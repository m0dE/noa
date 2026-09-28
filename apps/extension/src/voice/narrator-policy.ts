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
import { USER_STOP_REASON, type AgentEvent } from "@noa/shared";
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
  /** The user asked the agent something while it worked: its next words are the answer, said once. */
  awaitingAnswer: boolean;
}

export const freshMemory = (now = -Infinity): NarrationMemory => ({ lastSpokenAt: now, lastLine: null, awaitingAnswer: false });

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
 * for context). Speaks for: the result (the agent's spoken line), its answer to a question the user asked while it
 * worked, its question, a problem. Never for the user's message or words, the agent's other text (it restates the
 * request) or status lines; steps are progress (ProgressPacer), not news. `line`: the words it is about.
 */
export function narrationOf(ev: AgentEvent, memory: NarrationMemory, now: number): { kind: SpokenKind; line: string } | null {
  switch (ev.type) {
    case "assistant_text": {
      const line = memory.awaitingAnswer ? answerLine(ev.text) : "";
      if (!line) return null;
      memory.awaitingAnswer = false;
      return news(line, memory, now) ? { kind: "result", line } : null;
    }
    case "task_end": {
      // The turn's end says what is left to say (its answer included).
      memory.awaitingAnswer = false;
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
 * - The user speaking, or their reply about to start: dropped. Their reply is made with every note so far (a result
 *   included), so it answers once, with the news in it.
 * - A reply being made or audio playing: a milestone is let go (old news by then); the acknowledgement, a result, a
 *   question and a problem wait their turn.
 */
export function floor(kind: SpokenKind, f: Floor): "now" | "later" | "drop" {
  if (f.userSpeaking || f.awaitingReply) return "drop";
  if (f.replying || f.playing) return kind === "milestone" ? "drop" : "later";
  return "now";
}

/** Replies waiting for the floor: the most important one is made (it covers the others, whose notes it sees). */
const RANK: Record<SpokenKind, number> = { milestone: 0, ack: 1, result: 2, error: 3, question: 4 };
export const moreImportant = (a: SpokenKind | null, b: SpokenKind): SpokenKind => (a && RANK[a] >= RANK[b] ? a : b);

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

/**
 * How the narrator's updates begin (realtime-feed.ts: "Your update (...)", formerly "Agent update") and how it words
 * passing one on ("Tell the user the result: ..."). The heading needs its "(" or ":" so a user's "your update was
 * wrong" is still theirs.
 */
const UPDATE_WORDING = /^\s*(?:(?:your|agent) update\s*[(:]|tell the user\b)/i;
/** A request with at least this share of its words in an update the narrator was given passes that update on. */
export const UPDATE_ECHO_MIN = 0.8;
/** ...unless at least this share of its words are the user's own words of the turn. */
export const OWN_WORDS_MIN = 0.5;

/**
 * A send_to_agent that passes on an update the narrator was given, not the user's request (a real trace: the narrator
 * sent the agent "Tell the user the result: Done. Mecha Royale, ... will each post three times a day", its own result
 * line, which cost a whole agent turn). `userWords`: the user's words of the turn it answers (null: none known); a
 * request made of them ("post it", to the agent's "Should I post it?") is theirs even when the update has the words.
 */
export function echoesUpdate(request: string, updates: readonly string[], userWords: string | null): boolean {
  if (UPDATE_WORDING.test(request)) return true;
  if (userWords !== null && containedWordShare(request, userWords) >= OWN_WORDS_MIN) return false;
  return updates.some((u) => containedWordShare(request, u) >= UPDATE_ECHO_MIN);
}

/**
 * What a user's turn is, by its words: small talk the narrator may answer by itself (a greeting, "can you hear me",
 * thanks, a filler, what the agent is doing now), or a request, which must go through one of its tools. Anything about
 * what the agent did, saw, knows or remembers, a follow-up or correction ("no, I meant yesterday"), a question for the
 * browser, a command: the narrator's own notes are not the truth about those (it once told a user "yesterday, I told
 * you..." of something said minutes earlier). Unknown words count as a request: the agent answering a greeting costs
 * a turn, the narrator answering a request makes things up.
 */
export type SpeechTurn = "small_talk" | "request";

/** Whole clauses that are small talk (lowercase, no punctuation). English and Korean, the languages voice is used in. */
const SMALL_TALK = new RegExp(
  "^(?:" +
    [
      "(?:hi|hello|hey|yo)(?: there)?(?: (?:jev|noa))?",
      "good (?:morning|afternoon|evening)|morning",
      "(?:can|could|do) you (?:still )?hear me(?: now| okay| ok)?|you there|are you (?:still )?(?:there|listening|with me)",
      "testing(?: testing)*(?: one two(?: three)?)?|is (?:this|it) (?:working|on)",
      "(?:thanks|thank you)(?: (?:so|very) much| a lot)?|(?:ok|okay|cool|great|nice|perfect|awesome|alright|all right|good|sure|fine)(?: thanks| thank you)?|got it|sounds good",
      "um+|uh+|hmm+|wait|hold on|one sec(?:ond)?|just a sec(?:ond)?|let me think",
      // What the agent is doing now, or whether the assistant is there: answered from the latest update, never a new request.
      "what (?:are|r) (?:you|u|we|they|it) (?:doing|up to|working on)(?: (?:right )?now)?|what(?:'s| is) (?:it|the agent) doing(?: (?:right )?now)?",
      "what(?:'s| is) (?:going on|happening|the status|taking so long)(?: (?:right )?now)?|how(?:'s| is) it going|(?:are|r) you (?:done|busy|working|alive)(?: yet)?",
      "(?:i'm|i am|im) asking you(?: a question| something)?|answer me",
      "안녕(?:하세요)?|여보세요|(?:제 말 )?들려(?:요)?|들리(?:세요|나요|니)|고마워(?:요)?|감사합니다|알았어(?:요)?|알겠(?:어|어요|습니다)|오케이|좋아(?:요)?|잠깐(?:만)?(?:요)?",
    ].join("|") +
    ")$",
  "u",
);

/** Words that change nothing of what a clause asks: address, fillers, swearing ("what are you doing bro"). */
const FILLERS = /\b(?:bro|bruh|dude|man|buddy|mate|guys?|the (?:fuck|hell|heck)|fuck(?:ing)?|freaking|damn|like|you know|so|just|please|um+|uh+|yo|hey|come on)\b/gu;
/** "I'm asking you what are you doing": the question is what follows. */
const ASKING = /^(?:(?:i'm|i am|im) asking(?: you)?|i said|i asked(?: you)?|tell me) (?=\S)/u;

/**
 * A clause is small talk as said, without its fillers ("what are you doing bro"), or as the question after "I'm
 * asking you" ("I'm asking you what the fuck are you doing").
 */
function smallTalkClause(clause: string): boolean {
  const plain = clause.replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!plain) return true;
  const lean = plain.replace(FILLERS, " ").replace(/\s+/g, " ").trim();
  return [plain, lean, lean.replace(ASKING, "")].some((c) => SMALL_TALK.test(c));
}

export function speechTurnOf(words: string): SpeechTurn {
  const clauses = words.toLowerCase().replace(/[’`]/g, "'").split(/[.,!?;:…]+/u);
  return clauses.every(smallTalkClause) ? "small_talk" : "request";
}

/** A transcript heard this soon after a line was said aloud may be that line, picked up by the microphone. */
export const ECHO_WINDOW_MS = 10_000;
/** A transcript with at least this share of its words in what was just said aloud is that line again (echo). */
export const ECHO_OVERLAP_MIN = 0.75;
/** Shorter transcripts are never taken for echo ("okay" after the narrator said "Okay, on it" is the user's). */
const ECHO_MIN_WORDS = 2;

/** Words as compared for echo: lower case, simple endings off ("Opening" and "open" are one word). */
function stems(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((w) => w.replace(/'s$/, "").replace(/(?<=\p{L}{3})(?:ing|ed|es|s)$/u, ""));
}

/**
 * The microphone heard the assistant's own voice (the narrator's line, a result said aloud) and not the user: most
 * of the transcript's words are in what was said aloud lately (`said`). A real trace: "opening the home timeline" was
 * sent to the agent right after the narrator said "Opening the home timeline now."
 */
export function echoesSpoken(transcript: string, said: readonly string[]): boolean {
  const heard = stems(transcript);
  if (heard.length < ECHO_MIN_WORDS || !said.length) return false;
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
