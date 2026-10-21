/**
 * Settings on a paired phone: the extension's own options page (options/), in a frame over the phone's side panel
 * (apps/dashboard/src/phone/main.ts), working on the computer's settings. The dashboard's build makes its page,
 * /phone-settings.html, from static/options.html. The frame reads its parent's link to the computer.
 */
import { PHONE_BRIDGE_GLOBAL, type DesktopInfo, type PhonePanelBridge } from "@noa/shared/phone-link/panel-bridge";
import { HELPER_INSTALL_URL } from "@noa/shared";
import type { UiResponse } from "../ui-protocol.js";
import { phoneChrome } from "./chrome-shim.js";

const bridge = (parent as unknown as Record<string, unknown>)[PHONE_BRIDGE_GLOBAL] as PhonePanelBridge | undefined;
if (!bridge) throw new Error("Settings opened outside the phone page");
const res = (await bridge.request({ type: "phone.info" })) as UiResponse<DesktopInfo>;
if (!res.ok) throw new Error(res.error);
const desktop = res.data;
(globalThis as { chrome?: unknown }).chrome = phoneChrome(bridge, location.origin, desktop);
// The helper's install steps are for the computer's system and its extension's helper, not the phone's.
Object.defineProperty(navigator, "userAgent", { get: () => desktop.userAgent, configurable: true });
(globalThis as { __noaHelperCode?: string }).__noaHelperCode = desktop.helperCode;
// Whether the site has the helper's installer: the computer asks (the phone's browser may not, across sites).
const pageFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (init?.method !== "HEAD" || !url.startsWith(HELPER_INSTALL_URL.slice(0, HELPER_INSTALL_URL.lastIndexOf("/") + 1))) return pageFetch(input, init);
  const r = (await bridge.request({ type: "phone.installer", url })) as UiResponse<{ status: number }>;
  if (!r.ok) throw new Error(r.error);
  return new Response(null, { status: r.data.status });
};

await import("../options/options.js");
