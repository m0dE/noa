import { delay, MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_OPTIONS, MAX_SNAPSHOT_TEXT, type PageSnapshot, type Screenshot, type Sleep } from "@noa/shared";
import { isTabLoaded } from "./chrome-tabs.js";
import {
  BACKGROUND_SHOT_SKIPPED,
  clickElement,
  PAGE_MARKS,
  POLL_MS,
  pollUntil,
  SCREENSHOT_JPEG_QUALITY,
  SCROLL_SETTLE_MS,
  scrollDelta,
  SETTLE_MS,
  typeIntoElement,
  type Params as P,
  type Result as R,
} from "./driver-common.js";
import { parseKeyCombo } from "./keys.js";
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
} from "./page-input.js";
import { foreignExtensionInPage, loadProbeInPage, waitForUsablePage, type LoadProbe } from "./page-load.js";
import { snapshotPage } from "./page-snapshot.js";
import { waitInPage, type PageWait, type PageWaitArgs } from "./page-wait.js";
import { xAccountEntryInPage, xHandleParam, type XEntryStep } from "./page-x-account.js";
import { scrollProbeInPage, scrollReport, type PageResult, type ScrollProbe } from "./scroll-probe.js";

/**
 * Shown once per tab when the driver switches to this fallback, in front of
 * the tool result text. extensionId: the other extension whose frame is on
 * the page, when the page shows it (foreignExtensionInPage). Its name would
 * need the "management" permission; chrome://extensions/?id=... shows it.
 */
export function fallbackNote(extensionId: string | null): string {
  const which = extensionId ? `the frame of another extension (id ${extensionId}; chrome://extensions/?id=${extensionId} shows which)` : "another extension's frame";
  return `(Using fallback mode: ${which} on this page blocks Chrome's debugger. Clicks and typing are simulated.)`;
}

/** The note when the other extension is not known. */
export const FALLBACK_NOTE = fallbackNote(null);

const FALLBACK_UPLOAD_ERROR =
  "upload is not possible on this page because another extension's frame blocks Chrome's debugger, " +
  "and an extension cannot attach local files without it. Ask the human to attach the file (task_pause), " +
  "or disable the other extension on this site and try again.";

/**
 * The browser.* methods without chrome.debugger, for tabs where Chrome refuses
 * it: chrome.scripting in the top frame and chrome.tabs.captureVisibleTab.
 * Events are untrusted (isTrusted false), so some sites may ignore them, and
 * files cannot be uploaded.
 */
export class FallbackDriver {
  private readonly sleep: Sleep;

  constructor(opts: { sleep?: Sleep } = {}) {
    this.sleep = opts.sleep ?? delay;
  }

  /** Navigates with chrome.tabs.update, then waits until the new page is usable (see waitForLoad). */
  async navigate(tabId: number, { url }: P<"browser.navigate">, leaving: number | null = null): Promise<R<"browser.navigate"> & { probe: LoadProbe | null }> {
    await chrome.tabs.update(tabId, { url });
    return this.waitForLoad(tabId, url, leaving);
  }

  /**
   * Waits until the tab's new page is usable (page-load.ts: past
   * DOMContentLoaded and no longer changing; not its load event), then returns
   * its url and title, and the last reading. leaving: the document the
   * navigation leaves.
   */
  async waitForLoad(tabId: number, url: string, leaving: number | null = null): Promise<R<"browser.navigate"> & { probe: LoadProbe | null }> {
    const probe = await waitForUsablePage(() => this.probe(tabId), { sleep: this.sleep, leaving });
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? url, title: tab.title ?? "", probe };
  }

  /** How far the tab's page loaded; null while it cannot be read (a navigation not committed yet, or no page script). */
  async probe(tabId: number): Promise<LoadProbe | null> {
    const tab = await chrome.tabs.get(tabId);
    if (tab.pendingUrl) return null;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: loadProbeInPage });
      return (res?.result as LoadProbe | undefined) ?? null;
    } catch {
      // A loaded page no script may enter (e.g. an error page): usable as it is.
      return tab.status === "complete" ? { doc: -1, state: "complete", controls: 0, text: 0, foreignFrame: false } : null;
    }
  }

  /** The id of the other extension whose frame is on the page (see fallbackNote), or null when the page does not show one. */
  async foreignExtension(tabId: number): Promise<string | null> {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: foreignExtensionInPage });
      return typeof res?.result === "string" ? res.result : null;
    } catch {
      return null;
    }
  }

  async readPage(tabId: number): Promise<PageSnapshot> {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [PAGE_MARKS, MAX_SNAPSHOT_TEXT, MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_OPTIONS] });
    const snap = res?.result as PageSnapshot | undefined;
    if (!snap) throw new Error("Page script failed: no page snapshot (the page may be navigating); try again");
    return snap;
  }

  /** One slice of wait_for in the page (page-wait.ts; chrome.scripting waits for its promise); undefined when the page gave no answer. */
  async waitInPage(tabId: number, args: PageWaitArgs): Promise<PageResult<PageWait> | undefined> {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: waitInPage, args: [args] });
    return res?.result as PageResult<PageWait> | undefined;
  }

  async screenshot(tabId: number): Promise<Screenshot> {
    const tab = await chrome.tabs.get(tabId);
    // captureVisibleTab only sees the visible tab; the tab is never brought to the front.
    const minimized = await chrome.windows.get(tab.windowId).then((w) => w.state === "minimized", () => false);
    if (!tab.active || minimized) throw new Error(BACKGROUND_SHOT_SKIPPED);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: SCREENSHOT_JPEG_QUALITY });
    return { base64: dataUrl.replace(/^data:[^,]*,/, ""), mimeType: "image/jpeg" };
  }

  click(tabId: number, p: P<"browser.click">): Promise<R<"browser.click">> {
    const { index } = p;
    return clickElement(p, {
      state: () => this.exec(tabId, checkStateInPage, [PAGE_MARKS, index]),
      click: () => this.exec(tabId, clickInPage, [PAGE_MARKS, index]).then(() => undefined),
      force: (checked) => this.exec(tabId, setCheckedInPage, [PAGE_MARKS, index, checked]),
    });
  }

  type(tabId: number, { index, text }: P<"browser.type">): Promise<R<"browser.type">> {
    return typeIntoElement({
      target: () => this.exec(tabId, typeTargetInPage, [PAGE_MARKS, index]),
      select: () => this.exec(tabId, selectOptionInPage, [PAGE_MARKS, index, text]),
      click: () => this.exec(tabId, clickInPage, [PAGE_MARKS, index]).then(() => undefined),
      prepare: () => this.exec(tabId, prepareTypingInPage, [PAGE_MARKS, index]).then(() => undefined),
      insert: () => this.exec(tabId, insertTextInPage, [PAGE_MARKS, index, text]).then(() => undefined),
    });
  }

  async paste(tabId: number, { text }: P<"browser.paste">): Promise<R<"browser.paste">> {
    await this.exec(tabId, insertTextInPage, [PAGE_MARKS, null, text]);
    return { ok: true };
  }

  async pressKey(tabId: number, { key }: P<"browser.pressKey">): Promise<R<"browser.pressKey">> {
    const s = parseKeyCombo(key);
    const mods = { alt: (s.modifiers & 1) !== 0, ctrl: (s.modifiers & 2) !== 0, meta: (s.modifiers & 4) !== 0, shift: (s.modifiers & 8) !== 0 };
    await this.exec(tabId, pressKeyInPage, [{ key: s.key, code: s.code, keyCode: s.windowsVirtualKeyCode, text: s.text ?? null, ...mods }]);
    return { ok: true };
  }

  /** Scrolls like a wheel at the viewport center (or over element `index`) and reports what moved. */
  async scroll(tabId: number, { direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    const view = await this.exec(tabId, viewportInPage, []);
    const { dx, dy } = scrollDelta(direction, amount, view);
    const r = (await this.exec(tabId, scrollProbeInPage, [PAGE_MARKS, "scroll", view.w / 2, view.h / 2, index ?? null, dx, dy])) as {
      before: ScrollProbe;
      after: ScrollProbe;
    };
    await this.sleep(SCROLL_SETTLE_MS);
    if (!r || !Array.isArray(r.before?.entries) || !Array.isArray(r.after?.entries)) return { ok: true };
    return { ok: true, ...scrollReport(direction, r.before, r.after, index !== undefined) };
  }

  /**
   * browser.clickXAccountEntry (page-x-account.ts): found and clicked in one synchronous step in the page. A real
   * press needs the debugger, which this tab does not have: then nothing is clicked.
   */
  async clickXAccountEntry(tabId: number, p: P<"browser.clickXAccountEntry">): Promise<R<"browser.clickXAccountEntry">> {
    const handle = xHandleParam(p.handle);
    if (p.press) return { clicked: false, reason: "a real mouse press needs Chrome's debugger, which this page blocks" };
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: xAccountEntryInPage, args: [handle, p.waitMs ?? 0, "click", null] });
    const out = res?.result as PageResult<XEntryStep> | undefined;
    if (!out) throw new Error("Page script failed (or the page was navigating); call read_page and try again");
    if (!out.ok) throw new Error(`switch_x_account: ${out.error}`);
    if (!("clicked" in out.value)) throw new Error("clickXAccountEntry: unexpected answer from the page");
    return out.value;
  }

  async upload(): Promise<R<"browser.upload">> {
    throw new Error(FALLBACK_UPLOAD_ERROR);
  }

  /** Runs a self-contained page function in the tab's top frame only (never in other extensions' frames). */
  private async exec<A extends unknown[], T>(tabId: number, func: (...args: A) => PageResult<T>, args: A): Promise<T> {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    const out = res?.result as PageResult<T> | undefined;
    // Chrome returns null when the page function threw or the page navigated away meanwhile.
    if (!out) throw new Error("Page script failed (or the page was navigating); call read_page and try again");
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }
}
