import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import { MILESTONE_GAP_MS } from "../../src/voice/milestones.js";
import { Narration } from "../../src/voice/narration.js";

const call = (name: string, args: unknown = {}): AgentEvent => ({ type: "tool_call", id: "1", name, args });

describe("Narration: the lines the Standard engine says while a task runs", () => {
  it("the plan, then milestones at most every MILESTONE_GAP_MS, then the result", () => {
    const n = new Narration();
    const said = (ev: AgentEvent, now: number) => n.push(ev, now);
    expect(said({ type: "user_message", text: "check my email" }, 0)).toBeNull();
    expect(said({ type: "assistant_text", text: "I'll open Gmail and read your unread emails. Starting now." }, 100)).toBe("I'll open Gmail and read your unread emails.");
    expect(said(call("navigate", { url: "https://mail.google.com" }), 200)).toBe("Opening mail.google.com");
    expect(said(call("read_page"), 1000)).toBeNull();
    expect(said(call("open_tabs", { urls: ["https://a.example/1", "https://a.example/2"] }), 200 + MILESTONE_GAP_MS)).toBe("Opening 2 tabs");
    // Later text is an answer or thinking out loud: never read out.
    expect(said({ type: "assistant_text", text: "You have **4 unread emails**. Here's what each needs: ..." }, 9000)).toBeNull();
    expect(said({ type: "task_end", outcome: "done", summary: "Summarized 4 unread emails", spoken: "You have four unread emails; Jordan needs a reply." }, 9500)).toBe(
      "You have four unread emails; Jordan needs a reply.",
    );
  });

  it("a long opening text is not a plan: nothing is said for it", () => {
    const n = new Narration();
    expect(n.push({ type: "assistant_text", text: `Here is everything: ${"detail ".repeat(60)}` }, 0)).toBeNull();
  });

  it("each turn gets its own plan and its first milestone at once", () => {
    const n = new Narration();
    n.push({ type: "assistant_text", text: "Opening X." }, 0);
    n.push(call("navigate", { url: "https://x.com" }), 10);
    n.push({ type: "task_end", outcome: "done" }, 20);
    n.push({ type: "user_message", text: "now like it" }, 30);
    expect(n.push({ type: "assistant_text", text: "Liking the post." }, 40)).toBe("Liking the post.");
    expect(n.push(call("navigate", { url: "https://x.com" }), 50)).toBe("Opening x.com");
  });

  it("an error is said once in plain words; the turn's end then does not repeat it", () => {
    const n = new Narration();
    expect(n.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 0)).toBe("Too many requests right now.");
    expect(n.push({ type: "task_end", outcome: "retry", reason: "Claude API rate limit (HTTP 429); gave up after 4 attempts" }, 10)).toBeNull();
    // With its own spoken line, the end is still said.
    const m = new Narration();
    m.push({ type: "error", text: "boom" }, 0);
    expect(m.push({ type: "task_end", outcome: "failed", reason: "boom", spoken: "Sorry, the page broke." }, 10)).toBe("Sorry, the page broke.");
  });

  it("a question (paused) is said", () => {
    expect(new Narration().push({ type: "task_end", outcome: "paused", reason: "Which account should I use?" }, 0)).toBe("Which account should I use?");
  });
});
