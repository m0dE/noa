import { z } from "zod";

/**
 * How much Claude thinks before it acts (the "Reasoning" setting).
 *
 * - fast: the least thinking the model allows. Claude Code runs with its
 *   extended thinking off; on the Messages API, models that can turn thinking
 *   off do (Sonnet 5; Haiku 4.5 by leaving it out) and models that always
 *   think (Opus 5.5, Fable 5.1) run at low effort. When a run gets stuck, the
 *   next step may think (reasoningAutoRaise; core/src/reasoning.ts).
 * - thorough: the model thinks when it judges it useful (adaptive thinking;
 *   Claude Code's own default).
 */
export const ReasoningLevel = z.enum(["fast", "thorough"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;

/**
 * Fast. On the benchmark kit (2026-09-27, 3 runs per task, Claude Code + Jev)
 * Claude Code without thinking was as correct (15/15) and no slower on the
 * four small tasks, and 2.6x faster on the heavy mail task (median 16.0 s vs
 * 42.0 s; one thinking run spent 35 s before its first tool call). See
 * test/bench/results/*-d-all-* and *-e-all-nothink-*. Confirmed 2026-09-27 with
 * three hard tasks added (8 tasks x 3 runs, test/bench/METHOD.md "Reasoning"):
 * Thorough was no more correct on any task and slower where it thought most
 * (gmail 31.9 s vs 18.8 s, compare 45.9 s vs 39.2 s).
 */
export const DEFAULT_REASONING: ReasoningLevel = "fast";

/** The Reasoning setting's choices, as the options page and the model menu show them. */
export const REASONING_LEVELS: readonly { id: ReasoningLevel; label: string; detail: string }[] = [
  { id: "fast", label: "Fast", detail: "Acts at once, with as little thinking as the model allows." },
  { id: "thorough", label: "Thorough", detail: "Thinks before steps when it helps. Slower; uses more tokens." },
];
