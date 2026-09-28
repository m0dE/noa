/** The runner's persisted state (shown in the side panel) and the service worker keep-alive. */
import type { StorageLike } from "../kv.js";

const RUNNER_STATE_KEY = "runnerState";
export const KEEP_ALIVE_MS = 20_000;

/** Persisted across service worker restarts (chrome.storage.local). */
export interface RunnerState {
  lastRunAt?: string;
  lastError?: string;
  /** Failed scheduled runs in a row, per job (its task series); a job at maxConsecutiveFailures is paused (failure-policy.ts). */
  failures?: Record<string, number>;
  /** The "no brain" message already notified, so it is shown once. */
  noBrainNotified?: string;
}

/** RunnerState in storage, cached after the first read. */
export class RunnerStateStore {
  private cache: RunnerState | null = null;

  constructor(private readonly storage: () => StorageLike) {}

  async get(): Promise<RunnerState> {
    if (!this.cache) {
      const got = await this.storage().get(RUNNER_STATE_KEY);
      // consecutiveFailures and pausedReason: the one count and pause of every scheduled run, before jobs were paused one by one.
      const { consecutiveFailures: _count, pausedReason: _reason, ...raw } = (got[RUNNER_STATE_KEY] ?? {}) as RunnerState & { consecutiveFailures?: number; pausedReason?: string };
      this.cache = raw;
    }
    return { ...this.cache };
  }

  /** Merges the patch; undefined fields are removed. */
  async patch(patch: Partial<RunnerState>): Promise<void> {
    const next = { ...(await this.get()), ...patch } as RunnerState;
    for (const k of Object.keys(next) as (keyof RunnerState)[]) if (next[k] === undefined) delete next[k];
    this.cache = next;
    await this.storage().set({ [RUNNER_STATE_KEY]: next });
  }
}

/** Keeps the service worker alive (ping every KEEP_ALIVE_MS) while anything holds it. */
export class KeepAlive {
  private holds = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ping: () => unknown) {}

  get held(): boolean {
    return this.holds > 0;
  }

  hold(): void {
    this.holds++;
    this.timer ??= setInterval(() => {
      try {
        void Promise.resolve(this.ping()).catch(() => {});
      } catch {
        /* ignore */
      }
    }, KEEP_ALIVE_MS);
  }

  /** Returns true when nothing holds it any more. */
  release(): boolean {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds > 0) return false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return true;
  }
}
