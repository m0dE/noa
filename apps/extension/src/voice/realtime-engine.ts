/**
 * The Realtime hands-free engine: the microphone streams to the narrator
 * (PCM16 at 24 kHz, about every 100 ms), its speech plays back (PcmPlayer),
 * the chat's events go to it as notes (NarratorFeed; when it may speak is
 * narrator-policy.ts, one line at a time, after its audio here), and its tools reach
 * the panel (send_to_agent with the user's words for it, stop_task and cancel_request, use_this_tab, end_voice).
 * Words that led to no request reach it as heard. Turn-taking and barge-in are
 * OpenAI's server VAD; local playback stops the moment the user speaks.
 * Muted: the microphone's samples are dropped here and the client sends no
 * audio (and clears the server's buffer), so muted time bills no input audio;
 * the connection and the narrator's speech go on.
 */
import { traceStart, type AgentEvent, type ApprovalRequest, type RealtimeVoiceId } from "@noa/shared";
import { spokenAllowRefusal } from "./approval-voice.js";
import type { VoiceTracer } from "../trace/panel-trace.js";
import type { AudioSource } from "./dictation.js";
import type { EngineEvents, HandsFreeEngine } from "./engine.js";
import { EchoGate } from "./echo-gate.js";
import { PcmPlayer } from "./pcm-player.js";
import { RealtimeClient, realtimeFailure, REALTIME_SAMPLE_RATE, SENT_OUTPUT, takeoverUrl, type NarratorTool, type OpenSocket, type RealtimeFailure } from "./realtime-client.js";
import type { RealtimeTicket } from "./realtime-access.js";
import { NarratorFeed, type FeedOutput } from "./realtime-feed.js";
import { requestKind } from "./narrator-policy.js";
import { meterLevel, rms } from "./speech.js";
import { toInt16 } from "./wav.js";

/** Microphone audio is sent in chunks of about this long. */
const SEND_EVERY_MS = 100;
/** Starting may take this long (the relay, OpenAI's session) before it counts as failed. */
const START_TIMEOUT_MS = 15_000;

export interface RealtimeEngineDeps {
  /** Which Realtime engine this is (the ticket asks for its model); default realtime. */
  id?: "realtime" | "realtime-mini";
  /** Where to connect, with the session token. Rejects with the reason it cannot. */
  ticket(): Promise<RealtimeTicket>;
  /** The microphone at REALTIME_SAMPLE_RATE. */
  createSource(): AudioSource;
  events: EngineEvents;
  /** The narrator's voice and speaking speed (Settings). */
  voice?: { voice: RealtimeVoiceId; speed: number };
  /** The languages the user speaks (voice-language.ts voiceLanguages). */
  languages?: readonly string[];
  /** The language picked in Settings, by its English name: the narrator always speaks it (RealtimeClientOptions.language). */
  language?: string;
  log?(message: string): void;
  openSocket?: OpenSocket;
  player?: Pick<PcmPlayer, "play" | "stop" | "close" | "playing" | "quietMs" | "pause" | "resume" | "level">;
  /** The conversation's trace: the session token (ticket), connecting, each narrator reply, its tool calls. */
  trace?: VoiceTracer;
  /**
   * End the user's Realtime session still open on the server, if any, and take its place (it was this browser's own:
   * a session handed over from another panel, or reconnecting after a drop; or the user chose Take over here).
   */
  takeover?: boolean;
}

export class RealtimeEngine implements HandsFreeEngine {
  readonly id: "realtime" | "realtime-mini";
  readonly halfDuplex = false;
  private client: RealtimeClient | null = null;
  private source: AudioSource | null = null;
  private readonly feed = new NarratorFeed();
  private readonly player: Pick<PcmPlayer, "play" | "stop" | "close" | "playing" | "quietMs" | "pause" | "resume" | "level">;
  /** The narrator's own voice heard back is not the user (echo-gate.ts). */
  private readonly gate = new EchoGate(REALTIME_SAMPLE_RATE);
  private chunks: Float32Array[] = [];
  private chunked = 0;
  private level = 0;
  private stopped = false;
  private muted = false;
  /** The first audio went to the narrator (EngineEvents.capturing). */
  private capturing = false;
  /** The agent works on a task of the chat (the client is told, also once it connects). */
  private agentWorking = false;
  /** The approval the chat waits on (answer_approval allows only this one, named). */
  private approvalWaiting: ApprovalRequest | null = null;

  constructor(private readonly deps: RealtimeEngineDeps) {
    this.id = deps.id ?? "realtime";
    const ev = deps.events;
    this.player =
      deps.player ??
      new PcmPlayer(REALTIME_SAMPLE_RATE, {
        onStart: () => {
          // Anything it says holds the next progress line back (milestones.ts PROGRESS).
          this.feed.spoke(Date.now());
          ev.narrating();
        },
        onIdle: () => {
          if (this.stopped) return;
          ev.said();
          // A line waiting for the narrator to finish may start now.
          this.client?.playbackIdle();
        },
      });
  }

  /** Resolves once the narrator listens; stopped meanwhile (stop()), it closes what it opened and resolves. */
  async start(): Promise<void> {
    const trace = this.deps.trace;
    const asking = traceStart();
    const ticket = await this.deps.ticket();
    // The session token from the background (the relay checks plan and credit as the socket connects).
    trace?.record({ t: asking.t, ms: asking.elapsed(), cat: "voice", name: "voice.ticket", data: { waitMs: asking.elapsed(), ...(this.deps.takeover ? { takeover: true } : {}) } });
    if (this.stopped) return;
    const ev = this.deps.events;
    let client!: RealtimeClient;
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => fail(realtimeFailure({ closeCode: 1006, opened: false })), START_TIMEOUT_MS);
      const fail = (f: RealtimeFailure) => {
        clearTimeout(timer);
        if (!started) {
          started = true;
          this.client?.close();
          reject(f);
        } else if (!this.stopped) ev.failed(f);
      };
      client = this.client = new RealtimeClient({
        url: this.deps.takeover ? takeoverUrl(ticket.url) : ticket.url,
        token: ticket.token,
        ...(this.deps.voice ? { voice: this.deps.voice.voice, speed: this.deps.voice.speed } : {}),
        ...(this.deps.languages ? { languages: this.deps.languages } : {}),
        ...(this.deps.language ? { language: this.deps.language } : {}),
        ...(this.deps.openSocket ? { open: this.deps.openSocket } : {}),
        handlers: {
          onReady: () => {
            if (started) return;
            started = true;
            clearTimeout(timer);
            resolve();
          },
          onAudio: (b64, itemId) => this.player.play(b64, itemId),
          onNarratorText: (t) => ev.narratorText(t),
          onUserSpeech: (paused) => {
            // Paused, not cut off, while it may be the speaker heard back (onTalkedOver).
            if (paused) this.player.pause();
            else this.cutOff();
            ev.speech();
          },
          onTalkedOver: (user) => {
            if (user) return this.cutOff();
            this.player.resume();
            trace?.record({ t: Date.now(), cat: "voice", name: "voice.played_on" });
          },
          onTool: (name, args, inputId, heard) => this.tool(name, args, inputId, heard),
          onHeard: (words) => !this.stopped && ev.userWords(words),
          playing: () => this.player.playing,
          quietMs: () => this.player.quietMs,
          // Noise's reply: what of it plays stops.
          onNoise: () => this.cutOff(),
          onTurnDone: (inputId) => {
            // A turn that sent nothing: its timings stay with the session's chat.
            trace?.endUtterance(inputCid(inputId));
          },
          onClose: (f) => {
            if (f) return fail(f);
            // We closed it before it was ready (stop() while connecting): starting is over.
            if (started) return;
            started = true;
            clearTimeout(timer);
            resolve();
          },
          // Timings of the user's turn join the message it led to (by its input item).
          ...(trace ? { onTrace: (e, inputId) => trace.record(inputId ? { ...e, cid: inputCid(inputId) } : e) } : {}),
          log: (m) => this.deps.log?.(m),
        },
      });
      client.connect();
    });
    if (this.stopped) {
      // stop() came while connecting: nothing of this session may stay open.
      client.close();
      this.client = null;
      return;
    }
    if (this.muted) client.setMuted(true);
    client.setAgentWorking(this.agentWorking);
    ev.openingMic();
    const source = this.deps.createSource();
    this.source = source;
    await source.start((s) => this.onSamples(s));
    if (this.stopped) source.stop();
  }

  stop(): void {
    this.stopped = true;
    this.source?.stop();
    this.source = null;
    this.player.close();
    this.client?.close();
    this.client = null;
  }

  speak(_text: string): void {
    // The narrator says things in its own words (see the feed).
  }

  hush(): void {
    this.cutOff();
    this.client?.cancelResponse();
  }

  setTranscribing(_on: boolean): void {
    // Not half-duplex: OpenAI's turn detection hears the user over the narrator.
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    // A part-filled chunk is dropped either way: from before the mute, or silence.
    this.chunks = [];
    this.chunked = 0;
    if (muted) {
      this.level = 0;
      this.deps.events.level(0);
    }
    this.client?.setMuted(muted);
  }

  setAgentWorking(working: boolean): void {
    this.agentWorking = working;
    this.client?.setAgentWorking(working);
  }

  agentEvent(ev: AgentEvent, now: number): void {
    if (ev.type === "approval_request") this.approvalWaiting = ev.request;
    else if ((ev.type === "approval_resolved" && ev.id === this.approvalWaiting?.id) || ev.type === "task_end") this.approvalWaiting = null;
    this.apply(this.feed.push(ev, now));
  }

  note(text: string): void {
    this.client?.note(text);
  }

  /** What the feed says to do: a line to say word for word, or the narrator's new status. */
  private apply(out: FeedOutput[]): void {
    for (const o of out) {
      if ("say" in o) this.client?.say(o.say.kind, o.say.line);
      else this.client?.setStatus(o.status);
    }
  }

  tick(now: number): void {
    // While the agent works: "Still …" after a long silence (milestones.ts PROGRESS); news is said as it comes.
    if (!this.agentWorking) return;
    this.apply(this.feed.tick(now));
  }

  /** Stops local playback; the narrator's memory keeps only what was heard. */
  private cutOff(): void {
    const cut = this.player.stop();
    if (cut) this.client?.truncate(cut.itemId, cut.playedMs);
  }

  private async tool(name: NarratorTool, args: Record<string, unknown>, inputId: string | null, heard: string[]): Promise<string> {
    const ev = this.deps.events;
    const trace = this.deps.trace;
    // The request goes out as the utterance of the turn that called it (its message carries that id).
    const cid = inputId ? inputCid(inputId) : undefined;
    if (trace && cid && name === "send_to_agent") trace.useUtterance(cid);
    trace?.record({ t: Date.now(), cat: "voice", name: `voice.tool.${name}`, ...(cid ? { cid } : {}) });
    switch (name) {
      case "send_to_agent": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) return "Error: say what to send (text).";
        // Asked while the agent works: its answer is its next words once it read the question (a question asked when
        // idle starts a turn whose end says it). Otherwise its acknowledgement is the narrator's line for now: progress
        // waits PROGRESS.stepGapMs after it (milestones.ts). Counted before it goes: its events may come back first.
        this.apply(this.feed.sent(text, requestKind(args) === "question" && this.agentWorking, Date.now(), this.agentWorking));
        ev.forward(text, heard);
        return SENT_OUTPUT;
      }
      // The request already went out: taking it back stops its task.
      case "cancel_request":
      case "stop_task":
        return ev.stopTask();
      case "answer_approval": {
        if (typeof args.allow !== "boolean") return "Error: say whether the user allows it (allow: true or false).";
        // A no always stands; a yes only on the user's own plain yes for this turn, naming the waiting action.
        const refusal = args.allow ? spokenAllowRefusal(heard.join(" "), typeof args.action === "string" ? args.action : "", this.approvalWaiting?.action ?? null) : null;
        if (refusal) {
          trace?.record({ t: Date.now(), cat: "voice", name: "voice.approval_refused", ...(cid ? { cid } : {}), data: { chars: heard.join(" ").length } });
          return refusal;
        }
        return ev.answerApproval(args.allow);
      }
      case "use_this_tab":
        return ev.useThisTab();
      case "end_voice":
        // After this reply: the narrator may say goodbye first.
        setTimeout(() => ev.endVoice(), 0);
        return "Ending the hands-free conversation.";
    }
  }

  private onSamples(s: Float32Array): void {
    if (this.muted) return;
    this.chunks.push(s);
    this.chunked += s.length;
    this.level += (meterLevel(rms(s)) - this.level) * 0.35;
    this.deps.events.level(this.level);
    if (this.chunked < (REALTIME_SAMPLE_RATE * SEND_EVERY_MS) / 1000) return;
    const all = new Float32Array(this.chunked);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    this.chunked = 0;
    if (!this.client || this.stopped) return;
    const { send, opened } = this.gate.push(all, this.player.level());
    if (opened) this.deps.trace?.record({ t: Date.now(), cat: "voice", name: "voice.talk_over" });
    for (const c of send) this.client.appendAudio(toInt16(c));
    if (this.capturing) return;
    this.capturing = true;
    this.deps.events.capturing();
  }
}

/** The trace's correlation id of the user's input item `inputId` (a turn of theirs). */
export function inputCid(inputId: string): string {
  return `rt-${inputId.replace(/[^\w-]/g, "").slice(0, 60)}`;
}
