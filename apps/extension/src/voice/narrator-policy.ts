/**
 * When the Realtime narrator may speak: the one policy for what the chat's
 * events may make it say (narrationOf) and when a line may start (floor).
 *
 * It speaks only with news the user does not have: the agent's result, its
 * question, a problem. It never speaks for what merely echoes the user's own
 * request (their message, their transcribed words, the agent restating the
 * request), and one speaker talks at a time: the user first, then the
 * narrator's reply to them, then any news. Progress while the agent works (a
 * new step, "Still …" after a long silence) is milestones.ts ProgressPacer's,
 * said as it is (realtime-feed.ts): it is not a reply. Pure.
 */
import { ANSWER_TOOL, USER_STOP_REASON, type AgentEvent } from "@noa/shared";
import { containedWordShare, sharedWordShare } from "../text.js";
import { answerLine, endLine, errorLine } from "./spoken-line.js";

/** What a narrator reply is: its answer to the user's speech, or one it was asked for (see SpokenKind). */
export type ReplyKind = "speech" | SpokenKind;
/** A line the narrator is asked to say: the one acknowledgement of a request, a milestone, the result, the agent's question, a problem. */
export type SpokenKind = "ack" | "milestone" | "result" | "question" | "error";

/** A request sharing at least this share of its words with the one just sent is that request again (sent once). */
export const REPEATED_REQUEST_OVERLAP_MIN = 0.6;
/** An empty transcript of at most this much speech is noise (a cough, a door): no reply, no message. */
export const NOISE_MAX_SPEECH_MS = 2_500;

/** What the narrator has said for the request being worked on. */
export interface NarrationMemory {
  /** When it last spoke or was asked to (epoch ms). */
  lastSpokenAt: number;
  /** The last result or question said (never said twice). */
  lastLine: string | null;
}

export const freshMemory = (now = -Infinity): NarrationMemory => ({ lastSpokenAt: now, lastLine: null });

/**
 * What the user's words passed on to the agent are, as the narrator understood them (send_to_agent's `kind`): a
 * question (something asked of the agent, conversation, or a correction of a misunderstanding), answered by the
 * agent, or an instruction (a new task or a change to the one running). A call without it is an instruction.
 */
export type RequestKind = "question" | "instruction";
export const requestKind = (args: Record<string, unknown> | null): RequestKind => (args?.kind === "question" ? "question" : "instruction");

/** Said once: false when the very same line was said last (dedupe by meaning). */
function news(line: string, memory: NarrationMemory, now: number): boolean {
  const key = line.trim().toLowerCase();
  if (memory.lastLine === key) return false;
  memory.lastLine = key;
  memory.lastSpokenAt = now;
  return true;
}

/**
 * What an event of the chat may make the narrator say, or null: nothing to say (it may still be passed on as a note
 * for context). Speaks for: the result (the agent's spoken line), its answer to a message the user sent while it
 * worked (answer_user), its question, a problem. Never for the user's message or words, the agent's text (it restates
 * the request, or says what it does next) or status lines; steps are progress (ProgressPacer), not news. `line`: the
 * words it is about.
 */
export function narrationOf(ev: AgentEvent, memory: NarrationMemory, now: number): { kind: SpokenKind; line: string } | null {
  switch (ev.type) {
    case "tool_call": {
      const text = ev.name === ANSWER_TOOL ? (ev.args as { text?: unknown } | undefined)?.text : null;
      const line = typeof text === "string" ? answerLine(text) : "";
      return line && news(line, memory, now) ? { kind: "result", line } : null;
    }
    case "task_end": {
      // The turn's end says what is left to say (its answer included).
      const line = endLine(ev);
      // A reason without a spoken line is the agent's question as it wrote it (not when the user stopped it).
      const kind = ev.outcome === "paused" && !ev.spoken && ev.reason && ev.reason.trim() !== USER_STOP_REASON ? "question" : "result";
      return news(line, memory, now) ? { kind, line } : null;
    }
    case "error": {
      const line = errorLine(ev.text);
      return news(line, memory, now) ? { kind: "error", line } : null;
    }
    default:
      return null;
  }
}

/** Who has the floor when the narrator is asked to say something. */
export interface Floor {
  /** The user is talking (server VAD: speech started, their turn not in yet). */
  userSpeaking: boolean;
  /** Their turn is in but the reply to it has not started. */
  awaitingReply: boolean;
  /** A reply is being made. */
  replying: boolean;
  /** The narrator's audio is still playing here. */
  playing: boolean;
}

/**
 * Whether a line of `kind` starts now, waits for the floor ("later"), or is let go ("drop").
 * - The user speaking, or their reply about to start: progress and the acknowledgement are let go (old by then); a
 *   result, a question and a problem wait for the user and the reply to them. If what the user said was a new request,
 *   they are let go then (realtime-client.ts supersedeNews): the agent answers that one. Dropped at once, the answer
 *   was lost whenever it came while the user talked, and the narrator said it later from its notes, a turn behind.
 * - A reply being made or audio playing: a milestone is let go (old news by then); the acknowledgement, a result, a
 *   question and a problem wait their turn.
 */
export function floor(kind: SpokenKind, f: Floor): "now" | "later" | "drop" {
  if (f.userSpeaking || f.awaitingReply) return kind === "milestone" || kind === "ack" ? "drop" : "later";
  if (f.replying || f.playing) return kind === "milestone" ? "drop" : "later";
  return "now";
}

/** An empty transcript is noise when the speech was short (or its length is unknown). */
export function isNoise(transcript: string, speechMs: number | null): boolean {
  return !transcript.trim() && (speechMs === null || speechMs <= NOISE_MAX_SPEECH_MS);
}

/** The request the narrator last passed on (send_to_agent), and the user's turn it answered (null: a reply we asked for). */
export interface ForwardedRequest {
  inputId: string | null;
  text: string;
}

/**
 * A send_to_agent that passes on `last` again: the same or nearly the same words, in the same user turn or in a reply
 * we asked for (no new words of the user's came with it). One request goes to the agent once; a new turn may ask
 * again.
 */
export function repeatsRequest(text: string, inputId: string | null, last: ForwardedRequest | null): boolean {
  if (!last || (inputId !== null && inputId !== last.inputId)) return false;
  return sharedWordShare(text, last.text) >= REPEATED_REQUEST_OVERLAP_MIN;
}

/** A request with at least this share of its words in an update the narrator was given passes that update on. */
export const UPDATE_ECHO_MIN = 0.8;
/** ...unless at least this share of its words are the user's own words of the turn. */
export const OWN_WORDS_MIN = 0.5;

/**
 * A send_to_agent that passes on what the narrator was given (a line it said, its status, a note), not the user's
 * request (a real trace: the narrator sent the agent its own result line, "Done. Mecha Royale, ... will each post
 * three times a day", which cost a whole agent turn). `updates`: the texts it was given lately; `userWords`: the
 * user's words of the turn it answers (null: none known); a request made of them ("post it", to the agent's "Should I
 * post it?") is theirs even when the update has the words.
 */
export function echoesUpdate(request: string, updates: readonly string[], userWords: string | null): boolean {
  if (userWords !== null && containedWordShare(request, userWords) >= OWN_WORDS_MIN) return false;
  return updates.some((u) => containedWordShare(request, u) >= UPDATE_ECHO_MIN);
}

/** A transcript heard this soon after a line was said aloud may be that line, picked up by the microphone. */
export const ECHO_WINDOW_MS = 10_000;
/**
 * Speech that starts more than this long after the narrator's audio went silent is never its echo: the microphone
 * only hears the speaker while it sounds, and the server's speech_started comes a little after the audio that
 * started it (the microphone's chunks, the network both ways, the speech detection: well under a second), plus the
 * room's ring. Speech that starts later is the user's whatever its words (the owner's approval answered "Yes, post
 * it." right after "Say yes to allow it, or no." was taken for that line heard back).
 */
export const ECHO_TAIL_MS = 1_500;
/** A transcript with at least this share of its words in what was just said aloud is that line again (echo). */
export const ECHO_OVERLAP_MIN = 0.75;
/** Shorter transcripts are never taken for echo ("okay" after the narrator said "Okay, on it" is the user's). */
const ECHO_MIN_WORDS = 2;

/** Words as compared for echo: lower case, simple endings and contractions off ("Opening" and "open", "you'd" and "you" are one word). */
function stems(text: string): string[] {
  return (text.toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []).map((w) => w.replace(/'(?:s|d|ll|re|ve)$/, "").replace(/(?<=\p{L}{3})(?:ing|ed|es|s)$/u, ""));
}

/**
 * The microphone heard the assistant's own voice (the narrator's line, a result said aloud) and not the user: most
 * of the transcript's words are in what was said aloud lately (`said`). A real trace: "opening the home timeline" was
 * sent to the agent right after the narrator said "Opening the home timeline now." `minWords`: shorter transcripts are
 * never echo (speech that started over the narrator: 1, "I'm." of "I'm doing well").
 */
export function echoesSpoken(transcript: string, said: readonly string[], minWords = ECHO_MIN_WORDS): boolean {
  const heard = stems(transcript);
  if (heard.length < minWords || !said.length) return false;
  const left = new Map<string, number>();
  for (const w of said.flatMap(stems)) left.set(w, (left.get(w) ?? 0) + 1);
  let found = 0;
  for (const w of heard) {
    const n = left.get(w) ?? 0;
    if (n > 0) {
      found++;
      left.set(w, n - 1);
    }
  }
  return found / heard.length >= ECHO_OVERLAP_MIN;
}
