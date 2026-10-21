/**
 * What a click or typing on an element meets (coverInPage), and its check state after a click, for both drivers: they run in the page (through chrome.scripting.executeScript, or Runtime.evaluate),
 * serialized with Function.prototype.toString. Keep them self-contained (no imports at run time, no module scope),
 * plain ES2020; what they need comes as arguments (PageMarks).
 */
import type { Aim, AimFor, CheckState, Cover, InputProbe, PageMarks, TypeTarget } from "./driver-common.js";
import type { PageResult } from "./scroll-probe.js";

/**
 * What a click on element `index`, or typing into it (`act`), meets, checked in one go before anything is done to it:
 * its check state (a click), what lies over it where a click would land, and what typing into it means (typing: after
 * the cover, and only when no modal dialog covers it). With "check" or "uncheck", nothing is checked over it when no
 * click follows: it is no checkbox, or it is so already, or it is a radio button to uncheck (clickElement says why).
 * What lies over it (Cover, driver-common.ts), scrolled into view, at its center (inside open shadow roots too):
 * - { x, y }: a point of it that a click reaches (it, something inside it, or its label): its center, or, when something
 *   else (a suggestion list, a sticky header, a banner, a toast) lies over that, another point of it. Tried: points
 *   across its part in the window, scrolled to the center of the window, then to its top and its bottom.
 * - a string: an open modal dialog covers it; the dialog's name ("" when it has none). Modal: a <dialog> opened with
 *   showModal (whose page the browser makes inert) or a visible aria-modal="true" element, in the document or in an
 *   open shadow root. The point hits a modal the element is not in, or a backdrop over the modal the element is in
 *   (stacked modals: the topmost one names it). A modal that leaves the page reachable (no backdrop over it) covers
 *   nothing. snapshotPage marks elements by the same test.
 * - { over, lands, list }: something else covers every point tried. What it is (`the list "Address suggestions"`),
 *   what a click at the element's center lands on instead (`option "41 Harbor Rd"`), and whether it is a list or
 *   menu (a pick or Escape closes those). The element is scrolled back to the center.
 * `moved`: scrolling it into view moved it. The page may still move it in answer to that scroll (a dropdown's list put
 * back where it belongs), after this script: the caller aims again once that is done (aimAt).
 */
export function coverInPage(marks: PageMarks, index: number, act: AimFor, probe?: InputProbe | null): PageResult<Aim> {
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  var aim: Aim = {};
  if (act !== "type") {
    var state = checkState(el);
    aim.state = state;
    if (act !== "click" && (!state.checkable || state.checked === (act === "check") || (act === "uncheck" && state.radio))) return { ok: true, value: aim };
  }
  var was = el.getBoundingClientRect();
  aim.cover = coverOf(el);
  var now = el.getBoundingClientRect();
  if (now.left !== was.left || now.top !== was.top) aim.moved = true;
  if (act === "type" && typeof aim.cover !== "string") {
    var target = typeTarget(el);
    if (!target.ok) return target;
    aim.target = target.value;
  }
  // The click's input check armed here, at the free point, when a click there follows (not to choose a dropdown's
  // option): one script less before a trusted click.
  var free = aim.cover && typeof aim.cover === "object" && "x" in aim.cover ? aim.cover : null;
  if (probe && free && aim.target !== "select" && aim.target !== "listbox") aim.armed = armInputProbe(probe.key, probe.nonce, free.x, free.y);
  return { ok: true, value: aim };

  /**
   * Arms the check of a trusted click at (x, y) (CdpActions.mouseClick): listens (capture, on the window) for the click's
   * pointer and mouse events under `nonce`, at window[key]. False where no answer would be sure: the point is over a
   * frame, whose document gets the events instead.
   */
  function armInputProbe(key: string, nonce: string, x: number, y: number): boolean {
    var at = document.elementFromPoint(x, y);
    if (!at || /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(at.tagName)) return false;
    var p = { nonce: nonce, seen: false };
    (window as unknown as Record<string, unknown>)[key] = p;
    var mark = function () {
      p.seen = true;
    };
    var types = ["pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (var ty = 0; ty < types.length; ty++) window.addEventListener(types[ty]!, mark, { capture: true, once: true });
    return true;
  }

  /** The check state: a checkbox or radio input, an ARIA checkbox / radio / switch (aria-checked), or a <label> of a checkbox or radio input. */
  function checkState(e: HTMLElement): CheckState {
    var target: HTMLElement = e instanceof HTMLLabelElement && e.control ? e.control : e;
    if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
      return { checkable: true, checked: target.checked, radio: target.type === "radio" };
    }
    var role = (target.getAttribute("role") || "").split(" ")[0];
    if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role || "")) {
      return { checkable: true, checked: target.getAttribute("aria-checked") === "true", radio: role === "radio" || role === "menuitemradio" };
    }
    return { checkable: false, checked: false, radio: false };
  }

  /**
   * What typing into element `index` means, decided before anything is clicked:
   * "field" (an input or textarea: its value is replaced), "editor" (a rich
   * editor: text goes at the end), "select" (a dropdown: an option is chosen,
   * selectOptionInPage), "listbox" (a custom dropdown: it is opened and the
   * option clicked, listOptionInPage), or "other" (e.g. a wrapper whose inner editor a click
   * focuses). For "other" the current focus is dropped first, so only a field
   * the click focuses takes the text, never the field that had the focus
   * before. Checkboxes, radio buttons, buttons and links take no text: an
   * error, before anything is clicked.
   */
  function typeTarget(el: HTMLElement): PageResult<TypeTarget> {
    if (el instanceof HTMLSelectElement) return { ok: true, value: "select" };
    if (el instanceof HTMLTextAreaElement) return { ok: true, value: "field" };
    var role = (el.getAttribute("role") || "").split(" ")[0];
    var inputType = el instanceof HTMLInputElement ? (el.type || "text").toLowerCase() : "";
    if (inputType === "checkbox" || inputType === "radio" || role === "checkbox" || role === "radio" || role === "switch") {
      return { ok: false, error: "element " + index + " is a checkbox or radio button, which takes no text: set it with checked (true or false) instead" };
    }
    if (el instanceof HTMLInputElement) {
      if (/^(button|submit|reset|image|file|range|color)$/.test(inputType)) return { ok: false, error: "element " + index + " is an input of type " + inputType + ", which takes no text" };
      return { ok: true, value: "field" };
    }
    if (el.isContentEditable) return { ok: true, value: "editor" };
    // A custom dropdown (a button or div that opens a list of role=option items): its option is chosen, as a <select>'s
    // is. One that holds its own text field (a combobox wrapper around an input) is typed into instead.
    if ((role === "combobox" || el.getAttribute("aria-haspopup") === "listbox") && !el.querySelector('input,textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]')) {
      return { ok: true, value: "listbox" };
    }
    if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || role === "button" || role === "link") {
      return { ok: false, error: "element " + index + " is a " + (role || el.tagName.toLowerCase()) + ", which takes no text: leave out text to click it" };
    }
    /** The focused element, inside shadow roots too (document.activeElement is only their host). */
    function focused(): HTMLElement | null {
      var a = document.activeElement as HTMLElement | null;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
      return a;
    }
    var active = focused();
    // Inside el also through shadow roots: a wrapper's own component may hold the field.
    var inside = false;
    for (var e: Node | null = active; e && !inside; e = e.parentNode || (e as ShadowRoot).host || null) inside = e === el;
    if (active && active !== document.body && !inside) active.blur();
    return { ok: true, value: "other" };
  }

  /** What lies over the element where a click would land (see above). */
  function coverOf(el: HTMLElement): Cover {
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
    var labels = (el as HTMLInputElement).labels;
    /** Whether a click on `hit` reaches the element. */
    function reaches(hit: Element | null): boolean {
      if (!hit || within(el, hit) || within(hit, el)) return true;
      for (var l = 0; labels && l < labels.length; l++) if (within(labels[l]!, hit)) return true;
      return false;
    }
    /** The element's part in the window after scrolling it there (block: where); null when none of it is. */
    function inView(block: ScrollLogicalPosition): { left: number; top: number; width: number; height: number } | null {
      // Already wholly shown: not scrolled to the center, a scroll the page may answer by moving it.
      if (block !== "center" || !shown(el)) el.scrollIntoView({ block: block, inline: "center", behavior: "instant" as ScrollBehavior });
      var b = el.getBoundingClientRect();
      var left = Math.max(b.left, 0);
      var top = Math.max(b.top, 0);
      var width = Math.min(b.right, window.innerWidth) - left;
      var height = Math.min(b.bottom, window.innerHeight) - top;
      return width > 0 && height > 0 ? { left: left, top: top, width: width, height: height } : null;
    }
    /** Whether all of `e` is in the window and inside the box of every element around it that scrolls or clips. */
    function shown(e: Element): boolean {
      var b = e.getBoundingClientRect();
      if (b.width === 0 || b.height === 0 || b.left < 0 || b.top < 0 || b.right > window.innerWidth || b.bottom > window.innerHeight) return false;
      for (var up: Element | null = e.parentElement || ((e.parentNode as ShadowRoot | null)?.host ?? null); up && up !== document.documentElement && up !== document.body; up = up.parentElement || ((up.parentNode as ShadowRoot | null)?.host ?? null)) {
        var st = getComputedStyle(up);
        if (st.overflowX === "visible" && st.overflowY === "visible") continue;
        var ub = up.getBoundingClientRect();
        if (b.left < ub.left || b.top < ub.top || b.right > ub.right || b.bottom > ub.bottom) return false;
      }
      return true;
    }
    var r = inView("center");
    if (!r) {
      var whole = el.getBoundingClientRect();
      return { x: whole.left + whole.width / 2, y: whole.top + whole.height / 2 };
    }
    var hit = topAt(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || reaches(hit)) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    var cover: Element = hit;

    /** An element's accessible name, else its first heading's text. */
    function nameOf(e: Element): string {
      var name = e.getAttribute("aria-label") || "";
      var ids = (e.getAttribute("aria-labelledby") || "").split(/\s+/);
      var root = e.getRootNode() as Document | ShadowRoot;
      for (var k = 0; !name && k < ids.length; k++) {
        var ref = ids[k] ? root.getElementById(ids[k]!) : null;
        if (ref) name = ref.textContent || "";
      }
      if (!name) {
        var heading = e.querySelector("h1, h2, h3, h4, [role=heading]");
        if (heading) name = heading.textContent || "";
      }
      return name.replace(/\s+/g, " ").trim().slice(0, 80);
    }

    // Open modals, in the document and its open shadow roots (in page order).
    var roots: (Document | ShadowRoot)[] = [];
    function collectRoots(root: Document | ShadowRoot): void {
      roots.push(root);
      var hosts = root.querySelectorAll("*");
      for (var ho = 0; ho < hosts.length; ho++) if (hosts[ho]!.shadowRoot) collectRoots(hosts[ho]!.shadowRoot!);
    }
    collectRoots(document);
    var modals = openModals(roots);
    if (modals.length) {
      // A dialog covers it only when the click lands on a backdrop over the page (the topmost dialog's, when the element
      // is not in that one) or in a dialog the element is not in. Anything else (a chat launcher over a button of the
      // dialog, a fixed header while a cookie dialog is open) is checked below like any page, and its own dialog is
      // never named.
      var dialog = coveringModal(cover, el, modals, topmostModal(modals));
      if (dialog) return nameOf(dialog);
    }

    // Something else over its center: a point of it that a click reaches, with it scrolled to the center of the window,
    // then to the top and the bottom.
    var blocks: ScrollLogicalPosition[] = ["center", "start", "end"];
    var at = [0.5, 0.2, 0.8, 0.35, 0.65, 0.05, 0.95];
    for (var bl = 0; bl < blocks.length; bl++) {
      var part = bl === 0 ? r : inView(blocks[bl]!);
      for (var i = 0; part && i < at.length; i++)
        for (var j = 0; j < at.length; j++) {
          var x = part.left + part.width * at[j]!;
          var y = part.top + part.height * at[i]!;
          if (reaches(topAt(x, y))) return { x: x, y: y };
        }
    }
    inView("center");

    // Covered at every point: what covers it, from the element hit up to the nearest list, menu, named or fixed layer
    // (never as far as what holds the element too).
    var ROLES: Record<string, string> = { listbox: "list", menu: "menu", menubar: "menu", tree: "list", grid: "grid", tooltip: "tooltip", dialog: "dialog", alertdialog: "dialog", alert: "notice", status: "notice", banner: "header", navigation: "navigation", complementary: "panel", region: "panel" };
    var TAGS: Record<string, string> = { header: "header", nav: "navigation", footer: "footer", aside: "panel", dialog: "dialog", iframe: "frame", ul: "list", ol: "list" };
    var over: Element = cover;
    var kind = "";
    for (var n: Element | null = cover; n && !within(n, el); n = n.parentElement || ((n.parentNode as ShadowRoot | null)?.host ?? null)) {
      over = n;
      var role = (n.getAttribute("role") || "").split(" ")[0] || "";
      var position = getComputedStyle(n).position;
      kind = ROLES[role] || (role ? "" : TAGS[n.tagName.toLowerCase()] || "") || (n.getAttribute("aria-label") ? "element" : "") || (position === "fixed" || position === "sticky" ? "fixed element" : "");
      if (kind) break;
    }
    var what = nameOf(over);
    // A list without a name: the name of the field it belongs to (aria-controls or aria-owns: a combobox's suggestions).
    var controller = !what && over.id ? (over.getRootNode() as Document | ShadowRoot).querySelector('[aria-controls~="' + CSS.escape(over.id) + '"], [aria-owns~="' + CSS.escape(over.id) + '"]') : null;
    if (controller) {
      var own = (controller as HTMLInputElement).labels;
      what = nameOf(controller) || (own && own.length ? (own[0]!.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : "") || controller.getAttribute("placeholder") || "";
    }
    if (!what) what = ((over as HTMLElement).innerText || over.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
    // What a click would use: the control the hit element is part of, else its text.
    var control = cover.closest('a[href],button,input,select,textarea,label,[role=option],[role=menuitem],[role=button],[role=link],[role=tab],[role=checkbox]');
    var landsOn = control || cover;
    var landsRole = control ? control.getAttribute("role") || (control.tagName === "A" ? "link" : control.tagName.toLowerCase()) : "text";
    var landsText = ((control && control.getAttribute("aria-label")) || (landsOn as HTMLElement).innerText || landsOn.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
    return {
      over: "the " + (kind || "element") + (what ? " " + JSON.stringify(what) : ""),
      lands: landsRole + (landsText ? " " + JSON.stringify(landsText) : ""),
      list: kind === "list" || kind === "menu",
    };
  }
}

/** The check state of element `index` (coverInPage's checkState), read again after a click. */
export function checkStateInPage(marks: PageMarks, index: number): PageResult<CheckState> {
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  return { ok: true, value: checkState(el) };

  /** The check state: a checkbox or radio input, an ARIA checkbox / radio / switch (aria-checked), or a <label> of a checkbox or radio input. */
  function checkState(e: HTMLElement): CheckState {
    var target: HTMLElement = e instanceof HTMLLabelElement && e.control ? e.control : e;
    if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
      return { checkable: true, checked: target.checked, radio: target.type === "radio" };
    }
    var role = (target.getAttribute("role") || "").split(" ")[0];
    if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role || "")) {
      return { checkable: true, checked: target.getAttribute("aria-checked") === "true", radio: role === "radio" || role === "menuitemradio" };
    }
    return { checkable: false, checked: false, radio: false };
  }
}

/**
 * Arms the check of a trusted click at (x, y) (CdpActions.mouseClick): listens (capture, on the window) for the click's
 * pointer and mouse events under `nonce`, at window[key]. False where no answer would be sure: the point is over a
 * frame, whose document gets the events instead.
 */
export function armInputProbe(key: string, nonce: string, x: number, y: number): boolean {
  var at = document.elementFromPoint(x, y);
  if (!at || /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(at.tagName)) return false;
  var p = { nonce: nonce, seen: false };
  (window as unknown as Record<string, unknown>)[key] = p;
  var mark = function () {
    p.seen = true;
  };
  var types = ["pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (var ty = 0; ty < types.length; ty++) window.addEventListener(types[ty]!, mark, { capture: true, once: true });
  return true;
}
