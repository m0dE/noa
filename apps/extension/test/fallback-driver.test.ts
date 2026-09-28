import { beforeEach, describe, expect, it } from "vitest";
import { FOREIGN_FRAME_ERROR, type ChromeFake } from "./chrome-fake.js";
import { DRAWN, driverHarness, runInUserTab } from "./driver-harness.js";
import type { AgentTab } from "../src/agent-tab.js";
import { Cdp } from "../src/cdp.js";
import { Driver } from "../src/driver.js";
import { BACKGROUND_SHOT_SKIPPED, PAGE_MARKS, SCREENSHOT_JPEG_QUALITY } from "../src/driver-common.js";
import { FALLBACK_NOTE, fallbackNote } from "../src/fallback-driver.js";
import {
  checkStateInPage,
  clickInPage,
  insertTextInPage,
  prepareTypingInPage,
  pressKeyInPage,
  selectOptionInPage,
  setCheckedInPage,
  typeTargetInPage,
  viewportInPage,
} from "../src/page-input.js";
import { isDebuggerBlocked } from "../src/restricted.js";
import { scrollProbeInPage } from "../src/scroll-probe.js";
import { snapshotPage } from "../src/page-snapshot.js";
import { foreignExtensionInPage, loadProbeInPage } from "../src/page-load.js";

let chrome: ChromeFake;
let cdp: Cdp;
let agent: AgentTab;
let driver: Driver;
let tabId: number;
let windowId: number;
/** The page's readings (loadProbeInPage): the first is the page before a navigation; each tabs.update loads a new document. */
let probes: number;
let foreignFrame: boolean;

const snap = { url: "https://mail.test/", title: "Inbox", text: "hi", elements: DRAWN, truncated: false };

beforeEach(async () => {
  const h = driverHarness();
  ({ chrome, cdp, agent, driver } = h);
  ({ windowId, tabId } = await runInUserTab(h, "https://mail.test/"));
  chrome.debugger.respond = (method) => {
    if (method === "Runtime.evaluate") return { result: { value: snap } };
    if (method === "Page.captureScreenshot") return { data: "Q0RQ" };
    return {};
  };
  probes = 0;
  foreignFrame = false;
  chrome.scripting.respond = (func) =>
    func === loadProbeInPage
      ? { doc: probes++ === 0 ? 1 : 2 + chrome.tabs.updateCalls.filter((c) => c.props.url).length, state: "complete", controls: 3, text: 10, foreignFrame }
      : func === snapshotPage
      ? snap
      : func === viewportInPage
        ? { ok: true, value: { w: 1000, h: 800 } }
        : func === scrollProbeInPage
          ? { ok: true, value: { before: probeAt(0), after: probeAt(1280) } }
          : { ok: true, value: true };
});

const probeAt = (top: number) => ({
  entries: [{ page: true, index: null, top, left: 0, sh: 5400, sw: 1000, ch: 800, cw: 1000, oy: true, ox: true }],
  overFrame: false,
});

const injected = () => chrome.scripting.calls.map((c) => c.func);

describe("isDebuggerBlocked", () => {
  it("matches Chrome's cross-extension errors only", () => {
    expect(isDebuggerBlocked(new Error("Cannot access a chrome-extension:// URL of different extension"))).toBe(true);
    expect(isDebuggerBlocked("Cannot access a chrome-extension:// URL of different extension")).toBe(true);
    expect(isDebuggerBlocked(new Error("debugger_access_denied"))).toBe(true);
    expect(isDebuggerBlocked(new Error("Another debugger is already attached to the tab with id: 5."))).toBe(false);
    expect(isDebuggerBlocked(new Error("debugger detached by user"))).toBe(false);
    expect(isDebuggerBlocked(new Error("No tab with id: 5."))).toBe(false);
  });
});

describe("Driver on a page where Chrome refuses the debugger", () => {
  it("normal pages stay on the debugger and never inject scripts", async () => {
    expect(await driver.readPage()).toEqual(snap);
    expect(await driver.screenshot()).toEqual({ base64: "Q0RQ", mimeType: "image/jpeg" });
    expect(chrome.scripting.calls).toEqual([]);
    expect(chrome.tabs.captureCalls).toEqual([]);
    expect(driver.inFallback).toBe(false);
  });

  it("the note names the extension whose frame is on the page (its id, and where Chrome shows its name)", async () => {
    const id = "gppongmhjkpfnbhagpmjfkannfbllamg";
    const respond = chrome.scripting.respond;
    chrome.scripting.respond = (func, args) => (func === foreignExtensionInPage ? id : respond(func, args));
    chrome.debugger.blocked.add(tabId);
    expect((await driver.readPage()).note).toBe(fallbackNote(id));
    expect(fallbackNote(id)).toBe(
      `(Using fallback mode: the frame of another extension (id ${id}; chrome://extensions/?id=${id} shows which) on this page blocks Chrome's debugger. Clicks and typing are simulated.)`,
    );
    expect(FALLBACK_NOTE).toBe(fallbackNote(null));
  });

  it("switches to the fallback when attach is refused, with the note on the first result only", async () => {
    chrome.debugger.blocked.add(tabId);
    const first = await driver.readPage();
    expect(first).toEqual({ ...snap, note: FALLBACK_NOTE });
    expect(driver.inFallback).toBe(true);
    expect(chrome.scripting.calls[0]).toMatchObject({ tabId, func: snapshotPage, args: [PAGE_MARKS, 8000, 300, 30] });
    // Top frame only: no allFrames / other extensions' frames.
    expect(chrome.scripting.calls[0]!.frameIds).toBeUndefined();

    expect(await driver.screenshot()).toEqual({ base64: "RkFLRQ==", mimeType: "image/jpeg" });
    expect(chrome.tabs.captureCalls).toEqual([{ windowId, opts: { format: "jpeg", quality: SCREENSHOT_JPEG_QUALITY } }]);
    expect(await driver.click({ index: 3 })).toEqual({ ok: true });
    expect(await driver.type({ index: 4, text: "Ada" })).toEqual({ ok: true });
    expect(await driver.paste({ text: "!" })).toEqual({ ok: true });
    expect(await driver.pressKey({ key: "Control+Enter" })).toEqual({ ok: true });
    expect(await driver.scroll({ direction: "down", amount: 2, index: 1 })).toEqual({ ok: true, moved: 1280, target: "page", position: 1280, size: 5400, view: 800 });

    expect(injected()).toEqual([
      snapshotPage,
      // Once, for the note: which extension's frame is on the page.
      foreignExtensionInPage,
      checkStateInPage,
      clickInPage,
      typeTargetInPage,
      clickInPage,
      prepareTypingInPage,
      insertTextInPage,
      insertTextInPage,
      pressKeyInPage,
      viewportInPage,
      scrollProbeInPage,
    ]);
    const args = chrome.scripting.calls.map((c) => c.args);
    expect(args.slice(2)).toEqual([
      [PAGE_MARKS, 3],
      [PAGE_MARKS, 3],
      [PAGE_MARKS, 4],
      [PAGE_MARKS, 4],
      [PAGE_MARKS, 4],
      [PAGE_MARKS, 4, "Ada"],
      [PAGE_MARKS, null, "!"],
      [{ key: "Enter", code: "Enter", keyCode: 13, text: "\r", alt: false, ctrl: true, meta: false, shift: false }],
      [],
      [PAGE_MARKS, "scroll", 500, 400, 1, 0, 1280],
    ]);
    expect(chrome.debugger.commands).toEqual([]);
  });

  it("switches mid-run when a frame appears after the debugger was attached", async () => {
    await driver.readPage();
    expect(chrome.debugger.commands.map((c) => c.method)).toContain("Runtime.evaluate");
    // Chrome detaches the session when the other extension's frame is added, and refuses to reattach.
    chrome.debugger.attached.delete(tabId);
    chrome.debugger.blocked.add(tabId);
    cdp.handleDetach({ tabId }, "target_closed");
    expect(await driver.click({ index: 2 })).toEqual({ ok: true, note: FALLBACK_NOTE });
    expect(injected()).toEqual([checkStateInPage, clickInPage, foreignExtensionInPage]);
  });

  it("switches when a command fails even though the session is still attached", async () => {
    await driver.ready();
    chrome.debugger.blocked.add(tabId);
    expect(await driver.readPage()).toEqual({ ...snap, note: FALLBACK_NOTE });
  });

  it("surfaces page-function errors and does not switch on other errors", async () => {
    chrome.debugger.blocked.add(tabId);
    chrome.scripting.respond = () => ({ ok: false, error: "element 9 not found; call read_page again" });
    await expect(driver.click({ index: 9 })).rejects.toThrow("element 9 not found; call read_page again");

    const other = new Driver(new Cdp(), agent, { sleep: async () => {} });
    chrome.debugger.blocked.clear();
    chrome.debugger.respond = () => {
      throw new Error("Some other CDP failure");
    };
    await expect(other.readPage()).rejects.toThrow("Some other CDP failure");
    expect(other.inFallback).toBe(false);
  });

  it("upload fails with a clear reason in fallback mode", async () => {
    chrome.debugger.blocked.add(tabId);
    await expect(driver.upload({ index: 1, paths: ["C:\\a.png"] })).rejects.toThrow(/upload is not possible on this page because another extension/);
    // The note was not consumed by the failure.
    expect((await driver.readPage()).note).toBe(FALLBACK_NOTE);
  });

  it("screenshot of a background agent tab is skipped, never brought to the front", async () => {
    chrome.debugger.blocked.add(tabId);
    const user = await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    chrome.tabs.updateCalls.length = 0;
    await expect(driver.screenshot()).rejects.toThrow(BACKGROUND_SHOT_SKIPPED);
    expect(chrome.tabs.updateCalls.filter((c) => c.props.active)).toEqual([]);
    expect(chrome.windows.updateCalls.filter((c) => c.props.focused)).toEqual([]);
    expect((await chrome.tabs.get(user.id)).active).toBe(true);
    expect(chrome.tabs.captureCalls).toEqual([]);
    // The visible tab is captured with captureVisibleTab.
    await chrome.tabs.update(tabId, { active: true });
    expect(await driver.screenshot()).toMatchObject({ base64: "RkFLRQ==", mimeType: "image/jpeg" });
    expect(chrome.tabs.captureCalls).toEqual([{ windowId, opts: { format: "jpeg", quality: SCREENSHOT_JPEG_QUALITY } }]);
  });

  it("navigates with tabs.update, then tries the debugger again on the new page", async () => {
    chrome.debugger.blocked.add(tabId);
    chrome.tabs.byId.get(tabId)!.title = "Other";
    const nav = await driver.navigate({ url: "https://other.test/" });
    expect(nav).toEqual({ url: "https://other.test/", title: "Other", note: FALLBACK_NOTE });
    expect(chrome.tabs.updateCalls.at(-1)).toEqual({ id: tabId, props: { url: "https://other.test/" } });

    // The new page has no foreign frame: back on the debugger, no second note.
    chrome.debugger.blocked.delete(tabId);
    expect(await driver.readPage()).toEqual(snap);
    expect(driver.inFallback).toBe(false);
    expect(chrome.debugger.commands.map((c) => c.method)).toContain("Runtime.evaluate");

    // Blocked again later: fallback without repeating the note.
    chrome.debugger.blocked.add(tabId);
    chrome.debugger.attached.delete(tabId);
    cdp.handleDetach({ tabId }, "target_closed");
    expect(await driver.readPage()).toEqual(snap);
  });

  it("keeps fallback mode after a navigation to a page that has the other extension's frame again (no debugger attach to be dropped)", async () => {
    chrome.debugger.blocked.add(tabId);
    foreignFrame = true;
    await driver.navigate({ url: "https://mail.test/u/2/" });
    const attachesBefore = chrome.debugger.attachCalls;
    // The next calls stay in fallback without trying the debugger.
    chrome.debugger.blocked.delete(tabId);
    expect(await driver.readPage()).toEqual(snap);
    expect(driver.inFallback).toBe(true);
    expect(chrome.debugger.attachCalls).toBe(attachesBefore);
    // Navigating from a fallback tab never goes through the debugger.
    await driver.navigate({ url: "https://mail.test/u/0/" });
    expect(chrome.debugger.commands.filter((c) => c.method === "Page.navigate")).toEqual([]);
    expect(chrome.tabs.updateCalls.at(-1)).toEqual({ id: tabId, props: { url: "https://mail.test/u/0/" } });
  });

  it("Chrome dropping the debugger during a navigation ('Detached while handling command') goes on in fallback mode", async () => {
    chrome.debugger.respond = (method) => {
      if (method === "Page.navigate") {
        chrome.debugger.blocked.add(tabId);
        throw new Error("Detached while handling command.");
      }
      return {};
    };
    chrome.tabs.byId.get(tabId)!.title = "Inbox";
    expect(await driver.navigate({ url: "https://mail.test/u/2/" })).toEqual({ url: "https://mail.test/u/2/", title: "Inbox", note: FALLBACK_NOTE });
    expect(chrome.tabs.updateCalls.at(-1)).toEqual({ id: tabId, props: { url: "https://mail.test/u/2/" } });
  });

  it("navigate only waits when Page.navigate went through before the tab got blocked", async () => {
    chrome.debugger.respond = (method) => {
      if (method === "Page.navigate") {
        chrome.debugger.blocked.add(tabId);
        return { frameId: "f" };
      }
      return {};
    };
    await driver.navigate({ url: "https://mail.test/inbox" });
    expect(chrome.tabs.updateCalls.filter((c) => c.props.url)).toEqual([]);
  });

  it("each blocked tab gets its own note", async () => {
    chrome.debugger.blocked.add(tabId);
    expect((await driver.readPage()).note).toBe(FALLBACK_NOTE);
    const next = await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    await agent.prepare("current-tab");
    chrome.debugger.blocked.add(next.id);
    expect((await driver.readPage()).note).toBe(FALLBACK_NOTE);
    expect(chrome.scripting.calls.at(-1)!.tabId).toBe(next.id);
    expect(FOREIGN_FRAME_ERROR).toMatch(/different extension/);
  });
});

describe("page functions", () => {
  it("are self-contained so chrome.scripting can serialize them", () => {
    for (const fn of [
      clickInPage,
      typeTargetInPage,
      prepareTypingInPage,
      selectOptionInPage,
      checkStateInPage,
      setCheckedInPage,
      insertTextInPage,
      pressKeyInPage,
      viewportInPage,
      scrollProbeInPage,
      snapshotPage,
    ]) {
      const src = fn.toString();
      expect(src).not.toMatch(/__name|__vite|_interop|import\(|\bexports\b|require\(/);
      expect(() => new Function(`return (${src})`)).not.toThrow();
    }
  });
});
