/**
 * Local todo list: LocalTask records in chrome.storage.local, media blobs in
 * IndexedDB. Works with no cloud at all. The rules (input checks, repeats,
 * how a run changes a task) are in local-task-rules.ts.
 */
import { isDueNow, isOnHold, MAX_MEDIA_PER_TASK, PAUSED_BY_USER, resumedNotBefore, settleSchedule, type RepeatSchedule, type TaskRunResult } from "@noa/shared";
import { base64ToBytes } from "../base64.js";
import { Listeners } from "../listeners.js";
import type { LocalMediaInfo, TaskPatch, UiMediaUpload } from "../ui-protocol.js";
import type { KvDb, KvStore, StorageLike } from "./kv.js";
import { crashAfterMs } from "./run/deadline.js";
import {
  afterCrash,
  afterRun,
  byCreated,
  cleanAccount,
  cleanInstructions,
  cleanRepeat,
  cleanTime,
  migrateStoredTask,
  nextOccurrenceTask,
  withSeries,
  type StoredLocalTask,
} from "./local-task-rules.js";

export const LOCAL_TASKS_KEY = "localTasks";

export interface MediaRecord {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

export interface NewLocalTask {
  instructions: string;
  account?: string | null;
  notBefore?: string | null;
  /** The current shape, or the old { dailyAt } (converted, in this browser's zone). */
  repeat?: RepeatSchedule | { dailyAt: string[] } | null;
  media?: UiMediaUpload[];
  /** The agent wrote it (schedule_task): Task.agentAuthored. */
  agentAuthored?: boolean;
}

export interface LocalStoreOptions {
  db: KvDb;
  now?: () => Date;
  newId?: () => string;
  /** Default chrome.storage.local (looked up lazily). */
  storage?: StorageLike;
}

export function uploadToBlob(m: UiMediaUpload): Blob {
  return new Blob([base64ToBytes(m.dataBase64)], { type: m.type || "application/octet-stream" });
}

export class LocalStore {
  private readonly media: KvStore<MediaRecord>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly changes = new Listeners();

  constructor(private readonly opts: LocalStoreOptions) {
    this.media = opts.db.store<MediaRecord>("media");
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  /** Called after every change to the task list. */
  onChange(fn: () => void): () => void {
    return this.changes.add(fn);
  }

  async list(): Promise<StoredLocalTask[]> {
    return this.read();
  }

  async get(id: string): Promise<StoredLocalTask | null> {
    return (await this.read()).find((t) => t.id === id) ?? null;
  }

  /** Tasks for the UI: newest first, each with its media metadata. */
  async listWithMedia(): Promise<(StoredLocalTask & { media: LocalMediaInfo[] })[]> {
    const tasks = await this.read();
    const infos = new Map<string, LocalMediaInfo>();
    for (const { value } of await this.media.list()) infos.set(value.id, { id: value.id, name: value.name, type: value.type, size: value.size });
    return tasks
      .slice()
      .sort((a, b) => byCreated(b, a))
      .map((t) => ({ ...t, media: t.mediaIds.map((id) => infos.get(id)).filter((m): m is LocalMediaInfo => !!m) }));
  }

  async add(input: NewLocalTask): Promise<StoredLocalTask> {
    const instructions = cleanInstructions(input.instructions);
    const account = cleanAccount(input.account);
    const { notBefore, repeat } = settleSchedule(cleanTime(input.notBefore), cleanRepeat(input.repeat), this.now());
    const uploads = input.media ?? [];
    if (uploads.length > MAX_MEDIA_PER_TASK) throw new Error(`At most ${MAX_MEDIA_PER_TASK} files per task`);
    const mediaIds = await this.putMedia(uploads);
    const now = this.now().toISOString();
    const id = this.newId();
    const task: StoredLocalTask = {
      id,
      // A new task starts its own series; its repeats carry it.
      seriesId: id,
      instructions,
      account,
      mediaIds,
      notBefore,
      priority: 0,
      status: "pending",
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAfter: null,
      resultSummary: null,
      resultUrl: null,
      resultScreenshotId: null,
      pauseReason: null,
      failReason: null,
      createdAt: now,
      updatedAt: now,
      repeat,
      ...(input.agentAuthored ? { agentAuthored: true } : {}),
    };
    await this.mutate((tasks) => ({ tasks: [...tasks, task], result: undefined }));
    return task;
  }

  /** Stores uploaded files; returns their ids. */
  async putMedia(uploads: UiMediaUpload[]): Promise<string[]> {
    const ids: string[] = [];
    for (const m of uploads) {
      const blob = uploadToBlob(m);
      const id = this.newId();
      await this.media.put(id, { id, name: m.name || "file", type: blob.type, size: blob.size, blob });
      ids.push(id);
    }
    return ids;
  }

  async getMedia(ids: string[]): Promise<MediaRecord[]> {
    const out: MediaRecord[] = [];
    for (const id of ids) {
      const rec = await this.media.get(id);
      if (!rec) throw new Error(`Attached file ${id} is missing from extension storage`);
      out.push(rec);
    }
    return out;
  }

  /** Edits a task that is not running. */
  async update(id: string, patch: TaskPatch): Promise<StoredLocalTask> {
    const clean: Partial<StoredLocalTask> = {};
    if (patch.instructions !== undefined) clean.instructions = cleanInstructions(patch.instructions);
    if (patch.account !== undefined) clean.account = cleanAccount(patch.account);
    const at = patch.notBefore === undefined ? undefined : cleanTime(patch.notBefore);
    const repeat = patch.repeat === undefined ? undefined : cleanRepeat(patch.repeat);
    return this.updateOne(id, (t) => {
      if (t.status === "running") throw new Error("The task is running; stop it first");
      // A schedule change is settled like a new task's (a rule without a first time runs at its next time).
      const schedule =
        at === undefined && repeat === undefined ? {} : settleSchedule(at === undefined ? t.notBefore : at, repeat === undefined ? t.repeat : repeat, this.now());
      // Who wrote the instructions (TaskPatch.agentAuthored): as said, or the user when they change without a word on it.
      const authored = patch.agentAuthored ?? (clean.instructions !== undefined && clean.instructions !== t.instructions ? false : t.agentAuthored);
      return { ...t, ...clean, ...schedule, ...(authored === undefined ? {} : { agentAuthored: authored }), updatedAt: this.now().toISOString() };
    });
  }

  /** Deletes a task and the media no other task uses. */
  async delete(id: string): Promise<boolean> {
    const { gone, rest } = await this.mutate((tasks) => {
      const found = tasks.find((t) => t.id === id);
      if (found?.status === "running") throw new Error("The task is running; stop it first");
      const kept = tasks.filter((t) => t.id !== id);
      return { tasks: kept, result: { gone: found, rest: kept } };
    });
    if (!gone) return false;
    const inUse = new Set(rest.flatMap((t) => t.mediaIds));
    for (const mid of gone.mediaIds) if (!inUse.has(mid)) await this.media.delete(mid);
    return true;
  }

  /** Puts a failed, paused or finished task back in the queue to run now. */
  async retry(id: string): Promise<StoredLocalTask> {
    return this.updateOne(id, (t) => {
      if (t.status === "running") throw new Error("The task is already running");
      return {
        ...t,
        status: "pending",
        attempts: 0,
        // A task that already ran may have acted (e.g. posted) before it stopped;
        // the next run then checks for that before repeating it.
        crashed: t.attempts > 0 && t.status !== "done",
        notBefore: null,
        retryAfter: null,
        pauseReason: null,
        failReason: null,
        updatedAt: this.now().toISOString(),
      };
    });
  }

  /** Keeps a waiting task (pending, or paused for the user) from running until resume(); reason: what it shows. */
  async pause(id: string, reason = PAUSED_BY_USER): Promise<StoredLocalTask> {
    return this.updateOne(id, (t) => {
      if (t.status !== "pending" && t.status !== "paused") throw new Error(`The task is ${t.status}: only a waiting task can be paused`);
      return { ...t, status: "paused", pauseReason: reason, retryAfter: null, updatedAt: this.now().toISOString() };
    });
  }

  /** A paused task waits for its time again (a repeating one whose time went by: its rule's next time). */
  async resume(id: string): Promise<StoredLocalTask> {
    return this.updateOne(id, (t) => {
      if (t.status !== "paused") throw new Error(`The task is ${t.status}: only a paused task can be resumed`);
      const notBefore = resumedNotBefore(t.notBefore, t.repeat, this.now());
      return { ...t, status: "pending", notBefore, pauseReason: null, retryAfter: null, updatedAt: this.now().toISOString() };
    });
  }

  /**
   * Pauses the waiting row of a series (its next run, or its retry), so none of its runs start until the user
   * resumes it. Returns that row, or null when the series has none waiting (or it is on hold already).
   */
  async holdSeries(seriesId: string, reason: string): Promise<StoredLocalTask | null> {
    const waiting = (await this.read())
      .filter((t) => (t.seriesId ?? t.id) === seriesId && (t.status === "pending" || (t.status === "paused" && !isOnHold(t))))
      .sort((a, b) => byCreated(b, a))[0];
    return waiting ? this.pause(waiting.id, reason) : null;
  }

  /** Pending tasks whose notBefore and retryAfter have passed (isDueNow), oldest first. */
  async due(now = this.now()): Promise<StoredLocalTask[]> {
    return (await this.read()).filter((x) => isDueNow(x, now.getTime())).sort(byCreated);
  }

  /** Earliest future time a pending task becomes due, or null. */
  async nextWakeAt(now = this.now()): Promise<Date | null> {
    let best: number | null = null;
    for (const x of await this.read()) {
      if (x.status !== "pending") continue;
      const at = Math.max(x.notBefore ? Date.parse(x.notBefore) : 0, x.retryAfter ? Date.parse(x.retryAfter) : 0);
      if (at > now.getTime() && (best === null || at < best)) best = at;
    }
    return best === null ? null : new Date(best);
  }

  /** Crash marker: running with attempts+1, persisted before the brain starts. */
  async markStarted(id: string): Promise<StoredLocalTask> {
    return this.updateOne(id, (t) => ({ ...t, status: "running", attempts: t.attempts + 1, updatedAt: this.now().toISOString() }));
  }

  /**
   * Records how a run ended (see afterRun). A repeating task that ends done
   * or failed spawns its next occurrence once.
   */
  async finish(
    id: string,
    result: TaskRunResult,
    opts: { retryAfterMinutes: number },
  ): Promise<{ task: StoredLocalTask; next: StoredLocalTask | null }> {
    const now = this.now();
    return this.mutate((tasks) => {
      const cur = tasks.find((t) => t.id === id);
      if (!cur) throw new Error(`No task with id ${id}`);
      let task = afterRun(cur, result, now, opts.retryAfterMinutes);
      let next: StoredLocalTask | null = null;
      if ((task.status === "done" || task.status === "failed") && task.repeat && !task.nextId) {
        next = nextOccurrenceTask({ ...task, repeat: task.repeat }, this.newId(), now);
        if (next) task = { ...task, nextId: next.id };
      }
      const updated = tasks.map((t) => (t.id === id ? task : t));
      return { tasks: next ? [...updated, next] : updated, result: { task, next } };
    });
  }

  /**
   * Crash recovery: tasks left running for longer than any run can last
   * (crashAfterMs) go back to pending with the crash marker (or fail when out
   * of attempts). Tasks this worker is running (live) are left alone.
   * Returns how many were recovered.
   */
  async recoverCrashed(maxTaskMinutes: number, live: ReadonlySet<string> = new Set()): Promise<number> {
    const now = this.now();
    const cutoff = now.getTime() - crashAfterMs(maxTaskMinutes);
    return this.mutate((tasks) => {
      let count = 0;
      const next = tasks.map((t) => {
        if (t.status !== "running" || live.has(t.id) || Date.parse(t.updatedAt) > cutoff) return t;
        count++;
        return afterCrash(t, now);
      });
      return { tasks: next, result: count };
    });
  }

  private storage(): StorageLike {
    return this.opts.storage ?? chrome.storage.local;
  }

  private async read(): Promise<StoredLocalTask[]> {
    const got = await this.storage().get(LOCAL_TASKS_KEY);
    const v = got[LOCAL_TASKS_KEY];
    return Array.isArray(v) ? withSeries((v as StoredLocalTask[]).map(migrateStoredTask)) : [];
  }

  private updateOne(id: string, fn: (t: StoredLocalTask) => StoredLocalTask): Promise<StoredLocalTask> {
    return this.mutate((tasks) => {
      const cur = tasks.find((t) => t.id === id);
      if (!cur) throw new Error(`No task with id ${id}`);
      const next = fn(cur);
      return { tasks: tasks.map((t) => (t.id === id ? next : t)), result: next };
    });
  }

  /** Serialized read-modify-write: fn gives the new list and what to return; listeners hear of the change. */
  private async mutate<T>(fn: (tasks: StoredLocalTask[]) => { tasks: StoredLocalTask[]; result: T }): Promise<T> {
    const run = this.lock.then(async () => {
      const { tasks, result } = fn(await this.read());
      await this.storage().set({ [LOCAL_TASKS_KEY]: tasks });
      return result;
    });
    this.lock = run.catch(() => {});
    const result = await run;
    this.changes.emit();
    return result;
  }
}
