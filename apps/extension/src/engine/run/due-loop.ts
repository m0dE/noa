/**
 * The due loop: starts due tasks (local first, then the account's claims) while there
 * is room, with the random pause between starts, until nothing more is due.
 * An alarm that fires while it runs makes it look again once it ends.
 *
 * It starts nothing on the hosted AI while the account is out of usage credit, and claims none of the account's
 * tasks while accountQueueHold says why not (the side panel shows either): account-wide conditions are not pauses of
 * the jobs, which run again once they are gone.
 */
import { errorMessage, isXTask, OUT_OF_CREDIT, pickDelayMs, type ExtensionSettings, type Sleep } from "@noa/shared";
import type { BrainStatus } from "../../ui-protocol.js";
import { NO_AI } from "../brain-resolver.js";
import type { Brain } from "../brains.js";
import type { LocalStore } from "../local-store.js";
import type { ActiveSessions } from "./active.js";
import type { FailurePolicy, ScheduledJob } from "./failure-policy.js";
import { dueLocal, type FirstJob, type RunnerApi } from "./jobs.js";
import type { Lifecycle, RunBrain } from "./lifecycle.js";
import { Pacer, scheduledCap } from "./scheduling.js";
import type { RunnerStateStore } from "./state.js";

export interface DueLoopDeps {
  live: ActiveSessions;
  lifecycle: Lifecycle;
  policy: FailurePolicy;
  state: RunnerStateStore;
  localStore: LocalStore;
  loadSettings(): Promise<ExtensionSettings>;
  getRunnerId(): Promise<string>;
  accountApi?(): Promise<RunnerApi | null>;
  /** Why the account's tasks are not claimed now (RunnerDeps.accountQueueHold); null: they are. */
  accountQueueHold?(): Promise<string | null>;
  /** The hosted AI has no usage credit left. */
  outOfCredit?(): boolean;
  resolveBrain(settings: ExtensionSettings): Promise<{ brain: Brain | null; status: BrainStatus }>;
  notify(title: string, message: string): void | Promise<void>;
  sleep?: Sleep;
  now(): Date;
  newId(): string;
  log(message: string): void;
  changed(): void;
  /** Keeps the service worker alive; each hold() is given back by drop(), or by the job passed to track(). */
  hold(): void;
  drop(): void;
  /** A job in flight (the runner's idle() waits for it); drops a hold when it settles. */
  track<T>(job: Promise<T>): Promise<T | void>;
}

export class DueLoop {
  private running: Promise<void> | null = null;
  private stopRequested = false;
  /** An alarm fired while the loop ran: look again once it ends. */
  private alarmMissed = false;
  private readonly pacer: Pacer;

  constructor(private readonly deps: DueLoopDeps) {
    this.pacer = new Pacer(deps.sleep);
  }

  /** The loop's current run, if any. */
  get current(): Promise<void> | null {
    return this.running;
  }

  /** Starts the loop unless it runs already. Returns at once. */
  async start(trigger: "alarm" | "manual"): Promise<{ started: boolean; detail?: string }> {
    if (this.running) {
      if (trigger === "alarm") this.alarmMissed = true;
      return { started: false, detail: "A task is already running" };
    }
    this.deps.hold();
    let settings: ExtensionSettings;
    try {
      settings = await this.deps.loadSettings();
    } catch (err) {
      this.deps.drop();
      return { started: false, detail: errorMessage(err) };
    }
    if (this.running) {
      this.deps.drop();
      return { started: false, detail: "A task is already running" };
    }
    this.stopRequested = false;
    this.running = this.untilCaughtUp(settings).finally(() => {
      this.running = null;
      this.deps.drop();
    });
    return { started: true };
  }

  /** Stop: no more starts in this run, the pause between starts ends, a missed alarm is dropped. */
  stop(): void {
    this.stopRequested = true;
    this.alarmMissed = false;
    this.pacer.interrupt();
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  /** Runs the loop, again for as long as alarms fired during it (settings reloaded). */
  private async untilCaughtUp(initial: ExtensionSettings): Promise<void> {
    let settings = initial;
    for (;;) {
      await this.loop(settings);
      if (!this.alarmMissed || this.stopRequested) return;
      this.alarmMissed = false;
      try {
        settings = await this.deps.loadSettings();
      } catch (err) {
        this.deps.log(`due check after a missed alarm skipped: ${errorMessage(err)}`);
        return;
      }
    }
  }

  /** Starts due tasks while there is room, pacing between starts. */
  private async loop(initial: ExtensionSettings): Promise<void> {
    const { live, state } = this.deps;
    let settings = initial;
    await state.patch({ lastRunAt: this.deps.now().toISOString(), lastError: undefined });
    this.deps.changed();
    const scheduled = new Set<Promise<unknown>>();
    let halted = false;
    let started = 0;
    let paced = false;
    let cloudEmpty = false;
    try {
      await this.deps.localStore.recoverCrashed(settings.maxTaskMinutes, live.localRunning);
      const runnerId = await this.deps.getRunnerId();
      for (;;) {
        if (this.stopRequested || halted) break;
        if (started) settings = await this.deps.loadSettings();
        const held = await this.deps.accountQueueHold?.().catch(() => null);
        const accountApi = held ? null : ((await this.deps.accountApi?.().catch(() => null)) ?? null);
        // Held or signed out, the account's queue is not claimed.
        const cloudOn = !!accountApi;
        const { startable, blocked } = await dueLocal(this.deps.localStore, this.deps.now(), live.localRunning, !live.xTurn.free);
        const cloudReady = cloudOn && !cloudEmpty && live.xTurn.free;
        if (!startable.length && !cloudReady) {
          // Due tasks wait for the X task running beside the loop (a one-off run) to finish.
          const waitFor = scheduled.size > 0 || (blocked > 0 && live.size > 0) || (cloudOn && !cloudEmpty && !live.xTurn.free);
          if (!waitFor) break;
          await live.ended.wait();
          continue;
        }
        if (scheduled.size >= scheduledCap(settings, live.slots.count) || live.slots.free() === null) {
          await live.ended.wait();
          continue;
        }

        const brain = await this.brainFor(settings);
        if (!brain) break;

        // The random pause goes between task starts; then look again (things change while it waits).
        if (started > 0 && !paced) {
          if (!this.stopRequested) await this.pacer.pause(pickDelayMs(settings));
          paced = true;
          continue;
        }

        let job: FirstJob | null = null;
        if (startable[0]) job = { source: "local", task: startable[0] };
        else if (accountApi) {
          try {
            const claim = await accountApi.claim(runnerId);
            if (claim) job = { source: "cloud", claim, api: accountApi, runnerId };
            else cloudEmpty = true;
          } catch (err) {
            await state.patch({ lastError: `Account claim failed: ${errorMessage(err)}` });
            cloudEmpty = true;
          }
        }
        if (!job) continue;
        // A claimed cloud task goes back to the queue on its own when its lease runs out.
        if (this.stopRequested) break;

        const sessionId = this.deps.newId();
        const slotIndex = live.slots.reserve(sessionId);
        if (slotIndex === null) continue;
        const task = job.source === "local" ? job.task : job.claim.task;
        // Taken now, so the next pick sees it (a cloud X task claimed meanwhile waits in its run).
        if (isXTask(task)) live.xTurn.tryTake(sessionId);
        if (job.source === "local") live.localRunning.add(job.task.id);
        started++;
        paced = false;
        this.deps.hold();
        const source = job.source;
        const scheduledJob: ScheduledJob = { source, seriesId: task.seriesId ?? task.id, title: titleOf(task) };
        const tracked: Promise<unknown> = this.deps
          .track(
            this.deps.lifecycle
              .runFirst(job, brain, settings, sessionId, { slotIndex, scheduled: true })
              .then((ended) => this.deps.policy.afterScheduled(ended, settings, scheduledJob))
              .then((halt) => {
                if (halt) halted = true;
              })
              .catch((err) => this.deps.log(`${source} run failed: ${errorMessage(err)}`)),
          )
          .finally(() => {
            scheduled.delete(tracked);
            live.ended.notify();
          });
        scheduled.add(tracked);
      }
      while (scheduled.size) await Promise.allSettled([...scheduled]);
    } catch (err) {
      await state.patch({ lastError: errorMessage(err) });
      this.deps.log(`run failed: ${errorMessage(err)}`);
      while (scheduled.size) await Promise.allSettled([...scheduled]);
    }
  }

  /** The brain to run due tasks with; without one, the user is told why (once per reason). */
  private async brainFor(settings: ExtensionSettings): Promise<RunBrain | null> {
    const { state } = this.deps;
    const resolved = await this.deps.resolveBrain(settings);
    const { status } = resolved;
    // Out of credit on the hosted AI: every run would stop at its first step, so none starts until the user tops up.
    const noCredit = status.effective === "noa" && !!this.deps.outOfCredit?.();
    const brain = noCredit ? null : resolved.brain;
    if (!brain) {
      const note = noCredit ? OUT_OF_CREDIT : (status.note ?? NO_AI);
      const st = await state.get();
      await state.patch({ lastError: note, noBrainNotified: note });
      if (st.noBrainNotified !== note) await this.deps.notify("Cannot run tasks", note);
      return null;
    }
    if ((await state.get()).noBrainNotified) await state.patch({ noBrainNotified: undefined });
    return { brain, status };
  }
}

/** A task's first line, for a notification. */
function titleOf(task: { instructions: string }): string {
  const line = (task.instructions.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "A scheduled job";
}
