import { describe, expect, it } from "vitest";
import type { SessionInfo, StampedAgentEvent } from "@noa/shared";
import { MemoryKvDb } from "./memory-kv.js";
import { MAX_EVENTS_PER_SESSION, MAX_SESSIONS, SessionStore } from "../src/engine/sessions.js";

const info = (id: string, startedAt: string): SessionInfo => ({ sessionId: id, source: "adhoc", title: id, brain: "claude-api", jev: false, startedAt });

describe("SessionStore", () => {
  it("stores sessions and events in order and pushes them live", async () => {
    const store = new SessionStore(new MemoryKvDb(), { now: () => new Date("2026-09-24T10:00:00Z") });
    const pushed: string[] = [];
    store.subscribe({ onEvent: (e) => pushed.push(`e:${e.type}`), onSession: (s) => pushed.push(`s:${s.outcome ?? "running"}`) });
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    store.append("a", { type: "status", text: "one" });
    store.append("a", { type: "tool_result", id: "1", name: "screenshot", thumbnail: "x".repeat(300_000) });
    await store.update("a", { outcome: "done", endedAt: "2026-09-24T10:01:00Z" });
    const events = await store.eventsOf("a");
    expect(events.map((e) => e.type)).toEqual(["status", "tool_result"]);
    expect(events[0]).toEqual({ type: "status", text: "one", ts: "2026-09-24T10:00:00.000Z", sessionId: "a" });
    expect((events[1] as Extract<StampedAgentEvent, { type: "tool_result" }>).thumbnail).toBeUndefined();
    expect(pushed).toEqual(["s:running", "e:status", "e:tool_result", "s:done"]);
    expect(await store.get("a")).toMatchObject({ outcome: "done" });
  });

  it("live text deltas are pushed but never stored; the final text is stored (long answers kept up to MAX_ASSISTANT_TEXT)", async () => {
    const store = new SessionStore(new MemoryKvDb(), { now: () => new Date("2026-09-24T10:00:00Z") });
    const pushed: StampedAgentEvent[] = [];
    store.subscribe({ onEvent: (e) => pushed.push(e) });
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    for (const t of ["You ", "have ", "mail"]) store.append("a", { type: "assistant_text_delta", id: "m1:0", text: t });
    const answer = "x".repeat(6000);
    store.append("a", { type: "assistant_text", text: answer, id: "m1:0" });
    store.append("a", { type: "status", text: "after" });
    expect(pushed.map((e) => e.type)).toEqual(["assistant_text_delta", "assistant_text_delta", "assistant_text_delta", "assistant_text", "status"]);
    expect(pushed[0]).toEqual({ type: "assistant_text_delta", id: "m1:0", text: "You ", ts: "2026-09-24T10:00:00.000Z", sessionId: "a" });
    const events = await store.eventsOf("a");
    expect(events.map((e) => e.type)).toEqual(["assistant_text", "status"]);
    expect((events[0] as Extract<StampedAgentEvent, { type: "assistant_text" }>).text).toBe(answer);
  });

  it("reopen starts the next turn: events append after the stored ones, latest-turn fields are cleared", async () => {
    const db = new MemoryKvDb();
    const store = new SessionStore(db);
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    store.append("a", { type: "status", text: "one" });
    store.append("a", { type: "task_end", outcome: "done", summary: "s" });
    await store.update("a", { outcome: "done", endedAt: "2026-09-24T10:01:00Z", summary: "s", url: "u", reason: "r", suggestion: "Reply to Jordan" });
    // A new store (the service worker restarted) knows nothing of the sequence.
    const next = new SessionStore(db);
    const pushed: SessionInfo[] = [];
    next.subscribe({ onSession: (s) => pushed.push(s) });
    const s = await next.reopen("a", { turns: 2, startedAt: "2026-09-24T10:05:00Z" });
    expect(s).toEqual({ ...info("a", "2026-09-24T10:05:00Z"), turns: 2 });
    expect(pushed).toEqual([s]);
    next.append("a", { type: "user_message", text: "two" });
    const events = await next.eventsOf("a");
    expect(events.map((e) => e.type)).toEqual(["status", "task_end", "user_message"]);
    expect(await next.reopen("nope")).toBeNull();
  });

  it("note adds a spoken line to a conversation that ended (also after a restart), after its stored events", async () => {
    const db = new MemoryKvDb();
    const store = new SessionStore(db, { now: () => new Date("2026-09-24T10:00:00Z") });
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    store.append("a", { type: "user_message", text: "Read my mail", voice: true });
    store.append("a", { type: "task_end", outcome: "done", summary: "s" });
    await store.update("a", { outcome: "done", endedAt: "2026-09-24T10:01:00Z" });
    // The line is said after the turn ended: it must not overwrite the first event.
    expect(await store.note("a", { type: "spoken", text: "Sarah says dinner moved to eight." })).toMatchObject({ type: "spoken", sessionId: "a" });
    const restarted = new SessionStore(db);
    const pushed: string[] = [];
    restarted.subscribe({ onEvent: (e) => pushed.push(e.type) });
    await restarted.note("a", { type: "spoken", text: "Anything else?" });
    expect((await restarted.eventsOf("a")).map((e) => e.type)).toEqual(["user_message", "task_end", "spoken", "spoken"]);
    expect(pushed).toEqual(["spoken"]);
    expect(await restarted.note("nope", { type: "spoken", text: "x" })).toBeNull();
  });

  it("keeps the last MAX_EVENTS_PER_SESSION events", async () => {
    const store = new SessionStore(new MemoryKvDb());
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 5; i++) store.append("a", { type: "status", text: String(i) });
    const events = await store.eventsOf("a");
    expect(events).toHaveLength(MAX_EVENTS_PER_SESSION);
    expect(events[0]).toMatchObject({ text: "5" });
  });

  it("keeps the newest MAX_SESSIONS sessions and lists newest first", async () => {
    const db = new MemoryKvDb();
    const store = new SessionStore(db);
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      const id = `s${String(i).padStart(3, "0")}`;
      await store.create(info(id, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
      store.append(id, { type: "status", text: "x" });
    }
    const list = await store.list(1000);
    expect(list).toHaveLength(MAX_SESSIONS);
    expect(list[0]!.sessionId).toBe(`s${MAX_SESSIONS + 2}`);
    expect(await store.get("s000")).toBeNull();
    expect(await store.eventsOf("s000")).toEqual([]);
    expect(await store.list(2)).toHaveLength(2);
  });

  it("delete removes a conversation with its events; the others stay", async () => {
    const store = new SessionStore(new MemoryKvDb());
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    await store.create(info("b", "2026-09-24T11:00:00Z"));
    store.append("a", { type: "status", text: "x" });
    store.append("b", { type: "status", text: "y" });
    expect(await store.delete("a")).toBe(true);
    expect(await store.get("a")).toBeNull();
    expect(await store.eventsOf("a")).toEqual([]);
    expect((await store.list()).map((s) => s.sessionId)).toEqual(["b"]);
    expect(await store.eventsOf("b")).toHaveLength(1);
    expect(await store.delete("a")).toBe(false);
  });
});
