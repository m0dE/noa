/**
 * One turn of a task session: from the first message (or a follow-up) to its
 * task_* call. Holds the turn's limits (tool calls, time) and turns its state
 * into the TaskRunResult the extension gets. The rules and texts are core's,
 * shared with the Claude API brain.
 */
import type { RunConfig, TaskRunResult, ToolName } from "@noa/shared";
import { agentError, ENDED_WITHOUT_RESULT, EXITED_WITHOUT_RESULT, isTaskEndTool, timeLimitReached, toolBudget, toolCallLimitExceeded, toolCallLimitReached } from "@noa/core";

export interface Turn {
  config: RunConfig;
  finish: TaskRunResult | null;
  forcedPause: string | null;
  abortReason: string | null;
  timedOut: boolean;
  /** Persistent brains: the agent went idle without a task_* call. */
  idleEnd: boolean;
  lastError: string | null;
  toolCalls: number;
  /** When the time limit ends the turn (epoch ms; set with the limit's timer). */
  endsAt?: number;
  timeLimit?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Resolves the turn's wait early (persistent brains: result recorded, or idle). */
  settle: () => void;
  settled: Promise<void>;
}

export function createTurn(config: RunConfig): Turn {
  let settle!: () => void;
  const settled = new Promise<void>((r) => (settle = r));
  return {
    config,
    finish: null,
    forcedPause: null,
    abortReason: null,
    timedOut: false,
    idleEnd: false,
    lastError: null,
    toolCalls: 0,
    settle,
    settled,
  };
}

export function clearTurnTimers(t: Turn): void {
  clearTimeout(t.timeLimit);
  if (t.graceTimer) clearTimeout(t.graceTimer);
}

/**
 * Counts a tool call against the turn's limit (task_* calls are free).
 * `refusal`: text returned to the agent instead of running the tool.
 * `stop`: the limit is far exceeded; the caller aborts the turn.
 */
export function checkToolCall(t: Turn, name: ToolName): { refusal: string | null; stop?: true } {
  const ends = isTaskEndTool(name);
  if (t.finish) return { refusal: ends ? "The task result was already recorded. Stop now." : "The task is finished. Stop now." };
  if (ends) return { refusal: null };
  const max = t.config.maxToolCalls;
  const budget = toolBudget(++t.toolCalls, max);
  if (budget === "stop") {
    if (t.abortReason === null) t.abortReason = toolCallLimitExceeded(max);
    return { refusal: "Tool call limit exceeded. The task was stopped.", stop: true };
  }
  return { refusal: budget === "refuse" ? toolCallLimitReached(max) : null };
}

/** The turn's outcome. `brainError`: the brain crashed (session-wide). */
export function turnResult(t: Turn, brainError: string | null): TaskRunResult {
  if (t.forcedPause !== null) return { outcome: "paused", reason: t.forcedPause };
  if (t.finish) return { ...t.finish };
  if (t.abortReason !== null) return { outcome: "failed", reason: t.abortReason };
  if (t.timedOut) return { outcome: "failed", reason: timeLimitReached(t.config.maxTaskMinutes) };
  if (brainError) return { outcome: "failed", reason: agentError(brainError) };
  // e.g. "Claude Code: Claude AI usage limit reached" (the extension classifies it as temporary)
  if (t.lastError) return { outcome: "failed", reason: t.lastError };
  if (t.idleEnd) return { outcome: "failed", reason: ENDED_WITHOUT_RESULT };
  return { outcome: "failed", reason: EXITED_WITHOUT_RESULT };
}
