/**
 * Noa Browser's tab bridge: how the Noa agent built into Noa Browser drives the browser's own tabs.
 *
 * Noa Browser's host process (apps/browser) owns the browser's DevTools protocol connection
 * (--remote-debugging-pipe). It serves the tab bridge on a loopback WebSocket and, before the browser
 * starts, writes its address and a random token into Noa's own folder (NOA_BROWSER_HOST_FILE, next to
 * manifest.json; not web-accessible). The agent's Cdp then sends its commands there (apps/extension/src/noa-browser/host-debugger.ts)
 * instead of through chrome.debugger: no "started debugging this browser" bar, nothing the user can
 * cancel by mistake, the same commands. See docs/BROWSER.md.
 */

/** The file in Noa's extension folder holding the bridge's NoaBrowserHost (absent outside Noa Browser). */
export const NOA_BROWSER_HOST_FILE = "noa-browser.json";

/** What the host tells the extension. */
export interface NoaBrowserHost {
  /** ws://127.0.0.1:<port>/ */
  url: string;
  /** Sent in the hello message; the bridge closes a connection without it. */
  token: string;
  /** Noa Browser's version (apps/browser/package.json). */
  version: string;
}

/** Messages the extension sends. `id` pairs a request with its answer. */
export type BridgeRequest =
  | { id: number; op: "hello"; token: string }
  | { id: number; op: "attach"; tabId: number; targetId: string }
  | { id: number; op: "detach"; tabId: number }
  | { id: number; op: "send"; tabId: number; method: string; params?: Record<string, unknown> };

/** The bridge's answers, and its events (no id). */
export type BridgeMessage =
  | { id: number; result: unknown }
  | { id: number; error: string }
  /** The tab's CDP session ended: the tab closed or crashed ("target_closed"), or went to a page the agent may not control. */
  | { event: "detached"; tabId: number; reason: string }
  /** A CDP event of an attached tab (only BRIDGE_FORWARDED_EVENTS), as chrome.debugger.onEvent gives it. */
  | { event: "cdp"; tabId: number; method: string; params: Record<string, unknown> };

/** The CDP events the bridge passes on: the ones the agent reads (its tabs' JavaScript dialogs, cdp.ts). */
export const BRIDGE_FORWARDED_EVENTS: ReadonlySet<string> = new Set(["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"]);

/**
 * CDP domains a tab session may use through the bridge: what a debugger extension may do in a tab, never
 * the browser-wide domains (Browser, Target, Storage, SystemInfo, ...) that reach past the tab.
 */
export const BRIDGE_ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  "Accessibility",
  "CSS",
  "DOM",
  "DOMSnapshot",
  "Emulation",
  "Input",
  "Log",
  "Network",
  "Overlay",
  "Page",
  "Runtime",
]);

/** Largest message either side accepts (a full-page screenshot is a few MB of base64). */
export const BRIDGE_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** A BridgeRequest from untrusted JSON, or null. */
export function parseBridgeRequest(text: string): BridgeRequest | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  if (!Number.isSafeInteger(r.id)) return null;
  const tabOk = Number.isSafeInteger(r.tabId);
  switch (r.op) {
    case "hello":
      return typeof r.token === "string" ? (r as BridgeRequest) : null;
    case "attach":
      return tabOk && typeof r.targetId === "string" && r.targetId.length > 0 ? (r as BridgeRequest) : null;
    case "detach":
      return tabOk ? (r as BridgeRequest) : null;
    case "send":
      return tabOk && typeof r.method === "string" && /^[A-Z][A-Za-z]+\.[a-zA-Z]+$/.test(r.method) && (r.params === undefined || (typeof r.params === "object" && r.params !== null && !Array.isArray(r.params)))
        ? (r as BridgeRequest)
        : null;
    default:
      return null;
  }
}
