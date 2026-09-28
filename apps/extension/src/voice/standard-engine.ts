/**
 * The Standard hands-free engine: the microphone stays open (one MicTee),
 * the speech detector and the endpointer (endpointing.ts) decide where each
 * utterance ends, a Dictation per utterance turns it into text with Whisper
 * (live partials through voice.transcribe), and lines are said with the
 * browser's own speech (Speaker). Half-duplex: no dictation runs while a
 * line is said; speech long enough (HANDS_FREE.bargeInMs) cuts the line off,
 * and the next dictation starts with the audio just before, so the first
 * words are kept. Muted: the tee drops what the microphone hears, so neither
 * the detector nor a dictation gets any (no transcription request goes out).
 */
import { errorMessage, stopwatch, traceStart, traceText, VOICE_LIMITS, VOICE_TUNING, type AgentEvent, type TraceValue } from "@noa/shared";
import type { VoiceTracer } from "../trace/panel-trace.js";
import { Dictation, isFatal, type AudioSource, type TranscribeClip } from "./dictation.js";
import { Endpointer } from "./endpointing.js";
import type { EngineEvents, HandsFreeEngine } from "./engine.js";
import { HANDS_FREE } from "./hands-free.js";
import { MicTee } from "./mic-tee.js";
import type { Speaker } from "./speaker.js";
import { meterLevel, SpeechDetector } from "./speech.js";

/** Audio replayed to the dictation that starts after a barge-in. */
const BARGE_IN_REPLAY_MS = 600;

/** One utterance's timing: when the speech detector ended it, and its transcription requests. */
interface UtteranceTiming {
  vadEnd: number | null;
  requests: number;
  /** The last request (the final one once the utterance ended): when it went out (epoch ms), its round trip and size. */
  lastStart: number;
  lastMs: number;
  lastKB: number;
}

export interface StandardEngineDeps {
  /** The microphone at VOICE_LIMITS.sampleRate. */
  createSource(): AudioSource;
  transcribe: TranscribeClip;
  speaker: Pick<Speaker, "speak" | "cancel" | "speaking">;
  events: EngineEvents;
  /** The conversation's trace: utterances, their transcription, lines said and barge-ins. */
  trace?: VoiceTracer;
  /** The speech-to-text model the server runs, when known (for the trace). */
  model?(): string | undefined;
}

export class StandardEngine implements HandsFreeEngine {
  readonly id = "standard" as const;
  readonly halfDuplex = true;
  private tee: MicTee | null = null;
  private dictation: Dictation | null = null;
  private readonly timings = new WeakMap<Dictation, UtteranceTiming>();
  private transcribing = false;
  private detector = new SpeechDetector();
  private readonly endpointer = new Endpointer(VOICE_TUNING.frameMs);
  private readonly frameSamples = Math.round((VOICE_LIMITS.sampleRate * VOICE_TUNING.frameMs) / 1000);
  private pending = new Float32Array(0);
  private level = 0;
  /** This utterance was reported (speech()). */
  private reported = false;
  /** Loud frames in this utterance (its speech without the detector's hangover). */
  private loudFrames = 0;
  /** The line being said (a newer line or hush() makes an older one's end moot). */
  private line = 0;
  /** hush() cut a line off: the next dictation replays the audio just before. */
  private cutIn = false;
  private stopped = false;
  private muted = false;

  constructor(private readonly deps: StandardEngineDeps) {}

  async start(): Promise<void> {
    this.tee = new MicTee(this.deps.createSource(), Math.round((VOICE_LIMITS.sampleRate * BARGE_IN_REPLAY_MS) / 1000));
    this.tee.setMuted(this.muted);
    await this.tee.start((s) => this.onSamples(s));
  }

  stop(): void {
    this.stopped = true;
    this.dictation?.cancel();
    this.dictation = null;
    this.hush();
    this.tee?.stop();
    this.tee = null;
  }

  speak(text: string): void {
    const id = ++this.line;
    const queued = traceStart();
    let startMs: number | undefined;
    void this.deps.speaker.speak(text, { onStart: () => (startMs = queued.elapsed()) }).then(() => {
      // The time until the voice started is waiting; the rest is the line being said.
      this.deps.trace?.record({
        t: queued.t,
        ms: queued.elapsed(),
        cat: "voice",
        name: "voice.tts",
        data: { chars: text.length, waitMs: startMs ?? 0, ...(startMs === undefined ? { started: false } : { startMs }), cut: id !== this.line },
      });
      if (id === this.line && !this.stopped) this.deps.events.said();
    });
  }

  hush(): void {
    if (this.deps.speaker.speaking) this.cutIn = true;
    this.line++;
    this.deps.speaker.cancel();
  }

  setTranscribing(on: boolean): void {
    this.transcribing = on;
    if (!on) {
      this.dictation?.cancel();
      this.dictation = null;
      return;
    }
    if (!this.dictation) this.listen(this.cutIn);
    this.cutIn = false;
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.tee?.setMuted(muted);
    if (!muted) {
      if (this.transcribing && !this.dictation) this.listen(false);
      return;
    }
    // What was being said is dropped, and listening starts over from silence when unmuted.
    this.dictation?.cancel();
    this.dictation = null;
    this.detector = new SpeechDetector();
    this.endpointer.reset();
    this.pending = new Float32Array(0);
    this.reported = false;
    this.loudFrames = 0;
    this.cutIn = false;
    this.level = 0;
    this.deps.events.level(0);
  }

  agentEvent(_ev: AgentEvent, _now: number): void {
    // The panel picks the lines to say (narration.ts).
  }

  note(_text: string): void {
    // No narrator: the messages sent carry the note (sidepanel/hands-free.ts).
  }

  tick(_now: number): void {}

  /** Starts the next utterance's dictation (with the audio just before, after a barge-in). */
  private listen(replay: boolean): void {
    if (!this.tee || this.stopped || this.muted) return;
    const timing: UtteranceTiming = { vadEnd: null, requests: 0, lastStart: 0, lastMs: 0, lastKB: 0 };
    const d = new Dictation({
      source: this.tee.branch({ replay }),
      transcribe: async (wav, req) => {
        const took = stopwatch();
        timing.requests++;
        timing.lastStart = Date.now();
        try {
          return await this.deps.transcribe(wav, req);
        } finally {
          timing.lastMs = took();
          timing.lastKB = Math.round(wav.byteLength / 1024);
        }
      },
      events: { onText: (t) => this.dictation === d && this.deps.events.partial(t) },
    });
    this.dictation = d;
    this.timings.set(d, timing);
    d.run().then(
      (r) => {
        if (this.dictation === d) this.dictation = null;
        if (r.reason !== "cancel") this.traceTranscript(timing, r.text, r.reason);
        // Stopped at an utterance's end (send), or by itself (the clip cap).
        if (r.reason !== "cancel" && !this.stopped) {
          this.deps.events.heard(r.text, true);
          if (this.transcribing && !this.dictation) this.listen(false);
        }
      },
      (err) => {
        if (this.dictation === d) this.dictation = null;
        const trace = this.deps.trace;
        trace?.record({ t: Date.now(), cat: "error", name: "voice.transcribe_failed", cid: trace.utterance(), data: { error: traceText(errorMessage(err), 160), requests: timing.requests } });
        if (this.stopped) return;
        if (isFatal(err)) return this.deps.events.failed(err);
        if (this.transcribing && !this.dictation) this.listen(false);
      },
    );
  }

  /** The utterance's text is back: from the end of speech (the detector's) to the transcript, and its last request. */
  private traceTranscript(timing: UtteranceTiming, text: string, reason: string): void {
    const trace = this.deps.trace;
    if (!trace || (!text && !timing.requests)) return;
    const now = Date.now();
    const t = timing.vadEnd ?? now;
    const data: Record<string, TraceValue> = { chars: text.length, requests: timing.requests, lastRequestMs: timing.lastMs, lastKB: timing.lastKB, reason, waitMs: now - t };
    // From the end of speech to the final request going out (the partial requests before it may still be running).
    if (timing.vadEnd !== null && timing.lastStart >= timing.vadEnd) data.requestAfterMs = timing.lastStart - timing.vadEnd;
    const model = this.deps.model?.();
    if (model) data.model = model;
    trace.record({ t, ms: now - t, cat: "voice", name: "voice.transcript", cid: trace.utterance(), data });
  }

  private onSamples(samples: Float32Array): void {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    let at = 0;
    for (; at + this.frameSamples <= joined.length; at += this.frameSamples) this.onFrame(joined.subarray(at, at + this.frameSamples));
    this.pending = joined.slice(at);
    this.deps.events.level(this.level);
  }

  private onFrame(frame: Float32Array): void {
    const v = this.detector.push(frame);
    this.level += (meterLevel(v.rms) - this.level) * VOICE_TUNING.levelSmoothing;
    const signal = this.endpointer.push(v.speech);
    if (v.loud) this.loudFrames++;
    // Quiet (past the hangover) starts the count over.
    if (!v.speech) this.loudFrames = 0;
    if (signal === "end") {
      this.reported = false;
      // The utterance is over: its dictation finishes the text and reports it.
      const d = this.dictation;
      this.dictation = null;
      const timing = d && this.timings.get(d);
      if (timing) timing.vadEnd = Date.now();
      if (d) void d.stop("send");
      if (this.transcribing) this.listen(false);
      return;
    }
    if (this.reported || !v.speech) return;
    // Reported once it is an utterance; over a line only once it is long enough to be the user cutting in.
    const barge = this.deps.speaker.speaking;
    if (barge ? this.loudFrames * VOICE_TUNING.frameMs >= HANDS_FREE.bargeInMs : signal === "start") {
      this.reported = true;
      const trace = this.deps.trace;
      trace?.record({ t: Date.now(), cat: "voice", name: barge ? "voice.barge_in" : "voice.speech", cid: trace.utterance() });
      this.deps.events.speech();
    }
  }
}
