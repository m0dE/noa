/**
 * Dismissing jobs from the list (✕ on a row, Delete on a focused row, Dismiss all on Needs you): what it does to a
 * job, and the few seconds in which Undo takes it back.
 *
 * A need dismissed moves to Recent at once; it is done for real only when the Undo time is over (or the panel is
 * hidden, or another dismissal comes): a live run waiting for an approval is stopped then (the approval ends
 * unanswered, never allowed), a one-off task of the account's queue that paused is cancelled, and the dismissal is
 * kept (jobs.dismiss) so every panel shows the same. A Recent job is put away (it leaves the list; search finds it).
 * Upcoming and running jobs are not dismissed: they have Pause and Delete in their "⋯".
 */
import type { JobDismissal } from "../ui-protocol.js";
import type { Job } from "./jobs.js";

/** How long Undo is offered. */
export const UNDO_MS = 6000;

export interface Dismissal {
  key: string;
  /** The job's title (for Undo's line). */
  title: string;
  entry: JobDismissal;
  /** Done when it is committed: stop the live run, or cancel the account's task. */
  action?: { type: "stop"; sessionId: string } | { type: "cancel"; taskId: string };
}

/** What dismissing `job` does (null: it cannot be dismissed). */
export function dismissalOf(job: Job, source: "local" | "account", now = Date.now()): Dismissal | null {
  const at = new Date(now).toISOString();
  const { key, title } = job;
  if (job.group === "recent") return { key, title, entry: { at, archivedAt: job.at } };
  if (job.group !== "needs" || !job.needs) return null;
  const entry = { at, needs: job.needs };
  if (job.running && job.session) return { key, title, entry, action: { type: "stop", sessionId: job.session.sessionId } };
  const t = job.task;
  if (t?.status === "paused" && source === "account" && !t.repeat) return { key, title, entry, action: { type: "cancel", taskId: t.id } };
  return { key, title, entry };
}

export interface DismisserDeps {
  /** Does the batch for real (it can no longer be undone). */
  commit(batch: readonly Dismissal[]): Promise<void>;
  /** The dismissals not yet committed changed (the list shows them as done already). */
  onPending(pending: Readonly<Record<string, JobDismissal>>): void;
  /** Offer Undo for the batch (null: take the offer away). */
  offerUndo(batch: readonly Dismissal[] | null): void;
  undoMs?: number;
}

/** Undo's line: "Dismissed “Post the photo…”", or "Dismissed 3 jobs". */
export function undoText(batch: readonly Dismissal[]): string {
  if (batch.length !== 1) return `Dismissed ${batch.length} jobs`;
  const t = batch[0]!.title;
  return `Dismissed “${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}”`;
}

/** One batch waits for its Undo time at a time: a new dismissal commits the one before. */
export class Dismisser {
  private batch: Dismissal[] = [];
  /** Batches being committed: still shown as dismissed until their commit is done (and the state says so). */
  private committing = new Set<readonly Dismissal[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: DismisserDeps) {}

  dismiss(batch: readonly Dismissal[]): void {
    if (!batch.length) return;
    void this.flush();
    this.batch = [...batch];
    this.timer = setTimeout(() => void this.flush(), this.deps.undoMs ?? UNDO_MS);
    this.deps.onPending(this.pending());
    this.deps.offerUndo(this.batch);
  }

  /** Takes the waiting batch back. */
  undo(): void {
    if (!this.batch.length) return;
    this.stop();
    this.batch = [];
    this.deps.onPending(this.pending());
    this.deps.offerUndo(null);
  }

  /** Commits the waiting batch now. */
  async flush(): Promise<void> {
    if (!this.batch.length) return;
    const batch = this.batch;
    this.stop();
    this.batch = [];
    this.committing.add(batch);
    this.deps.offerUndo(null);
    try {
      await this.deps.commit(batch);
    } finally {
      this.committing.delete(batch);
      this.deps.onPending(this.pending());
    }
  }

  private pending(): Record<string, JobDismissal> {
    return Object.fromEntries([...this.committing, this.batch].flat().map((d) => [d.key, d.entry]));
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
