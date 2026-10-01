import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookmarkSync, BOOKMARK_SYNC_ALARM, BOOKMARK_SYNC_KEY, scanTree } from "../../src/bookmarks/sync.js";
import { memoryStorageArea } from "../chrome-fake.js";
import { FakeBookmarks, FakeBookmarkServer } from "./fake-bookmarks.js";

let clock = Date.parse("2026-09-28T10:00:00.000Z");
const tick = () => new Date((clock += 60_000));

/** One computer: its bookmarks, its storage, and its sync with `server` as user `userId`. */
function computer(server: FakeBookmarkServer, opts: { userId?: string; enabled?: boolean; signedIn?: boolean } = {}) {
  const bookmarks = new FakeBookmarks();
  const storage = memoryStorageArea();
  let guid = 0;
  const prefix = Math.random().toString(36).slice(2, 6);
  const state = { enabled: opts.enabled ?? true, signedIn: opts.signedIn ?? true, userId: opts.userId ?? "u1" };
  const sync = new BookmarkSync({
    bookmarks,
    storage,
    account: async () => (state.signedIn ? { userId: state.userId, api: server.api() } : null),
    enabled: async () => state.enabled,
    now: tick,
    newGuid: () => `${prefix}${++guid}`,
  });
  return { bookmarks, storage, sync, state };
}

let server: FakeBookmarkServer;
beforeEach(() => {
  server = new FakeBookmarkServer();
});

describe("scanTree", () => {
  it("maps the root folders to their fixed guids (by folderType, else by position) and leaves managed ones out", () => {
    const tree = [
      {
        id: "0",
        title: "",
        children: [
          { id: "1", title: "Bar", children: [{ id: "10", title: "a", url: "https://a.test" }] },
          { id: "2", title: "Other", children: [] },
          { id: "3", title: "Mobile", children: [] },
          { id: "4", title: "Managed", unmodifiable: "managed", folderType: "managed", children: [{ id: "40", title: "m", url: "https://m.test", unmodifiable: "managed" }] },
        ],
      },
    ];
    const { roots, nodes } = scanTree(tree);
    expect([...roots]).toEqual([
      ["1", "root_bar"],
      ["2", "root_other"],
      ["3", "root_mobile"],
    ]);
    expect([...nodes.keys()]).toEqual(["10"]);
  });
});

describe("BookmarkSync", () => {
  it("sends a computer's bookmarks and gives them to another computer, folders and order kept", async () => {
    const a = computer(server);
    const work = await a.bookmarks.create({ parentId: "1", title: "Work" });
    await a.bookmarks.create({ parentId: work.id, title: "Tracker", url: "https://tracker.test" });
    await a.bookmarks.create({ parentId: work.id, title: "Mail", url: "https://mail.test" });
    await a.bookmarks.create({ parentId: "2", title: "News", url: "https://news.test" });
    expect(await a.sync.sync()).toMatchObject({ state: "on" });
    expect(server.rows.size).toBe(4);

    const b = computer(server);
    await b.sync.sync();
    expect(b.bookmarks.outline()).toEqual(a.bookmarks.outline());
    expect(b.bookmarks.outline()).toEqual([
      "Bookmarks bar",
      "  Work",
      "    Tracker <https://tracker.test>",
      "    Mail <https://mail.test>",
      "Other bookmarks",
      "  News <https://news.test>",
      "Mobile bookmarks",
    ]);
  });

  it("changes, moves and deletions go both ways, and applying them sends nothing back", async () => {
    const a = computer(server);
    const b = computer(server);
    const f = await a.bookmarks.create({ parentId: "1", title: "Folder" });
    await a.bookmarks.create({ parentId: f.id, title: "Doc", url: "https://doc.test" });
    await a.bookmarks.create({ parentId: "1", title: "Loose", url: "https://loose.test" });
    await a.sync.sync();
    await b.sync.sync();

    await b.bookmarks.update(b.bookmarks.idOf("Doc"), { title: "Doc v2" });
    await b.bookmarks.move(b.bookmarks.idOf("Loose"), { parentId: b.bookmarks.idOf("Folder"), index: 0 });
    await b.sync.sync();
    await a.sync.sync();
    expect(a.bookmarks.outline()).toEqual(["Bookmarks bar", "  Folder", "    Loose <https://loose.test>", "    Doc v2 <https://doc.test>", "Other bookmarks", "Mobile bookmarks"]);

    // A's next sync after applying has nothing to send.
    const before = server.requests.length;
    await a.sync.sync({ pull: true });
    expect(server.requests.slice(before).every((r) => r.changes.length === 0)).toBe(true);

    await a.bookmarks.removeTree(a.bookmarks.idOf("Folder"));
    await a.sync.sync();
    await b.sync.sync();
    expect(b.bookmarks.outline()).toEqual(["Bookmarks bar", "Other bookmarks", "Mobile bookmarks"]);
    expect([...server.rows.values()].filter((r) => !r.deleted)).toEqual([]);
  });

  it("merges at the first sync: the same bookmarks on a second computer are not duplicated", async () => {
    const a = computer(server);
    const b = computer(server);
    for (const c of [a, b]) {
      const f = await c.bookmarks.create({ parentId: "1", title: "Shared" });
      await c.bookmarks.create({ parentId: f.id, title: "Same", url: "https://same.test" });
    }
    await b.bookmarks.create({ parentId: "1", title: "Only on B", url: "https://b.test" });
    await a.sync.sync();
    await b.sync.sync();
    await a.sync.sync();
    const want = ["Bookmarks bar", "  Shared", "    Same <https://same.test>", "  Only on B <https://b.test>", "Other bookmarks", "Mobile bookmarks"];
    expect(b.bookmarks.outline()).toEqual(want);
    expect(a.bookmarks.outline()).toEqual(want);
    expect([...server.rows.values()].filter((r) => !r.deleted)).toHaveLength(3);
  });

  it("the newer of two computers' changes to one bookmark wins on both", async () => {
    const a = computer(server);
    const b = computer(server);
    await a.bookmarks.create({ parentId: "1", title: "Page", url: "https://p.test" });
    await a.sync.sync();
    await b.sync.sync();
    await a.bookmarks.update(a.bookmarks.idOf("Page"), { title: "A's title" });
    await a.sync.sync();
    // B renames it later (its sync notes the change with a newer time), before hearing of A's.
    await b.bookmarks.update(b.bookmarks.idOf("Page"), { title: "B's title" });
    await b.sync.sync();
    await a.sync.sync();
    expect(a.bookmarks.outline()[1]).toBe("  B's title <https://p.test>");
    expect(b.bookmarks.outline()[1]).toBe("  B's title <https://p.test>");
  });

  it("a bookmark whose folder was deleted elsewhere is kept in Other bookmarks", async () => {
    const a = computer(server);
    const b = computer(server);
    await a.bookmarks.create({ parentId: "1", title: "Folder" });
    await a.sync.sync();
    await b.sync.sync();
    // A deletes the folder while B adds a bookmark in it.
    await a.bookmarks.removeTree(a.bookmarks.idOf("Folder"));
    await a.sync.sync();
    await b.bookmarks.create({ parentId: b.bookmarks.idOf("Folder"), title: "New", url: "https://new.test" });
    await b.sync.sync();
    await a.sync.sync();
    expect(a.bookmarks.outline()).toContain("  New <https://new.test>");
    expect(a.bookmarks.outline().indexOf("  New <https://new.test>")).toBeGreaterThan(a.bookmarks.outline().indexOf("Other bookmarks"));
  });

  it("does nothing switched off or signed out", async () => {
    const a = computer(server, { enabled: false });
    await a.bookmarks.create({ parentId: "1", title: "x", url: "https://x.test" });
    expect(await a.sync.sync()).toEqual({ state: "off" });
    a.state.enabled = true;
    a.state.signedIn = false;
    expect(await a.sync.sync()).toEqual({ state: "signed-out" });
    expect(server.requests).toEqual([]);
  });

  it("another account starts again with a merge; the state is kept in storage", async () => {
    const a = computer(server);
    await a.bookmarks.create({ parentId: "1", title: "x", url: "https://x.test" });
    await a.sync.sync();
    const stored = (await a.storage.get(BOOKMARK_SYNC_KEY))[BOOKMARK_SYNC_KEY] as { userId: string; rev: number; lastSyncAt?: string };
    expect(stored).toMatchObject({ userId: "u1", rev: 1, lastSyncAt: expect.any(String) });
    const other = new FakeBookmarkServer();
    const b = new BookmarkSync({
      bookmarks: a.bookmarks,
      storage: a.storage,
      account: async () => ({ userId: "u2", api: other.api() }),
      enabled: async () => true,
      now: tick,
    });
    await b.sync();
    expect([...other.rows.values()].map((r) => r.title)).toEqual(["x"]);
  });

  it("an error is kept for the settings page and the next sync tries again", async () => {
    const a = computer(server);
    await a.bookmarks.create({ parentId: "1", title: "x", url: "https://x.test" });
    const spy = vi.spyOn(server, "sync").mockImplementationOnce(() => {
      throw new Error("offline");
    });
    expect(await a.sync.sync()).toEqual({ state: "on", error: "offline" });
    spy.mockRestore();
    expect(await a.sync.sync()).toMatchObject({ state: "on", lastSyncAt: expect.any(String) });
    expect(server.rows.size).toBe(1);
  });

  it("bookmark events schedule a sync; the alarm pulls", async () => {
    vi.useFakeTimers();
    try {
      const a = computer(server);
      a.sync.listen();
      await a.bookmarks.create({ parentId: "1", title: "x", url: "https://x.test" });
      await vi.advanceTimersByTimeAsync(3500);
      expect(server.rows.size).toBe(1);
      expect(a.sync.onAlarm("other")).toBe(false);
      expect(a.sync.onAlarm(BOOKMARK_SYNC_ALARM)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bookmarkSyncNote", () => {
  it("says what the switch does, how the last sync went, or why it did not", async () => {
    const { bookmarkSyncNote, BOOKMARK_SYNC_HINT } = await import("../../src/options/bookmark-sync-view.js");
    const now = Date.parse("2026-09-28T10:10:00.000Z");
    expect(bookmarkSyncNote(false, { lastSyncAt: "2026-09-28T10:00:00.000Z" }, now)).toBe(BOOKMARK_SYNC_HINT);
    expect(bookmarkSyncNote(true, undefined, now)).toBe("Syncing…");
    expect(bookmarkSyncNote(true, { lastSyncAt: "2026-09-28T10:09:50.000Z" }, now)).toBe("Synced just now.");
    expect(bookmarkSyncNote(true, { lastSyncAt: "2026-09-28T10:00:00.000Z" }, now)).toBe("Synced 10 min ago.");
    expect(bookmarkSyncNote(true, { lastSyncAt: "2026-09-28T10:00:00.000Z", lastError: "offline" }, now)).toBe("Not synced: offline");
  });
});
