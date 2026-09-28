/**
 * Live dictation: listens to an audio source, detects speech and keeps the
 * text current by re-transcribing the recent audio about once a second.
 *
 *   idle -> listening -> transcribing -> done
 *                  \-> cancelled        \-> error
 *
 * Whisper transcribes whole clips, so live text is rolling re-transcription:
 * while someone speaks, the audio since the last finalised point is sent every
 * `partialIntervalMs` (one request in flight; a reply older than the newest
 * finalised point is dropped). Once that span passes `windowMs`, the part up to
 * the latest pause is transcribed once more and finalised, so each request
 * carries at most ~10 s and words at the cut stay stable. Stopping sends the
 * unfinalised rest one last time.
 *
 * Every decision runs on audio time (frames received), not on timers, so the
 * behaviour is the same however the audio arrives and tests need no clock.
 */
import { VOICE_LIMITS, VOICE_TUNING } from "@noa/shared";
import { FrameBuffer, meterLevel, type FrameRange, type Tuning } from "./speech.js";
import { encodeWav, toInt16 } from "./wav.js";

export type DictationState = "idle" | "listening" | "transcribing" | "done" | "error" | "cancelled";

/** Why listening stopped: `send` (the utterance ended), `cap` (`maxClipMs` reached) or `cancel`. */
export type StopReason = "send" | "cap" | "cancel";

export interface DictationResult {
  /** The voice text (empty when cancelled). */
  text: string;
  reason: StopReason;
}

/** Microphone (or a fake): delivers mono samples at `VOICE_LIMITS.sampleRate`. */
export interface AudioSource {
  start(onSamples: (samples: Float32Array) => void): Promise<void>;
  stop(): void;
}

export interface ClipRequest {
  /** Milliseconds of speech in the clip (the server's hallucination filter uses it). */
  speechMs: number;
  /** Finalised text just before the clip. */
  context?: string;
  signal: AbortSignal;
}

/** Transcribes one WAV clip. Rejecting with an error whose `fatal` is true ends the session. */
export type TranscribeClip = (wav: Uint8Array, req: ClipRequest) => Promise<string>;

export interface DictationEvents {
  onState?(state: DictationState): void;
  /** Smoothed input level, 0..1, per chunk of audio. */
  onLevel?(level: number): void;
  /** The voice text so far (finalised plus the newest partial). */
  onText?(text: string): void;
}

export interface DictationOptions {
  source: AudioSource;
  transcribe: TranscribeClip;
  events?: DictationEvents;
  tuning?: Tuning;
  sampleRate?: number;
  maxClipMs?: number;
}

type JobKind = "partial" | "commit" | "final";

interface Job {
  kind: JobKind;
  range: FrameRange;
  /** `committedTo` when the job was made: a partial for an older point is stale. */
  base: number;
  controller: AbortController;
  done: Promise<void>;
}

/** Text pieces joined with single spaces. */
export function joinText(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}

/** True for errors that must end the session (no plan, no credit, signed out). */
export function isFatal(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { fatal?: unknown }).fatal === true;
}

export class Dictation {
  private _state: DictationState = "idle";
  private readonly buf: FrameBuffer;
  private readonly t: Tuning;
  private readonly maxFrames: number;
  private readonly partialFrames: number;
  private readonly windowFrames: number;
  private readonly forceFrames: number;
  /** Text finalised up to frame `committedTo`. */
  private committedText = "";
  private committedTo = 0;
  private partialText = "";
  /** End frame of the last partial request, and whether speech came after it. */
  private lastPartialAt = 0;
  private job: Job | null = null;
  private level = 0;
  private settle!: { resolve: (r: DictationResult) => void; reject: (e: unknown) => void };
  private readonly result: Promise<DictationResult>;

  constructor(private readonly opts: DictationOptions) {
    this.t = opts.tuning ?? VOICE_TUNING;
    this.buf = new FrameBuffer(opts.sampleRate ?? VOICE_LIMITS.sampleRate, this.t);
    this.maxFrames = this.buf.framesIn(opts.maxClipMs ?? VOICE_LIMITS.maxClipMs);
    this.partialFrames = this.buf.framesIn(this.t.partialIntervalMs);
    this.windowFrames = this.buf.framesIn(this.t.windowMs);
    this.forceFrames = this.buf.framesIn(this.t.forceCommitMs);
    this.result = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    // The caller awaits run(); this keeps an unobserved rejection from being reported twice.
    this.result.catch(() => undefined);
  }

  get state(): DictationState {
    return this._state;
  }

  /** The voice text so far. */
  get text(): string {
    return joinText(this.committedText, this.partialText);
  }

  /** Starts listening; resolves when the session ends (stop, cap or cancel), rejects on an error. */
  run(): Promise<DictationResult> {
    if (this._state !== "idle") return this.result;
    this.opts.source.start((s) => this.onSamples(s)).then(
      () => {
        if (this._state !== "idle") return; // cancelled or stopped while the microphone was opening
        this.setState("listening");
      },
      (err) => this.fail(err),
    );
    return this.result;
  }

  /** Stops listening and finalises the text. */
  stop(reason: Exclude<StopReason, "cancel"> = "send"): Promise<DictationResult> {
    if (this._state === "idle") {
      // The microphone is still opening: end as soon as it is open, with nothing heard.
      this.opts.source.stop();
      this.finishWith({ text: "", reason });
    } else if (this._state === "listening") void this.finalize(reason);
    return this.result;
  }

  /** Stops and discards everything. */
  cancel(): void {
    if (this._state === "done" || this._state === "error" || this._state === "cancelled") return;
    this.opts.source.stop();
    this.job?.controller.abort();
    this.setState("cancelled");
    this.settle.resolve({ text: "", reason: "cancel" });
  }

  private onSamples(samples: Float32Array): void {
    if (this._state !== "listening") return;
    const verdicts = this.buf.append(samples);
    if (!verdicts.length) return;
    for (const v of verdicts) this.level += (meterLevel(v.rms) - this.level) * this.t.levelSmoothing;
    this.opts.events?.onLevel?.(this.level);
    if (this.buf.length >= this.maxFrames) return void this.finalize("cap");
    this.pump();
  }

  /** Starts the next request when none is in flight. */
  private pump(): void {
    if (this.job || this._state !== "listening") return;
    const end = this.buf.length;
    const cut = this.commitPoint(end);
    if (cut !== null) return this.startJob("commit", { from: this.committedTo, to: cut });
    const heardSince = this.buf.speechFrames({ from: Math.max(this.lastPartialAt, this.committedTo), to: end }) > 0;
    if (heardSince && end - this.lastPartialAt >= this.partialFrames) {
      this.lastPartialAt = end;
      this.startJob("partial", { from: this.committedTo, to: end });
    }
  }

  /** Where to finalise text when the unfinalised span has grown past the window, else null. */
  private commitPoint(end: number): number | null {
    const span = end - this.committedTo;
    if (span <= this.windowFrames) return null;
    const pause = this.buf.latestPause({ from: this.committedTo, to: end });
    if (pause !== null && pause > this.committedTo) return pause;
    if (span <= this.forceFrames) return null;
    // Someone talked without a pause for a long time: cut at the quietest moment, keeping the last half window open.
    const half = Math.floor(this.windowFrames / 2);
    return this.buf.quietest({ from: this.committedTo + half, to: end - half });
  }

  private startJob(kind: JobKind, range: FrameRange): void {
    const controller = new AbortController();
    const job: Job = { kind, range, base: this.committedTo, controller, done: Promise.resolve() };
    this.job = job;
    job.done = this.transcribeRange(range, controller.signal).then(
      (text) => this.onJobText(job, text),
      (err) => this.onJobError(job, err),
    );
  }

  /** The text of `range` (trimmed to its speech); "" without a request when it has none. */
  private async transcribeRange(range: FrameRange, signal: AbortSignal): Promise<string> {
    const clip = this.buf.trimmed(range);
    if (!clip) return "";
    const wav = encodeWav(toInt16(this.buf.samples(clip)), this.buf.sampleRate);
    const context = this.committedText.slice(-VOICE_LIMITS.contextChars) || undefined;
    return this.opts.transcribe(wav, { speechMs: this.buf.ms(this.buf.speechFrames(clip)), context, signal });
  }

  private onJobText(job: Job, text: string): void {
    if (this.job === job) this.job = null;
    if (job.controller.signal.aborted || this._state === "cancelled") return;
    if (job.kind === "commit") {
      this.committedText = joinText(this.committedText, text);
      this.committedTo = job.range.to;
      // The old partial covered the finalised part too; the next partial replaces it. Until
      // then the display keeps the old text rather than shrinking.
      this.partialText = "";
      this.lastPartialAt = 0;
    } else if (job.kind === "partial") {
      if (job.base !== this.committedTo) return; // stale: made before the latest finalised point
      this.partialText = text;
      this.opts.events?.onText?.(this.text);
    }
    this.pump();
  }

  private onJobError(job: Job, err: unknown): void {
    if (this.job === job) this.job = null;
    if (job.controller.signal.aborted || this._state === "cancelled") return;
    if (job.kind === "final" || isFatal(err)) return this.fail(err);
    // A partial or finalising request failed (network blip): the next one covers the same audio.
    this.pump();
  }

  /** Stops listening, lets a finalising request finish, then transcribes the rest once. */
  private async finalize(reason: Exclude<StopReason, "cancel">): Promise<void> {
    if (this._state !== "listening") return;
    this.opts.source.stop();
    this.setState("transcribing");
    const running = this.job;
    if (running?.kind === "partial") running.controller.abort();
    else if (running) await running.done;
    if (!this.finalizing()) return; // cancelled or failed meanwhile
    const controller = new AbortController();
    const job: Job = { kind: "final", range: { from: this.committedTo, to: this.buf.length }, base: this.committedTo, controller, done: Promise.resolve() };
    this.job = job;
    let tail: string;
    try {
      tail = await this.transcribeRange(job.range, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) this.fail(err);
      return;
    }
    if (!this.finalizing()) return;
    this.job = null;
    this.committedText = joinText(this.committedText, tail);
    this.partialText = "";
    this.opts.events?.onText?.(this.text);
    this.finishWith({ text: this.text, reason });
  }

  /** Still transcribing the rest (re-read after an await: cancel() or an error may have ended the session). */
  private finalizing(): boolean {
    return this._state === "transcribing";
  }

  private finishWith(result: DictationResult): void {
    this.setState("done");
    this.settle.resolve(result);
  }

  private fail(err: unknown): void {
    if (this._state === "done" || this._state === "error" || this._state === "cancelled") return;
    this.opts.source.stop();
    this.job?.controller.abort();
    this.setState("error");
    this.settle.reject(err);
  }

  private setState(s: DictationState): void {
    this._state = s;
    this.opts.events?.onState?.(s);
  }
}
