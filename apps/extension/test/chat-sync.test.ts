import type { ChatChanges, ChatUpload, CloudChat, SessionInfo } from "@noa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_SYNC_ALARM, ChatSync, chatFingerprint, eventsToSend, type ChatSyncApi } from "../src/chat-sync.js";
import { MAX_SESSIONS, SessionStore } from "../src/engine/sessions.js";
import { ApiRequestError } from "../src/http-client.js";
import { memoryStorageArea } from "./chrome-fake.js";
import { MemoryKvDb } from "./memory-kv.js";

let clock = Date.parse("2026-10-20T10:00:00.000Z");
const tick = () => new Date((clock += 60_000));

/** The account server's chat history (as apps/api/src/routes/chats.ts keeps it), per user. */
class FakeChatServer {
  readonly users = new Map<string, { rev: number; chats: Map<string, CloudChat & { rev: number; events: Record<string, unknown>[] }> }>();
  puts = 0;
  page = 200;

  private user(id: string) {
    let u = this.users.get(id);
    if (!u) this.users.set(id, (u = { rev: 0, chats: new Map() }));
    return u;
  }

  api(userId: string): ChatSyncApi {
    const u = () => this.user(userId);
    return {
      chatChanges: async (since: number): Promise<ChatChanges> => {
        const changed = [...u().chats.values()].filter((c) => c.rev > since).sort((a, b) => a.rev - b.rev);
        const page = changed.slice(0, this.page);
        const more = changed.length > page.length;
        return { rev: more ? page.at(-1)!.rev : u().rev, more, chats: page.map(({ sessionId, updatedAt, deleted, info }) => ({ sessionId, updatedAt, deleted, info })) };
      },
      putChat: async (chat: ChatUpload) => {
        this.puts++;
        const had = u().chats.get(chat.info.sessionId);
        if (had && had.updatedAt > chat.updatedAt) return { rev: u().rev, stored: false };
        const rev = ++u().rev;
        u().chats.set(chat.info.sessionId, { sessionId: chat.info.sessionId, updatedAt: chat.updatedAt, deleted: false, info: chat.info, rev, events: chat.events });
        return { rev, stored: true };
      },
      chatEvents: async (id: string) => u().chats.get(id)?.events ?? [],
      deleteChat: async (id: string) => {
        const rev = ++u().rev;
        u().chats.set(id, { sessionId: id, updatedAt: tick().toISOString(), deleted: true, info: null, rev, events: [] });
      },
    };
  }

  live(userId: string): string[] {
    return [...(this.users.get(userId)?.chats.values() ?? [])].filter((c) => !c.deleted).map((c) => c.sessionId).sort();
  }
}

/** One computer: its conversations and its chat sync as `userId` (signed out: null). */
function computer(server: FakeChatServer, opts: { userId?: string | null } = {}) {
  const sessions = new SessionStore(new MemoryKvDb(), { now: tick });
  const state = { userId: opts.userId === undefined ? "u1" : opts.userId, running: [] as string[], changed: 0 };
  const sync = new ChatSync({
    sessions,
    storage: memoryStorageArea(),
    account: async () => (state.userId ? { userId: state.userId, api: server.api(state.userId) } : null),
    running: () => state.running,
    onChanged: () => state.changed++,
    now: tick,
  });
  /** A chat of one turn: its request, the answer, ended. */
  async function chat(id: string, text = `request ${id}`, startedAt = tick().toISOString()): Promise<SessionInfo> {
    await sessions.create({ sessionId: id, source: "adhoc", title: text, brain: "noa", jev: false, startedAt, instructions: text });
    sessions.append(id, { type: "user_message", text });
    sessions.append(id, { type: "tool_result", id: "t1", name: "screenshot", thumbnail: "AAAA", text: "a page" });
    sessions.append(id, { type: "assistant_text", text: `answer to ${text}` });
    return (await sessions.update(id, { endedAt: tick().toISOString(), outcome: "done" }))!;
  }
  return { sessions, sync, state, chat };
}

let server: FakeChatServer;
beforeEach(() => {
  server = new FakeChatServer();
});

const ids = async (c: ReturnType<typeof computer>) => (await c.sessions.list(MAX_SESSIONS)).map((s) => s.sessionId).sort();

describe("ChatSync", () => {
  it("signing in on another computer brings back the chats, with their conversations", async () => {
    const a = computer(server);
    await a.chat("s1", "find flights to Lisbon");
    await a.chat("s2", "summarize my inbox");
    await a.sync.sync();
    expect(server.live("u1")).toEqual(["s1", "s2"]);

    const b = computer(server);
    await b.sync.sync();
    expect(await ids(b)).toEqual(["s1", "s2"]);
    expect(await b.sessions.get("s1")).toEqual(await a.sessions.get("s1"));
    const events = await b.sessions.eventsOf("s1");
    expect(events.map((e) => e.type)).toEqual(["user_message", "tool_result", "assistant_text"]);
    expect(events[0]).toMatchObject({ text: "find flights to Lisbon", sessionId: "s1" });
    // The picture stays on the computer it was taken on; the tool's words come.
    expect(events[1]).not.toHaveProperty("thumbnail");
    expect(events[1]).toMatchObject({ text: "a page" });
    expect(b.state.changed).toBe(1);
  });

  it("chats made signed out go to the account signed in next", async () => {
    const a = computer(server, { userId: null });
    await a.chat("s1");
    await a.sync.sync();
    expect(server.live("u1")).toEqual([]);
    a.state.userId = "u1";
    await a.sync.sync();
    expect(server.live("u1")).toEqual(["s1"]);
  });

  it("sends a chat once, again when it changes (a new turn, a rename), and never what the account sent", async () => {
    const a = computer(server);
    await a.chat("s1");
    await a.sync.sync();
    await a.sync.sync({ pull: true });
    expect(server.puts).toBe(1);
    await a.sessions.retitle("s1", "Lisbon trip", "user");
    await a.sync.sync();
    expect(server.puts).toBe(2);

    const b = computer(server);
    await b.sync.sync();
    await b.sync.sync({ pull: true });
    expect(server.puts).toBe(2);
    expect((await b.sessions.get("s1"))!.title).toBe("Lisbon trip");
    // Renamed on B: A takes the new name and does not send it back.
    await b.sessions.retitle("s1", "Lisbon in May", "user");
    await b.sync.sync();
    await a.sync.sync({ pull: true });
    expect((await a.sessions.get("s1"))!.title).toBe("Lisbon in May");
    await a.sync.sync({ pull: true });
    expect(server.puts).toBe(3);
  });

  it("a running conversation is sent once it ends, and is never replaced while it runs", async () => {
    const a = computer(server);
    await a.sessions.create({ sessionId: "s1", source: "adhoc", title: "t", brain: "noa", jev: false, startedAt: tick().toISOString() });
    a.state.running = ["s1"];
    await a.sync.sync();
    expect(server.live("u1")).toEqual([]);
    await a.sessions.update("s1", { endedAt: tick().toISOString(), outcome: "done" });
    a.state.running = [];
    await a.sync.sync();
    expect(server.live("u1")).toEqual(["s1"]);
  });

  it("a chat deleted on one computer goes from the account and the others", async () => {
    const a = computer(server);
    await a.chat("s1");
    await a.chat("s2");
    await a.sync.sync();
    const b = computer(server);
    await b.sync.sync();
    expect(await b.sessions.delete("s1")).toBe(true);
    await b.sync.deleted("s1");
    await b.sync.sync();
    expect(server.live("u1")).toEqual(["s2"]);
    await a.sync.sync({ pull: true });
    expect(await ids(a)).toEqual(["s2"]);
  });

  it("a deletion made signed out is sent when that account signs in again", async () => {
    const a = computer(server);
    await a.chat("s1");
    await a.sync.sync();
    a.state.userId = null;
    await a.sessions.delete("s1");
    await a.sync.deleted("s1");
    await a.sync.sync();
    expect(server.live("u1")).toEqual(["s1"]);
    a.state.userId = "u1";
    await a.sync.sync();
    expect(server.live("u1")).toEqual([]);
  });

  it("one account's chats never go to another signed in on the same computer", async () => {
    const a = computer(server);
    await a.chat("mine");
    await a.sync.sync();
    a.state.userId = "u2";
    await a.chat("theirs");
    await a.sync.sync();
    expect(server.live("u1")).toEqual(["mine"]);
    expect(server.live("u2")).toEqual(["theirs"]);
  });

  it("takes only the newest chats that fit here, page after page", async () => {
    server.page = 50;
    const api = server.api("u1");
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_SESSIONS + 30; i++) {
      const at = new Date(start + i * 60_000).toISOString();
      await api.putChat({ info: { sessionId: `c${String(i).padStart(3, "0")}`, source: "adhoc", title: `chat ${i}`, startedAt: at, endedAt: at }, updatedAt: at, events: [] });
    }
    const b = computer(server);
    await b.sync.sync();
    const have = await ids(b);
    expect(have).toHaveLength(MAX_SESSIONS);
    expect(have[0]).toBe("c030");
    expect(have.at(-1)).toBe(`c${MAX_SESSIONS + 29}`);
  });

  it("a chat the account refuses (too long) stays here and does not stop the others", async () => {
    const a = computer(server);
    await a.chat("big");
    await a.chat("small");
    const api = server.api("u1");
    const put = api.putChat;
    api.putChat = async (c) => {
      if (c.info.sessionId === "big") throw new ApiRequestError(413, "This chat is too long to keep in the account");
      return put(c);
    };
    const sync = new ChatSync({ sessions: a.sessions, storage: memoryStorageArea(), account: async () => ({ userId: "u1", api }), running: () => [], now: tick });
    await sync.sync();
    expect(server.live("u1")).toEqual(["small"]);
  });

  it("the alarm pulls", async () => {
    const a = computer(server);
    expect(a.sync.onAlarm("other")).toBe(false);
    expect(a.sync.onAlarm(CHAT_SYNC_ALARM)).toBe(true);
  });
});

describe("eventsToSend", () => {
  it("leaves pictures out, and tool output too when the chat is still too long", () => {
    const base = { ts: "t", sessionId: "s" };
    expect(eventsToSend([{ type: "tool_result", id: "1", name: "x", thumbnail: "AAA", text: "words", ...base }])).toEqual([{ type: "tool_result", id: "1", name: "x", text: "words", ...base }]);
    const huge = "x".repeat(3 * 1024 * 1024);
    const sent = eventsToSend([
      { type: "tool_result", id: "1", name: "x", text: huge, ...base },
      { type: "tool_result", id: "2", name: "x", text: huge, ...base },
      { type: "assistant_text", text: "answer", ...base },
    ]);
    expect(sent).toEqual([{ type: "tool_result", id: "1", name: "x", ...base }, { type: "tool_result", id: "2", name: "x", ...base }, { type: "assistant_text", text: "answer", ...base }]);
    expect(eventsToSend([{ type: "assistant_text", text: "y".repeat(5 * 1024 * 1024), ...base }])).toBeNull();
  });

  it("fingerprints what tells copies apart", () => {
    const s = { endedAt: "e", title: "t", turns: 2 };
    expect(chatFingerprint(s)).toBe(chatFingerprint({ ...s }));
    expect(chatFingerprint(s)).not.toBe(chatFingerprint({ ...s, title: "u" }));
    expect(chatFingerprint(s)).not.toBe(chatFingerprint({ ...s, turns: 3 }));
  });
});
