import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import { PROGRESS } from "../../src/voice/milestones.js";
import { NarratorFeed } from "../../src/voice/realtime-feed.js";

const call = (name: string, args: unknown = {}): AgentEvent => ({ type: "tool_call", id: "1", name, args });
const GAP = PROGRESS.stepGapMs;

describe("NarratorFeed: the chat's events as short notes for the realtime narrator", () => {
  it("what only echoes the request is not passed on: the voice message, the user's words, the agent restating it, routine steps", () => {
    const feed = new NarratorFeed();
    feed.request(0);
    feed.spoke(5);
    expect(feed.push({ type: "user_message", text: "Check my inbox.", voice: true }, 10)).toEqual([]);
    expect(feed.push({ type: "heard", text: "Check my inbox." }, 20)).toEqual([]);
    expect(feed.push({ type: "assistant_text", text: "I'll open your Gmail inbox and summarize the important emails." }, 30)).toEqual([]);
    for (const [i, name] of ["click", "act", "scroll", "switch_tab", "wait_for"].entries()) expect(feed.push(call(name), GAP * (i + 2))).toEqual([]);
  });

  it("a new step is progress, said as it is (line), with the agent's latest words as context, PROGRESS.stepGapMs after anything said", () => {
    const feed = new NarratorFeed();
    feed.request(0);
    // The acknowledgement was said.
    feed.spoke(100);
    feed.push({ type: "assistant_text", text: "This is the personal inbox; switching to the admin account." }, 200);
    expect(feed.push(call("navigate", { url: "https://accounts.google.com/" }), 100 + GAP - 1)).toEqual([]);
    expect(feed.push(call("navigate", { url: "https://calendar.google.com/" }), 100 + GAP)).toEqual([
      {
        text: 'Your update (progress): Opening calendar.google.com. (You last wrote: "This is the personal inbox; switching to the admin account.")',
        speak: "milestone",
        line: "Opening calendar.google.com",
      },
    ]);
    // The same site again is not new; the next new one waits for the gap.
    expect(feed.push(call("navigate", { url: "https://calendar.google.com/x" }), 100 + GAP * 3)).toEqual([]);
    expect(feed.push(call("navigate", { url: "https://drive.google.com/" }), 100 + GAP + 10)).toEqual([]);
  });

  it("while the agent works, a long silence gets one 'Still …' line about what it does now (tick)", () => {
    const feed = new NarratorFeed();
    feed.request(0);
    feed.spoke(100);
    feed.push(call("read_page"), 1_000);
    expect(feed.tick(100 + PROGRESS.stillWorkingMs - 1)).toEqual([]);
    expect(feed.tick(100 + PROGRESS.stillWorkingMs)).toEqual([{ text: "Your update (progress): Still reading the page.", speak: "milestone", line: "Still reading the page" }]);
    expect(feed.tick(100 + PROGRESS.stillWorkingMs * 3)).toEqual([]);
  });

  it("never passes on what the agent types or what pages say", () => {
    const feed = new NarratorFeed();
    feed.request(0);
    const notes = [
      ...feed.push(call("act", { steps: [{ goal: "type the password", text: "hunter2" }] }), GAP),
      ...feed.push({ type: "tool_result", id: "1", name: "read_page", text: "SECRET PAGE TEXT" }, GAP * 2),
      ...feed.push({ type: "task_end", outcome: "done", summary: "Signed in", spoken: "You're signed in." }, GAP * 3),
    ];
    expect(notes.map((n) => n.text).join(" ")).not.toMatch(/hunter2|SECRET/);
  });

  it("the end of a task is said at once: the agent's spoken line, in full", () => {
    const feed = new NarratorFeed();
    feed.request(0);
    feed.push(call("navigate", { url: "https://x.com/home" }), 100);
    expect(feed.push({ type: "task_end", outcome: "done", summary: "Posted the thread", spoken: "Posted your thread on X." }, 500)).toEqual([
      { text: 'Your update (finished): The task is done. Tell the user in one to three short sentences, in the first person: "Posted your thread on X."', speak: "result" },
    ]);
  });

  it("a paused task is a question to ask; a failure and an error say what went wrong; the same line is never said twice", () => {
    const feed = new NarratorFeed();
    expect(feed.push({ type: "task_end", outcome: "paused", reason: "Which account should I post from?" }, 0)).toEqual([
      { text: 'Your update (you need the user): Your question: "Which account should I post from?" Ask the user, and give their answer to send_to_agent.', speak: "question" },
    ]);
    expect(feed.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 0)).toEqual([
      { text: 'Your update (problem): "Too many requests right now." Tell the user briefly, in the first person.', speak: "error" },
    ]);
    expect(feed.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 5)).toEqual([]);
    expect(feed.push({ type: "task_end", outcome: "failed", reason: "The site kept timing out" }, 0)[0]!.text).toBe(
      'Your update (finished): The task did not work. Tell the user in one to three short sentences, in the first person: "That didn\'t work: The site kept timing out"',
    );
  });

  it("a message typed in the panel is noted as context only", () => {
    const feed = new NarratorFeed();
    expect(feed.push({ type: "user_message", text: "use the second draft" }, 0)).toEqual([
      { text: 'Your update: the user typed you a message: "use the second draft". Do not reply to it.', speak: null },
    ]);
  });

  it("ignores status lines, Jev picks and live text deltas", () => {
    const feed = new NarratorFeed();
    expect(feed.push({ type: "status", text: "Claude API (claude-sonnet-5)" }, 0)).toEqual([]);
    expect(feed.push({ type: "jev", goal: "x", operation: "click", index: 1, confidence: 1, executed: true, ms: 1 }, 0)).toEqual([]);
    expect(feed.push({ type: "assistant_text_delta", id: "m:0", text: "Hel" }, 0)).toEqual([]);
  });
});
