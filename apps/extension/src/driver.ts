import { delay, PAGE_SETTLE_MS, urlMatches, type AgentTabInfo, type PageSnapshot, type Screenshot, type Sleep } from "@noa/shared";
import type { AgentTab } from "./agent-tab.js";
import type { Cdp } from "./cdp.js";
import { CdpActions } from "./cdp-actions.js";
import { isTabLoaded, tabExists, tabUrl } from "./chrome-tabs.js";
import { assertOpenable, BACKGROUND_SHOT_SKIPPED, NAV_TIMEOUT_MS, pollUntil, type Params as P, type Result as R } from "./driver-common.js";
import { fallbackNote, FallbackDriver } from "./fallback-driver.js";
import { keyEvents } from "./keys.js";
import { pageIndicators, type HiddenPart, type PageIndicators } from "./page-indicator.js";
import { leavingDocument, readWhenDrawn, stillLoadingNote, waitForUsablePage, type LoadProbe } from "./page-load.js";
import { WAIT_MIN_GAP_MS, WAIT_POLL_MS, type PageWait, type PageWaitArgs } from "./page-wait.js";
import { isDebuggerBlocked, isDebuggerDetached, isRestrictedError, restrictedToolError } from "./restricted.js";
import type { PageResult } from "./scroll-probe.js";
import { shrinkScreenshot } from "./screenshot-size.js";

/** A result that may carry the fallback note (fallbackNote), once, for the caller to show. */
export type WithNote<T> = T & { note?: string };

/**
 * How long a screenshot of a background tab may take. In Chromium 153 (headed,
 * also without Playwright's anti-backgrounding flags) Page.captureScreenshot
 * of a background tab, a tab never shown, or a tab of a minimized or unfocused
 * window returns the real, current page in ~100 ms; this only guards against a
 * browser that never paints hidden tabs.
 */
const BACKGROUND_SHOT_TIMEOUT_MS = 10_000;

/**
 * How much longer than its slice a wait_for slice may take to answer: the page's own timer may be throttled in a
 * background tab, so the service worker ends the slice itself (the page's watcher is stopped by the next slice).
 */
const WAIT_SLICE_GRACE_MS = 2000;

/**
 * Implements the browser.* methods on the agent's tabs through the debugger.
 * The single-tab methods act on the current tab (see AgentTab); readPage can
 * also read any other tab of the run without activating it, and several tabs
 * can be attached at once. openTabs/switchTab/listTabs/closeTabs manage the
 * run's tabs.
 *
 * Chrome refuses chrome.debugger for a whole tab once it contains a frame of
 * another extension (e.g. Streak inside Gmail): attach and every command fail
 * with "Cannot access a chrome-extension:// URL of different extension", and a
 * live session is detached ("target_closed") when such a frame appears. That
 * tab then switches to FallbackDriver (chrome.scripting + captureVisibleTab,
 * simulated input); other tabs of the run keep using the debugger. The first
 * result in fallback mode for a tab carries the fallback note (fallbackNote, naming the other extension when the page shows it). After a
 * navigation the debugger is tried again.
 */
export class Driver {
  private readonly sleep: Sleep;
  private readonly viaCdp: CdpActions;
  private readonly fallback: FallbackDriver;
  /** Every agent tab of every slot (drivers share the debugger): a driver only detaches tabs no slot uses. */
  private readonly knownTabs: () => Promise<number[]>;
  /** Tabs driven without the debugger. */
  private readonly fallbackTabs = new Set<number>();
  /** Tabs whose fallback note was already handed out (or is pending). */
  private readonly noted = new Set<number>();
  /** Tabs whose next result carries the fallback note. */
  private readonly pendingNotes = new Set<number>();
  /** The current tab as of the last ready(). */
  private lastTab: number | null = null;
  /** The control overlay on the pages (page-indicator.ts): never in the agent's screenshots, never under its clicks. */
  private readonly indicator: Pick<PageIndicators, "hiddenDuring">;

  constructor(
    private readonly cdp: Cdp,
    private readonly agent: AgentTab,
    opts: { sleep?: Sleep; fallback?: FallbackDriver; knownTabs?: () => Promise<number[]>; indicator?: Pick<PageIndicators, "hiddenDuring"> } = {},
  ) {
    this.sleep = opts.sleep ?? delay;
    this.indicator = opts.indicator ?? pageIndicators;
    this.viaCdp = new CdpActions(cdp, this.sleep);
    this.fallback = opts.fallback ?? new FallbackDriver({ sleep: this.sleep });
    this.knownTabs = opts.knownTabs ?? (() => this.agent.tabIds());
  }

  /** True when the current agent tab is driven without the debugger. */
  get inFallback(): boolean {
    return this.lastTab !== null && this.fallbackTabs.has(this.lastTab);
  }

  /**
   * Ensure the current agent tab exists and the debugger is attached to it, or
   * that the tab is in fallback mode because Chrome refuses the debugger there.
   * Detaches from tabs that are no longer part of the run.
   */
  async ready(): Promise<number> {
    const tabId = await this.agent.ensureTab();
    this.lastTab = tabId;
    await this.forgetStrays();
    await this.attachOrFallback(tabId, true);
    return tabId;
  }

  /**
   * Opens `url` in the current tab and waits until the page is usable (past
   * DOMContentLoaded and settled; not the load event of a heavy app). A tab in
   * fallback mode navigates with chrome.tabs.update, never through a debugger
   * attach that the page's other-extension frame would drop; so does a tab
   * whose debugger Chrome drops during the navigation. After it, the debugger
   * is tried again only when the new page has no other extension's frame.
   */
  async navigate({ url }: P<"browser.navigate">): Promise<WithNote<R<"browser.navigate">>> {
    assertOpenable(url);
    let started = false;
    let leaving: number | null = null;
    const from = async (tabId: number, probe: (id: number) => Promise<LoadProbe | null>) => {
      const before = await chrome.tabs.get(tabId).then(tabUrl, () => undefined);
      leaving = leavingDocument(before, url, (await probe(tabId).catch(() => null))?.doc);
    };
    return this.use(
      async (tabId) => {
        await from(tabId, (id) => this.viaCdp.probe(id));
        return this.viaCdp.navigate(tabId, url, () => (started = true), leaving);
      },
      async (tabId) => {
        if (leaving === null) await from(tabId, (id) => this.fallback.probe(id));
        // Page.navigate may have gone through before Chrome refused or dropped the debugger: then only wait.
        const heading = started || (await chrome.tabs.get(tabId).then((t) => t.pendingUrl === url, () => false));
        const { probe, ...r } = heading ? await this.fallback.waitForLoad(tabId, url, leaving) : await this.fallback.navigate(tabId, { url }, leaving);
        // A page without the other extension's frame gets the debugger again (trusted input) from the next call.
        if (!probe?.foreignFrame) this.fallbackTabs.delete(tabId);
        return r;
      },
      undefined,
      { droppedGoesFallback: true },
    );
  }

  /**
   * Snapshot of the current tab, or of `tab` (a short id) without activating it or making it current. A tab that
   * shows next to nothing yet (still loading, or a web app drawing its first screen) is waited for, a few seconds
   * at most (readWhenDrawn); if it still shows nothing, the note says the page is still loading.
   */
  async readPage(p: P<"browser.readPage"> = {}): Promise<WithNote<PageSnapshot>> {
    const target = p.tab === undefined ? undefined : await this.agent.resolve(p.tab);
    const drawn = async (tabId: number, read: () => Promise<PageSnapshot>, probe: () => Promise<LoadProbe | null>): Promise<WithNote<PageSnapshot>> => {
      const tab = () => chrome.tabs.get(tabId).then((t) => ({ heading: t.pendingUrl || t.url, loading: t.status === "loading" }));
      const { snap, stillLoading } = await readWhenDrawn(read, probe, { sleep: this.sleep, tab });
      return stillLoading === undefined ? snap : { ...snap, note: stillLoadingNote(snap, stillLoading) };
    };
    const r = await this.use(
      (tabId) => drawn(tabId, () => this.viaCdp.readPage(tabId), () => this.viaCdp.probe(tabId)),
      (tabId) => drawn(tabId, () => this.fallback.readPage(tabId), () => this.fallback.probe(tabId)),
      target,
      { droppedGoesFallback: true },
    );
    // Several tabs may be read in one tool call: say which tab the note is about.
    if (r?.note && target !== undefined) r.note = `Tab ${(await this.agent.shortId(target)) ?? p.tab}: ${r.note}`;
    return r;
  }

  /**
   * Screenshot of the current tab. The tab is never brought to the front (the
   * user may be using another tab): a background tab is captured through the
   * debugger as it is; when that is not possible the call fails with
   * BACKGROUND_SHOT_SKIPPED. At most SCREENSHOT_MAX_WIDTH pixels wide.
   */
  async screenshot(): Promise<WithNote<Screenshot>> {
    const shot = await this.use(
      (tabId) => this.withoutIndicator(tabId, "all", () => this.cdpScreenshot(tabId)),
      (tabId) => this.withoutIndicator(tabId, "all", () => this.fallback.screenshot(tabId)),
      undefined,
      { droppedGoesFallback: true },
    );
    const small = await shrinkScreenshot(shot).catch(() => shot);
    return small === shot ? shot : { ...small, ...(shot.note ? { note: shot.note } : {}) };
  }

  click(p: P<"browser.click">): Promise<WithNote<R<"browser.click">>> {
    return this.use(
      (tabId) => this.withoutIndicator(tabId, "pill", () => this.viaCdp.click(tabId, p)),
      (tabId) => this.withoutIndicator(tabId, "pill", () => this.fallback.click(tabId, p)),
    );
  }

  type(p: P<"browser.type">): Promise<WithNote<R<"browser.type">>> {
    return this.use(
      (tabId) => this.withoutIndicator(tabId, "pill", () => this.viaCdp.type(tabId, p)),
      (tabId) => this.withoutIndicator(tabId, "pill", () => this.fallback.type(tabId, p)),
    );
  }

  paste(p: P<"browser.paste">): Promise<WithNote<R<"browser.paste">>> {
    return this.use(
      (tabId) => this.viaCdp.paste(tabId, p),
      (tabId) => this.fallback.paste(tabId, p),
    );
  }

  pressKey(p: P<"browser.pressKey">): Promise<WithNote<R<"browser.pressKey">>> {
    let events: ReturnType<typeof keyEvents>;
    try {
      events = keyEvents(p.key);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.use(
      (tabId) => this.viaCdp.pressKey(tabId, events),
      (tabId) => this.fallback.pressKey(tabId, p),
    );
  }

  scroll(p: P<"browser.scroll">): Promise<WithNote<R<"browser.scroll">>> {
    return this.use(
      (tabId) => this.withoutIndicator(tabId, "pill", () => this.viaCdp.scroll(tabId, p)),
      (tabId) => this.withoutIndicator(tabId, "pill", () => this.fallback.scroll(tabId, p)),
    );
  }

  upload(p: P<"browser.upload">): Promise<WithNote<R<"browser.upload">>> {
    return this.use(
      (tabId) => this.viaCdp.upload(tabId, p),
      () => this.fallback.upload(),
    );
  }

  /**
   * switch_x_account's pick in X's account menu (page-x-account.ts). Not run again on the fallback when the
   * debugger drops mid-call: a click may have happened already.
   */
  clickXAccountEntry(p: P<"browser.clickXAccountEntry">): Promise<WithNote<R<"browser.clickXAccountEntry">>> {
    // Only a real press goes through a point on the screen, where the control pill must not be.
    const around = <T>(tabId: number, call: () => Promise<T>) => (p.press ? this.withoutIndicator(tabId, "pill", call) : call());
    return this.use(
      (tabId) => around(tabId, () => this.viaCdp.clickXAccountEntry(tabId, p)),
      (tabId) => this.fallback.clickXAccountEntry(tabId, p),
    );
  }

  async currentUrl(): Promise<R<"browser.currentUrl">> {
    const tabId = await this.agent.ensureTab();
    const tab = await chrome.tabs.get(tabId);
    return { url: tabUrl(tab) };
  }

  /**
   * Opens the URLs in new tabs (loading in parallel) and waits for all of
   * them, NAV_TIMEOUT_MS at most each; a tab still loading then is returned
   * with `error`. Reading them later does not need them to be active.
   */
  async openTabs({ urls, background }: P<"browser.openTabs">): Promise<R<"browser.openTabs">> {
    urls.forEach(assertOpenable);
    const created = await this.agent.open(urls, { current: background === false });
    const current = await this.agent.tabId();
    const tabs = await Promise.all(
      created.map(async (t, i): Promise<AgentTabInfo> => {
        const loaded = await this.waitForTab(t.tabId);
        const info: AgentTabInfo = { id: t.id, url: loaded.url || urls[i]!, title: loaded.title, current: t.tabId === current };
        if (loaded.error) info.error = loaded.error;
        return info;
      }),
    );
    return { tabs };
  }

  /**
   * One slice of wait_for on the current tab, or on `tab` without making it current: which condition holds
   * (url_matches from the tab's URL, the others in the page: page-wait.ts), or none after timeoutMs. A page
   * that cannot be read right now (it is navigating) answers at once with none; a closed tab answers closed.
   */
  async waitFor(p: P<"browser.waitFor">): Promise<WithNote<R<"browser.waitFor">>> {
    const target = p.tab === undefined ? undefined : await this.agent.resolve(p.tab);
    return this.use(
      (tabId) => this.watch(tabId, p, (args) => this.viaCdp.waitInPage(tabId, args)),
      (tabId) => this.watch(tabId, p, (args) => this.fallback.waitInPage(tabId, args)),
      target,
      { droppedGoesFallback: true },
    );
  }

  private async watch(tabId: number, p: P<"browser.waitFor">, inPage: (a: PageWaitArgs) => Promise<PageResult<PageWait> | undefined>): Promise<R<"browser.waitFor">> {
    const tab = () => chrome.tabs.get(tabId).then((t) => ({ url: tabUrl(t), title: t.title ?? "" }), () => null);
    const byUrl = (url: string) => p.until.findIndex((c) => c.kind === "url_matches" && urlMatches(c.text ?? "", url));
    const before = await tab();
    if (!before) return { met: null, closed: true, url: "", title: "" };
    const early = byUrl(before.url);
    if (early >= 0) return { met: early, ...before };
    const args: PageWaitArgs = { until: p.until, timeoutMs: p.timeoutMs, baseline: p.baseline ?? null, settleMs: PAGE_SETTLE_MS, minGapMs: WAIT_MIN_GAP_MS, pollMs: WAIT_POLL_MS };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slice = inPage(args);
    const page = await Promise.race([slice, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), p.timeoutMs + WAIT_SLICE_GRACE_MS)))])
      .catch(async (err: unknown) => {
        // A page that is navigating gives no answer; the debugger refused or dropped on a tab that is still there switches to the fallback.
        if ((isDebuggerBlocked(err) || isDebuggerDetached(err)) && (await tabExists(tabId))) throw err;
        return undefined;
      })
      .finally(() => clearTimeout(timer));
    slice.catch(() => undefined);
    if (page && !page.ok) throw new Error(page.error);
    const after = await tab();
    if (!after) return { met: null, closed: true, url: before.url, title: before.title };
    const fingerprint = page?.value.fingerprint;
    const met = byUrl(after.url);
    return { met: met >= 0 ? met : (page?.value.met ?? null), ...after, ...(fingerprint ? { fingerprint } : {}) };
  }

  /** Makes a tab current and attaches to it. The browser's active tab does not change. */
  async switchTab({ tab }: P<"browser.switchTab">): Promise<R<"browser.switchTab">> {
    const tabId = await this.agent.setCurrent(tab);
    try {
      await this.ready();
    } catch (err) {
      if (!isRestrictedError(err)) throw err;
      throw new Error(restrictedToolError(await chrome.tabs.get(tabId).then((t) => t.url, () => undefined)));
    }
    const info = (await this.listTabs()).tabs.find((t) => t.current);
    if (!info) throw new Error(`tab ${tab} was closed`);
    return info;
  }

  async listTabs(): Promise<R<"browser.listTabs">> {
    const tabs = await this.agent.list();
    const infos = await Promise.all(
      tabs.map(async (t): Promise<AgentTabInfo | null> => {
        const tab = await chrome.tabs.get(t.tabId).catch(() => null);
        return tab ? { id: t.id, url: tabUrl(tab), title: tab.title ?? "", current: t.current } : null;
      }),
    );
    return { tabs: infos.filter((t): t is AgentTabInfo => t !== null) };
  }

  /** Closes tabs the agent opened (never the run's first tab). */
  async closeTabs({ tabs }: P<"browser.closeTabs">): Promise<R<"browser.closeTabs">> {
    const closed = await this.agent.close(tabs);
    await this.forgetStrays();
    return { closed, tabs: (await this.listTabs()).tabs };
  }

  /** Closes every tab the agent opened in this run (called when a run ends). Returns how many. */
  async closeOpenedTabs(): Promise<number> {
    const n = await this.agent.closeOpened();
    if (n) await this.forgetStrays();
    return n;
  }

  /**
   * Runs `viaCdp`, or `viaFallback` when the tab refuses the debugger
   * (switching on the first such error). Acts on the current tab, or on
   * `target` without making it current. droppedGoesFallback: Chrome dropping
   * the debugger mid-command switches too (only for calls that are safe to
   * run again: a click might have happened already). Tabs a page opened
   * meanwhile are reported in the result's note (withNewTabs).
   */
  private async use<T extends object>(
    viaCdp: (tabId: number) => Promise<T>,
    viaFallback: (tabId: number) => Promise<T>,
    target?: number,
    opts: { droppedGoesFallback?: boolean } = {},
  ): Promise<WithNote<T>> {
    let tabId: number | undefined = target;
    try {
      if (tabId === undefined) {
        tabId = await this.ready();
      } else {
        await this.attachOrFallback(tabId, false);
      }
      if (!this.fallbackTabs.has(tabId)) {
        try {
          return await this.withNewTabs(await viaCdp(tabId));
        } catch (err) {
          const dropped = opts.droppedGoesFallback === true && isDebuggerDetached(err) && (await tabExists(tabId));
          if (!isDebuggerBlocked(err) && !dropped) throw err;
          this.enterFallback(tabId);
        }
      }
      const result: WithNote<T> = await viaFallback(tabId);
      if (!this.pendingNotes.delete(tabId)) return await this.withNewTabs(result);
      // Before a note the result already carries (e.g. the page is still loading); on a copy, never the page's own object.
      const note = [fallbackNote(await this.fallback.foreignExtension(tabId)), result.note].filter(Boolean).join("\n");
      return await this.withNewTabs({ ...result, note });
    } catch (err) {
      // A page Chrome keeps extensions out of (Web Store, chrome://): one plain sentence, not Chrome's raw error.
      if (!isRestrictedError(err)) throw err;
      const id = tabId ?? (await this.agent.tabId());
      const url = id === null ? undefined : await chrome.tabs.get(id).then(tabUrl, () => undefined);
      throw new Error(restrictedToolError(url));
    }
  }

  /**
   * Tells the agent about tabs a page of the run opened (a click that opens a
   * new tab), in the result's note: otherwise it keeps looking at the old tab
   * for what happened.
   */
  private async withNewTabs<T extends object>(result: WithNote<T>): Promise<WithNote<T>> {
    const fresh = await this.agent.takeNewTabs().catch(() => []);
    if (!fresh.length) return result;
    const lines = fresh.map(
      (t) =>
        `A new tab opened from the page: ${t.id} ${JSON.stringify(t.title)} ${t.url}. Your current tab is still the one you were in: use switch_tab ${t.id} to work in the new one (read_page, act and screenshot work there).`,
    );
    return { ...result, note: [result.note, ...lines].filter(Boolean).join("\n") };
  }

  /** Attaches the debugger to the tab (current: and makes it cdp's current tab), or marks the tab for fallback. */
  private async attachOrFallback(tabId: number, current: boolean): Promise<void> {
    if (this.fallbackTabs.has(tabId)) return;
    try {
      if (current) await this.cdp.attach(tabId);
      else await this.cdp.ensure(tabId);
    } catch (err) {
      if (!isDebuggerBlocked(err)) throw err;
      this.enterFallback(tabId);
    }
  }

  private enterFallback(tabId: number): void {
    this.fallbackTabs.add(tabId);
    // Chrome already dropped (or never gave) the session; forget it.
    void this.cdp.detach(tabId).catch(() => {});
    if (!this.noted.has(tabId)) {
      this.noted.add(tabId);
      this.pendingNotes.add(tabId);
    }
  }

  /** Detaches from tabs that are no longer part of the run (an earlier run's, or closed ones). */
  private async forgetStrays(): Promise<void> {
    const attached = this.cdp.attachedTabs;
    if (!attached.length && !this.fallbackTabs.size) return;
    const known = new Set(await this.knownTabs());
    for (const t of attached) if (!known.has(t)) await this.cdp.detach(t);
    for (const t of [...this.fallbackTabs]) if (!known.has(t)) this.fallbackTabs.delete(t);
  }

  /**
   * Runs a call with the control overlay hidden in the tab: all of it for a screenshot (the agent sees the page as
   * it is), its pill for input at a point (a click there must reach the page, never the pill's Stop).
   */
  private withoutIndicator<T>(tabId: number, part: HiddenPart, call: () => Promise<T>): Promise<T> {
    return this.indicator.hiddenDuring(tabId, part, call);
  }

  /** A debugger screenshot; of a background tab with a time limit, since Chrome may not paint it. */
  private async cdpScreenshot(tabId: number): Promise<Screenshot> {
    const visible = await chrome.tabs.get(tabId).then((t) => t.active, () => true);
    const shot = this.viaCdp.screenshot(tabId);
    if (visible) return shot;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(BACKGROUND_SHOT_SKIPPED)), BACKGROUND_SHOT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([shot, timeout]);
    } finally {
      clearTimeout(timer);
      shot.catch(() => undefined);
    }
  }

  /** Waits until a new tab finished loading; `error` when it did not within NAV_TIMEOUT_MS. */
  private async waitForTab(tabId: number): Promise<{ url: string; title: string; error?: string }> {
    // Usable, like navigate (page-load.ts), read with chrome.scripting: no debugger attach per tab, and not the load event.
    const usable = await waitForUsablePage(
      async () => {
        if (!(await tabExists(tabId))) throw new Error("closed");
        return this.fallback.probe(tabId);
      },
      { sleep: this.sleep },
    ).catch(() => null);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { url: "", title: "", error: "the tab was closed while loading" };
    const r: { url: string; title: string; error?: string } = { url: tabUrl(tab), title: tab.title ?? "" };
    if (!usable) r.error = `still loading after ${NAV_TIMEOUT_MS / 1000} s`;
    return r;
  }
}
