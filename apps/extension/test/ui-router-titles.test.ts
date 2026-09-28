import { beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@noa/shared";
import { SessionStore } from "../src/engine/sessions.js";
import { UiRouter, type UiRouterDeps } from "../src/engine/ui-router.js";
import type { UiRequest, UiResponse } from "../src/ui-protocol.js";
import { MemoryKvDb } from "./memory-kv.js";

let sessions: SessionStore;
let shown: string[][];
let unbound: [number, string][];
let closed: string[];
let req: <T = any>(r: UiRequest) => Promise<T>;

const at = (min: number) => new Date(Date.parse("2026-09-27T10:00:00Z") + min * 60_000).toISOString();
function session(id: string, min: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: `Title ${id}`, brain: "claude-api", jev: false, startedAt: at(min), endedAt: at(min + 1), outcome: "done", ...extra };
}

beforeEach(async () => {
  sessions = new SessionStore(new MemoryKvDb());
  shown = [];
  unbound = [];
  closed = [];
  // Only what these requests use: the sessions, the titler, the runner (what runs; closing a chat) and the tabs' chats.
  const deps = {
    sessions,
    titles: { shown: (list: readonly SessionInfo[]) => shown.push(list.map((s) => s.sessionId)) },
    runner: { runningSessions: [session("chat-running", 40, { endedAt: undefined, outcome: undefined })], newChat: async (id: string) => (closed.push(id), { ok: true }) },
    tabChats: { all: async () => ({ "7": "chat-old", "8": "chat-new" }), unbind: async (tab: number, id: string) => (unbound.push([tab, id]), id) },
  } as unknown as UiRouterDeps;
  const router = new UiRouter(deps);
  req = async (r) => {
    const res = (await router.handle(r)) as UiResponse<any>;
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };
  await sessions.create(session("chat-old", 0));
  await sessions.create(session("todo-run", 10, { source: "local", taskId: "t1", title: "Post the daily tip" }));
  await sessions.create(session("todo-chat", 20, { source: "local", taskId: "t2", turns: 2 }));
  await sessions.create(session("chat-new", 30));
});

describe("sessions.list for the jobs list", () => {
  it("every run, newest first, and asks for its chats' titles", async () => {
    const { sessions: list } = await req<{ sessions: SessionInfo[] }>({ type: "sessions.list", limit: 10 });
    expect(list.map((s) => s.sessionId)).toEqual(["chat-new", "todo-chat", "todo-run", "chat-old"]);
    expect(shown[0]).toHaveLength(4);
  });
});

describe("session.rename", () => {
  it("keeps the user's name (cleaned) and marks it theirs", async () => {
    const { session: s } = await req<{ session: SessionInfo }>({ type: "session.rename", sessionId: "chat-new", title: "  Web Store \n emails " });
    expect(s).toMatchObject({ title: "Web Store emails", titleBy: "user" });
    expect(await sessions.get("chat-new")).toMatchObject({ title: "Web Store emails", titleBy: "user" });
  });

  it("refuses an empty name, a secret, a TODO run and an unknown chat", async () => {
    await expect(req({ type: "session.rename", sessionId: "chat-new", title: "  " })).rejects.toThrow(/Give the chat a name/);
    await expect(req({ type: "session.rename", sessionId: "chat-new", title: "password is hunter22" })).rejects.toThrow(/can't hold a password/);
    // An older TODO run (its title is its instructions); a run that keeps them may be renamed (its series' name).
    await expect(req({ type: "session.rename", sessionId: "todo-run", title: "Mine" })).rejects.toThrow(/named by its task/);
    await sessions.create(session("todo-run-2", 11, { source: "local", taskId: "t1", title: "Post the daily tip", instructions: "Post the daily tip" }));
    expect((await req<{ session: SessionInfo }>({ type: "session.rename", sessionId: "todo-run-2", title: "Daily tip" })).session).toMatchObject({ title: "Daily tip", titleBy: "user" });
    await expect(req({ type: "session.rename", sessionId: "nope", title: "Mine" })).rejects.toThrow(/No session/);
    expect((await sessions.get("chat-new"))!.title).toBe("Title chat-new");
  });
});

describe("session.delete", () => {
  it("deletes a conversation that is not running: no tab keeps it, its agent session closes", async () => {
    expect(await req({ type: "session.delete", sessionId: "chat-old" })).toEqual({ ok: true });
    expect(await sessions.get("chat-old")).toBeNull();
    expect(unbound).toEqual([[7, "chat-old"]]);
    expect(closed).toEqual(["chat-old"]);
  });

  it("refuses a running conversation", async () => {
    await expect(req({ type: "session.delete", sessionId: "chat-running" })).rejects.toThrow(/stop it first/);
  });
});
