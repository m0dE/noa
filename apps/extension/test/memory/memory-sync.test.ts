import { describe, expect, it } from "vitest";
import { MAX_MEMORY_SEARCH_QUERY_CHARS, memoryWriteProblem, PLAN_REQUIRED, type MemoryDeletion, type MemoryEntry, type MemorySyncInput, type MemorySyncResponse } from "@noa/shared";
import { MemoryStore } from "../../src/memory/store.js";
import { MemorySync, MEMORY_SYNC_KEY } from "../../src/memory/sync.js";
import { syncText } from "../../src/options/memory-view.js";
import { memoryStorage } from "./fakes.js";

/** The account server's memory for one user (routes/memory.ts, in memory): newest change wins, a revision per write. */
function fakeServer() {
  const rows = new Map<string, { entry: MemoryEntry | null; at: string; rev: number }>();
  let rev = 0;
  const calls: MemorySyncInput[] = [];
  let forgotten = 0;
  const changes = (since: number) => {
    const out = [...rows.entries()].filter(([, r]) => r.rev > since);
    return {
      entries: out.filter(([, r]) => r.entry).map(([, r]) => r.entry!),
      deleted: out.filter(([, r]) => !r.entry).map(([id, r]) => ({ id, at: r.at })),
    };
  };
  const api = {
    async memorySync(input: MemorySyncInput): Promise<MemorySyncResponse> {
      calls.push(structuredClone(input));
      const refused: MemorySyncResponse["refused"] = [];
      if (input.upserts.length || input.deletes.length) rev++;
      for (const e of input.upserts) {
        const why = memoryWriteProblem(e);
        if (why) {
          refused.push({ id: e.id, reason: why });
          continue;
        }
        const cur = rows.get(e.id);
        if (!cur || e.updatedAt >= cur.at) rows.set(e.id, { entry: e, at: e.updatedAt, rev });
      }
      for (const d of input.deletes) {
        const cur = rows.get(d.id);
        if (!cur || d.at >= cur.at) rows.set(d.id, { entry: null, at: d.at, rev });
      }
      return { rev, ...changes(input.since), refused, locked: false };
    },
    async forgetMemory() {
      forgotten++;
      rev++;
      for (const [id, r] of rows) if (r.entry) rows.set(id, { entry: null, at: "9999", rev });
    },
  };
  return { api, calls, rows, forgotten: () => forgotten };
}

let clock = Date.parse("2026-09-26T10:00:00Z");
const now = () => new Date(clock);

type Account = { userId: string; email: string; syncAllowed: boolean };

function browser(server: ReturnType<typeof fakeServer>, account: Account | null, name: string) {
  const storage = memoryStorage();
  let n = 0;
  const store = new MemoryStore({ storage, now, newId: () => `${name}${++n}` });
  const sync = new MemorySync({ store, storage, now, account: async () => (account ? { ...account, api: server.api } : null) });
  return { store, sync, storage };
}

const CHAT = { kind: "chat" as const };
const ADA: Account = { userId: "u-ada", email: "ada@example.com", syncAllowed: true };
const BOB: Account = { userId: "u-bob", email: "bob@example.com", syncAllowed: true };
const wait = () => new Promise((r) => setTimeout(r, 0));

describe("MemorySync", () => {
  it("a fact learned in one browser reaches another, and so do its correction and deletion", async () => {
    const server = fakeServer();
    const a = browser(server, ADA, "a");
    const b = browser(server, ADA, "b");
    await a.store.put({ kind: "account", subject: "Work email", text: "admin@runhq.io, Google /u/2", scope: "global" }, CHAT);
    await wait();
    await a.sync.sync();
    await b.sync.sync();
    expect((await b.store.list()).map((e) => e.text)).toEqual(["admin@runhq.io, Google /u/2"]);

    clock += 60_000;
    await b.store.put({ kind: "account", subject: "Work email", text: "admin@runhq.io is now /u/3", scope: "global" }, CHAT);
    await wait();
    await b.sync.sync();
    await a.sync.sync();
    expect((await a.store.list()).map((e) => e.text)).toEqual(["admin@runhq.io is now /u/3"]);

    clock += 60_000;
    await a.store.forget((await a.store.list())[0]!.id);
    await wait();
    await a.sync.sync();
    await b.sync.sync();
    expect(await b.store.list()).toEqual([]);
  });

  it("sends only what changed, and nothing when nothing did", async () => {
    const server = fakeServer();
    const a = browser(server, ADA, "a");
    await a.store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    await a.store.put({ kind: "person", subject: "Paul Lee", text: "accountant", scope: "global" }, CHAT);
    await wait();
    await a.sync.sync();
    expect(server.calls.at(-1)!.upserts.map((e) => e.id).sort()).toEqual(["a1", "a2"]);
    await a.store.touch(["a1"]);
    await a.sync.sync();
    expect(server.calls.at(-1)).toMatchObject({ upserts: [], deletes: [] });
    expect((await a.storage.get(MEMORY_SYNC_KEY))[MEMORY_SYNC_KEY]).toMatchObject({ dirty: [], deleted: [], rev: 1 });
  });

  it("an older change from the account does not replace a newer one here", async () => {
    const server = fakeServer();
    const a = browser(server, ADA, "a");
    await a.store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    await wait();
    await a.sync.sync();
    const [e] = await a.store.list();
    await a.store.applyRemote([{ ...e!, text: "stale", updatedAt: "2020-01-01T00:00:00.000Z" }], [{ id: e!.id, at: "2020-01-01T00:00:00.000Z" } satisfies MemoryDeletion]);
    expect((await a.store.list())[0]!.text).toBe("calm");
  });

  it("its own write coming back from a server on an older schema keeps the fields that server dropped", async () => {
    const server = fakeServer();
    const a = browser(server, ADA, "a");
    await a.store.putEpisode({ subject: "Send the quote", text: "Started looking in Drive; the user stopped it.", at: now().toISOString(), stopped: true }, CHAT);
    await wait();
    await a.sync.sync();
    const [e] = await a.store.list();
    const { stopped: _s, ...dropped } = e!;
    await a.store.applyRemote([dropped], []);
    expect((await a.store.list())[0]!.stopped).toBe(true);
  });

  it("changes from the account are not sent back, and an entry this computer refuses is left out", async () => {
    const server = fakeServer();
    const a = browser(server, ADA, "a");
    await a.sync.sync();
    const good: MemoryEntry = { id: "x1", kind: "person", subject: "Paul Lee", text: "accountant", scope: "global", source: CHAT, learnedAt: now().toISOString(), updatedAt: now().toISOString() };
    await a.store.applyRemote([good, { ...good, id: "x2", text: "PIN: 4821" }], []);
    expect((await a.store.list()).map((e) => e.id)).toEqual(["x1"]);
    await a.sync.sync();
    expect(server.calls.at(-1)!.upserts).toEqual([]);
  });

  it("stays on this computer while signed out or on a plan without it; the first sign-in to an empty account sends everything", async () => {
    const server = fakeServer();
    let account: Account | null = null;
    const storage = memoryStorage();
    const store = new MemoryStore({ storage, now });
    const sync = new MemorySync({ store, storage, now, account: async () => (account ? { ...account, api: server.api } : null) });
    await store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    expect(await sync.sync()).toEqual({ state: "signed-out" });
    account = { ...ADA, syncAllowed: false };
    expect(await sync.sync()).toEqual({ state: "no-plan" });
    expect(server.calls).toEqual([]);
    account = ADA;
    expect(await sync.sync()).toMatchObject({ state: "on", lastSyncAt: now().toISOString() });
    // One request looked whether the account keeps memory, the next sent this computer's.
    expect(server.calls.map((c) => c.upserts.length)).toEqual([0, 1]);
  });

  it("signing in to another account sends nothing until the user adds this computer's memory to it", async () => {
    const server = fakeServer();
    let account: Account = ADA;
    const storage = memoryStorage();
    const store = new MemoryStore({ storage, now });
    let asked = 0;
    const sync = new MemorySync({ store, storage, now, account: async () => ({ ...account, api: server.api }), onQuestionChange: () => asked++ });
    await store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    await sync.sync();
    const sentToAda = server.calls.length;

    account = BOB;
    expect(await sync.sync()).toEqual({ state: "ask", account: "bob@example.com" });
    expect(await sync.question()).toEqual({ account: "bob@example.com" });
    expect(asked).toBe(1);
    // Asking again (a turn's pull, Settings opening) sends nothing either.
    expect(await sync.sync()).toEqual({ state: "ask", account: "bob@example.com" });
    expect(server.calls.length).toBe(sentToAda);

    expect(await sync.choose(true)).toMatchObject({ state: "on" });
    expect(server.calls.at(-1)).toMatchObject({ since: 0, upserts: [expect.objectContaining({ subject: "Tone" })] });
    expect(await sync.question()).toBeNull();
    expect(asked).toBe(2);
  });

  it("keep separate: nothing goes to that account while it is signed in; the account it was synced with goes on", async () => {
    const server = fakeServer();
    let account: Account = ADA;
    const storage = memoryStorage();
    const store = new MemoryStore({ storage, now });
    const sync = new MemorySync({ store, storage, now, account: async () => ({ ...account, api: server.api }) });
    await store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    await sync.sync();

    account = BOB;
    await sync.sync();
    expect(await sync.choose(false)).toEqual({ state: "separate", account: "bob@example.com" });
    const calls = server.calls.length;
    await store.put({ kind: "person", subject: "Paul Lee", text: "accountant", scope: "global" }, CHAT);
    await wait();
    expect(await sync.sync()).toEqual({ state: "separate", account: "bob@example.com" });
    expect(await sync.question()).toBeNull();
    expect(server.calls.length).toBe(calls);

    // Back to Ada: what changed here meanwhile goes to her account, without asking.
    account = ADA;
    expect(await sync.sync()).toMatchObject({ state: "on" });
    expect(server.calls.at(-1)!.upserts.map((e) => e.subject)).toEqual(["Paul Lee"]);
    // Bob again: still kept separate; Settings can still add it.
    account = BOB;
    expect(await sync.status()).toEqual({ state: "separate", account: "bob@example.com" });
    expect(await sync.choose(true)).toMatchObject({ state: "on" });
    expect(server.calls.at(-1)!.upserts.map((e) => e.subject).sort()).toEqual(["Paul Lee", "Tone"]);
  });

  it("the first sign-in asks when the account already keeps memory; a computer with nothing to send never asks", async () => {
    const server = fakeServer();
    const other = browser(server, ADA, "o");
    await other.store.put({ kind: "person", subject: "Paul Lee", text: "accountant", scope: "global" }, CHAT);
    await other.sync.sync();

    const here = browser(server, ADA, "h");
    await here.store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    expect(await here.sync.sync()).toEqual({ state: "ask", account: "ada@example.com" });
    expect(server.calls.at(-1)!.upserts).toEqual([]);

    const empty = browser(server, ADA, "e");
    expect(await empty.sync.sync()).toMatchObject({ state: "on" });
    expect((await empty.store.list()).map((e) => e.subject)).toEqual(["Paul Lee"]);
  });

  it("forget everything forgets in the account too", async () => {
    const server = fakeServer();
    const a = browser(server, ADA, "a");
    await a.store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    await wait();
    await a.sync.sync();
    await a.store.clear();
    await a.sync.forgetAll();
    expect(server.forgotten()).toBe(1);
    expect([...server.rows.values()].every((r) => r.entry === null)).toBe(true);
  });

  it("a failed sync is reported and tried again with the next change", async () => {
    const storage = memoryStorage();
    const store = new MemoryStore({ storage, now });
    let fail = true;
    const server = fakeServer();
    const api = {
      memorySync: async (i: MemorySyncInput) => {
        if (fail) throw Object.assign(new Error(PLAN_REQUIRED), { status: 403 });
        return server.api.memorySync(i);
      },
      forgetMemory: server.api.forgetMemory,
    };
    const sync = new MemorySync({ store, storage, now, account: async () => ({ ...ADA, api }) });
    storage.data[MEMORY_SYNC_KEY] = { userId: ADA.userId, rev: 0, dirty: [], deleted: [] };
    await store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
    await wait();
    expect(await sync.sync()).toEqual({ state: "on", error: PLAN_REQUIRED });
    fail = false;
    expect(await sync.sync()).toMatchObject({ state: "on" });
    expect(server.calls[0]!.upserts).toHaveLength(1);
  });
});

describe("syncText (Settings > Memory)", () => {
  it("says where memory is kept", () => {
    expect(syncText({ state: "signed-out" }).text).toMatch(/^Kept on this computer only\. Log in with a paid plan/);
    expect(syncText({ state: "no-plan" }).text).toMatch(/^Kept on this computer only\. With a paid plan it syncs/);
    expect(syncText({ state: "on", lastSyncAt: "2026-09-26T21:14:00Z" }, new Date("2026-09-26T22:00:00Z"))).toMatchObject({ text: expect.stringMatching(/^Synced with your account, last Sep 26 /), tone: "ok" });
    expect(syncText({ state: "on", error: "offline" })).toMatchObject({ tone: "bad", text: expect.stringMatching(/offline/) });
    expect(syncText(undefined).text).toBe("");
  });
});

describe("search (the account's semantic search)", () => {
  it("asks the account only when this computer's memory syncs with it, cutting a long query", async () => {
    const server = fakeServer();
    const asked: unknown[] = [];
    const api = { ...server.api, memorySearch: async (input: unknown) => (asked.push(input), { model: "m", hits: [{ id: "a1", score: 0.7 }], pending: 0 }) };
    const account = { userId: "u1", email: "u@x.io", syncAllowed: true };
    const storage = memoryStorage();
    const store = new MemoryStore({ storage, now });
    const sync = new MemorySync({ store, storage, now, account: async () => ({ ...account, api }) });
    // Not synced with this account yet: nothing is asked.
    expect(await sync.search("tax guy", { limit: 5 })).toBeNull();
    await sync.sync();
    expect(await sync.search(`tax guy ${"x".repeat(2 * MAX_MEMORY_SEARCH_QUERY_CHARS)}`, { taskKey: "tA", limit: 5 })).toEqual(new Map([["a1", 0.7]]));
    expect(asked).toEqual([{ query: expect.stringMatching(/^tax guy x+$/), taskKey: "tA", limit: 5 }]);
    expect((asked[0] as { query: string }).query.length).toBe(MAX_MEMORY_SEARCH_QUERY_CHARS);
    // No plan: nothing is asked.
    account.syncAllowed = false;
    expect(await sync.search("tax guy", { limit: 5 })).toBeNull();
    expect(asked).toHaveLength(1);
  });
});
