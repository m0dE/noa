import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@noa/shared";
import { MemoryKvDb } from "../memory-kv.js";
import { SessionStore } from "../../src/engine/sessions.js";
import { TraceStore } from "../../src/engine/trace-store.js";
import type { TraceBook } from "../../src/trace/trace-book.js";

const T0 = Date.parse("2026-09-26T10:00:00Z");
const info = (id: string): SessionInfo => ({ sessionId: id, source: "adhoc", title: id, brain: "claude-code", model: "claude-sonnet-5", jev: true, startedAt: new Date(T0).toISOString(), instructions: "find a flight" });

function stores(saveDelayMs = 60_000) {
  const db = new MemoryKvDb();
  let now = T0;
  const trace = new TraceStore(db, { saveDelayMs });
  const sessions = new SessionStore(db, { now: () => new Date(now), trace });
  return { db, trace, sessions, advance: (ms: number) => (now += ms) };
}

describe("conversation traces in the session store", () => {
  it("trace events go to the trace, never to the events or the live push; the conversation's events are counted", async () => {
    const { sessions, advance } = stores();
    const pushed: string[] = [];
    sessions.subscribe({ onEvent: (e) => pushed.push(e.type) });
    await sessions.create(info("a"));
    sessions.append("a", { type: "trace", trace: { t: T0 + 5, ms: 30, cat: "brain", name: "brain.resolve", src: "engine", data: { brain: "claude-code" } } });
    advance(1200);
    sessions.append("a", { type: "assistant_text_delta", id: "m", text: "Hi" });
    sessions.append("a", { type: "status", text: "working" });
    advance(800);
    sessions.append("a", { type: "task_end", outcome: "done" });
    await sessions.flush();
    expect((await sessions.eventsOf("a")).map((e) => e.type)).toEqual(["status", "task_end"]);
    expect(pushed).toEqual(["assistant_text_delta", "status", "task_end"]);
    const book = (await sessions.traceOf("a"))!;
    expect(book.events.map((e) => e.name)).toEqual(["turn.start", "brain.resolve", "first.response", "turn.end"]);
    expect(book.events[0]!.data).toMatchObject({ brain: "claude-code", model: "claude-sonnet-5", jev: true, chars: 13 });
    expect(book.turns[0]).toMatchObject({ deltas: 1, firstResponse: T0 + 1200, end: T0 + 2000, outcome: "done" });
  });

  it("the next turn of a stored conversation, and the panel's timings after it ended", async () => {
    const { sessions, advance } = stores();
    await sessions.create(info("a"));
    sessions.append("a", { type: "task_end", outcome: "done" });
    advance(60_000);
    await sessions.reopen("a", { turns: 2 });
    sessions.linkTrace("a", "u2");
    expect(await sessions.addTrace("a", [{ t: T0 + 59_000, ms: 900, cat: "voice", name: "voice.transcript", src: "panel", cid: "u2", data: { waitMs: 900 } }])).toBe(true);
    expect(await sessions.addTrace("nope", [])).toBe(false);
    await sessions.flush();
    const book = (await sessions.traceOf("a"))!;
    expect(book.turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(book.events.at(-1)).toMatchObject({ name: "voice.transcript", turn: 2 });
    expect(book.turns[1]!.voiceMs).toBe(900);
  });

  it("writes a book when its turn ends (and after a pause otherwise), and reads it back after a restart", async () => {
    const { db, trace, sessions } = stores();
    await sessions.create(info("a"));
    sessions.append("a", { type: "status", text: "x" });
    await Promise.resolve();
    const saved = () => db.data.get("traces")?.get("a") as TraceBook | undefined;
    expect(saved()).toBeUndefined();
    sessions.append("a", { type: "task_end", outcome: "done" });
    await sessions.flush();
    expect(saved()?.turns[0]?.outcome).toBe("done");
    // A fresh store (the service worker restarted) reads it from the database.
    const again = new TraceStore(db);
    expect((await again.get("a"))?.turns[0]?.outcome).toBe("done");
    await trace.delete("a");
    expect(saved()).toBeUndefined();
  });

  it("recording before the book is loaded applies once it is", async () => {
    const { db } = stores();
    const first = new TraceStore(db);
    first.start("a", T0);
    await first.flush();
    const second = new TraceStore(db);
    second.record("a", { t: T0 + 1, cat: "tool", name: "tool", src: "engine", ms: 5 });
    second.record("a", { t: T0 + 2, cat: "tool", name: "tool", src: "engine", ms: 7 });
    await second.flush();
    await second.flush();
    const book = (await second.get("a"))!;
    expect(book.events.map((e) => e.name)).toEqual(["turn.start", "tool", "tool"]);
    expect(book.turns[0]!.toolMs).toBe(12);
  });
});
