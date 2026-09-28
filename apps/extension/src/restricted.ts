import { errorMessage } from "@noa/shared";
/**
 * Which pages an extension may see and control, and what to say when it may
 * not. Chrome keeps extensions out of its own pages, other extensions' pages
 * and the Chrome Web Store: neither chrome.debugger nor chrome.scripting works
 * there, and nothing bypasses it. A run then works in other tabs instead of
 * failing. Every rule is here, with the reason for it. Pure.
 */

/**
 * URL schemes Chrome does not let extensions script or debug, and why.
 * (Chrome's own schemes differ per Chromium browser, hence edge/brave/...)
 */
const RESTRICTED_SCHEMES: Readonly<Record<string, string>> = {
  chrome: "Chrome's own pages (settings, extensions, the new-tab page): no extension may touch them",
  "chrome-untrusted": "Chrome's sandboxed WebUI pages: same rule as chrome://",
  "chrome-extension": "another extension's pages (or this one's own UI): not scriptable by other extensions",
  "chrome-search": "the new-tab page's search frames",
  devtools: "DevTools windows",
  "view-source": "source views: Chrome reports \"Cannot access contents of url\"",
  edge: "Edge's own pages",
  brave: "Brave's own pages",
  opera: "Opera's own pages",
  vivaldi: "Vivaldi's own pages",
  about: "about: pages other than about:blank are browser pages",
  data: "data: URLs: no host permission can cover them",
  file: "local files: need the user's per-extension \"Allow access to file URLs\" switch",
};

/** Web Store hosts (and paths): Chrome answers "The extensions gallery cannot be scripted." */
const WEB_STORE: readonly { host: string; path?: string; why: string }[] = [
  { host: "chromewebstore.google.com", why: "the Chrome Web Store" },
  { host: "chrome.google.com", path: "/webstore", why: "the old Web Store address, including the developer dashboard (/webstore/devconsole)" },
];

/**
 * The quiet line in the chat when the user's tab is such a page and the request is about that page
 * (asksAboutThePage): a request that goes elsewhere anyway needs no note (the agent is told either way).
 */
export const RESTRICTED_STATUS = "Chrome doesn't let extensions see this page; Noa will work in other tabs";

/** Words that point at the page the user is on ("this page", "the current tab", "here", "what's on screen"). */
const ABOUT_THE_PAGE =
  /\b(?:this|that|the current|current|the open|my current)\s+(?:page|tab|site|website|screen|article|post|email|mail|message|video|form|document|doc|product|listing)\b|\bhere\b|\bon (?:it|this|screen)\b|\bwhat(?:'s| is) (?:this|on)\b/i;

/** The request is about the page the user's tab shows: an empty send ("look at the page"), or words that point at it. */
export function asksAboutThePage(text: string, screen = false): boolean {
  return screen || ABOUT_THE_PAGE.test(text);
}

/**
 * True when Chrome keeps extensions out of the page. An empty URL (a tab
 * still loading) is not restricted: it is not known yet.
 */
export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url || url === "about:blank") return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme && scheme in RESTRICTED_SCHEMES) return true;
  try {
    const u = new URL(url);
    return WEB_STORE.some((w) => u.hostname === w.host && (!w.path || u.pathname.startsWith(w.path)));
  } catch {
    return false;
  }
}

/** A page a run can act on now: http(s) (not restricted) or about:blank. Unknown (loading) URLs are not. */
export function isControllableUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url === "about:blank") return true;
  return /^https?:\/\//i.test(url) && !isRestrictedUrl(url);
}

/** Chrome's error for a tab with another extension's frame inside: the debugger is refused, chrome.scripting still works. */
const FOREIGN_FRAME_ERROR = /Cannot access a chrome-extension:\/\/ URL of different extension/i;

/**
 * True for the error Chrome gives when a tab contains a frame of another
 * extension (Streak in Gmail, password managers, ...). chrome.debugger then
 * refuses the whole tab: attach and every command fail, and an existing
 * session is detached ("target_closed") as soon as such a frame appears.
 * Driver drives such a tab with FallbackDriver.
 */
export function isDebuggerBlocked(err: unknown): boolean {
  const msg = errorMessage(err);
  return FOREIGN_FRAME_ERROR.test(msg) || /debugger_access_denied/i.test(msg);
}

/**
 * True when Chrome dropped the debugger from a tab in the middle of a command
 * ("Detached while handling command."), as it does when another extension's
 * frame appears on the page being loaded (Streak in Gmail). Unlike
 * isDebuggerBlocked, the command may or may not have taken effect.
 */
export function isDebuggerDetached(err: unknown): boolean {
  return /Detached while handling command|Debugger is not attached to the tab/i.test(errorMessage(err));
}

/**
 * True for the errors Chrome gives when an extension touches such a page:
 * "The extensions gallery cannot be scripted." (Web Store), "Cannot access a
 * chrome:// URL", "Cannot access contents of url ..." (view-source), and CDP
 * -32000 "Not allowed". Not the error of a tab with another extension's frame
 * inside ("... chrome-extension:// URL of different extension"): that tab is
 * driven by FallbackDriver instead.
 */
export function isRestrictedError(err: unknown): boolean {
  const msg = errorMessage(err);
  if (FOREIGN_FRAME_ERROR.test(msg)) return false;
  return /cannot be scripted|Cannot access a chrome(-untrusted)?:\/\/ URL|Cannot access contents of url|"code"\s*:\s*-32000[^}]*"Not allowed"|^\s*Not allowed\.?\s*$/i.test(msg);
}

/** A tool's answer on such a page, in place of Chrome's raw error. */
export function restrictedToolError(url?: string): string {
  const page = url ? ` (${url})` : "";
  return (
    `Chrome doesn't allow extensions to see or control this page${page}, so it can't be read, captured or clicked. ` +
    "Work in another tab (open_tabs, switch_tab), or tell the user exactly what to press on this page and call task_pause."
  );
}
