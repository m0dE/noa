import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import { PROGRESS } from "../../src/voice/milestones.js";
import { Narration, PLAN_HOLD_MS } from "../../src/voice/narration.js";

const call = (name: string, args: unknown = {}): AgentEvent => ({ type: "tool_call", id: "1", name, args });

describe("Narration: the lines the Standard engine says while a task runs", () => {
  it("the plan once the agent goes on to work, then a line for each new step at most every PROGRESS.stepGapMs, then the result", () => {
    const n = new Narration();
    const said = (ev: AgentEvent, now: number) => n.push(ev, now);
    expect(said({ type: "user_message", text: "check my email" }, 0)).toBeNull();
    expect(said({ type: "assistant_text", text: "I'll open Gmail and read your unread emails. Starting now." }, 100)).toBeNull();
    expect(said(call("navigate", { url: "https://mail.google.com" }), 200)).toBe("I'll open Gmail and read your unread emails.");
    expect(said(call("read_page"), 1000)).toBeNull();
    expect(said(call("open_tabs", { urls: ["https://a.example/1", "https://a.example/2"] }), 200 + PROGRESS.stepGapMs)).toBe("Opening 2 tabs");
    // Later text is an answer or thinking out loud: never read out.
    expect(said({ type: "assistant_text", text: "You have **4 unread emails**. Here's what each needs: ..." }, 9000)).toBeNull();
    expect(said({ type: "task_end", outcome: "done", summary: "Summarized 4 unread emails", spoken: "You have four unread emails; Jordan needs a reply." }, 9500)).toBe(
      "You have four unread emails; Jordan needs a reply.",
    );
  });

  it("a greeting answered at once is said once, by the turn's end (a real trace: it was said twice)", () => {
    const n = new Narration();
    n.push({ type: "user_message", text: "Hey, how are you doing?" }, 0);
    expect(n.push({ type: "assistant_text", text: "I'm doing well, thanks for asking! Ready to help with whatever you need." }, 100)).toBeNull();
    expect(n.push(call("task_complete", { summary: "Replied to greeting" }), 900)).toBeNull();
    expect(
      n.push({ type: "task_end", outcome: "done", summary: "Replied to greeting", spoken: "I'm doing well, thanks for asking! What can I help you with?" }, 1000),
    ).toBe("I'm doing well, thanks for asking! What can I help you with?");
    n.push({ type: "user_message", text: "hi" }, 2000);
    expect(n.push({ type: "assistant_text", text: "Hi there!" }, 2100)).toBeNull();
    expect(n.push({ type: "task_end", outcome: "done", spoken: "Hi there!" }, 2200)).toBe("Hi there!");
    // The next turn says it again when asked: only this turn's lines count.
    n.push({ type: "user_message", text: "say that one more time" }, 3000);
    expect(n.push({ type: "task_end", outcome: "done", spoken: "Hi there! What can I help you with?" }, 3100)).toBe("Hi there! What can I help you with?");
  });

  it("real Claude Code greetings (2026-09-30): nothing said twice, in a turn or from the turn before", () => {
    const n = new Narration();
    const turn = (user: string, events: AgentEvent[]) => {
      const said: string[] = [];
      for (const ev of [{ type: "user_message", text: user } as AgentEvent, ...events]) {
        const line = n.push(ev, 0);
        if (line) said.push(line);
      }
      return said;
    };
    const text = (t: string): AgentEvent => ({ type: "assistant_text", text: t });
    const end = (spoken: string): AgentEvent => ({ type: "task_end", outcome: "done", summary: "Replied", spoken });
    expect(
      turn("Hi! How's it going?", [
        text("I'm doing well, thanks for asking! I'm ready to help whenever you need something from your inbox or elsewhere."),
        end("I'm doing well, thanks for asking! Let me know what you'd like help with."),
      ]),
    ).toEqual(["I'm doing well, thanks for asking! Let me know what you'd like help with."]);
    // Each answer is said once, by its turn's end (the openings were the answers).
    expect(
      turn("Good morning, how are you?", [
        text("I'm doing well, thanks for asking! Let me know what you'd like help with next."),
        text("Good morning! I'm doing great, thanks for asking — though it looks like it's actually evening for you (around 7:36 PM). Anything I can help with?"),
        end("Good morning! I'm doing great. Just so you know, it's actually evening where you are, around 7:36 PM."),
      ]),
    ).toEqual(["Good morning! I'm doing great. Just so you know, it's actually evening where you are, around 7:36 PM."]);
    expect(
      turn("Hey there, you doing okay?", [
        text("Good morning! I'm doing great, thanks for asking — though a heads up, it's actually about 7:36 PM for you right now, not morning. Anything I can help with?"),
        text("Hey! Yes, I'm doing okay, thanks for checking in. Let me know if there's anything you'd like me to help with."),
        end("Hey! Yes, I'm doing okay, thanks for checking in. Let me know if you need anything."),
      ]),
    ).toEqual(["Hey! Yes, I'm doing okay, thanks for checking in. Let me know if you need anything."]);
    expect(
      turn("What's up?", [text("Not much! Just here, ready to help whenever you need something — whether it's checking your inbox or anything else."), end("Not much, just here and ready to help whenever you need something.")]),
    ).toEqual(["Not much, just here and ready to help whenever you need something."]);
    // Asked to say it again: said again (the turn before does not count for its end).
    expect(turn("Say that one more time.", [text("Not much! Just here and ready to help."), end("Not much, just here and ready to help whenever you need something.")])).toEqual([
      "Not much, just here and ready to help whenever you need something.",
    ]);
  });

  it("an opening that the turn's end follows at once was its answer: only the end is said (the owner's trace, session 91861ab2)", () => {
    const n = new Narration();
    const said: string[] = [];
    const say = (ev: AgentEvent, now: number) => {
      const line = n.push(ev, now);
      if (line) said.push(line);
    };
    say({ type: "user_message", text: "End web session." }, 0);
    say({ type: "assistant_text", text: "There's nothing for me to do here — this just asks to end the session, which isn't a browser task to perform." }, 3_890);
    expect(n.tick(4_000)).toBeNull();
    say(call("task_complete", { summary: "No action needed; ending session as requested.", spoken: "Okay, stopping here." }), 4_580);
    say({ type: "task_end", outcome: "done", summary: "No action needed; ending session as requested.", spoken: "Okay, stopping here." }, 4_590);
    expect(n.tick(10_000)).toBeNull();
    expect(said).toEqual(["Okay, stopping here."]);
  });

  it("an opening the agent thinks over before its first step: the plan after PLAN_HOLD_MS", () => {
    const n = new Narration();
    n.push({ type: "user_message", text: "check my email" }, 0);
    expect(n.push({ type: "assistant_text", text: "I'll open Gmail and read your unread emails." }, 100)).toBeNull();
    expect(n.tick(100 + PLAN_HOLD_MS - 1)).toBeNull();
    expect(n.tick(100 + PLAN_HOLD_MS)).toBe("I'll open Gmail and read your unread emails.");
    expect(n.tick(100 + PLAN_HOLD_MS + 1)).toBeNull();
  });

  it("a long opening text is not a plan: nothing is said for it", () => {
    const n = new Narration();
    expect(n.push({ type: "assistant_text", text: `Here is everything: ${"detail ".repeat(60)}` }, 0)).toBeNull();
  });

  it("each turn gets its own plan and its own steps", () => {
    const n = new Narration();
    n.push({ type: "assistant_text", text: "Opening X." }, 0);
    expect(n.push(call("navigate", { url: "https://x.com" }), 10)).toBe("Opening X.");
    n.push({ type: "task_end", outcome: "done" }, 20);
    n.push({ type: "user_message", text: "now like it" }, 30);
    expect(n.push({ type: "assistant_text", text: "Liking the post." }, 40)).toBeNull();
    expect(n.push(call("click"), 50)).toBe("Liking the post.");
    expect(n.push(call("navigate", { url: "https://x.com" }), 50 + PROGRESS.stepGapMs)).toBe("Opening x.com");
  });

  it("a long silence while the agent works: 'Still …' about what it does now (tick)", () => {
    const n = new Narration();
    n.push({ type: "user_message", text: "check my email" }, 0);
    expect(n.push(call("navigate", { url: "https://mail.google.com" }), 100)).toBe("Opening mail.google.com");
    expect(n.tick(100 + PROGRESS.stillWorkingMs - 1)).toBeNull();
    expect(n.tick(100 + PROGRESS.stillWorkingMs)).toBe("Still opening mail.google.com");
    expect(n.tick(100 + PROGRESS.stillWorkingMs * 3)).toBeNull();
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
