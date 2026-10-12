/**
 * One task session: its agent (brain), run log, tools and current turn. The
 * TaskRunner keeps the set of sessions and their lifecycle (opened, idle,
 * closed); this class handles what happens inside one session: turns, their
 * limits, the task_* result, user messages and stopping.
 */
import { type Sleep, type AgentEvent, type MemoryToolName, type RunConfig, type TaskRunResult, type TodoToolName, type TodoToolResult, type ToolName } from "@noa/shared";
import { createToolExecutor, Interjections, ReasoningGovernor, reasoningTrace, turnEndEvents, type BrowserCaller, type JevLike, type ReasoningChange, type SecretRedactor } from "@noa/core";
import type { RunLog } from "../logger.js";
import { UserInput, type ReasoningChannel } from "../brains/brain.js";
import type { ToolSession } from "../tool-router.js";
import { sessionBrowser } from "./session-setup.js";
import { checkToolCall, clearTurnTimers, createTurn, turnResult, type Turn } from "./turn.js";

export interface TaskSessionOptions {
  sessionId: string;
  /** The task id its agent's tool calls carry: the session id, or that of the agent started ahead that it took. */
  toolTaskId?: string;
  runDir: string;
  log: RunLog;
  /** The brain stays alive after a task_* call, for follow-up turns. */
  persistent: boolean;
  allowed: ReadonlySet<ToolName>;
  browser: BrowserCaller;
  jev: JevLike | null;
  jevThreshold: number;
  mediaPaths: string[];
  /** The task's account (an X handle): nothing is published on X as another account (ToolExecutorOptions.account). */
  account?: string | null;
  /** Passwords the agent is given (shared with the run log, which redacts them too). */
  secrets: SecretRedactor;
  /** helper.event notifications. */
  notify: (sessionId: string, event: AgentEvent) => void;
  /** The TODO tools: the extension answers them from the user's TODO list for this session's conversation. */
  todo?: (sessionId: string, tool: TodoToolName, args: unknown) => Promise<TodoToolResult>;
  /** remember / recall / forget: the extension's memory for this session's conversation. */
  memory?: (sessionId: string, tool: MemoryToolName, args: unknown) => Promise<{ text: string; isError?: boolean }>;
  /** Single-turn brains: time the agent gets to exit after its task_* call. */
  finishGraceMs: number;
  /** Time a brain gets to return after an abort (or a close) before we stop waiting (or kill it). */
  abortWaitMs: number;
  sleep?: Sleep;
}

export class TaskSession {
  readonly sessionId: string;
  readonly log: RunLog;
  readonly persistent: boolean;
  readonly controller = new AbortController();
  readonly input = new UserInput();
  /** Messages the user types while a turn runs (see BrainContext.interjections). */
  readonly interjections: Interjections;
  /** How much the model thinks: each turn's Reasoning setting, raised while a Fast run is stuck. The brain follows it. */
  readonly reasoning: ReasoningChannel;
  private readonly governor: ReasoningGovernor;
  private reasoningListener: ((change: ReasoningChange) => void) | null = null;
  /** The model the session runs: the first turn's setting (null: the brain's default); undefined before it. */
  private model: string | null | undefined;
  private modelListener: ((model: string) => void) | null = null;
  /** What the ToolRouter sees of this session. */
  readonly tools: ToolSession;
  turn: Turn | null = null;
  /** Settles once the brain has exited. */
  brainDone: Promise<void> = Promise.resolve();
  brainError: string | null = null;
  /** The brain has exited: the session is closed. */
  ended = false;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastTurnAt = Date.now();
  /** The run folder. */
  readonly runDir: string;
  /** The attachments placed in the run folder so far: id to path (AttachmentInbox.place). */
  readonly attachments = new Map<string, string>();

  constructor(private readonly opts: TaskSessionOptions) {
    this.sessionId = opts.sessionId;
    this.runDir = opts.runDir;
    this.log = opts.log;
    this.persistent = opts.persistent;
    // Each turn sets its own level (startTurn); until then, the defaults.
    this.governor = new ReasoningGovernor({}, (change) => {
      this.log.event({ type: "reasoning", ...change });
      this.emit({ type: "trace", trace: { ...reasoningTrace(change), src: "helper" } });
      this.reasoningListener?.(change);
    });
    const governor = this.governor;
    this.reasoning = {
      get thinking() {
        return governor.thinking;
      },
      onChange: (fn) => {
        this.reasoningListener = fn;
      },
    };
    this.interjections = new Interjections((route, waitedMs, count) =>
      this.emit({ type: "trace", trace: { t: Date.now() - Math.round(waitedMs), ms: waitedMs, cat: "user", name: "interjection", src: "helper", data: { route, count } } }),
    );
    const executor = createToolExecutor({
      interjections: this.interjections,
      browser: sessionBrowser(opts.browser, opts.sessionId, opts.runDir),
      jev: opts.jev,
      jevThreshold: opts.jevThreshold,
      onEvent: (e) => this.emit(e),
      onTrace: (trace) => this.emit({ type: "trace", trace: { ...trace, src: "helper" } }),
      onTaskEnd: (r) => this.recordFinish(r),
      turnEndsAt: () => this.turn?.endsAt,
      mediaPaths: opts.mediaPaths,
      account: opts.account ?? null,
      secrets: opts.secrets,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.todo ? { todo: (tool: TodoToolName, args: unknown) => opts.todo!(opts.sessionId, tool, args) } : {}),
      ...(opts.memory ? { memory: (tool: MemoryToolName, args: unknown) => opts.memory!(opts.sessionId, tool, args) } : {}),
    });
    this.tools = { taskId: opts.toolTaskId ?? opts.sessionId, allowedTools: opts.allowed, jev: opts.jev !== null, beforeCall: (name) => this.beforeCall(name), executor };
  }

  /** The first turn's model starts the brain; a later turn that names another one switches it. */
  private followModel(model: string | null): void {
    const first = this.model === undefined;
    if (first || (model !== null && model !== this.model)) {
      if (!first) {
        this.log.event({ type: "model_change", from: this.model, to: model });
        this.modelListener?.(model!);
      }
      this.model = model;
    }
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** To the run log and the extension (helper.event), without any password the agent was given. */
  emit(raw: AgentEvent): void {
    this.governor.observe(raw);
    const e = this.opts.secrets.redact(raw);
    if (e.type === "error" && this.turn) this.turn.lastError = e.text;
    // Live text deltas and timings only go to the extension; the run log keeps the final text.
    if (e.type !== "assistant_text_delta" && e.type !== "trace") this.log.event({ ...e });
    try {
      this.opts.notify(this.sessionId, e);
    } catch {
      /* the extension may be gone */
    }
  }

  /** The brain follows a later turn's model setting (BrainContext.onModelChange). */
  onModelChange(fn: (model: string) => void): void {
    this.modelListener = fn;
  }

  /** A new turn with fresh limits; its time limit aborts the session. */
  startTurn(config: RunConfig): Turn {
    const turn = createTurn(config);
    this.governor.startTurn(config);
    this.followModel(config.model?.trim() || null);
    const minutes = config.maxTaskMinutes;
    turn.endsAt = Date.now() + minutes * 60_000;
    turn.timeLimit = setTimeout(() => {
      turn.timedOut = true;
      this.log.event({ type: "time_limit", minutes });
      this.controller.abort(new Error("time limit"));
    }, minutes * 60_000);
    this.turn = turn;
    this.interjections.newTurn();
    this.lastTurnAt = Date.now();
    return turn;
  }

  /**
   * Until the brain exits, or (persistent) the turn settles; after an abort,
   * the brain gets abortWaitMs to exit. Then the turn is over.
   */
  async waitForTurn(turn: Turn): Promise<void> {
    // Removed when the turn ends: a kept-open session has many turns on one signal.
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<void>((resolve) => {
        onAbort = resolve;
        if (this.aborted) resolve();
        else this.controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      await Promise.race([this.brainDone, turn.settled, aborted]);
      if (!this.aborted) return;
      const waitMs = this.opts.abortWaitMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gaveUp = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), waitMs)));
      const r = await Promise.race([this.brainDone.then(() => "done" as const), gaveUp]);
      clearTimeout(timer);
      if (r === "timeout") this.log.event({ type: "brain_stuck", waitMs });
    } finally {
      if (onAbort) this.controller.signal.removeEventListener("abort", onAbort);
      clearTurnTimers(turn);
      if (this.turn === turn) {
        this.turn = null;
        // Said too late for this turn (it was stopped): not carried into the next one.
        this.interjections.clear();
      }
    }
  }

  /** The finished turn's result, announced with a task_end event. */
  report(turn: Turn): TaskRunResult {
    const result = turnResult(turn, this.brainError);
    // Who picked this turn's elements (Jev, or Claude after Jev was unsure), then task_end.
    for (const e of turnEndEvents(result, this.opts.jev ? this.tools.executor.takePicks() : null)) this.emit(e);
    result.logPath = this.log.path;
    return result;
  }

  /**
   * A message typed into the running turn: it reaches the model at its next
   * read and the turn cannot end before (see BrainContext.interjections).
   * False when there is no turn, it already has its result, or it is stopping.
   */
  sendUserMessage(text: string): boolean {
    if (!this.turn || this.turn.finish || this.aborted || this.input.closed || !text.trim()) return false;
    this.emit({ type: "user_message", text });
    this.interjections.add(text);
    return true;
  }

  forcePause(reason: string): void {
    this.log.event({ type: "force_pause", reason });
    if (this.turn && this.turn.forcedPause === null) this.turn.forcedPause = reason;
    this.controller.abort(new Error(`paused: ${reason}`));
  }

  abort(reason: string): void {
    this.log.event({ type: "abort", reason });
    if (this.turn && this.turn.abortReason === null) this.turn.abortReason = reason;
    this.controller.abort(new Error(reason));
  }

  /** Gracefully: a running turn is aborted; an idle agent is asked to exit (input closed), then killed after abortWaitMs. */
  end(why: string): void {
    this.log.event({ type: "session_end", why });
    if (this.turn) {
      if (this.turn.abortReason === null) this.turn.abortReason = `Session ${why}`;
      this.controller.abort(new Error(why));
    } else {
      this.input.close();
      // A brain that ignores the close is killed after abortWaitMs.
      const timer = setTimeout(() => this.controller.abort(new Error(why)), this.opts.abortWaitMs);
      void this.brainDone.finally(() => clearTimeout(timer));
    }
  }

  /** The brain exited. False when that was already handled. */
  markEnded(): boolean {
    if (this.ended) return false;
    this.ended = true;
    this.clearIdleTimer();
    this.input.close();
    return true;
  }

  clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  /** The running turn has its task_* result, or no turn runs (see BrainContext.turnOver). */
  turnOver(): boolean {
    return !this.turn || this.turn.finish !== null;
  }

  /** Persistent brains: the agent is waiting for input. Ends a turn that has no result yet. */
  onIdle(): void {
    const turn = this.turn;
    if (!turn || turn.finish || turn.idleEnd) return;
    turn.idleEnd = true;
    this.log.event({ type: "turn_idle" });
    turn.settle();
  }

  private beforeCall(name: ToolName): string | null {
    if (this.aborted) return "The task was stopped. Stop now.";
    const t = this.turn;
    if (!t) return "No task is running in this session right now. Stop and wait for the user's next message.";
    const { refusal, stop } = checkToolCall(t, name);
    if (stop) this.controller.abort(new Error("tool call limit"));
    // A Fast run's first task_fail: one careful look first, with its reasoning raised (never after the tool limit).
    if (!refusal && name === "task_fail" && t.toolCalls < t.config.maxToolCalls) return this.governor.beforeTaskFail();
    return refusal;
  }

  private recordFinish(r: TaskRunResult): void {
    const t = this.turn;
    if (!t || t.finish || t.forcedPause !== null) return;
    t.finish = r;
    this.log.event({ type: "task_result", ...r });
    if (this.persistent) {
      // The agent stays open, idle, for the next message.
      t.settle();
      return;
    }
    // Single-turn brains: Claude Code exits once its stdin is closed and the turn ends.
    this.input.close();
    const grace = this.opts.finishGraceMs;
    t.graceTimer = setTimeout(() => {
      this.log.event({ type: "grace_expired", ms: grace });
      this.controller.abort(new Error("finished"));
    }, grace);
  }
}
