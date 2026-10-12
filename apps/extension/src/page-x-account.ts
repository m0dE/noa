/**
 * browser.clickXAccountEntry in the page: switch_x_account's pick in X's open
 * account menu. X re-renders that menu 0.3-1.6 s after it opens, from the
 * personal "Switch to @handle" cells to the delegate-only "Act as" cells, and
 * the re-render replaces its nodes. A debugger mouse press waits for a frame
 * before it lands (about a second in a background tab), so it can land on
 * whatever took the entry's place. Here the entry is found and clicked in one
 * synchronous step of the page, so nothing can change in between.
 *
 * The one page function below serves both drivers (serialized with
 * Function.prototype.toString, like page-input.ts), in four modes:
 * - "click": finds the entry and calls its click(), in the same task.
 * - "find": finds it and leaves it for the debugger (FOUND_KEY), which turns
 *   it into a node id for a real press (cdp-actions.ts pressXAccountEntry).
 * - "arm" (called on that node, `this`): right before the press, checks the
 *   node is still the entry X shows, and arms a guard that stops every mouse
 *   event whose target is not inside it, so a press never reaches anything
 *   else, even when X replaces the node between this check and the press.
 * - "disarm": removes the guard; says whether the node got the click (or
 *   that the guard's document is gone: the click navigated).
 *
 * What it may click (refusal(), checked right before any click or press,
 * whatever picked the element): a visible button with testid UserCell whose
 * accessible name is exactly "Switch to @handle" for this handle, inside the
 * account menu (the popup holding X's AccountSwitcher_* items, never the page
 * around it), with nothing about it naming a delegate. Never "Act as".
 */
import type { XAccountEntryClick } from "@noa/shared";
import type { PageResult } from "./scroll-probe.js";

export type XEntryMode = "click" | "find" | "arm" | "disarm";

/** "find": the entry was found and left for the debugger at FOUND_KEY. */
export interface XEntryFound {
  found: true;
}
/** "arm": where to press (the entry's center, in the viewport). */
export interface XEntryPoint {
  x: number;
  y: number;
}
/**
 * "disarm": whether the entry got the click, and how many events aimed elsewhere the guard stopped. armed false: no
 * guard in this document, so the one it was armed in is gone (the entry's click navigated: nothing else got through).
 */
export interface XEntryPressed {
  armed: boolean;
  hit: boolean;
  stopped: number;
}

export type XEntryStep = XAccountEntryClick | XEntryFound | XEntryPoint | XEntryPressed;

/** Where "find" leaves the entry for the debugger (a global symbol: Runtime.evaluate reads it back as a node). */
export const FOUND_KEY = "noa.xAccountEntry";

/** A handle as X spells one: letters, digits and _, at most 15, with or without the "@". Throws otherwise. */
export function xHandleParam(handle: unknown): string {
  const h = typeof handle === "string" ? handle.trim() : "";
  if (!/^@?[A-Za-z0-9_]{1,15}$/.test(h)) throw new Error(`clickXAccountEntry needs an X handle like @name, got ${JSON.stringify(handle)}`);
  return h.startsWith("@") ? h : `@${h}`;
}

/**
 * Page function (self-contained, plain ES2020). `node`: the entry "arm" checks (Runtime.callFunctionOn passes it as
 * `this`, and it is given here too). waitMs: "click" and "find" wait this long for the menu to show its accounts
 * (a MutationObserver, so a background tab's throttled timers do not slow it down), then answer.
 */
export function xAccountEntryInPage(handle: string, waitMs: number, mode: XEntryMode, node?: Element | null): Promise<PageResult<XEntryStep>> {
  var GUARD_KEY = Symbol.for("noa.xAccountEntryGuard");
  var FOUND = Symbol.for("noa.xAccountEntry");
  var win = window as unknown as Record<symbol, unknown>;
  var want = handle.replace(/^@/, "").toLowerCase();
  var DELEGATE = /\bact as\b|delegate/i;
  var PERSONAL = /^switch to @([A-Za-z0-9_]{1,15})$/i;
  var norm = function (s: string | null) {
    return (s || "").replace(/\s+/g, " ").trim();
  };
  var done = function (value: XEntryStep): Promise<PageResult<XEntryStep>> {
    return Promise.resolve({ ok: true, value: value } as PageResult<XEntryStep>);
  };
  var notClicked = function (reason: string): Promise<PageResult<XEntryStep>> {
    return done({ clicked: false, reason: reason });
  };

  if (mode === "disarm") {
    var guard = win[GUARD_KEY] as { off: () => void; hit: boolean; stopped: number } | undefined;
    if (!guard) return done({ armed: false, hit: false, stopped: 0 });
    guard.off();
    delete win[GUARD_KEY];
    return done({ armed: true, hit: guard.hit, stopped: guard.stopped });
  }

  var visible = function (el: Element) {
    if (!el.isConnected || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  var isButton = function (el: Element) {
    return el.tagName === "BUTTON" || /^(button|menuitem)$/.test(el.getAttribute("role") || "");
  };
  /** The account menu: the smallest box around one of X's AccountSwitcher_* items that holds account cells, and not the page around it. */
  var menuRoot = function (): Element | null {
    var items = Array.prototype.slice.call(document.querySelectorAll('[data-testid^="AccountSwitcher_"]')) as Element[];
    for (var i = 0; i < items.length; i++) {
      if (!visible(items[i]!)) continue;
      for (var box = items[i]!.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
        if (box.querySelector('[data-testid="SideNav_AccountSwitcher_Button"],[data-testid="primaryColumn"],main')) break;
        if (box.querySelector('[data-testid="UserCell"]')) return box;
      }
    }
    return null;
  };
  var cellsIn = function (menu: Element) {
    return (Array.prototype.slice.call(menu.querySelectorAll('[data-testid="UserCell"]')) as Element[]).filter(function (c) {
      return visible(c) && isButton(c);
    });
  };
  /** Why this element must not be clicked or pressed; "" when it is the target's personal entry in the open menu. */
  var refusal = function (el: Element, menu: Element | null): string {
    var label = norm(el.getAttribute("aria-label"));
    var text = norm(el.textContent);
    if (el.getAttribute("data-testid") !== "UserCell" || !isButton(el)) return "it is not an account cell of the menu";
    if (DELEGATE.test(label) || DELEGATE.test(text)) return 'it is a delegate account ("Act as")';
    var m = PERSONAL.exec(label);
    if (!m || m[1]!.toLowerCase() !== want) return 'it is not the "Switch to @' + want + '" entry';
    if (!menu || !menu.contains(el)) return "it is not inside the account menu";
    if (!visible(el)) return "it is not shown";
    var marked = el.querySelectorAll('[href*="delegate" i],[data-testid*="delegate" i],[data-testid$="-follow"]');
    if (marked.length) return "it holds a delegate or follow control";
    return "";
  };
  /** The target's entry in the menu as the page shows it now, or why there is none. */
  var look = function (): { el: Element; menu: Element } | { reason: string; open: boolean } {
    var menu = menuRoot();
    if (!menu) return { reason: "the account menu is not open", open: false };
    var cells = cellsIn(menu);
    if (!cells.length) return { reason: "the account menu shows no accounts yet", open: false };
    for (var i = 0; i < cells.length; i++) if (!refusal(cells[i]!, menu)) return { el: cells[i]!, menu: menu };
    var delegates = cells.filter(function (c) {
      return DELEGATE.test(norm(c.getAttribute("aria-label")) + " " + norm(c.textContent));
    });
    if (delegates.length === cells.length) return { reason: 'the account menu shows only delegate accounts ("Act as"), not @' + want, open: true };
    return { reason: "the account menu does not list @" + want, open: true };
  };

  if (mode === "arm") {
    var entry = node || null;
    var now = look();
    if (!entry || !("el" in now) || now.el !== entry) return notClicked("not found: X replaced the @" + want + " entry before the press");
    var why = refusal(entry, now.menu);
    if (why) return Promise.resolve({ ok: false, error: "refused to press it: " + why } as PageResult<XEntryStep>);
    entry.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    var r = entry.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    var top = document.elementFromPoint(x, y);
    if (!top || !entry.contains(top)) return notClicked("something covers the @" + want + " entry");
    var previous = win[GUARD_KEY] as { off: () => void } | undefined;
    if (previous) previous.off();
    var target = entry;
    var state = { hit: false, stopped: 0, expired: false, off: function () {} };
    var TYPES = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "dblclick", "contextmenu"];
    var stop = function (e: Event) {
      if (!state.expired && e.target instanceof Node && target.contains(e.target)) {
        if (e.type === "click") state.hit = true;
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      state.stopped++;
    };
    TYPES.forEach(function (t) {
      window.addEventListener(t, stop, true);
    });
    // A press this late is not the one checked: from then on nothing gets through, the entry neither, until "disarm".
    // Only a caller that never disarms (it crashed) has the guard go by itself, so the page takes clicks again.
    var expiry = setTimeout(function () {
      state.expired = true;
    }, 30000);
    var removal = setTimeout(function () {
      state.off();
    }, 120000);
    state.off = function () {
      clearTimeout(expiry);
      clearTimeout(removal);
      TYPES.forEach(function (t) {
        window.removeEventListener(t, stop, true);
      });
    };
    win[GUARD_KEY] = state;
    return done({ x: x, y: y });
  }

  // "click" and "find": act on the menu as it is at that instant, the moment it shows its accounts.
  var act = function (): Promise<PageResult<XEntryStep>> | null {
    var now = look();
    if (!("el" in now)) return now.open ? notClicked(now.reason) : null;
    var why = refusal(now.el, now.menu);
    if (why) return Promise.resolve({ ok: false, error: "refused to click it: " + why } as PageResult<XEntryStep>);
    if (mode === "find") {
      win[FOUND] = now.el;
      return done({ found: true });
    }
    (now.el as HTMLElement).click();
    return done({ clicked: true });
  };
  var first = act();
  if (first) return first;
  if (waitMs <= 0) {
    var closed = look();
    return notClicked("reason" in closed ? closed.reason : "the account menu is not open");
  }
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function (out: Promise<PageResult<XEntryStep>>) {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      out.then(resolve);
    };
    var observer = new MutationObserver(function () {
      var out = act();
      if (out) finish(out);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-label"] });
    var timer = setTimeout(function () {
      var out = act();
      finish(out || notClicked("the account menu did not show its accounts within " + waitMs + " ms"));
    }, waitMs);
  });
}
