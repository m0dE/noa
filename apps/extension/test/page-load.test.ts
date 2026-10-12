import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PAGE_WAIT_MS, leavingDocument, looksUnloaded, READ_LOAD_WAIT_MS, readWhenDrawn, stillLoadingNote, waitForUsablePage, type LoadProbe } from "../src/page-load.js";

const reading = (over: Partial<LoadProbe>): LoadProbe => ({ doc: 2, state: "interactive", controls: 40, text: 5000, foreignFrame: false, ...over });

/** Plays the readings in order (the last repeats) and counts the waits between them. */
function play(readings: (LoadProbe | null)[]) {
  let i = 0;
  let waits = 0;
  return {
    read: async () => readings[Math.min(i++, readings.length - 1)]!,
    sleep: async () => void waits++,
    get reads() {
      return i;
    },
    get waits() {
      return waits;
    },
  };
}

describe("waitForUsablePage", () => {
  it("does not wait for the load event of a heavy app: past DOMContentLoaded, three unchanged readings are enough", async () => {
    const p = play([
      null, // navigating
      reading({ state: "loading" }),
      reading({ controls: 30, text: 800 }), // the shell, "Loading…"
      reading({ controls: 30, text: 800 }),
      reading({ controls: 900, text: 40_000 }), // the list is drawn
      reading({ controls: 900, text: 40_020 }),
      reading({ controls: 900, text: 40_040 }),
      reading({ controls: 900, text: 40_040 }),
    ]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep, leaving: 1 })).toMatchObject({ state: "interactive", controls: 900 });
    expect(p.reads).toBe(8);
  });

  it("a complete page needs one unchanged reading", async () => {
    const p = play([reading({ state: "complete" }), reading({ state: "complete" })]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep })).toMatchObject({ state: "complete" });
    expect(p.waits).toBe(1);
  });

  it("ignores the document being left, and a blank page that is not complete", async () => {
    const p = play([reading({ doc: 1, state: "complete" }), reading({ doc: 1, state: "complete" }), reading({ controls: 0, text: 0 }), reading({ controls: 0, text: 0 }), reading({ controls: 0, text: 0 }), reading({ controls: 0, text: 0 }), reading({ state: "complete", controls: 0, text: 0 }), reading({ state: "complete", controls: 0, text: 0 })]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep, leaving: 1 })).toMatchObject({ doc: 2, state: "complete" });
    expect(p.reads).toBe(7);
  });

  it("gives up after the time limit; a reading that throws ends the wait", async () => {
    const p = play([reading({ state: "loading" })]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep, timeoutMs: 0 })).toBeNull();
    await expect(waitForUsablePage(async () => Promise.reject(new Error("blocked")), { sleep: p.sleep })).rejects.toThrow("blocked");
  });
});

describe("leavingDocument", () => {
  it("is the current document, unless only the #fragment changes", () => {
    expect(leavingDocument("https://mail.test/u/0/#inbox", "https://mail.test/u/2/#inbox", 7)).toBe(7);
    expect(leavingDocument("https://mail.test/u/0/#inbox", "https://mail.test/u/0/#sent", 7)).toBeNull();
    expect(leavingDocument("https://mail.test/u/0/", "https://mail.test/u/0/", 7)).toBe(7);
    expect(leavingDocument("https://mail.test/", "https://mail.test/x", null)).toBeNull();
  });
});

describe("readWhenDrawn (read_page on a tab still loading or drawing)", () => {
  afterEach(() => vi.useRealTimers());
  const empty = { url: "https://x.com/jack", text: "X", elements: [{}, {}] };
  const drawn = { url: "https://x.com/jack", text: "Jack @jack 2,000 posts Follow", elements: Array(40).fill({}) };
  /** A clock the waits move (sleep = time passing), and the snapshots and load readings in order (the last repeats). */
  function page(snaps: (typeof empty)[], probes: (LoadProbe | null)[]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    let s = 0;
    let p = 0;
    return {
      read: async () => snaps[Math.min(s++, snaps.length - 1)]!,
      probe: async () => probes[Math.min(p++, probes.length - 1)]!,
      sleep: async (ms: number) => void vi.setSystemTime(Date.now() + ms),
      get reads() {
        return s;
      },
    };
  }

  it("a page that shows something is read once, with no wait", async () => {
    const p = page([drawn], [reading({ state: "complete" })]);
    expect(await readWhenDrawn(p.read, p.probe, p)).toEqual({ snap: drawn });
    expect(p.reads).toBe(1);
    // about:blank and browser pages are never waited for, nor is a page with real content.
    expect(looksUnloaded({ url: "about:blank", text: "", elements: [] })).toBe(false);
    expect(looksUnloaded(empty)).toBe(true);
    expect(looksUnloaded(drawn)).toBe(false);
  });

  it("a tab still loading is waited for until it is usable, then read again", async () => {
    const p = page([empty, drawn], [reading({ state: "loading" }), reading({ state: "interactive" })]);
    expect(await readWhenDrawn(p.read, p.probe, p)).toEqual({ snap: drawn });
    expect(p.reads).toBe(2);
  });

  it("a tab opened a moment ago still shows its blank first document: the address it is heading to says it is a web page to wait for", async () => {
    const blank = { url: "about:blank", text: "", elements: [] };
    const p = page([blank, blank, drawn], [reading({ state: "complete", controls: 0, text: 0 })]);
    let loads = 0;
    const tab = async () => ({ heading: "https://x.com/jack", loading: loads++ < 2 });
    expect(await readWhenDrawn(p.read, p.probe, { sleep: p.sleep, tab })).toEqual({ snap: drawn });
    expect(looksUnloaded(blank)).toBe(false);
    expect(looksUnloaded(blank, "https://x.com/jack")).toBe(true);
  });

  it("a loaded web app still drawing its first screen gets a few seconds", async () => {
    const p = page([empty, empty, empty, drawn], [reading({ state: "complete", controls: 2, text: 1 })]);
    expect(await readWhenDrawn(p.read, p.probe, p)).toEqual({ snap: drawn });
  });

  it("gives up after EMPTY_PAGE_WAIT_MS on a loaded page, READ_LOAD_WAIT_MS on a loading one, and says the page is still loading", async () => {
    const loaded = page([empty], [reading({ state: "complete", controls: 2, text: 1 })]);
    const r = await readWhenDrawn(loaded.read, loaded.probe, loaded);
    expect(r.snap).toBe(empty);
    expect(r.stillLoading).toBeGreaterThanOrEqual(EMPTY_PAGE_WAIT_MS);
    expect(r.stillLoading).toBeLessThan(READ_LOAD_WAIT_MS);
    const loading = page([empty], [reading({ state: "loading" })]);
    const l = await readWhenDrawn(loading.read, loading.probe, loading);
    expect(l.stillLoading).toBeGreaterThanOrEqual(READ_LOAD_WAIT_MS);
    expect(l.stillLoading).toBeLessThan(READ_LOAD_WAIT_MS + 1000);
    expect(stillLoadingNote(empty, 10_000)).toBe(
      "Page still loading: after 10 s it still shows next to nothing (2 elements, 1 characters of text). Read it again in a moment, or use wait_for, before concluding anything from it.",
    );
  });
});
