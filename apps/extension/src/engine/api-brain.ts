/**
 * The Claude API agent loop in the service worker, behind the Brain
 * interface. The same loop serves two brains, told apart by their backend:
 * the user's Anthropic API key (claude-api) and the hosted Noa AI
 * (Noa, see hosted-brain.ts).
 */
import { withoutCreditPause, type AgentSession, type ApiAgentOptions, type ApiAttachment, type BrowserCaller, type JevLike } from "@noa/core";
import { errorMessage, SESSION_HEADER, type AgentEvent, type ExtensionSettings, type MemoryToolName, type TodoToolName, type TodoToolResult } from "@noa/shared";
import { callSafely } from "../listeners.js";
import { hostedJevEndpoint } from "./hosted-brain.js";
import { endedRun, failedRun, type Brain, type BrainContinueOptions, type BrainRun, type BrainStartOptions, type CoreApi, type TurnAttachment } from "./brains.js";

/** Where a conversation's current turn goes: the runner's event handler and the turn's tab. */
interface TurnRoute {
  sink: (e: AgentEvent) => void;
  browser: BrowserCaller;
}

/** A conversation's Claude API agent, kept in memory between turns. */
interface ApiConversation {
  agent: AgentSession;
  /** Changed at every turn; the agent reaches the turn through it. */
  route: TurnRoute;
  lastUsed: number;
}

/** Where an API brain's requests go and how they authenticate. */
export interface ApiBackend {
  readonly kind: "claude-api" | "noa";
  /** What the brain is called in messages. */
  readonly label: string;
  /** The agent options for a new session. Throws when the backend cannot be used. */
  connect(
    settings: ExtensionSettings,
    sessionId: string,
  ): { agent: Pick<ApiAgentOptions, "apiKey" | "model" | "baseUrl" | "auth" | "headers" | "label" | "onOutOfCredit">; jev: JevLike | null };
  /** A turn ended (e.g. refresh the account's credit). */
  afterTurn?(): void;
}

/**
 * The user's own Anthropic API key. Jev, when it is on: the Jev key set here, else Noa's cloud Jev while
 * `cloudJev` gives the account's session (jevSourceFor); a run it has no credit for goes on without it.
 */
export function claudeApiBackend(core: Pick<CoreApi, "createJev">, fetchFn?: typeof fetch, cloudJev?: () => { token: string; apiBase: string } | null): ApiBackend {
  const fetchOpt = fetchFn ? { fetch: fetchFn } : {};
  return {
    kind: "claude-api",
    label: "Claude API",
    connect(s, sessionId) {
      let jev: JevLike | null = null;
      const cloud = s.jevEnabled && !s.jevApiKey ? cloudJev?.() : null;
      if (s.jevEnabled && s.jevApiKey) jev = core.createJev(s.jevApiKey, fetchFn ? { fetch: fetchFn } : undefined);
      else if (cloud) jev = withoutCreditPause(core.createJev(cloud.token, { endpoint: hostedJevEndpoint(cloud.apiBase), headers: { [SESSION_HEADER]: sessionId }, ...fetchOpt }));
      return { agent: { apiKey: s.anthropicApiKey, model: s.anthropicModel }, jev };
    },
  };
}

/** Like the helper's kept-open Claude Code sessions: a few, for 30 idle minutes. */
const API_KEEP_CONVERSATIONS = 3;
export const API_IDLE_MS = 30 * 60_000;

/** The agent loop inside the extension (core.startApiAgent), on the backend's endpoint. */
export class ApiBrain implements Brain {
  readonly kind: "claude-api" | "noa";
  private readonly backend: ApiBackend;
  /** Conversation history lives here only: lost when the service worker restarts. */
  private readonly conversations = new Map<string, ApiConversation>();

  constructor(
    private readonly deps: {
      core: Pick<CoreApi, "startApiAgent" | "createJev">;
      browser: BrowserCaller;
      fetch?: typeof fetch;
      now?: () => number;
      onSessionsChanged?: () => void;
      /** Default: the Anthropic API key in the settings. */
      backend?: ApiBackend;
      /** The default backend's Noa cloud Jev: the account's session while it can be used, else null. */
      cloudJev?: () => { token: string; apiBase: string } | null;
      /** The TODO tools for a conversation (the TODO list's TaskScheduler). Absent: the tools are refused. */
      todoTool?: (sessionId: string, tool: TodoToolName, args: unknown) => Promise<TodoToolResult>;
      /** remember / recall / forget for a conversation (the extension's memory). Absent: the tools are refused. */
      memoryTool?: (sessionId: string, tool: MemoryToolName, args: unknown) => Promise<{ text: string; isError?: boolean }>;
    },
  ) {
    this.backend = deps.backend ?? claudeApiBackend(deps.core, deps.fetch, deps.cloudJev);
    this.kind = this.backend.kind;
  }

  start(opts: BrainStartOptions): BrainRun {
    try {
      const { agent, jev } = this.backend.connect(opts.settings, opts.sessionId);
      const route: TurnRoute = { sink: opts.onEvent, browser: opts.browser ?? this.deps.browser };
      const conv: ApiConversation = {
        route,
        lastUsed: this.now(),
        agent: this.deps.core.startApiAgent({
          ...agent,
          sessionId: opts.sessionId,
          task: opts.task,
          mediaPaths: opts.mediaPaths,
          ...(opts.attachments?.length ? { attachments: opts.attachments.map(apiAttachment) } : {}),
          config: opts.config,
          // Every turn acts in its own run's tab.
          browser: { call: (method, params) => route.browser.call(method, params) },
          jev,
          onEvent: (e) => route.sink(e),
          // Model calls and tool spans for the conversation's trace (recorded here, in the engine).
          onTrace: (trace) => route.sink({ type: "trace", trace: { ...trace, src: "engine" } }),
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
          ...(this.deps.todoTool ? { todo: (tool: TodoToolName, args: unknown) => this.deps.todoTool!(opts.sessionId, tool, args) } : {}),
          ...(this.deps.memoryTool ? { memory: (tool: MemoryToolName, args: unknown) => this.deps.memoryTool!(opts.sessionId, tool, args) } : {}),
        }),
      };
      if (conv.agent.continueWith) this.keep(opts.sessionId, conv);
      this.touchWhenDone(conv);
      return this.runOf(conv.agent);
    } catch (err) {
      return failedRun(`Could not start the ${this.backend.label} agent: ${errorMessage(err)}`);
    }
  }

  continue(opts: BrainContinueOptions): BrainRun {
    const conv = this.live(opts.sessionId);
    if (!conv?.agent.continueWith) return endedRun();
    let agent: AgentSession;
    try {
      conv.route.sink = opts.onEvent;
      conv.route.browser = opts.browser ?? this.deps.browser;
      agent = conv.agent.continueWith(opts.text, { config: opts.config, ...(opts.attachments?.length ? { attachments: opts.attachments.map(apiAttachment) } : {}) });
    } catch (err) {
      return failedRun(errorMessage(err));
    }
    conv.agent = agent;
    conv.lastUsed = this.now();
    this.touchWhenDone(conv);
    return this.runOf(agent);
  }

  isOpen(sessionId: string): boolean {
    return this.live(sessionId) !== null;
  }

  openSessions(): string[] {
    return [...this.conversations.keys()].filter((id) => this.live(id));
  }

  async end(sessionId: string): Promise<void> {
    if (this.conversations.delete(sessionId)) this.changed();
  }

  /** Idle time counts from the end of the last turn. */
  private touchWhenDone(conv: ApiConversation): void {
    const agent = conv.agent;
    void agent.done.then(
      () => {
        if (conv.agent === agent) conv.lastUsed = this.now();
        callSafely(this.backend.afterTurn);
      },
      () => {},
    );
  }

  private runOf(agent: AgentSession): BrainRun {
    return {
      done: agent.done,
      sendUserMessage: async (text) => {
        agent.sendUserMessage(text);
        return true;
      },
      abort: (reason, outcome) => agent.abort(reason, outcome),
    };
  }

  private keep(sessionId: string, conv: ApiConversation): void {
    this.conversations.delete(sessionId);
    this.conversations.set(sessionId, conv);
    // Oldest first (Map order): drop the oldest beyond the limit.
    const excess = this.conversations.size - API_KEEP_CONVERSATIONS;
    for (const id of [...this.conversations.keys()].slice(0, Math.max(0, excess))) this.conversations.delete(id);
    this.changed();
  }

  /** The conversation, unless it idled out (then it is dropped). */
  private live(sessionId: string): ApiConversation | null {
    const conv = this.conversations.get(sessionId);
    if (!conv) return null;
    if (this.now() - conv.lastUsed > API_IDLE_MS) {
      this.conversations.delete(sessionId);
      return null;
    }
    return conv;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private changed(): void {
    callSafely(this.deps.onSessionsChanged);
  }
}

/** An attachment as the agent loop takes it (its bytes stay here; a fresh image's or PDF's go as base64). */
function apiAttachment({ blob: _bytes, ...a }: TurnAttachment): ApiAttachment {
  return a;
}
