/**
 * The bridge between the account server's dashboard and this extension: a content script registered only on that
 * server's origin (account/dashboard-sign-in.ts). The page may ask one thing, "sign me in with the extension's
 * account", and gets the background's answer back. Nothing the page sends is forwarded.
 */
import { DASHBOARD_BRIDGE_ATTR, DASHBOARD_SIGN_IN, DASHBOARD_SIGN_IN_REPLY, type DashboardSignInReply } from "@noa/shared/dashboard-sign-in";

document.documentElement.setAttribute(DASHBOARD_BRIDGE_ATTR, "");

window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.origin !== location.origin || (ev.data as { type?: unknown } | null)?.type !== DASHBOARD_SIGN_IN) return;
  const answer = (reply: DashboardSignInReply) => window.postMessage({ type: DASHBOARD_SIGN_IN_REPLY, reply }, location.origin);
  chrome.runtime.sendMessage({ type: DASHBOARD_SIGN_IN }).then(answer, () => answer({ error: "failed" }));
});
