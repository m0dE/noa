/**
 * The post check on X's real post page (the user's trace, Sep 28): the agent posted, X had the post at the URL
 * it reported, yet the check said `"100gb/month free. zero servers to babysi" not found` and the run became a
 * retry. The check read the page once, right after opening it, while X showed its frame without the post; the
 * post's text only comes with the tab's title a moment later (see x-status-page.ts).
 */
import { describe, expect, it } from "vitest";
import type { BrowserCaller } from "../src/index.js";
import { postWords, verifySnippet, verifyXPost, VERIFY_WAIT } from "../src/verify.js";
import type { PageSnapshot } from "@noa/shared";
import { ARRR_POST_TITLE, ARRR_POST_URL, ARRR_TYPED, xStatusShell } from "./x-status-page.js";

/** A post page whose reads return `pages` in turn (the last one from then on). */
function postPage(pages: PageSnapshot[]) {
  const calls: string[] = [];
  let read = 0;
  const browser = {
    call: async (method: string) => {
      calls.push(method);
      if (method === "browser.navigate") return { url: ARRR_POST_URL, title: pages[0]!.title };
      if (method === "browser.readPage") return pages[Math.min(read++, pages.length - 1)]!;
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as BrowserCaller;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  return { browser, calls, sleeps, sleep };
}

describe("verifyXPost on X's post page", () => {
  it("the page as the agent read it (the post only in the title) passes", async () => {
    const p = postPage([xStatusShell(ARRR_POST_TITLE)]);
    const r = await verifyXPost(p.browser, ARRR_POST_URL, ARRR_TYPED, "@arrrfun", { sleep: p.sleep });
    expect(r).toEqual({ ok: true, detail: expect.stringContaining("found") });
  });

  it("waits for X to show the post: the first read has X's frame only (the trace's failure)", async () => {
    const p = postPage([xStatusShell("X"), xStatusShell("X"), xStatusShell(ARRR_POST_TITLE)]);
    const r = await verifyXPost(p.browser, ARRR_POST_URL, ARRR_TYPED, "@arrrfun", { sleep: p.sleep });
    expect(r.ok).toBe(true);
    expect(p.calls.filter((c) => c === "browser.readPage")).toHaveLength(3);
    expect(p.sleeps).toEqual([VERIFY_WAIT.intervalMs, VERIFY_WAIT.intervalMs]);
  });

  it("gives up after the wait with the reason it gave the user", async () => {
    const p = postPage([xStatusShell("X")]);
    const r = await verifyXPost(p.browser, ARRR_POST_URL, ARRR_TYPED, "@arrrfun", { sleep: p.sleep });
    expect(r).toEqual({ ok: false, detail: `"100gb month free zero servers to babysit" not found on ${ARRR_POST_URL}` });
    expect(p.sleeps.reduce((a, b) => a + b, 0)).toBe(VERIFY_WAIT.timeoutMs);
  });

  it("stops waiting as soon as X says the post does not exist", async () => {
    const missing = { ...xStatusShell("X"), text: "Hmm...this page doesn't exist. Try searching for something else." };
    const p = postPage([xStatusShell("X"), missing]);
    const r = await verifyXPost(p.browser, ARRR_POST_URL, ARRR_TYPED, "@arrrfun", { sleep: p.sleep });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does not exist/);
    expect(p.sleeps).toHaveLength(1);
  });

  it("a different post at the URL fails after the wait", async () => {
    const other = xStatusShell('ARRR on X: "Netcode headaches, surprise hosting bills, scaling panic at 2am." / X');
    const p = postPage([other]);
    expect((await verifyXPost(p.browser, ARRR_POST_URL, ARRR_TYPED, "@arrrfun", { sleep: p.sleep })).ok).toBe(false);
  });
});

describe("verifySnippet: the words of the post, whatever X does to its text", () => {
  it("case, line breaks, punctuation and emoji do not count; the snippet ends on a whole word", () => {
    expect(verifySnippet(ARRR_TYPED)).toBe("100gb month free zero servers to babysit");
  });

  it("links are left out (X shows them as t.co in the title, shortened in the post)", () => {
    const typed = "https://arrr.fun/play is live: pirates, sails and cannons for everyone who builds games";
    const title = 'ARRR on X: "https://t.co/AbCdEf12 is live: pirates, sails and cannons for everyone who builds games" / X';
    expect(verifySnippet(typed)).toBe("is live pirates sails and cannons for");
    expect(postWords(title)).toContain(verifySnippet(typed));
  });

  it("compatibility forms read as plain letters (full-width, ligatures) and accents are kept", () => {
    expect(verifySnippet("ＡＲＲＲ ﬁnally ships the café map")).toBe("arrr finally ships the café map");
  });
});
