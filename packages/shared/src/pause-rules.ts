/**
 * URLs that always pause a task, whatever the agent is doing. Login,
 * verification and lockout pages need a human.
 */
import { siteHost } from "./urls.js";

/** Only X's main and mobile hosts show these flows (unlike isXSite, no other subdomains). */
const X_PAUSE_HOSTS = new Set(["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]);

const X_PAUSE_PATHS: { prefix: string; reason: string }[] = [
  { prefix: "/i/flow/login", reason: "X is asking to log in" },
  { prefix: "/login", reason: "X is asking to log in" },
  { prefix: "/i/flow/signup", reason: "X is showing the sign-up flow" },
  { prefix: "/account/access", reason: "X locked the account and needs verification" },
  { prefix: "/account/login_challenge", reason: "X is showing a login challenge" },
  { prefix: "/account/login_verification", reason: "X is asking for login verification" },
  { prefix: "/i/flow/consent_flow", reason: "X is showing a consent flow" },
  { prefix: "/account/suspended", reason: "X says the account is suspended" },
];

/** Returns a pause reason when this URL needs a human, otherwise null. */
export function pauseReasonForUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!X_PAUSE_HOSTS.has(siteHost(url.hostname))) return null;
  const path = url.pathname.toLowerCase();
  for (const rule of X_PAUSE_PATHS) {
    if (path === rule.prefix || path.startsWith(rule.prefix + "/") || path.startsWith(rule.prefix + "?")) {
      return rule.reason;
    }
  }
  return null;
}
