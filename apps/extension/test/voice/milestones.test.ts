import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import { milestoneOf, PROGRESS, ProgressPacer, siteName } from "../../src/voice/milestones.js";

const call = (name: string, args: unknown = {}) => ({ type: "tool_call" as const, id: "1", name, args });

describe("milestoneOf", () => {
  it("says what the agent is doing, in a few words, from its tool calls", () => {
    expect(milestoneOf(call("navigate", { url: "https://www.linkedin.com/feed/" }))).toBe("Opening linkedin.com");
    expect(milestoneOf(call("open_tabs", { urls: ["https://a.example.com/1", "https://b.example.com/2", "https://c.example.com"] }))).toBe("Opening 3 tabs");
    expect(milestoneOf(call("open_tabs", { urls: ["https://mail.google.com/mail/u/0"] }))).toBe("Opening mail.google.com");
    expect(milestoneOf(call("read_page"))).toBe("Reading the page");
    expect(milestoneOf(call("read_page", { tabs: ["t2", "t3"] }))).toBe("Reading 2 pages");
    expect(milestoneOf(call("screenshot"))).toBe("Looking at the page");
    expect(milestoneOf(call("act", { steps: [{ goal: "click Post" }] }))).toBe("Clicking through the page");
    expect(milestoneOf(call("act", { steps: [{ goal: "type the post", text: "gm" }, { goal: "click Post" }] }))).toBe("Typing");
    expect(milestoneOf(call("act", { steps: [{ goal: "name", text: "Ada" }, { goal: "email", text: "a@b.c" }, { goal: "agree", checked: true }] }))).toBe(
      "Filling in the form",
    );
    expect(milestoneOf(call("switch_x_account", { handle: "@alpha" }))).toBe("Switching to @alpha");
    expect(milestoneOf(call("get_credential", { site: "example.com" }))).toBe("Signing in to example.com");
    expect(milestoneOf(call("upload", { index: 2, paths: ["a.png"] }))).toBe("Attaching files");
    expect(milestoneOf(call("scroll", { direction: "down" }))).toBe("Scrolling");
    expect(milestoneOf(call("switch_tab", { tab: "t2" }))).toBe("Switching tabs");
  });

  it("stays quiet for bookkeeping calls, the end of the task and other events", () => {
    for (const name of ["list_tabs", "close_tabs", "press_key", "task_complete", "task_fail", "task_pause", "no_such_tool"]) expect(milestoneOf(call(name))).toBeNull();
    expect(milestoneOf({ type: "status", text: "Verifying the post" })).toBeNull();
    expect(milestoneOf({ type: "assistant_text", text: "I'll open X." })).toBeNull();
  });

  it("never reads typed text or a bad URL aloud", () => {
    expect(milestoneOf(call("act", { steps: [{ goal: "type the password", text: "hunter2" }] }))).toBe("Typing");
    expect(milestoneOf(call("navigate", { url: "not a url" }))).toBe("Opening a page");
    expect(milestoneOf(call("navigate", {}))).toBe("Opening a page");
  });

  it("siteName: the host without www", () => {
    expect(siteName("https://www.example.com/a?b")).toBe("example.com");
    expect(siteName("chrome://settings")).toBeNull();
  });
});

describe("ProgressPacer: a line when the agent starts something new, 'Still …' after a long silence", () => {
  const P = { stepGapMs: 8_000, stillWorkingMs: 18_000, maxSteps: 3 };
  const call = (name: string, args: unknown = {}): AgentEvent => ({ type: "tool_call", id: "1", name, args });

  it("PROGRESS: the thresholds", () => {
    expect(PROGRESS).toEqual({ stepGapMs: 8_000, stillWorkingMs: 18_000, maxSteps: 5 });
  });

  it("a new kind of step (a site, reading, writing, an account) is said, stepGapMs after anything said; routine steps never", () => {
    const p = new ProgressPacer(P);
    p.reset(0);
    // The user's request does not hold the first step back.
    expect(p.step(call("navigate", { url: "https://x.com/a" }), 100)).toBe("Opening x.com");
    expect(p.step(call("read_page"), 100 + P.stepGapMs - 1)).toBeNull();
    // The same kind again is not new; routine steps never are.
    expect(p.step(call("screenshot"), 100 + P.stepGapMs)).toBe("Looking at the page");
    expect(p.step(call("read_page"), 100 + P.stepGapMs * 3)).toBeNull();
    for (const name of ["click", "scroll", "switch_tab", "wait_for", "press_key"]) expect(p.step(call(name), 100 + P.stepGapMs * 4)).toBeNull();
    // Another site is a new step; so is typing. At most maxSteps a request.
    expect(p.step(call("type"), 100 + P.stepGapMs * 5)).toBe("Typing");
    expect(p.step(call("navigate", { url: "https://mail.google.com/" }), 100 + P.stepGapMs * 7)).toBeNull();
    p.reset(P.stepGapMs * 8);
    expect(p.step(call("navigate", { url: "https://mail.google.com/" }), P.stepGapMs * 8)).toBe("Opening mail.google.com");
  });

  it("anything said (an acknowledgement, an answer) holds the next step back", () => {
    const p = new ProgressPacer(P);
    p.reset(0);
    p.said(1_000);
    expect(p.step(call("navigate", { url: "https://x.com/" }), 1_000 + P.stepGapMs - 1)).toBeNull();
    expect(p.step(call("read_page"), 1_000 + P.stepGapMs)).toBe("Reading the page");
  });

  it("'Still …' once nothing was said for stillWorkingMs: about what the agent does now, once for each thing", () => {
    const p = new ProgressPacer(P);
    p.reset(0);
    expect(p.stillWorking(P.stillWorkingMs - 1)).toBeNull();
    // Nothing done yet: thinking.
    expect(p.stillWorking(P.stillWorkingMs)).toBe("Still working on it");
    expect(p.stillWorking(P.stillWorkingMs * 3)).toBeNull();
    p.step(call("click"), P.stillWorkingMs * 3);
    expect(p.stillWorking(P.stillWorkingMs * 4)).toBe("Still clicking through the page");
    expect(p.stillWorking(P.stillWorkingMs * 6)).toBeNull();
    // A new step right after it is still news; then the silence counts from that line.
    const at = P.stillWorkingMs * 6;
    expect(p.step(call("navigate", { url: "https://x.com/" }), at)).toBe("Opening x.com");
    expect(p.stillWorking(at + P.stillWorkingMs - 1)).toBeNull();
    expect(p.stillWorking(at + P.stillWorkingMs)).toBe("Still opening x.com");
  });

  it("voice started while the agent works: the silence counts from the first look", () => {
    const p = new ProgressPacer(P);
    expect(p.stillWorking(50_000)).toBeNull();
    expect(p.stillWorking(50_000 + P.stillWorkingMs)).toBe("Still working on it");
  });
});
