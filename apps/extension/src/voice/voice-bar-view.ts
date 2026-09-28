/**
 * What the voice strip at the top of the side panel says while a hands-free
 * session is on (sidepanel/voice-bar.ts draws it), and which voice controls
 * the composer row shows (sidepanel/voice-input.ts). The strip only tells:
 * "Voice on" with the state word, the time on and a small meter. Every
 * control is at the bottom, by the box: Voice ends voice, Mute (a mic icon),
 * and the task's own Stop. A line being said is cut off by Esc or by talking.
 *
 * The strip always names the tab the session runs for ("Voice on · Inbox",
 * voiceOnLabel). On another tab it adds Go to tab and Use voice here; in
 * another window's panel (remoteBarView) the same, with nothing live and
 * Turn off (that panel has no session controls: its mic moves the session
 * there, it does not end it).
 *
 * It says "Listening" only once it listens: until the microphone's audio
 * reaches the engine the session is starting, and the strip (grey, like the
 * orb) says what it waits on (startingText: "Connecting…", "Opening the
 * mic…", "Still …" when slow). The panel stops a start that takes too long
 * and says why (sidepanel/hands-free.ts START_TIMEOUT_MS).
 *
 * Muted (Mute, or MUTE_KEY): the state word says so while it would listen,
 * no meter, and the strip in grey (voice.css). Mute shows once the session
 * runs. "Hearing you" comes from the microphone's level (VoiceActivity); the
 * polite announcement for screen readers leaves it out, so a voice going on
 * and off is not read out again and again.
 *
 * Pure.
 */
import type { VoiceEngineId } from "@noa/shared";
import type { HandsFreePhase } from "./hands-free.js";
import { VOICE_ON, voiceOnLabel, type TabPage } from "./hands-free-tab.js";

export { VOICE_ON };

/** The strip's lead words while a session starts (it does not listen yet). */
export const VOICE_STARTING = "Voice starting";

/** A session's phase as the strip knows it: the state machine's, or still starting (microphone, connection). */
export type VoiceBarPhase = Exclude<HandsFreePhase, "off"> | "starting";

export type VoiceBarState = "starting" | "listening" | "hearing" | "muted" | "sending" | "working" | "speaking" | "reconnecting" | "elsewhere";

/** What a session still starting waits on: the connection (Realtime), or the microphone's audio. */
export type StartStep = "connecting" | "microphone";

/** The strip's state word while starting (or reconnecting); slow: it has taken a while. */
export function startingText(step: StartStep, slow = false): string {
  const what = step === "connecting" ? "connecting…" : "opening the mic…";
  return slow ? `Still ${what}` : `${what[0]!.toUpperCase()}${what.slice(1)}`;
}

/** Under the orb while it does not listen yet: that first, then what it waits on. */
export function notListeningCaption(step: StartStep | "reconnecting", slow = false): string {
  if (step === "reconnecting") return "Not listening · reconnecting…";
  return `Not listening yet · ${startingText(step, slow).toLowerCase()}`;
}

/** Under the orb once it listens (and has nothing else to say). */
export const LISTENING_CAPTION = "Listening · go ahead · say “stop” to end";

export interface VoiceBarInput {
  phase: VoiceBarPhase;
  /** Starting: what it waits on (default: the microphone), and whether that has taken a while. */
  step?: StartStep;
  slow?: boolean;
  /** The microphone hears a voice now (VoiceActivity). */
  hearing: boolean;
  /** The user muted the microphone. */
  muted: boolean;
  /** The Realtime connection dropped and is being made again. */
  reconnecting?: boolean;
  /** The engine running (null: not chosen yet). */
  engine: VoiceEngineId | null;
  /** How long the session has been on. */
  elapsedMs: number;
  /** The tab the session runs for, as far as known (its title and address). */
  where: TabPage | null;
  /** The session listens in another tab than the one shown. */
  elsewhere: boolean;
}

export interface VoiceBarView {
  state: VoiceBarState;
  /** "Voice on" and where ("Voice on · Inbox"). */
  label: string;
  /** The state word after it ("Listening"; on another tab only "Muted", or ""). */
  status: string;
  /** How long it has been on ("0:42"; null: not shown). */
  time: string | null;
  /** The strip's tooltip: the engine and what to do now. */
  hint: string;
  /** The microphone's level shows (a small meter). */
  meter: boolean;
  /** For screen readers (polite): changes only with the state, not with the voice going on and off. */
  announce: string;
  /** Go to tab and Use voice here (the session runs for another tab); turnOff: Turn off too, where no mic here ends it. */
  links: { turnOff: boolean } | null;
  /** The microphone is muted (the strip goes grey). */
  muted: boolean;
  /** The composer's Mute toggle: pressed while muted, its tooltip and accessible name (null: not offered). */
  mute: { pressed: boolean; label: string } | null;
}

/** Mute and unmute inside the side panel, by the key's position (Alt on a Mac types another letter). */
export const MUTE_KEY = { code: "KeyM", label: "Alt+M" } as const;

export function isMuteKey(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return e.code === MUTE_KEY.code && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

const muteButton = (muted: boolean) => ({ pressed: muted, label: `${muted ? "Unmute" : "Mute"} the microphone · ${MUTE_KEY.label}` });

export const ENGINE_NAMES: Record<VoiceEngineId, string> = { realtime: "Realtime", standard: "Nova-3" };

/** A session's time on: "0:07", "12:34", "1:02:03". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

const STATUS: Record<Exclude<VoiceBarState, "elsewhere">, string> = {
  starting: "Starting…",
  listening: "Listening",
  hearing: "Hearing you",
  muted: "Muted",
  sending: "Sending",
  working: "Agent working",
  speaking: "Speaking",
  reconnecting: "Reconnecting…",
};

const HINTS: Record<Exclude<VoiceBarState, "elsewhere">, string> = {
  starting: "Not listening yet: wait for the sound, then talk",
  listening: "Just talk · say “stop” to end",
  hearing: "Just talk · say “stop” to end",
  muted: "Microphone off · Unmute to talk",
  sending: "Say “cancel” or press Esc to take it back",
  working: "Still listening: talk to add to the task",
  speaking: "Esc stops it, or just talk",
  reconnecting: "Not listening: the voice connection dropped and is being made again",
};

/** Muted, the hints that do not ask the user to talk. */
const MUTED_HINTS: Partial<Record<VoiceBarState, string>> = {
  sending: "Press Esc to take it back",
  speaking: "Esc stops it · microphone muted",
};
const MUTED_WORKING_HINT = "Agent working · updates are still said";

/** The states in which the microphone's level shows. */
const METER_STATES = new Set<VoiceBarState>(["listening", "hearing", "working", "sending"]);

function stateOf(input: VoiceBarInput): VoiceBarState {
  if (input.elsewhere) return "elsewhere";
  const { phase, hearing } = input;
  if (input.reconnecting) return "reconnecting";
  if (input.muted && (phase === "listening" || phase === "working")) return "muted";
  // The voice counts while the microphone is what is live: listening, or listening while the agent works.
  if (hearing && (phase === "listening" || phase === "working")) return "hearing";
  return phase;
}

const engineName = (engine: VoiceEngineId | null) => (engine ? `${ENGINE_NAMES[engine]} voice` : "Voice");

export function voiceBarView(input: VoiceBarInput): VoiceBarView {
  const state = stateOf(input);
  const time = elapsedText(input.elapsedMs);
  const { muted } = input;
  const mute = input.phase === "starting" ? null : muteButton(muted);
  if (state === "elsewhere") {
    const label = voiceOnLabel(input.where, true);
    return {
      state,
      label,
      status: muted ? STATUS.muted : "",
      time,
      hint: `${engineName(input.engine)} listens in that tab, not this one`,
      meter: false,
      announce: label,
      links: { turnOff: false },
      muted,
      mute,
    };
  }
  const status = state === "starting" ? startingText(input.step ?? "microphone", input.slow) : STATUS[state];
  // "Hearing you" comes and goes with the voice: it is announced as listening.
  const announced = state === "hearing" ? (input.phase === "working" ? STATUS.working : STATUS.listening) : status;
  const hint = !muted ? HINTS[state] : state === "muted" && input.phase === "working" ? MUTED_WORKING_HINT : (MUTED_HINTS[state] ?? HINTS[state]);
  // Starting, it is not on yet: "Voice starting · Inbox".
  const lead = state === "starting" ? VOICE_STARTING : VOICE_ON;
  return {
    state,
    label: state === "starting" ? voiceOnLabel(input.where).replace(VOICE_ON, VOICE_STARTING) : voiceOnLabel(input.where),
    status,
    time: state === "starting" ? null : time,
    hint: state === "starting" ? hint : `${engineName(input.engine)} · ${hint}`,
    meter: !muted && METER_STATES.has(state),
    announce: `${lead}: ${announced}`,
    links: null,
    muted,
    mute,
  };
}

/** The strip's tooltip in another window's panel: the session runs in the panel there, this one does not listen. */
export const NOT_HERE_TEXT = "Listening in another window";

/**
 * The strip in a panel that runs no session while another panel runs one (it reports it through the background):
 * where, with Go to tab, Use voice here and Turn off; nothing live, no time.
 */
export function remoteBarView(input: { where: TabPage | null; engine: VoiceEngineId | null; muted?: boolean }): VoiceBarView {
  const label = voiceOnLabel(input.where, true);
  const muted = input.muted ?? false;
  return {
    state: "elsewhere",
    label,
    status: muted ? STATUS.muted : "",
    time: null,
    hint: `${engineName(input.engine)} · ${NOT_HERE_TEXT}`,
    meter: false,
    announce: label,
    links: { turnOff: true },
    muted,
    mute: null,
  };
}

/** How loud (the 0..1 meter level) counts as a voice, and how long "Hearing you" stays after it. */
export const HEARING = { level: 0.5, holdMs: 600 } as const;

/** Whether the microphone hears a voice now, from its level; held a little so the word does not flicker. */
export class VoiceActivity {
  private lastVoiceAt = Number.NEGATIVE_INFINITY;

  /** A level (0..1) at `now`. */
  push(level: number, now: number): void {
    if (level >= HEARING.level) this.lastVoiceAt = now;
  }

  hearing(now: number): boolean {
    return now - this.lastVoiceAt < HEARING.holdMs;
  }

  reset(): void {
    this.lastVoiceAt = Number.NEGATIVE_INFINITY;
  }
}
