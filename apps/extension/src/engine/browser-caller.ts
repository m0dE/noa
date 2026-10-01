import { errorMessage, registrableDomain, sameSite, siteHost, traceStart, traceText, type BrowserCallContext, type BrowserMethod, type BrowserMethods, type TraceValue } from "@noa/shared";
import type { BrowserCaller } from "@noa/core";
import type { HelperPeer } from "../helper-link.js";

/** The driver method behind each browser.* method: "browser.readPage" -> readPage. */
type DriverMethodOf<M> = M extends `browser.${infer Name}` ? Name : never;

/** What performs the browser.* methods (Driver): one method per browser.* method, named after it. */
export type DriverLike = {
  [M in BrowserMethod as DriverMethodOf<M>]: (params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
};

export interface VaultLike {
  getCredential(site: string): Promise<BrowserMethods["vault.getCredential"]["result"]>;
}

/** Makes pictures for generate_image (engine/image-generator.ts, bound to the calling session). */
export interface ImagesLike {
  generate(params: BrowserMethods["media.generateImage"]["params"]): Promise<BrowserMethods["media.generateImage"]["result"]>;
}

interface Targets {
  driver: DriverLike;
  vault: VaultLike;
  images?: ImagesLike | undefined;
}

/** Every browser.*, vault.* and media.* method, performed by the driver, the vault and the image maker. */
const METHODS: { [M in BrowserMethod]: (t: Targets, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]> } = {
  "browser.navigate": ({ driver }, p) => driver.navigate(p),
  "browser.readPage": ({ driver }, p) => driver.readPage(p ?? {}),
  "browser.screenshot": ({ driver }, p) => driver.screenshot(p),
  "browser.click": ({ driver }, p) => driver.click(p),
  "browser.type": ({ driver }, p) => driver.type(p),
  "browser.paste": ({ driver }, p) => driver.paste(p),
  "browser.pressKey": ({ driver }, p) => driver.pressKey(p),
  "browser.scroll": ({ driver }, p) => driver.scroll(p),
  "browser.upload": ({ driver }, p) => driver.upload(p),
  "browser.clickXAccountEntry": ({ driver }, p) => driver.clickXAccountEntry(p),
  "browser.currentUrl": ({ driver }, p) => driver.currentUrl(p),
  "browser.openTabs": ({ driver }, p) => driver.openTabs(p),
  "browser.switchTab": ({ driver }, p) => driver.switchTab(p),
  "browser.listTabs": ({ driver }, p) => driver.listTabs(p),
  "browser.closeTabs": ({ driver }, p) => driver.closeTabs(p),
  "browser.waitFor": ({ driver }, p) => driver.waitFor(p),
  "browser.handleDialog": ({ driver }, p) => driver.handleDialog(p),
  "vault.getCredential": ({ driver, vault }, p) => credentialForCurrentTab(driver, vault, p.site),
  "media.generateImage": async ({ images }, p) => {
    if (!images) throw new Error("Image generation is not available here.");
    return images.generate(p);
  },
};

/**
 * A saved login, only for the site of the tab the agent is on: whatever site the model names, a page cannot get
 * another site's password read out to it (a prompt injection on evil.test asking for bank.test's gets nothing).
 */
async function credentialForCurrentTab(driver: DriverLike, vault: VaultLike, site: string): Promise<BrowserMethods["vault.getCredential"]["result"]> {
  const { url } = await driver.currentUrl({});
  if (!sameSite(site, url)) {
    const host = siteHost(site);
    throw new Error(`Saved logins are given only for the site of the current tab (${registrableDomain(url) || "no site"}), and ${host} is not it. Open ${host}'s sign-in page in this tab first.`);
  }
  return vault.getCredential(site);
}

const BROWSER_METHODS = Object.keys(METHODS) as BrowserMethod[];

/** One method on these targets. TypeScript cannot call a table entry through a generic key, hence the one widening. */
function perform<M extends BrowserMethod>(t: Targets, method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> {
  const fn = METHODS[method] as (t: Targets, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
  return fn(t, params);
}

/** BrowserCaller for the in-extension (Claude API) brain and the post verifier. */
export function createBrowserCaller(driver: DriverLike, vault: VaultLike, images?: ImagesLike): BrowserCaller {
  return { call: (method, params) => perform({ driver, vault, images }, method, params) };
}

/**
 * Serves the browser methods to the helper (Claude Code brain via MCP). Each
 * call is served by the caller's session (BrowserCallContext.sessionId): the
 * tab of that session's slot. The session id is not passed on to the driver.
 */
export function registerBrowserHandlers(peer: HelperPeer, browserFor: (sessionId: string | undefined) => BrowserCaller): void {
  for (const method of BROWSER_METHODS) serve(peer, method, browserFor);
}

function serve<M extends BrowserMethod>(peer: HelperPeer, method: M, browserFor: (sessionId: string | undefined) => BrowserCaller): void {
  peer.handle(method, (params) => {
    const { sessionId, ...rest } = (params ?? {}) as BrowserMethods[M]["params"] & BrowserCallContext;
    return browserFor(typeof sessionId === "string" && sessionId ? sessionId : undefined).call(method, rest as BrowserMethods[M]["params"]);
  });
}

/** What a browser call's trace records: the method, its duration and what it returned (sizes, not content). */
export type BrowserCallTrace = (call: { method: BrowserMethod; t: number; ms: number; data: Record<string, TraceValue> }) => void;

/**
 * `inner` with every call timed for the trace: the method, how long it took,
 * which driver served it (the debugger, or the fallback), and the size of
 * what came back (a page snapshot's elements and text, a screenshot's KB);
 * never page content.
 */
export function tracedBrowser(inner: BrowserCaller, driverMode: () => "cdp" | "fallback", record: BrowserCallTrace): BrowserCaller {
  return {
    call: async (method, params) => {
      const span = traceStart();
      const data: Record<string, TraceValue> = {};
      try {
        const r = await inner.call(method, params);
        Object.assign(data, resultSize(method, r));
        return r;
      } catch (err) {
        data.error = traceText(errorMessage(err), 160);
        throw err;
      } finally {
        data.driver = driverMode();
        record({ method, t: span.t, ms: span.elapsed(), data });
      }
    },
  };
}

function resultSize(method: BrowserMethod, r: unknown): Record<string, TraceValue> {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  switch (method) {
    case "browser.readPage": {
      const els = Array.isArray(o.elements) ? (o.elements as { name?: unknown; text?: unknown }[]) : [];
      // Roughly what the snapshot carries: its elements' names and texts (the format adds a little).
      const chars = els.reduce((n, e) => n + (typeof e.name === "string" ? e.name.length : 0) + (typeof e.text === "string" ? e.text.length : 0), 0);
      return { elements: els.length, chars };
    }
    case "browser.screenshot":
      return typeof o.base64 === "string" ? { kb: Math.round((o.base64.length * 3) / 4 / 1024) } : {};
    case "browser.navigate":
      return typeof o.url === "string" ? { host: hostOf(o.url) } : {};
    case "browser.openTabs":
      return Array.isArray(o.tabs) ? { tabs: o.tabs.length } : {};
    case "media.generateImage":
      return typeof o.chargedCents === "number" ? { chargedCents: o.chargedCents } : {};
    default:
      return {};
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
