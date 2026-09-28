import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@noa/shared";
import { addEvent, beginTurn, linkCid, newBook, observe, TRACE_CAPS, turnOf } from "../../src/trace/trace-book.js";

const T0 = Date.parse("2026-09-26T10:00:00Z");
const ev = (e: Partial<TraceEvent> & Pick<TraceEvent, "t" | "cat" | "name">): TraceEvent => ({ src: "engine", ...e });

describe("trace book", () => {
  it("assigns events to turns: their own, their message's (correlation id), else the running one", () => {
    const book = newBook("s");
    beginTurn(book, 1, T0, { brain: "claude-code" });
    linkCid(book, "u1");
    beginTurn(book, 2, T0 + 60_000);
    // The panel's voice timings of turn 1's message arrive after turn 2 started: they still join turn 1.
    const late = addEvent(book, ev({ t: T0 - 900, ms: 700, cat: "voice", name: "voice.transcript", src: "panel", cid: "u1", data: { waitMs: 700 } }));
    const running = addEvent(book, ev({ t: T0 + 61_000, ms: 50, cat: "tool", name: "tool" }));
    const own = addEvent(book, ev({ t: T0 + 61_000, cat: "brain", name: "x", turn: 1 }));
    expect([late.turn, running.turn, own.turn]).toEqual([1, 2, 1]);
    // Turn 1's clock starts at its earliest event (the voice before the engine started it).
    expect(turnOf(book, 1)!.first).toBe(T0 - 900);
    expect(turnOf(book, 1)!.voiceMs).toBe(700);
    expect(turnOf(book, 2)!.toolMs).toBe(50);
  });

  it("adds up model calls, tokens, cost, tools, Jev and errors per turn", () => {
    const book = newBook("s");
    beginTurn(book, 1, T0);
    addEvent(book, ev({ t: T0 + 10, ms: 4000, cat: "model", name: "model.call", data: { inTokens: 10, outTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 } }));
    addEvent(book, ev({ t: T0 + 5000, ms: 3000, cat: "model", name: "model.call", data: { inTokens: 5, outTokens: 100 } }));
    // A retry wait is model-side time, but not a call.
    addEvent(book, ev({ t: T0 + 9000, ms: 1000, cat: "model", name: "model.wait" }));
    addEvent(book, ev({ t: T0 + 4100, ms: 800, cat: "tool", name: "tool", data: { tool: "read_page" } }));
    addEvent(book, ev({ t: T0 + 9100, cat: "brain", name: "claude.result", data: { costUsd: 0.0123 } }));
    addEvent(book, ev({ t: T0 + 9200, cat: "error", name: "voice.failed" }));
    observe(book, { type: "jev", goal: "click Search", operation: "click", index: 3, confidence: 0.9, executed: true, ms: 420 }, T0 + 4500);
    const t = turnOf(book, 1)!;
    expect(t).toMatchObject({ modelCalls: 2, modelMs: 7000, toolCalls: 1, toolMs: 800, jevPicks: 1, jevMs: 420, errors: 1, costUsd: 0.0123 });
    expect(t.tokens).toEqual({ in: 15, out: 300, cacheRead: 5000, cacheWrite: 300 });
  });

  it("counts the stream instead of recording it, and records the first response and the turn's end once", () => {
    const book = newBook("s");
    beginTurn(book, 1, T0);
    linkCid(book, "c1");
    for (let i = 0; i < 50; i++) observe(book, { type: "assistant_text_delta", id: "m:0", text: "x" }, T0 + 1000 + i * 10);
    observe(book, { type: "assistant_text", id: "m:0", text: "hello" }, T0 + 1600);
    observe(book, { type: "tool_call", id: "t1", name: "read_page", args: {} }, T0 + 1700);
    observe(book, { type: "task_end", outcome: "done" }, T0 + 5000);
    observe(book, { type: "task_end", outcome: "done" }, T0 + 6000);
    const t = turnOf(book, 1)!;
    expect(t).toMatchObject({ deltas: 50, firstDelta: T0 + 1000, lastDelta: T0 + 1490, texts: 1, lastText: T0 + 1600, firstResponse: T0 + 1000, end: T0 + 5000, outcome: "done" });
    // No per-token events: the first response (naming its message) and the turn's end, besides the start.
    expect(book.events.map((e) => e.name)).toEqual(["turn.start", "first.response", "turn.end"]);
    expect(book.events[1]).toMatchObject({ t: T0, ms: 1000, cid: "c1", data: { via: "text" } });
    expect(book.events[2]).toMatchObject({ ms: 5000, data: { outcome: "done" } });
  });

  it("a message typed into a running turn waits for its own first response", () => {
    const book = newBook("s");
    beginTurn(book, 1, T0);
    observe(book, { type: "tool_call", id: "t1", name: "navigate", args: {} }, T0 + 800);
    linkCid(book, "c2");
    observe(book, { type: "user_message", text: "also check Saturday" }, T0 + 10_000);
    observe(book, { type: "assistant_text", id: "m", text: "ok" }, T0 + 12_500);
    const firsts = book.events.filter((e) => e.name === "first.response");
    expect(firsts.map((e) => [e.t - T0, e.ms, e.cid])).toEqual([
      [0, 800, undefined],
      [10_000, 2500, "c2"],
    ]);
    expect(turnOf(book, 1)!.userMessages).toBe(1);
  });

  it("keeps the newest events, turns and correlation ids within the caps; totals still count dropped events", () => {
    const book = newBook("s");
    beginTurn(book, 1, T0);
    const n = TRACE_CAPS.events + 250;
    for (let i = 0; i < n; i++) addEvent(book, ev({ t: T0 + i, ms: 2, cat: "tool", name: "tool" }));
    expect(book.events).toHaveLength(TRACE_CAPS.events);
    expect(book.dropped).toBe(n + 1 - TRACE_CAPS.events);
    expect(book.events.at(-1)!.t).toBe(T0 + n - 1);
    expect(turnOf(book, 1)!.toolCalls).toBe(n);

    for (let i = 2; i <= TRACE_CAPS.turns + 20; i++) {
      beginTurn(book, i, T0 + i * 1000);
      linkCid(book, `c${i}`);
    }
    expect(book.turns).toHaveLength(TRACE_CAPS.turns);
    expect(book.turns[0]!.turn).toBe(21);
    expect(Object.keys(book.cids)).toHaveLength(TRACE_CAPS.cids);
    expect(book.cids[`c${TRACE_CAPS.turns + 20}`]).toBe(TRACE_CAPS.turns + 20);
  });

  it("stays small: a long turn's book serializes to well under a megabyte", () => {
    const book = newBook("s");
    beginTurn(book, 1, T0);
    for (let i = 0; i < 5000; i++) addEvent(book, ev({ t: T0 + i, ms: 1, cat: "browser", name: "browser.readPage", data: { driver: "cdp", elements: 400, chars: 16000 } }));
    for (let i = 0; i < 20_000; i++) observe(book, { type: "assistant_text_delta", id: "m", text: "token " }, T0 + i);
    expect(JSON.stringify(book).length).toBeLessThan(200_000);
  });
});
