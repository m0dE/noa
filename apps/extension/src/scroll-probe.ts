/**
 * Measures what a scroll did. A page function lists the scroll positions of
 * everything that could move under the scroll point (the scrollable
 * containers from the element there up to the page, then the page itself);
 * scrollReport() compares that list before and after and says what moved, or
 * why nothing did. The debugger path measures around a mouse wheel; the
 * fallback path scrolls inside the same page function.
 */
import type { ScrollDirection, ScrollReport } from "@noa/shared";
import { PAGE_MARKS, type PageMarks } from "./driver-common.js";

/** One scroller's state. `page` is the window (document.scrollingElement). */
export interface ScrollEntry {
  page: boolean;
  /** read_page's number of the container (PageMarks.attr), when it has one. */
  index: number | null;
  top: number;
  left: number;
  sh: number;
  sw: number;
  ch: number;
  cw: number;
  /** The CSS overflow lets it scroll on that axis (for the page: not hidden). */
  oy: boolean;
  ox: boolean;
}

export interface ScrollProbe {
  entries: ScrollEntry[];
  /** The element under the point is an iframe (or embed/object). */
  overFrame: boolean;
}

/** Result of a page function: its value, or an error message to throw. */
export type PageResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Page function (self-contained, plain ES2020: it is serialized with
 * Function.prototype.toString for Runtime.evaluate and chrome.scripting).
 *
 * - "measure": finds the scrollers under point (x, y), or from element
 *   `index` up, remembers them on the window, returns their state.
 * - "read": the state of the remembered scrollers (same order).
 * - "scroll": measures, scrolls the innermost scroller that can move
 *   (dx, dy) that way, like a wheel would, and returns before and after.
 */
export function scrollProbeInPage(
  marks: PageMarks,
  mode: string,
  x: number,
  y: number,
  index: number | null,
  dx: number,
  dy: number,
): PageResult<ScrollProbe | { before: ScrollProbe; after: ScrollProbe }> {
  var KEY = "__noaScroll";
  var w = window as unknown as Record<string, unknown>;
  var root = (document.scrollingElement || document.documentElement) as HTMLElement;
  var hidden = function (v: string) {
    return v === "hidden" || v === "clip";
  };
  var state = function (e: HTMLElement | null): ScrollEntry {
    if (!e) {
      var hs = getComputedStyle(document.documentElement);
      var bs = document.body ? getComputedStyle(document.body) : hs;
      // overflow on body applies to the viewport when html's is visible.
      var oy = !hidden(hs.overflowY) && !(hs.overflowY === "visible" && hidden(bs.overflowY));
      var ox = !hidden(hs.overflowX) && !(hs.overflowX === "visible" && hidden(bs.overflowX));
      return { page: true, index: null, top: root.scrollTop, left: root.scrollLeft, sh: root.scrollHeight, sw: root.scrollWidth, ch: root.clientHeight, cw: root.clientWidth, oy: oy, ox: ox };
    }
    var cs = getComputedStyle(e);
    var raw = e.getAttribute(marks.attr);
    return {
      page: false,
      index: raw === null || raw === "" || isNaN(Number(raw)) ? null : Number(raw),
      top: e.scrollTop,
      left: e.scrollLeft,
      sh: e.scrollHeight,
      sw: e.scrollWidth,
      ch: e.clientHeight,
      cw: e.clientWidth,
      oy: /(auto|scroll|overlay)/.test(cs.overflowY),
      ox: /(auto|scroll|overlay)/.test(cs.overflowX),
    };
  };
  var read = function (list: (HTMLElement | null)[], overFrame: boolean): ScrollProbe {
    return { entries: list.map(state), overFrame: overFrame };
  };

  if (mode === "read") {
    var kept = w[KEY] as { list: (HTMLElement | null)[]; overFrame: boolean } | undefined;
    if (!kept) return { ok: false, error: "scroll was not measured first" };
    return { ok: true, value: read(kept.list, kept.overFrame) };
  }

  var start: Element | null;
  if (index != null) {
    start = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null);
    if (!start) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  } else {
    start = document.elementFromPoint(x, y);
  }
  var overFrame = !!start && /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(start.tagName);
  // Scrollable containers from the start element up (through shadow roots), then the page (null).
  var list: (HTMLElement | null)[] = [];
  for (var e: Element | null = start; e && list.length < 20; ) {
    if (e !== root && e !== document.body && e !== document.documentElement && e instanceof HTMLElement) {
      if (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth) {
        var s = getComputedStyle(e);
        if (/(auto|scroll|overlay)/.test(s.overflowY) || /(auto|scroll|overlay)/.test(s.overflowX)) list.push(e);
      }
    }
    var next: Element | null = e.parentElement;
    if (!next) {
      var r = e.getRootNode() as ShadowRoot;
      next = r && r.host ? r.host : null;
    }
    e = next;
  }
  list.push(null);
  Object.defineProperty(w, KEY, { value: { list: list, overFrame: overFrame }, configurable: true, writable: true, enumerable: false });
  var before = read(list, overFrame);
  if (mode !== "scroll") return { ok: true, value: before };

  for (var i = 0; i < list.length; i++) {
    var st = before.entries[i]!;
    var roomY = dy > 0 ? st.top < st.sh - st.ch - 1 : dy < 0 ? st.top > 0 : false;
    var roomX = dx > 0 ? st.left < st.sw - st.cw - 1 : dx < 0 ? st.left > 0 : false;
    if ((dy !== 0 && st.oy && roomY) || (dx !== 0 && st.ox && roomX)) {
      var el = list[i];
      if (el) el.scrollBy({ top: dy, left: dx, behavior: "instant" as ScrollBehavior });
      else window.scrollBy({ top: dy, left: dx, behavior: "instant" as ScrollBehavior });
      break;
    }
  }
  return { ok: true, value: { before: before, after: read(list, overFrame) } };
}

/** Runtime.evaluate expression for scrollProbeInPage. */
export function scrollProbeExpression(mode: "measure" | "read", x: number, y: number, index: number | null): string {
  return `(${scrollProbeInPage.toString()})(${JSON.stringify(PAGE_MARKS)}, ${JSON.stringify(mode)}, ${x}, ${y}, ${index === null ? "null" : Math.trunc(index)}, 0, 0)`;
}

/**
 * Compares the scrollers' state before and after a scroll. byIndex: the
 * scroll was aimed at an element, so a stuck container is reported rather
 * than the page.
 */
export function scrollReport(direction: ScrollDirection, before: ScrollProbe, after: ScrollProbe, byIndex = false): ScrollReport {
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "down" || direction === "right" ? 1 : -1;
  const pos = (e: ScrollEntry) => (vertical ? e.top : e.left);
  const size = (e: ScrollEntry) => (vertical ? e.sh : e.sw);
  const view = (e: ScrollEntry) => (vertical ? e.ch : e.cw);
  const allowed = (e: ScrollEntry) => (vertical ? e.oy : e.ox);
  const range = (e: ScrollEntry) => Math.max(0, size(e) - view(e));
  const report = (e: ScrollEntry, moved: number, reason?: ScrollReport["reason"]): ScrollReport => {
    const r: ScrollReport = { moved, target: e.page ? "page" : "container", position: Math.round(pos(e)), size: size(e), view: view(e) };
    if (!e.page && e.index !== null) r.containerIndex = e.index;
    if (reason) r.reason = reason;
    return r;
  };

  const pairs = before.entries.map((b, i) => ({ b, a: after.entries[i] ?? b }));
  // The wheel scrolls the innermost scroller that can move; report that one.
  for (const { b, a } of pairs) {
    const moved = Math.round((pos(a) - pos(b)) * sign);
    if (moved > 0) return report(a, moved);
  }
  const page = pairs[pairs.length - 1]?.a ?? { page: true, index: null, top: 0, left: 0, sh: 0, sw: 0, ch: 0, cw: 0, oy: true, ox: true };
  const candidates = pairs.map((p) => p.a).filter((e) => allowed(e) && range(e) > 1);
  if (!candidates.length) return report(page, 0, before.overFrame ? "frame" : "fixed");
  const atEnd = (e: ScrollEntry) => (sign > 0 ? pos(e) >= range(e) - 1 : pos(e) <= 0);
  const room = candidates.find((e) => !atEnd(e));
  if (room) return report(room, 0, before.overFrame ? "frame" : "ignored");
  return report((byIndex ? undefined : candidates.find((e) => e.page)) ?? candidates[0]!, 0, "end");
}

/** True when both lists hold the same positions (the scroll has settled). */
export function sameProbe(a: ScrollProbe, b: ScrollProbe): boolean {
  return a.entries.length === b.entries.length && a.entries.every((e, i) => e.top === b.entries[i]!.top && e.left === b.entries[i]!.left);
}
