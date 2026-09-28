/**
 * What a scheduled run's end means: a job whose runs fail maxConsecutiveFailures times in a row is paused on its
 * own (the rest of its repeats wait until the user resumes it, and its reason shows on the job); the other jobs go on.
 * A run that paused (it needs the user) is told about and ends the due run.
 *
 * Account-wide conditions (out of usage credit, a plan without the TODO list) never count here: the due loop does not
 * start runs while they hold, and the side panel shows them once (header.ts).
 */
import { errorMessage, failureHoldReason, type ExtensionSettings } from "@noa/shared";
import type { Ended } from "./lifecycle.js";
import type { RunnerStateStore } from "./state.js";

/** The job a scheduled run belongs to. */
export interface ScheduledJob {
  source: "local" | "cloud";
  /** Its task's series (a repeating task's runs share it; a one-off task: its own id). */
  seriesId: string;
  /** Its first line, for the notification. */
  title: string;
}

export interface FailurePolicyDeps {
  state: RunnerStateStore;
  notify(title: string, message: string): void | Promise<void>;
  /** The user asked the due loop to stop. */
  stopping(): boolean;
  /** Pauses the series' waiting run (TodoSource.holdSeries) with this reason; false: nothing of it waits. Throws when it could not. */
  holdSeries(source: ScheduledJob["source"], seriesId: string, reason: string): Promise<boolean>;
  log(message: string): void;
}

export class FailurePolicy {
  /** Serializes the bookkeeping of parallel jobs. */
  private accounting: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FailurePolicyDeps) {}

  /** After a scheduled run. True: start no more tasks in this due run. */
  afterScheduled({ result, stop }: Ended, settings: ExtensionSettings, job: ScheduledJob): Promise<boolean> {
    const next = this.accounting.then(async () => {
      if (result.outcome === "done") await this.setFailures(job.seriesId, 0);
      else if (result.outcome === "failed" || result.outcome === "retry") await this.failed(job, result.reason ?? result.outcome, settings.maxConsecutiveFailures);
      // The user stopped it: nothing to tell them, and the other tasks go on.
      if (stop?.kind === "user-stop") return this.deps.stopping();
      if (result.outcome === "paused") {
        if (!this.deps.stopping()) await this.deps.notify("Task paused", result.reason ?? "The task needs your attention.");
        return true;
      }
      return false;
    });
    this.accounting = next.catch(() => {});
    return next;
  }

  /**
   * After a next turn of a scheduled run's conversation (the user went on in it): once it got the work done, the
   * job's failures in a row start over. Its failures do not count here (the user is there to see them).
   */
  afterTurn({ result, stop }: Ended, seriesId: string | undefined): Promise<void> {
    if (!seriesId || result.outcome !== "done" || stop) return Promise.resolve();
    const next = this.accounting.then(async () => {
      if ((await this.deps.state.get()).failures?.[seriesId]) await this.setFailures(seriesId, 0);
    });
    this.accounting = next.catch(() => {});
    return next;
  }

  /** One more failure in a row for the job; at `max` (0: never) the job is paused with the reason. */
  private async failed(job: ScheduledJob, last: string, max: number): Promise<void> {
    const n = ((await this.deps.state.get()).failures?.[job.seriesId] ?? 0) + 1;
    if (max <= 0 || n < max) return this.setFailures(job.seriesId, n);
    const reason = failureHoldReason(n, last);
    try {
      const held = await this.deps.holdSeries(job.source, job.seriesId, reason);
      await this.setFailures(job.seriesId, 0);
      if (held) await this.deps.notify(`Paused: ${job.title}`, reason);
    } catch (err) {
      // Not paused: its count stays, so the next failure tries again.
      await this.setFailures(job.seriesId, n);
      this.deps.log(`pausing job ${job.seriesId} failed: ${errorMessage(err)}`);
      await this.deps.notify(`Failing: ${job.title}`, `${n} runs failed in a row and it could not be paused (${errorMessage(err)}). Last: ${last}`);
    }
  }

  private async setFailures(seriesId: string, n: number): Promise<void> {
    const failures = { ...(await this.deps.state.get()).failures };
    if (n > 0) failures[seriesId] = n;
    else delete failures[seriesId];
    await this.deps.state.patch({ failures: Object.keys(failures).length ? failures : undefined });
  }
}
