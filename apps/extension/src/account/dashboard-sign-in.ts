/**
 * Signing the dashboard in with this extension's account. The bridge script (dashboard-bridge.ts), registered only
 * on the account server's origin, relays the dashboard's request here; the answer is a one-time code the page trades
 * with the server for a session of its own (apps/api routes/auth.ts). The session token never leaves the extension.
 */
import { DASHBOARD_SIGN_IN, type DashboardSignInReply, errorMessage, type SignInCodeResponse } from "@noa/shared";

const BRIDGE_ID = "noa-dashboard-bridge";

export interface DashboardSignInSender {
  id?: string;
  origin?: string;
  frameId?: number;
  tab?: unknown;
}

export const isDashboardSignInMessage = (msg: unknown): boolean => (msg as { type?: unknown } | null)?.type === DASHBOARD_SIGN_IN;

/**
 * The answer to the bridge: a code when it runs in a tab's top frame (sender.origin is Chrome's word for the page's
 * origin); `code` returns null unless that origin is the signed-in account server's.
 */
export async function answerDashboardSignIn(
  sender: DashboardSignInSender,
  deps: { selfId: string; code(origin: string): Promise<SignInCodeResponse | null>; log?(message: string): void },
): Promise<DashboardSignInReply> {
  if (sender.id !== deps.selfId || !sender.tab || sender.frameId !== 0 || !sender.origin) return { error: "signed-out" };
  try {
    return (await deps.code(sender.origin)) ?? { error: "signed-out" };
  } catch (err) {
    deps.log?.(`dashboard sign-in code: ${errorMessage(err)}`);
    return { error: "failed" };
  }
}

/** Runs the bridge on the account server `apiBase`'s pages only (none when it is not an http(s) URL). */
export async function syncDashboardBridge(apiBase: string): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] }).catch(() => {});
  let origin: string;
  try {
    const u = new URL(apiBase);
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    origin = u.origin;
  } catch {
    return;
  }
  await chrome.scripting.registerContentScripts([{ id: BRIDGE_ID, matches: [`${origin}/*`], js: ["dashboard-bridge.js"], runAt: "document_start", allFrames: false }]);
}
