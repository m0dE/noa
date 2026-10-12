/**
 * The lines the Standard engine says while the agent works on the chat it
 * follows: the agent's short opening plan (once it goes on to work: an
 * opening the turn's end follows at once was its answer, and the end says
 * it), a short line when it starts something new and "Still …" after a long
 * silence (milestones.ts ProgressPacer), its answer to a message sent while
 * it works (answer_user), an error in plain words, and the turn's result or
 * question (spoken-line.ts). Everything else stays on screen. Pure.
 */
import { ANSWER_TOOL, TASK_END_TOOLS, type AgentEvent } from "@noa/shared";
import { ProgressPacer } from "./milestones.js";
import { answerLine, endLine, errorLine, planLine, saidBefore, unsaid } from "./spoken-line.js";
import { approvalLine } from "./approval-voice.js";

/**
 * The opening text is said as the plan once the agent goes on to work (a tool call), or after this long without the
 * turn ending. Said at once, an opening that was the answer was heard twice in other words: "There's nothing for me
 * to do here — this just asks to end the session...", then the turn's end, "Okay, stopping here." (the owner's trace,
 * session 91861ab2). The end came 0.5-0.7 s after the opening in the traces.
 */
export const PLAN_HOLD_MS = 2_000;

export class Narration {
  private readonly progress = new ProgressPacer();
  /** The turn's opening text was seen (only it can be the plan). */
  private opened = false;
  /** An error was said this turn (its end then does not repeat it). */
  private erred = false;
  /** The lines said this turn (its end leaves out what they said), and in the turn before. */
  private lines: string[] = [];
  private before: string[] = [];
  /** The opening plan, held until the agent goes on to work (PLAN_HOLD_MS). */
  private plan: { line: string; at: number } | null = null;

  /** The line to say for an event of the chat, or null. */
  push(ev: AgentEvent, now: number): string | null {
    const line = this.lineFor(ev, now);
    if (!line) return null;
    this.progress.said(now);
    if (ev.type !== "task_end") this.lines.push(line);
    return line;
  }

  /** While the agent works (and nothing else is being said): the plan held PLAN_HOLD_MS, "Still …" after a long silence, or null. */
  tick(now: number): string | null {
    if (this.plan && now - this.plan.at >= PLAN_HOLD_MS) {
      const line = this.takePlan();
      this.progress.said(now);
      this.lines.push(line);
      return line;
    }
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
        if (plan) this.plan = { line: plan, at: now };
        return null;
      }
      case "tool_call": {
        if (ev.name === ANSWER_TOOL) {
          // Its answer to the user's message is what it says now (an opening held is moot).
          this.plan = null;
          const text = (ev.args as { text?: unknown } | undefined)?.text;
          return typeof text === "string" ? answerLine(text) || null : null;
        }
        // Ending the turn: what it says is the end's (the plan held was its answer).
        if (TASK_END_TOOLS.includes(ev.name as (typeof TASK_END_TOOLS)[number])) return null;
        const step = this.progress.step(ev, now);
        // Work: the plan first (its step is the next one's news).
        return this.plan ? this.takePlan() : step;
      }
      case "error":
        this.erred = true;
        this.plan = null;
        return errorLine(ev.text);
      case "approval_request":
        this.plan = null;
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

  private takePlan(): string {
    const line = this.plan!.line;
    this.plan = null;
    return line;
  }

  private newTurn(now: number): void {
    this.opened = false;
    this.erred = false;
    this.plan = null;
    // A turn that ended without its end (a new message into it): what it said is the turn before.
    if (this.lines.length) this.before = this.lines;
    this.lines = [];
    this.progress.reset(now);
  }
}
