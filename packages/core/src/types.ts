/**
 * Public contract of @noa/core: the agent logic shared by the helper
 * (Claude Code brain, via MCP) and the extension (Claude API brain, in the
 * service worker). Runs in Node and in the browser: no Node-only imports.
 */
import type {
  AgentEvent,
  ElementPicks,
  AgentTask,
  MemoryToolName,
  BrowserMethod,
  BrowserMethods,
  PageSnapshot,
  RunConfig,
  Sleep,
  TaskRunResult,
  TodoToolName,
  TodoToolResult,
  ToolName,
  ToolResult,
  TraceDraft,
} from "@noa/shared";
import type { CreditShortfall } from "./api-errors.js";
import type { ApiAttachment } from "./attachments.js";
import type { Interjections } from "./interjections.js";
import type { SecretRedactor } from "./redact.js";

/** Something that performs browser.* and vault.* methods (extension driver, or RPC to it). */
export interface BrowserCaller {
  call<M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]>;
}

export type JevOperation = "click" | "type" | "scroll" | "press_key" | "wait" | "done" | "blocked";

export interface JevDecision {
  operation: JevOperation;
  /** Target element index, or null for none. */
  index: number | null;
  /** min(operation confidence, target confidence), 0..1 */
  confidence: number;
  /** Element indices from most to least likely target (when Jev reports probabilities). */
  ranked?: number[];
}

export interface JevLike {
  decide(input: {
    goal: string;
    snapshot: PageSnapshot;
    /** The step types text (the text itself stays with Claude). */
    typesText?: boolean;
    /** What the previous step of the same act call did. */
    previousStep?: string;
  }): Promise<JevDecision>;
}

export interface ToolExecutorOptions {
  browser: BrowserCaller;
  /** null = Jev off: act steps then need an element index. */
  jev: JevLike | null;
  jevThreshold: number;
  onEvent: (e: AgentEvent) => void;
  /**
   * Receives task_complete / task_fail / task_pause. When undefined
   * (mcp-server --attach), task_* tools answer that there is no task to end.
   */
  onTaskEnd?: (r: TaskRunResult) => void;
  /** Absolute local paths the task may upload. upload rejects other paths. */
  mediaPaths: string[];
  /**
   * The task's account (e.g. an X handle "@name"), when it has one: nothing is published on X while X's account
   * switcher shows another account (a Post click is refused, however the agent came to make it).
   */
  account?: string | null;
  /**
   * Where passwords get_credential hands out are remembered, so events never
   * show them. Pass one to redact the same secrets elsewhere (the helper's run
   * log). Default: the executor's own.
   */
  secrets?: SecretRedactor;
  /** For tests. Default: real setTimeout. */
  sleep?: Sleep;
  /** For tests (wait_for's clock). Default: Date.now. */
  now?: () => number;
  /**
   * When the running turn's time limit ends it (epoch ms), or undefined: wait_for stops waiting shortly before
   * (WAIT_TURN_MARGIN_MS), so the agent can still say what it was waiting for. Absent: no limit is known.
   */
  turnEndsAt?: () => number | undefined;
  /**
   * The conversation's timing trace: one "tool" span per call (duration,
   * result size) and one "act.step" span per act step. Redacted like events.
   */
  onTrace?: (e: TraceDraft) => void;
  /**
   * Messages the user sends while the turn runs (the brain delivers them as
   * user messages): until the model has read them, act stops before its next
   * step, navigate, open_tabs and wait_for stop waiting, and task_* is refused.
   */
  interjections?: Interjections;
  /**
   * The TODO tools (schedule_task, list_scheduled_tasks, update_scheduled_task, cancel_scheduled_task): the
   * user's TODO list for this conversation (the extension answers them). Answers the model's text; isError when
   * nothing was done (e.g. the plan has no TODO list, or the user did not approve). Undefined (mcp-server
   * --attach): refused, there is no conversation.
   */
  todo?: TodoCall;
  /**
   * remember / recall / forget: the conversation's memory (the extension keeps it). Answers the model's text;
   * isError when it refused (e.g. memory is off, or the entry looks like a secret). Undefined: refused.
   */
  memory?: MemoryCall;
}

/** One memory tool call, answered by the extension's memory for the conversation. */
export type MemoryCall = (tool: MemoryToolName, args: unknown) => Promise<{ text: string; isError?: boolean }>;

/** One TODO tool call, answered by the extension's TODO list for the conversation. */
export type TodoCall = (tool: TodoToolName, args: unknown) => Promise<TodoToolResult>;

export interface ToolExecutor {
  /** Validates args with ToolArgs, runs the tool, emits tool_call/tool_result/jev events. Never throws. */
  call(name: ToolName, args: unknown): Promise<ToolResult>;
  /** Element picks (act clicks and typing) by Jev and by Claude since the last take; resets the counts. */
  takePicks(): ElementPicks;
  /** Lets upload attach these files too (a later turn's attachments). */
  allowMedia(paths: readonly string[]): void;
}

/** A running agent. */
export interface AgentSession {
  readonly sessionId: string;
  /** Adds a human message to the conversation before the next model turn. */
  sendUserMessage(text: string): void;
  /** Stops the agent; done resolves with this outcome and reason. */
  abort(reason: string, outcome?: "paused" | "failed" | "retry"): void;
  readonly done: Promise<TaskRunResult>;
  /**
   * The user's next message after this turn ended (done resolved), as a new
   * turn of the same conversation: Claude sees the whole history. Returns the
   * new turn (same sessionId). config: that turn's limits (default: the
   * first turn's). Throws "busy" while a turn runs.
   */
  continueWith?(text: string, opts?: { config?: RunConfig; attachments?: ApiAttachment[] }): AgentSession;
}

export interface ApiAgentOptions {
  sessionId: string;
  apiKey: string;
  /** e.g. "claude-sonnet-5" */
  model: string;
  task: AgentTask;
  mediaPaths: string[];
  /** Files the user attached (see core attachments.ts): fresh images and PDFs go as blocks before the task. */
  attachments?: ApiAttachment[];
  config: RunConfig;
  browser: BrowserCaller;
  /** null = Jev off: act steps then need an element index. */
  jev: JevLike | null;
  onEvent: (e: AgentEvent) => void;
  /** Default globalThis.fetch. */
  fetch?: typeof fetch;
  /**
   * Messages API base: requests go to `${baseUrl}/messages`. Default
   * "https://api.anthropic.com/v1". The Noa hosted AI is
   * `${apiBase}/v1/ai` (with auth "bearer" and the session token as apiKey).
   */
  baseUrl?: string;
  /** How apiKey is sent: "x-api-key" (Anthropic, default) or "bearer" (Authorization: Bearer). */
  auth?: "x-api-key" | "bearer";
  /** Extra headers on every Messages request (e.g. X-Noa-Session). */
  headers?: Record<string, string>;
  /** Name in status lines and error reasons. Default "Claude API". */
  label?: string;
  /**
   * Stream responses (server-sent events) and emit assistant_text_delta
   * events as text is written. Default: on for x-api-key (Anthropic), off
   * for bearer (the hosted AI's /v1/ai/messages answers whole messages).
   */
  stream?: boolean;
  /**
   * HTTP 402: called, then the turn ends paused, with reason OUT_OF_CREDIT
   * ("Out of usage credit") when the account has none left, or LOW_CREDIT
   * ("Not enough usage credit") when some is left but too little for the
   * request (`shortfall` says how much).
   */
  onOutOfCredit?(info: { message: string; topupUrl?: string; shortfall?: CreditShortfall }): void;
  /**
   * The conversation's timing trace: each Messages request (duration, time to
   * the response and to the first text, stream deltas, tokens, retries and
   * waits), and the tool executor's spans.
   */
  onTrace?: (e: TraceDraft) => void;
  /** The TODO tools for this conversation (see ToolExecutorOptions.todo). Undefined: refused. */
  todo?: TodoCall;
  /** remember / recall / forget for this conversation (see ToolExecutorOptions.memory). Undefined: refused. */
  memory?: MemoryCall;
}

export type FailureKind = "transient" | "permanent";

export type { AgentEvent, AgentTask, RunConfig, TaskRunResult, ToolName, ToolResult };
