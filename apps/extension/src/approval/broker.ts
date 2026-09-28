/**
 * Approval requests waiting for the user: the gate asks (request), the chat's
 * approval card or hands-free voice answers (answer), and a request with no
 * answer in APPROVAL_TIMEOUT_MS counts as denied. Each request and how it
 * ended are events of the conversation (approval_request, approval_resolved),
 * so the card shows in the thread, survives a panel reload, and the Raw view
 * has it, with a trace row saying what ended it and how long it waited
 * (approval.wait). A request ends once: whatever comes after (a late Allow)
 * is refused.
 *
 * What ends a request besides an answer: the turn ending (end()), the
 * request's signal (Stop: "ended"; a message from the user: "interrupted",
 * so the agent reads it first), and nobody being there to answer (an
 * unattended run: "paused" at once, its card kept in the thread).
 */
import {
  APPROVAL_TIMEOUT_MS,
  type AgentEvent,
  type ApprovalAnswer,
  type ApprovalAnsweredBy,
  type ApprovalEndedBy,
  type ApprovalOutcome,
  type ApprovalRequest,
  type TraceEvent,
} from "@noa/shared";

export interface ApprovalBrokerDeps {
  /** Adds an event to the conversation (SessionStore.note). */
  note(sessionId: string, event: AgentEvent): void | Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  newId?: () => string;
  /** A request now waits for the user (e.g. a system notification when the side panel may be closed). */
  onRequest?(sessionId: string, request: ApprovalRequest): void;
  /** Adds a row to the conversation's timing trace (the Raw view): each request's wait and what ended it. */
  trace?(sessionId: string, row: TraceEvent): void;
}

/** Why a request's signal was aborted: the run was stopped, or the user wrote to the agent. */
export type ApprovalInterrupt = "stop" | "message";

export interface ApprovalRequestOptions {
  /** Waits at most this long (never longer than the broker's timeout). */
  timeoutMs?: number;
  /** Ends the request when aborted; its reason is an ApprovalInterrupt ("message" ends it as interrupted, anything else as ended). */
  signal?: AbortSignal;
  /** Nobody can answer now: the card is kept in the thread and the request ends at once as "paused". */
  unattended?: boolean;
}

interface Pending {
  sessionId: string;
  request: ApprovalRequest;
  settle(outcome: ApprovalOutcome, by: ApprovalEndedBy): void;
}

const ANSWERED_BY = new Set<ApprovalEndedBy>(["card", "keyboard", "voice"]);

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly newId: () => string;

  constructor(private readonly deps: ApprovalBrokerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Asks the user; resolves with their answer, or how it ended without one (see the top of this file). */
  request(sessionId: string, ask: Omit<ApprovalRequest, "id" | "expiresAt">, opts: ApprovalRequestOptions = {}): Promise<ApprovalOutcome> {
    const { signal } = opts;
    // Stopped (or written to) before it was asked: nothing is shown, the action is not done.
    if (signal?.aborted) return Promise.resolve(interruptOutcome(signal));
    const timeoutMs = Math.min(opts.timeoutMs ?? this.timeoutMs, this.timeoutMs);
    const askedAt = this.now();
    const request: ApprovalRequest = { ...ask, id: this.newId(), expiresAt: new Date(askedAt + (opts.unattended ? 0 : timeoutMs)).toISOString() };
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = opts.unattended ? undefined : setTimeout(() => settle("timeout", "timeout"), timeoutMs);
      const onAbort = () => settle(interruptOutcome(signal!), signal!.reason === "message" ? "message" : "stop");
      const settle = (outcome: ApprovalOutcome, by: ApprovalEndedBy) => {
        if (!this.pending.delete(request.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void this.emit(sessionId, { type: "approval_resolved", id: request.id, outcome, ...(ANSWERED_BY.has(by) ? { by: by as ApprovalAnsweredBy } : {}) });
        this.deps.trace?.(sessionId, { t: askedAt, ms: this.now() - askedAt, cat: "approval", name: "approval.wait", src: "engine", data: { id: request.id, action: request.action, site: request.site, outcome, by } });
        resolve(outcome);
      };
      this.pending.set(request.id, { sessionId, request, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      // A request the user cannot see would only wait out its timeout: it ends at once instead.
      void this.emit(sessionId, { type: "approval_request", request }).then((shown) => {
        if (!shown) settle("ended", "not_shown");
        // Nobody to answer: the card stays in the thread, and the run pauses for the user (the gate's caller says why).
        else if (opts.unattended) settle("paused", "unattended");
        else if (this.pending.has(request.id)) this.deps.onRequest?.(sessionId, request);
      });
    });
  }

  /** The user's answer to a request of this conversation. False when it is not waiting (answered, ended, or not this conversation's). */
  answer(sessionId: string, id: string, answer: ApprovalAnswer, by: ApprovalAnsweredBy = "card"): boolean {
    const p = this.pending.get(id);
    if (!p || p.sessionId !== sessionId) return false;
    p.settle(answer, by);
    return true;
  }

  /** The turn ended: its waiting requests end unanswered (the actions are not done). */
  end(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) p.settle("ended", "turn_end");
  }

  /** The conversations with a request waiting now (the side panel lists them under Needs you). */
  waitingSessions(): string[] {
    return [...new Set([...this.pending.values()].map((p) => p.sessionId))];
  }

  /** Requests waiting now, oldest first (all conversations, or one). */
  waiting(sessionId?: string): ApprovalRequest[] {
    return [...this.pending.values()].filter((p) => !sessionId || p.sessionId === sessionId).map((p) => p.request);
  }

  /** Adds the event to the conversation; false when that failed. */
  private async emit(sessionId: string, e: AgentEvent): Promise<boolean> {
    try {
      await this.deps.note(sessionId, e);
      return true;
    } catch {
      return false;
    }
  }
}

function interruptOutcome(signal: AbortSignal): ApprovalOutcome {
  return signal.reason === "message" ? "interrupted" : "ended";
}
