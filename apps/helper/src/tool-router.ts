/**
 * Routes MCP tool calls (from a task session's MCP server, or the user's own
 * Claude Code attached with `mcp-server.js --attach`, over the pipe) to the
 * right @noa/core tool executor: the task session's, or the attached
 * session's (task id INTERACTIVE_TASK_ID).
 */
import { APPROVAL_TIMEOUT_MS, isApprovalGated, TOOL_NAMES, type BrowserMethod, type BrowserMethods, type ToolName, type ToolResult } from "@noa/shared";
import type { BrowserCaller, ToolExecutor } from "@noa/core";
import { INTERACTIVE_TASK_ID } from "./mcp-tools.js";

export const BROWSER_RPC_TIMEOUT_MS = 60_000;

/** Structural view of RpcPeer<BrowserMethods, ...> (it takes a timeout option). */
export interface RpcBrowser {
  call<M extends BrowserMethod>(
    method: M,
    params: BrowserMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<BrowserMethods[M]["result"]>;
}

/**
 * A core BrowserCaller over the extension RPC, with a per-call timeout. An
 * action that changes something may first wait for the user's approval in the
 * extension (up to APPROVAL_TIMEOUT_MS): its timeout allows for that.
 */
export function rpcBrowser(peer: RpcBrowser, timeoutMs = BROWSER_RPC_TIMEOUT_MS): BrowserCaller {
  return { call: (method, params) => peer.call(method, params, { timeoutMs: timeoutMs + (isApprovalGated(method) ? APPROVAL_TIMEOUT_MS : 0) }) };
}

/** A task session, as seen by the router. Implemented by TaskSession. */
export interface ToolSession {
  taskId: string;
  allowedTools: ReadonlySet<ToolName>;
  /** Jev picks act's elements in this session (tool descriptions differ). */
  jev?: boolean;
  /** Called before each tool. Returns an error text to return instead of running it. */
  beforeCall(name: ToolName): string | null;
  executor: ToolExecutor;
}

/** The attached session's tools (no task to end, no limits). */
export interface InteractiveTools {
  allowedTools: ReadonlySet<ToolName>;
  jev?: boolean;
  executor: ToolExecutor;
}

const err = (text: string): ToolResult => ({ text, isError: true });

export class ToolRouter {
  constructor(
    private readonly deps: {
      /** No id: the running turn's session. With an id: that task session (running or idle). */
      getSession: (taskId?: string) => ToolSession | null;
      /** The attached session's tools; null when not available. */
      getInteractive?: () => InteractiveTools | null;
    },
  ) {}

  /** Tool names the given task may use (for `tool.list`). */
  allowedTools(taskId: string): ToolName[] {
    const target = this.target(taskId);
    return target ? TOOL_NAMES.filter((n) => target.allowedTools.has(n)) : [];
  }

  /** Whether Jev picks act's elements for the given task (for `tool.list`). */
  jev(taskId: string): boolean {
    return this.target(taskId)?.jev === true;
  }

  async call(taskId: string, name: ToolName, args: unknown): Promise<ToolResult> {
    const target = this.target(taskId);
    if (!target) return err(`No running task ${taskId}. Stop now.`);
    if (taskId === INTERACTIVE_TASK_ID && this.deps.getSession()) {
      return err("A Noa task is using the browser right now. Wait for it to finish, then try again.");
    }
    if (!(TOOL_NAMES as string[]).includes(name) || !target.allowedTools.has(name)) {
      return err(`Tool ${name} is not available${taskId === INTERACTIVE_TASK_ID ? " in an attached session" : " for this task"}.`);
    }
    if ("beforeCall" in target) {
      const blocked = target.beforeCall(name);
      if (blocked) return err(blocked);
    }
    return target.executor.call(name, args);
  }

  private target(taskId: string): ToolSession | InteractiveTools | null {
    if (taskId === INTERACTIVE_TASK_ID) return this.deps.getInteractive?.() ?? null;
    const s = this.deps.getSession(taskId);
    return s && s.taskId === taskId ? s : null;
  }
}
