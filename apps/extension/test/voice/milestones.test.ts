import { describe, expect, it } from "vitest";
import { MILESTONE_GAP_MS, MilestoneThrottle, milestoneOf, siteName } from "../../src/voice/milestones.js";

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

describe("MilestoneThrottle", () => {
  it("lets a milestone through at most every MILESTONE_GAP_MS, and never the same one twice in a row", () => {
    const t = new MilestoneThrottle();
    expect(t.offer("Opening x.com", 0)).toBe("Opening x.com");
    expect(t.offer("Reading the page", 1000)).toBeNull();
    expect(t.offer("Typing", MILESTONE_GAP_MS - 1)).toBeNull();
    expect(t.offer("Typing", MILESTONE_GAP_MS)).toBe("Typing");
    expect(t.offer("Typing", MILESTONE_GAP_MS * 3)).toBeNull();
    expect(t.offer("Clicking through the page", MILESTONE_GAP_MS * 3)).toBe("Clicking through the page");
  });

  it("reset (a new turn) lets the next one through at once", () => {
    const t = new MilestoneThrottle(5000);
    expect(t.offer("Opening x.com", 0)).toBe("Opening x.com");
    t.reset();
    expect(t.offer("Opening x.com", 10)).toBe("Opening x.com");
  });
});
