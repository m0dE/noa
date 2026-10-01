/**
 * The lines the Standard engine says while the agent works on the chat it
 * follows: the agent's short opening plan, a short line when it starts
 * something new and "Still …" after a long silence (milestones.ts
 * ProgressPacer), an error in plain words, and the turn's result or question
 * (spoken-line.ts). Everything else stays on screen. Pure.
 */
import type { AgentEvent } from "@noa/shared";
import { ProgressPacer } from "./milestones.js";
import { endLine, errorLine, planLine, saidBefore, unsaid } from "./spoken-line.js";
import { approvalLine } from "./approval-voice.js";

export class Narration {
  private readonly progress = new ProgressPacer();
  /** The turn's opening text was seen (only it can be the plan). */
  private opened = false;
  /** An error was said this turn (its end then does not repeat it). */
  private erred = false;
  /** The lines said this turn (its end leaves out what they said), and in the turn before. */
  private lines: string[] = [];
  private before: string[] = [];

  /** The line to say for an event of the chat, or null. */
  push(ev: AgentEvent, now: number): string | null {
    const line = this.lineFor(ev, now);
    if (!line) return null;
    this.progress.said(now);
    if (ev.type !== "task_end") this.lines.push(line);
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
        const plan = planLine(ev.text);
        // The last answer again (Claude Code opening a turn by restating it): not said again, and not the opening.
        if (plan && saidBefore(plan, [...this.before, ...this.lines])) return null;
        this.opened = true;
        return plan;
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
        const said = this.lines;
        const line = repeat ? null : unsaid(endLine(ev), said) || null;
        this.newTurn(now);
        this.before = line ? [...said, line] : said;
        return line;
      }
      default:
        return null;
    }
  }

  private newTurn(now: number): void {
    this.opened = false;
    this.erred = false;
    // A turn that ended without its end (a new message into it): what it said is the turn before.
    if (this.lines.length) this.before = this.lines;
    this.lines = [];
    this.progress.reset(now);
  }
}
