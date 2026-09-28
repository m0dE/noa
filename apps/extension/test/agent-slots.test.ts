import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { DRAWN } from "./driver-harness.js";
import { AgentSlots } from "../src/agent-slots.js";
import { Cdp } from "../src/cdp.js";
import { TAB_GROUP_TITLE } from "../src/chrome-tabs.js";

let chrome: ChromeFake;
let slots: AgentSlots;
let userTab: number;

const vault = { getCredential: async () => ({ found: false as const }) };

beforeEach(async () => {
  chrome = installChromeFake();
  slots = new AgentSlots(new Cdp(), vault);
  const win = await chrome.windows.create({ url: "https://news.test/", focused: true, type: "normal" });
  userTab = win.tabs[0]!.id;
  chrome.debugger.respond = (method) => {
    const tabId = chrome.debugger.commands.at(-1)!.tabId;
    if (method === "Runtime.evaluate") return { result: { value: { url: chrome.tabs.byId.get(tabId)!.url, title: "t", text: "", elements: DRAWN, truncated: false } } };
    return {};
  };
});

const groupTitle = (tabId: number) => chrome.tabGroups.byId.get(chrome.tabs.byId.get(tabId)!.groupId)?.title;

describe("AgentSlots", () => {
  it("gives each slot its own agent tab in the Noa group, remembered per slot", async () => {
    await slots.take(0, "A").prepare({ mode: "own-tab" });
    await slots.take(1, "B").prepare({ mode: "own-tab" });
    const [a, b] = [await slots.get(0).tab.tabId(), await slots.get(1).tab.tabId()];
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(groupTitle(a!)).toBe(TAB_GROUP_TITLE);
    expect(groupTitle(b!)).toBe(TAB_GROUP_TITLE);
    // Every slot opens its tab in the background: the user keeps the tab they are using.
    expect(chrome.tabs.createCalls.map((c) => c.active)).toEqual([false, false]);
    // Slot 0 keeps the storage keys from before slots; slot 1 has its own.
    const stored = await chrome.storage.session.get(["agentTabId", "agentTabId.1"]);
    expect(stored).toEqual({ agentTabId: a, "agentTabId.1": b });
    // Reusing a slot reuses its tab.
    slots.release(1, "B", { keepTabs: true });
    await slots.take(1, "C").prepare({ mode: "own-tab" });
    expect(await slots.get(1).tab.tabId()).toBe(b);
  });

  it("tabsOf: the tab the session acts on now first (where the user can watch it), then the rest", async () => {
    await slots.take(0, "A").prepare({ mode: "own-tab" });
    const main = (await slots.get(0).tab.tabId())!;
    expect(await slots.tabsOf("A")).toEqual([main]);
    const [opened] = await slots.get(0).tab.open(["https://docs.test/"], { current: true });
    expect(await slots.tabsOf("A")).toEqual([opened!.tabId, main]);
    await slots.get(0).tab.setCurrent("t1");
    expect(await slots.tabsOf("A")).toEqual([main, opened!.tabId]);
    expect(await slots.tabsOf("nobody")).toEqual([]);
  });

  it("routes a session's browser calls to its slot, refuses sessions without one, and sends unnamed calls to slot 0", async () => {
    await slots.take(0, "A").prepare({ mode: "own-tab" });
    await slots.take(1, "B").prepare({ mode: "own-tab" });
    const tabOf = async (sessionId: string | undefined) => {
      await slots.browserFor(sessionId).call("browser.readPage", {});
      return chrome.debugger.commands.at(-1)!.tabId;
    };
    expect(await tabOf("A")).toBe(await slots.get(0).tab.tabId());
    expect(await tabOf("B")).toBe(await slots.get(1).tab.tabId());
    expect(await tabOf(undefined)).toBe(await slots.get(0).tab.tabId());
    slots.release(1, "B", { keepTabs: true });
    expect(() => slots.browserFor("B")).toThrow(/no browser tab right now/);
    expect(slots.slotOf("A")).toBe(0);
    expect(slots.slotOf("B")).toBeNull();
  });

  it("confirm: a change outside the page asks through the session's gate; a session without a slot is refused", async () => {
    const asked: [string, string][] = [];
    const gated = new AgentSlots(new Cdp(), vault, undefined, undefined, {
      context: async () => ({ level: "ask_consequential" }),
      request: async (sessionId, ask) => (asked.push([sessionId, ask.action]), "allow_once"),
      end: () => {},
    });
    gated.take(1, "B");
    const change = { action: 'Cancel the scheduled job "Dentist"', site: "", why: "cancels one of your scheduled jobs" };
    await gated.confirm("B", change);
    expect(asked).toEqual([["B", change.action]]);
    gated.release(1, "B", { keepTabs: true });
    await expect(gated.confirm("B", change)).rejects.toThrow(/nothing was changed/);
    // Without approvals nothing waits.
    slots.take(0, "A");
    await slots.confirm("A", change);
  });

  it("two one-off runs never share the tab the user is looking at", async () => {
    await slots.take(0, "A").prepare({ mode: "current-tab" });
    expect(await slots.get(0).tab.tabId()).toBe(userTab);
    await slots.take(1, "B").prepare({ mode: "current-tab" });
    const b = await slots.get(1).tab.tabId();
    expect(b).not.toBe(userTab);
    // Once A's run is over, the user's tab is free again.
    slots.release(0, "A", { keepTabs: true });
    slots.release(1, "B", { keepTabs: true });
    await chrome.tabs.update(userTab, { active: true });
    await slots.take(1, "C").prepare({ mode: "current-tab" });
    expect(await slots.get(1).tab.tabId()).toBe(userTab);
  });

  it("a driver keeps the other slots' tabs attached", async () => {
    await slots.take(0, "A").prepare({ mode: "own-tab" });
    await slots.take(1, "B").prepare({ mode: "own-tab" });
    await slots.browserFor("A").call("browser.readPage", {});
    await slots.browserFor("B").call("browser.readPage", {});
    // Preparing slot 0 again (its next run) must not detach slot 1's tab.
    await slots.take(0, "A2").prepare({ mode: "own-tab" });
    const b = (await slots.get(1).tab.tabId())!;
    expect(chrome.debugger.attached.has(b)).toBe(true);
  });

  it("a run never takes over the user's screen: turn start, next turns, switch_tab, screenshot; Show Tab does", async () => {
    const windowId = chrome.tabs.byId.get(userTab)!.windowId;
    const runTab = (await chrome.tabs.create({ windowId, url: "https://run.test/", active: false })).id;
    const takeovers = () => [
      ...chrome.tabs.updateCalls.filter((c) => c.props.active),
      ...chrome.windows.updateCalls.filter((c) => c.props.focused),
    ];
    chrome.tabs.updateCalls.length = 0;
    chrome.windows.updateCalls.length = 0;
    const slot = slots.take(0, "S");
    const prev = chrome.debugger.respond;
    chrome.debugger.respond = (method, params) => (method === "Page.captureScreenshot" ? { data: "Q0RQ" } : prev(method, params));
    // Turn start of a one-off in its (background) tab, then the next turns.
    await slot.prepare({ mode: "current-tab", tabId: runTab });
    await slot.browser.call("browser.openTabs", { urls: ["https://run.test/2"] });
    await slot.browser.call("browser.switchTab", { tab: "t2" });
    await slot.browser.call("browser.switchTab", { tab: "t1" });
    expect(await slot.screenshot()).toEqual({ base64: "Q0RQ", mimeType: "image/jpeg" });
    await slot.prepare({ mode: "current-tab", tabId: runTab });
    // A conversation without a tab continues in the agent's own tab.
    await slot.prepare({ mode: "own-tab" });
    await slot.screenshot();
    expect(takeovers()).toEqual([]);
    expect((await chrome.tabs.get(userTab)).active).toBe(true);
    // The user's Show Tab: the run's tab comes to the front.
    const shown = (await slots.get(0).tab.tabId())!;
    expect(await slots.show("S")).toBe(true);
    expect(chrome.windows.updateCalls).toEqual([{ id: windowId, props: { focused: true } }]);
    expect(chrome.tabs.updateCalls.filter((c) => c.props.active)).toEqual([{ id: shown, props: { active: true } }]);
    expect((await chrome.tabs.get(shown)).active).toBe(true);
  });
});
