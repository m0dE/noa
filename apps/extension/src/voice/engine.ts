/**
 * A hands-free voice engine as the side panel drives it: Standard
 * (standard-engine.ts: speech detection, Whisper, the browser's speech) or
 * Realtime (realtime-engine.ts: the OpenAI narrator through the relay). The
 * panel runs the session's state machine (hands-free.ts) on what an engine
 * reports, and tells the engine what to do.
 */
import type { AgentEvent, VoiceEngineId } from "@noa/shared";

export interface EngineEvents {
  /** The user started speaking (while a line is said: long enough to be a barge-in). */
  speech(): void;
  /** What the user said; forward: a message for the agent (Standard), else only checked for stop and cancel words. */
  heard(text: string, forward: boolean): void;
  /** The user's words so far. */
  partial(text: string): void;
  /** The connection is up (Realtime): the microphone is being opened now. */
  openingMic(): void;
  /**
   * The microphone's first audio reached the engine (once per start; muted, none does): it listens from now on. Until
   * then the session does not say it listens.
   */
  capturing(): void;
  /** Microphone level, 0..1. */
  level(level: number): void;
  /** The narrator started talking by itself (Realtime). */
  narrating(): void;
  /** The line (or the narrator) is done. */
  said(): void;
  /** What the narrator is saying so far (Realtime). */
  narratorText(text: string): void;
  /**
   * A request for the agent from the narrator (Realtime send_to_agent), as it understood it: it goes out at once.
   * heard: the user's words for it, word for word (each part of their speech, in order), shown folded under it.
   */
  forward(text: string, heard?: readonly string[]): void;
  /** What the user said that led to no request (Realtime), word for word: kept for the record, not shown. */
  userWords(words: readonly string[]): void;
  /** The narrator asks to stop the running task (stop_task, cancel_request); the answer goes back to it. */
  stopTask(): Promise<string>;
  /** The user's answer to the approval the chat waits on (Realtime answer_approval); what happened goes back to the narrator. */
  answerApproval(allow: boolean): Promise<string>;
  /** The narrator ends the session (the user said goodbye). */
  endVoice(): void;
  /** The user asks to move the session to the tab they look at (Realtime use_this_tab); what happened goes back to the narrator. */
  useThisTab(): Promise<string>;
  /** The engine cannot go on (Realtime: a RealtimeFailure; Standard: a VoiceError). */
  failed(err: unknown): void;
}

export interface HandsFreeEngine {
  readonly id: VoiceEngineId;
  /** Nothing is transcribed while a line is said (it would hear itself). */
  readonly halfDuplex: boolean;
  /**
   * Opens the microphone (and the connection). Rejects when it cannot start. Resolving does not mean audio flows:
   * EngineEvents.capturing says when it does.
   */
  start(): Promise<void>;
  stop(): void;
  /** Says a line (Standard; the Realtime narrator speaks for itself). */
  speak(text: string): void;
  /** Stops talking now. */
  hush(): void;
  /** Half-duplex: stop or start turning speech into text. */
  setTranscribing(on: boolean): void;
  /**
   * Muted: nothing the microphone hears is processed or leaves the browser (the microphone itself stays open, so
   * unmuting is instant); lines are still said. May be called before start().
   */
  setMuted(muted: boolean): void;
  /** The agent started or stopped working on a task of the session's chat (Realtime: small talk then gets a short reply). */
  setAgentWorking?(working: boolean): void;
  /** An event of the chat the session follows (Realtime tells the narrator). */
  agentEvent(ev: AgentEvent, now: number): void;
  /** Something the narrator should know, not say (Realtime: which tab the user looks at). */
  note(text: string): void;
  tick(now: number): void;
}
