/**
 * The overlay on a page the agent drives: a soft glow around the viewport and a small pill at the top ("Noa
 * is working" with Stop, or "Noa needs you" with Open). It lives in a closed shadow root on an element of its
 * own (<noa-control>) outside the page's body, so page CSS cannot change it and it cannot change the page;
 * only the pill takes the pointer. It is put there with chrome.scripting (the top frame, the extension's isolated
 * world), the same way with or without the debugger, and only in tabs the agent controls.
 *
 * The agent never sees it: the page's text is read from its body and its elements are the body's controls, and the
 * driver hides it while it takes a screenshot and hides the pill while it clicks, types or scrolls (hiddenDuring).
 */
import { errorMessage } from "@noa/shared";

export type IndicatorVariant = "working" | "needs-you";

/** What the pill's button asks the background for (a runtime message from the page, see background.ts). */
export const INDICATOR_MESSAGE = { stop: "control.stop", open: "control.open" } as const;
export type IndicatorMessage = { type: (typeof INDICATOR_MESSAGE)[keyof typeof INDICATOR_MESSAGE] };

export function isIndicatorMessage(msg: unknown): msg is IndicatorMessage {
  const type = (msg as { type?: unknown } | null)?.type;
  return type === INDICATOR_MESSAGE.stop || type === INDICATOR_MESSAGE.open;
}

/** The overlay's element name: the one element it adds to the page. */
export const INDICATOR_TAG = "noa-control";

/** What the driver hides around a browser call: everything (a screenshot) or the pill (input at a point). */
export type HiddenPart = "all" | "pill";

/**
 * Shows the overlay (or changes its variant). Runs in the page through chrome.scripting: self-contained, plain
 * ES2020, everything it needs comes as arguments. The shadow root is closed; the isolated world keeps the only
 * reference to it.
 */
export function showIndicatorInPage(tag: string, variant: IndicatorVariant, messages: { stop: string; open: string }): boolean {
  var w = window as unknown as { __noaControl?: { host: HTMLElement; root: ShadowRoot } };
  var held = w.__noaControl;
  if (!held || !held.host.isConnected) {
    var host = document.createElement(tag);
    var root = host.attachShadow({ mode: "closed" });
    held = w.__noaControl = { host: host, root: root };
    (document.documentElement || document).appendChild(host);
  }
  if (held.host.getAttribute("data-variant") === variant) return true;
  held.host.setAttribute("data-variant", variant);
  var working = variant === "working";
  var accent = working ? "79, 70, 229" : "234, 160, 0";
  var css =
    ":host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;contain:strict!important}" +
    ":host([hidden]){display:none!important}" +
    ":host([data-busy]) .pill{visibility:hidden}" +
    ".glow{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px rgba(" + accent + ",.85),inset 0 0 28px 6px rgba(" + accent + ",.35);animation:breathe 2.4s ease-in-out infinite}" +
    "@keyframes breathe{0%,100%{opacity:.55}50%{opacity:1}}" +
    ".pill{position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:calc(100% - 32px);box-sizing:border-box;" +
    "padding:5px 6px 5px 12px;border-radius:999px;background:#1e1b3a;color:#fff;font:500 13px/18px system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.28),0 0 0 1px rgba(" + accent + ",.6);pointer-events:auto;white-space:nowrap;user-select:none}" +
    ".dot{width:8px;height:8px;border-radius:50%;background:rgb(" + accent + ");flex:none;animation:breathe 1.2s ease-in-out infinite}" +
    ".text{overflow:hidden;text-overflow:ellipsis}" +
    "button{all:unset;cursor:pointer;padding:2px 10px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font:600 12px/18px system-ui,-apple-system,'Segoe UI',sans-serif}" +
    "button:hover{background:rgba(255,255,255,.26)}" +
    "button:focus-visible{outline:2px solid rgb(" + accent + ");outline-offset:1px}" +
    "@media (prefers-reduced-motion:reduce){.glow,.dot{animation:none}.glow{opacity:.8}}";
  var style = document.createElement("style");
  style.textContent = css;
  var glow = document.createElement("div");
  glow.className = "glow";
  var pill = document.createElement("div");
  pill.className = "pill";
  pill.setAttribute("role", "status");
  var dot = document.createElement("span");
  dot.className = "dot";
  var text = document.createElement("span");
  text.className = "text";
  text.textContent = working ? "Noa is working" : "Noa needs you";
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
  pill.append(dot, text, button);
  held.root.replaceChildren(style, glow, pill);
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

  constructor(private readonly deps: { inject?: Inject; log?(message: string): void } = {}) {}

  private get inject(): Inject {
    return this.deps.inject ?? inTopFrame;
  }

  /** Shows the overlay in the tab (again after a navigation: the new page has none). */
  async show(tabId: number, variant: IndicatorVariant): Promise<void> {
    this.shown.set(tabId, variant);
    await this.run(tabId, showIndicatorInPage, [INDICATOR_TAG, variant, INDICATOR_MESSAGE]);
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

  /** Runs `fn` (a browser call) with the overlay, or its pill, hidden in that tab; nothing to hide: just runs it. */
  async hiddenDuring<T>(tabId: number, part: HiddenPart, fn: () => Promise<T>): Promise<T> {
    if (!this.shown.has(tabId)) return fn();
    await this.run(tabId, hideIndicatorInPage, [part]);
    try {
      return await fn();
    } finally {
      await this.run(tabId, hideIndicatorInPage, [null]);
    }
  }

  private async run(tabId: number, func: (...args: never[]) => unknown, args: unknown[]): Promise<void> {
    try {
      await this.inject(tabId, func, args);
    } catch (err) {
      this.deps.log?.(`overlay in tab ${tabId}: ${errorMessage(err)}`);
    }
  }
}

/** The service worker's overlays: the control indicator shows them, every driver hides them around its calls. */
export const pageIndicators = new PageIndicators();
