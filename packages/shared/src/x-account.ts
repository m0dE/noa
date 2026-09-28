/**
 * What X's pages say about its accounts: which one is signed in (the account
 * switcher in the side nav) and who wrote a post (its URL). The testId comes
 * from X's HTML at the time of writing and must be re-checked against the
 * live site.
 */
import type { PageSnapshot } from "./browser.js";
import { isXStatusUrl, normalizeHandle } from "./urls.js";

/** X's account switcher button: its text names the signed-in account ("Rooftop Chat @rooftopchat"). */
export const X_SWITCHER_TEST_ID = "SideNav_AccountSwitcher_Button";

const HANDLE = /@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;

/** Handles compare without case and without caring for the "@". */
export function sameHandle(a: string, b: string): boolean {
  return normalizeHandle(a).toLowerCase() === normalizeHandle(b).toLowerCase();
}

/** The account X is signed in as, read from its switcher button; null when the page shows no switcher with a handle. */
export function activeXAccount(page: Pick<PageSnapshot, "elements">): string | null {
  const switcher = page.elements.find((e) => e.testId === X_SWITCHER_TEST_ID);
  if (!switcher) return null;
  const handles = [...`${switcher.name} ${switcher.text ?? ""}`.matchAll(HANDLE)];
  return handles.length ? `@${handles.at(-1)![1]}` : null;
}

/** The author of an X post URL (x.com/<handle>/status/<id>); null for x.com/i/status/<id> or a URL that is not a post. */
export function xPostAuthor(url: string): string | null {
  if (!isXStatusUrl(url)) return null;
  const m = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(new URL(url).pathname);
  return m && m[1]!.toLowerCase() !== "i" ? `@${m[1]}` : null;
}
