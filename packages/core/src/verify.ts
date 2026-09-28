/** Independent check that an X post exists, shows the expected text and was written by the task's account. */
import { errorMessage, isXStatusUrl, normalizeText, sameHandle, xPostAuthor } from "@noa/shared";
import type { BrowserCaller } from "./types.js";

export const VERIFY_SNIPPET_CHARS = 40;
/** What X shows instead of a post that does not exist (or was deleted). */
export const X_POST_MISSING = /this (post|page) (doesn.t|does not) exist|this post was deleted|hmm\.\.\.this page/i;

/** The distinctive part of a post text that must appear on its page. */
export function verifySnippet(expectedText: string): string {
  return normalizeText(expectedText).slice(0, VERIFY_SNIPPET_CHARS).trim();
}

/**
 * account: the task's X account; the post must be its own. X shows a post under its author's handle whatever
 * handle the URL named, so the author is read from the URL the post page ends up on.
 */
export async function verifyXPost(browser: BrowserCaller, url: string, expectedText: string, account?: string | null): Promise<{ ok: boolean; detail: string }> {
  if (!isXStatusUrl(url)) return { ok: false, detail: `not an X post URL: ${url}` };
  const snippet = verifySnippet(expectedText);
  try {
    await browser.call("browser.navigate", { url });
    const page = await browser.call("browser.readPage", {});
    if (X_POST_MISSING.test(`${page.title} ${page.text}`)) return { ok: false, detail: `X says the post does not exist at ${page.url}` };
    if (account) {
      const author = xPostAuthor(page.url) ?? xPostAuthor(url);
      if (!author) return { ok: false, detail: `could not tell which account wrote the post at ${page.url}` };
      if (!sameHandle(author, account)) return { ok: false, detail: `the post at ${page.url} is by ${author}, not the task's account ${account}` };
    }
    if (!snippet) return { ok: true, detail: `opened ${page.url} (no text to compare)` };
    const haystack = normalizeText(`${page.text}\n${page.title}\n${page.elements.map((e) => `${e.name} ${e.text ?? ""}`).join("\n")}`);
    if (haystack.includes(snippet)) return { ok: true, detail: `found "${snippet}" on ${page.url}` };
    return { ok: false, detail: `"${snippet}" not found on ${page.url}` };
  } catch (e) {
    return { ok: false, detail: `could not open ${url}: ${errorMessage(e)}` };
  }
}
