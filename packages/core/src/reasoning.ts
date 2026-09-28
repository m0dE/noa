/**
 * Reasoning: how much the model thinks, per request (the Reasoning setting,
 * shared/reasoning.ts), and raising it for a while when a Fast run is stuck.
 *
 * Both brains feed the same AgentEvents they already get from the tool
 * executor to a ReasoningGovernor; it says when to think harder (a stuck
 * run) and when to go back to fast (a step worked). What "thinking harder"
 * means is the brain's: the Messages API brain changes the next request's
 * thinking settings (reasoningParams) and adds RAISE_NUDGE after the tool
 * results; Claude Code gets its thinking turned on by a control request and
 * the note as a new message (apps/helper/src/brains/claude-code.ts).
 *
 * Measured on 2026-09-27 (scratch probes, 2 runs each unless noted): on the
 * Messages API, switching Sonnet 5's thinking between disabled and adaptive
 * inside a tool-use loop takes effect in both directions (the docs say a
 * mid-turn toggle may be ignored; here it was not); Opus 5.5 raised from low
 * effort to its default thought, then went back (1 run); Haiku 4.5's manual
 * thinking turned on mid-turn was ignored (0 thinking tokens), so it only
 * gets the note.
 */
import { DEFAULT_REASONING, modelThinking, TASK_END_TOOLS, type AgentEvent, type ReasoningLevel, type RunConfig, type ToolName, type TraceDraft } from "@noa/shared";

/** When a Fast run counts as stuck. Each is a count of events in a row. */
export const STUCK_LIMITS = {
  /** One page-changing tool failing this many times in a row (OBSERVING_TOOLS in between do not break the run). */
  toolFailures: 3,
  /** The same action (tool and arguments) giving the same result this many times in a row: no progress. */
  sameResult: 3,
  /** Jev answering "blocked" (login page, captcha, error page, no such element) this many times in a row. */
  blockedPicks: 2,
} as const;

/** Raises a turn may have at most: it never goes back and forth for ever. */
export const MAX_RAISES_PER_TURN = 2;

/**
 * Tools that only look or wait (the page, tabs, memory, a condition): neutral to the detector. Their
 * failures are no sign of a stuck plan (a slow page, a long wait_for), and they do not end a run of
 * failures or count as the same action again.
 */
export const OBSERVING_TOOLS: ReadonlySet<string> = new Set<ToolName>(["read_page", "screenshot", "list_tabs", "wait_for", "recall", "search_history", "check_similar", "get_credential"]);

/** Tools repeated on purpose (scrolling loads more): never "the same action again". */
const REPEATED_ON_PURPOSE: ReadonlySet<string> = new Set<ToolName>(["scroll"]);

const isTaskEnd = (name: string) => (TASK_END_TOOLS as readonly string[]).includes(name);

/** What the model reads when its reasoning was raised (after the tool results, or as the next message). */
export const raiseNote = (why: string) => `Several steps have not worked (${why}). Please think hard before your next step, then go on with the task.`;

/** task_fail's answer the first time a Fast run gives up: one careful look first (reasoning is raised for it). */
export const TASK_FAIL_RECHECK =
  "task_fail was not recorded yet. Before giving up, think it through once more: what the page shows now, and what you have tried. If the task really cannot be done, call task_fail again.";

/**
 * Watches the executor's events for a run that is stuck. observe() returns
 * why, once, when a limit is reached (then starts counting again).
 */
export class StuckDetector {
  private failing: { tool: string; count: number } | null = null;
  /** Page-changing calls whose result has not come yet: id -> tool and arguments. */
  private readonly calls = new Map<string, string>();
  private same: { outcome: string; tool: string; count: number } | null = null;
  private blocked = 0;

  reset(): void {
    this.failing = null;
    this.calls.clear();
    this.same = null;
    this.blocked = 0;
  }

  observe(e: AgentEvent): string | null {
    switch (e.type) {
      case "tool_call":
        if (!isTaskEnd(e.name) && !OBSERVING_TOOLS.has(e.name) && !REPEATED_ON_PURPOSE.has(e.name)) this.calls.set(e.id, `${e.name} ${stableJson(e.args)}`);
        return null;
      case "tool_result":
        return isTaskEnd(e.name) ? null : this.result(e);
      case "jev":
        if (e.operation === "blocked") {
          if (++this.blocked >= STUCK_LIMITS.blockedPicks) return this.found(`Jev found no way to do "${e.goal}" ${this.blocked} times in a row`);
        } else if (e.executed) this.blocked = 0;
        return null;
      default:
        return null;
    }
  }

  private result(e: Extract<AgentEvent, { type: "tool_result" }>): string | null {
    if (OBSERVING_TOOLS.has(e.name)) return null;
    if (e.isError) {
      this.failing = this.failing?.tool === e.name ? { tool: e.name, count: this.failing.count + 1 } : { tool: e.name, count: 1 };
      if (this.failing.count >= STUCK_LIMITS.toolFailures) return this.found(`${e.name} failed ${this.failing.count} times in a row`);
    } else this.failing = null;

    const call = this.calls.get(e.id);
    if (call === undefined) return null;
    this.calls.delete(e.id);
    const outcome = `${call}\n${e.isError === true}\n${e.text ?? ""}`;
    this.same = this.same?.outcome === outcome ? { ...this.same, count: this.same.count + 1 } : { outcome, tool: e.name, count: 1 };
    if (this.same.count >= STUCK_LIMITS.sameResult) return this.found(`the same ${e.name} gave the same result ${this.same.count} times in a row`);
    return null;
  }

  private found(why: string): string {
    this.reset();
    return why;
  }
}

/** JSON with object keys sorted, so the same arguments compare equal whatever their order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A change of the run's thinking: raised (a stuck Fast run), lowered (a step worked), or a new turn's level. */
export interface ReasoningChange {
  kind: "raise" | "lower" | "turn";
  /** Think from now on. */
  thinking: boolean;
  why: string;
}

/** The Reasoning setting of a turn, from its RunConfig (absent: the defaults). */
export function reasoningOf(config: Pick<RunConfig, "reasoning" | "reasoningAutoRaise">): { level: ReasoningLevel; autoRaise: boolean } {
  return { level: config.reasoning ?? DEFAULT_REASONING, autoRaise: config.reasoningAutoRaise ?? true };
}

/**
 * The run's reasoning: its level (Fast or Thorough), and on Fast with
 * autoRaise, raised while it is stuck. Bounded: at most MAX_RAISES_PER_TURN
 * raises a turn, and a raise ends at the first page-changing step that works.
 */
export class ReasoningGovernor {
  private level: ReasoningLevel;
  private autoRaise: boolean;
  private isRaised = false;
  private raises = 0;
  private failRechecked = false;
  private readonly detector = new StuckDetector();

  constructor(
    config: Pick<RunConfig, "reasoning" | "reasoningAutoRaise">,
    private readonly onChange: (change: ReasoningChange) => void,
  ) {
    ({ level: this.level, autoRaise: this.autoRaise } = reasoningOf(config));
  }

  /** The model thinks now: Thorough, or a raised Fast run. */
  get thinking(): boolean {
    return this.level === "thorough" || this.isRaised;
  }

  get raised(): boolean {
    return this.isRaised;
  }

  /** A new turn: its own setting, no raise and fresh counts. Says so when that changes the thinking. */
  startTurn(config: Pick<RunConfig, "reasoning" | "reasoningAutoRaise">): void {
    const before = this.thinking;
    ({ level: this.level, autoRaise: this.autoRaise } = reasoningOf(config));
    this.isRaised = false;
    this.raises = 0;
    this.failRechecked = false;
    this.detector.reset();
    if (this.thinking !== before) this.notify({ kind: "turn", thinking: this.thinking, why: `new turn (${this.level})` });
  }

  /** Every event of the run (the executor's tool_call, tool_result and jev events are the ones that count). */
  observe(e: AgentEvent): void {
    if (this.isRaised) {
      if (e.type === "tool_result" && !e.isError && !isTaskEnd(e.name) && !OBSERVING_TOOLS.has(e.name)) {
        this.isRaised = false;
        this.notify({ kind: "lower", thinking: this.thinking, why: `${e.name} worked` });
      }
      return;
    }
    if (!this.canRaise) return;
    const why = this.detector.observe(e);
    if (why) this.raise(why);
  }

  /**
   * Before a task_fail runs: the first one of a Fast turn (with autoRaise, not
   * raised yet) is answered with TASK_FAIL_RECHECK and the reasoning raised,
   * so the model takes one careful look before giving up. Null: let it run.
   */
  beforeTaskFail(): string | null {
    if (this.isRaised || this.failRechecked || !this.canRaise) return null;
    this.failRechecked = true;
    this.raise("about to give up (task_fail)");
    return TASK_FAIL_RECHECK;
  }

  private get canRaise(): boolean {
    return this.level === "fast" && this.autoRaise && this.raises < MAX_RAISES_PER_TURN;
  }

  private raise(why: string): void {
    this.isRaised = true;
    this.raises++;
    this.detector.reset();
    this.notify({ kind: "raise", thinking: true, why });
  }

  private notify(change: ReasoningChange): void {
    try {
      this.onChange(change);
    } catch {
      /* a listener must not break the run */
    }
  }
}

/** The Raw view's line for a change ("Reasoning raised: act failed 3 times in a row"). */
export function reasoningTrace(change: ReasoningChange): TraceDraft {
  const name = change.kind === "raise" ? "reasoning.raise" : change.kind === "lower" ? "reasoning.lower" : "reasoning.turn";
  return { t: Date.now(), cat: "model", name, data: { why: change.why, thinking: change.thinking } };
}

// ---------------------------------------------------------------- Messages API parameters

/** Effort of a Fast request on models that always think (Opus 5.5, Fable 5.1). */
export const FAST_EFFORT = "low";
/** max_tokens of a request that may think: room for the thinking and the answer (non-streaming requests stay well under the SDKs' timeout). */
export const THINKING_MAX_TOKENS = 16_000;
/** Thinking budget where a model takes a fixed one (Haiku 4.5; min 1,024, under THINKING_MAX_TOKENS), and Claude Code's when raised. */
export const THINKING_BUDGET_TOKENS = 8_192;

export type ThinkingParam = { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budget_tokens: number };

/** The thinking fields of a Messages request; max_tokens only when it must be larger than the usual. */
export interface ReasoningParams {
  thinking?: ThinkingParam;
  output_config?: { effort: typeof FAST_EFFORT };
  max_tokens?: number;
}

/**
 * A request's thinking settings for this model (shared/models.ts says how
 * each model's thinking is controlled). `when`: "fast", "raised" (a Fast run
 * that is stuck, mid-turn) or "thorough". Unknown models get nothing: they
 * run as their own default.
 */
export function reasoningParams(model: string, when: "fast" | "raised" | "thorough"): ReasoningParams {
  const think: ReasoningParams = { thinking: { type: "adaptive" }, max_tokens: THINKING_MAX_TOKENS };
  switch (modelThinking(model)) {
    case "switchable":
      return when === "fast" ? { thinking: { type: "disabled" } } : think;
    case "always":
      return when === "fast" ? { thinking: { type: "adaptive" }, output_config: { effort: FAST_EFFORT } } : think;
    case "budget":
      // Turned on mid-turn it is ignored (measured): only a Thorough turn thinks from its start.
      return when === "thorough" ? { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS }, max_tokens: THINKING_MAX_TOKENS } : {};
    default:
      return {};
  }
}
