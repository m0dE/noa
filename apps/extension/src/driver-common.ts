/** What Driver, its debugger actions and FallbackDriver share. */
import type { BrowserMethods, ScrollDirection, Sleep } from "@noa/shared";

/** Params and result of a browser.* method. */
export type Params<M extends keyof BrowserMethods> = BrowserMethods[M]["params"];
export type Result<M extends keyof BrowserMethods> = BrowserMethods[M]["result"];

/** How long a navigation or a new tab may take to load. */
export const NAV_TIMEOUT_MS = 30_000;
/** How often a loading tab is checked. */
export const POLL_MS = 200;
/** Extra wait after a load, for late scripts to render. */
export const SETTLE_MS = 500;
/** Wait after a scroll, for lazy content. */
export const SCROLL_SETTLE_MS = 300;
/** JPEG quality of screenshots. */
export const SCREENSHOT_JPEG_QUALITY = 70;
/** One scroll `amount` moves this share of the viewport (a little overlap keeps context). */
const SCROLL_VIEWPORT_SHARE = 0.8;

/** The screenshot tool's answer when a background tab cannot be captured (it is never brought to the front). */
export const BACKGROUND_SHOT_SKIPPED =
  "Screenshot skipped: the tab is in the background (the user is using another tab). Use read_page to see the page.";

/** http(s) pages and about:blank: what navigate and open_tabs accept. */
const OPENABLE_URL = /^(https?:\/\/|about:blank$)/i;

/** Throws unless navigate and open_tabs may open the URL. */
export function assertOpenable(url: string): void {
  if (!OPENABLE_URL.test(url)) throw new Error(`Only http(s) URLs can be opened, got "${url}"`);
}

/**
 * What page functions need from here: they run in the page, serialized with
 * Function.prototype.toString, so they cannot import it and get it as an
 * argument instead. attr: read_page's element numbers; shadow: the window
 * property listing the numbered elements inside shadow roots, which
 * document.querySelector cannot reach; notFound: the error for a number the
 * page no longer has ("#" is the number).
 */
export interface PageMarks {
  attr: string;
  shadow: string;
  notFound: string;
}

export const PAGE_MARKS: PageMarks = {
  attr: "data-noa-index",
  shadow: "__noaShadowMarks",
  notFound: "element # not found; call read_page again",
};

export function notFound(index: number): Error {
  return new Error(PAGE_MARKS.notFound.replace("#", String(index)));
}

/** Selector for the element with this number from the last read_page. */
export function indexSelector(index: number): string {
  return `[${PAGE_MARKS.attr}="${Math.trunc(index)}"]`;
}

/** A page expression for the element with this number from the last read_page, inside a shadow root too; null when gone. */
export function indexedElement(index: number): string {
  const n = JSON.stringify(String(Math.trunc(index)));
  return `(document.querySelector(${JSON.stringify(indexSelector(index))}) || (window[${JSON.stringify(PAGE_MARKS.shadow)}] || []).find((m) => m.isConnected && m.getAttribute(${JSON.stringify(PAGE_MARKS.attr)}) === ${n}) || null)`;
}

/** The wheel of a scroll: `amount` times a viewport share in its direction. */
export function scrollDelta(direction: ScrollDirection, amount: number, view: { w: number; h: number }): { dx: number; dy: number } {
  const dy = Math.round(amount * SCROLL_VIEWPORT_SHARE * view.h);
  const dx = Math.round(amount * SCROLL_VIEWPORT_SHARE * view.w);
  return {
    dx: direction === "right" ? dx : direction === "left" ? -dx : 0,
    dy: direction === "down" ? dy : direction === "up" ? -dy : 0,
  };
}

/** Checks every POLL_MS until done() says so or timeoutMs passed. Resolves whether it was done. */
export async function pollUntil(done: () => Promise<boolean>, sleep: Sleep, timeoutMs = NAV_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** An element's check state, as checkStateInPage reads it. */
export interface CheckState {
  checkable: boolean;
  checked: boolean;
  radio: boolean;
}

/** The page operations behind browser.click on one element, by the debugger or the fallback. */
export interface ClickOps {
  /** Its check state; null when the page gave no answer (it may be navigating). */
  state(): Promise<CheckState | null>;
  click(): Promise<void>;
  /** Sets the check state without a real click (setCheckedInPage); returns the state afterwards. */
  force(checked: boolean): Promise<boolean>;
}

/**
 * browser.click for both drivers: a click, or with `checked` a checkbox,
 * radio button or switch set to that state (clicked only when it is not so
 * already, so a second call never unchecks it). For those, the result says
 * the state afterwards, so the agent sees what its click did.
 */
export async function clickElement({ index, checked }: Params<"browser.click">, ops: ClickOps): Promise<Result<"browser.click">> {
  const before = await ops.state();
  if (checked !== undefined) {
    if (!before?.checkable) throw new Error(`element ${index} is not a checkbox, radio button or switch; leave out checked to click it`);
    if (before.checked === checked) return { ok: true, checked };
    if (!checked && before.radio) throw new Error(`element ${index} is a radio button: it is unchecked by checking another option of its group`);
  }
  await ops.click();
  if (!before?.checkable) return { ok: true };
  let now = (await ops.state().catch(() => null))?.checked;
  if (now === undefined) return { ok: true };
  if (checked !== undefined && now !== checked) now = await ops.force(checked);
  if (checked !== undefined && now !== checked) throw new Error(`element ${index} is still ${now ? "checked" : "unchecked"} after clicking it`);
  return { ok: true, checked: now };
}

/** What typing into an element means (typeTargetInPage). */
export type TypeTarget = "field" | "editor" | "select" | "other";

/** The page operations behind browser.type on one element, by the debugger or the fallback. */
export interface TypeOps {
  target(): Promise<TypeTarget>;
  /** Chooses the <select>'s option the text names; returns its label. */
  select(): Promise<string>;
  click(): Promise<void>;
  /** Selects (or empties) the field, or puts the caret at the end of an editor (prepareTypingInPage). */
  prepare(): Promise<void>;
  insert(): Promise<void>;
}

/**
 * browser.type for both drivers. A dropdown gets its option chosen, never
 * clicked (a click opens its native popup) or typed into. Anything else is
 * clicked for the focus, prepared so the text replaces a field's value, and
 * the text is inserted only into what the click focused.
 */
export async function typeIntoElement(ops: TypeOps): Promise<Result<"browser.type">> {
  if ((await ops.target()) === "select") return { ok: true, selected: await ops.select() };
  await ops.click();
  await ops.prepare();
  await ops.insert();
  return { ok: true };
}
