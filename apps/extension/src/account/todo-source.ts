/**
 * Where the TODO list's tasks live: the signed-in account (the API), or this
 * browser (the local store, used when signed out). Both answer with the
 * same row shape, so the tab's UI does not change.
 *
 * The account's list is a paid feature: on a plan without it the list comes
 * back `locked` (the kept tasks are read-only; writes answer plan_required).
 */
import { isFailureHold, isOnHold, LegacyRepeatRule, legacyToRepeat, type CreateTaskInput, type LocalTask, type RepeatSchedule, type Task } from "@noa/shared";
import type { LocalMediaInfo, TaskPatch } from "../ui-protocol.js";
import { uploadToBlob, type LocalStore, type NewLocalTask } from "../engine/local-store.js";
import type { AccountApi, AccountTaskList } from "./account-api.js";

export type TodoRow = LocalTask & { media: LocalMediaInfo[] };

/** The list and whether it is locked (the plan does not include the TODO list: read-only until the user subscribes). */
export interface TodoList {
  tasks: TodoRow[];
  locked: boolean;
}

/** A repeat rule as the account takes it: an old { dailyAt } rule runs in timeZone. */
function accountRepeat(repeat: RepeatSchedule | LegacyRepeatRule | null | undefined, timeZone: string): RepeatSchedule | null {
  if (!repeat) return null;
  const legacy = LegacyRepeatRule.safeParse(repeat);
  return legacy.success ? legacyToRepeat(legacy.data, timeZone) : (repeat as RepeatSchedule);
}

/**
 * A task for the account from a local task's fields (a new one, or one
 * moving in): its files are uploaded first. An old { dailyAt } repeat runs
 * in timeZone; a current rule carries its own zone.
 */
export async function accountTaskInput(
  api: Pick<AccountApi, "uploadMedia">,
  t: { instructions: string; account?: string | null; notBefore?: string | null; repeat?: RepeatSchedule | LegacyRepeatRule | null; agentAuthored?: boolean },
  files: { name: string; blob: Blob }[],
  timeZone: string,
): Promise<CreateTaskInput> {
  const mediaIds: string[] = [];
  for (const f of files) mediaIds.push((await api.uploadMedia(f.blob, f.name)).id);
  const account = t.account?.trim();
  const repeat = accountRepeat(t.repeat, timeZone);
  return {
    instructions: t.instructions,
    ...(account ? { account } : {}),
    ...(mediaIds.length ? { mediaIds } : {}),
    ...(t.notBefore || repeat ? { schedule: { ...(t.notBefore ? { at: t.notBefore } : {}), ...(repeat ? { repeat } : {}) } } : {}),
    ...(t.agentAuthored ? { agentAuthored: true } : {}),
  };
}

export interface TodoSource {
  readonly kind: "local" | "account";
  list(): Promise<TodoList>;
  add(input: NewLocalTask): Promise<LocalTask>;
  update(id: string, patch: TaskPatch): Promise<LocalTask>;
  delete(id: string): Promise<boolean>;
  retry(id: string): Promise<LocalTask>;
  cancel(id: string): Promise<LocalTask>;
  /** Keeps a waiting task from running until resume() (reason: what it shows; default "Paused by you"). */
  pause(id: string, reason?: string): Promise<LocalTask>;
  /** A paused task waits for its time again. */
  resume(id: string): Promise<LocalTask>;
  /** Pauses the waiting row of a series (see LocalStore.holdSeries); null: none waits. */
  holdSeries(seriesId: string, reason: string): Promise<LocalTask | null>;
  /** Resumes the series' rows paused after its runs kept failing, except `except` (see LocalStore.releaseHold); the ids resumed. */
  releaseHold(seriesId: string, except?: string): Promise<string[]>;
  /** A page of one series' rows (a repeating job's runs), newest first; `cursor`: the page after the one that gave it. */
  seriesPage(seriesId: string, cursor?: string): Promise<SeriesPage>;
}

/** A page of a series' rows; nextCursor null: the last page. */
export interface SeriesPage {
  tasks: LocalTask[];
  nextCursor: string | null;
}

/** An account task in the TODO row shape. Files are known by id only (the list does not carry their names). */
export function accountRow(t: Task): TodoRow {
  return { ...asLocal(t), media: t.mediaIds.map((id, i) => ({ id, name: `file ${i + 1}`, type: "", size: 0 })) };
}

/** An account task in the row shape: its repeat rule at the top (notBefore is its schedule's `at`). */
function asLocal(t: Task): LocalTask {
  const { schedule, ...rest } = t;
  return { ...rest, repeat: schedule?.repeat ?? null };
}

/** The signed-in account's tasks. An old { dailyAt } repeat given to it runs in the browser's IANA time zone. */
export class AccountTodo implements TodoSource {
  readonly kind = "account" as const;

  /** onChange: the list as just fetched, or nothing after a change made here. */
  constructor(
    private readonly api: AccountApi,
    private readonly timeZone: string,
    private readonly onChange: (listed?: AccountTaskList) => void = () => {},
  ) {}

  async list(): Promise<TodoList> {
    const listed = await this.api.listTasks();
    this.onChange(listed);
    return { tasks: listed.tasks.map(accountRow), locked: listed.locked };
  }

  async add(input: NewLocalTask): Promise<LocalTask> {
    const files = (input.media ?? []).map((m) => ({ name: m.name, blob: uploadToBlob(m) }));
    const task = await this.api.createTask(await accountTaskInput(this.api, input, files, this.timeZone));
    this.onChange();
    return asLocal(task);
  }

  async update(id: string, patch: TaskPatch): Promise<LocalTask> {
    const body: Record<string, unknown> = {};
    if (patch.instructions !== undefined) body.instructions = patch.instructions;
    // null (or an empty account) clears it on the server.
    if (patch.account !== undefined) body.account = patch.account?.trim() || null;
    // A new repeat rule replaces the whole schedule (with the first time given beside it); a time alone moves just the time.
    if (patch.repeat !== undefined) body.schedule = { at: patch.notBefore ?? null, repeat: accountRepeat(patch.repeat, this.timeZone) };
    else if (patch.notBefore !== undefined) body.notBefore = patch.notBefore ?? null;
    if (patch.agentAuthored !== undefined) body.agentAuthored = patch.agentAuthored;
    const task = await this.api.updateTask(id, body);
    this.onChange();
    return asLocal(task);
  }

  async delete(id: string): Promise<boolean> {
    await this.api.deleteTask(id);
    this.onChange();
    return true;
  }

  async retry(id: string): Promise<LocalTask> {
    const task = await this.api.retryTask(id);
    this.onChange();
    return asLocal(task);
  }

  async cancel(id: string): Promise<LocalTask> {
    const task = await this.api.cancelTask(id);
    this.onChange();
    return asLocal(task);
  }

  async pause(id: string, reason?: string): Promise<LocalTask> {
    const task = await this.api.pauseTask(id, reason);
    this.onChange();
    return asLocal(task);
  }

  async resume(id: string): Promise<LocalTask> {
    const task = await this.api.resumeTask(id);
    this.onChange();
    return asLocal(task);
  }

  async holdSeries(seriesId: string, reason: string): Promise<LocalTask | null> {
    // Newest first: the series' waiting row is its newest pending (or paused for a while) one.
    const waiting = (await this.api.listSeries(seriesId)).find((t) => t.status === "pending" || (t.status === "paused" && !isOnHold(t)));
    return waiting ? this.pause(waiting.id, reason) : null;
  }

  async releaseHold(seriesId: string, except?: string): Promise<string[]> {
    const held = (await this.api.listSeries(seriesId)).filter((t) => t.id !== except && isFailureHold(t));
    for (const t of held) await this.resume(t.id);
    return held.map((t) => t.id);
  }

  async seriesPage(seriesId: string, cursor?: string): Promise<SeriesPage> {
    const page = await this.api.seriesPage(seriesId, cursor);
    return { tasks: page.tasks.map(asLocal), nextCursor: page.nextCursor };
  }
}

/**
 * This browser's tasks (signed out). The TODO tools do not use them (signed
 * out it is one Log in button, so none can be added there): they are the
 * engine's local queue, tasks kept from before the list moved into the
 * account. They run here and use no cloud storage; moving them into the
 * account is offered only on a plan with the TODO list.
 */
export class LocalTodo implements TodoSource {
  readonly kind = "local" as const;

  constructor(private readonly store: LocalStore) {}

  async list(): Promise<TodoList> {
    return { tasks: await this.store.listWithMedia(), locked: false };
  }

  add(input: NewLocalTask): Promise<LocalTask> {
    return this.store.add(input);
  }

  update(id: string, patch: TaskPatch): Promise<LocalTask> {
    return this.store.update(id, patch);
  }

  delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  retry(id: string): Promise<LocalTask> {
    return this.store.retry(id);
  }

  async cancel(): Promise<LocalTask> {
    // Local tasks have no cancelled state of their own: deleting is the way to drop one.
    throw new Error("Local tasks cannot be cancelled; delete it instead");
  }

  pause(id: string, reason?: string): Promise<LocalTask> {
    return this.store.pause(id, reason);
  }

  resume(id: string): Promise<LocalTask> {
    return this.store.resume(id);
  }

  holdSeries(seriesId: string, reason: string): Promise<LocalTask | null> {
    return this.store.holdSeries(seriesId, reason);
  }

  releaseHold(seriesId: string, except?: string): Promise<string[]> {
    return this.store.releaseHold(seriesId, except);
  }

  /** This browser keeps every row of a series: one page. */
  async seriesPage(seriesId: string): Promise<SeriesPage> {
    const rows = (await this.store.list()).filter((t) => (t.seriesId ?? t.id) === seriesId);
    return { tasks: rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)), nextCursor: null };
  }
}
