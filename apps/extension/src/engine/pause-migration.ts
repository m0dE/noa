/**
 * Scheduled runs used to have one switch for all of them ("Pause scheduled runs", the `paused` setting). It is gone:
 * each job is paused on its own. A browser that had the switch on must not start anything it kept from running, so
 * the first start after the update pauses every waiting job instead ("Paused by you"): this browser's tasks, and the
 * signed-in account's. Afterwards nothing global remains.
 *
 * This browser's tasks are paused at once. The account's may fail (offline, a server without POST
 * /v1/tasks/:id/pause, a plan without the TODO list): until they are paused the due loop claims none of the account's
 * tasks (accountQueueHold), the side panel says why with Retry, and every scheduled check tries again.
 */
import { errorMessage, PAUSED_BY_USER, type LocalTask } from "@noa/shared";
import type { StorageLike } from "./kv.js";

/** Where the conversion waits while the account's jobs are not paused yet (the old switch is gone from the settings). */
export const PAUSE_MIGRATION_KEY = "pauseMigration";
const SETTINGS_KEY = "settings";

interface Pending {
  /** Why the account's jobs could not be paused yet ("" before the first try). */
  error: string;
}

/** The TODO list the conversion pauses jobs in (todo-source.ts). */
export interface PausableList {
  list(): Promise<{ tasks: LocalTask[]; locked: boolean }>;
  pause(id: string, reason?: string): Promise<LocalTask>;
}

export interface PauseMigrationDeps {
  storage(): StorageLike;
  /** This browser's tasks. */
  local: PausableList;
  /** The signed-in account's TODO list; null when signed out (nothing of the account runs here then). */
  account(): Promise<PausableList | null>;
  log(message: string): void;
  /** The side panel shows the change. */
  changed(): void;
}

/** A job that would run by itself: waiting for its time, or paused for a while and coming back on its own. */
const waiting = (t: LocalTask) => t.status === "pending" || (t.status === "paused" && !!t.retryAfter);

export class PauseMigration {
  private running: Promise<void> | null = null;

  constructor(private readonly deps: PauseMigrationDeps) {}

  /**
   * At every service worker start: the old switch, when on, becomes a conversion (and leaves the settings); a
   * conversion still waiting is tried again.
   */
  async start(): Promise<void> {
    const storage = this.deps.storage();
    const raw = (await storage.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (raw && typeof raw === "object" && "paused" in raw) {
      const { paused, ...rest } = raw as Record<string, unknown>;
      // Recorded before the switch leaves the settings: a crash between the two cannot let anything run.
      if (paused === true) await storage.set({ [PAUSE_MIGRATION_KEY]: { error: "" } satisfies Pending });
      await storage.set({ [SETTINGS_KEY]: rest });
      if (paused === true) {
        const held = await this.pauseAll(this.deps.local);
        this.deps.log(`the old pause of every scheduled run: ${held} of this browser's jobs paused`);
      }
    }
    await this.retry();
  }

  /** Why the account's tasks are not claimed now (the account's jobs are not paused yet), or null. */
  async pending(): Promise<string | null> {
    const got = (await this.deps.storage().get(PAUSE_MIGRATION_KEY))[PAUSE_MIGRATION_KEY] as Pending | undefined;
    if (!got) return null;
    return got.error || "Pausing your scheduled jobs one by one";
  }

  /** Pauses the account's waiting jobs if that is still to do; once done, nothing of the old switch is left. */
  retry(): Promise<void> {
    this.running ??= this.convertAccount().finally(() => (this.running = null));
    return this.running;
  }

  private async convertAccount(): Promise<void> {
    const storage = this.deps.storage();
    if (!(await storage.get(PAUSE_MIGRATION_KEY))[PAUSE_MIGRATION_KEY]) return;
    try {
      const account = await this.deps.account();
      const held = account ? await this.pauseAll(account) : 0;
      await storage.set({ [PAUSE_MIGRATION_KEY]: null });
      this.deps.log(`the old pause of every scheduled run: ${held} of the account's jobs paused; done`);
    } catch (err) {
      await storage.set({ [PAUSE_MIGRATION_KEY]: { error: errorMessage(err) } satisfies Pending });
      this.deps.log(`pausing the account's jobs failed (tried again at the next check): ${errorMessage(err)}`);
    }
    this.deps.changed();
  }

  /** Pauses every waiting job of a list; how many. A locked list refuses writes: that is an error (tried again). */
  private async pauseAll(list: PausableList): Promise<number> {
    const { tasks, locked } = await list.list();
    const todo = tasks.filter(waiting);
    if (locked && todo.length) throw new Error("The TODO list needs a paid plan to pause its jobs");
    for (const t of todo) await list.pause(t.id, PAUSED_BY_USER);
    return todo.length;
  }
}
