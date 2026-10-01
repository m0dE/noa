import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import { PROGRESS } from "../../src/voice/milestones.js";
import { ANSWER_HOLD_MS, NarratorFeed, withoutStepNarration, type FeedLine, type FeedOutput } from "../../src/voice/realtime-feed.js";

const call = (name: string, args: unknown = {}): AgentEvent => ({ type: "tool_call", id: "1", name, args });
const GAP = PROGRESS.stepGapMs;
/** The lines to say among the feed's output. */
const says = (out: FeedOutput[]): FeedLine[] => out.flatMap((o) => ("say" in o ? [o.say] : []));
/** The last status among the feed's output. */
const statusOf = (out: FeedOutput[]): string | undefined => out.flatMap((o) => ("status" in o ? [o.status] : [])).pop();
/** The brains' trace: the model read the message sent into its running turn. */
const read: AgentEvent = { type: "trace", trace: { t: 0, src: "engine", cat: "user", name: "interjection", data: { route: "request", count: 1 } } };
const end = (spoken: string): AgentEvent => ({ type: "task_end", outcome: "done", summary: spoken, spoken });

/** A feed whose agent runs the voice request `text` (sent, then its turn started with the voice message). */
function working(text = "Check my inbox.", now = 0): NarratorFeed {
  const feed = new NarratorFeed();
  feed.sent(text, false, now);
  feed.push({ type: "user_message", text, voice: true }, now);
  return feed;
}

describe("NarratorFeed: what the realtime narrator says, word for word, and its status", () => {
  it("what only echoes the request is not said: the voice message, the user's words, the agent restating it, routine steps", () => {
    const feed = working();
    feed.spoke(5);
    expect(says(feed.push({ type: "heard", text: "Check my inbox." }, 20))).toEqual([]);
    expect(says(feed.push({ type: "assistant_text", text: "I'll open your Gmail inbox and summarize the important emails." }, 30))).toEqual([]);
    for (const [i, name] of ["click", "act", "scroll", "switch_tab", "wait_for"].entries()) expect(says(feed.push(call(name), GAP * (i + 2)))).toEqual([]);
  });

  it("a new step is progress, said as it is, PROGRESS.stepGapMs after anything said; the status names it", () => {
    const feed = working();
    // The acknowledgement was said.
    feed.spoke(100);
    expect(says(feed.push(call("navigate", { url: "https://accounts.google.com/" }), 100 + GAP - 1))).toEqual([]);
    const out = feed.push(call("navigate", { url: "https://calendar.google.com/" }), 100 + GAP);
    expect(says(out)).toEqual([{ kind: "milestone", line: "Opening calendar.google.com" }]);
    expect(statusOf(out)).toContain("Latest step: Opening calendar.google.com.");
    // The same site again is not new; the next new one waits for the gap.
    expect(says(feed.push(call("navigate", { url: "https://calendar.google.com/x" }), 100 + GAP * 3))).toEqual([]);
    expect(says(feed.push(call("navigate", { url: "https://drive.google.com/" }), 100 + GAP + 10))).toEqual([]);
  });

  it("while the agent works, a long silence gets one 'Still …' line about what it does now (tick)", () => {
    const feed = working();
    feed.spoke(100);
    feed.push(call("read_page"), 1_000);
    expect(feed.tick(100 + PROGRESS.stillWorkingMs - 1)).toEqual([]);
    expect(says(feed.tick(100 + PROGRESS.stillWorkingMs))).toEqual([{ kind: "milestone", line: "Still reading the page" }]);
    expect(feed.tick(100 + PROGRESS.stillWorkingMs * 3)).toEqual([]);
  });

  it("never passes on what the agent types or what pages say", () => {
    const feed = working();
    const out = [
      ...feed.push(call("act", { steps: [{ goal: "type the password", text: "hunter2" }] }), GAP),
      ...feed.push({ type: "tool_result", id: "1", name: "read_page", text: "SECRET PAGE TEXT" }, GAP * 2),
      ...feed.push({ type: "task_end", outcome: "done", summary: "Signed in", spoken: "You're signed in." }, GAP * 3),
    ];
    expect(JSON.stringify(out)).not.toMatch(/hunter2|SECRET/);
  });

  it("the end of a task is said at once, word for word: the agent's spoken line, in full; the status keeps what was said", () => {
    const feed = working("Post my thread.");
    feed.push(call("navigate", { url: "https://x.com/home" }), 100);
    const out = feed.push({ type: "task_end", outcome: "done", summary: "Posted the thread", spoken: "Posted your thread on X." }, 500);
    expect(says(out)).toEqual([{ kind: "result", line: "Posted your thread on X." }]);
    expect(statusOf(out)).toContain("You finished working on «Post my thread.».");
    // The status never holds a result (the narrator said it again for "hello?").
    expect(statusOf(out)).not.toContain("Posted your thread");
  });

  it("a paused task is a question to ask; a failure and an error say what went wrong; the same line is never said twice", () => {
    const feed = new NarratorFeed();
    const paused = feed.push({ type: "task_end", outcome: "paused", reason: "Which account should I post from?" }, 0);
    expect(says(paused)).toEqual([{ kind: "question", line: "Which account should I post from?" }]);
    expect(statusOf(paused)).toContain("You asked the user: «Which account should I post from?» Give their answer to send_to_agent.");
    expect(says(feed.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 0))).toEqual([{ kind: "error", line: "Too many requests right now." }]);
    expect(feed.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 5)).toEqual([]);
    expect(says(feed.push({ type: "task_end", outcome: "failed", reason: "The site kept timing out" }, 0))).toEqual([{ kind: "result", line: "That didn't work: The site kept timing out" }]);
  });

  it("a message typed in the panel changes the status only", () => {
    const feed = new NarratorFeed();
    const out = feed.push({ type: "user_message", text: "use the second draft" }, 0);
    expect(says(out)).toEqual([]);
    expect(statusOf(out)).toContain("You are working on the user's request: «use the second draft»");
  });

  it("ignores status lines, Jev picks, live text deltas and other traces", () => {
    const feed = new NarratorFeed();
    expect(feed.push({ type: "status", text: "Claude API (claude-sonnet-5)" }, 0)).toEqual([]);
    expect(feed.push({ type: "jev", goal: "x", operation: "click", index: 1, confidence: 1, executed: true, ms: 1 }, 0)).toEqual([]);
    expect(feed.push({ type: "assistant_text_delta", id: "m:0", text: "Hel" }, 0)).toEqual([]);
    expect(feed.push({ type: "trace", trace: { t: 0, src: "engine", cat: "model", name: "claude.request" } }, 0)).toEqual([]);
  });
});

/**
 * The owner's report (2026-09-30): the voice answered what they had asked a turn or two before. Reproduced live
 * (test/manual/realtime-lag.live.ts): the narrator said updates it had not said yet from its conversation, and the
 * agent's words written before it read the new question were passed on as the answer to it.
 */
describe("NarratorFeed: only what the agent wrote knowing the user's latest request is said", () => {
  it("a question sent into the running turn: the step's text written before the agent read it is not the answer; the first words after are", () => {
    const feed = working("What's the latest email in my inbox?");
    feed.push(call("read_page"), 1_000);
    feed.sent("What did she say about the agenda?", true, 2_000);
    feed.push({ type: "user_message", text: "What did she say about the agenda?", voice: true }, 2_100);
    // Written while the question was on its way (live: "Let me check your inbox." said as the answer to it).
    expect(says(feed.push({ type: "assistant_text", text: "The page is open; reading the messages now." }, 2_500))).toEqual([]);
    expect(feed.fresh()).toBe(false);
    feed.push(read, 3_000);
    expect(feed.fresh()).toBe(true);
    // Its answer is held for the turn's end, and said when the agent goes on working (ANSWER_HOLD_MS).
    expect(says(feed.push({ type: "assistant_text", text: "She wants to go over the onboarding flow first, then the pricing page." }, 3_500))).toEqual([]);
    expect(says(feed.tick(3_500 + ANSWER_HOLD_MS - 1))).toEqual([]);
    expect(says(feed.tick(3_500 + ANSWER_HOLD_MS))).toEqual([{ kind: "result", line: "She wants to go over the onboarding flow first, then the pricing page." }]);
    // Said once.
    expect(says(feed.push({ type: "assistant_text", text: "Now opening the next message." }, 9_000))).toEqual([]);
    expect(says(feed.tick(20_000)).filter((l) => l.kind === "result")).toEqual([]);
  });

  it("the question read only as its turn ends (no read trace): the turn's end is written knowing it, and is said", () => {
    const feed = working();
    feed.sent("Can you speak Korean?", true, 1_000);
    feed.push({ type: "user_message", text: "Can you speak Korean?", voice: true }, 1_100);
    expect(says(feed.push({ type: "assistant_text", text: "Reading the inbox." }, 1_500))).toEqual([]);
    expect(says(feed.push(end("Yes, I can speak Korean."), 2_000))).toEqual([{ kind: "result", line: "Yes, I can speak Korean." }]);
  });

  it("an old turn's end that comes after the next request went out (the request waits for the next turn) is not said", () => {
    const feed = working("What's the latest email?");
    feed.sent("Did anyone reply to her?", false, 5_000);
    expect(says(feed.push(end("The latest email is from Dana."), 5_500))).toEqual([]);
    // The next turn starts with the request, and its end answers it.
    feed.push({ type: "user_message", text: "Did anyone reply to her?", voice: true }, 6_000);
    expect(says(feed.push(end("Yes, Marco replied."), 9_000))).toEqual([{ kind: "result", line: "Yes, Marco replied." }]);
  });

  it("a new chat's first turn has no message of its own: its first event takes the request", () => {
    const feed = new NarratorFeed();
    feed.sent("Check my inbox.", false, 0);
    expect(feed.fresh()).toBe(false);
    feed.push({ type: "status", text: "Claude Code" }, 100);
    expect(feed.fresh()).toBe(true);
    expect(says(feed.push(end("Three new emails."), 5_000))).toEqual([{ kind: "result", line: "Three new emails." }]);
  });

  it("the events of a request's message may come back before it is counted as sent: it is taken all the same", () => {
    const feed = working();
    // Its user_message came back first (Math.min: never taken ahead of what was sent), then it is counted.
    feed.push({ type: "user_message", text: "Use the second draft.", voice: true }, 1_000);
    feed.sent("Use the second draft.", false, 1_001);
    feed.push(read, 1_500);
    expect(feed.fresh()).toBe(false);
    expect(says(feed.push(end("Posted the second draft."), 2_000))).toEqual([]);
  });

  it("a problem is said even before the agent read the latest request: it is about what runs now", () => {
    const feed = working();
    feed.sent("Also check spam.", false, 1_000);
    expect(says(feed.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 1_500))).toEqual([{ kind: "error", line: "Too many requests right now." }]);
  });

  it("an approval is asked when the agent asks, and the status says it waits until it is answered", () => {
    const feed = working();
    const asked = feed.push({ type: "approval_request", request: { id: "a1", action: 'Click "Post"', site: "x.com", why: "publishes" } } as unknown as AgentEvent, 1_000);
    expect(says(asked)).toEqual([{ kind: "question", line: expect.stringContaining("Post") }]);
    expect(statusOf(asked)).toContain("An action waits for the user's OK");
    expect(statusOf(feed.push({ type: "approval_resolved", id: "a1", outcome: "allowed" } as unknown as AgentEvent, 2_000))).not.toContain("waits for the user's OK");
  });

  it("a request said before the first turn showed anything (Claude Code still starting) goes into that turn: its lines are said once read (live: silent for the whole session)", () => {
    const feed = new NarratorFeed();
    feed.sent("What's the latest email in my inbox?", false, 0, false);
    // 5 s later, nothing from the agent yet: the next request goes into the turn that is starting.
    feed.sent("What did she say about the agenda?", true, 5_000, true);
    feed.push({ type: "user_message", text: "What did she say about the agenda?", voice: true }, 5_100);
    feed.push({ type: "status", text: "Claude Code started (claude-sonnet-5)" }, 9_000);
    expect(says(feed.push({ type: "assistant_text", text: "Checking the inbox." }, 9_500))).toEqual([]);
    feed.push(read, 10_000);
    expect(feed.fresh()).toBe(true);
    expect(says(feed.push(end("Dana's agenda is the onboarding flow first, then the pricing page."), 20_000))).toEqual([
      { kind: "result", line: "Dana's agenda is the onboarding flow first, then the pricing page." },
    ]);
    // The next turn: its voice message is its first event, and its end is said.
    feed.sent("Did anyone reply to her?", false, 30_000, false);
    feed.push({ type: "user_message", text: "Did anyone reply to her?", voice: true }, 30_100);
    expect(says(feed.push(end("Yes, Marco replied."), 35_000))).toEqual([{ kind: "result", line: "Yes, Marco replied." }]);
  });

  it("after a question is read, what the agent says it does next is not the answer; its answer is (live, Claude Code)", () => {
    const feed = asked();
    for (const step of [
      "Let me open Dana Kim's email to see what she said about the agenda.",
      "I'll check Dana's email thread to see her agenda comments.",
      "I need to check the inbox first.",
      "I haven't opened the latest email yet, so let me check the inbox now to see what she said.",
    ]) {
      feed.push({ type: "assistant_text", text: step }, 2_000);
      expect(says(feed.tick(2_000 + ANSWER_HOLD_MS)), step).toEqual([]);
    }
    feed.push({ type: "assistant_text", text: "She wants the onboarding flow first, then the pricing page." }, 10_000);
    expect(says(feed.tick(10_000 + ANSWER_HOLD_MS))).toEqual([{ kind: "result", line: "She wants the onboarding flow first, then the pricing page." }]);
  });

  it("the turn's end soon after the answer that covers it says it instead (live: half an answer mid-turn, then the whole one at the end)", () => {
    const feed = asked();
    feed.push({ type: "assistant_text", text: "Dana said the agenda is the onboarding flow first, then the pricing page." }, 2_000);
    expect(says(feed.push(end("Dana's agenda is the new onboarding flow first, then the pricing page, and bring your mocks."), 4_000))).toEqual([
      { kind: "result", line: "Dana's agenda is the new onboarding flow first, then the pricing page, and bring your mocks." },
    ]);
    expect(says(feed.tick(30_000)).filter((l) => l.kind === "result")).toEqual([]);
    // A turn's end with no line of its own: the answer held is said then.
    const other = asked();
    other.push({ type: "assistant_text", text: "I'm signed in as @acme." }, 2_000);
    expect(says(other.push({ type: "task_end", outcome: "done", summary: "" }, 3_000))).toEqual([{ kind: "result", line: "I'm signed in as @acme." }]);
  });

  it("a turn's end about the task alone does not swallow the answer held: the answer, then the end", () => {
    const feed = asked();
    feed.push({ type: "assistant_text", text: "She wants to go over the onboarding flow first, then the pricing page." }, 2_000);
    expect(says(feed.push(end("The latest email is from Dana Kim, moving Friday's design review to 3 PM."), 3_000))).toEqual([
      { kind: "result", line: "She wants to go over the onboarding flow first, then the pricing page." },
      { kind: "result", line: "The latest email is from Dana Kim, moving Friday's design review to 3 PM." },
    ]);
  });

  it("a turn's end after the answer was said is not said again when it repeats it; with news of its own it is", () => {
    const feed = asked();
    feed.push({ type: "assistant_text", text: "Dana said the agenda is first the new onboarding flow, then the pricing page, and she asked everyone to bring their mocks." }, 2_000);
    expect(says(feed.tick(2_000 + ANSWER_HOLD_MS))).toHaveLength(1);
    expect(says(feed.push(end("Dana's agenda is the new onboarding flow first, then the pricing page, and she wants everyone to bring their mocks."), 30_000))).toEqual([]);
    const other = asked();
    other.push({ type: "assistant_text", text: "I'm on @acme." }, 2_000);
    expect(says(other.tick(2_000 + ANSWER_HOLD_MS))).toHaveLength(1);
    expect(says(other.push(end("Posted your thread on X from @acme."), 30_000))).toEqual([{ kind: "result", line: "Posted your thread on X from @acme." }]);
  });

  it("the facts of an answer are kept, its sentences about what it does next dropped; the first answer is kept, not the steps after it", () => {
    expect(withoutStepNarration('The latest email is from Dana Kim, titled "Design review moved to Friday 3 PM." Let me open it to see the agenda.')).toBe(
      'The latest email is from Dana Kim, titled "Design review moved to Friday 3 PM."',
    );
    expect(withoutStepNarration("Let me open it. I'll read it next.")).toBe("");
    const feed = asked();
    feed.push({ type: "assistant_text", text: "She wants the onboarding flow first, then the pricing page." }, 2_000);
    // Live (scripted agent): its next step's words took the answer's place, and the answer was never said.
    feed.push({ type: "assistant_text", text: "Reading it now." }, 4_000);
    expect(says(feed.tick(2_000 + ANSWER_HOLD_MS))).toEqual([{ kind: "result", line: "She wants the onboarding flow first, then the pricing page." }]);
  });

  it("a new request lets go of the answer held for the one before", () => {
    const feed = asked();
    feed.push({ type: "assistant_text", text: "She wants the onboarding flow first." }, 2_000);
    feed.sent("Never mind, check my calendar.", false, 3_000, true);
    expect(says(feed.tick(30_000)).filter((l) => l.kind === "result")).toEqual([]);
  });
});

/** A feed whose agent works on "What's the latest email?" and has read the question asked meanwhile. */
function asked(): NarratorFeed {
  const feed = working("What's the latest email?");
  feed.sent("What did she say about the agenda?", true, 1_000, true);
  feed.push({ type: "user_message", text: "What did she say about the agenda?", voice: true }, 1_100);
  feed.push(read, 1_500);
  return feed;
}
