/**
 * How long a run may last (packages/shared/src/turn-time.ts). The user's
 * limit (maxTaskMinutes) counts active time: ActiveClock leaves out the time
 * the agent waits (wait_for, approvals), and the runner stops the turn when
 * the rest reaches the limit, unless the turn got somewhere since it last
 * did (TurnProgressClock): then it runs on for another limit. Wall time is bounded by TURN_WALL_MINUTES: the
 * brain's own timer, and the runner's safety timer a margin later, which
 * aborts the brain and waits a grace period for its result. A local task
 * still marked running after the safety timer and the grace period was left by
 * a crash (runs still live in this worker are never recovered).
 */
import { madeProgress, ToolProgress } from "@noa/core";
import { TURN_WALL_MINUTES, type AgentEvent } from "@noa/shared";

const SAFETY_MARGIN_MINUTES = 2;
/** Extra wait after aborting a stuck brain before giving up on it. */
export const ABORT_GRACE_MS = 30_000;

/** When the safety timer aborts a run that has not reported a result: after the wall ceiling, with a margin. */
export function safetyTimeoutMinutes(): number {
  return TURN_WALL_MINUTES + SAFETY_MARGIN_MINUTES;
}

/**
 * A task marked running for longer than this, and not live in this worker, was left by a crash. A turn that
 * waited can run longer than maxTaskMinutes, but it is live then; one that is not live has stopped.
 */
export function crashAfterMs(maxTaskMinutes: number): number {
  return (maxTaskMinutes + SAFETY_MARGIN_MINUTES) * 60_000 + ABORT_GRACE_MS;
}

/**
 * A turn's active time: wall time minus the time spent waiting. wait() starts a wait and returns the function that
 * ends it (waits may overlap: time is left out while any runs). When active time reaches the limit, `extend` is asked
 * first: true gives the turn another limitMs (a run still getting somewhere, see TurnProgressClock); otherwise onLimit
 * is called, once. stop() ends the clock.
 */
export class ActiveClock {
  private activeBefore = 0;
  /** When the current active stretch began; null while waiting. */
  private since: number | null;
  private waits = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private over = false;
  private endsAtMs: number;

  constructor(
    private readonly limitMs: number,
    private readonly onLimit: () => void,
    private readonly now: () => number = Date.now,
    private readonly extend: () => boolean = () => false,
  ) {
    this.endsAtMs = limitMs;
    this.since = now();
    this.arm();
  }

  get activeMs(): number {
    return this.activeBefore + (this.since === null ? 0 : this.now() - this.since);
  }

  wait(): () => void {
    if (this.waits++ === 0 && this.since !== null) {
      this.activeBefore += this.now() - this.since;
      this.since = null;
      clearTimeout(this.timer);
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--this.waits > 0) return;
      this.since = this.now();
      this.arm();
    };
  }

  stop(): void {
    this.over = true;
    clearTimeout(this.timer);
  }

  private arm(): void {
    if (this.over) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.over || this.since === null) return;
      if (this.activeMs < this.endsAtMs) return this.arm();
      if (this.extend()) {
        this.endsAtMs += this.limitMs;
        return this.arm();
      }
      this.over = true;
      this.onLimit();
    }, Math.max(0, this.endsAtMs - this.activeMs));
  }
}

/**
 * Whether a turn got somewhere since the last time its time limit was reached (madeProgress over the brain's
 * tool_call and tool_result events): ActiveClock's `extend`.
 */
export class TurnProgressClock {
  readonly progress = new ToolProgress();
  private from = { calls: 0, fresh: 0 };

  observe(e: AgentEvent): void {
    this.progress.observe(e);
  }

  /** Got somewhere since the last call (the first: since the turn began); the next call counts from now. */
  progressed(): boolean {
    const { calls, fresh } = this.progress;
    const ok = madeProgress(calls - this.from.calls, fresh - this.from.fresh);
    this.from = { calls, fresh };
    return ok;
  }
}
