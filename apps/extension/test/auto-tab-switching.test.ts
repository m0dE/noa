/**
 * A screenshot of a tab Chrome cannot capture where it is (driver.ts BACKGROUND_SHOT_TIMEOUT_MS, measured): Auto tab
 * switching brings it forward (and the chat is told once); off, the user is asked on a card (Switch to it / Not now).
 * Never for a stopped run, never a card for a run nobody watches, and only where the capture needs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SWITCH_APPROVAL_TIMEOUT_MS, type AgentEvent, type ApprovalRequest } from "@noa/shared";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { DRAWN } from "./driver-harness.js";
import { AgentSlots, type SlotApprovals } from "../src/agent-slots.js";
import { ApprovalBroker } from "../src/approval/broker.js";
import type { GateContext } from "../src/approval/gate.js";
import { Cdp } from "../src/cdp.js";
import { SHOT_NOT_SWITCHED } from "../src/driver-common.js";

let chrome: ChromeFake;
let windowId: number;
let userTab: number;
let runTab: number;
let auto: boolean;
let stopped: boolean;
let attended: boolean;
/** What the card's user does when a request shows: an answer, or nothing (it waits until it times out). */
let answer: "allow_once" | "deny" | null;
let requests: ApprovalRequest[];
let told: [string, AgentEvent][];
let broker: ApprovalBroker;

const vault = { getCredential: async () => ({ found: false as const }) };

function makeSlots(opts: { timeoutMs?: number } = {}): AgentSlots {
  broker = new ApprovalBroker({
    note: (sessionId, e) => {
      if (e.type !== "approval_request") return;
      requests.push(e.request);
      if (answer) queueMicrotask(() => broker.answer(sessionId, e.request.id, answer!));
    },
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const approvals: SlotApprovals = {
    context: async (): Promise<GateContext> => ({ level: "ask_consequential", attended, stopped: () => stopped }),
    request: (sessionId, ask, o) => broker.request(sessionId, ask, o),
    end: (sessionId) => broker.end(sessionId),
  };
  return new AgentSlots(new Cdp(), vault, undefined, undefined, approvals, (sessionId, e) => told.push([sessionId, e]), undefined, undefined, async () => auto);
}

const activations = () => chrome.tabs.updateCalls.filter((c) => c.props.active).map((c) => c.id);
const windowUpdates = () => chrome.windows.updateCalls.map((c) => c.props);

beforeEach(async () => {
  chrome = installChromeFake();
  const win = await chrome.windows.create({ url: "https://news.test/", focused: true, type: "normal" });
  windowId = win.id;
  userTab = win.tabs[0]!.id;
  runTab = (await chrome.tabs.create({ windowId, url: "https://run.test/", active: false })).id;
  chrome.debugger.respond = (method) => {
    if (method === "Page.captureScreenshot") return { data: "Q0RQ" };
    const tabId = chrome.debugger.commands.at(-1)!.tabId;
    if (method === "Runtime.evaluate") return { result: { value: { url: chrome.tabs.byId.get(tabId)!.url, title: "t", text: "", elements: DRAWN, truncated: false } } };
    return {};
  };
  auto = true;
  stopped = false;
  attended = true;
  answer = null;
  requests = [];
  told = [];
  chrome.tabs.updateCalls.length = 0;
});

afterEach(() => vi.useRealTimers());

async function runIn(slots: AgentSlots, tabId = runTab) {
  const slot = slots.take(0, "S");
  await slot.prepare({ mode: "current-tab", tabId });
  chrome.tabs.updateCalls.length = 0;
  chrome.windows.updateCalls.length = 0;
  return slot;
}

describe("the setting", () => {
  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.autoTabSwitching).toBe(true);
  });
});

describe("Auto tab switching on", () => {
  it("a background tab comes forward before its screenshot (its window keeps its focus); the chat is told once", async () => {
    const slot = await runIn(makeSlots());
    expect(await slot.screenshot()).toEqual({ base64: "Q0RQ", mimeType: "image/jpeg" });
    expect(activations()).toEqual([runTab]);
    expect(windowUpdates()).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(told).toEqual([["S", { type: "auto_tab_switching", tab: "t1", url: "https://run.test/" }]]);
    // The user goes back to their tab: the next screenshot brings it forward again, without telling again.
    await chrome.tabs.update(userTab, { active: true });
    chrome.tabs.updateCalls.length = 0;
    await slot.screenshot();
    expect(activations()).toEqual([runTab]);
    await new Promise((r) => setTimeout(r, 0));
    expect(told).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  it("not while the user is active (chrome.idle, 15 s): they are asked on the card instead, so their keys never land in the run's tab", async () => {
    chrome.idle.state = "active";
    answer = "deny";
    const slot = await runIn(makeSlots());
    await expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.declined);
    expect(chrome.idle.queryCalls).toContain(15);
    expect(activations()).toEqual([]);
    expect(requests).toEqual([expect.objectContaining({ action: "Switch to tab t1", switchTo: { tabId: runTab } })]);
    expect(told.filter(([, e]) => e.type === "auto_tab_switching")).toEqual([]);
  });

  it("active user who says Switch to it: the tab and its window come forward", async () => {
    chrome.idle.state = "active";
    answer = "allow_once";
    const slot = await runIn(makeSlots());
    expect(await slot.screenshot()).toEqual({ base64: "Q0RQ", mimeType: "image/jpeg" });
    expect(activations()).toEqual([runTab]);
    expect(windowUpdates()).toEqual([{ focused: true }]);
  });

  it("an active user in another app (the tab's window not focused) takes no keys there: it switches without asking", async () => {
    chrome.idle.state = "active";
    const get = chrome.windows.get;
    chrome.windows.get = async (id: number) => ({ ...(await get(id)), focused: false });
    const slot = await runIn(makeSlots());
    await slot.screenshot();
    expect(activations()).toEqual([runTab]);
    expect(requests).toEqual([]);
  });

  it("stays on the run's tab after the screenshot (never switches back)", async () => {
    const slot = await runIn(makeSlots());
    await slot.screenshot();
    expect((await chrome.tabs.get(runTab)).active).toBe(true);
    expect(activations()).not.toContain(userTab);
  });

  it("no switch where the capture works as it is: the active tab of an unfocused window, or of a minimized one (debugger)", async () => {
    const slots = makeSlots();
    await chrome.tabs.update(runTab, { active: true });
    await chrome.windows.create({ url: "https://other.test/", focused: true });
    const slot = await runIn(slots);
    await slot.screenshot();
    await chrome.windows.update(windowId, { state: "minimized" });
    chrome.windows.updateCalls.length = 0;
    await slot.screenshot();
    expect(activations()).toEqual([]);
    expect(windowUpdates()).toEqual([]);
    expect(told).toEqual([]);
  });

  it("without the debugger (captureVisibleTab): the tab of a minimized window is shown again, without taking the focus", async () => {
    const slots = makeSlots();
    await chrome.tabs.update(runTab, { active: true });
    chrome.debugger.blocked.add(runTab);
    const slot = await runIn(slots);
    await chrome.windows.update(windowId, { state: "minimized" });
    chrome.windows.updateCalls.length = 0;
    expect(await slot.screenshot()).toMatchObject({ base64: "RkFLRQ==", mimeType: "image/jpeg" });
    expect(windowUpdates()).toEqual([{ state: "normal" }]);
    expect(chrome.tabs.captureCalls).toHaveLength(1);
  });

  it("never for a stopped run: the screenshot says the task was stopped, and nothing moves", async () => {
    const slot = await runIn(makeSlots());
    stopped = true;
    await expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.stopped);
    expect(activations()).toEqual([]);
    expect(told).toEqual([]);
  });
});

describe("Auto tab switching off: the user is asked", () => {
  beforeEach(() => {
    auto = false;
    // Without the debugger a background tab is never captured: the card is asked for at once.
    chrome.debugger.blocked.add(runTab);
  });

  it("Switch to it: the tab and its window come forward, then the capture", async () => {
    answer = "allow_once";
    const slot = await runIn(makeSlots());
    expect(await slot.screenshot()).toMatchObject({ base64: "RkFLRQ==" });
    expect(requests).toEqual([expect.objectContaining({ action: "Switch to tab t1", site: "run.test", switchTo: { tabId: runTab } })]);
    expect(activations()).toEqual([runTab]);
    expect(windowUpdates()).toEqual([{ focused: true }]);
    // The card says it, not the Auto tab switching notice (the limited-mode notice is about the page's frame).
    expect(told.filter(([, e]) => e.type === "auto_tab_switching")).toEqual([]);
  });

  it("the card waits at most SWITCH_APPROVAL_TIMEOUT_MS, then the agent is told nobody answered, and this turn asks no more", async () => {
    vi.useFakeTimers();
    const slot = await runIn(makeSlots());
    const first = expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.timeout);
    await vi.advanceTimersByTimeAsync(SWITCH_APPROVAL_TIMEOUT_MS - 1);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    await expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.timeout);
    expect(requests).toHaveLength(1);
    expect(activations()).toEqual([]);
  });

  it("Not now: nothing moves, the agent is told to read the page, and this turn asks no more; the next turn asks again", async () => {
    answer = "deny";
    const slots = makeSlots();
    const slot = await runIn(slots);
    await expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.declined);
    await expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.declined);
    expect(requests).toHaveLength(1);
    expect(activations()).toEqual([]);
    slots.release(0, "S", { keepTabs: true });
    const next = await runIn(slots);
    await expect(next.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.declined);
    expect(requests).toHaveLength(2);
  });

  it("a stopped run asks nothing and switches nothing; Stop while the card waits ends it without switching", async () => {
    const slots = makeSlots();
    const slot = await runIn(slots);
    stopped = true;
    await expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.stopped);
    expect(requests).toEqual([]);
    // Stopped while it waits: the turn ends (release ends its waiting requests), and a late Switch does nothing.
    stopped = false;
    const shot = slot.screenshot();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    stopped = true;
    slots.release(0, "S", { keepTabs: true });
    await expect(shot).rejects.toThrow(SHOT_NOT_SWITCHED.stopped);
    expect(broker.answer("S", requests[0]!.id, "allow_once")).toBe(false);
    expect(activations()).toEqual([]);
  });

  it("a run nobody watches is not asked (no card): the agent is told", async () => {
    attended = false;
    const slot = await runIn(makeSlots());
    await expect(slot.screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.unattended);
    expect(requests).toEqual([]);
    expect(activations()).toEqual([]);
  });

  it("with the debugger, the hidden tab is tried as it is first: the card only when that capture never answers", async () => {
    chrome.debugger.blocked.delete(runTab);
    answer = "allow_once";
    const slot = await runIn(makeSlots());
    // Answers: no card.
    await slot.screenshot();
    expect(requests).toEqual([]);
    // Never answers while hidden (BACKGROUND_SHOT_TIMEOUT_MS): then the card, and the capture once in front.
    const respond = chrome.debugger.respond;
    chrome.debugger.respond = (method, params) =>
      method === "Page.captureScreenshot" && !chrome.tabs.byId.get(runTab)!.active ? new Promise(() => {}) : respond(method, params);
    vi.useFakeTimers();
    const shot = slot.screenshot();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await shot).toEqual({ base64: "Q0RQ", mimeType: "image/jpeg" });
    expect(requests).toHaveLength(1);
    expect(activations()).toEqual([runTab]);
  });
});

describe("without a chat (no session using the slot)", () => {
  it("off: never brought forward, the agent is told why", async () => {
    auto = false;
    chrome.debugger.blocked.add(runTab);
    const slots = makeSlots();
    await slots.get(0).prepare({ mode: "current-tab", tabId: runTab });
    chrome.tabs.updateCalls.length = 0;
    await expect(slots.get(0).screenshot()).rejects.toThrow(SHOT_NOT_SWITCHED.noChat);
    expect(activations()).toEqual([]);
  });
});
