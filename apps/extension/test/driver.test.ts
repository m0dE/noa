import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeFake } from "./chrome-fake.js";
import { driverHarness, userWindow as openWindow } from "./driver-harness.js";
import { addressOnly, AgentTab, keptChatTabs } from "../src/agent-tab.js";
import { DEBUGGER_CANCELED, type Cdp } from "../src/cdp.js";
import type { Driver } from "../src/driver.js";
import { PAGE_MARKS } from "../src/driver-common.js";
import { snapshotExpression } from "../src/page-snapshot.js";

let chrome: ChromeFake;
let cdp: Cdp;
let agent: AgentTab;
let driver: Driver;
/** Values returned by Runtime.evaluate, matched by a substring of the expression. */
let evalResults: [string, unknown][];

beforeEach(() => {
  ({ chrome, cdp, agent, driver } = driverHarness());
  evalResults = [];
  chrome.debugger.respond = (method, params) => {
    if (method === "Runtime.evaluate") {
      const expr = String((params as { expression: string }).expression);
      const hit = evalResults.find(([needle]) => expr.includes(needle));
      return { result: { value: hit ? hit[1] : undefined } };
    }
    if (method === "Page.captureScreenshot") return { data: "SU1H" };
    if (method === "Page.navigate") return { frameId: "f", loaderId: "l" };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 42 };
    return {};
  };
});

const inputCommands = () => chrome.debugger.commands.filter((c) => c.method.startsWith("Input."));

/** A focused normal window whose active tab shows `url`. */
const userWindow = (url: string) => openWindow(chrome, url);

/**
 * coverInPage's answer before a click on what is no checkbox: a click at (x, y) reaches it; armed: whether it armed the
 * click's input check there (it does when the driver gives it one).
 */
const freeAt = (x: number, y: number, armed?: boolean): [string, unknown] => [
  "function coverInPage",
  { ok: true, value: { state: { checkable: false, checked: false, radio: false }, cover: { x, y }, ...(armed === undefined ? {} : { armed }) } },
];
/** The expressions the driver evaluated, in order. */
const evaluated = () => chrome.debugger.commands.filter((c) => c.method === "Runtime.evaluate").map((c) => String((c.params as { expression: string }).expression));

describe("AgentTab", () => {
  it("one-off runs act on the tab the user is looking at, in a Noa group", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    await chrome.windows.create({ url: "https://popup.test/", focused: false, type: "popup" });
    expect(await agent.prepare("current-tab")).toBe(tabId);
    expect(chrome.tabs.createCalls).toEqual([]);
    expect(chrome.windows.createCalls).toHaveLength(2);
    expect(chrome.storage.session.data.agentTabId).toBe(tabId);
    expect(await agent.isAgentTab(tabId)).toBe(true);
    expect(await agent.isAgentTab(999)).toBe(false);
    expect(await agent.windowId()).toBe(windowId);
    const group = chrome.tabGroups.byId.get(chrome.tabs.byId.get(tabId)!.groupId)!;
    // Grey while nothing runs; the control indicator colours it while the agent acts (control-indicator.ts).
    expect(group).toMatchObject({ windowId, title: "Noa", color: "grey" });
  });

  it.each([
    "chrome://newtab/",
    "chrome-extension://abc/page.html",
    "https://chromewebstore.google.com/detail/x",
    "https://chrome.google.com/webstore/x",
    "https://chrome.google.com/u/2/webstore/devconsole/x",
    "about:version",
    "edge://settings",
    "devtools://devtools/x",
    "view-source:https://a.test/",
    "",
  ])("one-off run on %j opens a new active tab right after it", async (url) => {
    const { windowId, tabId } = await userWindow("https://first.test/");
    const second = await chrome.tabs.create({ windowId, url, active: true });
    await chrome.tabs.create({ windowId, url: "https://third.test/", active: false });
    chrome.tabs.createCalls.length = 0;
    const agentTab = await agent.prepare("current-tab");
    expect(agentTab).not.toBe(tabId);
    expect(agentTab).not.toBe(second.id);
    expect(chrome.tabs.createCalls).toEqual([{ windowId, index: 2, active: true, url: "about:blank" }]);
    expect((await chrome.tabs.get(agentTab)).active).toBe(true);
  });

  it("a tab a page of the run opens joins the run (grouped, in the background), is reported once, and stays open after the run", async () => {
    const { windowId, tabId } = await userWindow("https://x.test/compose");
    await agent.prepare("current-tab");
    const other = await chrome.tabs.create({ windowId, url: "https://elsewhere.test/", active: false });
    // Opened by some other tab: not the run's.
    expect(await agent.adopt(other.id!, 999)).toBeNull();
    const popup = await chrome.tabs.create({ windowId, url: "https://x.test/grok", active: false });
    chrome.tabs.byId.get(popup.id!)!.title = "Grok Imagine";
    expect(await agent.adopt(popup.id!, tabId)).toEqual({ id: "t2", tabId: popup.id, opened: true, fromPage: true });
    expect(await agent.adopt(popup.id!, tabId)).toBeNull();
    // The run's tabs, then the user's other tab in the window (opened after prepare: it is listed with the next id).
    expect((await agent.list()).map((t) => [t.id, t.tabId, !!t.user])).toEqual([["t1", tabId, false], ["t2", popup.id, false], ["t3", other.id, true]]);
    expect(chrome.tabGroups.byId.get(chrome.tabs.byId.get(popup.id!)!.groupId)!.title).toBe("Noa");
    expect((await chrome.tabs.get(popup.id!)).active).toBe(false);
    expect(await agent.takeNewTabs()).toEqual([{ id: "t2", url: "https://x.test/grok", title: "Grok Imagine" }]);
    expect(await agent.takeNewTabs()).toEqual([]);
    // The run's result may be in it: it is not closed with the run's open_tabs tabs.
    await agent.closeOpened();
    expect(await chrome.tabs.get(popup.id!)).toBeDefined();
    expect(await agent.isAgentTab(popup.id!)).toBe(false);
  });

  it("a run from the user's tab may use their other tabs in that window: listed with ids, read without switching, never closed", async () => {
    const { windowId, tabId } = await userWindow("https://forms.test/new");
    const source = await chrome.tabs.create({ windowId, url: "https://records.test/7", active: false });
    chrome.tabs.byId.get(source.id!)!.title = "Record 7";
    await chrome.tabs.create({ windowId, url: "chrome://settings/", active: false });
    await chrome.tabs.create({ windowId, url: "about:blank", active: false });
    const elsewhere = await chrome.windows.create({ url: "https://other-window.test/", focused: false });
    await agent.prepare("current-tab");
    // Only the pages the agent can use, in this window; the run's own tab is t1.
    expect(await agent.userTabs()).toEqual({ tabs: [{ id: "t2", url: "https://records.test/7", title: "Record 7" }], more: 0 });
    expect(await agent.isAgentTab(source.id!)).toBe(false);
    expect(elsewhere).toBeDefined();
    // open_tabs numbers after them and does not count them.
    const opened = (await agent.open(["https://more.test/"]))[0]!;
    expect(opened.id).toBe("t3");
    // Using one makes it the run's (not grouped, not activated); the user keeps their tab in front.
    expect(await agent.resolve("t2")).toBe(source.id);
    expect(await agent.isAgentTab(source.id!)).toBe(true);
    expect(chrome.tabs.byId.get(source.id!)!.groupId).toBe(-1);
    expect((await chrome.tabs.get(tabId)).active).toBe(true);
    await expect(agent.close(["t2"])).rejects.toThrow("t2 is one of the user's own tabs; it is never closed");
    // The run's end closes what it opened, never the user's tab.
    await agent.closeOpened();
    expect(chrome.tabs.byId.has(opened.tabId)).toBe(false);
    expect(chrome.tabs.byId.has(source.id!)).toBe(true);
    expect(await agent.isAgentTab(source.id!)).toBe(false);
  });

  it("a user's tab another run uses is not offered; a chat's next turn finds the user's tabs again instead of keeping them", async () => {
    const { windowId } = await userWindow("https://forms.test/new");
    const busy = await chrome.tabs.create({ windowId, url: "https://busy.test/", active: false });
    const free = await chrome.tabs.create({ windowId, url: "https://free.test/", active: false });
    const taken = new AgentTab(0, { isTaken: (id) => id === busy.id });
    await taken.prepare("current-tab", { owner: "chat-1" });
    expect((await taken.userTabs()).tabs.map((t) => t.url)).toEqual(["https://free.test/"]);
    await taken.resolve("t2");
    await taken.park("chat-1");
    // Not kept as one of the chat's opened tabs: still the user's.
    expect(await keptChatTabs()).toEqual({});
    expect(await taken.isAgentTab(free.id!)).toBe(false);
    await taken.prepare("current-tab", { owner: "chat-1" });
    // Same ids as the turn before.
    expect((await taken.list()).map((t) => [t.id, !!t.user])).toEqual([["t1", false], ["t2", true]]);
  });

  it("the user's tabs are given without the query and #part of their address until the run uses them", async () => {
    const { windowId } = await userWindow("https://forms.test/new");
    const reset = await chrome.tabs.create({ windowId, url: "https://login.test/reset?token=s3cr3t-r3set#code=oauth-c0de", active: false });
    chrome.tabs.byId.get(reset.id!)!.title = "Reset your password";
    await agent.prepare("current-tab");
    expect(await agent.userTabs()).toEqual({ tabs: [{ id: "t2", url: "https://login.test/reset", title: "Reset your password" }], more: 0 });
    expect((await driver.listTabs()).tabs.find((t) => t.id === "t2")).toMatchObject({ url: "https://login.test/reset", user: true });
    // Once the agent reads it (or works in it), its full address is what it sees anyway.
    await agent.resolve("t2");
    expect((await driver.listTabs()).tabs.find((t) => t.id === "t2")!.url).toBe("https://login.test/reset?token=s3cr3t-r3set#code=oauth-c0de");
  });

  it("addressOnly keeps origin and path", () => {
    expect(addressOnly("https://a.test/p/q?x=1#y")).toBe("https://a.test/p/q");
    expect(addressOnly("https://a.test")).toBe("https://a.test/");
    expect(addressOnly("file:///home/me/doc.html?v=2")).toBe("file:///home/me/doc.html");
    expect(addressOnly("not a url?x#y")).toBe("not a url");
  });

  it("only the user's 12 tabs used last are given, with how many were left out", async () => {
    const { windowId } = await userWindow("https://forms.test/new");
    for (let i = 1; i <= 15; i++) {
      const t = await chrome.tabs.create({ windowId, url: `https://site${i}.test/`, active: false });
      chrome.tabs.byId.get(t.id!)!.lastAccessed = i;
    }
    await agent.prepare("current-tab");
    const { tabs, more } = await agent.userTabs();
    expect(tabs.map((t) => t.url)).toEqual(Array.from({ length: 12 }, (_, i) => `https://site${i + 4}.test/`));
    expect(more).toBe(3);
  });

  it("with Use my other tabs off, the run is given none of the user's tabs and cannot use them", async () => {
    const { windowId } = await userWindow("https://forms.test/new");
    await chrome.tabs.create({ windowId, url: "https://records.test/7", active: false });
    await agent.prepare("current-tab", { userTabs: false });
    expect(await agent.userTabs()).toEqual({ tabs: [], more: 0 });
    expect((await agent.list()).map((t) => t.id)).toEqual(["t1"]);
    await expect(agent.resolve("t2")).rejects.toThrow('unknown tab "t2"');
  });

  it("scheduled runs (own tab) are not given the user's tabs", async () => {
    const { windowId } = await userWindow("https://forms.test/new");
    await chrome.tabs.create({ windowId, url: "https://records.test/7", active: false });
    await agent.prepare("own-tab");
    expect(await agent.userTabs()).toEqual({ tabs: [], more: 0 });
    expect((await agent.list()).map((t) => t.id)).toEqual(["t1"]);
  });

  it("the driver's next result tells the agent about a tab the page opened", async () => {
    const { windowId, tabId } = await userWindow("https://x.test/compose");
    await agent.prepare("current-tab");
    evalResults.push(["snapshotPage", { url: "https://x.test/compose", title: "X", text: "What is happening?! Post your reply", elements: [{}, {}, {}], truncated: false }]);
    const popup = await chrome.tabs.create({ windowId, url: "https://x.test/grok", active: false });
    await agent.adopt(popup.id!, tabId);
    const snap = await driver.readPage();
    expect(snap.note).toMatch(/^A new tab opened from the page: t2 "" https:\/\/x\.test\/grok\. Your current tab is still the one you were in: use switch_tab t2 to work in the new one/);
    expect((await driver.readPage()).note).toBeUndefined();
  });

  it("a new tab on a page Chrome keeps extensions out of is reported as such, not as one to read", async () => {
    const { windowId, tabId } = await userWindow("https://x.test/compose");
    await agent.prepare("current-tab");
    evalResults.push(["snapshotPage", { url: "https://x.test/compose", title: "X", text: "What is happening?! Post your reply", elements: [{}, {}, {}], truncated: false }]);
    const store = await chrome.tabs.create({ windowId, url: "https://chrome.google.com/u/2/webstore/devconsole/x", active: false });
    await agent.adopt(store.id!, tabId);
    const { note } = await driver.readPage();
    expect(note).toMatch(/^A new tab opened from the page: t2 .*Chrome doesn't allow extensions to see or control it/);
    expect(note).not.toMatch(/read_page, act and screenshot work there/);
  });

  it("about:blank is controllable", async () => {
    const { tabId } = await userWindow("about:blank");
    expect(await agent.prepare("current-tab")).toBe(tabId);
  });

  it("opens a focused window when there is no normal window", async () => {
    const tabId = await agent.prepare("current-tab");
    expect(chrome.windows.createCalls).toEqual([{ url: "about:blank", focused: true, type: "normal" }]);
    expect(chrome.tabs.byId.get(tabId)!.url).toBe("about:blank");
  });

  it("scheduled runs open a background tab in the last focused window, then reuse it", async () => {
    const { windowId, tabId: userTab } = await userWindow("https://example.com/");
    const first = await agent.prepare("own-tab");
    expect(first).not.toBe(userTab);
    expect(chrome.tabs.createCalls).toEqual([{ windowId, active: false, url: "about:blank" }]);
    expect((await chrome.tabs.get(userTab)).active).toBe(true);
    expect(chrome.windows.createCalls).toHaveLength(1);
    // The user moves on; the next scheduled run reuses the same tab.
    await chrome.tabs.update(userTab, { active: true });
    expect(await agent.prepare("own-tab")).toBe(first);
    expect(chrome.tabs.createCalls).toHaveLength(1);
    // Gone: a new one is opened.
    await chrome.tabs.remove(first);
    const third = await agent.prepare("own-tab");
    expect(third).not.toBe(first);
    expect(chrome.tabs.createCalls).toHaveLength(2);
    expect(chrome.storage.session.data.agentTabId).toBe(third);
  });

  it("scheduled runs open an unfocused window when there is none", async () => {
    await agent.prepare("own-tab");
    expect(chrome.windows.createCalls).toEqual([{ url: "about:blank", focused: false, type: "normal" }]);
  });

  it("joins an existing Noa group in the same window and creates only one", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    const other = await chrome.windows.create({ url: "https://b.test/", focused: false, type: "normal" });
    const elsewhere = await chrome.tabs.group({ tabIds: [other.tabs[0]!.id], createProperties: { windowId: other.id } });
    await chrome.tabGroups.update(elsewhere, { title: "Noa", color: "blue" });
    const loose = await chrome.tabs.create({ windowId, url: "https://c.test/", active: false });
    const existing = await chrome.tabs.group({ tabIds: [loose.id], createProperties: { windowId } });
    await chrome.tabGroups.update(existing, { title: "Noa", color: "blue" });
    await agent.prepare("current-tab");
    expect(chrome.tabs.byId.get(tabId)!.groupId).toBe(existing);
    await agent.prepare("own-tab");
    await agent.prepare("current-tab");
    expect(chrome.tabGroups.byId.size).toBe(2);
  });

  it("does not rename a group of the user's own", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    const mine = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(mine, { title: "Work", color: "red" });
    await agent.prepare("current-tab");
    expect(chrome.tabGroups.byId.get(mine)).toMatchObject({ title: "Work", color: "red" });
    expect(chrome.tabGroups.byId.get(chrome.tabs.byId.get(tabId)!.groupId)!.title).toBe("Noa");
  });

  it("still works when tab groups are unavailable", async () => {
    await userWindow("https://example.com/");
    const c = chrome as unknown as Record<string, any>;
    c.tabs.group = async () => {
      throw new Error("no groups");
    };
    expect(typeof (await agent.prepare("current-tab"))).toBe("number");
  });

  it("the driver keeps using the run's tab after the user switches tabs", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    const other = await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    await driver.readPage();
    expect(chrome.debugger.commands.at(-1)!.tabId).toBe(tabId);
    expect(chrome.debugger.attached.has(other.id)).toBe(false);
  });

  it("switching the agent to a different tab detaches the old one", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    await driver.ready();
    const next = await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    await agent.prepare("current-tab");
    await driver.ready();
    expect([...chrome.debugger.attached]).toEqual([next.id]);
    expect(chrome.debugger.attached.has(tabId)).toBe(false);
  });

  it("fails the next browser call readably when the user closed the agent tab", async () => {
    const { tabId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    await driver.readPage();
    await chrome.tabs.remove(tabId);
    await expect(driver.readPage()).rejects.toThrow("the agent tab was closed");
  });

  it("show() focuses the agent tab's window and activates the tab", async () => {
    expect(await agent.show()).toBe(false);
    const { windowId } = await userWindow("https://example.com/");
    const agentTab = await agent.prepare("own-tab");
    const { windowId: later } = await userWindow("https://later.test/");
    expect(later).not.toBe(windowId);
    await chrome.tabs.update((await chrome.tabs.query({ windowId }))[0]!.id, { active: true });
    chrome.tabs.updateCalls.length = 0;
    expect(await agent.show()).toBe(true);
    expect(chrome.windows.updateCalls).toEqual([{ id: windowId, props: { focused: true } }]);
    expect(chrome.tabs.updateCalls).toEqual([{ id: agentTab, props: { active: true } }]);
    expect(chrome.windows.focusOrder.at(-1)).toBe(windowId);
    expect((await chrome.tabs.get(agentTab)).active).toBe(true);
  });

  it("show() restores a minimized window", async () => {
    const { windowId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    chrome.windows.byId.get(windowId)!.state = "minimized";
    await agent.show();
    expect(chrome.windows.updateCalls.at(-1)).toEqual({ id: windowId, props: { focused: true, state: "normal" } });
  });
});

describe("Cdp", () => {
  it("attaches with protocol 1.3 and reattaches once after a detach", async () => {
    const attach = vi.spyOn(chrome.debugger, "attach");
    await cdp.attach(5);
    expect(attach).toHaveBeenCalledWith({ tabId: 5 }, "1.3");
    chrome.debugger.attached.delete(5);
    cdp.handleDetach({ tabId: 5 }, "target_closed");
    await cdp.send("Page.enable");
    expect(attach).toHaveBeenCalledTimes(2);
    expect(chrome.debugger.commands.at(-1)).toMatchObject({ tabId: 5, method: "Page.enable" });
  });

  it("fails sends after the user cancels, and tells the listener", async () => {
    const onCancel = vi.fn();
    cdp.onUserCancel = onCancel;
    await cdp.attach(5);
    chrome.debugger.attached.delete(5);
    cdp.handleDetach({ tabId: 5 }, "canceled_by_user");
    expect(onCancel).toHaveBeenCalled();
    await expect(cdp.send("Page.enable")).rejects.toThrow(DEBUGGER_CANCELED);
    // A fresh task resets the state.
    cdp.reset();
    await cdp.attach(5);
    await expect(cdp.send("Page.enable")).resolves.toBeDefined();
  });

  it("a command that meets a page being swapped ('Not attached to an active page') attaches again and runs", async () => {
    const { tabId } = await userWindow("https://example.com/");
    await cdp.attach(tabId);
    let refusals = 2;
    chrome.debugger.respond = (method) => {
      if (method === "Runtime.evaluate" && refusals-- > 0) throw new Error('{"code":-32000,"message":"Not attached to an active page"}');
      return { result: { value: 7 } };
    };
    expect(await cdp.sendTo(tabId, "Runtime.evaluate", { expression: "7" })).toEqual({ result: { value: 7 } });
    expect(refusals).toBe(-1);
    chrome.debugger.respond = () => {
      throw new Error("Not attached to an active page");
    };
    await expect(cdp.sendTo(tabId, "Runtime.evaluate", {})).rejects.toThrow("Not attached to an active page");
  });

  it("ignores detaches of other tabs", async () => {
    await cdp.attach(5);
    cdp.handleDetach({ tabId: 6 }, "canceled_by_user");
    await expect(cdp.send("Page.enable")).resolves.toBeDefined();
  });
});

describe("Driver", () => {
  it("click scrolls the element into view and sends a trusted mouse click at its center", async () => {
    evalResults.push(freeAt(110, 220, true), ['"gone" : p.seen', "seen"]);
    await driver.click({ index: 3 });
    expect(inputCommands().map((c) => c.params)).toEqual([
      { type: "mouseMoved", x: 110, y: 220, button: "none" },
      { type: "mousePressed", x: 110, y: 220, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x: 110, y: 220, button: "left", buttons: 0, clickCount: 1 },
    ]);
    // One page script before the click (its check state, scrolled into view, the point, and the input check armed
    // there), then the check read after it, under the nonce the first one armed.
    const [aim, read] = evaluated();
    expect(evaluated()).toHaveLength(2);
    const nonce = /"key":"noa\.inputProbe","nonce":"([^"]+)"/.exec(aim!)?.[1];
    expect(aim!.startsWith("(function coverInPage")).toBe(true);
    expect(nonce).toBeTruthy();
    expect(read).toContain(JSON.stringify(nonce));
  });

  it("click with no answer to the cover check arms the input check itself, and fails when the page got none of the click", async () => {
    evalResults.push(["(function coverInPage", undefined], ["function armInputProbe", true], ['"gone" : p.seen', "none"], ["scrollIntoView", { x: 7, y: 8 }]);
    await expect(driver.click({ index: 3 })).rejects.toThrow(/never reached the page.*Chrome dialog/);
    expect(evaluated().map((e) => /^\(function (\w+)/.exec(e)?.[1] ?? "expression")).toEqual(["coverInPage", "expression", "armInputProbe", "expression"]);
  });

  it("click with no answer from the page (navigating) is no verdict: a click at the element's center", async () => {
    evalResults.push(["scrollIntoView({ block: \"center\", inline: \"center\", behavior: \"instant\" });\n        const r", { x: 7, y: 8 }]);
    await driver.click({ index: 3 });
    expect(inputCommands().map((c) => [(c.params as { x: number }).x, (c.params as { y: number }).y])).toEqual([[7, 8], [7, 8], [7, 8]]);
  });

  // Measured in real Chromium (2026-10-09): after a sign-in, Chrome's own "password found in a data breach" dialog held
  // the tab's input; every click "succeeded" while the page got nothing, and the agent tried for two minutes.
  it("click fails, saying why, when the page received none of it (input held outside the page)", async () => {
    evalResults.push(freeAt(110, 220, true), ['"gone" : p.seen', "none"]);
    await expect(driver.click({ index: 3 })).rejects.toThrow(/never reached the page.*Chrome dialog/);
  });

  it("click succeeds when the page got the click, or it navigated (a new document), or the point is over a frame", async () => {
    evalResults.push(freeAt(110, 220, true), ['"gone" : p.seen', "seen"]);
    await driver.click({ index: 3 });
    evalResults = [freeAt(110, 220, true), ['"gone" : p.seen', "gone"]];
    await driver.click({ index: 3 });
    // Not armed (a frame under the point): no answer is read.
    chrome.debugger.commands.length = 0;
    evalResults = [freeAt(110, 220, false), ['"gone" : p.seen', "none"]];
    await driver.click({ index: 3 });
    expect(evaluated()).toHaveLength(1);
  });

  it("click reports a missing element", async () => {
    await expect(driver.click({ index: 9 })).rejects.toThrow("element 9 not found; call read_page again");
  });

  /** The page functions the driver ran, by name, in order. */
  const pageCalls = () =>
    chrome.debugger.commands
      .filter((c) => c.method === "Runtime.evaluate")
      .map((c) => /^\(function (\w+)/.exec(String((c.params as { expression: string }).expression))?.[1] ?? "expression");

  it("type into a field: checks what it is, clicks it, selects its value so the text replaces it, then inserts text", async () => {
    evalResults.push(["function coverInPage", { ok: true, value: { cover: { x: 1, y: 2 }, target: "field", armed: true } }], ["prepareTypingInPage", { ok: true, value: true }], ['"gone" : p.seen', "seen"]);
    expect(await driver.type({ index: 2, text: "hello" })).toEqual({ ok: true });
    const methods = inputCommands().map((c) => c.method);
    expect(methods).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.insertText"]);
    expect(inputCommands().at(-1)!.params).toEqual({ text: "hello" });
    // First, in one script, whether an open modal dialog covers it, where a click reaches it, what typing into it
    // means, and the click's input check armed there; then that check read after the click; after the text, the field's
    // suggestions (the fake page gives no verdict: none).
    expect(pageCalls()).toEqual(["coverInPage", "expression", "prepareTypingInPage", "suggestionsInPage"]);
  });

  it("type with empty text empties the element: it is prepared whole (an editor too), then the empty text replaces the selection", async () => {
    evalResults.push(
      ["function coverInPage", { ok: true, value: { cover: { x: 1, y: 2 }, target: "field" } }],
      ["prepareTypingInPage", { ok: true, value: true }],
      ["scrollIntoView", { x: 1, y: 2 }],
      ["typedTextInPage", { ok: true, value: "" }],
    );
    expect(await driver.type({ index: 2, text: "" })).toEqual({ ok: true });
    expect(inputCommands().map((c) => c.method)).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.insertText"]);
    expect(inputCommands().at(-1)!.params).toEqual({ text: "" });
    // Read once, right after the deletion: empty, so not again.
    expect(pageCalls().filter((c) => c === "typedTextInPage")).toHaveLength(1);
    const prepare = chrome.debugger.commands.map((c) => String((c.params as { expression?: string })?.expression ?? "")).find((e) => e.startsWith("(function prepareTypingInPage"));
    expect(prepare).toMatch(/\)\(\{.*\}, 2, true\)$/s);
  });

  it("type with empty text where text is left (an editor that ignores the inserted nothing): its whole text selected again, a Backspace on it, then an error if it stays", async () => {
    evalResults.push(
      ["function coverInPage", { ok: true, value: { cover: { x: 1, y: 2 }, target: "editor" } }],
      ["prepareTypingInPage", { ok: true, value: true }],
      ["scrollIntoView", { x: 1, y: 2 }],
      ["typedTextInPage", { ok: true, value: "old text" }],
    );
    await expect(driver.type({ index: 2, text: "" })).rejects.toThrow('element 2 still holds "old text" after its whole text was selected and deleted');
    expect(inputCommands().slice(3).map((c) => [c.method, (c.params as { key?: string }).key])).toEqual([
      ["Input.insertText", undefined],
      ["Input.dispatchKeyEvent", "Backspace"],
      ["Input.dispatchKeyEvent", "Backspace"],
    ]);
    // Prepared twice (an editor may move the selection back after the click's focus), read, selected whole again
    // right before the Backspace, then read until the 1 s wait runs out.
    const typing = pageCalls().filter((c) => c === "prepareTypingInPage" || c === "typedTextInPage");
    expect(typing.slice(0, 4)).toEqual(["prepareTypingInPage", "prepareTypingInPage", "typedTextInPage", "prepareTypingInPage"]);
    expect(typing.slice(4).every((c) => c === "typedTextInPage")).toBe(true);
  });

  it("type with text prepares an editor as usual (the caret at its end), twice: again once its own selection restore has run", async () => {
    evalResults.push(["function coverInPage", { ok: true, value: { cover: { x: 1, y: 2 }, target: "editor" } }], ["prepareTypingInPage", { ok: true, value: true }], ["scrollIntoView", { x: 1, y: 2 }]);
    await driver.type({ index: 2, text: "more" });
    const prepares = chrome.debugger.commands.map((c) => String((c.params as { expression?: string })?.expression ?? "")).filter((e) => e.startsWith("(function prepareTypingInPage"));
    expect(prepares).toHaveLength(2);
    for (const p of prepares) expect(p).toMatch(/\)\(\{.*\}, 2, false\)$/s);
    expect(inputCommands().at(-1)).toMatchObject({ method: "Input.insertText", params: { text: "more" } });
  });

  it("type into a dropdown chooses the option in the page: no click (it would open the native popup), no text input", async () => {
    evalResults.push(["function coverInPage", { ok: true, value: { cover: { x: 1, y: 2 }, target: "select" } }], ["selectOptionInPage", { ok: true, value: "United Kingdom" }]);
    expect(await driver.type({ index: 8, text: "united kingdom" })).toEqual({ ok: true, selected: "United Kingdom" });
    expect(inputCommands()).toEqual([]);
    expect(pageCalls()).toEqual(["coverInPage", "selectOptionInPage"]);
  });

  it("type into what takes no text (a checkbox, a button) fails before anything is clicked or typed", async () => {
    evalResults.push(["function coverInPage", { ok: false, error: "element 14 is a checkbox or radio button, which takes no text: set it with checked (true or false) instead" }]);
    await expect(driver.type({ index: 14, text: "yes" })).rejects.toThrow(/set it with checked/);
    expect(inputCommands()).toEqual([]);
  });

  it("type stops when the click focused no text field: the text never goes to the field focused before", async () => {
    evalResults.push(
      ["function coverInPage", { ok: true, value: { cover: { x: 1, y: 2 }, target: "other" } }],
      ["prepareTypingInPage", { ok: false, error: "element 5 did not focus a text field when clicked, so nothing was typed" }],
      ["scrollIntoView", { x: 1, y: 2 }],
    );
    await expect(driver.type({ index: 5, text: "United Kingdom" })).rejects.toThrow(/nothing was typed/);
    expect(inputCommands().map((c) => c.method)).not.toContain("Input.insertText");
  });

  it("click with checked on an unchecked box clicks it and reports the new state", async () => {
    let checked = false;
    chrome.debugger.respond = (method, params) => {
      if (method === "Input.dispatchMouseEvent" && (params as { type: string }).type === "mouseReleased") checked = !checked;
      if (method !== "Runtime.evaluate") return {};
      const expr = String((params as { expression: string }).expression);
      const state = { checkable: true, checked, radio: false };
      if (expr.includes("function checkStateInPage")) return { result: { value: { ok: true, value: state } } };
      if (expr.includes("function coverInPage")) {
        // As the page decides: with checked and the box so already, nothing over it is checked (no click follows).
        const act = /, "(\w+)"\)$/.exec(expr)?.[1];
        const already = (act === "check" && checked) || (act === "uncheck" && !checked);
        return { result: { value: { ok: true, value: already ? { state } : { state, cover: { x: 5, y: 6 } } } } };
      }
      return { result: { value: undefined } };
    };
    expect(await driver.click({ index: 14, checked: true })).toEqual({ ok: true, checked: true });
    // A second call does not toggle it back.
    expect(await driver.click({ index: 14, checked: true })).toEqual({ ok: true, checked: true });
    expect(inputCommands().filter((c) => (c.params as { type: string }).type === "mouseReleased")).toHaveLength(1);
    // A plain click toggles, and says so.
    expect(await driver.click({ index: 14 })).toEqual({ ok: true, checked: false });
  });

  it("click with checked on what is not a checkbox fails without clicking", async () => {
    evalResults.push(["function coverInPage", { ok: true, value: { state: { checkable: false, checked: false, radio: false } } }]);
    await expect(driver.click({ index: 4, checked: true })).rejects.toThrow(/not a checkbox, radio button or switch/);
    expect(inputCommands()).toEqual([]);
  });

  it("click with checked sets the state in the page when the click did not (something covers the box)", async () => {
    evalResults.push(
      ["function coverInPage", { ok: true, value: { state: { checkable: true, checked: false, radio: false }, cover: { x: 1, y: 2 } } }],
      ["function checkStateInPage", { ok: true, value: { checkable: true, checked: false, radio: false } }],
      ["setCheckedInPage", { ok: true, value: true }],
    );
    expect(await driver.click({ index: 14, checked: true })).toEqual({ ok: true, checked: true });
    expect(pageCalls()).toContain("setCheckedInPage");
  });

  it("paste inserts text at the focus", async () => {
    await driver.paste({ text: "x y" });
    expect(inputCommands()).toEqual([{ tabId: expect.any(Number), method: "Input.insertText", params: { text: "x y" } }]);
  });

  it("pressKey sends keyDown and keyUp", async () => {
    await driver.pressKey({ key: "Control+Enter" });
    expect(inputCommands().map((c) => (c.params as { type: string; modifiers: number }).type)).toEqual(["keyDown", "keyUp"]);
    expect((inputCommands()[0]!.params as { modifiers: number }).modifiers).toBe(2);
  });

  it("scroll wheels at the viewport center by amount x 0.8 x viewport", async () => {
    evalResults.push(["scrollViewInPage", { ok: true, value: { w: 1000, h: 800, stepW: 1000, stepH: 800 } }]);
    await driver.scroll({ direction: "down", amount: 2 });
    await driver.scroll({ direction: "left" });
    expect(inputCommands().map((c) => c.params)).toEqual([
      { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 1280 },
      { type: "mouseWheel", x: 500, y: 400, deltaX: -800, deltaY: 0 },
    ]);
  });

  describe("scroll measures what moved", () => {
    const pageEntry = (top: number, sh = 5400) => ({ page: true, index: null, top, left: 0, sh, sw: 1000, ch: 800, cw: 1000, oy: true, ox: true });
    /** Probe answers: "measure" gives `before`, every "read" the next of `reads` (the last repeats). */
    function probe(before: unknown, reads: unknown[]) {
      let n = 0;
      const base = chrome.debugger.respond;
      chrome.debugger.respond = (method, params) => {
        const expr = String((params as { expression?: string })?.expression ?? "");
        if (expr.includes(`${JSON.stringify(PAGE_MARKS)}, "measure"`)) return { result: { value: { ok: true, value: before } } };
        if (expr.includes(`${JSON.stringify(PAGE_MARKS)}, "read"`)) return { result: { value: { ok: true, value: reads[Math.min(n++, reads.length - 1)] } } };
        return base!(method, params);
      };
    }

    it("the page moved: reports pixels and the new position, after the smooth scroll settled", async () => {
      evalResults.push(["scrollViewInPage", { ok: true, value: { w: 1000, h: 800, stepW: 1000, stepH: 800 } }]);
      probe({ entries: [pageEntry(640)], overFrame: false }, [
        { entries: [pageEntry(900)], overFrame: false },
        { entries: [pageEntry(1280)], overFrame: false },
        { entries: [pageEntry(1280)], overFrame: false },
      ]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 640, target: "page", position: 1280, size: 5400, view: 800 });
      expect(inputCommands()).toHaveLength(1);
    });

    it("at the bottom nothing moved", async () => {
      evalResults.push(["scrollViewInPage", { ok: true, value: { w: 1000, h: 800, stepW: 1000, stepH: 800 } }]);
      const bottom = { entries: [pageEntry(4600)], overFrame: false };
      probe(bottom, [bottom]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 0, target: "page", position: 4600, size: 5400, view: 800, reason: "end" });
    });

    it("an inner container scrolled instead of the window", async () => {
      evalResults.push(["scrollViewInPage", { ok: true, value: { w: 1000, h: 800, stepW: 1000, stepH: 800 } }]);
      const inner = (top: number) => ({ page: false, index: 7, top, left: 0, sh: 2000, sw: 300, ch: 500, cw: 300, oy: true, ox: false });
      probe({ entries: [inner(0), pageEntry(0, 800)], overFrame: false }, [{ entries: [inner(640), pageEntry(0, 800)], overFrame: false }]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 640, target: "container", containerIndex: 7, position: 640, size: 2000, view: 500 });
    });

    it("a page that cannot be measured still scrolls", async () => {
      evalResults.push(["scrollViewInPage", { ok: true, value: { w: 1000, h: 800, stepW: 1000, stepH: 800 } }]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true });
      expect(inputCommands()).toHaveLength(1);
    });
  });

  it("upload sets files on a file input (found by object, so one inside a shadow root too)", async () => {
    evalResults.push(["type === \"file\"", "file"]);
    const respond = chrome.debugger.respond;
    chrome.debugger.respond = (method, params) => {
      const p = params as { expression?: string; returnByValue?: boolean };
      if (method === "Runtime.evaluate" && !p.returnByValue && p.expression?.includes('[data-noa-index=\\"4\\"]')) return { result: { objectId: "file-4" } };
      return respond(method, params);
    };
    expect(await driver.upload({ index: 4, paths: ["C:\\a.png"] })).toEqual({ ok: true });
    const cmd = chrome.debugger.commands.find((c) => c.method === "DOM.setFileInputFiles");
    expect(cmd?.params).toEqual({ files: ["C:\\a.png"], objectId: "file-4" });
    expect(chrome.debugger.commands.some((c) => c.method === "Runtime.releaseObject")).toBe(true);
    chrome.debugger.respond = respond;
    expect(chrome.debugger.commands.some((c) => c.method === "Input.dispatchDragEvent")).toBe(false);

    evalResults.length = 0;
    evalResults.push(["type === \"file\"", "missing"]);
    await expect(driver.upload({ index: 4, paths: ["C:\\a.png"] })).rejects.toThrow("element 4 not found; call read_page again");
  });

  const drags = () =>
    chrome.debugger.commands
      .filter((c) => c.method === "Input.dispatchDragEvent")
      .map((c) => c.params as { type: string; x: number; y: number; data: { files: string[] } });

  it("upload drops the files on another element with a real drag when the page accepts it", async () => {
    evalResults.push(["type === \"file\"", "notfile"], ["scrollIntoView", { x: 110, y: 220 }], ["defaultPrevented", true]);
    expect(await driver.upload({ index: 4, paths: ["C:\\a.png", "C:\\b.zip"] })).toEqual({ ok: true, via: "drop" });
    expect(drags().map((d) => d.type)).toEqual(["dragEnter", "dragOver", "drop"]);
    expect(drags()[2]).toMatchObject({ x: 110, y: 220, data: { files: ["C:\\a.png", "C:\\b.zip"] } });
    expect(chrome.debugger.commands.some((c) => c.method === "DOM.setFileInputFiles")).toBe(false);
  });

  it("upload cancels a drag nothing accepts and pastes the files instead", async () => {
    evalResults.push(["type === \"file\"", "notfile"], ["scrollIntoView", { x: 1, y: 2 }], ["defaultPrevented", false]);
    const plain = chrome.debugger.respond;
    let pasted = true;
    chrome.debugger.respond = (method, params) => {
      if (method === "Runtime.evaluate" && String((params as { expression: string }).expression).includes("createElement")) {
        return { result: { objectId: "input-1" } };
      }
      if (method === "Runtime.callFunctionOn") return { result: { value: pasted } };
      return plain(method, params);
    };
    expect(await driver.upload({ index: 4, paths: ["C:\\a.png"] })).toEqual({ ok: true, via: "paste" });
    expect(drags().map((d) => d.type)).toEqual(["dragEnter", "dragOver", "dragCancel"]);
    const set = chrome.debugger.commands.find((c) => c.method === "DOM.setFileInputFiles");
    expect(set?.params).toEqual({ files: ["C:\\a.png"], objectId: "input-1" });
    expect(chrome.debugger.commands.some((c) => c.method === "Runtime.releaseObject")).toBe(true);

    pasted = false;
    await expect(driver.upload({ index: 4, paths: ["C:\\a.png"] })).rejects.toThrow(/element 4 took neither a drop nor a paste/);
  });

  it("screenshot captures a JPEG", async () => {
    expect(await driver.screenshot()).toEqual({ base64: "SU1H", mimeType: "image/jpeg" });
    const cmd = chrome.debugger.commands.find((c) => c.method === "Page.captureScreenshot");
    expect(cmd?.params).toEqual({ format: "jpeg", quality: 70 });
  });

  it("navigate waits until the new page is usable (not its load event) and returns url and title", async () => {
    // The page before (doc 1), then the new one: loading, then drawn and settled while still loading resources.
    const readings = [
      { doc: 1, state: "complete", controls: 5, text: 100, foreignFrame: false },
      { doc: 1, state: "complete", controls: 5, text: 100, foreignFrame: false },
      { doc: 2, state: "loading", controls: 0, text: 0, foreignFrame: false },
      ...Array(4).fill({ doc: 2, state: "interactive", controls: 50, text: 3000, foreignFrame: false }),
    ];
    let probes = 0;
    chrome.debugger.respond = (method, params) => {
      if (method === "Page.navigate") return { frameId: "f" };
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression: string }).expression;
        if (expr.includes("timeOrigin")) return { result: { value: readings[Math.min(probes++, readings.length - 1)] } };
        return { result: { value: { url: "https://example.com/", title: "Example" } } };
      }
      return {};
    };
    expect(await driver.navigate({ url: "https://example.com/" })).toEqual({ url: "https://example.com/", title: "Example" });
    // One reading of the page it leaves, then the new page until three unchanged readings.
    expect(probes).toBe(7);
  });

  it("navigate rejects unsupported schemes and navigation errors", async () => {
    await expect(driver.navigate({ url: "javascript:alert(1)" })).rejects.toThrow(/http/);
    chrome.debugger.respond = () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" });
    await expect(driver.navigate({ url: "https://nope.invalid/" })).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
  });

  it("readPage evaluates the snapshot function by value", async () => {
    const snap = { url: "u", title: "t", text: "", elements: [], truncated: false };
    evalResults.push(["data-noa-index", snap]);
    expect(await driver.readPage()).toEqual(snap);
    const cmd = chrome.debugger.commands.find((c) => c.method === "Runtime.evaluate");
    expect(cmd?.params).toMatchObject({ expression: snapshotExpression(), returnByValue: true });
  });

  it("readPage waits for a tab still loading (read_page never reasons over an empty page), and says when it gave up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = driverHarness(async (ms) => void vi.setSystemTime(Date.now() + ms));
      const loadingScreen = { url: "https://x.com/jack", title: "", text: "X", elements: [], truncated: false };
      const profile = { ...loadingScreen, title: "Jack (@jack) / X", text: "Jack @jack 2,000 posts", elements: Array(30).fill({ index: 1, role: "link", name: "Posts" }) };
      let loaded = false;
      let reads = 0;
      h.chrome.debugger.respond = (method, params) => {
        if (method !== "Runtime.evaluate") return {};
        const expr = String((params as { expression: string }).expression);
        if (expr.includes("timeOrigin")) {
          // Still loading for 2 s, then usable.
          if (Date.now() - start >= 2000) loaded = true;
          return { result: { value: { doc: 1, state: loaded ? "complete" : "loading", controls: loaded ? 30 : 0, text: 0, foreignFrame: false } } };
        }
        reads++;
        return { result: { value: loaded ? profile : loadingScreen } };
      };
      const start = Date.now();
      expect(await h.driver.readPage()).toEqual(profile);
      expect(reads).toBe(2);
      expect(Date.now() - start).toBeGreaterThanOrEqual(2000);

      // A page that never draws: the read gives up and the note says it is still loading.
      loaded = false;
      h.chrome.debugger.respond = (method, params) => {
        const expr = String((params as { expression: string }).expression ?? "");
        if (method !== "Runtime.evaluate") return {};
        if (expr.includes("timeOrigin")) return { result: { value: { doc: 1, state: "loading", controls: 0, text: 0, foreignFrame: false } } };
        return { result: { value: loadingScreen } };
      };
      const gaveUp = await h.driver.readPage();
      expect(gaveUp).toMatchObject({ text: "X", note: expect.stringMatching(/^Page still loading: after 10(\.\d)? s it still shows next to nothing \(0 elements, 1 characters of text\)/) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces page exceptions", async () => {
    chrome.debugger.respond = () => ({ result: {}, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: x" } } });
    await expect(driver.readPage()).rejects.toThrow("ReferenceError: x");
  });

  it("currentUrl reads the agent tab", async () => {
    const tabId = await agent.ensureTab();
    chrome.tabs.byId.get(tabId)!.url = "https://example.com/x";
    expect(await driver.currentUrl()).toEqual({ url: "https://example.com/x" });
  });
});

describe("snapshotExpression", () => {
  it("is a self-contained expression with the limits baked in", () => {
    const expr = snapshotExpression();
    expect(expr).toMatch(/^\(function/);
    expect(expr).toContain(`(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30, 160, 60, 8, 15, 48)`);
    expect(expr).not.toMatch(/__name|__vite|_interop|import\(/);
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });
});
