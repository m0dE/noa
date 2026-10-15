import { MAX_CONTEXT_TEXT, MAX_SNAPSHOT_AREAS, MAX_SNAPSHOT_CONTEXTS, MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_OPTIONS, MAX_SNAPSHOT_TEXT, type PageSnapshot } from "@noa/shared";
import { PAGE_MARKS, type PageMarks } from "./driver-common.js";

/** The Runtime.evaluate expression that runs snapshotPage in the page. */
export function snapshotExpression(): string {
  return `(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, ${MAX_SNAPSHOT_TEXT}, ${MAX_SNAPSHOT_ELEMENTS}, ${MAX_SNAPSHOT_OPTIONS}, ${MAX_CONTEXT_TEXT}, ${MAX_SNAPSHOT_CONTEXTS}, ${MAX_SNAPSHOT_AREAS})`;
}

/**
 * Runs inside the page via Runtime.evaluate. It must stay self-contained:
 * no imports, no references to module scope, plain ES2020, because it is
 * serialized with Function.prototype.toString.
 */
export function snapshotPage(marks: PageMarks, maxText: number, maxElements: number, maxOptions: number, maxContextText = 160, maxContexts = 60, maxAreas = 8): PageSnapshot {
  var ATTR = marks.attr;
  var w = window as unknown as Record<string, Element[] | undefined>;
  var old: Element[] = Array.prototype.slice.call(document.querySelectorAll("[" + ATTR + "]")).concat(w[marks.shadow] || []);
  for (var i = 0; i < old.length; i++) old[i]!.removeAttribute(ATTR);
  // The numbered elements inside shadow roots, for the page functions that look a number up (page-input.ts).
  var shadowMarked: Element[] = [];
  Object.defineProperty(w, marks.shadow, { value: shadowMarked, configurable: true, writable: true, enumerable: false });

  var SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="option"]',
    '[role="switch"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  var vw = window.innerWidth;
  var vh = window.innerHeight;

  function clean(s: string | null | undefined, max: number): string {
    return (s || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  /** An element's box, read once: nothing here changes the page's layout while it is read. */
  var boxes = new Map<Element, DOMRect>();
  function boxOf(e: Element): DOMRect {
    var b = boxes.get(e);
    if (!b) {
      b = e.getBoundingClientRect();
      boxes.set(e, b);
    }
    return b;
  }

  /** An element's rendered text (innerText; undefined for one without it, e.g. SVG), read once. */
  var texts = new Map<Element, string | undefined>();
  function textOf(e: Element): string | undefined {
    if (texts.has(e)) return texts.get(e);
    var t = (e as HTMLElement).innerText;
    texts.set(e, t);
    return t;
  }

  function isVisible(el: Element): boolean {
    // No box (display: none on it or on an ancestor, or never rendered) reads as a zero-size box.
    var rect = boxOf(el);
    if (rect.width === 0 || rect.height === 0) return false;
    return getComputedStyle(el).visibility !== "hidden";
  }

  /** The element with this id in el's own document or shadow root, where its aria references point. */
  function byId(el: Element, id: string): Element | null {
    var root = el.getRootNode() as Document | ShadowRoot;
    return root.getElementById ? root.getElementById(id) : document.getElementById(id);
  }

  function implicitRole(el: Element): string {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0]!;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "file") return "file";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    if (tag === "tr") return "row";
    return "generic";
  }

  /** A label's text without the text of controls inside it (a <select> in its label would add every option). */
  function labelText(label: HTMLLabelElement, control: Element): string {
    if (!label.contains(control)) return label.textContent || "";
    var copy = label.cloneNode(true) as HTMLElement;
    var inner = copy.querySelectorAll("select, textarea, input, button");
    for (var k = 0; k < inner.length; k++) inner[k]!.remove();
    return copy.textContent || "";
  }

  /** The page's message for a field that fails validation, once it has a value or the form was submitted; else "". */
  function invalidMessage(el: Element, hasValue: boolean): string {
    if (el.getAttribute("aria-invalid") === "true") {
      var ids = (el.getAttribute("aria-errormessage") || el.getAttribute("aria-describedby") || "").split(/\s+/);
      var said = ids
        .map(function (id) {
          var ref = id ? byId(el, id) : null;
          return ref ? ref.textContent || "" : "";
        })
        .join(" ");
      return clean(said, 160) || "invalid";
    }
    var field = el as HTMLInputElement;
    if (!field.validity || field.validity.valid || !field.willValidate) return "";
    var shown = hasValue;
    try {
      // Set once the user (or a submit) touched it; Chrome 119+.
      shown = shown || el.matches(":user-invalid");
    } catch (e) {
      /* older browsers: only fields with a value */
    }
    return shown ? clean(field.validationMessage, 160) || "invalid" : "";
  }

  function nameOf(el: Element): string {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clean(aria, 120);
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts: string[] = [];
      labelledBy.split(/\s+/).forEach(function (id) {
        var ref = byId(el, id);
        if (ref) parts.push(ref.textContent || "");
      });
      var joined = clean(parts.join(" "), 120);
      if (joined) return joined;
    }
    var labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      var lt = clean(labelText(labels[0]!, el), 120);
      if (lt) return lt;
    }
    var attrs = ["alt", "title", "placeholder"];
    for (var a = 0; a < attrs.length; a++) {
      var v = el.getAttribute(attrs[a]!);
      if (v && v.trim()) return clean(v, 120);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "input") {
      var type = ((el as HTMLInputElement).type || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return clean((el as HTMLInputElement).value, 120);
      return "";
    }
    var text = textOf(el);
    if (text === undefined) text = el.textContent || "";
    if (clean(text, 120)) return clean(text, 120);
    // Icon buttons: fall back to an image's alt text inside.
    var img = el.querySelector("img[alt], svg[aria-label]");
    if (img) return clean(img.getAttribute("alt") || img.getAttribute("aria-label"), 120);
    return "";
  }

  /**
   * Things a script made clickable without its HTML saying so: the outermost box styled cursor: pointer (a table row
   * with a click handler, a card), that is not a control above, inside one, or only a wrapper around one. Labels are
   * left out: their control is listed. Skipped on very large pages, where reading every node's style is too slow.
   */
  function scriptClickables(): Element[] {
    var found: Element[] = [];
    var all = document.body ? document.body.getElementsByTagName("*") : [];
    if (all.length > 20000) return found;
    // Each element's cursor, read once: its parent's was read just before it (page order), unless the parent was skipped.
    var cursors = new Map<Element, string>();
    function cursorOf(e: Element): string {
      var cur = cursors.get(e);
      if (cur === undefined) {
        cur = getComputedStyle(e).cursor;
        cursors.set(e, cur);
      }
      return cur;
    }
    for (var c = 0; c < all.length; c++) {
      var cand = all[c]!;
      if (/^(LABEL|OPTION|SCRIPT|STYLE|svg|path|g|use)$/.test(cand.tagName)) continue;
      if (cursorOf(cand) !== "pointer") continue;
      var parent = cand.parentElement;
      if (parent && cursorOf(parent) === "pointer") continue;
      if (cand.matches(SELECTOR) || (parent && parent.closest(SELECTOR))) continue;
      var ownText = clean((cand as HTMLElement).innerText, 200);
      if (!ownText) continue;
      var control = cand.querySelector(SELECTOR) as HTMLElement | null;
      if (control && clean(control.innerText, 200) === ownText) continue;
      found.push(cand);
    }
    return found;
  }

  /**
   * The controls in page order, with those inside open shadow roots where their host is (web components: a design
   * system's text field keeps its <textarea> in one), and those open shadow roots in `roots`. Closed shadow roots
   * cannot be read.
   */
  function controls(root: Document | ShadowRoot, extra: Set<Element>, out: Element[], roots: ShadowRoot[]): Element[] {
    var all = root.querySelectorAll("*");
    // The root's matches in one query (what e.matches(SELECTOR) says of each of them), looked up per element.
    var hits = new Set(Array.prototype.slice.call(root.querySelectorAll(SELECTOR)) as Element[]);
    for (var c = 0; c < all.length; c++) {
      var e = all[c]!;
      if (hits.has(e) || extra.has(e)) out.push(e);
      if (e.shadowRoot) {
        roots.push(e.shadowRoot);
        controls(e.shadowRoot, extra, out, roots);
      }
    }
    return out;
  }

  var DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
  function inView(r: DOMRect): boolean {
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && r.width > 0;
  }

  // Open modal dialogs: a <dialog> opened with showModal (the browser makes the rest inert), or a visible
  // aria-modal="true" element in the window (a closed off-canvas menu kept aside with a transform is not open), in
  // the document or an open shadow root. Of stacked ones the topmost counts: the last that shows at its own center.
  // An element is covered when the topmost thing at its center (Noa's own overlay aside) is not it (nor its label)
  // but a backdrop over the page (outside the topmost dialog) or a dialog the element is not in: a click there lands
  // on a dialog or a backdrop. coverInPage, which the click and typing check, is the same test.
  var shadowRoots: ShadowRoot[] = [];
  var all = controls(document, new Set(scriptClickables()), [], shadowRoots);
  /** Whether `inner` is `outer` or inside it, through shadow roots too. */
  function within(outer: Node, inner: Node | null): boolean {
    for (var nd: Node | null = inner; nd; nd = nd.parentNode || (nd as ShadowRoot).host || null) if (nd === outer) return true;
    return false;
  }
  /** The topmost element at a point, inside open shadow roots too; Noa's own overlay is not part of the page. */
  function topAt(x: number, y: number): Element | null {
    // The topmost element (elementsFromPoint's first, without listing all below it), else the first under Noa's overlay.
    var hit = document.elementFromPoint(x, y);
    if (hit && hit.tagName.toLowerCase() === marks.overlay) {
      var stack = document.elementsFromPoint(x, y);
      hit = null;
      for (var st = 0; !hit && st < stack.length; st++) if (stack[st]!.tagName.toLowerCase() !== marks.overlay) hit = stack[st]!;
    }
    while (hit && hit.shadowRoot) {
      var deeper = hit.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    return hit;
  }
  /**
   * The open modal dialogs in `roots` (the document and its open shadow roots, in page order): a <dialog> opened with
   * showModal (the browser makes the rest inert), or a visible aria-modal="true" element in the window (a closed
   * off-canvas menu kept aside with a transform is not open).
   */
  function openModals(roots: (Document | ShadowRoot)[]): Element[] {
    var found: Element[] = [];
    for (var ro = 0; ro < roots.length; ro++) {
      try {
        found.push.apply(found, Array.prototype.slice.call(roots[ro]!.querySelectorAll("dialog:modal")));
      } catch (e) {
        /* no :modal (Chrome < 105) */
      }
      var aria = roots[ro]!.querySelectorAll('[aria-modal="true"]');
      for (var am = 0; am < aria.length; am++) {
        var box = aria[am]!.getBoundingClientRect();
        var shows = box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight;
        if (shows && getComputedStyle(aria[am]!).visibility !== "hidden") found.push(aria[am]!);
      }
    }
    return found;
  }
  /** Of stacked modals the topmost: the last that shows at its own center (one opened from another, nested in it or not, comes after it). */
  function topmostModal(modals: Element[]): Element | null {
    for (var tm = modals.length - 1; tm >= 0; tm--) {
      var mr = modals[tm]!.getBoundingClientRect();
      if (within(modals[tm]!, topAt(mr.left + mr.width / 2, mr.top + mr.height / 2))) return modals[tm]!;
    }
    return modals.length ? modals[modals.length - 1]! : null;
  }
  /**
   * Whether `hit`, or a layer it is in that does not hold `e` too, is a backdrop: fixed or absolute and about the
   * window's size (not a page wrapper as tall as the document; never the page's <html> or <body>).
   */
  function overBackdrop(hit: Element, e: Element | null): boolean {
    for (var bd: Element | null = hit; bd && !(e && within(bd, e)); bd = bd.parentElement || ((bd.parentNode as ShadowRoot | null)?.host ?? null)) {
      if (bd === document.documentElement || bd === document.body) break;
      var bb = bd.getBoundingClientRect();
      if (bb.width >= window.innerWidth * 0.9 && bb.height >= window.innerHeight * 0.75 && bb.height <= window.innerHeight * 1.1 && /^(fixed|absolute)$/.test(getComputedStyle(bd).position)) return true;
    }
    return false;
  }
  /**
   * The open modal dialog a click at `hit` lands on instead of `e`: the topmost one (`top`) when `hit` is a backdrop over
   * the page and `e` is not in that dialog; else the innermost one holding `hit` but not `e`. null: no dialog is in the
   * way (anything else over `e`, a chat launcher over a button of the dialog, is not a dialog's cover).
   */
  function coveringModal(hit: Element, e: Element, modals: Element[], top: Element | null): Element | null {
    if (top && overBackdrop(hit, e) && !within(top, e)) return top;
    var innermost: Element | null = null;
    for (var hm = 0; hm < modals.length; hm++) if (within(modals[hm]!, hit) && (!innermost || within(innermost, modals[hm]!))) innermost = modals[hm]!;
    return innermost && !within(innermost, e) ? innermost : null;
  }
  var roots = [document as Document | ShadowRoot].concat(shadowRoots);
  var modals = openModals(roots);
  // Whether anything on the page (the document or an open shadow root) is a dialog: without one no element is in a
  // dialog, and closest is not asked for each.
  var anyDialog = false;
  for (var ad = 0; !anyDialog && ad < roots.length; ad++) anyDialog = !!roots[ad]!.querySelector(DIALOG);
  function inDialog(e: Element): boolean {
    return anyDialog && !!e.closest(DIALOG);
  }
  var topModal = topmostModal(modals);
  function inModal(e: Element): boolean {
    return !!topModal && within(topModal, e);
  }
  /** Whether a click at the center of the element's part in view reaches it (see above). */
  function reachable(e: Element, r: DOMRect): boolean {
    var hit = topAt((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2);
    if (!hit || within(e, hit) || within(hit, e)) return true;
    var lbls = (e as HTMLInputElement).labels;
    for (var lb = 0; lbls && lb < lbls.length; lb++) if (within(lbls[lb]!, hit)) return true;
    return !coveringModal(hit, e, modals, topModal);
  }
  // Whether the page outside the topmost dialog is covered as a whole: a <dialog> opened with showModal makes it
  // inert; else a backdrop (or the dialog) is what each corner of the window shows. Then the controls behind it
  // that are out of view are covered too.
  var pageCovered = false;
  if (topModal) {
    var nativeModal = false;
    try {
      nativeModal = topModal.matches("dialog:modal");
    } catch (e) {
      /* no :modal */
    }
    pageCovered = nativeModal;
    if (!pageCovered) {
      pageCovered = true;
      var corners = [
        [4, 4],
        [vw - 4, 4],
        [4, vh - 4],
        [vw - 4, vh - 4],
      ];
      for (var cn = 0; pageCovered && cn < corners.length; cn++) {
        var ch = topAt(corners[cn]![0]!, corners[cn]![1]!);
        pageCovered = !!ch && (within(topModal, ch) || overBackdrop(ch, null));
      }
    }
  }

  var elements: PageSnapshot["elements"] = [];
  function listable(e: Element): boolean {
    var type = e.tagName === "INPUT" ? ((e as HTMLInputElement).type || "text").toLowerCase() : undefined;
    if (type === "hidden") return false;
    return type === "file" || isVisible(e);
  }
  // The listable controls in page order, up to one past the cap (isVisible is the costly part: a page within the cap
  // pays nothing more).
  var head: Element[] = [];
  var n = 0;
  for (; n < all.length && head.length <= maxElements; n++) if (listable(all[n]!)) head.push(all[n]!);
  var truncated = head.length > maxElements;
  var nodes = head;
  if (truncated) {
    // Too many to list: an open dialog's controls first (it covers the page, and a dialog mounted at the end of the
    // page would otherwise be cut), then those in view, then the rest in page order; numbered in page order. Past the
    // head only those two kinds are checked, and the head alone has enough of the rest.
    var first: Element[] = [];
    var second: Element[] = [];
    var sort = function (e: Element) {
      if (inDialog(e)) first.push(e);
      else if (inView(boxOf(e))) second.push(e);
    };
    for (var h = 0; h < head.length; h++) sort(head[h]!);
    for (; n < all.length; n++) {
      var e = all[n]!;
      if ((inDialog(e) || inView(boxOf(e))) && listable(e)) sort(e);
    }
    var keep = new Set<Element>();
    var tiers = [first, second, head];
    for (var t = 0; t < tiers.length && keep.size < maxElements; t++) {
      for (var k = 0; k < tiers[t]!.length && keep.size < maxElements; k++) keep.add(tiers[t]![k]!);
    }
    nodes = all.filter(function (x) {
      return keep.has(x);
    });
  }
  // The post, section or dialog an element is in: the nearest article, dialog, or labelled region or form.
  var CONTAINER =
    'article, [role="article"], [role="dialog"], [role="alertdialog"], dialog, [role="region"][aria-label], [role="region"][aria-labelledby], section[aria-label], section[aria-labelledby], form[aria-label], form[aria-labelledby]';
  var contexts: string[] = [];
  var contextIds = new Map<Element, number>();
  function contextOf(e: Element): number | null {
    var box = e.parentElement ? e.parentElement.closest(CONTAINER) : null;
    if (!box) return null;
    var known = contextIds.get(box);
    if (known !== undefined) return known;
    if (contexts.length >= maxContexts) return null;
    var label = clean(box.getAttribute("aria-label"), 80);
    var inner = (box as HTMLElement).innerText;
    var shown = clean(inner === undefined ? box.textContent : inner, maxContextText);
    var said = clean(label && shown.indexOf(label) !== 0 ? label + ": " + shown : shown, maxContextText);
    if (!said) return null;
    contexts.push(said);
    contextIds.set(box, contexts.length - 1);
    return contexts.length - 1;
  }
  for (var m = 0; m < nodes.length; m++) {
    var el = nodes[m]!;
    var tag = el.tagName.toLowerCase();
    var inputType = tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : undefined;
    var index = elements.length;
    el.setAttribute(ATTR, String(index));
    if (el.getRootNode() !== document) shadowMarked.push(el);
    var rect = boxOf(el);
    var info: PageSnapshot["elements"][number] = {
      index: index,
      tag: tag,
      role: implicitRole(el),
      name: nameOf(el),
      inViewport: inView(rect),
    };
    if (inputType) info.type = inputType;
    if (tag !== "input" && tag !== "textarea" && tag !== "select") {
      var inner = textOf(el);
      var innerClean = clean(inner === undefined ? el.textContent : inner, 120);
      if (innerClean && innerClean !== info.name) info.text = innerClean;
    }
    var checkable = inputType === "checkbox" || inputType === "radio";
    if (tag === "select") {
      var select = el as HTMLSelectElement;
      var chosen = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
      // What the person sees chosen (the option's label), unless it is an empty placeholder.
      if (chosen && chosen.value !== "") info.value = clean(chosen.label || chosen.text, 200);
      var labels: string[] = [];
      for (var o = 0; o < select.options.length && labels.length < maxOptions; o++) {
        var opt = select.options[o]!;
        var optLabel = clean(opt.label || opt.text, 60);
        if (optLabel && opt.value !== "") labels.push(optLabel);
      }
      if (labels.length) info.options = labels;
    } else if ((tag === "input" && !checkable) || tag === "textarea") {
      var value = (el as HTMLInputElement).value;
      if (value) info.value = inputType === "password" ? "********" : value.slice(0, 200);
    } else if (checkable && (el as HTMLInputElement).value !== "on") {
      // A checkbox's or radio's value says which option it is (value="11-50"), not what was entered.
      info.value = (el as HTMLInputElement).value.slice(0, 200);
    }
    var ariaRole = (el.getAttribute("role") || "").split(" ")[0];
    if (checkable) info.checked = (el as HTMLInputElement).checked;
    else if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(ariaRole || "")) info.checked = el.getAttribute("aria-checked") === "true";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if ((el as HTMLInputElement).required || el.getAttribute("aria-required") === "true") info.required = true;
      var invalid = invalidMessage(el, !checkable && !!(el as HTMLInputElement).value);
      if (invalid) info.invalid = invalid;
    } else if (el.getAttribute("aria-required") === "true") info.required = true;
    if (tag !== "input" && tag !== "textarea" && tag !== "select" && el.getAttribute("aria-invalid") === "true") info.invalid = invalidMessage(el, true);
    var href = tag === "a" ? (el as HTMLAnchorElement).href : null;
    if (href) info.href = href.slice(0, 500);
    var testId = el.getAttribute("data-testid");
    if (testId) info.testId = testId;
    if ((el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true") info.disabled = true;
    if (inDialog(el)) info.inDialog = true;
    // What a click opens (aria-haspopup: "true" is a menu; other values are not a popup), and whether it is open.
    var popup = (el.getAttribute("aria-haspopup") || "").trim().toLowerCase();
    if (popup === "true") popup = "menu";
    if (/^(menu|listbox|tree|grid|dialog)$/.test(popup)) info.popup = popup as NonNullable<typeof info.popup>;
    var expanded = el.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") info.expanded = expanded === "true";
    var ctx = contextOf(el);
    if (ctx !== null) info.context = ctx;
    if (modals.length && info.inViewport && !reachable(el, rect)) info.covered = true;
    if (pageCovered && !info.inViewport && !inModal(el)) info.covered = true;
    elements.push(info);
  }

  /**
   * Scrollable areas in view (not the page) whose content goes on past what they show: a box with overflow auto or
   * scroll, at least MIN_AREA_HEIGHT tall, with more than MIN_AREA_HIDDEN px out of view. Each gets a number (its
   * own, when it is listed) so that a scroll can be aimed inside it. Those in an open dialog first.
   */
  function scrollAreas(): NonNullable<PageSnapshot["areas"]> {
    var MIN_AREA_HEIGHT = 40;
    var MIN_AREA_HIDDEN = 8;
    var GRID = 12;
    var found: HTMLElement[] = [];
    if (!document.body) return [];
    // Not every element of the page is checked (that costs tens of ms on a large page): only the ancestors of the
    // listed elements in view and of what shows on a grid of points over the window, which every area in view
    // larger than a grid cell is.
    var seen = new Set<Element>();
    var climb = function (from: Element | null) {
      for (var at: Element | null = from; at && !seen.has(at); ) {
        seen.add(at);
        var node = at as HTMLElement;
        if (node !== document.scrollingElement && node !== document.body && node.clientHeight >= MIN_AREA_HEIGHT && node.scrollHeight - node.clientHeight > MIN_AREA_HIDDEN) {
          var oy = getComputedStyle(node).overflowY;
          if ((oy === "auto" || oy === "scroll" || oy === "overlay") && isVisible(node) && inView(boxOf(node))) found.push(node);
        }
        at = at.parentElement || ((at.getRootNode() as ShadowRoot).host ?? null);
      }
    };
    for (var e = 0; e < nodes.length; e++) if (elements[e]!.inViewport) climb(nodes[e]!);
    for (var gx = 0; gx < GRID; gx++) {
      for (var gy = 0; gy < GRID; gy++) climb(document.elementFromPoint(((gx + 0.5) * vw) / GRID, ((gy + 0.5) * vh) / GRID));
    }
    // In page order, as before.
    found.sort(function (a, b) {
      return a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    found.sort(function (a, b) {
      return (inDialog(b) ? 1 : 0) - (inDialog(a) ? 1 : 0);
    });
    var next = elements.length;
    var out: NonNullable<PageSnapshot["areas"]> = [];
    for (var i = 0; i < found.length && out.length < maxAreas; i++) {
      var area = found[i]!;
      var box = boxOf(area);
      var own = area.getAttribute(ATTR);
      var number = own !== null ? Number(own) : next++;
      if (own === null) {
        area.setAttribute(ATTR, String(number));
        if (area.getRootNode() !== document) shadowMarked.push(area);
      }
      var info: NonNullable<PageSnapshot["areas"]>[number] = {
        index: number,
        height: Math.round(area.clientHeight),
        above: Math.round(area.scrollTop),
        below: Math.max(0, Math.round(area.scrollHeight - area.clientHeight - area.scrollTop)),
      };
      var label = labelOfArea(area);
      if (label) info.label = label;
      // What it shows: the listed elements inside it that are in its box, else its lines of text.
      var shown: string[] = [];
      for (var k = 0; k < nodes.length; k++) {
        var inside = nodes[k]!;
        if (inside === area || !area.contains(inside)) continue;
        var r = boxOf(inside);
        if (r.bottom <= box.top || r.top >= box.bottom) continue;
        var said = clean(elements[k]!.name || elements[k]!.text, 60);
        if (said) shown.push(said);
      }
      if (!shown.length) {
        var lines = (textOf(area) || "").split("\n");
        for (var l = 0; l < lines.length; l++) {
          var line = clean(lines[l], 60);
          if (line) shown.push(line);
        }
      }
      if (shown.length) info.first = shown[0]!;
      if (shown.length > 1) info.last = shown[shown.length - 1]!;
      if (inDialog(area)) info.inDialog = true;
      out.push(info);
    }
    return out;
  }

  /** An area's label: its aria-label or aria-labelledby, else the short text of the element just before it (a heading), looked for up to 3 levels up. */
  function labelOfArea(area: HTMLElement): string {
    var aria = clean(area.getAttribute("aria-label"), 60);
    if (aria) return aria;
    var by = (area.getAttribute("aria-labelledby") || "").split(/\s+/)[0];
    var named = by ? byId(area, by) : null;
    if (named) return clean(textOf(named) || named.textContent, 60);
    var at: Element | null = area;
    for (var up = 0; at && up < 3; up++, at = at.parentElement) {
      for (var prev = at.previousElementSibling; prev; prev = prev.previousElementSibling) {
        var t = clean(textOf(prev) || "", 61);
        if (t && t.length <= 60) return t;
        if (t) break;
      }
    }
    return "";
  }

  var bodyText = document.body ? document.body.innerText || "" : "";
  var allText = bodyText
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
  var text = allText.slice(0, maxText);

  // Frames of other sites (not other extensions'): shown, but their content cannot be read from this page.
  var frames: { url: string; title: string }[] = [];
  var iframes = document.querySelectorAll("iframe");
  for (var f = 0; f < iframes.length && frames.length < 5; f++) {
    var frame = iframes[f]!;
    var src = frame.src || "";
    if (!/^https?:/i.test(src) || !isVisible(frame)) continue;
    var box = frame.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) continue;
    var sameSite = false;
    try {
      sameSite = new URL(src).origin === location.origin;
    } catch (e) {
      /* not a URL */
    }
    if (!sameSite) frames.push({ url: src.slice(0, 200), title: clean(frame.title || frame.getAttribute("aria-label"), 80) });
  }
  var areas = scrollAreas();
  var snap: PageSnapshot = { url: location.href, title: document.title, text: text, elements: elements, truncated: truncated };
  if (areas.length) snap.areas = areas;
  if (allText.length > maxText) snap.textCut = true;
  if (frames.length) snap.frames = frames;
  if (contexts.length) snap.contexts = contexts;
  return snap;
}
