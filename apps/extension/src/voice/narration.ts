/**
 * The lines the Standard engine says while the agent works on the chat it
 * follows: the agent's short opening plan, a milestone now and then
 * (milestones.ts), an error in plain words, and the turn's result or question
 * (spoken-line.ts). Everything else stays on screen. Pure.
 */
import type { AgentEvent } from "@noa/shared";
import { milestoneOf, MilestoneThrottle } from "./milestones.js";
import { endLine, errorLine, planLine } from "./spoken-line.js";
import { approvalLine } from "./approval-voice.js";

export class Narration {
  private readonly milestones = new MilestoneThrottle();
  /** The turn's opening text was seen (only it can be the plan). */
  private opened = false;
  /** An error was said this turn (its end then does not repeat it). */
  private erred = false;

  /** The line to say for an event of the chat, or null. */
  push(ev: AgentEvent, now: number): string | null {
    switch (ev.type) {
      case "user_message":
        this.newTurn();
        return null;
      case "assistant_text": {
        if (this.opened) return null;
        this.opened = true;
        return planLine(ev.text);
      }
      case "tool_call": {
        const m = milestoneOf(ev);
        return m ? this.milestones.offer(m, now) : null;
      }
      case "error":
        this.erred = true;
        return errorLine(ev.text);
      case "approval_request":
        return approvalLine(ev.request);
      case "task_end": {
        const repeat = this.erred && !ev.spoken;
        this.newTurn();
        return repeat ? null : endLine(ev);
      }
      default:
        return null;
    }
  }

  private newTurn(): void {
    this.opened = false;
    this.erred = false;
    this.milestones.reset();
  }
}
