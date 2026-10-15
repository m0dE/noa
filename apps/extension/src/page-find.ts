/**
 * find_text in the page (browser.findText): where a text occurs anywhere on the page, also far below the start of
 * the page text that read_page returns. Each match is reported by its place (the row, list item, paragraph or other
 * smallest block around it): that place's text and the controls in it. One place can be scrolled into view, so its
 * controls are among those read_page lists first.
 *
 * One find_text call that scrolls searches the page once: the search that scrolled keeps its places (marks.found),
 * and the call after the page read (again) lists them anew, with the numbers that read gave their controls and what
 * is in view now. It searches the page again only when the page changed in between (anything but read_page's own
 * numbering), so its answer is the one a new search would give.
 *
 * Both drivers run the same function: the debugger (Runtime.evaluate) and chrome.scripting.
 */
import type { FoundControl, FoundPlace, FoundText } from "@noa/shared";
import { MAX_FOUND_CONTEXT, MAX_FOUND_CONTROLS, MAX_FOUND_PLACES } from "@noa/shared";
import type { PageMarks } from "./driver-common.js";
import type { PageResult } from "./scroll-probe.js";

/** findTextInPage's limits (MAX_FOUND_*), passed in: the page function cannot import them. */
export const FIND_LIMITS = { places: MAX_FOUND_PLACES, context: MAX_FOUND_CONTEXT, controls: MAX_FOUND_CONTROLS };
export type FindLimits = typeof FIND_LIMITS;

/**
 * Page function (self-contained, plain ES2020: serialized with Function.prototype.toString). Searches the text the
 * page shows (visible text nodes, in open shadow roots too) and the values of its form fields, ignoring case and
 * spacing; a match may run across inline elements ("<b>Priya</b> Raman"). Lists the first limits.places places, and
 * place number `place` (1-based) too when it is further down; scroll: scrolls that place into view. again: the same
 * search as the last one, which scrolled, after a page read: its places listed anew while the page is unchanged.
 */
export function findTextInPage(marks: PageMarks, query: string, place: number, scroll: boolean, limits: FindLimits, again?: boolean): PageResult<FoundText> {
  var needle = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return { ok: false, error: "find_text needs some text to find" };
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var target = Math.max(1, Math.floor(place || 1));

  var CONTROLS =
    'a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="tab"],[role="textbox"],[role="combobox"],[contenteditable="true"],[contenteditable=""]';
  var PLACE = 'tr,li,[role="row"],[role="listitem"],[role="option"],[role="article"],article,dt,dd,p,h1,h2,h3,h4,h5,h6,label,figcaption,blockquote,pre';
  var INLINE = /^(inline|inline-block|inline-flex|inline-grid|contents)$/;

  var parentOf = function (e: Element): Element | null {
    if (e.parentElement) return e.parentElement;
    var root = e.getRootNode() as ShadowRoot;
    return root && root.host ? root.host : null;
  };
  var styles = new Map<Element, CSSStyleDeclaration>();
  var styleOf = function (e: Element) {
    var s = styles.get(e);
    if (!s) {
      s = getComputedStyle(e);
      styles.set(e, s);
    }
    return s;
  };
  /** Shown: laid out (it has boxes) and not visibility: hidden. */
  var shown = function (e: Element) {
    return e.getClientRects().length > 0 && styleOf(e).visibility !== "hidden";
  };
  /** The nearest ancestor not laid out inline: where a new line of text starts. */
  var blockOf = function (e: Element): Element {
    for (var b: Element | null = e; b; b = parentOf(b)) if (!INLINE.test(styleOf(b).display)) return b;
    return document.body;
  };

  // The page's text as one string (lower case, spacing collapsed), each piece mapped back to the element it is in.
  // Built as a list of parts joined once, its length and last character kept aside: reading a character of a string
  // grown by += flattens it, which made the search quadratic in the page's length (measured: most of its time on a
  // 5,000-row table).
  var pieces: { end: number; el: Element }[] = [];
  var parts: string[] = [];
  var length = 0;
  var lastChar = "";
  var lastBlock: Element | null = null;
  var space = function () {
    if (length && lastChar !== " ") {
      parts.push(" ");
      length++;
      lastChar = " ";
    }
  };
  var add = function (text: string, el: Element, block: Element | null) {
    var t = text.replace(/\s+/g, " ").toLowerCase();
    if (block === null || block !== lastBlock) space();
    lastBlock = block;
    if (t.charAt(0) === " " && (!length || lastChar === " ")) t = t.slice(1);
    if (!t) return;
    parts.push(t);
    length += t.length;
    lastChar = t.charAt(t.length - 1);
    pieces.push({ end: length, el: el });
  };
  /** A form field's value, text the page shows too (never a password's); null for a field whose value is not. */
  var valueOf = function (el: Element): string | null {
    var type = ((el as HTMLInputElement).type || "").toLowerCase();
    if (/^(password|hidden|checkbox|radio|file|submit|button|reset|image)$/.test(type)) return null;
    if (el.tagName !== "SELECT") return (el as HTMLInputElement).value || "";
    var sel = el as HTMLSelectElement;
    var opt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    return opt ? opt.label || opt.text : "";
  };
  /** The fields whose values were read, and those values: a value typed since changes the page without a mutation. */
  var fields: Element[] = [];
  var values: string[] = [];
  var fieldValue = function (el: Element) {
    var v = valueOf(el);
    if (v === null) return;
    fields.push(el);
    values.push(v);
    if (v.trim()) add(v + " ", el, null);
    lastBlock = null;
  };
  var shadowRoots: ShadowRoot[] = [];
  var walk = function (root: Node) {
    for (var n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        var parent = n.parentNode as Element | null;
        var value = n.nodeValue || "";
        if (parent && parent.nodeType === 1 && value.trim() && styleOf(parent).visibility !== "hidden") add(value, parent, blockOf(parent));
        else if (/\s/.test(value)) space();
      } else if (n.nodeType === 1) {
        var el = n as Element;
        var tag = el.tagName.toUpperCase();
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
          if (shown(el)) fieldValue(el);
          continue;
        }
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|SVG|OBJECT|EMBED)$/.test(tag)) continue;
        if (styleOf(el).display === "none") continue;
        if (el.shadowRoot) {
          shadowRoots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
        walk(el);
      }
    }
  };

  /** The place of a match: the smallest row, item or paragraph around it, else its nearest block. */
  var placeOf = function (el: Element): Element {
    return el.closest(PLACE) || blockOf(el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" ? parentOf(el) || el : el);
  };
  var textOf = function (el: Element) {
    var t = (el as HTMLElement).innerText;
    return (typeof t === "string" ? t : el.textContent || "").replace(/\s+/g, " ").trim();
  };
  var labelOf = function (el: Element): string {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      // The label's own words, without the text of controls inside it (a <select>'s options).
      var copy = labels[0]!.cloneNode(true) as HTMLElement;
      var inner = copy.querySelectorAll("select,textarea,input,button");
      for (var r = 0; r < inner.length; r++) inner[r]!.remove();
      var said = (copy.textContent || "").replace(/\s+/g, " ").trim();
      if (said) return said;
    }
    var attrs = ["title", "placeholder", "alt"];
    for (var a = 0; a < attrs.length; a++) {
      var v = el.getAttribute(attrs[a]!);
      if (v && v.trim()) return v.trim();
    }
    if (el.tagName === "INPUT") return /^(submit|button|reset)$/i.test((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "";
    if (el.tagName === "SELECT") return "";
    return textOf(el);
  };
  var roleOf = function (el: Element): string {
    var r = el.getAttribute("role");
    if (r) return r.split(" ")[0]!;
    var tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "INPUT") {
      var t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "submit" || t === "button" || t === "reset") return "button";
    }
    return "textbox";
  };
  var controlsIn = function (el: Element): FoundControl[] {
    var list: Element[] = (el.matches(CONTROLS) ? [el] : []).concat(Array.prototype.slice.call(el.querySelectorAll(CONTROLS)));
    var out: FoundControl[] = [];
    for (var c = 0; c < list.length && out.length < limits.controls; c++) {
      var ctl = list[c]!;
      if (!shown(ctl)) continue;
      var info: FoundControl = { role: roleOf(ctl), name: labelOf(ctl).slice(0, 80) };
      var tag = ctl.tagName;
      var type = ((ctl as HTMLInputElement).type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") info.checked = (ctl as HTMLInputElement).checked;
      else if (tag === "SELECT") info.value = textOf((ctl as HTMLSelectElement).selectedOptions[0] || ctl).slice(0, 80);
      else if ((tag === "INPUT" && type !== "password" && !/^(submit|button|reset|image|file)$/.test(type)) || tag === "TEXTAREA") info.value = ((ctl as HTMLInputElement).value || "").slice(0, 80);
      var raw = ctl.getAttribute(marks.attr);
      if (raw !== null && raw !== "" && !isNaN(Number(raw))) info.index = Number(raw);
      out.push(info);
    }
    return out;
  };
  var inView = function (el: Element) {
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && r.width > 0;
  };
  /** The place's text, cut around the match. */
  var contextOf = function (el: Element): string {
    var t = textOf(el);
    if (t.length <= limits.context) return t;
    var i = t.toLowerCase().indexOf(needle);
    var from = i < 0 ? 0 : Math.max(0, Math.min(i - Math.floor((limits.context - needle.length) / 2), t.length - limits.context));
    return (from > 0 ? "…" : "") + t.slice(from, from + limits.context) + (from + limits.context < t.length ? "…" : "");
  };
  /** The answer: the first limits.places places and the one asked for, each read now (text, controls, in view). */
  var answer = function (places: Element[], counts: number[], total: number, scrolledTo: number | null): PageResult<FoundText> {
    var listed: FoundPlace[] = [];
    for (var q = 0; q < places.length; q++) {
      if (q >= limits.places && q !== target - 1) continue;
      listed.push({ number: q + 1, context: contextOf(places[q]!), matches: counts[q]!, inViewport: inView(places[q]!), controls: controlsIn(places[q]!) });
    }
    return { ok: true, value: { total: total, placeCount: places.length, places: listed, scrolledTo: scrolledTo } };
  };

  // The last search's places: listed again by this call (again, the page unchanged since), else dropped.
  type Kept = { needle: string; target: number; places: Element[]; counts: number[]; total: number; fields: Element[]; values: string[]; changed: boolean; observer: MutationObserver | null };
  var win = window as unknown as Record<string, Kept | undefined>;
  var kept = win[marks.found];
  /** Noa's own overlay (outside the body, never searched): shown, hidden or put back while the agent works. */
  var ours = function (n: Node) {
    return n.nodeType === 1 && (n as Element).tagName.toLowerCase() === marks.overlay;
  };
  var allOurs = function (list: NodeList) {
    for (var o = 0; o < list.length; o++) if (!ours(list[o]!)) return false;
    return true;
  };
  /** A change to the page: anything but read_page numbering its elements and Noa's overlay. */
  var changes = function (records: MutationRecord[]) {
    for (var m = 0; m < records.length; m++) {
      var rec = records[m]!;
      if (rec.type === "attributes" && rec.attributeName === marks.attr) continue;
      if (ours(rec.target)) continue;
      if (rec.type === "childList" && allOurs(rec.addedNodes) && allOurs(rec.removedNodes)) continue;
      return true;
    }
    return false;
  };
  if (kept) {
    win[marks.found] = undefined;
    var unchanged = !kept.changed && !!kept.observer && !changes(kept.observer.takeRecords());
    if (kept.observer) kept.observer.disconnect();
    if (again && unchanged && kept.needle === needle && kept.target === target) {
      for (var f = 0; unchanged && f < kept.fields.length; f++) unchanged = kept.fields[f]!.isConnected && valueOf(kept.fields[f]!) === kept.values[f];
      for (var e = 0; unchanged && e < kept.places.length; e++) unchanged = kept.places[e]!.isConnected;
      if (unchanged) return answer(kept.places, kept.counts, kept.total, null);
    }
  }

  if (document.body) walk(document.body);
  // Every match, by the element its first character is in.
  var hay = parts.join("");
  var hits: Element[] = [];
  var p = 0;
  for (var at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    while (p < pieces.length - 1 && pieces[p]!.end <= at) p++;
    if (pieces[p]) hits.push(pieces[p]!.el);
  }

  // Matches grouped by place, in page order.
  var places: Element[] = [];
  var counts: number[] = [];
  var numbers = new Map<Element, number>();
  for (var h = 0; h < hits.length; h++) {
    var pl = placeOf(hits[h]!);
    var k = numbers.get(pl);
    if (k !== undefined) counts[k]!++;
    else {
      numbers.set(pl, places.length);
      places.push(pl);
      counts.push(1);
    }
  }
  var scrolledTo: number | null = null;
  if (scroll && target <= places.length) {
    places[target - 1]!.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as ScrollBehavior });
    scrolledTo = target;
    // Kept for the call after the page read, watched for any change to the page until then.
    var keep: Kept = { needle: needle, target: target, places: places, counts: counts, total: hits.length, fields: fields, values: values, changed: false, observer: null };
    var observer = new MutationObserver(function (records) {
      if (!changes(records)) return;
      keep.changed = true;
      observer.disconnect();
    });
    var watch: MutationObserverInit = { subtree: true, childList: true, characterData: true, attributes: true };
    observer.observe(document, watch);
    for (var s = 0; s < shadowRoots.length; s++) observer.observe(shadowRoots[s]!, watch);
    keep.observer = observer;
    Object.defineProperty(win, marks.found, { value: keep, configurable: true, writable: true, enumerable: false });
  }
  return answer(places, counts, hits.length, scrolledTo);
}
