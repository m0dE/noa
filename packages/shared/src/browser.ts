import type { WaitCheck, WaitCheckParams } from "./wait.js";

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
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible text of the page, truncated to MAX_SNAPSHOT_TEXT characters. */
  text: string;
  elements: ElementInfo[];
  /** True when elements were cut at MAX_SNAPSHOT_ELEMENTS. */
  truncated: boolean;
  /**
   * Visible frames from other sites (e.g. an account switcher or a sign-in popup): their content is
   * not in text or elements, and they cannot be clicked. Absent when there are none.
   */
  frames?: { url: string; title: string }[];
}

export const MAX_SNAPSHOT_TEXT = 8000;
export const MAX_SNAPSHOT_ELEMENTS = 300;
/** Option labels listed per <select> in a snapshot. */
export const MAX_SNAPSHOT_OPTIONS = 30;

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
export type BrowserMethods = {
  "browser.navigate": { params: { url: string }; result: { url: string; title: string } };
  /** tab: short tab id ("t2"); default the current tab. Reading never activates the tab. */
  "browser.readPage": { params: { tab?: string }; result: PageSnapshot };
  "browser.screenshot": { params: Record<string, never>; result: Screenshot };
  /**
   * checked: for a checkbox, radio button or switch, the state to set (clicked only when it is not
   * so already); an error for other elements. The result's checked: the state afterwards, for those.
   */
  "browser.click": { params: { index: number; checked?: boolean }; result: { ok: true; checked?: boolean } };
  /**
   * Replaces a field's value with text (appended in a rich editor). For a <select>, chooses the
   * option whose label or value is text instead: `selected` is its label.
   */
  "browser.type": { params: { index: number; text: string }; result: { ok: true; selected?: string } };
  "browser.paste": { params: { text: string }; result: { ok: true } };
  /** key is a KeyboardEvent.key value, optionally with modifiers: "Control+Enter". */
  "browser.pressKey": { params: { key: string }; result: { ok: true } };
  "browser.scroll": {
    params: { direction: ScrollDirection; amount?: number; index?: number };
    /** The report fields are missing when the driver could not measure (older drivers, fakes). */
    result: { ok: true } & Partial<ScrollReport>;
  };
  "browser.upload": { params: { index: number; paths: string[] }; result: { ok: true } };
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
  "vault.getCredential": {
    params: { site: string };
    result: { found: false; locked?: boolean } | { found: true; username: string; password: string };
  };
}
export type BrowserMethod = keyof BrowserMethods;
