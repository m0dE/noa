import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGE_MARKS } from "../src/driver-common.js";
import { scrollProbeInPage, scrollReport, type ScrollEntry, type ScrollProbe } from "../src/scroll-probe.js";

/** Just enough DOM for scrollProbeInPage: elements with scroll boxes and overflow styles. */
class FakeEl {
  parentElement: FakeEl | null = null;
  scrollTop = 0;
  scrollLeft = 0;
  constructor(
    public tagName: string,
    public scrollHeight: number,
    public clientHeight: number,
    public style: { overflowX: string; overflowY: string } = { overflowX: "visible", overflowY: "visible" },
    public attrs: Record<string, string> = {},
    public scrollWidth = 100,
    public clientWidth = 100,
  ) {}
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  getRootNode() {
    return {};
  }
  scrollBy({ top = 0, left = 0 }: { top?: number; left?: number }) {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + top));
    this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left));
  }
}

let html: FakeEl;
let body: FakeEl;
let hit: FakeEl;
const saved: Record<string, unknown> = {};
const G = globalThis as Record<string, unknown>;

function page(opts: { pageHeight: number; inner?: FakeEl }) {
  html = new FakeEl("HTML", opts.pageHeight, 800);
  body = new FakeEl("BODY", opts.pageHeight, opts.pageHeight);
  body.parentElement = html;
  hit = new FakeEl("P", 20, 20);
  if (opts.inner) {
    opts.inner.parentElement = body;
    hit.parentElement = opts.inner;
  } else {
    hit.parentElement = body;
  }
  const all = [html, body, hit, ...(opts.inner ? [opts.inner] : [])];
  G.document = {
    documentElement: html,
    body,
    scrollingElement: html,
    elementFromPoint: () => hit,
    querySelector: (sel: string) => all.find((e) => sel.includes(`"${e.attrs["data-noa-index"]}"`)) ?? null,
  };
  G.window = { scrollBy: (o: { top?: number; left?: number }) => html.scrollBy(o) };
}

beforeEach(() => {
  for (const k of ["document", "window", "getComputedStyle", "HTMLElement"]) saved[k] = G[k];
  G.getComputedStyle = (e: FakeEl) => e.style;
  G.HTMLElement = FakeEl;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) G[k] = v;
});

type Both = { before: ScrollProbe; after: ScrollProbe };
const run = (dy: number, index: number | null = null) => {
  const r = scrollProbeInPage(PAGE_MARKS, "scroll", 50, 400, index, 0, dy);
  if (!r.ok) throw new Error(r.error);
  return r.value as Both;
};

describe("scrollProbeInPage + scrollReport (fallback path)", () => {
  it("scrolls the page and reports how far", () => {
    page({ pageHeight: 5400 });
    const { before, after } = run(640);
    expect(html.scrollTop).toBe(640);
    expect(scrollReport("down", before, after)).toEqual({ moved: 640, target: "page", position: 640, size: 5400, view: 800 });
  });

  it("at the bottom nothing moves, and it says so", () => {
    page({ pageHeight: 5400 });
    html.scrollTop = 4600;
    const { before, after } = run(640);
    expect(scrollReport("down", before, after)).toEqual({ moved: 0, target: "page", position: 4600, size: 5400, view: 800, reason: "end" });
    // Going up from there works.
    const up = run(-640);
    expect(scrollReport("up", up.before, up.after)).toMatchObject({ moved: 640, target: "page", position: 3960 });
  });

  it("a page that does not scroll", () => {
    page({ pageHeight: 800 });
    const { before, after } = run(640);
    expect(scrollReport("down", before, after)).toMatchObject({ moved: 0, target: "page", reason: "fixed" });
  });

  it("the container under the point scrolls instead of the page", () => {
    const inner = new FakeEl("DIV", 2000, 500, { overflowX: "hidden", overflowY: "auto" }, { "data-noa-index": "12" });
    page({ pageHeight: 800, inner });
    const { before, after } = run(400);
    expect(inner.scrollTop).toBe(400);
    expect(html.scrollTop).toBe(0);
    expect(scrollReport("down", before, after)).toEqual({ moved: 400, target: "container", containerIndex: 12, position: 400, size: 2000, view: 500 });
  });

  it("a container at its end chains to the page; with an index a stuck container is reported", () => {
    const inner = new FakeEl("DIV", 2000, 500, { overflowX: "hidden", overflowY: "auto" }, { "data-noa-index": "3" });
    page({ pageHeight: 5400, inner });
    inner.scrollTop = 1500;
    const chained = run(640);
    expect(scrollReport("down", chained.before, chained.after)).toMatchObject({ moved: 640, target: "page" });
    html.scrollTop = 4600;
    const stuck = run(640, 3);
    expect(scrollReport("down", stuck.before, stuck.after, true)).toMatchObject({ moved: 0, target: "container", containerIndex: 3, reason: "end" });
    expect(scrollReport("down", stuck.before, stuck.after, false)).toMatchObject({ moved: 0, target: "page", reason: "end" });
  });

  it("overflow: hidden on the body keeps the page from scrolling", () => {
    page({ pageHeight: 5400 });
    body.style = { overflowX: "hidden", overflowY: "hidden" };
    const { before, after } = run(640);
    expect(html.scrollTop).toBe(0);
    expect(scrollReport("down", before, after)).toMatchObject({ moved: 0, reason: "fixed" });
  });

  it("measure then read (debugger path) sees what a wheel moved", () => {
    const inner = new FakeEl("DIV", 2000, 500, { overflowX: "hidden", overflowY: "scroll" });
    page({ pageHeight: 5400, inner });
    const m = scrollProbeInPage(PAGE_MARKS, "measure", 50, 400, null, 0, 0);
    inner.scrollTop = 300; // the wheel
    const r = scrollProbeInPage(PAGE_MARKS, "read", 0, 0, null, 0, 0);
    if (!m.ok || !r.ok) throw new Error("probe failed");
    expect(scrollReport("down", m.value as ScrollProbe, r.value as ScrollProbe)).toEqual({ moved: 300, target: "container", position: 300, size: 2000, view: 500 });
  });
});

describe("scrollReport", () => {
  const entry = (over: Partial<ScrollEntry>): ScrollEntry => ({ page: true, index: null, top: 0, left: 0, sh: 800, sw: 100, ch: 800, cw: 100, oy: true, ox: true, ...over });
  it("a page with room that did not move was ignoring the wheel; over a frame says frame", () => {
    const p = { entries: [entry({ top: 100, sh: 5400 })], overFrame: false };
    expect(scrollReport("down", p, p)).toMatchObject({ moved: 0, reason: "ignored", position: 100 });
    expect(scrollReport("down", { ...p, overFrame: true }, p)).toMatchObject({ reason: "frame" });
    const flat = { entries: [entry({})], overFrame: true };
    expect(scrollReport("down", flat, flat)).toMatchObject({ reason: "frame" });
  });
});
