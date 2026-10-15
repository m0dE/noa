/**
 * Routes MCP tool calls (from a task session's MCP server, or the user's own
 * Claude Code attached with `mcp-server.js --attach`, over the pipe) to the
 * right @noa/core tool executor: the task session's, or the attached
 * session's (task id INTERACTIVE_TASK_ID).
 */
import { APPROVAL_TIMEOUT_MS, isApprovalGated, SWITCH_APPROVAL_TIMEOUT_MS, TOOL_NAMES, type BrowserMethod, type BrowserMethods, type ToolName, type ToolResult } from "@noa/shared";
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

/** How long a browser call may wait for a card in the extension, on top of its own time. */
export function approvalWaitMs(method: BrowserMethod): number {
  if (isApprovalGated(method)) return APPROVAL_TIMEOUT_MS;
  // With Auto tab switching off, a screenshot of a background tab may ask to switch to it (after a background try).
  if (method === "browser.screenshot") return SWITCH_APPROVAL_TIMEOUT_MS;
  return 0;
}

/**
 * A core BrowserCaller over the extension RPC, with a per-call timeout. An
 * action that changes something may first wait for the user's approval in the
 * extension (up to APPROVAL_TIMEOUT_MS), and a screenshot for the card asking to
 * switch tabs (up to SWITCH_APPROVAL_TIMEOUT_MS): its timeout allows for that.
 */
export function rpcBrowser(peer: RpcBrowser, timeoutMs = BROWSER_RPC_TIMEOUT_MS): BrowserCaller {
  return { call: (method, params) => peer.call(method, params, { timeoutMs: timeoutMs + approvalWaitMs(method) }) };
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

/**
 * The attached sessions' tools, one set per pipe connection: each attached Claude Code session runs its own MCP
 * server process, which holds one connection for the session's life. So what a session's tools keep (Jev's late
 * answers and pause, act's unsure picks, the last page read) is that session's only, and ends with it.
 */
export class AttachedSessions {
  private readonly byClient = new Map<number, InteractiveTools>();

  constructor(private readonly make: () => InteractiveTools) {}

  /** The tools of the session on this connection (made on its first call). */
  get(client: number): InteractiveTools {
    let tools = this.byClient.get(client);
    if (!tools) this.byClient.set(client, (tools = this.make()));
    return tools;
  }

  /** The connection closed: its session is over. */
  end(client: number): void {
    this.byClient.delete(client);
  }

  get size(): number {
    return this.byClient.size;
  }
}

export class ToolRouter {
  constructor(
    private readonly deps: {
      /** No id: the running turn's session. With an id: that task session (running or idle). */
      getSession: (taskId?: string) => ToolSession | null;
      /** The tools of the attached session on that pipe connection (PipeHandlers' client); null when not available. */
      getInteractive?: (client: number) => InteractiveTools | null;
    },
  ) {}

  /** Tool names the given task may use (for `tool.list`). client: the pipe connection (attached sessions). */
  allowedTools(taskId: string, client = 0): ToolName[] {
    const target = this.target(taskId, client);
    return target ? TOOL_NAMES.filter((n) => target.allowedTools.has(n)) : [];
  }

  /** Whether Jev picks act's elements for the given task (for `tool.list`). */
  jev(taskId: string, client = 0): boolean {
    return this.target(taskId, client)?.jev === true;
  }

  async call(taskId: string, name: ToolName, args: unknown, client = 0): Promise<ToolResult> {
    const target = this.target(taskId, client);
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

  private target(taskId: string, client: number): ToolSession | InteractiveTools | null {
    if (taskId === INTERACTIVE_TASK_ID) return this.deps.getInteractive?.(client) ?? null;
    const s = this.deps.getSession(taskId);
    return s && s.taskId === taskId ? s : null;
  }
}
