import { USER_STOP_REASON } from "@noa/shared";
/**
 * The sessions running right now and what each one holds while it runs: its
 * agent slot (tab), the X turn, its local task.
 */
import type { SessionInfo } from "@noa/shared";
import type { SlotPool } from "../../agent-slots.js";
import { DEBUGGER_CANCELED } from "../../cdp.js";
import type { AbortOutcome } from "../brains.js";
import { Signal, SlotTable, XTurn } from "./scheduling.js";
import type { ActiveSession } from "./turn.js";

/** The runner's own reasons to stop a session, with the outcome each ends it with and its reason in words (chat, notifications, a continuing agent). */
const STOPS = {
  "user-stop": { outcome: "paused", reason: USER_STOP_REASON },
  "tab-closed": { outcome: "paused", reason: "The tab was closed" },
  "debugger-canceled": { outcome: "failed", reason: DEBUGGER_CANCELED },
} as const satisfies Record<string, { outcome: AbortOutcome; reason: string }>;

/** Why the runner stopped a session (rather than the brain ending it). */
export type StopKind = keyof typeof STOPS | "pause-url" | "needs-approval";

export interface ForcedStop {
  kind: StopKind;
  outcome: AbortOutcome;
  reason: string;
}

export function stopOf(kind: keyof typeof STOPS): ForcedStop {
  return { kind, ...STOPS[kind] };
}

/** The agent's tab reached a page that needs the user; reason: what it needs (pauseReasonForUrl). */
export function pauseUrlStop(reason: string): ForcedStop {
  return { kind: "pause-url", outcome: "paused", reason };
}

/** Nobody was there to approve an action (an unattended scheduled run); reason: what needs the user's OK (approvalPauseReason). */
export function approvalStop(reason: string): ForcedStop {
  return { kind: "needs-approval", outcome: "paused", reason };
}

export class ActiveSessions {
  /** Oldest first. */
  private readonly byId = new Map<string, ActiveSession>();
  readonly slots: SlotTable;
  readonly xTurn = new XTurn();
  /** Local tasks picked by the due loop that have not ended yet. */
  readonly localRunning = new Set<string>();
  /** Woken whenever a session ends (or on stop): the due loop waits on it for capacity. */
  readonly ended = new Signal();

  constructor(private readonly pool: SlotPool) {
    this.slots = new SlotTable(pool.size);
  }

  get size(): number {
    return this.byId.size;
  }

  has(sessionId: string): boolean {
    return this.byId.has(sessionId);
  }

  get(sessionId: string): ActiveSession | undefined {
    return this.byId.get(sessionId);
  }

  /** Oldest first. */
  all(): ActiveSession[] {
    return [...this.byId.values()];
  }

  /** The session started last. */
  last(): ActiveSession | undefined {
    return this.all().at(-1);
  }

  /** Registers a running session in its slot, with the local task it runs (kept from crash recovery and the due loop until it ends). */
  activate(session: SessionInfo, slotIndex: number, x: boolean, scheduled: boolean, localTaskId: string | null): ActiveSession {
    const sessionId = session.sessionId;
    this.slots.bind(slotIndex, sessionId);
    if (localTaskId) this.localRunning.add(localTaskId);
    const slot = this.pool.take(slotIndex, sessionId);
    const active: ActiveSession = { session, slot, run: null, forced: null, said: [], waiting: [], runOver: false, nextTurn: [], typed: [], x, scheduled, localTaskId, approvals: new AbortController() };
    this.byId.set(sessionId, active);
    return active;
  }

  /**
   * The session ended: its slot, X turn and local task are free again.
   * keepTabs: the tabs its agent opened stay open for its next turn (see SlotPool.release).
   */
  deactivate(active: ActiveSession, keepTabs: boolean): void {
    const sessionId = active.session.sessionId;
    if (this.byId.get(sessionId) === active) this.byId.delete(sessionId);
    const index = this.slots.release(sessionId);
    if (index !== null) this.pool.release(index, sessionId, { keepTabs });
    this.xTurn.release(sessionId);
    if (active.localTaskId) this.localRunning.delete(active.localTaskId);
    this.ended.notify();
  }

  /** The chat is over (New Chat): the tabs its agent opened close (see SlotPool.endChat). */
  endChat(sessionId: string): Promise<void> {
    return this.pool.endChat(sessionId);
  }

  /** A session that never became active: gives back the slot, X turn and local task taken for it. */
  abandon(slotIndex: number, sessionId: string, localTaskId: string | null): void {
    this.slots.unassign(slotIndex);
    this.xTurn.release(sessionId);
    if (localTaskId) this.localRunning.delete(localTaskId);
    this.ended.notify();
  }

  /**
   * Stops a session (the brain is asked to stop; an X wait ends). The first stop wins. Its waiting approvals end
   * at once as not done: a brain's run cannot end while an action of it waits in the approval gate.
   */
  force(a: ActiveSession, stop: ForcedStop): void {
    if (a.forced) return;
    a.forced = stop;
    a.approvals.abort("stop");
    a.run?.abort(stop.reason, stop.outcome);
    this.xTurn.wake();
  }

  /** Stops every running session. */
  forceAll(stop: ForcedStop): void {
    for (const a of this.all()) this.force(a, stop);
  }
}
