/**
 * What the Realtime narrator is told about the chat, from the agent's events: the lines to say, word for word
 * (realtime-client.ts say(): the result, the agent's question, a problem, an approval to ask for, progress while it
 * works), and one status for context (setStatus(): what it works on, what was said last, what waits for the user).
 * The narrator never picks what to say from a pile of updates: it said the oldest one it had not said yet, so its
 * answers ran a turn or two behind the user (test/manual/realtime-lag.live.ts).
 *
 * A line is said only when the agent wrote it knowing the user's latest request (fresh()): a request is sent
 * (sent()), the agent takes it (a new turn, or its voice message into the running one) and reads it (a new turn at
 * once; a message into a running turn when the brain says so, isMessageRead, or when the turn ends, which it cannot
 * before). What the agent wrote before, an old turn's end or a step's text written before the message was read, stays
 * in the chat and is not said. Only milestones (milestones.ts), the agent's answer or spoken line (spoken-line.ts),
 * errors and approvals are said: never what the agent types or what pages say. Pure.
 */
import { isMessageRead, type AgentEvent } from "@noa/shared";
import { freshMemory, narrationOf, type NarrationMemory, type SpokenKind } from "./narrator-policy.js";
import { ProgressPacer } from "./milestones.js";
import { approvalLine } from "./approval-voice.js";
import { containedWordShare } from "../text.js";

/** The user's request and a typed message are kept in the status up to this many characters. */
const MAX_STATUS_TEXT = 200;

/** Something to say, word for word (in the user's language); `kind` decides when it may start (narrator-policy.ts floor). */
export interface FeedLine {
  kind: SpokenKind;
  line: string;
}

export type FeedOutput = { say: FeedLine } | { status: string };

/** A request's words as compared with its voice message (the runner sends them trimmed). */
const words = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * What the agent says it does next rather than an answer: "Let me open Dana's email to see…", "I'll check the inbox",
 * "I need to find it first". Written after it read a question, it came before the answer (live, Claude Code).
 */
const STEP_NARRATION =
  /(?:^\s*(?:let's|i have to|i'm (?:now )?(?:checking|opening|looking|going)|now i|first,? i|next,? i|(?:checking|opening|looking)\b)|\b(?:let me|i'll|i will|i'm going to|i am going to|i need to)\b)/i;
export const stepNarration = (text: string): boolean => STEP_NARRATION.test(text);

/**
 * The agent's text without its sentences about what it does next ("The latest email is from Dana Kim. Let me open it
 * to see the agenda." is only its first sentence); "" when nothing else is left.
 */
export function withoutStepNarration(text: string): string {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?]["'”’)\]*]*)\s+/);
  return sentences
    .map((x) => x.trim())
    .filter((x) => x && !stepNarration(x))
    .join(" ");
}

/** How long an answer written mid-turn waits for the turn's end, which then says it instead. */
export const ANSWER_HOLD_MS = 5_000;

/** The turn's line covers the answer held mid-turn when at least this share of the answer's words are in it. */
export const ANSWER_COVERED_MIN = 0.6;

/** A line with at least this share of its words in lines already said for the request is not said again. */
export const ALREADY_SAID_MIN = 0.8;

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export class NarratorFeed {
  private memory: NarrationMemory = freshMemory();
  private readonly progress = new ProgressPacer();
  /** Requests the narrator sent (send_to_agent), in order (their words, for the voice message that carries one). */
  private readonly sentTexts: string[] = [];
  /** How many of them the agent took. */
  private taken = 0;
  /** A turn of the chat is running: from a request that starts one (or its first event) until its task_end. */
  private running = false;
  /** Events of the running turn so far (a voice message that is its first event opens it). */
  private turnEvents = 0;
  /** The requests sent up to the one that started the running turn: its first event means the agent took them. */
  private startedBy = 0;
  /** The agent read the latest message it took (a message into a running turn is read at its next step). */
  private read = true;
  /** For the status. */
  private request: string | null = null;
  /** The agent's answer to a question asked while it works, held ANSWER_HOLD_MS (its turn's end may say it better). */
  private pendingAnswer: { text: string; at: number } | null = null;
  /** The lines of news said for the latest request (a line whose words were all said already is not said again). */
  private saidLines: string[] = [];
  private step: string | null = null;
  private asked: string | null = null;
  private approval: string | null = null;

  /**
   * A request went to the agent at `now`: `question`, asked while it works (its answer is its next words once it
   * read it), else an instruction or a new turn (its end says the result). What is said about it starts over.
   */
  sent(text: string, question: boolean, now: number, agentWorking = question): FeedOutput[] {
    this.sentTexts.push(words(text));
    if (!this.running) {
      this.running = true;
      // The agent works on a turn this feed has not seen yet (voice started mid-turn): the request goes into it.
      // Else the request starts a turn, whose first event (a new chat's first turn has no message of its own; a next
      // turn's is the voice message) says the agent took it. It may be slow to come (Claude Code starting): a
      // request said meanwhile goes into that turn.
      this.turnEvents = agentWorking ? 1 : 0;
      this.startedBy = this.sentCount;
    }
    this.request = clip(text, MAX_STATUS_TEXT);
    this.asked = null;
    this.saidLines = [];
    this.pendingAnswer = null;
    if (question) this.memory.awaitingAnswer = true;
    else {
      this.memory = freshMemory(now);
      this.progress.reset(now);
    }
    return [this.status()];
  }

  /** The narrator spoke at `now` (anything: an acknowledgement, an answer, a line): progress waits its turn after it. */
  spoke(now: number): void {
    this.progress.said(now);
  }

  /** While the agent works: "Still …" after a long silence, else nothing. */
  tick(now: number): FeedOutput[] {
    if (!this.fresh()) return [];
    // The agent goes on working after its answer: the answer is said now.
    if (this.pendingAnswer && now - this.pendingAnswer.at >= ANSWER_HOLD_MS) return this.sayAnswer(now);
    const line = this.progress.stillWorking(now);
    return line ? [{ say: { kind: "milestone", line } }] : [];
  }

  /** The answer held (pendingAnswer), said once. */
  private sayAnswer(now: number): FeedOutput[] {
    const held = this.pendingAnswer;
    this.pendingAnswer = null;
    return held ? this.sayHeld(held, now) : [];
  }

  private sayHeld(held: { text: string }, now: number): FeedOutput[] {
    const memory = { ...this.memory, awaitingAnswer: true };
    const spoken = narrationOf({ type: "assistant_text", text: held.text }, memory, now);
    this.memory.lastLine = memory.lastLine;
    this.memory.lastSpokenAt = memory.lastSpokenAt;
    // Answered: what it writes next goes on with the task.
    this.memory.awaitingAnswer = false;
    if (!spoken || this.alreadySaid(spoken.line)) return [];
    this.saidLines.push(spoken.line);
    this.progress.said(now);
    return [{ say: { kind: "result", line: spoken.line } }];
  }

  private get sentCount(): number {
    return this.sentTexts.length;
  }

  /** The agent wrote this knowing the user's latest request. */
  fresh(): boolean {
    return this.taken >= this.sentCount && this.read;
  }

  /** An event of the chat the session follows: what to say, and the status when it changed. */
  push(ev: AgentEvent, now: number): FeedOutput[] {
    if (isMessageRead(ev)) {
      this.read = true;
      return [];
    }
    if (ev.type === "trace" || ev.type === "assistant_text_delta") return [];
    // A turn this feed did not see start (voice started mid-turn): it runs what was sent so far.
    if (!this.running && ev.type !== "task_end") {
      this.running = true;
      this.turnEvents = 0;
      this.startedBy = this.sentCount;
    }
    // The first event of a turn: the agent took the requests that started it, and starts from them (read).
    const first = this.running && this.turnEvents++ === 0;
    if (first) {
      this.taken = Math.max(this.taken, this.startedBy);
      this.read = true;
    }
    if (ev.type === "user_message") return this.message(ev, first);
    switch (ev.type) {
      case "task_end": {
        // A turn cannot end before its messages are read: its end is fresh unless a request went out after it.
        this.running = false;
        this.read = true;
        this.approval = null;
        this.step = null;
        const fresh = this.fresh();
        const held = fresh ? this.pendingAnswer : null;
        this.pendingAnswer = null;
        const spoken = narrationOf(ev, this.memory, now);
        // The answer held mid-turn is said first unless the turn's line covers it (live: Claude's line mostly said
        // both, whole; a line about the task alone would have lost the answer).
        const answer = held && !(spoken?.kind === "result" && containedWordShare(held.text, spoken.line) >= ANSWER_COVERED_MIN) ? this.sayHeld(held, now) : [];
        // The answer said is the turn's end: no bare "Done." after it.
        if (answer.length && !ev.spoken?.trim() && ev.outcome === "done") return [...answer, this.status()];
        // Its answer said already mid-turn, in other words (live: the same answer twice, 10 s apart).
        if (!fresh || !spoken || (spoken.kind === "result" && this.alreadySaid(spoken.line))) return [...answer, this.status()];
        if (spoken.kind === "result") this.saidLines.push(spoken.line);
        this.progress.said(now);
        if (spoken.kind === "question") this.asked = spoken.line;
        return [...answer, { say: { kind: spoken.kind, line: spoken.line } }, this.status()];
      }
      case "assistant_text": {
        // Its answer to a question asked while it works: only words written after it read the question, and not
        // what it says it does next ("Let me open her email to see…": live with Claude Code, said as the answer).
        // The first such words are its answer (it is told to answer before its next tool call; what it writes after
        // goes on with the task: live, a step's "Reading it now." took the answer's place). Held ANSWER_HOLD_MS: the
        // turn's end mostly comes within seconds and says it whole (live, Claude Code: the words mid-turn were often
        // half an answer, then the end said it again).
        if (!this.memory.awaitingAnswer || !this.fresh() || this.pendingAnswer) return [];
        const answer = withoutStepNarration(ev.text);
        if (answer) this.pendingAnswer = { text: answer, at: now };
        return [];
      }
      case "tool_call": {
        const line = this.progress.step(ev, now);
        if (!line) return [];
        this.step = line;
        return this.fresh() ? [{ say: { kind: "milestone", line } }, this.status()] : [this.status()];
      }
      case "error": {
        // A problem is said even when the agent has not read the latest request yet: it is about what runs now.
        const spoken = narrationOf(ev, this.memory, now);
        if (!spoken) return [];
        this.progress.said(now);
        return [{ say: { kind: "error", line: spoken.line } }];
      }
      case "approval_request":
        this.approval = approvalLine(ev.request);
        return [{ say: { kind: "question", line: this.approval } }, this.status()];
      case "approval_resolved":
        this.approval = null;
        return [this.status()];
      default:
        return [];
    }
  }

  /**
   * The user's message in the chat: said to the narrator (a request it sent; the agent took it and every one before),
   * or typed in the panel. As the turn's first event it opens the turn (read); else it went into the running turn,
   * read at the agent's next step.
   */
  private message(ev: Extract<AgentEvent, { type: "user_message" }>, first: boolean): FeedOutput[] {
    if (ev.voice) {
      const at = this.sentTexts.lastIndexOf(words(ev.text));
      this.taken = Math.min(Math.max(this.taken, at >= 0 ? at + 1 : this.taken + 1), this.sentCount);
    } else {
      // Typed: a new request the narrator did not send; what the agent wrote before it is old news too.
      this.request = clip(ev.text, MAX_STATUS_TEXT);
      this.memory = freshMemory(this.memory.lastSpokenAt);
    }
    if (!first) this.read = false;
    this.asked = null;
    return [this.status()];
  }

  /** Nearly every word of `line` was said already for this request. */
  private alreadySaid(line: string): boolean {
    return this.saidLines.length > 0 && containedWordShare(line, this.saidLines.join(" ")) >= ALREADY_SAID_MIN;
  }

  /**
   * The narrator's context: what it works on, its latest step, what waits for the user. Never something to say, and
   * never a result (it used to hold the last line said, and the narrator said it again when the user said "hello?").
   */
  private status(): FeedOutput {
    const parts = [
      this.running ? `You are working on the user's request${this.request ? `: «${this.request}»` : "."}` : this.request ? `You finished working on «${this.request}».` : "You are not working on anything.",
    ];
    if (this.running && this.step) parts.push(`Latest step: ${this.step}.`);
    if (this.asked) parts.push(`You asked the user: «${this.asked}» Give their answer to send_to_agent.`);
    if (this.approval) parts.push(`An action waits for the user's OK: «${this.approval}» When they plainly answer yes or no, call answer_approval.`);
    return { status: `Status (context for answering the user; not something to say by itself): ${parts.join(" ")}` };
  }
}
