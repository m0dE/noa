/**
 * One slice of wait_for in the page (browser.waitFor): watches the document
 * with a MutationObserver (a change is checked within MIN_GAP_MS) and polls
 * as a fallback (for what mutations do not show, e.g. an element becoming
 * visible through a style sheet), polling less often the longer it waits.
 * Answers when a condition holds, when the page's URL changes (the driver
 * checks url_matches itself, from the tab), or after timeoutMs. Nothing is
 * read or sent anywhere else: no screenshots, no model.
 *
 * Both drivers run the same function: the debugger (Runtime.evaluate with
 * awaitPromise) and chrome.scripting (which waits for the returned promise).
 */
import type { WaitCondition } from "@noa/shared";
import type { PageResult } from "./scroll-probe.js";

export interface PageWaitArgs {
  until: WaitCondition[];
  timeoutMs: number;
  /** page_changed compares the page with this fingerprint; null: the page as this slice first sees it. */
  baseline: string | null;
  settleMs: number;
  /** A check at most this often after mutations. */
  minGapMs: number;
  /** The fallback polling interval: first, and at most (it grows by half each time). */
  pollMs: [number, number];
}

export interface PageWait {
  /** Index in `until` of the condition that holds (never a url_matches one), or null. */
  met: number | null;
  /** The fingerprint page_changed compares against (the baseline given, or the page when the slice began). */
  fingerprint: string;
}

/** How often the page is checked: at most every MIN_GAP_MS after mutations, else polled from POLL_MS[0] up to POLL_MS[1]. */
export const WAIT_MIN_GAP_MS = 250;
export const WAIT_POLL_MS: [number, number] = [500, 5000];

/**
 * Page function (self-contained, plain ES2020: serialized with Function.prototype.toString for Runtime.evaluate,
 * and passed to chrome.scripting). A slice left running in the page by an earlier call (its answer was not waited
 * for) is stopped first, so observers never pile up.
 */
export function waitInPage(a: PageWaitArgs): Promise<PageResult<PageWait>> {
  var KEY = "__noaWait";
  var w = window as unknown as Record<string, unknown>;
  var previous = w[KEY];
  if (typeof previous === "function") (previous as () => void)();

  var norm = function (s: string) {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  };
  var textOf = function (el: Element) {
    var t = (el as HTMLElement).innerText;
    return typeof t === "string" ? t : el.textContent || "";
  };
  var fingerprint = function () {
    var s = location.href + "\n" + norm(document.body ? textOf(document.body) : "");
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(36) + "." + s.length;
  };
  var select = function (selector: string): Element[] {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  };
  for (var c = 0; c < a.until.length; c++) {
    var sel = a.until[c]!.selector;
    if (!sel) continue;
    try {
      document.querySelector(sel);
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'selector "' + sel + '" is not a valid CSS selector' } as PageResult<PageWait>);
    }
  }
  var hasText = function (cond: WaitCondition) {
    var needle = norm(cond.text || "");
    var scopes = cond.selector ? select(cond.selector) : document.body ? [document.body] : [];
    return scopes.some(function (el) {
      return norm(textOf(el)).indexOf(needle) >= 0;
    });
  };
  var visible = function (el: Element) {
    if (!el.getClientRects().length) return false;
    var st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  var disabled = function (el: Element) {
    return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true" || !!el.closest("fieldset[disabled]");
  };
  var nameOf = function (el: Element) {
    return norm(el.getAttribute("aria-label") || textOf(el) || (el as HTMLInputElement).value || el.getAttribute("placeholder") || el.getAttribute("title") || "");
  };
  // The elements a label names: controls whose name is the label, else the innermost ones whose name contains it.
  var labelled = function (label: string) {
    var all = select("a,button,input,select,textarea,summary,label,[role],[aria-label],[title],[data-testid]");
    var exact = all.filter(function (el) {
      return nameOf(el) === label;
    });
    if (exact.length) return exact;
    var partial = all.filter(function (el) {
      return nameOf(el).indexOf(label) >= 0;
    });
    return partial.filter(function (el) {
      return !partial.some(function (other) {
        return other !== el && el.contains(other);
      });
    });
  };
  var elementIs = function (cond: WaitCondition) {
    var els = cond.selector ? select(cond.selector) : labelled(norm(cond.text || ""));
    var shown = els.filter(visible);
    var state = cond.state || "visible";
    if (state === "hidden") return shown.length === 0;
    if (state === "enabled")
      return shown.some(function (el) {
        return !disabled(el);
      });
    if (state === "disabled") return shown.some(disabled);
    return shown.length > 0;
  };

  var base = a.baseline || fingerprint();
  var startHref = location.href;
  var lastChange = Date.now();
  var watchesSettle = a.until.some(function (x) {
    return x.kind === "page_changed";
  });
  var holds = function (cond: WaitCondition) {
    switch (cond.kind) {
      case "text_appears":
        return hasText(cond);
      case "text_gone":
        return !hasText(cond);
      case "element":
        return elementIs(cond);
      case "page_changed":
        return Date.now() - lastChange >= a.settleMs && fingerprint() !== base;
      default:
        return false;
    }
  };

  return new Promise(function (resolve) {
    var done = false;
    var observer: MutationObserver | null = null;
    var endTimer: ReturnType<typeof setTimeout> | undefined;
    var pollTimer: ReturnType<typeof setTimeout> | undefined;
    var gapTimer: ReturnType<typeof setTimeout> | undefined;
    var settleTimer: ReturnType<typeof setTimeout> | undefined;
    var lastCheck = 0;
    var finish = function (met: number | null) {
      if (done) return;
      done = true;
      if (observer) observer.disconnect();
      clearTimeout(endTimer);
      clearTimeout(pollTimer);
      clearTimeout(gapTimer);
      clearTimeout(settleTimer);
      if (w[KEY] === stop) delete w[KEY];
      resolve({ ok: true, value: { met: met, fingerprint: base } });
    };
    var stop = function () {
      finish(null);
    };
    w[KEY] = stop;
    var check = function () {
      if (done) return;
      lastCheck = Date.now();
      // The driver checks url_matches (and a new page) from the tab.
      if (location.href !== startHref) return finish(null);
      for (var i = 0; i < a.until.length; i++) if (holds(a.until[i]!)) return finish(i);
    };
    var soon = function () {
      if (done || gapTimer !== undefined) return;
      gapTimer = setTimeout(function () {
        gapTimer = undefined;
        check();
      }, Math.max(0, lastCheck + a.minGapMs - Date.now()));
    };
    observer = new MutationObserver(function () {
      lastChange = Date.now();
      soon();
      if (watchesSettle) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(check, a.settleMs + 20);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    var every = a.pollMs[0];
    var poll = function () {
      check();
      every = Math.min(every * 1.5, a.pollMs[1]);
      if (!done) pollTimer = setTimeout(poll, every);
    };
    endTimer = setTimeout(stop, a.timeoutMs);
    check();
    if (!done) pollTimer = setTimeout(poll, every);
  });
}
