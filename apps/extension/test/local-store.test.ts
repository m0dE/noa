import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { MemoryKvDb } from "./memory-kv.js";
import { LOCAL_TASKS_KEY, LocalStore } from "../src/engine/local-store.js";
import { localTimeZone } from "@noa/shared";
import { cleanRepeat, MAX_LOCAL_ATTEMPTS, migrateStoredTask, nextOccurrenceTask, withSeries, type StoredLocalTask } from "../src/engine/local-task-rules.js";

/** Local wall-clock date, so the tests pass in any time zone. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const b64 = (s: string) => btoa(s);

let chrome: ChromeFake;
let now: Date;
let ids: number;
let store: LocalStore;
let db: MemoryKvDb;

beforeEach(() => {
  chrome = installChromeFake();
  now = local(2026, 9, 24, 10, 0);
  ids = 0;
  db = new MemoryKvDb();
  store = new LocalStore({ db, now: () => now, newId: () => `id${++ids}` });
});

const TZ = localTimeZone();
const daily = (hhmm: string, extra = {}) => ({ cron: `${Number(hhmm.slice(3))} ${Number(hhmm.slice(0, 2))} * * *`, tz: TZ, ...extra });

describe("local repeat rules (the shared schedule rules, in this browser's zone)", () => {
  it("cleanRepeat takes the current shape and converts the old { dailyAt }", () => {
    expect(cleanRepeat(daily("09:00"))).toEqual(daily("09:00"));
    expect(cleanRepeat({ dailyAt: ["13:30", "09:00"] })).toEqual({ cron: "0 9 * * *\n30 13 * * *", tz: TZ });
    expect(cleanRepeat(null)).toBeNull();
    expect(() => cleanRepeat({ dailyAt: ["25:00"] })).toThrow(/Repeat rule/);
    expect(() => cleanRepeat({ cron: "0 9 * *", tz: TZ })).toThrow(/has 4 fields/);
  });

  it("tasks stored before are migrated as they are read", () => {
    const old = { id: "a", repeat: { dailyAt: ["09:00"] } } as unknown as StoredLocalTask;
    expect(migrateStoredTask(old).repeat).toEqual({ cron: "0 9 * * *", tz: TZ });
    const plain = { id: "b", repeat: null } as unknown as StoredLocalTask;
    expect(migrateStoredTask(plain)).toBe(plain);
  });

  it("the next occurrence is strictly after the end of the run, and none once the rule is over", () => {
    const base = { id: "t", status: "done", attempts: 1 } as unknown as StoredLocalTask;
    const at = (repeat: object, end: Date) => nextOccurrenceTask({ ...base, repeat } as never, "n", end)?.notBefore ?? null;
    expect(at(daily("10:00"), local(2026, 9, 24, 10, 0))).toBe(local(2026, 9, 25, 10, 0).toISOString());
    expect(at({ cron: "59 23 * * *\n15 0 * * *", tz: TZ }, local(2026, 12, 31, 23, 59))).toBe(local(2027, 1, 1, 0, 15).toISOString());
    expect(at(daily("09:00", { end: "2026-09-24" }), local(2026, 9, 24, 10, 0))).toBeNull();
    expect(at(daily("09:00", { count: 1 }), local(2026, 9, 24, 10, 0))).toBeNull();
    expect(nextOccurrenceTask({ ...base, repeat: daily("09:00", { count: 3 }) } as never, "n", local(2026, 9, 24, 10, 0))!.repeat).toEqual(daily("09:00", { count: 2 }));
  });
});

describe("LocalStore", () => {
  it("adds tasks with media and lists them newest first with media info", async () => {
    const a = await store.add({ instructions: "  first  ", account: " @me ", media: [{ name: "a.png", type: "image/png", dataBase64: b64("PNGDATA") }] });
    now = new Date(now.getTime() + 1000);
    await store.add({ instructions: "second" });
    expect(a).toMatchObject({ instructions: "first", account: "@me", status: "pending", attempts: 0, mediaIds: ["id1"], repeat: null });
    const listed = await store.listWithMedia();
    expect(listed.map((t) => t.instructions)).toEqual(["second", "first"]);
    expect(listed[1]!.media).toEqual([{ id: "id1", name: "a.png", type: "image/png", size: 7 }]);
    const [rec] = await store.getMedia(["id1"]);
    expect(await rec!.blob.text()).toBe("PNGDATA");
    expect(Array.isArray(chrome.storage.local.data[LOCAL_TASKS_KEY])).toBe(true);
  });

  it("validates input", async () => {
    await expect(store.add({ instructions: "   " })).rejects.toThrow(/empty/);
    await expect(store.add({ instructions: "x", repeat: { dailyAt: ["25:00"] } })).rejects.toThrow(/Repeat rule/);
    await expect(store.add({ instructions: "x", repeat: daily("09:00", { end: "2020-01-01" }) })).rejects.toThrow(/never runs/);
    await expect(store.add({ instructions: "x", notBefore: "not a date" })).rejects.toThrow(/Invalid time/);
  });

  it("a repeating task without a time starts at its next occurrence", async () => {
    const t = await store.add({ instructions: "daily", repeat: { dailyAt: ["18:00", "08:00", "18:00"] } });
    expect(t.repeat).toEqual({ cron: "0 8,18 * * *", tz: TZ });
    expect(t.notBefore).toBe(local(2026, 9, 24, 18, 0).toISOString());
    // Every 2 days: anchored on the first run's day.
    const other = await store.add({ instructions: "x", repeat: daily("09:00", { interval: { every: 2, unit: "day" } }) });
    expect(other).toMatchObject({ notBefore: local(2026, 9, 25, 9, 0).toISOString(), repeat: daily("09:00", { interval: { every: 2, unit: "day" }, start: "2026-09-25" }) });
  });

  it("due: pending, notBefore and retryAfter passed, oldest first", async () => {
    await store.add({ instructions: "future", notBefore: local(2026, 9, 24, 12, 0).toISOString() });
    now = new Date(now.getTime() + 1);
    await store.add({ instructions: "now" });
    now = new Date(now.getTime() + 1);
    await store.add({ instructions: "past", notBefore: local(2026, 9, 24, 9, 0).toISOString() });
    expect((await store.due()).map((t) => t.instructions)).toEqual(["now", "past"]);
    expect((await store.due(local(2026, 9, 24, 12, 0))).map((t) => t.instructions)).toEqual(["future", "now", "past"]);
    expect(await store.nextWakeAt()).toEqual(local(2026, 9, 24, 12, 0));
  });

  it("markStarted persists running + attempts; finish done records the result", async () => {
    const t = await store.add({ instructions: "x" });
    const started = await store.markStarted(t.id);
    expect(started).toMatchObject({ status: "running", attempts: 1 });
    expect(await store.due()).toEqual([]);
    const { task, next } = await store.finish(t.id, { outcome: "done", summary: "posted", url: "https://x.com/me/status/1" }, { retryAfterMinutes: 10 });
    expect(task).toMatchObject({ status: "done", resultSummary: "posted", resultUrl: "https://x.com/me/status/1" });
    expect(next).toBeNull();
  });

  it("retry goes back to pending after retryAfterMinutes, and fails after 5 attempts", async () => {
    const t = await store.add({ instructions: "x" });
    for (let i = 1; i < MAX_LOCAL_ATTEMPTS; i++) {
      await store.markStarted(t.id);
      const { task } = await store.finish(t.id, { outcome: "retry", reason: "usage limit" }, { retryAfterMinutes: 10 });
      expect(task.status).toBe("pending");
      expect(task.retryAfter).toBe(new Date(now.getTime() + 10 * 60_000).toISOString());
      expect(task.failReason).toBe("usage limit");
      expect(await store.due()).toEqual([]);
      now = new Date(now.getTime() + 11 * 60_000);
      expect((await store.due()).map((x) => x.id)).toEqual([t.id]);
    }
    await store.markStarted(t.id);
    const { task } = await store.finish(t.id, { outcome: "retry", reason: "usage limit" }, { retryAfterMinutes: 10 });
    expect(task.status).toBe("failed");
    expect(task.failReason).toMatch(/gave up after 5 attempts/);
  });

  it("paused waits for the user; retry resets it", async () => {
    const t = await store.add({ instructions: "x" });
    await store.markStarted(t.id);
    await store.finish(t.id, { outcome: "paused", reason: "login page" }, { retryAfterMinutes: 10 });
    expect(await store.get(t.id)).toMatchObject({ status: "paused", pauseReason: "login page" });
    expect(await store.due()).toEqual([]);
    const r = await store.retry(t.id);
    expect(r).toMatchObject({ status: "pending", attempts: 0, pauseReason: null });
    // It already ran once, so the next run must check whether it already acted.
    expect(r.crashed).toBe(true);
    expect((await store.due()).map((x) => x.id)).toEqual([t.id]);
  });

  it("retrying a task that never ran is not marked as possibly acted", async () => {
    const t = await store.add({ instructions: "x" });
    expect((await store.retry(t.id)).crashed).toBe(false);
  });

  it("a repeating task spawns its next occurrence once when it ends done or failed", async () => {
    const t = await store.add({ instructions: "daily", repeat: daily("09:00"), media: [{ name: "a.png", type: "image/png", dataBase64: b64("x") }] });
    now = local(2026, 9, 25, 9, 1);
    await store.markStarted(t.id);
    const { task, next } = await store.finish(t.id, { outcome: "failed", reason: "nope" }, { retryAfterMinutes: 10 });
    expect(task.status).toBe("failed");
    expect(next).toMatchObject({ status: "pending", attempts: 0, instructions: "daily", mediaIds: t.mediaIds, notBefore: local(2026, 9, 26, 9, 0).toISOString() });
    expect(task.nextId).toBe(next!.id);
    // Retrying and finishing the old one again does not spawn a second copy.
    await store.retry(t.id);
    await store.markStarted(t.id);
    const again = await store.finish(t.id, { outcome: "done" }, { retryAfterMinutes: 10 });
    expect(again.next).toBeNull();
    expect((await store.list()).length).toBe(2);
    // Deleting the history row keeps the media the next occurrence still uses.
    await store.delete(t.id);
    expect((await store.getMedia(next!.mediaIds)).length).toBe(1);
    await store.delete(next!.id);
    await expect(store.getMedia(next!.mediaIds)).rejects.toThrow(/missing/);
  });

  it("retry outcomes of a repeating task do not spawn", async () => {
    const t = await store.add({ instructions: "daily", repeat: daily("09:00") });
    await store.markStarted(t.id);
    expect((await store.finish(t.id, { outcome: "retry" }, { retryAfterMinutes: 5 })).next).toBeNull();
  });

  it("a counted rule stops after its last run", async () => {
    const t = await store.add({ instructions: "twice", repeat: daily("09:00", { count: 2 }) });
    now = local(2026, 9, 24, 9, 1);
    await store.markStarted(t.id);
    const { next } = await store.finish(t.id, { outcome: "done" }, { retryAfterMinutes: 5 });
    expect(next!.repeat).toEqual(daily("09:00", { count: 1 }));
    now = local(2026, 9, 25, 9, 1);
    await store.markStarted(next!.id);
    const last = await store.finish(next!.id, { outcome: "done" }, { retryAfterMinutes: 5 });
    expect(last).toMatchObject({ next: null, task: { status: "done", nextId: null } });
  });

  it("reads tasks stored with the old { dailyAt } rule, and saves them converted", async () => {
    chrome.storage.local.data[LOCAL_TASKS_KEY] = [{ id: "old", instructions: "x", status: "pending", notBefore: null, retryAfter: null, mediaIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString(), repeat: { dailyAt: ["09:00"] } }];
    expect((await store.get("old"))!.repeat).toEqual({ cron: "0 9 * * *", tz: TZ });
    await store.update("old", { instructions: "y" });
    expect((chrome.storage.local.data[LOCAL_TASKS_KEY] as StoredLocalTask[])[0]!.repeat).toEqual({ cron: "0 9 * * *", tz: TZ });
  });

  it("update and delete refuse running tasks; a repeating one that runs can be updated", async () => {
    const t = await store.add({ instructions: "x" });
    expect(await store.update(t.id, { instructions: "y", account: "@a", repeat: daily("07:00") })).toMatchObject({
      instructions: "y",
      account: "@a",
      repeat: daily("07:00"),
      notBefore: local(2026, 9, 25, 7, 0).toISOString(),
    });
    const started = await store.markStarted(t.id);
    // Repeating: the edit is what its next runs do; when the run started stays (crash recovery reads it).
    expect(await store.update(t.id, { instructions: "z" })).toMatchObject({ status: "running", instructions: "z", updatedAt: started.updatedAt });
    await expect(store.delete(t.id)).rejects.toThrow(/running/);
    const once = await store.add({ instructions: "once" });
    await store.markStarted(once.id);
    await expect(store.update(once.id, { instructions: "z" })).rejects.toThrow(/running/);
    await expect(store.update("nope", {})).rejects.toThrow(/No task/);
    expect(await store.delete("nope")).toBe(false);
  });

  it("recoverCrashed: old running tasks go back to pending with the crash marker", async () => {
    const a = await store.add({ instructions: "old" });
    const b = await store.add({ instructions: "young" });
    await store.markStarted(a.id);
    now = new Date(now.getTime() + 11 * 60_000);
    await store.markStarted(b.id);
    now = new Date(now.getTime() + 2 * 60_000);
    // maxTaskMinutes 10 -> cutoff 12.5 minutes (the safety timer and its grace): a (13 min) recovers, b (2 min) does not.
    expect(await store.recoverCrashed(10)).toBe(1);
    expect(await store.get(a.id)).toMatchObject({ status: "pending", crashed: true, attempts: 1 });
    expect(await store.get(b.id)).toMatchObject({ status: "running" });
  });

  it("recoverCrashed leaves alone the tasks this worker is still running, however old", async () => {
    const a = await store.add({ instructions: "slow" });
    await store.markStarted(a.id);
    now = new Date(now.getTime() + 60 * 60_000);
    expect(await store.recoverCrashed(10, new Set([a.id]))).toBe(0);
    expect(await store.get(a.id)).toMatchObject({ status: "running" });
  });

  it("recoverCrashed fails a task that is out of attempts", async () => {
    const a = await store.add({ instructions: "old" });
    for (let i = 0; i < MAX_LOCAL_ATTEMPTS; i++) await store.markStarted(a.id);
    now = new Date(now.getTime() + 60 * 60_000);
    await store.recoverCrashed(10);
    expect(await store.get(a.id)).toMatchObject({ status: "failed" });
  });

  it("notifies listeners on change and serializes concurrent writes", async () => {
    let changes = 0;
    store.onChange(() => changes++);
    await Promise.all([store.add({ instructions: "a" }), store.add({ instructions: "b" }), store.add({ instructions: "c" })]);
    expect((await store.list()).length).toBe(3);
    expect(changes).toBe(3);
  });
});

describe("who wrote a task (agentAuthored)", () => {
  it("the agent's task stays the agent's across repeats and a change of time; the user's new words or Trust make it theirs", async () => {
    const t = await store.add({ instructions: "post a tip on X", repeat: daily("09:00"), agentAuthored: true });
    expect(t.agentAuthored).toBe(true);
    await store.markStarted(t.id);
    const { next } = await store.finish(t.id, { outcome: "done" }, { retryAfterMinutes: 15 });
    expect(next?.agentAuthored).toBe(true);
    expect((await store.update(next!.id, { repeat: daily("08:00"), instructions: "post a tip on X" })).agentAuthored).toBe(true);
    expect((await store.update(next!.id, { instructions: "post a grounded tip on X" })).agentAuthored).toBe(false);
    expect((await store.update(next!.id, { instructions: "pay 50 on pay.evil.test", agentAuthored: true })).agentAuthored).toBe(true);
    expect((await store.update(next!.id, { agentAuthored: false })).agentAuthored).toBe(false);
  });

  it("a task the user adds is theirs", async () => {
    expect((await store.add({ instructions: "post a tip" })).agentAuthored).toBeUndefined();
  });
});

describe("task series (seriesId)", () => {
  it("a new task is its own series; its repeats carry it, also after an edit", async () => {
    const t = await store.add({ instructions: "post a tip", repeat: daily("09:00") });
    expect(t.seriesId).toBe(t.id);
    await store.markStarted(t.id);
    const { next } = await store.finish(t.id, { outcome: "done", summary: "ok" }, { retryAfterMinutes: 15 });
    expect(next?.seriesId).toBe(t.id);
    const edited = await store.update(next!.id, { instructions: "post a grounded tip", repeat: daily("08:00") });
    expect(edited.seriesId).toBe(t.id);
    await store.markStarted(edited.id);
    const third = (await store.finish(edited.id, { outcome: "done" }, { retryAfterMinutes: 15 })).next;
    expect(third?.seriesId).toBe(t.id);
  });

  it("tasks stored before series get the first row of their repeat chain as they are read", async () => {
    const row = (id: string, nextId: string | null) => ({ id, instructions: "x", nextId, repeat: null }) as unknown as StoredLocalTask;
    const chained = withSeries([row("c", null), row("a", "b"), row("b", "c"), row("z", null)]);
    expect(Object.fromEntries(chained.map((t) => [t.id, t.seriesId]))).toEqual({ a: "a", b: "a", c: "a", z: "z" });
    await chrome.storage.local.set({ [LOCAL_TASKS_KEY]: [row("a", "b"), row("b", null)] });
    expect((await store.list()).map((t) => t.seriesId)).toEqual(["a", "a"]);
  });
});

describe("pausing a job (pause, resume, holdSeries)", () => {
  it("pause keeps a waiting task from running (not due, no wake-up) until resume puts it back at its time", async () => {
    const t = await store.add({ instructions: "later", notBefore: local(2026, 9, 24, 12, 0).toISOString() });
    const paused = await store.pause(t.id);
    expect(paused).toMatchObject({ status: "paused", pauseReason: "Paused by you", retryAfter: null });
    now = local(2026, 9, 24, 13, 0);
    expect(await store.due()).toEqual([]);
    expect(await store.nextWakeAt()).toBeNull();
    // A one-off whose time went by while paused: due as soon as it is resumed.
    expect(await store.resume(t.id)).toMatchObject({ status: "pending", pauseReason: null, notBefore: local(2026, 9, 24, 12, 0).toISOString() });
    expect((await store.due()).map((x) => x.id)).toEqual([t.id]);
  });

  it("a repeating task resumed after its time went by runs at its next time, not at once", async () => {
    const t = await store.add({ instructions: "tip", repeat: daily("09:00") });
    expect(t.notBefore).toBe(local(2026, 9, 25, 9, 0).toISOString());
    await store.pause(t.id);
    now = local(2026, 9, 27, 10, 0);
    expect((await store.resume(t.id)).notBefore).toBe(local(2026, 9, 28, 9, 0).toISOString());
    expect(await store.due()).toEqual([]);
  });

  it("refuses to pause a running or finished task, and to resume one that is not paused", async () => {
    const t = await store.add({ instructions: "x" });
    await expect(store.resume(t.id)).rejects.toThrow(/only a paused task can be resumed/);
    await store.markStarted(t.id);
    await expect(store.pause(t.id)).rejects.toThrow(/only a waiting task can be paused/);
    await store.finish(t.id, { outcome: "done" }, { retryAfterMinutes: 10 });
    await expect(store.pause(t.id)).rejects.toThrow(/only a waiting task can be paused/);
  });

  it("holdSeries pauses the series' waiting run (its next repeat or its retry) with the reason; null when none waits", async () => {
    const t = await store.add({ instructions: "tip", notBefore: now.toISOString(), repeat: daily("09:00") });
    await store.markStarted(t.id);
    const { next } = await store.finish(t.id, { outcome: "failed", reason: "boom" }, { retryAfterMinutes: 10 });
    const held = await store.holdSeries(t.id, "Paused after 3 failed runs in a row. Last: boom");
    expect(held).toMatchObject({ id: next!.id, status: "paused", pauseReason: "Paused after 3 failed runs in a row. Last: boom" });
    // On hold already: nothing more to hold.
    expect(await store.holdSeries(t.id, "again")).toBeNull();
    expect(await store.holdSeries("no-such-series", "x")).toBeNull();
    // A retry waiting for its time is held too.
    const r = await store.add({ instructions: "retry me" });
    await store.markStarted(r.id);
    await store.finish(r.id, { outcome: "retry", reason: "network" }, { retryAfterMinutes: 10 });
    expect(await store.holdSeries(r.id, "held")).toMatchObject({ id: r.id, status: "paused", retryAfter: null, pauseReason: "held" });
  });

  it("releaseHold resumes the series' row held after failures (at its time, no new row); never one the user paused, nor `except`", async () => {
    const HOLD = "Paused after 3 failed runs in a row. Last: button not found";
    const t = await store.add({ instructions: "tip", notBefore: now.toISOString(), repeat: daily("09:00") });
    await store.markStarted(t.id);
    const { next } = await store.finish(t.id, { outcome: "failed", reason: "button not found" }, { retryAfterMinutes: 10 });
    await store.holdSeries(t.id, HOLD);
    const rows = async () => (await store.list()).filter((x) => (x.seriesId ?? x.id) === t.id);
    expect(await rows()).toHaveLength(2);
    // The row the conversation finished is left to it.
    expect(await store.releaseHold(t.id, next!.id)).toEqual([]);
    expect(await store.releaseHold(t.id)).toEqual([next!.id]);
    expect(await rows()).toHaveLength(2);
    expect((await store.get(next!.id))!).toMatchObject({ status: "pending", pauseReason: null, notBefore: next!.notBefore });
    // Nothing held any more; a row the user paused stays paused.
    expect(await store.releaseHold(t.id)).toEqual([]);
    await store.pause(next!.id);
    expect(await store.releaseHold(t.id)).toEqual([]);
    expect(await store.get(next!.id)).toMatchObject({ status: "paused", pauseReason: "Paused by you" });
  });
});
