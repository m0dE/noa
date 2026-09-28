/**
 * Keeps the helper's task sessions and their lifecycle: starts a session
 * (run folder, MCP config, prompts, brain), runs its turns, keeps it open
 * between turns, and closes it (ended, idle, replaced, or to make room).
 * What happens inside one session lives in session/task-session.ts.
 *
 * A session starts with run() (the first turn). With a persistent brain
 * (Claude Code headless with stdin kept open) the agent stays alive after
 * its task_* call, idle, and continueSession() types the user's next message
 * into it as a new turn. Several sessions can run turns at the same time (the
 * extension gives each its own tab: every browser call carries the session
 * id); a few idle sessions may stay open beside them.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  HelperErrorCode,
  mcpToolName,
  RpcError,
  TOOL_NAMES,
  toolsFor,
  type AgentAttachment,
  type AgentEvent,
  type AgentTask,
  type MemoryToolName,
  type RunConfig,
  type TodoToolName,
  type TodoToolResult,
  type Sleep,
  type TaskRunResult,
  type ToolName,
  traceStart,
} from "@noa/shared";
import { buildSystemPrompt, buildTaskPrompt, FOLLOW_UP_PREFIX, reasoningOf, SecretRedactor, withAttachmentLines, type BrowserCaller, type JevLike } from "@noa/core";
import { RunLog, type LiveLog } from "./logger.js";
import type { Brain } from "./brains/brain.js";
import type { WarmClaude } from "./brains/claude-code.js";
import { INTERACTIVE_TASK_ID } from "./mcp-tools.js";
import type { ToolSession } from "./tool-router.js";
import { ATTACHMENTS_DIR, type AttachmentInbox } from "./session/attachments.js";
import { buildMcpConfig, runDirFor } from "./session/session-setup.js";
import { TaskSession } from "./session/task-session.js";
import type { Turn } from "./session/turn.js";

export interface RunTaskParams {
  sessionId: string;
  task: AgentTask;
  mediaPaths: string[];
  config: RunConfig;
  /** Files the user attached to the conversation, waiting in the inbox (or placed by an earlier turn). */
  attachments?: AgentAttachment[];
}

export interface ContinueSessionParams {
  sessionId: string;
  text: string;
  config: RunConfig;
  /** This message's attachments (fresh), and earlier ones to list again. */
  attachments?: AgentAttachment[];
}

/** Session timings and limits when TaskRunnerDeps leaves them out. */
export const RUNNER_DEFAULTS = {
  /** Single-turn brains: time the agent gets to exit after its first task_* call. */
  finishGraceMs: 20_000,
  /** Time a brain gets to return after an abort before we stop waiting. */
  abortWaitMs: 15_000,
  /** An idle kept-open session is closed after this long without a turn. */
  idleSessionMs: 30 * 60_000,
  /** At most this many kept-open task sessions; starting another closes the oldest idle one. */
  maxSessions: 3,
  /** An agent started ahead (prewarm) that no session took is stopped after this long. */
  warmMs: 10 * 60_000,
} as const;

/** An agent process started ahead of the next new session (TaskRunner.prewarm), with the run folder it was started in. */
interface Spare {
  /** The task id its tool calls carry (its MCP config's): the session that takes it answers to it. */
  toolTaskId: string;
  runDir: string;
  /** The settings it was started with. */
  model: string | null;
  jev: boolean;
  thinking: boolean;
  warm: WarmClaude;
  timer: ReturnType<typeof setTimeout>;
}

export interface TaskRunnerDeps {
  runsDir: string;
  /** Where attachments wait for their session's next turn (helper.putAttachment). */
  inbox: AttachmentInbox;
  mcpServerPath: string;
  pipePath: string;
  /** What the MCP servers' pipe calls carry (PipeMethods). */
  pipeToken: string;
  browser: BrowserCaller;
  /** Jev key from the helper environment (TYPESAFE_API_KEY), used when the run config has none. */
  envJevKey: string | null;
  makeJev: (apiKey: string) => JevLike;
  makeBrain: () => Brain;
  /** helper.event notifications. */
  notify: (sessionId: string, event: AgentEvent) => void;
  /** The TODO tools for a session (the extension's todo.call). Absent: the tools are refused. */
  todo?: (sessionId: string, tool: TodoToolName, args: unknown) => Promise<TodoToolResult>;
  /** remember / recall / forget for a session (the extension's memory.call). Absent: the tools are refused. */
  memory?: (sessionId: string, tool: MemoryToolName, args: unknown) => Promise<{ text: string; isError?: boolean }>;
  /** The set of open sessions changed (one opened or closed): helper.sessions notifications. */
  onSessionsChanged?: (open: string[]) => void;
  live?: LiveLog | null;
  /** See RUNNER_DEFAULTS. */
  finishGraceMs?: number;
  abortWaitMs?: number;
  idleSessionMs?: number;
  maxSessions?: number;
  warmMs?: number;
  nodePath?: string;
  sleep?: Sleep;
}

export class TaskRunner {
  private readonly sessions = new Map<string, TaskSession>();
  /** Sessions no longer open (replaced, or closed to make room) whose agent has not exited yet. */
  private readonly closing = new Set<TaskSession>();
  /** Sessions whose turn is running. */
  private readonly active = new Set<TaskSession>();
  /** Waiting for every session to close (see whenAllClosed). */
  private readonly allClosedWaiters: (() => void)[] = [];
  /** The agent started ahead for the next new session (prewarm). */
  private spare: Spare | null = null;
  /** Sessions that took a spare: the task id their tool calls carry, to the session id. */
  private readonly toolTaskIds = new Map<string, string>();

  constructor(private readonly deps: TaskRunnerDeps) {}

  /** Some turn is running. */
  get busy(): boolean {
    return this.active.size > 0;
  }

  /** Resolves once no session is open or closing and no turn is running (e.g. after shutdown). */
  whenAllClosed(): Promise<void> {
    if (this.allClosed) return Promise.resolve();
    return new Promise((resolve) => this.allClosedWaiters.push(resolve));
  }

  private get allClosed(): boolean {
    return this.sessions.size === 0 && this.closing.size === 0 && this.active.size === 0;
  }

  private checkAllClosed(): void {
    if (this.allClosed) for (const resolve of this.allClosedWaiters.splice(0)) resolve();
  }

  /** Sessions whose agent is still alive (running a turn, or idle and kept open). */
  get openSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * The ToolSession for the ToolRouter: a running turn's when no id is given;
   * with an id, that session's (an idle one refuses tools until its next turn).
   */
  session(taskId?: string): ToolSession | null {
    if (taskId === undefined) return [...this.active][0]?.tools ?? null;
    return this.sessions.get(this.toolTaskIds.get(taskId) ?? taskId)?.tools ?? null;
  }

  forcePause(sessionId: string, reason: string): boolean {
    const s = this.sessions.get(sessionId);
    s?.forcePause(reason);
    return s !== undefined;
  }

  abort(sessionId: string, reason: string): boolean {
    const s = this.sessions.get(sessionId);
    s?.abort(reason);
    return s !== undefined;
  }

  /** Types a message into the running turn. False when there is no such turn or it already has its result. */
  sendUserMessage(sessionId: string, text: string): boolean {
    return this.sessions.get(sessionId)?.sendUserMessage(text) ?? false;
  }

  /** Ends a kept-open session (gracefully: the agent is asked to exit, then killed). False when unknown. */
  endSession(sessionId: string, why = "ended"): boolean {
    const s = this.sessions.get(sessionId);
    s?.end(why);
    return s !== undefined;
  }

  /** Abort everything, closing sessions included (used when Chrome closes the port). */
  shutdown(reason: string): void {
    this.dropSpare();
    for (const s of [...this.sessions.values(), ...this.closing]) s.abort(reason);
  }

  /**
   * Starts the agent of the next new session ahead (the side panel opened), with this run config's
   * model, Reasoning and Jev: run() then takes it instead of starting one. It waits for its first
   * message without using tokens, RUNNER_DEFAULTS.warmMs at most. One is kept: a call with the same
   * settings keeps it, one with others replaces it. False when the brain starts nothing ahead.
   */
  prewarm(config: RunConfig): boolean {
    const brain = this.deps.makeBrain();
    if (!brain.warm) return false;
    const model = config.model?.trim() || null;
    const jev = this.jevKey(config) !== null;
    const thinking = reasoningOf(config).level === "thorough";
    const current = this.spare;
    if (current?.warm.ready && current.model === model && current.jev === jev && current.thinking === thinking) {
      current.timer.refresh();
      return true;
    }
    this.dropSpare();
    const toolTaskId = `warm-${randomUUID()}`;
    const runDir = runDirFor(this.deps.runsDir, toolTaskId);
    mkdirSync(runDir, { recursive: true });
    const files = this.sessionFiles(runDir, toolTaskId, jev, brain.persistent === true);
    const warm = brain.warm({ ...files, ...(model ? { model } : {}), thinking });
    const timer = setTimeout(() => this.dropSpare(), this.deps.warmMs ?? RUNNER_DEFAULTS.warmMs);
    (timer as { unref?: () => void }).unref?.();
    this.spare = { toolTaskId, runDir, model, jev, thinking, warm, timer };
    return true;
  }

  /** The spare, for a new session with this Jev setting (its MCP config and prompt depend on it); else it is stopped. */
  private takeSpare(jev: boolean): Spare | null {
    const spare = this.spare;
    if (!spare) return null;
    this.spare = null;
    clearTimeout(spare.timer);
    // The brain takes the process only when started with the session's model and thinking too.
    if (spare.warm.ready && spare.jev === jev) return spare;
    spare.warm.stop();
    return null;
  }

  private dropSpare(): void {
    if (!this.spare) return;
    clearTimeout(this.spare.timer);
    this.spare.warm.stop();
    this.spare = null;
  }

  /** The Jev key a run with this config uses, or null (Jev off). */
  private jevKey(config: RunConfig): string | null {
    const key = config.jevApiKey?.trim() || this.deps.envJevKey;
    return config.jevEnabled && key ? key : null;
  }

  /**
   * Writes the session's MCP config into its run folder and makes its attachments folder (Claude Code runs there,
   * with Read on the files the user attached); returns them with the session's tools and system prompt.
   */
  private sessionFiles(
    runDir: string,
    toolTaskId: string,
    jev: boolean,
    followUps: boolean,
  ): { mcpConfigPath: string; readDir: string; allowedTools: string[]; systemPrompt: string } {
    // act replaces click and type (steps can still name an exact element index).
    const allowed = new Set<ToolName>(toolsFor());
    const toolNames = TOOL_NAMES.filter((n) => allowed.has(n));
    const mcpConfigPath = join(runDir, "mcp-config.json");
    const mcpConfig = buildMcpConfig({
      nodePath: this.deps.nodePath ?? process.execPath,
      mcpServerPath: this.deps.mcpServerPath,
      pipePath: this.deps.pipePath,
      pipeToken: this.deps.pipeToken,
      taskId: toolTaskId,
      toolNames,
      jev,
    });
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    const readDir = join(runDir, ATTACHMENTS_DIR);
    mkdirSync(readDir, { recursive: true });
    return { mcpConfigPath, readDir, allowedTools: toolNames.map(mcpToolName), systemPrompt: buildSystemPrompt({ tools: toolNames, jev, followUps, readAttachments: true }) };
  }

  async run(params: RunTaskParams): Promise<TaskRunResult> {
    const { sessionId, task, mediaPaths, config } = params;
    const setup = traceStart();
    if (sessionId === INTERACTIVE_TASK_ID) throw new Error(`sessionId "${INTERACTIVE_TASK_ID}" is reserved`);
    // A session runs one turn at a time; other sessions may run beside it.
    const previous = this.sessions.get(sessionId);
    if (previous?.turn) throw new RpcError("busy", HelperErrorCode.busy);
    if (previous) this.retire(previous, "replaced by a new run");
    this.makeRoom();

    const jevKey = this.jevKey(config);
    const jev = jevKey ? this.deps.makeJev(jevKey) : null;
    // An agent started ahead (prewarm) comes with its run folder; its tool calls carry its own task id.
    const spare = this.takeSpare(jev !== null);
    const runDir = spare?.runDir ?? runDirFor(this.deps.runsDir, sessionId);
    const toolTaskId = spare?.toolTaskId ?? sessionId;
    if (spare) this.toolTaskIds.set(toolTaskId, sessionId);
    mkdirSync(runDir, { recursive: true });
    const secrets = new SecretRedactor();
    const log = new RunLog(join(runDir, "log.jsonl"), this.deps.live ?? null, sessionId, secrets);
    // act replaces click and type (steps can still name an exact element index).
    const allowed = new Set<ToolName>(toolsFor());
    const brain = this.deps.makeBrain();

    const s = new TaskSession({
      sessionId,
      toolTaskId,
      runDir,
      log,
      persistent: brain.persistent === true,
      allowed,
      browser: this.deps.browser,
      jev,
      jevThreshold: config.jevThreshold,
      mediaPaths,
      account: task.account,
      secrets,
      notify: this.deps.notify,
      ...(this.deps.todo ? { todo: this.deps.todo } : {}),
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
      finishGraceMs: this.deps.finishGraceMs ?? RUNNER_DEFAULTS.finishGraceMs,
      abortWaitMs: this.deps.abortWaitMs ?? RUNNER_DEFAULTS.abortWaitMs,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.sessions.set(sessionId, s);
    this.sessionsChanged();
    this.active.add(s);
    const turn = s.startTurn(config);
    const attachments = this.place(s, params.attachments);
    // The scripted brain uploads every file the task has.
    const uploadable = [...mediaPaths, ...attachments.flatMap((a) => (a.path ? [a.path] : []))];

    log.event({
      type: "task_start",
      taskId: task.id,
      account: task.account,
      media: mediaPaths,
      ...(attachments.length ? { attachments: attachments.map((a) => ({ id: a.ref.id, kind: a.ref.kind, size: a.ref.size, placed: a.path !== undefined })) } : {}),
      jev: jev !== null,
      persistent: s.persistent,
      isRetry: config.isRetry,
      maxToolCalls: config.maxToolCalls,
      maxTaskMinutes: config.maxTaskMinutes,
    });

    try {
      const { mcpConfigPath, readDir, allowedTools, systemPrompt } = this.sessionFiles(runDir, toolTaskId, jev !== null, s.persistent);
      // The run folder, the MCP config and the prompts, before the agent starts.
      s.emit({ type: "trace", trace: { t: setup.t, ms: setup.elapsed(), cat: "brain", name: "helper.setup", src: "helper", data: { jev: jev !== null, media: mediaPaths.length, prewarmed: spare !== null } } });
      s.brainDone = brain
        .run({
          taskId: toolTaskId,
          prompt: buildTaskPrompt(task, mediaPaths, { isRetry: config.isRetry, attachments, view: "read" }),
          systemPrompt,
          readDir,
          ...(config.model?.trim() ? { model: config.model.trim() } : {}),
          mcpConfigPath,
          allowedTools,
          ...(spare ? { warm: spare.warm } : {}),
          signal: s.controller.signal,
          log: (e) => log.event(e),
          emit: (e) => s.emit(e),
          input: s.input,
          interjections: s.interjections,
          reasoning: s.reasoning,
          onModelChange: (fn) => s.onModelChange(fn),
          idle: () => s.onIdle(),
          turnOver: () => s.turnOver(),
          task: { instructions: task.instructions, account: task.account, mediaPaths: uploadable },
        })
        .catch((e: unknown) => {
          s.brainError = errorMessage(e);
          log.event({ type: "brain_error", message: s.brainError });
        })
        .finally(() => this.onBrainExit(s));
    } catch (e) {
      spare?.warm.stop();
      s.brainError = errorMessage(e);
      s.brainDone = Promise.resolve();
      this.onBrainExit(s);
    }
    return this.finishTurn(s, turn);
  }

  /**
   * The next user message in a kept-open session: a new turn with fresh
   * limits. Throws an RpcError with a HelperErrorCode: sessionEnded when its
   * agent is gone (the caller then starts a fresh run), busy while this
   * session's turn runs.
   */
  async continueSession(params: ContinueSessionParams): Promise<TaskRunResult> {
    const s = this.sessions.get(params.sessionId);
    if (!s || s.ended || s.input.closed || s.aborted || !s.persistent) throw new RpcError("session ended", HelperErrorCode.sessionEnded);
    if (s.turn) throw new RpcError("busy", HelperErrorCode.busy);
    if (!params.text.trim()) throw new RpcError("empty message", HelperErrorCode.emptyMessage);
    s.clearIdleTimer();
    this.active.add(s);
    const turn = s.startTurn(params.config);
    s.log.event({ type: "turn_start", chars: params.text.length, maxToolCalls: params.config.maxToolCalls, maxTaskMinutes: params.config.maxTaskMinutes });
    s.emit({ type: "user_message", text: params.text });
    const attachments = this.place(s, params.attachments);
    s.input.push(withAttachmentLines(`${FOLLOW_UP_PREFIX}${params.text}`, attachments, "read"));
    return this.finishTurn(s, turn);
  }

  /** Moves the turn's attachments into the session's attachments folder; upload may attach them from now on. */
  private place(s: TaskSession, attachments: readonly AgentAttachment[] = []): AgentAttachment[] {
    if (!attachments.length) return [];
    const placed = this.deps.inbox.place(s.sessionId, s.runDir, attachments, s.attachments);
    s.tools.executor.allowMedia(placed.flatMap((a) => (a.path ? [a.path] : [])));
    const missing = placed.filter((a) => !a.path).map((a) => a.ref.id);
    if (missing.length) s.log.event({ type: "attachments_missing", ids: missing });
    return placed;
  }

  /** Waits for the turn to end, then reports it. The session stays open when its agent is still alive. */
  private async finishTurn(s: TaskSession, turn: Turn): Promise<TaskRunResult> {
    try {
      await s.waitForTurn(turn);
    } finally {
      this.active.delete(s);
      this.checkAllClosed();
    }
    const result = s.report(turn);
    if (!s.ended) this.armIdle(s);
    return result;
  }

  private onBrainExit(s: TaskSession): void {
    if (!s.markEnded()) return;
    this.deps.inbox.drop(s.sessionId);
    this.closing.delete(s);
    if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
    if (s.tools.taskId !== s.sessionId) this.toolTaskIds.delete(s.tools.taskId);
    this.sessionsChanged();
    s.log.event({ type: "session_closed" });
    this.checkAllClosed();
  }

  private armIdle(s: TaskSession): void {
    s.clearIdleTimer();
    const ms = this.deps.idleSessionMs ?? RUNNER_DEFAULTS.idleSessionMs;
    s.idleTimer = setTimeout(() => this.endSession(s.sessionId, "idle"), ms);
    // Never keep the helper alive just for this.
    (s.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Keeps at most maxSessions open: closes the oldest idle ones to make room for a new one. */
  private makeRoom(): void {
    const max = this.deps.maxSessions ?? RUNNER_DEFAULTS.maxSessions;
    const idle = [...this.sessions.values()].filter((x) => !x.turn && !x.ended).sort((a, b) => a.lastTurnAt - b.lastTurnAt);
    while (this.sessions.size >= max && idle.length) this.retire(idle.shift()!, "closed to make room for a new session");
  }

  /** Takes an idle session out of the open ones and ends it; it counts as closing until its agent exits. */
  private retire(s: TaskSession, why: string): void {
    if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
    if (!s.ended) this.closing.add(s);
    s.end(why);
  }

  private sessionsChanged(): void {
    try {
      this.deps.onSessionsChanged?.(this.openSessions);
    } catch {
      /* the extension may be gone */
    }
  }
}
