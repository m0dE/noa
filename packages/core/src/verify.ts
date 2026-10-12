/** Independent check that an X post exists, shows the expected text and was written by the task's account. */
import { errorMessage, isXStatusUrl, pollUntil, sameHandle, xPostAuthor, type PageSnapshot, type Sleep } from "@noa/shared";
import type { BrowserCaller } from "./types.js";

export const VERIFY_SNIPPET_CHARS = 40;
/** What X shows instead of a post that does not exist (or was deleted). */
export const X_POST_MISSING = /this (post|page) (doesn.t|does not) exist|this post was deleted|hmm\.\.\.this page/i;
/**
 * How long the check waits for X to show the post. Right after it opens, X's post page is only its frame: the post
 * (and the tab's title, which carries its text) comes a moment later, and in a tab in the background the post itself
 * may never be drawn, only the title (the user's trace, Sep 28: 22 elements, no post, the text in the title only).
 */
export const VERIFY_WAIT = { intervalMs: 1000, timeoutMs: 10_000 } as const;

/** A link as typed ("https://arrr.fun/play", "www.arrr.fun") or as X shows it ("https://t.co/…"). */
const LINK = /\b(?:https?:\/\/|www\.)\S*/gi;

/**
 * A text as the words it shows, for comparing a post with its page: compatibility forms as plain letters (NFKC),
 * lower case, links left out (X turns them into t.co links and shortens them), and everything but letters and
 * digits (punctuation, emoji, line breaks) as one space.
 */
export function postWords(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(LINK, " ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** The distinctive part of a post text that must appear on its page: its first words, up to VERIFY_SNIPPET_CHARS. */
export function verifySnippet(expectedText: string): string {
  const words = postWords(expectedText).split(" ").filter(Boolean);
  let snippet = words[0] ?? "";
  for (const w of words.slice(1)) {
    if (snippet.length + 1 + w.length > VERIFY_SNIPPET_CHARS) break;
    snippet += ` ${w}`;
  }
  return snippet;
}

/** The page shows the snippet, as whole words, in its text, its title (X puts the post there) or its elements. */
function shows(page: PageSnapshot, snippet: string): boolean {
  const words = postWords(`${page.text}\n${page.title}\n${page.elements.map((e) => `${e.name} ${e.text ?? ""}`).join("\n")}`);
  return ` ${words} `.includes(` ${snippet} `);
}

const isMissing = (page: PageSnapshot) => X_POST_MISSING.test(`${page.title} ${page.text}`);

/**
 * account: the task's X account; the post must be its own. X shows a post under its author's handle whatever
 * handle the URL named, so the author is read from the URL the post page ends up on. The page is read again
 * (VERIFY_WAIT) until it shows the text or says the post does not exist; opts.sleep: injected by tests.
 */
export async function verifyXPost(
  browser: BrowserCaller,
  url: string,
  expectedText: string,
  account?: string | null,
  opts: { sleep?: Sleep } = {},
): Promise<{ ok: boolean; detail: string }> {
  if (!isXStatusUrl(url)) return { ok: false, detail: `not an X post URL: ${url}` };
  const snippet = verifySnippet(expectedText);
  try {
    await browser.call("browser.navigate", { url });
    const read = () => browser.call("browser.readPage", {});
    const settled = (page: PageSnapshot) => isMissing(page) || !snippet || shows(page, snippet);
    const { value: page } = await pollUntil(read, settled, { ...VERIFY_WAIT, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
    if (isMissing(page)) return { ok: false, detail: `X says the post does not exist at ${page.url}` };
    if (account) {
      const author = xPostAuthor(page.url) ?? xPostAuthor(url);
      if (!author) return { ok: false, detail: `could not tell which account wrote the post at ${page.url}` };
      if (!sameHandle(author, account)) return { ok: false, detail: `the post at ${page.url} is by ${author}, not the task's account ${account}` };
    }
    if (!snippet) return { ok: true, detail: `opened ${page.url} (no text to compare)` };
    if (shows(page, snippet)) return { ok: true, detail: `found "${snippet}" on ${page.url}` };
    return { ok: false, detail: `"${snippet}" not found on ${page.url}` };
  } catch (e) {
    return { ok: false, detail: `could not open ${url}: ${errorMessage(e)}` };
  }
}
