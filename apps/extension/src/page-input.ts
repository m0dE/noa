/**
 * Input page functions, for both drivers: they run in the page (through
 * chrome.scripting.executeScript, or Runtime.evaluate), serialized with
 * Function.prototype.toString. Keep them self-contained (no imports at run
 * time, no module scope), plain ES2020; what they need comes as arguments
 * (PageMarks).
 */
import type { ClickPoint, PageMarks } from "./driver-common.js";
import type { PageResult } from "./scroll-probe.js";

/**
 * A click on element `index` from script, as a person's would go: at `at` (a point of it coverInPage found free,
 * where it left the element), else scrolled into view and at its center.
 */
export function clickInPage(marks: PageMarks, index: number, at?: ClickPoint): PageResult<true> {
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  if (!at) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  var r = el.getBoundingClientRect();
  var x = at ? at.x : r.left + r.width / 2;
  var y = at ? at.y : r.top + r.height / 2;
  // Like a real click, hit the topmost element at that point when it is part of the target.
  var hit = document.elementFromPoint(x, y) as HTMLElement | null;
  var target: HTMLElement = hit && (hit === el || el.contains(hit)) ? hit : el;
  var common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
  var pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  target.dispatchEvent(new PointerEvent("pointerover", Object.assign({}, common, pointer)));
  target.dispatchEvent(new MouseEvent("mouseover", common));
  target.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ buttons: 1 }, common, pointer)));
  var downOk = target.dispatchEvent(new MouseEvent("mousedown", Object.assign({ buttons: 1 }, common)));
  // Untrusted mousedown does not move focus; do it like the browser would.
  if (downOk) {
    var focusable = target.closest('a[href],button,input,textarea,select,[tabindex],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') as HTMLElement | null;
    (focusable || el).focus({ preventScroll: true });
  }
  target.dispatchEvent(new PointerEvent("pointerup", Object.assign({ buttons: 0 }, common, pointer)));
  target.dispatchEvent(new MouseEvent("mouseup", Object.assign({ buttons: 0 }, common)));
  // A dispatched click runs activation behavior: links navigate, buttons submit, checkboxes toggle.
  target.dispatchEvent(new MouseEvent("click", Object.assign({ buttons: 0, detail: 1 }, common)));
  return { ok: true, value: true };
}

/**
 * After the click that focused element `index` (typeTargetInPage said what it
 * is): a field is selected whole, or emptied when its type has no selection
 * (email, number), so the text replaces its value; a rich editor gets the
 * caret at the end (a selection the agent made inside it is kept), or, when
 * the text is empty (`whole`), its whole content selected, so inserting the
 * empty text empties it. For "other", the focus must now be on a field or
 * editor, else nothing is typed.
 */
export function prepareTypingInPage(marks: PageMarks, index: number, whole?: boolean): PageResult<true> {
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  var target = el;
  /** The focused element, inside shadow roots too (document.activeElement is only their host). */
  function focused(): HTMLElement | null {
    var a = document.activeElement as HTMLElement | null;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
    return a;
  }
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
    var active = focused();
    var editable = !!active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable);
    if (!active || active === document.body || !editable) {
      return { ok: false, error: "element " + index + " did not focus a text field when clicked, so nothing was typed. If it opens one, click it first (no text), then type into that field" };
    }
    target = active;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (focused() !== target) target.focus();
    if (target.value === "") return { ok: true, value: true };
    target.select();
    if (target.selectionStart === 0 && target.selectionEnd === target.value.length) return { ok: true, value: true };
    // No selection for this type: empty it the way frameworks (React) notice, then the text is inserted.
    var proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(target, "");
    else target.value = "";
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    return { ok: true, value: true };
  }
  if (!target.contains(focused())) target.focus();
  var sel = getSelection();
  if (sel && (whole || !(sel.anchorNode && target.contains(sel.anchorNode) && !sel.isCollapsed))) {
    var range = document.createRange();
    range.selectNodeContents(target);
    if (!whole) range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return { ok: true, value: true };
}

/**
 * Chooses the option of the <select> `index` that `text` names: its label or
 * value (case and spacing ignored), else the one option whose label starts
 * with or contains it. Fires input and change like a person's choice. Returns
 * the chosen option's label; an unknown or ambiguous name is an error that
 * lists the options.
 */
export function selectOptionInPage(marks: PageMarks, index: number, text: string): PageResult<string> {
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null);
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "element " + index + " is not a dropdown (<select>)" };
  var select = el;
  function norm(s: string): string {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }
  function labelOf(o: HTMLOptionElement): string {
    return (o.label || o.text || "").replace(/\s+/g, " ").trim();
  }
  var want = norm(text);
  var options = Array.prototype.slice.call(select.options).filter(function (o: HTMLOptionElement) {
    return !o.disabled;
  }) as HTMLOptionElement[];
  function only(pred: (o: HTMLOptionElement) => boolean): HTMLOptionElement[] {
    return options.filter(pred);
  }
  var found = only(function (o) {
    return norm(labelOf(o)) === want;
  });
  if (!found.length) found = only(function (o) {
    return norm(o.value) === want;
  });
  if (!found.length && want) found = only(function (o) {
    return norm(labelOf(o)).indexOf(want) === 0;
  });
  if (!found.length && want) found = only(function (o) {
    return norm(labelOf(o)).indexOf(want) >= 0;
  });
  if (found.length !== 1) {
    var listed = (found.length ? found : options).slice(0, 40).map(function (o) {
      return JSON.stringify(labelOf(o));
    });
    var what = found.length ? "matches several options" : "matches no option";
    return { ok: false, error: JSON.stringify(text) + " " + what + " of dropdown " + index + "; its options" + (found.length ? " that match" : "") + ": " + listed.join(", ") };
  }
  var option = found[0]!;
  if (!option.selected) {
    select.focus();
    if (select.multiple) option.selected = true;
    else {
      // The prototype setter, so frameworks that track the value see the change.
      var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
      if (setter && setter.set) setter.set.call(select, option.index);
      else select.selectedIndex = option.index;
    }
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { ok: true, value: labelOf(option) };
}

/**
 * Sets the check state of element `index` when a click did not (e.g. it hit
 * something covering the box): an untrusted click() on the input, which
 * toggles it and fires input and change. Returns the state afterwards.
 */
export function setCheckedInPage(marks: PageMarks, index: number, checked: boolean): PageResult<boolean> {
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  var target: HTMLElement = el instanceof HTMLLabelElement && el.control ? el.control : el;
  function state(): boolean {
    return target instanceof HTMLInputElement ? target.checked : target.getAttribute("aria-checked") === "true";
  }
  if (state() !== checked) target.click();
  return { ok: true, value: state() };
}

/**
 * Inserts text into element `index` (prepareTypingInPage ran first), or at the
 * focus when index is null. In a rich editor, the beforeinput typing fires
 * goes first (an editor that cancels it inserts the text itself). Then
 * execCommand("insertText"), which fires input like typing (but no
 * beforeinput) and works in inputs, textareas and rich editors; else the
 * value is set directly.
 */
export function insertTextInPage(marks: PageMarks, index: number | null, text: string): PageResult<true> {
  /** The focused element, inside shadow roots too (document.activeElement is only their host). */
  function focused(): HTMLElement | null {
    var a = document.activeElement as HTMLElement | null;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
    return a;
  }
  var el: HTMLElement | null;
  if (index == null) {
    el = focused();
    if (!el || el === document.body) return { ok: false, error: "nothing is focused to paste into; click a field first" };
  } else {
    el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
    if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  }
  var isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (index != null && !isField && !el.isContentEditable) el.focus();
  var target = (index == null ? el : el.isContentEditable || isField ? el : focused()) || el;
  var editor = !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.isContentEditable;
  /**
   * The beforeinput a person's edit fires first, over the selection (execCommand fires none). True when the page
   * cancelled it: an editor that applies edits to its own model and renders them (Slate) has made it, and the
   * browser's edit must not follow; one that lets it through gets the browser's edit next, as with typing.
   */
  function editorTook(inputType: string, data: string | null): boolean {
    if (!editor) return false;
    var sel = getSelection();
    var ranges: StaticRange[] = [];
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0);
      ranges.push(new StaticRange({ startContainer: r.startContainer, startOffset: r.startOffset, endContainer: r.endContainer, endOffset: r.endOffset }));
    }
    return !target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: inputType, data: data, targetRanges: ranges }));
  }
  if (text === "" && index != null && editor) {
    // An empty text empties the editor: prepareTypingInPage selected all of it, and replacing the selection is an
    // edit the editor's own code handles (beforeinput, or the browser's edit it observes). Setting its DOM instead
    // would leave the editor's model (ProseMirror, Lexical, Slate) holding the old text, which it shows and saves
    // again. typeIntoElement reads it back, and presses Backspace on it when text is left, as the debugger does.
    try {
      if (!editorTook("insertText", "")) document.execCommand("insertText", false, "");
    } catch (e) {
      // Read back by typeIntoElement.
    }
    return { ok: true, value: true };
  }
  if (editorTook("insertText", text)) return { ok: true, value: true };
  var before = isField ? (target as HTMLInputElement).value : target.textContent;
  var done = false;
  // The input event execCommand fires: the page got the edit, even when an editor renders it a moment later (Lexical
  // puts its own DOM back at once and renders the text from its model after).
  var inputs = 0;
  var counted = function () {
    inputs++;
  };
  document.addEventListener("input", counted, true);
  try {
    done = document.execCommand("insertText", false, text);
  } catch (e) {
    done = false;
  } finally {
    document.removeEventListener("input", counted, true);
  }
  var after = isField ? (target as HTMLInputElement).value : target.textContent;
  // Retyping a field's own value changes nothing, yet it was typed: a focused field is trusted.
  if (done && (after !== before || (editor && inputs > 0) || (isField && focused() === target))) return { ok: true, value: true };
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    // Use the prototype setter so frameworks that track the value (React) see the change.
    var proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    // In place of the selection (prepareTypingInPage selected the whole value), else at the end.
    var start = target.selectionStart;
    var end = target.selectionEnd;
    var next = typeof start === "number" && typeof end === "number" ? target.value.slice(0, start) + text + target.value.slice(end) : target.value + text;
    if (setter && setter.set) setter.set.call(target, next);
    else target.value = next;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: true };
  }
  if (target.isContentEditable) {
    // Text goes at the end (an empty text was handled above).
    target.appendChild(document.createTextNode(text));
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return { ok: true, value: true };
  }
  return { ok: false, error: "the element does not accept text" };
}

/**
 * The text left in what browser.type typed into: element `index` when it is
 * a field or a rich editor, else the field its click focused. For an editor,
 * its text without the blank lines and zero-width characters editors keep in
 * an empty one. null when there is no such field.
 */
export function typedTextInPage(marks: PageMarks, index: number): PageResult<string | null> {
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    ((window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || []).filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  var target: HTMLElement | null = el;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
    target = document.activeElement as HTMLElement | null;
    while (target && target.shadowRoot && target.shadowRoot.activeElement) target = target.shadowRoot.activeElement as HTMLElement;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return { ok: true, value: target.value };
  if (!target || !target.isContentEditable) return { ok: true, value: null };
  return { ok: true, value: (target.textContent || "").replace(/[\s\u200b\ufeff]+/g, " ").trim() };
}

interface PageKey {
  key: string;
  code: string;
  keyCode: number;
  text?: string | null;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/**
 * Dispatches keydown/keypress/keyup at the focus. Untrusted key events have no
 * default action, so the common ones are performed here when the page does not
 * cancel keydown: typing a character, Backspace/Delete, Enter (new line in
 * editors, form.requestSubmit() in a single-line input), Control/Meta+A.
 * Other defaults (Tab focus moves, arrows, shortcuts of the browser) do not happen.
 */
export function pressKeyInPage(k: PageKey): PageResult<true> {
  /** The focused element, inside shadow roots too (document.activeElement is only their host). */
  function focused(): HTMLElement | null {
    var a = document.activeElement as HTMLElement | null;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
    return a;
  }
  var target = focused() || document.body;
  // Chrome may drop null arguments' fields; treat a missing text as no text.
  var text = typeof k.text === "string" ? k.text : null;
  var init = {
    key: k.key,
    code: k.code,
    keyCode: k.keyCode,
    which: k.keyCode,
    altKey: k.alt,
    ctrlKey: k.ctrl,
    metaKey: k.meta,
    shiftKey: k.shift,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  var down = target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (down && text !== null) {
    var charCode = k.key === "Enter" ? 13 : text.charCodeAt(0);
    down = target.dispatchEvent(new KeyboardEvent("keypress", Object.assign({}, init, { keyCode: charCode, which: charCode, charCode: charCode })));
  }
  if (down) {
    var field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    var editable = field || target.isContentEditable;
    var shortcut = k.ctrl || k.meta || k.alt;
    /**
     * The key's edit. In a rich editor, first the beforeinput the key fires (execCommand fires none) over the
     * selection: an editor that cancels it applies the edit to its own model (Slate), else the browser's edit follows.
     */
    var edit = function (inputType: string, data: string | null, command: string, value?: string) {
      if (!field) {
        var sel = getSelection();
        var ranges: StaticRange[] = [];
        if (sel && sel.rangeCount) {
          var r = sel.getRangeAt(0);
          ranges.push(new StaticRange({ startContainer: r.startContainer, startOffset: r.startOffset, endContainer: r.endContainer, endOffset: r.endOffset }));
        }
        if (!target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: inputType, data: data, targetRanges: ranges }))) return;
      }
      document.execCommand(command, false, value);
    };
    if (k.key === "Enter" && !shortcut) {
      if (target instanceof HTMLInputElement) {
        if (target.form) target.form.requestSubmit();
      } else if (target instanceof HTMLTextAreaElement) {
        document.execCommand("insertText", false, "\n");
      } else if (target.isContentEditable) {
        edit("insertParagraph", null, "insertParagraph");
      } else if (target instanceof HTMLAnchorElement || target instanceof HTMLButtonElement) {
        target.click();
      }
    } else if ((k.ctrl || k.meta) && k.key.toLowerCase() === "a") {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select();
      else document.execCommand("selectAll");
    } else if (editable && !shortcut && (k.key === "Backspace" || k.key === "Delete")) {
      if (k.key === "Backspace") edit("deleteContentBackward", null, "delete");
      else edit("deleteContentForward", null, "forwardDelete");
    } else if (editable && !shortcut && text !== null) {
      edit("insertText", text, "insertText", text);
    }
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true, value: true };
}

export function viewportInPage(): PageResult<{ w: number; h: number }> {
  return { ok: true, value: { w: window.innerWidth, h: window.innerHeight } };
}

/**
 * Whether element `index` (or the field inside it) searches as you type: a search field by its HTML (type=search,
 * role searchbox or combobox, aria-autocomplete, in a search landmark) or by its label (aria-label, placeholder,
 * name, title or a <label> that says search, filter or find). Such a field often searches a moment after the typing
 * stops (a debounce), so its results are waited for longer (see CdpActions.type).
 */
export function searchFieldInPage(marks: PageMarks, index: number): PageResult<boolean> {
  var shadow = (window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || [];
  var el: Element | null =
    document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    shadow.filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null;
  if (!el) return { ok: true, value: false };
  var field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : el.querySelector("input, textarea") || el;
  var role = (field.getAttribute("role") || el.getAttribute("role") || "").split(" ")[0];
  var auto = (field.getAttribute("aria-autocomplete") || "").toLowerCase();
  if ((field instanceof HTMLInputElement && field.type === "search") || role === "searchbox" || role === "combobox" || auto === "list" || auto === "both") return { ok: true, value: true };
  if (field.closest('[role="search"], search')) return { ok: true, value: true };
  var labels = (field as HTMLInputElement).labels;
  var said = [field.getAttribute("aria-label"), field.getAttribute("placeholder"), field.getAttribute("name"), field.getAttribute("title")];
  if (labels) for (var i = 0; i < labels.length; i++) said.push(labels[i]!.textContent);
  return { ok: true, value: /\b(search|filter|find)/i.test(said.join(" ")) };
}

/**
 * The window's size, and what one scroll `amount` is measured against: for a scroll inside element `index`, the
 * box that scrolls there on each axis (the element or its nearest ancestor that scrolls that way, not the page), so
 * that a list a few rows tall moves by about its own height, not the window's (which would skip rows). Without
 * one, the window.
 */
export function scrollViewInPage(marks: PageMarks, index: number | null): PageResult<{ w: number; h: number; stepW: number; stepH: number }> {
  var w = window.innerWidth;
  var h = window.innerHeight;
  var out = { w: w, h: h, stepW: w, stepH: h };
  if (index === null) return { ok: true, value: out };
  var shadow = (window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || [];
  var el: Element | null =
    document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    shadow.filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null;
  var page = document.scrollingElement;
  var foundY = false;
  var foundX = false;
  var scrolls = function (o: string) {
    return o === "auto" || o === "scroll" || o === "overlay";
  };
  for (var at: Element | null = el; at && at !== page && at !== document.body && !(foundX && foundY); ) {
    var st = getComputedStyle(at);
    if (!foundY && at.scrollHeight > at.clientHeight && scrolls(st.overflowY)) {
      out.stepH = Math.min(h, at.clientHeight);
      foundY = true;
    }
    if (!foundX && at.scrollWidth > at.clientWidth && scrolls(st.overflowX)) {
      out.stepW = Math.min(w, at.clientWidth);
      foundX = true;
    }
    var root = at.getRootNode() as Document | ShadowRoot;
    at = at.parentElement || ((root as ShadowRoot).host ?? null);
  }
  return { ok: true, value: out };
}
