/**
 * The browser.* actions through the debugger (Chrome DevTools Protocol) on
 * one tab. Driver decides which tab, and when a tab needs FallbackDriver
 * instead (errors that isDebuggerBlocked() recognizes pass through).
 */
import { INPUT_BLOCKED_TEXT, SETTLE_REQUESTS_MAX_MS, type Settle, type Settled, type Sleep, type PageSnapshot, type Screenshot } from "@noa/shared";
import {
  clickElement,
  indexedElement,
  notFound,
  PAGE_MARKS,
  PAGE_SCRIPT_FAILED,
  POLL_MS,
  SCREENSHOT_JPEG_QUALITY,
  SCROLL_SETTLE_MS,
  scrollDelta,
  typeIntoElement,
  type ClickPoint,
  type InputProbe,
  type PageDriver,
  type PageFunction,
  type Params as P,
  type Result as R,
} from "./driver-common.js";
import { keyEvents } from "./keys.js";
import { armInputProbe } from "./page-cover.js";
import { scrollViewInPage, searchFieldInPage } from "./page-input.js";
import { enteredFieldsInPage } from "./page-entered.js";
import { loadProbeInPage, waitForUsablePage, type LoadProbe } from "./page-load.js";
import { FIND_LIMITS, findTextInPage } from "./page-find.js";
import { snapshotExpression } from "./page-snapshot.js";
import { waitInPage, type PageWait, type PageWaitArgs } from "./page-wait.js";
import { FOUND_KEY, xAccountEntryInPage, xHandleParam, type XEntryMode, type XEntryStep } from "./page-x-account.js";
import { DialogOpenError, type Cdp } from "./cdp.js";
import { isDebuggerBlocked } from "./restricted.js";
import { sameProbe, scrollProbeExpression, scrollReport, type PageResult, type ScrollProbe } from "./scroll-probe.js";

/** Where dropFiles keeps the page's dragover and drop events while it drags. */
const DRAG_PROBE_KEY = "noa.dragProbe";
/** Input.dispatchDragEvent's dragOperationsMask for "copy". */
const DRAG_COPY = 1;

/**
 * The page side of mouseClick's check. "arm" listens (capture, on the window) for the click's pointer and mouse
 * events under `nonce`, and answers false where no answer would be sure: the point is over a frame, whose document
 * gets the events instead. "read" answers whether any arrived, or "gone" when the page is a new document.
 */
export function inputProbeExpression(mode: "arm" | "read", nonce: string, x: number, y: number): string {
  const key = JSON.stringify(INPUT_PROBE_KEY);
  if (mode === "read") return `(() => { const p = window[${key}]; return !p || p.nonce !== ${JSON.stringify(nonce)} ? "gone" : p.seen ? "seen" : "none"; })()`;
  return `(${armInputProbe.toString()})(${key}, ${JSON.stringify(nonce)}, ${x}, ${y})`;
}
const INPUT_PROBE_KEY = "noa.inputProbe";
/** A click's own input check name. */
const newNonce = () => `${Date.now()}-${Math.random()}`;

/** How often a settling input checks whether the page's requests are done. */
const REQUESTS_POLL_MS = 50;
/**
 * After typing into a search field (searchFieldInPage), how long a request may take to start: a search box often
 * searches only once the typing has stopped for a moment (a debounce, commonly 200-800 ms).
 */
const SEARCH_REQUEST_START_MS = 1200;
/** After the requests an input waited for are done: time for the page to show what they brought. */
const REQUESTS_RENDER_MS = 150;

/**
 * The wait after an input (CdpActions.settled): settleMs; then, while no request started, up to startWithinMs after
 * the input; then while requests are loading, up to SETTLE_REQUESTS_MAX_MS after it, and REQUESTS_RENDER_MS more
 * when it waited for any. Time is counted in the sleeps.
 */
export async function settleAfterInput(watch: { open(): number; started(): number } | null, sleep: Sleep, settleMs: number, startWithinMs = 0): Promise<void> {
  await sleep(settleMs);
  let waited = settleMs;
  // A field that searches a moment after the typing stops: its request may not have started yet.
  for (; watch && !watch.started() && waited < startWithinMs; waited += REQUESTS_POLL_MS) await sleep(REQUESTS_POLL_MS);
  if (!watch?.open()) return;
  for (; watch.open() && waited < SETTLE_REQUESTS_MAX_MS; waited += REQUESTS_POLL_MS) await sleep(REQUESTS_POLL_MS);
  await sleep(REQUESTS_RENDER_MS);
}

/** Extra readings after a wheel while the position still changes (smooth scrolling). */
const SCROLL_SETTLE_POLLS = 6;

interface EvaluateResult<T> {
  result?: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export class CdpActions {
  constructor(
    private readonly cdp: Cdp,
    private readonly sleep: Sleep,
  ) {}

  /**
   * Page.navigate, then waits until the new page is usable (page-load.ts), not
   * for its load event. onStarted: the navigation went through. leaving: the
   * document it leaves (see leavingDocument).
   */
  async navigate(tabId: number, url: string, onStarted: () => void, leaving: number | null = null): Promise<R<"browser.navigate">> {
    const nav = await this.send<{ errorText?: string }>(tabId, "Page.navigate", { url });
    if (nav.errorText) throw new Error(`Navigation to ${url} failed: ${nav.errorText}`);
    onStarted();
    await waitForUsablePage(() => this.probe(tabId), { sleep: this.sleep, leaving });
    return this.evaluate<{ url: string; title: string }>(tabId, "({ url: location.href, title: document.title })");
  }

  /** How far the tab's page loaded; null while it cannot be read (navigating). A dialog that froze it is an error. */
  probe(tabId: number): Promise<LoadProbe | null> {
    return this.evaluate<LoadProbe>(tabId, `(${loadProbeInPage.toString()})()`).then(
      (p) => p ?? null,
      (err: unknown) => {
        if (isDebuggerBlocked(err) || err instanceof DialogOpenError) throw err;
        return null;
      },
    );
  }

  /** Form fields holding what was entered (page-entered.ts); 0 when the page gives no answer. */
  enteredFields(tabId: number): Promise<number> {
    return this.evaluate<number>(tabId, `(${enteredFieldsInPage.toString()})()`).then(
      (n) => (typeof n === "number" ? n : 0),
      () => 0,
    );
  }

  readPage(tabId: number): Promise<PageSnapshot> {
    return this.evaluate<PageSnapshot>(tabId, snapshotExpression());
  }

  /** One slice of wait_for in the page (page-wait.ts); undefined when the page gave no answer. */
  waitInPage(tabId: number, args: PageWaitArgs): Promise<PageResult<PageWait> | undefined> {
    return this.evaluate<PageResult<PageWait> | undefined>(tabId, `(${waitInPage.toString()})(${JSON.stringify(args)})`);
  }

  /** find_text in the page (page-find.ts). */
  async findText(tabId: number, { text, place, scroll, again }: P<"browser.findText">): Promise<R<"browser.findText">> {
    const out = await this.pageResult(tabId, findTextInPage, [text, place ?? 1, scroll === true, FIND_LIMITS, again === true]);
    if (!out) throw new Error(PAGE_SCRIPT_FAILED);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }

  async screenshot(tabId: number): Promise<Screenshot> {
    const shot = await this.send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "jpeg", quality: SCREENSHOT_JPEG_QUALITY });
    return { base64: shot.data, mimeType: "image/jpeg" };
  }

  click(tabId: number, p: P<"browser.click">): Promise<R<"browser.click">> {
    return this.settled(tabId, p, () => clickElement(p, this.page(tabId)));
  }

  /**
   * The input, then the page's time to react (Settle): settleMs, and longer while requests the page started since
   * the input began are loading (a search's results), up to SETTLE_REQUESTS_MAX_MS; then REQUESTS_RENDER_MS for the
   * page to show what they brought. startWithin: from the input's result, how long after the input a request may still
   * start when none did within settleMs (a search field's debounce). Without settleMs, only the input.
   */
  private async settled<T extends object>(tabId: number, { settleMs }: Settle, input: () => Promise<T>, startWithin: (out: T) => number = () => 0): Promise<T & Settled> {
    if (settleMs === undefined) return input();
    const watch = await this.cdp.watchRequests(tabId).catch(() => null);
    try {
      const out = await input();
      await settleAfterInput(watch, this.sleep, settleMs, startWithin(out));
      return { ...out, settled: true };
    } finally {
      await watch?.stop();
    }
  }

  /**
   * A trusted mouse click at `at` (a point of the element coverInPage found free, where it left the element) or else
   * at the element's center, scrolled into view first. Throws INPUT_BLOCKED_TEXT when the page got none of it:
   * something outside the page holds the tab's input (a dialog of Chrome's own, which the agent cannot see), and
   * every click and key would otherwise "succeed" with nothing happening.
   */
  private async mouseClick(tabId: number, index: number, at?: ClickPoint, probe?: { probe: InputProbe; armed: boolean }): Promise<void> {
    const { x, y } = at ?? (await this.centerOf(tabId, index));
    // Armed by coverInPage at `at` already, or armed here.
    const nonce = probe && at ? probe.probe.nonce : newNonce();
    const armed = probe && at ? probe.armed : await this.evaluate<boolean>(tabId, inputProbeExpression("arm", nonce, x, y)).catch(() => false);
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    if (!armed) return;
    // "gone": the click navigated (a new document), so it arrived.
    const seen = await this.evaluate<"seen" | "none" | "gone">(tabId, inputProbeExpression("read", nonce, x, y)).catch(() => "gone" as const);
    if (seen === "none") throw new Error(INPUT_BLOCKED_TEXT);
  }

  async type(tabId: number, p: P<"browser.type">): Promise<R<"browser.type">> {
    // Text typed into a search field: its search may start only once the typing has stopped for a moment.
    const field = p.settleMs !== undefined && p.text !== "" ? await this.pageResult(tabId, searchFieldInPage, [p.index]).catch(() => undefined) : undefined;
    // Not when the typing already chose a suggestion or listed some: the page has answered it.
    const searches = field?.ok === true && field.value;
    return this.settled(tabId, p, () => typeIntoElement(p, this.page(tabId)), (r) => (searches && r.selected === undefined && !r.suggestions?.length ? SEARCH_REQUEST_START_MS : 0));
  }

  /** What clickElement and typeIntoElement need, through the debugger. */
  private page(tabId: number): PageDriver {
    return {
      run: (fn, args) => this.pageResult(tabId, fn, args),
      clickAt: (index, at, armed) => this.mouseClick(tabId, index, at, armed),
      inputProbe: () => ({ key: INPUT_PROBE_KEY, nonce: newNonce() }),
      // Trusted text input at the focus, like typing.
      insertText: async (_index, text) => {
        await this.send(tabId, "Input.insertText", { text });
      },
      backspace: async () => {
        await this.pressKey(tabId, keyEvents("Backspace"));
      },
      sleep: this.sleep,
    };
  }

  async paste(tabId: number, { text }: P<"browser.paste">): Promise<R<"browser.paste">> {
    await this.send(tabId, "Input.insertText", { text });
    return { ok: true };
  }

  pressKey(tabId: number, [down, up]: ReturnType<typeof keyEvents>, settle: Settle = {}): Promise<R<"browser.pressKey">> {
    return this.settled(tabId, settle, async () => {
      await this.send(tabId, "Input.dispatchKeyEvent", down);
      await this.send(tabId, "Input.dispatchKeyEvent", up);
      return { ok: true as const };
    });
  }

  async scroll(tabId: number, { direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    // The box a step is measured against (scrollViewInPage); the window when the page gives no answer.
    const viewed = await this.pageResult(tabId, scrollViewInPage, [index ?? null]);
    const view = viewed?.ok
      ? viewed.value
      : await this.evaluate<{ w: number; h: number; stepW: number; stepH: number }>(tabId, "({ w: innerWidth, h: innerHeight, stepW: innerWidth, stepH: innerHeight })");
    const at = index === undefined ? { x: view.w / 2, y: view.h / 2 } : await this.centerOf(tabId, index);
    const { dx: deltaX, dy: deltaY } = scrollDelta(direction, amount, { w: view.stepW, h: view.stepH });
    // What could move under the wheel, measured before and after (never fails the scroll itself).
    const probe = (mode: "measure" | "read") =>
      this.evaluate<PageResult<ScrollProbe>>(tabId, scrollProbeExpression(mode, at.x, at.y, index ?? null)).then(
        (r) => (r && r.ok && Array.isArray(r.value?.entries) ? r.value : null),
        (err: unknown) => {
          if (isDebuggerBlocked(err)) throw err;
          return null;
        },
      );
    const before = await probe("measure");
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY });
    await this.sleep(SCROLL_SETTLE_MS);
    if (!before) return { ok: true };
    // Smooth scrolling may still be animating: read until two readings agree.
    let after = await probe("read");
    for (let i = 0; after && i < SCROLL_SETTLE_POLLS; i++) {
      await this.sleep(POLL_MS / 2);
      const again = await probe("read");
      if (!again || sameProbe(after, again)) break;
      after = again;
    }
    if (!after) return { ok: true };
    return { ok: true, ...scrollReport(direction, before, after, index !== undefined) };
  }

  /**
   * Files onto element `index`, the way a person would give them: set on an <input type=file>; otherwise dropped
   * on it with a real drag (a drop zone, or an editor that takes dropped images); otherwise pasted into it (an
   * editor that only takes pasted images). A drag the element does not accept is cancelled before the drop, so an
   * element that takes no files never gets them (and the tab never opens the file).
   */
  async upload(tabId: number, { index, paths }: P<"browser.upload">): Promise<R<"browser.upload">> {
    const kind = await this.evaluate<string>(
      tabId,
      `(() => { const el = ${indexedElement(index)}; if (!el) return "missing";
        return el instanceof HTMLInputElement && el.type === "file" ? "file" : "notfile"; })()`,
    );
    if (kind === "missing") throw notFound(index);
    if (kind === "file") {
      // By object, not DOM.querySelector: that cannot reach an input inside a shadow root.
      const found = await this.send<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", { expression: indexedElement(index) });
      const objectId = found.result?.objectId;
      if (!objectId) throw notFound(index);
      try {
        await this.send(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
      } finally {
        await this.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
      return { ok: true };
    }
    if (await this.dropFiles(tabId, index, paths)) return { ok: true, via: "drop" };
    if (await this.pasteFiles(tabId, index, paths)) return { ok: true, via: "paste" };
    throw new Error(
      `element ${index} took neither a drop nor a paste of the files: upload to an <input type=file>, a drop zone or an editor that accepts files`,
    );
  }

  /** A trusted drag of the files onto the element's center; false (drag cancelled) when nothing there accepts it. */
  private async dropFiles(tabId: number, index: number, paths: string[]): Promise<boolean> {
    const { x, y } = await this.centerOf(tabId, index);
    // The page's own dragover and drop events, kept to read whether a handler accepted them (preventDefault).
    await this.evaluate(
      tabId,
      `(() => { const k = Symbol.for(${JSON.stringify(DRAG_PROBE_KEY)}); const seen = (window[k] = {});
        for (const t of ["dragover", "drop"]) window.addEventListener(t, (e) => { seen[t] = e; }, { capture: true, once: true }); })()`,
    );
    const accepted = (type: "dragover" | "drop") =>
      this.evaluate<boolean>(tabId, `!!window[Symbol.for(${JSON.stringify(DRAG_PROBE_KEY)})]?.${type}?.defaultPrevented`);
    const drag = (type: string) =>
      this.send(tabId, "Input.dispatchDragEvent", { type, x, y, data: { items: [], files: paths, dragOperationsMask: DRAG_COPY } });
    try {
      await drag("dragEnter");
      await drag("dragOver");
      if (!(await accepted("dragover"))) {
        await drag("dragCancel");
        return false;
      }
      await drag("drop");
      return true;
    } finally {
      await this.evaluate(tabId, `delete window[Symbol.for(${JSON.stringify(DRAG_PROBE_KEY)})]`).catch(() => undefined);
    }
  }

  /**
   * The files pasted into the element: set on an input the page never sees (not in the document), then given to
   * the element as a paste event's clipboard data. True when the page took them (preventDefault).
   */
  private async pasteFiles(tabId: number, index: number, paths: string[]): Promise<boolean> {
    const made = await this.send<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", {
      expression: `(() => { const i = document.createElement("input"); i.type = "file"; i.multiple = true; return i; })()`,
    });
    const objectId = made.result.objectId;
    if (!objectId) return false;
    try {
      await this.send(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
      const res = await this.send<EvaluateResult<boolean>>(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          const el = ${indexedElement(index)}; if (!el) return false;
          const data = new DataTransfer(); for (const f of this.files) data.items.add(f);
          if (typeof el.focus === "function") el.focus();
          const e = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
          el.dispatchEvent(e); return e.defaultPrevented; }`,
        returnByValue: true,
      });
      if (res.exceptionDetails) return false;
      return res.result?.value === true;
    } finally {
      await this.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  /**
   * browser.clickXAccountEntry (page-x-account.ts): the entry clicked in the page, in the same synchronous step
   * that finds it; with `press`, a real mouse press on that same node instead (pressXAccountEntry).
   */
  async clickXAccountEntry(tabId: number, p: P<"browser.clickXAccountEntry">): Promise<R<"browser.clickXAccountEntry">> {
    const handle = xHandleParam(p.handle);
    const step = await this.xEntryStep(tabId, handle, p.waitMs ?? 0, p.press ? "find" : "click");
    if ("clicked" in step) return step;
    if (!("found" in step)) throw new Error("clickXAccountEntry: unexpected answer from the page");
    const found = await this.send<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", {
      expression: `(() => { const k = Symbol.for(${JSON.stringify(FOUND_KEY)}); const el = window[k]; delete window[k]; return el; })()`,
    });
    const objectId = found.result.objectId;
    if (!objectId) return { clicked: false, reason: "not found: X replaced the entry before the press" };
    const { node } = await this.send<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", { objectId });
    await this.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    return this.pressXAccountEntry(tabId, handle, node.backendNodeId);
  }

  /**
   * A trusted press on the account entry known by its node identity (backendNodeId), never by position or an
   * element number: resolved again right before the press, so a node X replaced answers "not found" instead of
   * a press on whatever sits there now. The page's guard ("arm") stops every mouse event aimed elsewhere during
   * the press, so even a replacement in the last moment reaches nothing.
   */
  private async pressXAccountEntry(tabId: number, handle: string, backendNodeId: number): Promise<R<"browser.clickXAccountEntry">> {
    const gone = { clicked: false as const, reason: `not found: X replaced the ${handle} entry before the press` };
    const resolved = await this.send<{ object: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId }).catch(() => null);
    const objectId = resolved?.object.objectId;
    if (!objectId) return gone;
    try {
      const at = await this.xEntryStep(tabId, handle, 0, "arm", objectId);
      if ("clicked" in at) return at;
      if (!("x" in at)) throw new Error("clickXAccountEntry: unexpected answer from the page");
      const press = async () => {
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
        await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
      };
      const disarm = () => this.xEntryStep(tabId, handle, 0, "disarm").catch(() => null);
      const pressed = await press().then(disarm, async (err: unknown) => {
        await disarm();
        throw err;
      });
      // No answer, or no guard in the page: the document it was armed in is gone, which only the entry's click can
      // have started (the guard stops every event aimed elsewhere). The switcher, read next, says whether it switched.
      if (!pressed || !("armed" in pressed) || !pressed.armed) return { clicked: true };
      return pressed.hit ? { clicked: true } : gone;
    } finally {
      await this.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  /** One mode of xAccountEntryInPage; "arm" runs on the node `objectId` names. */
  private async xEntryStep(tabId: number, handle: string, waitMs: number, mode: XEntryMode, objectId?: string): Promise<XEntryStep> {
    const args = [handle, waitMs, mode].map((a) => JSON.stringify(a)).join(", ");
    const res = objectId
      ? await this.send<EvaluateResult<PageResult<XEntryStep>>>(tabId, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function () { return (${xAccountEntryInPage.toString()})(${args}, this); }`,
          returnByValue: true,
          awaitPromise: true,
        })
      : await this.send<EvaluateResult<PageResult<XEntryStep>>>(tabId, "Runtime.evaluate", {
          expression: `(${xAccountEntryInPage.toString()})(${args})`,
          returnByValue: true,
          awaitPromise: true,
        });
    if (res.exceptionDetails) throw new Error(`Page script failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "unknown error"}`);
    const out = res.result?.value;
    if (!out) throw new Error("Page script failed (or the page was navigating); call read_page and try again");
    if (!out.ok) throw new Error(`switch_x_account: ${out.error}`);
    return out.value;
  }

  private send<T = Record<string, unknown>>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.cdp.sendTo<T>(tabId, method, params);
  }

  private async centerOf(tabId: number, index: number): Promise<{ x: number; y: number }> {
    const pos = await this.evaluate<{ x: number; y: number } | null>(
      tabId,
      `(() => { const el = ${indexedElement(index)}; if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!pos) throw notFound(index);
    return pos;
  }

  /** A page function's result as it is; undefined when the page gave none. */
  private pageResult<T>(tabId: number, fn: PageFunction<T>, args: unknown[]): Promise<PageResult<T> | undefined> {
    return this.evaluate<PageResult<T> | undefined>(tabId, `(${fn.toString()})(${[PAGE_MARKS, ...args].map((a) => JSON.stringify(a)).join(", ")})`);
  }

  private async evaluate<T>(tabId: number, expression: string): Promise<T> {
    const res = await this.send<EvaluateResult<T>>(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`Page script failed: ${d.exception?.description ?? d.text ?? "unknown error"}`);
    }
    return res.result?.value as T;
  }
}
