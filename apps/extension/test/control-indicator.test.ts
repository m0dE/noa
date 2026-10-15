import { beforeEach, describe, expect, it } from "vitest";
import { TOOL_NAMES, USER_STOP_REASON, type AgentEvent } from "@noa/shared";
import { CONTROL_BADGES, ControlIndicator, controlBadge, groupLook, LIMITED_DETAILS, stepOf, tabDetails, tabStates, type ControlledSession } from "../src/control-indicator.js";
import type { GroupLook } from "../src/chrome-tabs.js";
import type { IndicatorDetails, IndicatorVariant } from "../src/page-indicator.js";
import type { BadgeLook } from "../src/tab-badges.js";

describe("groupLook", () => {
  it("idle: the brand in grey", () => {
    expect(groupLook([])).toEqual({ title: "Noa", color: "grey" });
  });
  it("one run acting: its job in purple (working without a title); several: how many", () => {
    expect(groupLook([{ state: "working", title: "Compare flight prices" }])).toEqual({ title: "Noa · Compare flight prices", color: "purple" });
    expect(groupLook([{ state: "working" }])).toEqual({ title: "Noa · working", color: "purple" });
    expect(groupLook([{ state: "working", title: "a" }, { state: "working", title: "b" }])).toEqual({ title: "Noa · 2 working", color: "purple" });
  });
  it("a long job title is cut short for the tab strip", () => {
    const title = groupLook([{ state: "working", title: "Find three apartments near the office under the budget and book viewings" }]).title;
    expect(title).toBe("Noa · Find three apartments near th…");
    expect(title.length).toBe("Noa · ".length + 30);
  });
  it("any run waiting for the user wins: needs you in yellow", () => {
    expect(groupLook([{ state: "working", title: "a" }, { state: "needs-you", title: "b" }])).toEqual({ title: "Noa · needs you", color: "yellow" });
  });
});

describe("what a controlled tab tells about its run", () => {
  it("the popover: the job, what the agent does now (only while it works), limited mode", () => {
    expect(tabDetails("working", { title: "Compare flight prices", step: "Opening kayak.com" })).toEqual({ job: "Compare flight prices", now: "Now: Opening kayak.com", limited: "" });
    expect(tabDetails("needs-you", { title: "Compare flight prices", step: "Opening kayak.com" })).toEqual({ job: "Compare flight prices", now: "", limited: "" });
    expect(tabDetails("working", { limited: { extensionId: null } })).toEqual({ job: "", now: "", limited: LIMITED_DETAILS });
    expect(LIMITED_DETAILS).toMatch(/simulated.*can't upload files.*turn that extension off/s);
  });
  it("the badge's tooltip says the same in one line; without a job, as before", () => {
    expect(controlBadge("working", { title: "Compare flight prices", step: "Typing", limited: { extensionId: "x" } })).toEqual({
      ...CONTROL_BADGES.working,
      title: "Noa is working in this tab: Compare flight prices · Now: Typing · Limited mode: another extension blocks Chrome's debugger here",
    });
    expect(controlBadge("needs-you", { title: "Compare flight prices", step: "Typing" }).title).toBe("Noa needs you in this tab: Compare flight prices");
    expect(controlBadge("working", {})).toEqual(CONTROL_BADGES.working);
  });
  it("every tool's call says what the agent does now: its voice milestone, else the tool's own line", () => {
    for (const name of TOOL_NAMES) expect(stepOf({ type: "tool_call", id: "1", name, args: {} }), name).toMatch(/^[A-Z][a-z]/);
    expect(stepOf({ type: "tool_call", id: "1", name: "navigate", args: { url: "https://www.kayak.com/" } })).toBe("Opening kayak.com");
    expect(stepOf({ type: "tool_call", id: "1", name: "list_tabs", args: {} })).toBe("Checking the open tabs");
    expect(stepOf({ type: "tool_call", id: "1", name: "toString", args: {} })).toBeNull();
    expect(stepOf({ type: "status", text: "Verifying" })).toBeNull();
  });
});

describe("tabStates", () => {
  it("each session's tabs; a session that needs the user wins a tab two share", () => {
    const states = tabStates([
      { sessionId: "a", tabs: [1, 2], needsYou: false },
      { sessionId: "b", tabs: [2, 3], needsYou: true },
    ]);
    expect(Object.fromEntries(states)).toEqual({
      1: { state: "working", sessionId: "a" },
      2: { state: "needs-you", sessionId: "b" },
      3: { state: "needs-you", sessionId: "b" },
    });
  });
});

/** The indicator on fakes: what runs, which group each tab is in, and what it did. */
function harness() {
  let running: ControlledSession[] = [];
  let overlay = true;
  const titles = new Map<string, string>();
  const limited = new Map<number, string | null>();
  const details = new Map<number, IndicatorDetails>();
  const groupOfTab = new Map<number, number>();
  const knownGroups = new Set<number>();
  const looks = new Map<number, GroupLook>();
  const badges = new Map<number, BadgeLook>();
  const pages = new Map<number, IndicatorVariant>();
  const shows: [number, IndicatorVariant][] = [];
  let stored: unknown;
  const make = () =>
    new ControlIndicator({
      running: async () => running,
      tabsOf: async (sessionId) => running.find((s) => s.sessionId === sessionId)?.tabs ?? [],
      chatTabOf: async (sessionId) => (sessionId === "chat" ? 50 : null),
      titleOf: async (sessionId) => titles.get(sessionId) ?? null,
      limited: (tabId) => (limited.has(tabId) ? { extensionId: limited.get(tabId) ?? null } : null),
      showOverlay: async () => overlay,
      groups: {
        of: async (tabId) => groupOfTab.get(tabId) ?? null,
        all: async () => [...knownGroups],
        apply: async (groupId, look) => void looks.set(groupId, look),
      },
      badges: {
        controlled: (tabId, look) => {
          if (look) badges.set(tabId, look);
          else badges.delete(tabId);
        },
      },
      pages: {
        show: async (tabId, variant, d) => {
          pages.set(tabId, variant);
          details.set(tabId, d);
          shows.push([tabId, variant]);
        },
        remove: async (tabId) => void pages.delete(tabId),
      },
      storage: { load: async () => stored, save: async (v) => void (stored = structuredClone(v)) },
      delayMs: 0,
    });
  return {
    make,
    setRunning: (r: ControlledSession[]) => (running = r),
    setOverlay: (on: boolean) => (overlay = on),
    group: (tabId: number, groupId: number) => {
      groupOfTab.set(tabId, groupId);
      knownGroups.add(groupId);
    },
    looks,
    badges,
    pages,
    shows,
    titles,
    limited,
    details,
  };
}

const end = (outcome: "done" | "paused" | "failed", reason?: string): AgentEvent => ({ type: "task_end", outcome, ...(reason ? { reason } : {}) });

describe("ControlIndicator", () => {
  let h: ReturnType<typeof harness>;
  let ind: ControlIndicator;

  beforeEach(() => {
    h = harness();
    ind = h.make();
    h.group(1, 10);
    h.group(2, 10);
  });

  it("a run acting in a tab: its group says working, the tab has the RUN badge and the overlay; all gone when it ends", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    expect(h.looks.get(10)).toEqual({ title: "Noa · working", color: "purple" });
    expect(h.badges.get(1)).toEqual(CONTROL_BADGES.working);
    expect(CONTROL_BADGES.working).toMatchObject({ text: "RUN", title: "Noa is working in this tab" });
    expect(h.pages.get(1)).toBe("working");
    expect(ind.sessionOf(1)).toBe("s1");

    h.setRunning([]);
    ind.onEvent("s1", end("done"));
    await ind.applyNow();
    expect(h.looks.get(10)).toEqual({ title: "Noa", color: "grey" });
    expect(h.badges.has(1)).toBe(false);
    expect(h.pages.has(1)).toBe(false);
    expect(ind.sessionOf(1)).toBeNull();
  });

  it("two runs in the group: 2 working; one waiting for an approval: needs you, its tab shows Open", async () => {
    h.setRunning([
      { sessionId: "s1", tabs: [1], needsYou: false },
      { sessionId: "s2", tabs: [2], needsYou: false },
    ]);
    await ind.applyNow();
    expect(h.looks.get(10)?.title).toBe("Noa · 2 working");
    h.setRunning([
      { sessionId: "s1", tabs: [1], needsYou: false },
      { sessionId: "s2", tabs: [2], needsYou: true },
    ]);
    await ind.applyNow();
    expect(h.looks.get(10)).toEqual({ title: "Noa · needs you", color: "yellow" });
    expect(h.badges.get(2)).toEqual(CONTROL_BADGES["needs-you"]);
    expect(h.pages.get(2)).toBe("needs-you");
    expect(h.pages.get(1)).toBe("working");
  });

  it("a run that ended paused for the user needs them in its tabs until its next turn", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    // task_end comes while the session is still running; then it ends.
    ind.onEvent("s1", end("paused", "Log in to continue"));
    await ind.applyNow();
    h.setRunning([]);
    await ind.applyNow();
    expect(h.looks.get(10)?.title).toBe("Noa · needs you");
    expect(h.pages.get(1)).toBe("needs-you");

    // The next turn starts with the user's message.
    ind.onEvent("s1", { type: "user_message", text: "done, go on" });
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    expect(h.looks.get(10)?.title).toBe("Noa · working");
    expect(h.pages.get(1)).toBe("working");
  });

  it("a turn too short for any refresh to see still leaves 'needs you' in its tabs", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [2], needsYou: false }]);
    // Its slot still has the tab when its task_end comes.
    ind.onEvent("s1", end("paused", "Which size?"));
    await new Promise((r) => setTimeout(r, 5));
    h.setRunning([]);
    await ind.applyNow();
    expect(h.pages.get(2)).toBe("needs-you");
    expect(h.looks.get(10)?.title).toBe("Noa · needs you");
  });

  it("a run the user stopped does not ask for them", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    ind.onEvent("s1", end("paused", USER_STOP_REASON));
    h.setRunning([]);
    await ind.applyNow();
    expect(h.looks.get(10)?.title).toBe("Noa");
    expect(h.pages.has(1)).toBe(false);
  });

  it("Open on a paused run: the chat's tab, and its tabs stop saying so", async () => {
    h.setRunning([{ sessionId: "chat", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    ind.onEvent("chat", end("paused", "Which account?"));
    h.setRunning([]);
    await ind.applyNow();
    expect(ind.open(1)).toBe(50);
    await ind.applyNow();
    expect(h.pages.has(1)).toBe(false);
    expect(h.looks.get(10)?.title).toBe("Noa");
    // A tab without a session's chat opens its own panel.
    expect(ind.open(7)).toBe(7);
  });

  it("with the overlay setting off, the group and badge still show; turning it on shows the overlay", async () => {
    h.setOverlay(false);
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    expect(h.pages.size).toBe(0);
    expect(h.badges.get(1)).toEqual(CONTROL_BADGES.working);
    expect(h.looks.get(10)?.title).toBe("Noa · working");
    h.setOverlay(true);
    await ind.applyNow();
    expect(h.pages.get(1)).toBe("working");
    h.setOverlay(false);
    await ind.applyNow();
    expect(h.pages.size).toBe(0);
  });

  it("a controlled tab's new page gets the overlay again; a closed tab is forgotten", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1, 3], needsYou: false }]);
    await ind.applyNow();
    h.shows.length = 0;
    ind.tabLoaded(1);
    ind.tabLoaded(9);
    expect(h.shows).toEqual([[1, "working"]]);
    ind.tabRemoved(3);
    expect(ind.sessionOf(3)).toBeNull();
  });

  it("a tab outside any agent group still gets the badge and overlay", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [4], needsYou: false }]);
    await ind.applyNow();
    expect(h.badges.get(4)).toEqual(CONTROL_BADGES.working);
    expect(h.pages.get(4)).toBe("working");
    expect(h.looks.get(10)?.title).toBe("Noa");
  });

  it("a restarted service worker takes over what the last one showed, and takes it down when nothing runs", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    h.badges.clear();
    h.pages.clear();
    const restarted = h.make();
    await restarted.ready;
    // Shown again (this worker's overlays and badges).
    expect(h.pages.get(1)).toBe("working");
    expect(h.badges.get(1)).toEqual(CONTROL_BADGES.working);
    h.setRunning([]);
    await restarted.applyNow();
    expect(h.pages.has(1)).toBe(false);
    expect(h.badges.has(1)).toBe(false);
    expect(h.looks.get(10)?.title).toBe("Noa");
  });

  it("the job and what the agent does now: in the group's title, the popover and the badge's tooltip, kept up to date", async () => {
    h.titles.set("s1", "Compare flight prices");
    h.setRunning([{ sessionId: "s1", tabs: [1, 2], needsYou: false }]);
    await ind.applyNow();
    expect(h.looks.get(10)).toEqual({ title: "Noa · Compare flight prices", color: "purple" });
    expect(h.details.get(2)).toEqual({ job: "Compare flight prices", now: "", limited: "" });
    expect(h.badges.get(2)?.title).toBe("Noa is working in this tab: Compare flight prices");

    ind.onEvent("s1", { type: "tool_call", id: "c1", name: "navigate", args: { url: "https://www.kayak.com/flights" } });
    await ind.applyNow();
    expect(h.details.get(1)).toEqual({ job: "Compare flight prices", now: "Now: Opening kayak.com", limited: "" });
    expect(h.badges.get(1)?.title).toBe("Noa is working in this tab: Compare flight prices · Now: Opening kayak.com");

    // A step that says nothing new (the same one again) changes nothing on the pages.
    h.shows.length = 0;
    ind.onEvent("s1", { type: "tool_call", id: "c2", name: "navigate", args: { url: "https://kayak.com/a" } });
    ind.onEvent("s1", { type: "tool_call", id: "c3", name: "navigate", args: { url: "https://kayak.com/b" } });
    await ind.applyNow();
    expect(h.shows).toEqual([]);

    // Renamed (the title model, or the user): the next refresh says so.
    h.titles.set("s1", "Flights to Lisbon");
    await ind.applyNow();
    expect(h.looks.get(10)?.title).toBe("Noa · Flights to Lisbon");
    expect(h.details.get(1)?.job).toBe("Flights to Lisbon");

    // Waiting for the user: no "Now" (it waits), the job stays.
    ind.onEvent("s1", end("paused", "Which dates?"));
    h.setRunning([]);
    await ind.applyNow();
    expect(h.details.get(1)).toEqual({ job: "Flights to Lisbon", now: "", limited: "" });
    expect(h.badges.get(1)?.title).toBe("Noa needs you in this tab: Flights to Lisbon");

    // The next turn starts afresh: no step from the last one.
    ind.onEvent("s1", { type: "user_message", text: "May 3 to 10" });
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    await ind.applyNow();
    expect(h.details.get(1)?.now).toBe("");
  });

  it("a tab in limited mode: 'Limited' on its pill with what it means, and in the badge's tooltip; gone when the debugger is back", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1, 2], needsYou: false }]);
    h.limited.set(2, "abcdefghijklmnopabcdefghijklmnop");
    await ind.applyNow();
    expect(h.details.get(2)?.limited).toBe(LIMITED_DETAILS);
    expect(h.details.get(1)?.limited).toBe("");
    expect(h.badges.get(2)?.title).toMatch(/Limited mode: another extension blocks Chrome's debugger here$/);
    expect(h.badges.get(2)?.text).toBe("RUN");
    h.limited.delete(2);
    await ind.applyNow();
    expect(h.details.get(2)?.limited).toBe("");
    expect(h.badges.get(2)?.title).toBe("Noa is working in this tab");
  });

  it("a restarted service worker shows the same details and tooltip it kept", async () => {
    h.titles.set("s1", "Compare flight prices");
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    ind.onEvent("s1", { type: "tool_call", id: "c1", name: "screenshot", args: {} });
    await ind.applyNow();
    const shown = { details: h.details.get(1), badge: h.badges.get(1) };
    h.details.clear();
    h.badges.clear();
    const restarted = h.make();
    await restarted.ready;
    expect(h.details.get(1)).toEqual(shown.details);
    expect(h.badges.get(1)).toEqual(shown.badge);
    expect(shown.details?.now).toBe("Now: Looking at the page");
  });

  it("a tool call with no spoken milestone still replaces what the agent does now (never the last step, stale)", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    ind.onEvent("s1", { type: "tool_call", id: "c1", name: "navigate", args: { url: "https://kayak.com/" } });
    await ind.applyNow();
    expect(h.details.get(1)?.now).toBe("Now: Opening kayak.com");
    ind.onEvent("s1", { type: "tool_call", id: "c2", name: "list_tabs", args: {} });
    await ind.applyNow();
    expect(h.details.get(1)?.now).toBe("Now: Checking the open tabs");
    // A name no tool has: nothing is claimed.
    ind.onEvent("s1", { type: "tool_call", id: "c3", name: "no_such_tool", args: {} });
    await ind.applyNow();
    expect(h.details.get(1)?.now).toBe("");
  });

  it("a restarted service worker keeps what the agent does now through its next refresh", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    ind.onEvent("s1", { type: "tool_call", id: "c1", name: "screenshot", args: {} });
    await ind.applyNow();
    const restarted = h.make();
    await restarted.ready;
    await restarted.applyNow();
    expect(h.details.get(1)?.now).toBe("Now: Looking at the page");
    expect(h.badges.get(1)?.title).toBe("Noa is working in this tab · Now: Looking at the page");
  });

  it("refresh() gathers a burst of changes into one pass", async () => {
    h.setRunning([{ sessionId: "s1", tabs: [1], needsYou: false }]);
    for (let i = 0; i < 5; i++) ind.refresh();
    await new Promise((r) => setTimeout(r, 10));
    await ind.applyNow();
    expect(h.shows).toEqual([[1, "working"]]);
  });
});
