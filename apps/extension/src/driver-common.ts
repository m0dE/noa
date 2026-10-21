/** What Driver, its debugger actions and FallbackDriver share. */
import { coveredText, overlaidText, type BrowserMethods, type ScrollDirection, type Sleep } from "@noa/shared";
import { prepareTypingInPage, selectOptionInPage, setCheckedInPage, typedTextInPage } from "./page-input.js";
import { checkStateInPage, coverInPage } from "./page-cover.js";
import { listOptionInPage, optionChosenInPage, suggestionsInPage } from "./page-listbox.js";
import type { PageResult } from "./scroll-probe.js";

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

/** The screenshot tool's answer when a background tab cannot be captured and nothing brings it to the front (Driver's front). */
export const BACKGROUND_SHOT_SKIPPED =
  "Screenshot skipped: the tab is in the background (the user is using another tab). Use read_page to see the page.";

const NOT_SWITCHED =
  "Screenshot skipped: the tab is in the background (the user is using another tab), and Noa does not switch to it on its own (Auto tab switching is off in Noa's settings, or the user was active in that window)";

/**
 * The screenshot tool's answer when a background tab stays there (agent-slots.ts): Auto tab switching is off, or the
 * user is active in the tab's window, and the user did not let Noa switch to it; or the run was stopped.
 */
export const SHOT_NOT_SWITCHED = {
  /** The user pressed Not now (on this request or an earlier one of this turn). */
  declined: `${NOT_SWITCHED}; the user chose not to switch to it. Use read_page to see the page; screenshots of background tabs are skipped for the rest of this task.`,
  /** Nobody answered the request in time. */
  timeout: `${NOT_SWITCHED}; the user didn't answer the request to switch to it. Use read_page to see the page; screenshots of background tabs are skipped for the rest of this task.`,
  /** A run nobody watches (a scheduled run): the user is not asked. */
  unattended: `${NOT_SWITCHED}, and nobody is watching this run to switch to it. Use read_page to see the page.`,
  /** No conversation to ask in (e.g. mcp-server --attach). */
  noChat: `${NOT_SWITCHED}. Use read_page to see the page.`,
  /** The user wrote to the agent before answering. */
  interrupted: "Screenshot skipped: the user sent you a message before answering the request to switch to the tab. Read their message first and do what it says.",
  /** The run was stopped (or its turn ended) first: its tab is never brought forward. */
  stopped: "Screenshot skipped: the task was stopped.",
} as const;

/** Where a tab shows for captureVisibleTab: its window, and whether it is hidden there (not the active tab, or the window minimized). */
export interface CaptureView {
  windowId: number;
  hidden: boolean;
}

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
 * page no longer has ("#" is the number); overlay: the tag of Noa's own
 * control overlay (page-indicator.ts), never taken for part of the page;
 * found: the window property where find_text keeps its last search's places
 * for the call after the page read (page-find.ts).
 */
export interface PageMarks {
  attr: string;
  shadow: string;
  notFound: string;
  overlay: string;
  found: string;
}

export const PAGE_MARKS: PageMarks = {
  attr: "data-noa-index",
  shadow: "__noaShadowMarks",
  notFound: "element # not found; call read_page again",
  overlay: "noa-control",
  found: "__noaFound",
};

/** A page function's error when the page gave no answer (it threw, or the page navigated meanwhile). */
export const PAGE_SCRIPT_FAILED = "Page script failed (or the page was navigating); call read_page and try again";

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

/** An element's check state, as checkStateInPage reads it. */
export interface CheckState {
  checkable: boolean;
  checked: boolean;
  radio: boolean;
}

/** A point in the window (CSS pixels) where a click reaches the element. */
export interface ClickPoint {
  x: number;
  y: number;
}

/** What else covers an element at every point a click could use (coverInPage): see overlaidText. */
export interface Overlay {
  over: string;
  lands: string;
  list: boolean;
}

/**
 * What lies over an element where a click would land (coverInPage): a point of it that a click reaches (its center
 * unless something else lies over that); a string, the name of an open modal dialog over it ("" without one); or what
 * else covers it everywhere. null: no verdict (the page gave no answer; it may be navigating), a click goes to its
 * center.
 */
export type Cover = null | string | ClickPoint | Overlay;

/** What coverInPage checks before a click (with checked: "check" or "uncheck") or typing. */
export type AimFor = "click" | "check" | "uncheck" | "type";

/** The input check of a trusted click (CdpActions.mouseClick): where it waits in the page, and this click's nonce. */
export interface InputProbe {
  key: string;
  nonce: string;
}

/** What a click or typing on an element meets (coverInPage). */
export interface Aim {
  /** What lies over it; absent when no click follows (see coverInPage), or when the page gave no answer. */
  cover?: Cover;
  /** Its check state (a click). */
  state?: CheckState;
  /** What typing into it means (typing), unless a modal dialog covers it. */
  target?: TypeTarget;
  /** With an InputProbe: whether the click's input check was armed at the free point (armInputProbe). */
  armed?: boolean;
  /** Scrolling it into view moved it (coverInPage). */
  moved?: boolean;
}

/** Whether a page's answer is a Cover. */
export function isCover(v: unknown): v is Cover {
  if (v === null || typeof v === "string") return true;
  if (typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (typeof o.x === "number" && typeof o.y === "number") || (typeof o.over === "string" && typeof o.lands === "string" && typeof o.list === "boolean");
}

/** Whether a page's answer is an Aim. */
export function isAim(v: unknown): v is Aim {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.cover === undefined || isCover(o.cover);
}

/** A page function (page-input.ts): PAGE_MARKS, then its own arguments. */
export type PageFunction<T> = (marks: PageMarks, ...args: never[]) => PageResult<T>;

/**
 * What a driver gives browser.click and browser.type on one tab, by the debugger or the fallback; the operations are
 * built from these here, once for both.
 */
export interface PageDriver {
  /** Runs a page function with PAGE_MARKS and `args`; undefined when the page gave no answer (it may be navigating). */
  run<T>(fn: PageFunction<T>, args: unknown[]): Promise<PageResult<T> | undefined>;
  /**
   * Clicks element `index`: at `at` (a point coverInPage found free), else at its center, scrolled into view. armed:
   * the probe coverInPage armed at `at`, and whether it could (else the driver arms its own check, if it has one).
   */
  clickAt(index: number, at?: ClickPoint, armed?: { probe: InputProbe; armed: boolean }): Promise<void>;
  /** A new input check for a trusted click, armed by coverInPage with the cover (only the debugger has one). */
  inputProbe?(): InputProbe;
  /** Inserts the text at the focus, into element `index` (prepareTypingInPage ran): an empty text replaces the selection. */
  insertText(index: number, text: string): Promise<void>;
  /** A Backspace key at the focus, which the page's editor handles itself (pressKey's). */
  backspace(): Promise<void>;
  sleep: Sleep;
}

/** A page function's value; its error, or no answer, is thrown. */
async function inPage<T>(page: PageDriver, fn: PageFunction<T>, args: unknown[]): Promise<T> {
  const out = await page.run(fn, args);
  if (!out) throw new Error(PAGE_SCRIPT_FAILED);
  if (!out.ok) throw new Error(out.error);
  return out.value;
}

/**
 * What a click on element `index`, or typing into it, meets (coverInPage). A page that gives no answer (it may be
 * navigating), or anything but one of its answers, is no verdict ({}), never taken for covered: the click or typing
 * that follows finds out what is there.
 */
async function aimAt(page: PageDriver, index: number, act: AimFor): Promise<{ aim: Aim; armed?: { probe: InputProbe; armed: boolean } }> {
  for (let aims = 1; ; aims++) {
    const probe = page.inputProbe?.();
    const out = await page.run<Aim>(coverInPage, probe ? [index, act, probe] : [index, act]);
    if (out?.ok === false) throw new Error(out.error);
    const aim = out?.ok === true && isAim(out.value) ? out.value : {};
    // Scrolled into view: the page may move it in answer to the scroll (a dropdown's list, placed against the page that
    // scrolled with it, is put back a frame later), and a click at the point measured would land on a neighbouring
    // option. Aimed again after that moment, until it holds still.
    if (aim.moved && aims < MAX_AIMS) {
      await page.sleep(SCROLL_REFLOW_MS);
      continue;
    }
    return probe && typeof aim.armed === "boolean" ? { aim, armed: { probe, armed: aim.armed } } : { aim };
  }
}

/** How long a page may take to move an element in answer to the scroll that brought it into view (its scroll events). */
const SCROLL_REFLOW_MS = 50;
/** Most times an element is aimed at while scrolling it into view keeps moving it. */
const MAX_AIMS = 3;

/**
 * A plain click on element `index` (an option of a list, a suggestion), at a point of it aimed at like any click
 * (aimAt): never measured in the same moment as the scroll that brought it into view. Something over it, or no
 * verdict: its center.
 */
async function clickSteady(page: PageDriver, index: number): Promise<void> {
  const { aim, armed } = await aimAt(page, index, "click");
  const cover = aim.cover ?? null;
  const at = cover !== null && typeof cover === "object" && "x" in cover ? cover : undefined;
  await page.clickAt(index, at, at ? armed : undefined);
}

/** The check state of element `index` (after a click); null when the page gave no answer. */
async function checkState(page: PageDriver, index: number): Promise<CheckState | null> {
  const out = await page.run<CheckState>(checkStateInPage, [index]);
  if (out?.ok === false) throw new Error(out.error);
  return out?.ok === true ? out.value : null;
}

/**
 * browser.click for both drivers: a click, or with `checked` a checkbox,
 * radio button or switch set to that state (clicked only when it is not so
 * already, so a second call never unchecks it). For those, the result says
 * the state afterwards, so the agent sees what its click did.
 */
export async function clickElement(p: Params<"browser.click">, page: PageDriver): Promise<Result<"browser.click">> {
  const index = Math.trunc(p.index);
  const { checked } = p;
  const { aim, armed } = await aimAt(page, index, checked === undefined ? "click" : checked ? "check" : "uncheck");
  const before = aim.state ?? null;
  if (checked !== undefined) {
    if (!before?.checkable) throw new Error(`element ${index} is not a checkbox, radio button or switch; leave out checked to click it`);
    if (before.checked === checked) return { ok: true, checked };
    if (!checked && before.radio) throw new Error(`element ${index} is a radio button: it is unchecked by checking another option of its group`);
  }
  const cover = aim.cover ?? null;
  notInDialog(index, cover);
  await page.clickAt(index, clickPoint(index, cover), armed);
  if (!before?.checkable) return { ok: true };
  let now = (await checkState(page, index).catch(() => null))?.checked;
  if (now === undefined) return { ok: true };
  // Not set by the click (e.g. it hit something covering the box): set without a real click (setCheckedInPage).
  if (checked !== undefined && now !== checked) now = await inPage<boolean>(page, setCheckedInPage, [index, checked]);
  if (checked !== undefined && now !== checked) throw new Error(`element ${index} is still ${now ? "checked" : "unchecked"} after clicking it`);
  return { ok: true, checked: now };
}

/** Throws coveredText when an open modal dialog covers the element: nothing may be done to it, clicked or not. */
function notInDialog(index: number, cover: Cover): void {
  if (typeof cover === "string") throw new Error(coveredText(index, cover));
}

/**
 * Where to click the element: the free point coverInPage found, or undefined for its center (no verdict). Throws overlaidText
 * when something else covers it everywhere: a click would reach that instead (e.g. pick an option of a list).
 */
function clickPoint(index: number, cover: Cover): ClickPoint | undefined {
  if (cover === null || typeof cover === "string") return undefined;
  if ("over" in cover) throw new Error(overlaidText(index, cover));
  return cover;
}

/** What typing into an element means (typeTargetInPage). */
export type TypeTarget = "field" | "editor" | "select" | "listbox" | "other";

/** How long a custom dropdown's options may take to show after the click that opens it, and a field's suggestions after typing. */
const LIST_OPTIONS_WAIT_MS = 1500;
/** Suggestions that stay the same this long after typing are the ones for the typed text (not an earlier list still shown). */
const SUGGESTIONS_SETTLED_MS = 500;
/** Most suggestions a type result lists. */
const MAX_SUGGESTIONS = 10;

/** A text field's suggestions after typing into it (suggestionsInPage). */
export type Suggestions =
  | { kind: "none" }
  | { kind: "waiting" }
  | { kind: "pick"; label: string; index: number }
  | { kind: "shown"; labels: string[] };

/** How long after the click's focus an editor may still move the selection (ProseMirror's restore runs after 20 ms). */
const SELECTION_SETTLE_MS = 50;

/** How long the page may take to show a clicked option chosen, or an emptied field empty (a framework's re-render). */
const TYPED_CHECK_WAIT_MS = 1000;

/** A custom dropdown's option (listOptionInPage): its label, its element number, and whether it is selected already. */
export interface ListOption {
  label: string;
  index: number;
  selected: boolean;
}

/**
 * browser.type for both drivers. A dropdown gets its option chosen, never
 * clicked (a click opens its native popup) or typed into. A custom dropdown
 * is opened (unless its options show already) and the option the text names
 * is clicked, unless it is selected already (a click unselects it in a
 * multi-select); the click must then show it chosen. Anything else is
 * clicked for the focus, prepared so the text replaces a field's value, and
 * the text is inserted only into what the click focused. An empty text
 * empties the field (an editor too) and is read back: an editor that kept
 * its text is an error, not a success. A field that suggests values as you
 * type (an ARIA combobox, not a search box) then gets the suggestion whose
 * label is the text clicked, as a person picks it from the list; when none
 * is, the result lists the ones shown.
 */
export async function typeIntoElement(p: Params<"browser.type">, page: PageDriver): Promise<Result<"browser.type">> {
  const index = Math.trunc(p.index);
  const { text } = p;
  const { aim, armed } = await aimAt(page, index, "type");
  const cover = aim.cover ?? null;
  notInDialog(index, cover);
  const target = aim.target;
  if (!target) throw new Error(PAGE_SCRIPT_FAILED);
  // A dropdown's option is chosen without a click, so only a modal dialog over it stops that.
  if (target === "select") return { ok: true, selected: await inPage<string>(page, selectOptionInPage, [index, text]) };
  if (target === "listbox") {
    // The shown option the text names; before the click that opens it (opened false) the lists the page shows are
    // noted, so that after the click only a list tied to the dropdown or newly shown counts.
    const optionNow = (opened: boolean) => inPage<ListOption | null>(page, listOptionInPage, [index, text, opened]);
    let option = await optionNow(false);
    if (!option) {
      await page.clickAt(index, clickPoint(index, cover));
      // Its options may render a moment after the click (an animation, or loaded from the server).
      for (let waited = 0; ; waited += POLL_MS / 2) {
        let error: unknown = null;
        option = await optionNow(true).catch((e: unknown) => ((error = e), null));
        if (option || waited >= LIST_OPTIONS_WAIT_MS) {
          if (error) throw error;
          break;
        }
        await page.sleep(POLL_MS / 2);
      }
    }
    if (!option) {
      throw new Error(
        "this dropdown showed no options (role=option) of its own when clicked. If the click opened a search field, type the text into that field, then click the option; else read_page and click the option it shows",
      );
    }
    // Clicking a selected option unselects it in a multi-select.
    if (option.selected) return { ok: true, selected: option.label };
    await clickSteady(page, option.index);
    const chosen = option;
    const shown = await waitFor(() => inPage<{ chosen: boolean; shows: string }>(page, optionChosenInPage, [index, chosen.index, chosen.label]), (s) => s.chosen, page.sleep);
    if (!shown.chosen) {
      throw new Error(
        `clicked option ${JSON.stringify(option.label)} of dropdown ${index}, but the page does not show it chosen (the option is not aria-selected, and the dropdown shows ${JSON.stringify(shown.shows)}); read_page to see its state`,
      );
    }
    return { ok: true, selected: option.label };
  }
  await page.clickAt(index, clickPoint(index, cover), armed);
  const whole = text === "";
  await inPage<true>(page, prepareTypingInPage, [index, whole]);
  if (target !== "field") {
    // An editor may put back its own selection a moment after the click focused it (ProseMirror does, 20 ms after the
    // focus): the text would then go where the click left the caret, and an empty text would delete nothing (or one
    // character, by the Backspace below). So once that moment has passed, it is prepared again (the same selection,
    // when nothing moved it).
    await page.sleep(SELECTION_SETTLE_MS);
    await inPage<true>(page, prepareTypingInPage, [index, whole]);
  }
  await page.insertText(index, text);
  if (text !== "") return suggestionAfterTyping(page, index, text);
  let left = await inPage<string | null>(page, typedTextInPage, [index]);
  if (left) {
    // Text is left (an editor that ignores the inserted nothing): its whole text selected again, as the insertion may
    // have moved the selection, and a Backspace on it, a key the editor handles itself. Then read until it shows.
    await inPage<true>(page, prepareTypingInPage, [index, true]);
    await page.backspace();
    left = await waitFor(() => inPage<string | null>(page, typedTextInPage, [index]), (t) => !t, page.sleep);
  }
  if (left) {
    const shown = left.length > 80 ? left.slice(0, 80) + "…" : left;
    throw new Error(
      `element ${index} still holds ${JSON.stringify(shown)} after its whole text was selected and deleted: the editor did not take the deletion, so it was not emptied. Read_page to see it, then try selecting its text (click it, Control+A) and pressing Backspace`,
    );
  }
  return { ok: true };
}

/**
 * After typing into field `index`: its suggestions, waited for (they may load from the server) until one is the typed
 * text, which is then clicked, or until those shown stay the same SUGGESTIONS_SETTLED_MS. A field that suggests
 * nothing costs one page call.
 */
async function suggestionAfterTyping(page: PageDriver, index: number, text: string): Promise<Result<"browser.type">> {
  let shown: string[] | null = null;
  let since = 0;
  for (let waited = 0; ; waited += POLL_MS / 2) {
    // The page may be gone (the typing navigated), or give no answer: nothing to pick.
    const out = await page.run<Suggestions>(suggestionsInPage, [index, text]).catch(() => undefined);
    const s = out?.ok === true ? out.value : null;
    if (s?.kind !== "waiting" && s?.kind !== "pick" && s?.kind !== "shown") return { ok: true };
    if (s.kind === "pick") {
      await clickSteady(page, s.index);
      return { ok: true, selected: s.label };
    }
    if (s.kind === "shown") {
      if (!shown || shown.join("\n") !== s.labels.join("\n")) [shown, since] = [s.labels, waited];
      else if (waited - since >= SUGGESTIONS_SETTLED_MS) break;
    } else shown = null;
    if (waited >= LIST_OPTIONS_WAIT_MS) break;
    await page.sleep(POLL_MS / 2);
  }
  return shown ? { ok: true, suggestions: shown.slice(0, MAX_SUGGESTIONS) } : { ok: true };
}

/** Reads until `done` holds, for up to TYPED_CHECK_WAIT_MS; returns the last reading. */
async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, sleep: Sleep): Promise<T> {
  let v = await read();
  for (let waited = 0; !done(v) && waited < TYPED_CHECK_WAIT_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    v = await read();
  }
  return v;
}
