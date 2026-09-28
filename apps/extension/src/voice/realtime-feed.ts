/**
 * What the Realtime narrator is told about the chat: short text notes made
 * from the agent's events, each saying whether the narrator should speak
 * about it (and as what), by the one policy in narrator-policy.ts: the
 * result, the agent's question, a problem, and now and then a meaningful step.
 * What only echoes the user's request (their voice message, their words, the
 * agent restating it) is not passed on. Only milestones (milestones.ts), the
 * agent's own text (clipped, as context) and the short result lines
 * (spoken-line.ts) are passed on: never what the agent types or what pages
 * say. Pure.
 */
import { USER_STOP_REASON, type AgentEvent } from "@noa/shared";
import { freshMemory, narrationOf, type NarrationMemory, type SpokenKind } from "./narrator-policy.js";
import { approvalLine } from "./approval-voice.js";

/** The agent's text is passed on up to this many characters (the narrator summarises it). */
const MAX_AGENT_TEXT = 300;
/** The user's typed message is noted up to this many characters. */
const MAX_USER_TEXT = 300;

export interface FeedNote {
  text: string;
  /** Ask the narrator to say something about it (as this kind of line); null: context only. */
  speak: SpokenKind | null;
}

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export class NarratorFeed {
  private memory: NarrationMemory = freshMemory();
  /** The agent's latest words (context for a milestone). */
  private said: string | null = null;

  /** A request went to the agent at `now` (the narrator acknowledged it): what it says about it starts over. */
  request(now: number): void {
    this.memory = freshMemory(now);
    this.said = null;
  }

  /** The user asked the agent something while it works on a request: its next words are the answer (said once). */
  question(): void {
    this.memory.awaitingAnswer = true;
  }

  /** An event of the chat the session follows: the notes for the narrator. */
  push(ev: AgentEvent, now: number): FeedNote[] {
    const spoken = narrationOf(ev, this.memory, now);
    switch (ev.type) {
      case "assistant_text":
        if (ev.text.trim()) this.said = clip(ev.text, MAX_AGENT_TEXT);
        return spoken ? [{ text: `Your update (answer): Your answer to the user's question: "${spoken.line}" Tell the user in one or two short sentences, in the first person.`, speak: "result" }] : [];
      case "user_message":
        // Said to the narrator (send_to_agent): it knows. Typed in the panel: a new request it should know of.
        if (ev.voice) return [];
        this.request(this.memory.lastSpokenAt);
        return [{ text: `Your update: the user typed you a message: "${clip(ev.text, MAX_USER_TEXT)}". Do not reply to it.`, speak: null }];
      case "tool_call": {
        if (!spoken) return [];
        const context = this.said ? ` (You last wrote: "${this.said}")` : "";
        return [{ text: `Your update (progress): ${spoken.line}.${context} Say it in a few words, in the first person, only if it is news to the user.`, speak: "milestone" }];
      }
      case "error":
        return spoken ? [{ text: `Your update (problem): "${spoken.line}" Tell the user briefly, in the first person.`, speak: "error" }] : [];
      case "approval_request":
        return [{ text: `Your update (you need the user's OK): "${approvalLine(ev.request)}" Ask the user in a few words, then call answer_approval with their answer.`, speak: "question" }];
      case "task_end": {
        this.said = null;
        if (!spoken) return [];
        if (spoken.kind === "question") {
          return [{ text: `Your update (you need the user): Your question: "${spoken.line}" Ask the user, and give their answer to send_to_agent.`, speak: "question" }];
        }
        const what =
          ev.outcome === "done"
            ? "The task is done."
            : ev.outcome === "paused" && ev.reason?.trim() === USER_STOP_REASON
              ? "The user stopped the task."
              : ev.outcome === "paused"
                ? "The task is waiting for the user."
                : "The task did not work.";
        return [{ text: `Your update (finished): ${what} Tell the user in one to three short sentences, in the first person: "${spoken.line}"`, speak: "result" }];
      }
      default:
        return [];
    }
  }
}
