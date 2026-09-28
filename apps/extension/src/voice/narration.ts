/**
 * The lines the Standard engine says while the agent works on the chat it
 * follows: the agent's short opening plan, a short line when it starts
 * something new and "Still …" after a long silence (milestones.ts
 * ProgressPacer), an error in plain words, and the turn's result or question
 * (spoken-line.ts). Everything else stays on screen. Pure.
 */
import type { AgentEvent } from "@noa/shared";
import { ProgressPacer } from "./milestones.js";
import { endLine, errorLine, planLine } from "./spoken-line.js";
import { approvalLine } from "./approval-voice.js";

export class Narration {
  private readonly progress = new ProgressPacer();
  /** The turn's opening text was seen (only it can be the plan). */
  private opened = false;
  /** An error was said this turn (its end then does not repeat it). */
  private erred = false;

  /** The line to say for an event of the chat, or null. */
  push(ev: AgentEvent, now: number): string | null {
    const line = this.lineFor(ev, now);
    if (line) this.progress.said(now);
    return line;
  }

  /** While the agent works (and nothing else is being said): "Still …" after a long silence, or null. */
  tick(now: number): string | null {
    return this.progress.stillWorking(now);
  }

  /** Something else was said (a line the panel says for itself). */
  said(now: number): void {
    this.progress.said(now);
  }

  private lineFor(ev: AgentEvent, now: number): string | null {
    switch (ev.type) {
      case "user_message":
        this.newTurn(now);
        return null;
      case "assistant_text": {
        if (this.opened) return null;
        this.opened = true;
        return planLine(ev.text);
      }
      case "tool_call":
        return this.progress.step(ev, now);
      case "error":
        this.erred = true;
        return errorLine(ev.text);
      case "approval_request":
        return approvalLine(ev.request);
      case "task_end": {
        const repeat = this.erred && !ev.spoken;
        this.newTurn(now);
        return repeat ? null : endLine(ev);
      }
      default:
        return null;
    }
  }

  private newTurn(now: number): void {
    this.opened = false;
    this.erred = false;
    this.progress.reset(now);
  }
}
