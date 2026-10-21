/**
 * The rules of one agent turn that both brains share (the Claude API loop in
 * api-agent.ts, and the helper's Claude Code sessions): the tool call
 * budget, the time limit, and the events that close a turn.
 */
import { TASK_END_TOOLS, type AgentEvent, type ElementPicks, type TaskRunResult, type ToolName } from "@noa/shared";
import { picksEvent } from "./executor.js";
import { OBSERVING_TOOLS, stableJson } from "./reasoning.js";

/** Past the budget the agent is told to call task_fail; this many calls past it the turn is stopped. */
export const TOOL_CALL_STOP_MARGIN = 5;

/**
 * The share of a round's tool calls that must be actions with an outcome new to the turn for the round to count as
 * getting somewhere (madeProgress).
 */
export const PROGRESS_SHARE = 0.2;

/**
 * Whether a stretch of a turn got somewhere: of its `calls` tool calls, at least PROGRESS_SHARE (and at least one)
 * were actions with an outcome new to the turn (ToolProgress.fresh).
 */
export function madeProgress(calls: number, fresh: number): boolean {
  return fresh >= Math.max(1, Math.ceil(calls * PROGRESS_SHARE));
}

/**
 * Counts the actions of a turn whose outcome is new to it, from the executor's events: an action (a tool that
 * changes the page or keeps something, not one that only looks: OBSERVING_TOOLS) that worked, and whose arguments
 * and result were not seen together before this turn. A run going round in circles repeats them or fails; a long job
 * (statement after statement, page after page) keeps making new ones.
 */
export class ToolProgress {
  /** Tool calls seen (task_* calls not counted). */
  calls = 0;
  /** Actions with a new outcome. */
  fresh = 0;
  private readonly pending = new Map<string, string>();
  private readonly seen = new Set<string>();

  observe(e: AgentEvent): void {
    if (e.type === "tool_call") {
      if (isTaskEndTool(e.name as ToolName)) return;
      this.calls++;
      if (!OBSERVING_TOOLS.has(e.name)) this.pending.set(e.id, `${e.name} ${stableJson(e.args)}`);
    } else if (e.type === "tool_result") {
      const call = this.pending.get(e.id);
      if (call === undefined) return;
      this.pending.delete(e.id);
      if (e.isError) return;
      const outcome = `${call}\n${e.text ?? ""}`;
      if (this.seen.has(outcome)) return;
      this.seen.add(outcome);
      this.fresh++;
    }
  }
}

/**
 * What to do with a tool call, given how many the turn has made including
 * this one and how many it may make: run it, refuse it (toolCallLimitReached),
 * or stop the turn (toolCallLimitExceeded). task_* calls are not counted: always run them.
 */
export type ToolBudget = "run" | "refuse" | "stop";

export function toolBudget(calls: number, allowed: number): ToolBudget {
  if (calls >= allowed + TOOL_CALL_STOP_MARGIN) return "stop";
  return calls > allowed ? "refuse" : "run";
}

/**
 * A turn's tool call budget. The Tool calls setting (maxToolCalls) is a round, not a ceiling: when a round is used
 * up and it got somewhere (madeProgress), the turn gets another, so a long job (28 statements to download) runs on
 * while one going round in circles ends after a round as before. The turn's time limits still bound it.
 */
export class TurnBudget {
  /** Tool calls counted so far (task_* calls are free). */
  calls = 0;
  /** Calls the turn may make now: rounds of maxToolCalls, one more for each round that got somewhere. */
  allowed: number;
  readonly progress = new ToolProgress();
  private roundFrom = { calls: 0, fresh: 0 };

  constructor(readonly maxToolCalls: number) {
    this.allowed = maxToolCalls;
  }

  /** Feed it the executor's events (tool_call, tool_result). */
  observe(e: AgentEvent): void {
    this.progress.observe(e);
  }

  /** Counts one tool call (not a task_* call) and says what to do with it. */
  next(): ToolBudget {
    if (++this.calls === this.allowed + 1) {
      const p = this.progress;
      if (madeProgress(p.calls - this.roundFrom.calls, p.fresh - this.roundFrom.fresh)) {
        this.allowed += this.maxToolCalls;
        this.roundFrom = { calls: p.calls, fresh: p.fresh };
      }
    }
    return toolBudget(this.calls, this.allowed);
  }

  /** The calls the turn may make now are used up (the next one is refused unless the round got somewhere). */
  get spent(): boolean {
    return this.calls >= this.allowed;
  }
}

/** task_complete, task_fail and task_pause end the turn and never count against its budget. */
export function isTaskEndTool(name: ToolName): boolean {
  return TASK_END_TOOLS.includes(name);
}

/** Answer to a refused tool call. */
export const toolCallLimitReached = (maxToolCalls: number) =>
  `Tool call limit reached: the last ${maxToolCalls} tool calls got almost nowhere new. Call task_fail now with a short reason: what was done and what is left.`;
/** Failure reason of a turn stopped for making far too many tool calls. */
export const toolCallLimitExceeded = (maxToolCalls: number) => `Tool call limit: the last ${maxToolCalls} tool calls got almost nowhere new`;
/** Failure reason of a turn that ran out of time. */
export const timeLimitReached = (maxTaskMinutes: number) => `Task time limit of ${maxTaskMinutes} minutes reached`;

/** The events that close a turn: who picked act's elements (with Jev on, when any were picked), then task_end. */
export function turnEndEvents(r: TaskRunResult, picks: ElementPicks | null): AgentEvent[] {
  const events: AgentEvent[] = [];
  const picked = picks ? picksEvent(picks) : null;
  if (picked) events.push(picked);
  const end: AgentEvent = { type: "task_end", outcome: r.outcome };
  if (r.summary !== undefined) end.summary = r.summary;
  if (r.url !== undefined) end.url = r.url;
  if (r.reason !== undefined) end.reason = r.reason;
  if (r.suggestion !== undefined) end.suggestion = r.suggestion;
  if (r.spoken !== undefined) end.spoken = r.spoken;
  if (r.draft !== undefined) end.draft = r.draft;
  if (r.byAgent) end.byAgent = true;
  events.push(end);
  return events;
}
