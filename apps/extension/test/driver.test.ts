import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeFake } from "./chrome-fake.js";
import { driverHarness, userWindow as openWindow } from "./driver-harness.js";
import { AgentTab } from "../src/agent-tab.js";
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
    expect((await agent.list()).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(chrome.tabGroups.byId.get(chrome.tabs.byId.get(popup.id!)!.groupId)!.title).toBe("Noa");
    expect((await chrome.tabs.get(popup.id!)).active).toBe(false);
    expect(await agent.takeNewTabs()).toEqual([{ id: "t2", url: "https://x.test/grok", title: "Grok Imagine" }]);
    expect(await agent.takeNewTabs()).toEqual([]);
    // The run's result may be in it: it is not closed with the run's open_tabs tabs.
    await agent.closeOpened();
    expect(await chrome.tabs.get(popup.id!)).toBeDefined();
    expect(await agent.isAgentTab(popup.id!)).toBe(false);
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
    evalResults.push(["scrollIntoView", { x: 110, y: 220 }]);
    await driver.click({ index: 3 });
    expect(inputCommands().map((c) => c.params)).toEqual([
      { type: "mouseMoved", x: 110, y: 220, button: "none" },
      { type: "mousePressed", x: 110, y: 220, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x: 110, y: 220, button: "left", buttons: 0, clickCount: 1 },
    ]);
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
    evalResults.push(["typeTargetInPage", { ok: true, value: "field" }], ["prepareTypingInPage", { ok: true, value: true }], ["scrollIntoView", { x: 1, y: 2 }]);
    expect(await driver.type({ index: 2, text: "hello" })).toEqual({ ok: true });
    const methods = inputCommands().map((c) => c.method);
    expect(methods).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.insertText"]);
    expect(inputCommands().at(-1)!.params).toEqual({ text: "hello" });
    expect(pageCalls()).toEqual(["typeTargetInPage", "expression", "prepareTypingInPage"]);
  });

  it("type into a dropdown chooses the option in the page: no click (it would open the native popup), no text input", async () => {
    evalResults.push(["typeTargetInPage", { ok: true, value: "select" }], ["selectOptionInPage", { ok: true, value: "United Kingdom" }]);
    expect(await driver.type({ index: 8, text: "united kingdom" })).toEqual({ ok: true, selected: "United Kingdom" });
    expect(inputCommands()).toEqual([]);
    expect(pageCalls()).toEqual(["typeTargetInPage", "selectOptionInPage"]);
  });

  it("type into what takes no text (a checkbox, a button) fails before anything is clicked or typed", async () => {
    evalResults.push(["typeTargetInPage", { ok: false, error: "element 14 is a checkbox or radio button, which takes no text: set it with checked (true or false) instead" }]);
    await expect(driver.type({ index: 14, text: "yes" })).rejects.toThrow(/set it with checked/);
    expect(inputCommands()).toEqual([]);
  });

  it("type stops when the click focused no text field: the text never goes to the field focused before", async () => {
    evalResults.push(
      ["typeTargetInPage", { ok: true, value: "other" }],
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
      if (expr.includes("checkStateInPage")) return { result: { value: { ok: true, value: { checkable: true, checked, radio: false } } } };
      return { result: { value: { x: 5, y: 6 } } };
    };
    expect(await driver.click({ index: 14, checked: true })).toEqual({ ok: true, checked: true });
    // A second call does not toggle it back.
    expect(await driver.click({ index: 14, checked: true })).toEqual({ ok: true, checked: true });
    expect(inputCommands().filter((c) => (c.params as { type: string }).type === "mouseReleased")).toHaveLength(1);
    // A plain click toggles, and says so.
    expect(await driver.click({ index: 14 })).toEqual({ ok: true, checked: false });
  });

  it("click with checked on what is not a checkbox fails without clicking", async () => {
    evalResults.push(["checkStateInPage", { ok: true, value: { checkable: false, checked: false, radio: false } }]);
    await expect(driver.click({ index: 4, checked: true })).rejects.toThrow(/not a checkbox, radio button or switch/);
    expect(inputCommands()).toEqual([]);
  });

  it("click with checked sets the state in the page when the click did not (something covers the box)", async () => {
    evalResults.push(
      ["checkStateInPage", { ok: true, value: { checkable: true, checked: false, radio: false } }],
      ["setCheckedInPage", { ok: true, value: true }],
      ["scrollIntoView", { x: 1, y: 2 }],
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
    evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
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
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      probe({ entries: [pageEntry(640)], overFrame: false }, [
        { entries: [pageEntry(900)], overFrame: false },
        { entries: [pageEntry(1280)], overFrame: false },
        { entries: [pageEntry(1280)], overFrame: false },
      ]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 640, target: "page", position: 1280, size: 5400, view: 800 });
      expect(inputCommands()).toHaveLength(1);
    });

    it("at the bottom nothing moved", async () => {
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      const bottom = { entries: [pageEntry(4600)], overFrame: false };
      probe(bottom, [bottom]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 0, target: "page", position: 4600, size: 5400, view: 800, reason: "end" });
    });

    it("an inner container scrolled instead of the window", async () => {
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      const inner = (top: number) => ({ page: false, index: 7, top, left: 0, sh: 2000, sw: 300, ch: 500, cw: 300, oy: true, ox: false });
      probe({ entries: [inner(0), pageEntry(0, 800)], overFrame: false }, [{ entries: [inner(640), pageEntry(0, 800)], overFrame: false }]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 640, target: "container", containerIndex: 7, position: 640, size: 2000, view: 500 });
    });

    it("a page that cannot be measured still scrolls", async () => {
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true });
      expect(inputCommands()).toHaveLength(1);
    });
  });

  it("upload sets files on a file input", async () => {
    evalResults.push(["type === \"file\"", "file"]);
    expect(await driver.upload({ index: 4, paths: ["C:\\a.png"] })).toEqual({ ok: true });
    const cmd = chrome.debugger.commands.find((c) => c.method === "DOM.setFileInputFiles");
    expect(cmd?.params).toEqual({ files: ["C:\\a.png"], nodeId: 42 });
    const q = chrome.debugger.commands.find((c) => c.method === "DOM.querySelector");
    expect(q?.params).toEqual({ nodeId: 1, selector: '[data-noa-index="4"]' });
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
    expect(expr).toContain(`(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30)`);
    expect(expr).not.toMatch(/__name|__vite|_interop|import\(/);
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });
});
