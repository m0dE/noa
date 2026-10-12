// The dashboard signing in with the extension's account. No imports: the extension's bridge script (a content script
// on the account server's pages) bundles this alone.
//
// page --window.postMessage--> bridge --chrome.runtime--> background: a one-time code (POST /v1/auth/code), and back.

/** The page's request, and the bridge's message to the background. */
export const DASHBOARD_SIGN_IN = "noa.dashboardSignIn";
/** The bridge's answer to the page: { type, reply }. */
export const DASHBOARD_SIGN_IN_REPLY = "noa.dashboardSignIn.reply";
/** The bridge sets this attribute on <html>: the extension is here to ask. */
export const DASHBOARD_BRIDGE_ATTR = "data-noa-extension";

/** A one-time code (POST /v1/auth/code), or why there is none. */
export type DashboardSignInReply = { code: string; expiresAt: string } | { error: "signed-out" | "failed" };
