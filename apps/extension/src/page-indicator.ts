/**
 * The overlay on a page the agent drives: a soft glow around the viewport and a small pill at the top ("Noa
 * is working" with Stop, or "Noa needs you" with Open; "Limited" in limited mode), whose popover says what the job
 * is and what the agent does there now (IndicatorDetails). It lives in a closed shadow root on an element of its
 * own (<noa-control>) outside the page's body, so page CSS cannot change it and it cannot change the page;
 * only the pill takes the pointer. It is put there with chrome.scripting (the top frame, the extension's isolated
 * world), the same way with or without the debugger, and only in tabs the agent controls.
 *
 * The agent never sees it: the page's text is read from its body and its elements are the body's controls, and the
 * driver hides it while it takes a screenshot and hides the pill while it clicks, types or scrolls (hiddenDuring).
 */
import { errorMessage } from "@noa/shared";
import { PAGE_MARKS } from "./driver-common.js";

export type IndicatorVariant = "working" | "needs-you";

/** What the pill's button asks the background for (a runtime message from the page, see background.ts). */
export const INDICATOR_MESSAGE = { stop: "control.stop", open: "control.open" } as const;
export type IndicatorMessage = { type: (typeof INDICATOR_MESSAGE)[keyof typeof INDICATOR_MESSAGE] };

export function isIndicatorMessage(msg: unknown): msg is IndicatorMessage {
  const type = (msg as { type?: unknown } | null)?.type;
  return type === INDICATOR_MESSAGE.stop || type === INDICATOR_MESSAGE.open;
}

/** The overlay's element name: the one element it adds to the page. */
export const INDICATOR_TAG = PAGE_MARKS.overlay;

/** What the driver hides around a browser call: everything (a screenshot) or the pill (input at a point). */
export type HiddenPart = "all" | "pill";

/**
 * What the pill tells on hover or keyboard focus, in its popover (control-indicator.ts tabDetails words it): the job
 * (its chat's title), what the agent does there now, and why the tab is in limited mode. "": that line is left out;
 * with none, there is no popover. limited also puts a "Limited" mark on the pill.
 */
export interface IndicatorDetails {
  job: string;
  now: string;
  limited: string;
}

export const NO_DETAILS: IndicatorDetails = { job: "", now: "", limited: "" };

/**
 * Shows the overlay (or changes its variant and details). Runs in the page through chrome.scripting: self-contained,
 * plain ES2020, everything it needs comes as arguments. The shadow root is closed; the isolated world keeps the only
 * reference to it. The overlay is built again only for another variant; new details change its text in place (a
 * popover the user reads stays open).
 */
export function showIndicatorInPage(tag: string, variant: IndicatorVariant, messages: { stop: string; open: string }, details: IndicatorDetails): boolean {
  var w = window as unknown as { __noaControl?: { host: HTMLElement; root: ShadowRoot } };
  var held = w.__noaControl;
  if (!held || !held.host.isConnected) {
    var host = document.createElement(tag);
    var root = host.attachShadow({ mode: "closed" });
    held = w.__noaControl = { host: host, root: root };
    (document.documentElement || document).appendChild(host);
  }
  var shadow = held.root;
  if (held.host.getAttribute("data-variant") !== variant) {
    held.host.setAttribute("data-variant", variant);
    var working = variant === "working";
    var accent = working ? "79, 70, 229" : "234, 160, 0";
    var css =
      ":host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;contain:strict!important}" +
      ":host([hidden]){display:none!important}" +
      ":host([data-busy]) .bar{visibility:hidden}" +
      ".glow{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px rgba(" + accent + ",.85),inset 0 0 28px 6px rgba(" + accent + ",.35);animation:breathe 2.4s ease-in-out infinite}" +
      "@keyframes breathe{0%,100%{opacity:.55}50%{opacity:1}}" +
      ".bar{position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;max-width:calc(100% - 32px);pointer-events:auto}" +
      ".pill{display:flex;align-items:center;gap:8px;max-width:100%;box-sizing:border-box;" +
      "padding:5px 6px 5px 12px;border-radius:999px;background:#1e1b3a;color:#fff;font:500 13px/18px system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0;" +
      "box-shadow:0 2px 12px rgba(0,0,0,.28),0 0 0 1px rgba(" + accent + ",.6);white-space:nowrap;user-select:none}" +
      ".dot{width:8px;height:8px;border-radius:50%;background:rgb(" + accent + ");flex:none;animation:breathe 1.2s ease-in-out infinite}" +
      ".text{overflow:hidden;text-overflow:ellipsis;border-radius:4px}" +
      ".text:focus-visible{outline:2px solid rgb(" + accent + ");outline-offset:2px}" +
      ".mark{flex:none;padding:0 7px;border-radius:999px;border:1px solid rgba(250,204,21,.5);background:rgba(250,204,21,.16);color:#fde68a;font:600 11px/16px system-ui,-apple-system,'Segoe UI',sans-serif}" +
      "button{all:unset;cursor:pointer;padding:2px 10px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font:600 12px/18px system-ui,-apple-system,'Segoe UI',sans-serif}" +
      "button:hover{background:rgba(255,255,255,.26)}" +
      "button:focus-visible{outline:2px solid rgb(" + accent + ");outline-offset:1px}" +
      ".pop{display:none;margin-top:6px;width:max-content;max-width:min(360px,100%);box-sizing:border-box;padding:9px 12px;border-radius:12px;" +
      "background:#1e1b3a;color:#fff;font:400 12px/17px system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0;text-align:left;white-space:normal;overflow-wrap:anywhere;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.32),0 0 0 1px rgba(" + accent + ",.6)}" +
      ".bar:hover .pop,.bar:focus-within .pop{display:block}" +
      ".bar[data-dismissed] .pop{display:none}" +
      ".job{font-weight:600;font-size:13px;line-height:18px}" +
      ".now{color:rgba(255,255,255,.78)}" +
      ".job+.now{margin-top:2px}" +
      ".limited{color:#fde68a}" +
      ".pop>:not([hidden])~.limited{margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.16)}" +
      "[hidden]{display:none!important}" +
      "@media (prefers-reduced-motion:reduce){.glow,.dot{animation:none}.glow{opacity:.8}}";
    var style = document.createElement("style");
    style.textContent = css;
    var glow = document.createElement("div");
    glow.className = "glow";
    var bar = document.createElement("div");
    bar.className = "bar";
    var pill = document.createElement("div");
    pill.className = "pill";
    pill.setAttribute("role", "status");
    var dot = document.createElement("span");
    dot.className = "dot";
    var text = document.createElement("span");
    text.className = "text";
    text.textContent = working ? "Noa is working" : "Noa needs you";
    var mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "Limited";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = working ? "Stop" : "Open";
    button.title = working ? "Stop what Noa is doing in this tab" : "Open Noa to see what it needs";
    var type = working ? messages.stop : messages.open;
    button.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      try {
        void chrome.runtime.sendMessage({ type: type }).catch(function () {
          /* the extension reloaded: nothing to stop here */
        });
      } catch (err) {
        /* the extension context is gone */
      }
    });
    pill.append(dot, text, mark, button);
    // The popover, under the pill: shown while the pointer is on either or focus is in them; Escape hides it until then.
    var pop = document.createElement("div");
    pop.className = "pop";
    pop.id = "noa-control-details";
    pop.setAttribute("role", "tooltip");
    ["job", "now", "limited"].forEach(function (name) {
      var line = document.createElement("div");
      line.className = name;
      pop.append(line);
    });
    bar.append(pill, pop);
    bar.addEventListener("keydown", function (e) {
      if (e.key === "Escape") bar.setAttribute("data-dismissed", "");
    });
    var undismiss = function () {
      bar.removeAttribute("data-dismissed");
    };
    bar.addEventListener("mouseleave", undismiss);
    bar.addEventListener("focusout", undismiss);
    shadow.replaceChildren(style, glow, bar);
  }
  var part = function (cls: string): HTMLElement {
    return shadow.querySelector("." + cls) as HTMLElement;
  };
  var any = false;
  (["job", "now", "limited"] as const).forEach(function (name) {
    var line = part(name);
    line.textContent = details[name];
    line.hidden = !details[name];
    if (details[name]) any = true;
  });
  part("mark").hidden = !details.limited;
  var popover = part("pop");
  popover.hidden = !any;
  // Keyboard users reach the details on the pill's text (the popover describes it).
  var label = part("text");
  if (any) {
    label.setAttribute("tabindex", "0");
    label.setAttribute("aria-describedby", popover.id);
  } else {
    label.removeAttribute("tabindex");
    label.removeAttribute("aria-describedby");
  }
  return true;
}

/** Removes the overlay. Runs in the page (see showIndicatorInPage). */
export function removeIndicatorInPage(): boolean {
  var w = window as unknown as { __noaControl?: { host: HTMLElement } };
  var held = w.__noaControl;
  if (held) held.host.remove();
  delete w.__noaControl;
  return true;
}

/**
 * Hides the overlay ("all") or its pill ("pill"), or shows it again (null). Hiding resolves once the page drew
 * without it (a frame, or a moment in a tab Chrome does not draw). Runs in the page (see showIndicatorInPage).
 */
export function hideIndicatorInPage(part: HiddenPart | null): Promise<boolean> {
  var held = (window as unknown as { __noaControl?: { host: HTMLElement } }).__noaControl;
  if (!held) return Promise.resolve(false);
  held.host.toggleAttribute("hidden", part === "all");
  held.host.toggleAttribute("data-busy", part === "pill");
  if (part === null) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var done = function () {
      resolve(true);
    };
    requestAnimationFrame(function () {
      requestAnimationFrame(done);
    });
    setTimeout(done, 60);
  });
}

type Inject = (tabId: number, func: (...args: never[]) => unknown, args: unknown[]) => Promise<unknown>;

const inTopFrame: Inject = async (tabId, func, args) => {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: func as (...a: unknown[]) => unknown, args });
  return res?.result;
};

/**
 * The overlays shown in tabs (by this service worker; the control indicator shows them again after a restart). Every
 * call is best effort: a page Chrome keeps extensions out of, or one that is navigating, simply has none.
 */
export class PageIndicators {
  private readonly shown = new Map<number, IndicatorVariant>();
  /** Per tab, the last page script started: the next one runs after it, so they reach the page in order. */
  private readonly queue = new Map<number, Promise<void>>();

  constructor(private readonly deps: { inject?: Inject; log?(message: string): void } = {}) {}

  private get inject(): Inject {
    return this.deps.inject ?? inTopFrame;
  }

  /** Shows the overlay in the tab (again after a navigation: the new page has none), or changes what it says. */
  async show(tabId: number, variant: IndicatorVariant, details: IndicatorDetails = NO_DETAILS): Promise<void> {
    this.shown.set(tabId, variant);
    await this.run(tabId, showIndicatorInPage, [INDICATOR_TAG, variant, INDICATOR_MESSAGE, details]);
  }

  async remove(tabId: number): Promise<void> {
    if (!this.shown.delete(tabId)) return;
    await this.run(tabId, removeIndicatorInPage, []);
  }

  /** The tab closed. */
  tabRemoved(tabId: number): void {
    this.shown.delete(tabId);
  }

  has(tabId: number): boolean {
    return this.shown.has(tabId);
  }

  /**
   * Runs `fn` (a browser call) with the overlay, or its pill, hidden in that tab; nothing to hide: just runs it. The
   * call does not wait for the overlay to come back: a dialog the call opened (a click on "Delete" that asks
   * "Are you sure?") freezes the page, and a page script waits until someone answers it.
   */
  async hiddenDuring<T>(tabId: number, part: HiddenPart, fn: () => Promise<T>): Promise<T> {
    if (!this.shown.has(tabId)) return fn();
    await this.run(tabId, hideIndicatorInPage, [part]);
    try {
      return await fn();
    } finally {
      void this.run(tabId, hideIndicatorInPage, [null]);
    }
  }

  private run(tabId: number, func: (...args: never[]) => unknown, args: unknown[]): Promise<void> {
    const next = (this.queue.get(tabId) ?? Promise.resolve()).then(
      () => this.inject(tabId, func, args).then(() => undefined),
    ).catch((err: unknown) => this.deps.log?.(`overlay in tab ${tabId}: ${errorMessage(err)}`));
    this.queue.set(tabId, next);
    void next.then(() => {
      if (this.queue.get(tabId) === next) this.queue.delete(tabId);
    });
    return next;
  }
}

/** The service worker's overlays: the control indicator shows them, every driver hides them around its calls. */
export const pageIndicators = new PageIndicators();
