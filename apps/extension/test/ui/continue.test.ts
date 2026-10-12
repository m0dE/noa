import { describe, expect, it } from "vitest";
import type { AgentEvent, StampedAgentEvent } from "@noa/shared";
import {
  buildFollowUpInstructions,
  doneSoFar,
  isContinuableOutcome,
  lastAssistantText,
  lastTurnEvents,
  stopReason,
} from "../../src/continue.js";

const ev = (e: AgentEvent): StampedAgentEvent => ({ ...e, ts: "2026-09-24T10:00:00Z", sessionId: "s1" }) as StampedAgentEvent;

const EVENTS: StampedAgentEvent[] = [
  ev({ type: "status", text: "Started" }),
  ev({ type: "assistant_text", text: "Opening X." }),
  ev({ type: "tool_call", id: "1", name: "mcp__noa__navigate", args: { url: "https://www.x.com/home" } }),
  ev({ type: "tool_result", id: "1", name: "navigate", text: "\nOpened https://x.com/home (title: Home / X)\nsecond line" }),
  ev({ type: "tool_call", id: "2", name: "click", args: { index: 7 } }),
  ev({ type: "tool_result", id: "2", name: "click", text: "no element 7", isError: true }),
  ev({ type: "tool_call", id: "3", name: "screenshot", args: {} }),
  ev({ type: "tool_result", id: "3", name: "screenshot", thumbnail: "abc" }),
  ev({ type: "user_message", text: "use the second draft" }),
  ev({ type: "tool_call", id: "4", name: "type", args: { index: 9, text: "hello\nworld" } }),
  ev({ type: "assistant_text", text: "Typed it; pressing Post next." }),
];

describe("isContinuableOutcome", () => {
  it("paused, failed and retry runs; not done or running ones", () => {
    for (const o of ["paused", "failed", "retry"] as const) expect(isContinuableOutcome(o)).toBe(true);
    expect(isContinuableOutcome("done")).toBe(false);
    expect(isContinuableOutcome(undefined)).toBe(false);
  });
});

describe("doneSoFar", () => {
  it("lists tool calls with short args and the first line of their result, plus user messages", () => {
    expect(doneSoFar(EVENTS)).toEqual({
      steps: [
        "navigate x.com/home → Opened https://x.com/home (title: Home / X)",
        "click #7 → error: no element 7",
        "screenshot → (screenshot)",
        'the user said: "use the second draft"',
        'type #9 "hello world" → (no result)',
      ],
      skipped: 0,
    });
  });

  it("keeps the last steps only and counts the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => ev({ type: "tool_call", id: String(i), name: "press_key", args: { key: `K${i}` } }));
    const { steps, skipped } = doneSoFar(many);
    expect(steps).toHaveLength(15);
    expect(skipped).toBe(5);
    expect(steps[0]).toBe("press_key K5 → (no result)");
    expect(doneSoFar([])).toEqual({ steps: [], skipped: 0 });
  });
});

describe("continue helpers", () => {
  it("lastAssistantText, stopReason, lastTurnEvents", () => {
    expect(lastAssistantText(EVENTS)).toBe("Typed it; pressing Post next.");
    expect(lastAssistantText([])).toBeNull();
    expect(stopReason({ outcome: "paused", reason: "stopped by user" })).toBe("stopped by user");
    expect(stopReason({ outcome: "retry" })).toBe("a temporary problem");
    const end = ev({ type: "task_end", outcome: "done" });
    const second = [ev({ type: "user_message", text: "and now" }), ev({ type: "assistant_text", text: "ok" }), end];
    expect(lastTurnEvents([...EVENTS, end, ...second])).toEqual(second);
    expect(lastTurnEvents(EVENTS)).toEqual(EVENTS);
  });
});

describe("buildFollowUpInstructions", () => {
  it("after a finished turn: the first request, what was done, the result and the new message", () => {
    const text = buildFollowUpInstructions({
      instructions: "  Post on X from @alpha. Post: first  ",
      session: { outcome: "done", summary: "posted", url: "https://x.com/alpha/status/1" },
      events: EVENTS,
      text: "  Now like the first reply ",
    });
    expect(text.split("\n")[0]).toBe("--- Continuing a conversation ---");
    expect(text).toContain("<<<\nPost on X from @alpha. Post: first\n>>>");
    expect(text).toContain("What was done so far (oldest first):\n- navigate x.com/home");
    expect(text).toContain('the user said: "use the second draft"');
    expect(text).toContain("The last request finished: posted (https://x.com/alpha/status/1)");
    expect(text).toContain('The agent\'s last message: "Typed it; pressing Post next."');
    expect(text).toContain("The user's new message, which is what to do now:\n<<<\nNow like the first reply\n>>>");
    expect(text).toMatch(/never post the same thing twice/);
    expect(text).not.toMatch(/do not type it again/);
  });

  it("after a stopped turn: the reason and the do-not-repeat rules", () => {
    const text = buildFollowUpInstructions({ instructions: "x", session: { outcome: "paused", reason: "stopped by user" }, events: [], text: "go on" });
    expect(text).toContain("stopped before it finished (reason: stopped by user)");
    expect(text).toMatch(/do not type it again/);
    expect(text).not.toContain("What was done so far");
    expect(text).not.toContain("last message");
  });
});
