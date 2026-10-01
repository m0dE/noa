import { describe, expect, it } from "vitest";
import { MAX_SPOKEN_CHARS, OUT_OF_CREDIT, USER_STOP_REASON } from "@noa/shared";
import { endLine, errorLine, planLine, speakable, STOPPED_LINE } from "../../src/voice/spoken-line.js";
import { freshMemory, narrationOf } from "../../src/voice/narrator-policy.js";
import { NarratorFeed } from "../../src/voice/realtime-feed.js";

describe("a task the user stopped (the owner's trace: 'I need a quick response from you... Did you stop the task?')", () => {
  it("is one clear line, a result, never a question for the user", () => {
    const stopped = { type: "task_end", outcome: "paused", reason: USER_STOP_REASON } as const;
    expect(endLine(stopped)).toBe(STOPPED_LINE);
    expect(narrationOf(stopped, freshMemory(), 0)).toEqual({ kind: "result", line: "Stopped." });
    const feed = new NarratorFeed();
    expect(feed.push(stopped, 0)).toContainEqual({ say: { kind: "result", line: "Stopped." } });
  });
});

describe("speakable", () => {
  it("takes the first sentence, without Markdown or links", () => {
    expect(speakable("**Done.** I posted it at https://x.com/a/status/1 and pinned it.")).toBe("Done.");
    expect(speakable("## Summary\n\nYou have [4 emails](https://mail.example.com) waiting. More below.")).toBe("You have 4 emails waiting.");
    expect(speakable("Use `npm run build` first! Then publish.")).toBe("Use npm run build first!");
    expect(speakable("   ")).toBe("");
  });

  it("keeps decimals and abbreviations inside a sentence", () => {
    expect(speakable("It costs $4.20 a month. Cheap.")).toBe("It costs $4.20 a month.");
    expect(speakable("Version 0.2 is out")).toBe("Version 0.2 is out");
  });

  it("clips a run-on sentence at a word, within the cap", () => {
    const long = `${"word ".repeat(80)}end.`;
    const out = speakable(long);
    expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });
});

describe("endLine: what is said when a turn ends", () => {
  it("the agent's own spoken line comes first", () => {
    expect(endLine({ type: "task_end", outcome: "done", summary: "Summarized 4 unread emails", spoken: "You have four unread emails." })).toBe("You have four unread emails.");
  });

  it("else the first sentence of the summary (done) or the reason (paused: the question)", () => {
    expect(endLine({ type: "task_end", outcome: "done", summary: "Posted the thread. It has 4 posts." })).toBe("Posted the thread.");
    expect(endLine({ type: "task_end", outcome: "done" })).toBe("Done.");
    expect(endLine({ type: "task_end", outcome: "paused", reason: "Which account should I post from? Alpha or beta." })).toBe("Which account should I post from?");
  });

  it("the agent's own pause reason is said as it wrote it, not as one of Noa's errors (Sep 30)", () => {
    const reason = "@rooftopchat is not signed in on this browser's X account menu, so switch_x_account cannot switch to it.";
    expect(endLine({ type: "task_end", outcome: "paused", reason, byAgent: true })).toMatch(/^@rooftopchat is not signed in/);
  });

  it("a failure is said in the error card's plain words", () => {
    expect(endLine({ type: "task_end", outcome: "paused", reason: OUT_OF_CREDIT })).toBe("You're out of usage credit.");
    expect(endLine({ type: "task_end", outcome: "failed", reason: "The site kept timing out on login" })).toBe("That didn't work: The site kept timing out on login");
    expect(endLine({ type: "task_end", outcome: "retry", reason: "Claude API rate limit (HTTP 429)" })).toBe("Too many requests right now.");
    expect(endLine({ type: "task_end", outcome: "failed" })).toBe("That didn't work.");
  });
});

describe("errorLine and planLine", () => {
  it("errorLine: the error's one short line", () => {
    expect(errorLine("Claude API rate limit (HTTP 429: rate_limit_error)")).toBe("Too many requests right now.");
    expect(errorLine("weird internal thing")).toBe("Something went wrong.");
  });

  it("planLine: the first sentence of the agent's opening text, when it is short", () => {
    expect(planLine("I'll open X, check the account, then write the thread. First, X.")).toBe("I'll open X, check the account, then write the thread.");
    expect(planLine(`Here is what I found: ${"a lot of detail ".repeat(20)}`)).toBeNull();
    expect(planLine("")).toBeNull();
  });
});
