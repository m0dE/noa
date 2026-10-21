import type { JsDialog } from "./dialog.js";
import type { ImageQuality, ImageSize } from "./images.js";
import type { WaitCheck, WaitCheckParams } from "./wait.js";
import type { NoaFileList, SavedFile, SaveFileParams } from "./noa-files.js";

/**
 * Browser primitives the extension performs on the agent tab, and the page
 * snapshot format. The helper calls these over native messaging as
 * `browser.<name>` RPC methods.
 */

/** One interactive element found on the page, addressed by `index`. */
export interface ElementInfo {
  index: number;
  tag: string;
  /** ARIA role or implicit role, e.g. "button", "link", "textbox". */
  role: string;
  /** Accessible name: aria-label, label text, alt, title, placeholder or text. */
  name: string;
  /**
   * Visible text inside the element, truncated to 120 chars, when it differs
   * from `name` (e.g. a button with aria-label "Account menu" that shows
   * "Alpha @alpha").
   */
  text?: string;
  /** input type, when tag is input. */
  type?: string;
  /** Current value for inputs, truncated to 200 chars; for a <select>, the chosen option's label. */
  value?: string;
  /** A <select>'s option labels (the first MAX_SNAPSHOT_OPTIONS), so a step can name one. */
  options?: string[];
  /** Checkboxes, radio buttons and switches: whether it is checked (absent: not one of those). */
  checked?: boolean;
  /** A form field that must be filled in (required, aria-required). */
  required?: boolean;
  /**
   * A form field that fails validation, with the page's message (validationMessage, or the text
   * of aria-errormessage / aria-describedby for aria-invalid fields). Only once it has a value or
   * the form was submitted, so an empty form is not all invalid.
   */
  invalid?: string;
  href?: string;
  /** data-testid attribute, when present. Useful to Claude as a stable hint. */
  testId?: string;
  disabled?: boolean;
  /** True when at least part of the element is inside the viewport. */
  inViewport: boolean;
  /** Inside an open dialog (role=dialog/alertdialog, aria-modal, or <dialog open>), e.g. X's compose or reply box. */
  inDialog?: boolean;
  /**
   * Covered by an open modal dialog (a <dialog> opened with showModal, or aria-modal="true"): a click at its center
   * lands on the dialog or its backdrop. Clicking or typing into it fails until the dialog is closed.
   */
  covered?: boolean;
  /**
   * What a click on it opens, as the page declares it (aria-haspopup; "true" means a menu): it shows choices or a
   * dialog, and does nothing else by itself. Absent when it declares none.
   */
  popup?: "menu" | "listbox" | "tree" | "grid" | "dialog";
  /** aria-expanded: the menu, list or section it opens is open now (true) or closed (false). Absent when not said. */
  expanded?: boolean;
  /**
   * The post, section or dialog it is in (the nearest article, dialog, or labelled region or form), as an index into
   * PageSnapshot.contexts. Absent when it is in none.
   */
  context?: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible text of the page, truncated to MAX_SNAPSHOT_TEXT characters. */
  text: string;
  /** The page has more text than `text` (it was cut at MAX_SNAPSHOT_TEXT). */
  textCut?: true;
  elements: ElementInfo[];
  /** True when elements were cut at MAX_SNAPSHOT_ELEMENTS. */
  truncated: boolean;
  /**
   * The start of each post, section or dialog an element is in (ElementInfo.context): its label and visible text,
   * at most MAX_CONTEXT_TEXT characters, e.g. "Carla @carla · 2h Our tide tables now cover…". Absent when none.
   */
  contexts?: string[];
  /**
   * Visible frames from other sites (e.g. an account switcher or a sign-in popup): their content is
   * not in text or elements, and they cannot be clicked. Absent when there are none.
   */
  frames?: { url: string; title: string }[];
  /**
   * Scrollable areas in view (not the page itself) whose content goes on past what they show, e.g. a list of
   * accounts in a picker. What is scrolled out of an area may be missing from elements and text: a long list often
   * draws only the rows in view. Absent when there are none.
   */
  areas?: ScrollArea[];
  /**
   * The page's pictures (<img>) that are shown at least MIN_PICTURE_SIDE px on both sides, largest first, at most
   * MAX_SNAPSHOT_PICTURES: what save_file takes by url to keep one. Absent when there are none.
   */
  pictures?: PagePicture[];
}

/** A picture on the page (PageSnapshot.pictures). */
export interface PagePicture {
  /** Its address: the largest one its srcset offers, else a lazy loader's (data-src: the placeholder shown until then is not it), else the one it shows. */
  url: string;
  /** Its alt text, else its title or the caption of the figure it is in. */
  text?: string;
  /**
   * Its own size in pixels (0 when unknown: not loaded yet, or a lazy page's placeholder is shown instead), and the
   * size it is shown at (CSS pixels).
   */
  width: number;
  height: number;
  shownWidth: number;
  shownHeight: number;
  /** The link it is in, as its address. */
  link?: string;
}

/** Pictures a snapshot lists at most (PageSnapshot.pictures). */
export const MAX_SNAPSHOT_PICTURES = 15;
/** Pictures shown smaller than this on either side (icons, avatars, spacers) are not listed. */
export const MIN_PICTURE_SIDE = 48;

/** A scrollable area of a PageSnapshot (PageSnapshot.areas). */
export interface ScrollArea {
  /** Its number: browser.scroll with this index scrolls inside it (an element's own number when it is listed too). */
  index: number;
  /** Its label (aria-label, or the heading just before it), when it has one. */
  label?: string;
  /** The first and last listed elements (else lines of text) it shows. */
  first?: string;
  last?: string;
  /** Its height, and how much of its content is out of view above and below it (CSS pixels). */
  height: number;
  above: number;
  below: number;
  inDialog?: true;
}

/** Scrollable areas a snapshot reports (PageSnapshot.areas). */
export const MAX_SNAPSHOT_AREAS = 8;

export const MAX_SNAPSHOT_TEXT = 8000;
export const MAX_SNAPSHOT_ELEMENTS = 300;
/** Characters of a container's text kept in PageSnapshot.contexts. */
export const MAX_CONTEXT_TEXT = 160;
/** Containers kept in PageSnapshot.contexts (elements in later ones have no context). */
export const MAX_SNAPSHOT_CONTEXTS = 60;
/** Option labels listed per <select> in a snapshot. */
export const MAX_SNAPSHOT_OPTIONS = 30;

/** Places listed by one find_text (the count says how many there are in all). */
export const MAX_FOUND_PLACES = 10;
/** Characters of a found place's text (its row, list item or paragraph) shown around the match. */
export const MAX_FOUND_CONTEXT = 300;
/** Controls listed next to each found place. */
export const MAX_FOUND_CONTROLS = 6;

/** A control next to found text: its role and accessible name, and its read_page number when the last read listed it. */
export interface FoundControl {
  role: string;
  name: string;
  /** A field's value (a <select>: the chosen option's label); never a password's. */
  value?: string;
  /** Checkboxes and radio buttons: whether it is checked. */
  checked?: boolean;
  index?: number;
}

/** One place on the page where find_text's text occurs: its row, list item, paragraph or other smallest block around it. */
export interface FoundPlace {
  /** Its number among all the places, in page order (1-based): find_text's `place` scrolls to it. */
  number: number;
  /** The place's text (whitespace collapsed), cut to MAX_FOUND_CONTEXT characters around the match. */
  context: string;
  /** Matches in this place (a row that names it twice counts 2). */
  matches: number;
  /** At least part of it is inside the viewport. */
  inViewport: boolean;
  /** The controls inside it (at most MAX_FOUND_CONTROLS): a row's checkbox, its Edit link, a field's value. */
  controls: FoundControl[];
}

/** browser.findText's answer. */
export interface FoundText {
  /** Matches on the whole page. */
  total: number;
  /** Places with a match on the whole page. */
  placeCount: number;
  /** The places, in page order: the first MAX_FOUND_PLACES, and the one asked for when it is further down. */
  places: FoundPlace[];
  /** The number of the place scrolled into view, or null when none was. */
  scrolledTo: number | null;
}

export interface Screenshot {
  /** Base64 without the data: prefix. */
  base64: string;
  mimeType: "image/png" | "image/jpeg";
}

export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * What a browser.scroll actually did, measured before and after. Positions
 * are along the scroll direction's axis (vertical for up/down).
 */
export interface ScrollReport {
  /** Pixels moved in the requested direction; 0 when nothing moved. */
  moved: number;
  /**
   * What moved, or when nothing moved, what was measured: the page (the
   * window), or a scrollable container (the element given by index or its
   * nearest scrollable ancestor, or a container under the wheel point that
   * scrolled instead of the page).
   */
  target: "page" | "container";
  /** The container's element index from read_page, when it has one. */
  containerIndex?: number;
  /** Scroll offset after the scroll (scrollY / scrollTop, or the x equivalents). */
  position: number;
  /** Full scrollable length (scrollHeight / scrollWidth). */
  size: number;
  /** Visible length (viewport or container client size). */
  view: number;
  /**
   * Why nothing moved: "end" already at the end that way; "fixed" nothing
   * there scrolls that way; "ignored" it could scroll but the page did not
   * react; "frame" the wheel point is over an embedded frame.
   */
  reason?: "end" | "fixed" | "ignored" | "frame";
}

/**
 * One tab the agent works in during a run. `id` is a short per-run id ("t1" is
 * the tab the run started on, tabs opened by open_tabs are "t2", "t3", ...).
 */
export interface AgentTabInfo {
  id: string;
  url: string;
  title: string;
  /** The tab the single-tab tools (read_page, act, navigate, ...) act on. */
  current: boolean;
  /** One of the user's own tabs (open before the run, in its window): usable like the others, never closed. */
  user?: true;
  /** Set when the tab did not finish loading (e.g. the 30 s cap was hit). */
  error?: string;
}

/** Most URLs one open_tabs / read_page call handles. */
export const MAX_TABS_PER_CALL = 8;
/** Most tabs the agent may have open at once in one run (including the first). */
export const MAX_AGENT_TABS = 20;

/**
 * Every browser.* call the helper makes for a task carries that task session's
 * id as an extra `sessionId` param, so tasks running at the same time act in
 * their own tabs. Calls without one (mcp-server --attach) use the first agent tab.
 */
export interface BrowserCallContext {
  sessionId?: string;
}

/** What browser.clickXAccountEntry did: clicked the entry, or why not (it was not there, X replaced it, ...). */
export type XAccountEntryClick = { clicked: true } | { clicked: false; reason: string };

/** Params and results of every browser RPC method. */
/**
 * After a click, typing or a key: the time the page gets to react (settleMs), which the driver extends while
 * requests (fetch, XHR) that the page started after the input are still loading, up to SETTLE_REQUESTS_MAX_MS: a
 * search box's results come from the server, often a second or more after the typing. A driver that did this answers
 * settled; one that did not (no way to see the page's requests) leaves the wait to the caller.
 */
export interface Settle {
  settleMs?: number;
}
export interface Settled {
  settled?: true;
}
/** The longest a click, typing or key waits for the requests it started (Settle). */
export const SETTLE_REQUESTS_MAX_MS = 4000;

export type BrowserMethods = {
  /**
   * kept: the current tab's page held what was entered in its form and the address is on another site, so that tab
   * (kept, a short tab id) was left as it is and the address opened in a new tab (tab), now the current tab.
   */
  "browser.navigate": { params: { url: string }; result: { url: string; title: string; kept?: string; tab?: string } };
  /** tab: short tab id ("t2"); default the current tab. Reading never activates the tab. */
  "browser.readPage": { params: { tab?: string }; result: PageSnapshot };
  "browser.screenshot": { params: Record<string, never>; result: Screenshot };
  /**
   * find_text in the current tab: where `text` occurs in the page's shown text and form fields (case and spacing do
   * not matter), anywhere on the page. scroll: scrolls place number `place` (1-based, default 1) into view. again:
   * the same search as the last call (which scrolled), after a page read: its places listed anew without searching
   * the page again, unless the page changed since. Reads only (scrolling aside): never approval-gated.
   */
  "browser.findText": { params: { text: string; place?: number; scroll?: boolean; again?: boolean }; result: FoundText };
  /**
   * checked: for a checkbox, radio button or switch, the state to set (clicked only when it is not
   * so already); an error for other elements. The result's checked: the state afterwards, for those.
   * settleMs (on click, type and pressKey): see Settle.
   */
  "browser.click": { params: { index: number; checked?: boolean } & Settle; result: { ok: true; checked?: boolean } & Settled };
  /**
   * Replaces a field's value with text (appended in a rich editor). For a <select>, chooses the
   * option whose label or value is text instead, and for a custom dropdown (an ARIA combobox or a
   * button with a listbox popup) opens it and clicks the option labelled text: `selected` is its label.
   * A text field that suggests values as you type (an ARIA combobox, not a search box) gets the
   * suggestion labelled text clicked (`selected`); when none is, `suggestions` lists those shown.
   */
  "browser.type": { params: { index: number; text: string } & Settle; result: { ok: true; selected?: string; suggestions?: string[] } & Settled };
  "browser.paste": { params: { text: string }; result: { ok: true } };
  /** key is a KeyboardEvent.key value, optionally with modifiers: "Control+Enter". */
  "browser.pressKey": { params: { key: string } & Settle; result: { ok: true } & Settled };
  "browser.scroll": {
    params: { direction: ScrollDirection; amount?: number; index?: number };
    /** The report fields are missing when the driver could not measure (older drivers, fakes). */
    result: { ok: true } & Partial<ScrollReport>;
  };
  /** via: how the files were given (set on a file input, dropped on the element, pasted into it). Absent: file input. */
  "browser.upload": { params: { index: number; paths: string[] }; result: { ok: true; via?: "input" | "drop" | "paste" } };
  /**
   * switch_x_account's pick in X's open account menu, and nothing else: the personal entry
   * ("Switch to @handle", testid UserCell) of exactly this handle, found and clicked in one synchronous
   * step in the page (X replaces the menu's nodes when it flips to its delegate view, so no element
   * number or earlier read may stand for it). Never a delegate's "Act as" cell, nothing outside the menu.
   * waitMs: how long the page may wait for the menu to show its accounts. press: a real mouse press
   * instead (for a page that ignored the click), aimed at that same node and refused when X replaced it
   * before the press. clicked false: the entry was not in the menu at that moment (see reason).
   */
  "browser.clickXAccountEntry": { params: { handle: string; waitMs?: number; press?: boolean }; result: XAccountEntryClick };
  "browser.currentUrl": { params: Record<string, never>; result: { url: string } };
  /**
   * Opens each URL in a new tab of the agent's window, loading in parallel, and
   * waits for all of them (30 s cap each). background false shows the first new
   * tab and makes it the current tab; otherwise the current tab is unchanged.
   */
  "browser.openTabs": { params: { urls: string[]; background?: boolean }; result: { tabs: AgentTabInfo[] } };
  /** Makes a tab the current tab (the one the single-tab methods act on). */
  "browser.switchTab": { params: { tab: string }; result: AgentTabInfo };
  "browser.listTabs": { params: Record<string, never>; result: { tabs: AgentTabInfo[] } };
  /** Closes tabs the agent opened. The run's first tab is never closed. */
  "browser.closeTabs": { params: { tabs: string[] }; result: { closed: string[]; tabs: AgentTabInfo[] } };
  /**
   * One slice of wait_for: watches the tab (default the current one; it is not made current) until a condition
   * holds or timeoutMs passes, then answers which one holds (met), or none yet. Reads only: never approval-gated.
   */
  "browser.waitFor": { params: WaitCheckParams; result: WaitCheck };
  /**
   * Answers the JavaScript dialog open in the current tab, or in `tab` (see dialog.ts): accept presses OK (Leave on
   * "Leave site?"), otherwise Cancel (Stay); text is a prompt's answer. Fails when no dialog is open there. The
   * result's tab: the short id of the tab it was in.
   */
  "browser.handleDialog": { params: { tab?: string; accept: boolean; text?: string }; result: { tab: string; dialog: JsDialog; accepted: boolean } };
  "vault.getCredential": {
    params: { site: string };
    result: { found: false; locked?: boolean } | { found: true; username: string; password: string };
  };
  /**
   * generate_image: a picture made from the description by the account's hosted AI (paid from its usage credit), saved
   * as a PNG in the user's Noa folder (Downloads/Noa/images/<name>.png). path: that file, absolute. preview: a smaller
   * JPEG of it for the model and the chat (the PNG itself can be larger than a native message may carry).
   */
  /**
   * list_files: the files in the user's Noa folder (noa-files.ts), newest first; search: only names containing it (any
   * case).
   */
  "files.list": { params: { search?: string }; result: NoaFileList };
  /**
   * save_file: keeps a file in the user's Noa folder (Downloads/Noa/<folder>/<name>) and, on a plan with cloud files,
   * in the account's cloud files (file-saver.ts). Rejects when the source cannot be read.
   */
  "files.save": { params: SaveFileParams; result: SavedFile };
  /**
   * view_file: a picture in the user's files (a path list_files or save_file gave; a cloud-only one is downloaded
   * first), as a JPEG at most VIEW_FILE_MAX_SIDE on its longest side, with the picture's own size and the file's bytes.
   */
  "files.view": { params: { path: string }; result: { image: { base64: string; mimeType: string }; width: number; height: number; size: number } };
  "media.generateImage": {
    params: { prompt: string; name?: string; size?: ImageSize; quality?: ImageQuality; transparent?: boolean };
    result: { path: string; preview: { base64: string; mimeType: string }; size: ImageSize; quality: ImageQuality; chargedCents: number };
  };
}
export type BrowserMethod = keyof BrowserMethods;
