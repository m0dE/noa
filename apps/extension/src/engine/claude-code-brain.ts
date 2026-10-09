/** Headless Claude Code in the helper, behind the Brain interface. */
import { ATTACHMENT_CHUNK_BYTES, errorMessage, HelperErrorCode, rpcErrorCode, type AgentAttachment, type AgentEvent, type HelperInfo, type HelperMethods, type HelperNotifications, type RunConfig, type TaskRunResult, type TraceEvent } from "@noa/shared";
import { HELPER_CALL_TIMEOUT_MS } from "../helper-link.js";
import { hostedJevEndpoint } from "./hosted-brain.js";
import { bytesToBase64 } from "../base64.js";
import { endedRun, SessionEndedError, type Brain, type BrainContinueOptions, type BrainRun, type BrainStartOptions, type TurnAttachment } from "./brains.js";

export interface HelperLike {
  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<HelperMethods[M]["result"]>;
  onNotification<N extends keyof HelperNotifications & string>(method: N, fn: (params: HelperNotifications[N]) => void): () => void;
  onDisconnect(fn: (reason: string) => void): () => void;
  /** Hello info (with the open sessions) after every connect, null on disconnect. */
  onInfo?(fn: (info: HelperInfo | null) => void): () => void;
}


/** Headless Claude Code in the helper (helper.runTask / helper.continueSession + helper.event). */
export class ClaudeCodeBrain implements Brain {
  readonly kind = "claude-code" as const;
  /** Attachments go to the helper, into the session's folder: Claude Code Reads and uploads them there. */
  readonly keepsAttachments = true as const;
  /** Task sessions alive in the helper, as it last reported them. */
  private open = new Set<string>();
  /** Sessions whose turn is running: a run listens to their events. */
  private readonly running = new Set<string>();

  constructor(
    private readonly helper: HelperLike,
    private readonly opts: {
      onSessionsChanged?: () => void;
      /**
       * A timing of a session whose turn already ended. Claude Code runs task_complete as soon as the
       * model wrote it, so the turn ends before that model call's stream closes (and its model.call
       * timing is sent); Claude Code's own summary of the turn (claude.result) comes later still.
       */
      onLateTrace?: (sessionId: string, trace: TraceEvent) => void;
      /** The signed-in account's session while Noa's cloud Jev can be used (cloudJevUsable), else null. */
      cloudJev?: () => { token: string; apiBase: string } | null;
    } = {},
  ) {
    helper.onNotification("helper.event", (p) => {
      if (p.event.type === "trace" && !this.running.has(p.sessionId)) this.opts.onLateTrace?.(p.sessionId, p.event.trace);
    });
    helper.onNotification("helper.sessions", (p) => this.setOpen(p.open));
    helper.onInfo?.((info) => this.setOpen(info?.openSessions ?? []));
    helper.onDisconnect(() => this.setOpen([]));
  }

  start(opts: BrainStartOptions): BrainRun {
    const { sessionId } = opts;
    // A new agent session has none of the conversation's files yet: all of them go.
    const attachments = opts.attachments ?? [];
    return this.run(sessionId, opts.onEvent, () =>
      this.after(this.send(sessionId, attachments), () =>
        this.helper.call("helper.runTask", {
          sessionId,
          task: opts.task,
          mediaPaths: opts.mediaPaths,
          config: this.withCloudJev(opts.config),
          ...(attachments.length ? { attachments: attachments.map(agentAttachment) } : {}),
        }),
      ),
    );
  }

  continue(opts: BrainContinueOptions): BrainRun {
    const { sessionId } = opts;
    if (!this.open.has(sessionId)) return endedRun();
    // The session has the earlier files already: this message's go.
    const attachments = opts.attachments ?? [];
    return this.run(sessionId, opts.onEvent, () =>
      this.after(this.send(sessionId, attachments.filter((a) => a.fresh)), () =>
        this.helper
          .call("helper.continueSession", { sessionId, text: opts.text, config: this.withCloudJev(opts.config), ...(attachments.length ? { attachments: attachments.map(agentAttachment) } : {}) })
          .catch((err: unknown) => {
            if (rpcErrorCode(err) === HelperErrorCode.sessionEnded) throw new SessionEndedError();
            throw err;
          }),
      ),
    );
  }

  /** `call` once `sending` is done; at once when nothing was sent (the turn starts without waiting a tick). */
  private after<T>(sending: Promise<void> | null, call: () => Promise<T>): Promise<T> {
    return sending ? sending.then(call) : call();
  }

  /** Noa's cloud Jev for the helper, used when neither a key here nor its own is set (jevSourceFor). */
  private withCloudJev(config: RunConfig): RunConfig {
    if (!config.jevEnabled || config.jevApiKey) return config;
    const s = this.opts.cloudJev?.();
    return s ? { ...config, jevCloud: { endpoint: hostedJevEndpoint(s.apiBase), token: s.token } } : config;
  }

  /** Sends files to the helper in pieces of ATTACHMENT_CHUNK_BYTES (native messaging keeps messages small); null: none. */
  private send(sessionId: string, attachments: readonly TurnAttachment[]): Promise<void> | null {
    return attachments.length ? this.sendAll(sessionId, attachments) : null;
  }

  private async sendAll(sessionId: string, attachments: readonly TurnAttachment[]): Promise<void> {
    for (const a of attachments) {
      const bytes = new Uint8Array(await a.blob.arrayBuffer());
      let offset = 0;
      do {
        const piece = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
        await this.helper.call("helper.putAttachment", { sessionId, id: a.ref.id, offset, dataBase64: bytesToBase64(piece) }, { timeoutMs: HELPER_CALL_TIMEOUT_MS });
        offset += piece.length;
      } while (offset < bytes.length);
    }
  }

  prewarm(config: RunConfig): void {
    this.helper.call("helper.prewarm", { config: this.withCloudJev(config) }, { timeoutMs: HELPER_CALL_TIMEOUT_MS }).catch(() => {});
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  openSessions(): string[] {
    return [...this.open];
  }

  async end(sessionId: string): Promise<void> {
    try {
      await this.helper.call("helper.endSession", { sessionId }, { timeoutMs: HELPER_CALL_TIMEOUT_MS });
    } catch {
      /* already gone, or the helper is not connected */
    }
    if (this.open.delete(sessionId)) this.changed();
  }

  private run(sessionId: string, onEvent: (e: AgentEvent) => void, call: () => Promise<TaskRunResult>): BrainRun {
    this.running.add(sessionId);
    const cleanups: (() => void)[] = [() => this.running.delete(sessionId)];
    cleanups.push(
      this.helper.onNotification("helper.event", (p) => {
        if (p.sessionId === sessionId) onEvent(p.event);
      }),
    );
    const disconnected = new Promise<TaskRunResult>((resolve) => {
      cleanups.push(this.helper.onDisconnect((reason) => resolve({ outcome: "retry", reason: `helper disconnected: ${reason}` })));
    });
    const run = call().catch((err: unknown): TaskRunResult => {
      if (err instanceof SessionEndedError) throw err;
      return { outcome: "retry", reason: `helper error: ${errorMessage(err)}` };
    });
    const done = Promise.race([run, disconnected]).finally(() => {
      for (const fn of cleanups) fn();
    });
    return {
      done,
      sendUserMessage: async (text) => {
        try {
          return (await this.helper.call("helper.sendUserMessage", { sessionId, text }, { timeoutMs: HELPER_CALL_TIMEOUT_MS })).ok;
        } catch {
          return false;
        }
      },
      abort: (reason, outcome) => {
        const call =
          outcome === "paused"
            ? this.helper.call("helper.forcePause", { sessionId, reason }, { timeoutMs: HELPER_CALL_TIMEOUT_MS })
            : this.helper.call("helper.abortTask", { sessionId, reason }, { timeoutMs: HELPER_CALL_TIMEOUT_MS });
        call.catch(() => {});
      },
    };
  }

  private setOpen(ids: readonly string[]): void {
    const next = new Set(ids);
    if (next.size === this.open.size && [...next].every((id) => this.open.has(id))) return;
    this.open = next;
    this.changed();
  }

  private changed(): void {
    try {
      this.opts.onSessionsChanged?.();
    } catch {
      /* UI push errors are not the brain's problem */
    }
  }
}

/** What the helper is told of an attachment: the bytes went ahead, and it gives the path. */
function agentAttachment({ blob: _bytes, base64: _data, path: _path, ...a }: TurnAttachment): AgentAttachment {
  return a;
}
