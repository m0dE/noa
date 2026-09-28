/** Site and X (Twitter) URL helpers. */

const X_HOSTS = ["x.com", "twitter.com"];

/** X's home timeline (where the composer and the account switcher are). */
export const X_HOME_URL = "https://x.com/home";

/** "@name" from "name", "@name" or " @@name ". */
export function normalizeHandle(handle: string): string {
  return `@${handle.trim().replace(/^@+/, "").trim()}`;
}

/** The profile page of an X account (handle with or without @). */
export function xProfileUrl(handle: string): string {
  return `https://x.com/${normalizeHandle(handle).slice(1)}`;
}

/** Hostname of a site given as a host or URL, lowercased, without www. */
export function siteHost(site: string): string {
  const s = site.trim().toLowerCase();
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, "");
  } catch {
    return s;
  }
}

/** Second levels under a two-letter country code that are public suffixes themselves: "co.uk", "com.au", "ne.jp". */
const COUNTRY_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "go", "gob", "gov", "ltd", "mil", "ne", "net", "nic", "or", "org", "plc", "sch"]);

/** Hosting domains whose every subdomain is a site of its own (the most used of the Public Suffix List's private section). */
const HOSTING_SUFFIXES = [
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com",
  "herokuapp.com", "onrender.com", "fly.dev", "blogspot.com", "azurewebsites.net", "cloudfront.net", "glitch.me",
];

/**
 * The registrable domain (eTLD+1) of a site given as host or URL: "mail.google.com" -> "google.com", "www.bbc.co.uk"
 * -> "bbc.co.uk", "alice.github.io" -> "alice.github.io". A host with no site above it (localhost, an IP address, a
 * public suffix) is its own. Limitation: this is not the Public Suffix List, only its common shapes (a TLD, a
 * two-letter country code under a generic second level, the hosting domains above); under a suffix it does not know
 * ("city.kawasaki.jp", a rarer hosting service) two customers' sites count as one.
 */
export function registrableDomain(site: string): string {
  const host = siteHost(site).replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2 || /^[\d.]+$/.test(host) || host.startsWith("[")) return host;
  const hosting = HOSTING_SUFFIXES.find((s) => host.endsWith(`.${s}`));
  const suffixLabels = hosting ? hosting.split(".").length : labels.at(-1)!.length === 2 && COUNTRY_SECOND_LEVELS.has(labels.at(-2)!) ? 2 : 1;
  return labels.length <= suffixLabels ? host : labels.slice(-(suffixLabels + 1)).join(".");
}

/** Whether two sites (hosts or URLs) are one registrable domain: "login.bank.test" and "https://bank.test/x" are. */
export function sameSite(a: string, b: string): boolean {
  const site = registrableDomain(a);
  return site !== "" && site === registrableDomain(b);
}

/** True for x.com, twitter.com and their subdomains (site given as host or URL). */
export function isXSite(site: string): boolean {
  const host = siteHost(site);
  return X_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** True when the URL is on x.com or twitter.com. */
export function isXUrl(url: string): boolean {
  try {
    return isXSite(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** An X post URL: https://x.com/<handle>/status/<id>. Only the path counts, not the query. */
export function isXStatusUrl(url: string): boolean {
  if (!isXUrl(url)) return false;
  try {
    return /\/status\/\d+/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
