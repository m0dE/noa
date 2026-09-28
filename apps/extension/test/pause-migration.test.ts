import { beforeEach, describe, expect, it } from "vitest";
import type { LocalTask } from "@noa/shared";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { MemoryKvDb } from "./memory-kv.js";
import { LocalTodo } from "../src/account/todo-source.js";
import { LocalStore } from "../src/engine/local-store.js";
import { PAUSE_MIGRATION_KEY, PauseMigration, type PausableList } from "../src/engine/pause-migration.js";
import { loadSettings } from "../src/settings-store.js";

let chrome: ChromeFake;
let store: LocalStore;

beforeEach(() => {
  chrome = installChromeFake();
  let n = 0;
  store = new LocalStore({ db: new MemoryKvDb(), now: () => new Date("2026-09-28T10:00:00Z"), newId: () => `l${++n}` });
});

/** An account list in memory; `fail` makes its calls throw. */
function accountList(tasks: Partial<LocalTask>[]) {
  const rows = tasks.map((t, i) => ({ id: `a${i}`, status: "pending", retryAfter: null, pauseReason: null, ...t }) as LocalTask);
  const list = {
    fail: null as Error | null,
    locked: false,
    rows,
    list: async () => {
      if (list.fail) throw list.fail;
      return { tasks: rows, locked: list.locked };
    },
    pause: async (id: string, reason?: string) => {
      if (list.fail) throw list.fail;
      const t = rows.find((r) => r.id === id)!;
      Object.assign(t, { status: "paused", pauseReason: reason, retryAfter: null });
      return t;
    },
  };
  return list satisfies PausableList;
}

function migration(account: PausableList | null) {
  const logs: string[] = [];
  let changes = 0;
  const m = new PauseMigration({
    storage: () => chrome.storage.local,
    local: new LocalTodo(store),
    account: async () => account,
    log: (x) => void logs.push(x),
    changed: () => void changes++,
  });
  return { m, logs, changes: () => changes };
}

describe("the old pause of every scheduled run becomes paused jobs", () => {
  it("pauses every waiting job, here and in the account, and leaves nothing global", async () => {
    chrome.storage.local.data.settings = { paused: true, intervalMinutes: 30 };
    const waiting = await store.add({ instructions: "local waiting" });
    const done = await store.add({ instructions: "local done" });
    await store.markStarted(done.id);
    await store.finish(done.id, { outcome: "done" }, { retryAfterMinutes: 10 });
    const account = accountList([
      { status: "pending" },
      // Paused for a while (it would come back by itself): held too.
      { status: "paused", retryAfter: "2026-09-28T10:15:00Z", pauseReason: "Out of usage credit" },
      // Needs the user already, or over: left as they are.
      { status: "paused", pauseReason: "Log in to X" },
      { status: "done" },
    ]);
    const { m } = migration(account);
    await m.start();
    expect(await store.get(waiting.id)).toMatchObject({ status: "paused", pauseReason: "Paused by you" });
    expect(await store.get(done.id)).toMatchObject({ status: "done" });
    expect(account.rows.map((r) => [r.status, r.pauseReason])).toEqual([
      ["paused", "Paused by you"],
      ["paused", "Paused by you"],
      ["paused", "Log in to X"],
      ["done", null],
    ]);
    // Nothing global remains: the switch left the settings (the rest kept), and nothing waits.
    expect(chrome.storage.local.data.settings).toEqual({ intervalMinutes: 30 });
    expect(await m.pending()).toBeNull();
    expect((await loadSettings()).intervalMinutes).toBe(30);
    // Another start: nothing to do.
    await m.start();
    expect(account.rows[0]!.status).toBe("paused");
  });

  it("with the switch off, only drops it from the settings", async () => {
    chrome.storage.local.data.settings = { paused: false };
    const t = await store.add({ instructions: "x" });
    const { m } = migration(accountList([{ status: "pending" }]));
    await m.start();
    expect(chrome.storage.local.data.settings).toEqual({});
    expect(await store.get(t.id)).toMatchObject({ status: "pending" });
    expect(await m.pending()).toBeNull();
  });

  it("signed out: this browser's jobs are paused and it is done", async () => {
    chrome.storage.local.data.settings = { paused: true };
    const t = await store.add({ instructions: "x" });
    const { m } = migration(null);
    await m.start();
    expect(await store.get(t.id)).toMatchObject({ status: "paused" });
    expect(await m.pending()).toBeNull();
  });

  it("when the account's jobs cannot be paused yet, it waits with why (nothing of the account runs meanwhile) and a retry finishes it", async () => {
    chrome.storage.local.data.settings = { paused: true };
    const t = await store.add({ instructions: "x" });
    const account = accountList([{ status: "pending" }]);
    account.fail = new Error("HTTP 404: not found");
    const { m, changes } = migration(account);
    await m.start();
    // This browser's are paused already; the switch is gone from the settings, but the conversion waits.
    expect(await store.get(t.id)).toMatchObject({ status: "paused" });
    expect(chrome.storage.local.data.settings).toEqual({});
    expect(await m.pending()).toBe("HTTP 404: not found");
    expect(changes()).toBe(1);
    account.fail = null;
    await m.retry();
    expect(account.rows[0]).toMatchObject({ status: "paused", pauseReason: "Paused by you" });
    expect(await m.pending()).toBeNull();
    expect(chrome.storage.local.data[PAUSE_MIGRATION_KEY]).toBeNull();
  });

  it("a locked account list (no TODO on the plan) cannot be paused: it waits, and says why", async () => {
    chrome.storage.local.data.settings = { paused: true };
    const account = accountList([{ status: "pending" }]);
    account.locked = true;
    const { m } = migration(account);
    await m.start();
    expect(await m.pending()).toBe("The TODO list needs a paid plan to pause its jobs");
    expect(account.rows[0]!.status).toBe("pending");
  });

  it("a crash after the switch was recorded is picked up at the next start", async () => {
    chrome.storage.local.data[PAUSE_MIGRATION_KEY] = { error: "" };
    const account = accountList([{ status: "pending" }]);
    const { m } = migration(account);
    expect(await m.pending()).toBe("Pausing your scheduled jobs one by one");
    await m.start();
    expect(account.rows[0]!.status).toBe("paused");
    expect(await m.pending()).toBeNull();
  });
});
