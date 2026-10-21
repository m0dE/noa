/**
 * The side panel on a paired phone (docs/MOBILE.md, "The phone"): the extension's own side panel (sidepanel/), the same
 * page with the same jobs list, Home | Scheduled, job pages and composer, working on the computer's jobs and browser.
 * The phone page (apps/dashboard/src/phone/main.ts) loads this bundle once it is paired, with the link to the computer
 * as `globalThis.__noaPhoneBridge`; the dashboard's build puts the panel's HTML (static/sidepanel.html) and styles
 * next to it.
 */
import { PHONE_BRIDGE_GLOBAL, type PhonePanelBridge } from "@noa/shared/phone-link/panel-bridge";
import { phoneChrome } from "./chrome-shim.js";

/** The body of static/sidepanel.html, without its script (the dashboard's build reads it). */
declare const __NOA_PANEL_HTML__: string;

const bridge = (globalThis as Record<string, unknown>)[PHONE_BRIDGE_GLOBAL] as PhonePanelBridge | undefined;
if (!bridge) throw new Error("The phone page did not give the side panel its link");
(globalThis as { chrome?: unknown }).chrome = phoneChrome(bridge, location.origin);

const mount = document.getElementById("panel-mount");
if (!mount) throw new Error("The phone page has no place for the side panel");
// The panel's elements take the mount's place: the panel's styles lay out the body's children.
mount.insertAdjacentHTML("beforebegin", __NOA_PANEL_HTML__);
mount.remove();
document.body.classList.add("panel");

// After the stand-in is in place: the panel reads `chrome` as its modules load.
await import("../sidepanel/sidepanel.js");
