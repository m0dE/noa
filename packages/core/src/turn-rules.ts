/**
 * The rules of one agent turn that both brains share (the Claude API loop in
 * api-agent.ts, and the helper's Claude Code sessions): the tool call
 * budget, the time limit, and the events that close a turn.
 */
import { TASK_END_TOOLS, type AgentEvent, type ElementPicks, type TaskRunResult, type ToolName } from "@noa/shared";
import { picksEvent } from "./executor.js";

/** Past maxToolCalls the agent is told to call task_fail; this many calls past the max the turn is stopped. */
export const TOOL_CALL_STOP_MARGIN = 5;

/**
 * What to do with a tool call, given how many the turn has made including
 * this one: run it, refuse it (TOOL_CALL_LIMIT_REACHED), or stop the turn
 * (toolCallLimitExceeded). task_* calls are not counted: always run them.
 */
export type ToolBudget = "run" | "refuse" | "stop";

export function toolBudget(calls: number, maxToolCalls: number): ToolBudget {
  if (calls >= maxToolCalls + TOOL_CALL_STOP_MARGIN) return "stop";
  return calls > maxToolCalls ? "refuse" : "run";
}

/** task_complete, task_fail and task_pause end the turn and never count against its budget. */
export function isTaskEndTool(name: ToolName): boolean {
  return TASK_END_TOOLS.includes(name);
}

/** Answer to a refused tool call. */
export const toolCallLimitReached = (maxToolCalls: number) => `Tool call limit of ${maxToolCalls} reached. Call task_fail now with a short reason.`;
/** Failure reason of a turn stopped for making far too many tool calls. */
export const toolCallLimitExceeded = (maxToolCalls: number) => `Tool call limit exceeded (${maxToolCalls} calls)`;
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
  events.push(end);
  return events;
}
