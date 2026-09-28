/**
 * What the user cleared from the jobs list (sidepanel/jobs.ts reads it): a job that needed them, dismissed (it moves
 * to Recent), or a finished one put away (it leaves the list; search still finds it). Kept in chrome.storage.local,
 * job key -> dismissal, so every panel and a restarted service worker see the same list. Nothing of the job itself
 * changes: its conversation and memory stay (Delete in its "⋯" removes them).
 */
import type { StorageLike } from "./engine/kv.js";
import { Listeners } from "./listeners.js";
import type { JobDismissal } from "./ui-protocol.js";

const KEY = "jobDismissals";
/** The newest this many are kept (older ones are for jobs long gone from the list). */
export const MAX_DISMISSALS = 500;

export class JobDismissals {
  private cache: Record<string, JobDismissal> | null = null;
  private readonly changes = new Listeners();

  constructor(private readonly area: StorageLike) {}

  async all(): Promise<Record<string, JobDismissal>> {
    if (this.cache) return this.cache;
    const raw = (await this.area.get(KEY))[KEY];
    this.cache = raw && typeof raw === "object" ? (raw as Record<string, JobDismissal>) : {};
    return this.cache;
  }

  /** Adds (or replaces) dismissals by job key; the oldest go beyond MAX_DISMISSALS. */
  async set(entries: Record<string, JobDismissal>): Promise<void> {
    const merged = Object.entries({ ...(await this.all()), ...entries })
      .sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, MAX_DISMISSALS);
    this.cache = Object.fromEntries(merged);
    await this.area.set({ [KEY]: this.cache });
    this.changes.emit();
  }

  /** Called after every change. */
  onChange(fn: () => void): () => void {
    return this.changes.add(fn);
  }
}
