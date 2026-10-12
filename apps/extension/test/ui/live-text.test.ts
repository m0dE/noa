import { describe, expect, it } from "vitest";
import type { StampedAgentEvent } from "@noa/shared";
import { LiveTexts, MAX_LIVE } from "../../src/sidepanel/live-text.js";
import { describeEvent } from "../../src/sidepanel/event-format.js";
import { isLongSummary, toolArgsSummary } from "../../src/text.js";

const at = (sessionId: string) => (e: Record<string, unknown>) => ({ ts: "2026-09-25T00:00:00Z", sessionId, ...e }) as StampedAgentEvent;
const s1 = at("s1");
const delta = (id: string, text: string, ev = s1) => ev({ type: "assistant_text_delta", id, text }) as Extract<StampedAgentEvent, { type: "assistant_text_delta" }>;

describe("LiveTexts (chat append / replace)", () => {
  it("deltas append to their block; the final text replaces the live one, once", () => {
    const l = new LiveTexts();
    expect(l.add(delta("m1:0", "You have **4"))).toBe("You have **4");
    expect(l.add(delta("m1:0", " unread**"))).toBe("You have **4 unread**");
    expect(l.of("s1")).toEqual([["m1:0", "You have **4 unread**"]]);
    expect(l.settle(s1({ type: "assistant_text", text: "You have **4 unread** emails.", id: "m1:0" }))).toEqual({ replaces: "m1:0", drop: [], freeze: [] });
    expect(l.of("s1")).toEqual([]);
    // The same final again (a backfill) replaces nothing: it is rendered as an ordinary event.
    expect(l.settle(s1({ type: "assistant_text", text: "You have **4 unread** emails.", id: "m1:0" })).replaces).toBeNull();
  });

  it("text without an id (not streamed, e.g. the hosted AI) never replaces anything", () => {
    const l = new LiveTexts();
    l.add(delta("m1:0", "Hel"));
    expect(l.settle(s1({ type: "assistant_text", text: "Other" }))).toEqual({ replaces: null, drop: [], freeze: [] });
    expect(l.of("s1")).toEqual([["m1:0", "Hel"]]);
  });

  it("two text blocks of one message are settled one by one", () => {
    const l = new LiveTexts();
    l.add(delta("m1:0", "First"));
    l.add(delta("m1:2", "Second"));
    expect(l.settle(s1({ type: "assistant_text", text: "First", id: "m1:0" }))).toEqual({ replaces: "m1:0", drop: [], freeze: [] });
    expect(l.of("s1")).toEqual([["m1:2", "Second"]]);
    expect(l.settle(s1({ type: "assistant_text", text: "Second", id: "m1:2" })).replaces).toBe("m1:2");
  });

  it("a retried request: the abandoned message's live text is dropped when the next message's final arrives", () => {
    const l = new LiveTexts();
    l.add(delta("m1:0", "Half an ans"));
    l.add(delta("m2:0", "The whole answer"));
    expect(l.settle(s1({ type: "assistant_text", text: "The whole answer", id: "m2:0" }))).toEqual({ replaces: "m2:0", drop: ["m1:0"], freeze: [] });
  });

  it("task_end: what is still live stays as written (frozen); other conversations are untouched", () => {
    const l = new LiveTexts();
    l.add(delta("m1:0", "Cut off by Stop"));
    l.add(delta("x1:0", "other chat", at("s2")));
    expect(l.settle(s1({ type: "task_end", outcome: "paused", reason: "stopped by user" }))).toEqual({ replaces: null, drop: [], freeze: ["m1:0"] });
    expect(l.of("s2")).toEqual([["x1:0", "other chat"]]);
    // Tool calls and other events change nothing.
    expect(l.settle(at("s2")({ type: "tool_call", id: "1", name: "navigate", args: {} }))).toEqual({ replaces: null, drop: [], freeze: [] });
  });

  it("keeps at most MAX_LIVE texts, forgetting other conversations' first", () => {
    const l = new LiveTexts();
    for (let k = 0; k < MAX_LIVE + 5; k++) l.add(delta(`o${k}:0`, "x", at(`other${k}`)));
    l.add(delta("m1:0", "mine"));
    expect(l.of("s1")).toEqual([["m1:0", "mine"]]);
    expect(l.of("other0")).toEqual([]);
  });
});

describe("answers in the chat, short summaries in the end card", () => {
  const answer = "Here's how:\n\n## 1. Prepare\n- Zip it";
  it("a long task_end summary is marked long (shown as a message above the outcome line)", () => {
    expect(isLongSummary("Posted the thread")).toBe(false);
    expect(isLongSummary(answer)).toBe(true);
    expect(isLongSummary("x".repeat(200))).toBe(true);
    expect(describeEvent({ type: "task_end", outcome: "done", summary: answer })).toMatchObject({ kind: "end", text: answer, long: true });
    expect(describeEvent({ type: "task_end", outcome: "done", summary: "Answered" })).not.toHaveProperty("long");
  });
  it("the task_complete step does not repeat a long summary", () => {
    expect(toolArgsSummary("task_complete", { summary: answer })).toBe("");
    expect(toolArgsSummary("task_complete", { summary: "Answered the question" })).toBe("Answered the question");
  });
  it("streamed text keeps its block id", () => {
    expect(describeEvent({ type: "assistant_text", text: " **hi** ", id: "m:0" })).toEqual({ kind: "text", text: "**hi**", id: "m:0" });
  });
});
