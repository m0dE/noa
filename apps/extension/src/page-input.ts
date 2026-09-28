/**
 * Input page functions, for both drivers: they run in the page (through
 * chrome.scripting.executeScript, or Runtime.evaluate), serialized with
 * Function.prototype.toString. Keep them self-contained (no imports at run
 * time, no module scope), plain ES2020; what they need comes as arguments
 * (PageMarks).
 */
import type { CheckState, PageMarks, TypeTarget } from "./driver-common.js";
import type { PageResult } from "./scroll-probe.js";

export function clickInPage(marks: PageMarks, index: number): PageResult<true> {
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;
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
 * What typing into element `index` means, decided before anything is clicked:
 * "field" (an input or textarea: its value is replaced), "editor" (a rich
 * editor: text goes at the end), "select" (a dropdown: an option is chosen,
 * selectOptionInPage), or "other" (e.g. a wrapper whose inner editor a click
 * focuses). For "other" the current focus is dropped first, so only a field
 * the click focuses takes the text, never the field that had the focus
 * before. Checkboxes, radio buttons, buttons and links take no text: an
 * error, before anything is clicked.
 */
export function typeTargetInPage(marks: PageMarks, index: number): PageResult<TypeTarget> {
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
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
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || role === "button" || role === "link") {
    return { ok: false, error: "element " + index + " is a " + (role || el.tagName.toLowerCase()) + ", which takes no text: leave out text to click it" };
  }
  var active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && !el.contains(active)) active.blur();
  return { ok: true, value: "other" };
}

/**
 * After the click that focused element `index` (typeTargetInPage said what it
 * is): a field is selected whole, or emptied when its type has no selection
 * (email, number), so the text replaces its value; a rich editor gets the
 * caret at the end (a selection the agent made inside it is kept). For
 * "other", the focus must now be on a field or editor, else nothing is typed.
 */
export function prepareTypingInPage(marks: PageMarks, index: number): PageResult<true> {
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  var target = el;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
    var active = document.activeElement as HTMLElement | null;
    var editable = !!active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable);
    if (!active || active === document.body || !editable) {
      return { ok: false, error: "element " + index + " did not focus a text field when clicked, so nothing was typed. If it opens one, click it first (no text), then type into that field" };
    }
    target = active;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (document.activeElement !== target) target.focus();
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
  if (!target.contains(document.activeElement)) target.focus();
  var sel = getSelection();
  if (sel && !(sel.anchorNode && target.contains(sel.anchorNode) && !sel.isCollapsed)) {
    var range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
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
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]');
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
 * The check state of element `index`: a checkbox or radio input, an ARIA
 * checkbox / radio / switch (aria-checked), or a <label> of a checkbox or
 * radio input (the state of that input).
 */
export function checkStateInPage(marks: PageMarks, index: number): PageResult<CheckState> {
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  var target: HTMLElement = el instanceof HTMLLabelElement && el.control ? el.control : el;
  if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
    return { ok: true, value: { checkable: true, checked: target.checked, radio: target.type === "radio" } };
  }
  var role = (target.getAttribute("role") || "").split(" ")[0];
  if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role || "")) {
    return { ok: true, value: { checkable: true, checked: target.getAttribute("aria-checked") === "true", radio: role === "radio" || role === "menuitemradio" } };
  }
  return { ok: true, value: { checkable: false, checked: false, radio: false } };
}

/**
 * Sets the check state of element `index` when a click did not (e.g. it hit
 * something covering the box): an untrusted click() on the input, which
 * toggles it and fires input and change. Returns the state afterwards.
 */
export function setCheckedInPage(marks: PageMarks, index: number, checked: boolean): PageResult<boolean> {
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
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
 * focus when index is null. execCommand("insertText") fires beforeinput/input
 * like typing and works in inputs, textareas and rich editors; else the value
 * is set directly.
 */
export function insertTextInPage(marks: PageMarks, index: number | null, text: string): PageResult<true> {
  var el: HTMLElement | null;
  if (index == null) {
    el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: false, error: "nothing is focused to paste into; click a field first" };
  } else {
    el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
    if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  }
  var isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (index != null && !isField && !el.isContentEditable) el.focus();
  var target = (index == null ? el : el.isContentEditable || isField ? el : (document.activeElement as HTMLElement | null)) || el;
  var before = isField ? (target as HTMLInputElement).value : target.textContent;
  var done = false;
  try {
    done = document.execCommand("insertText", false, text);
  } catch (e) {
    done = false;
  }
  var after = isField ? (target as HTMLInputElement).value : target.textContent;
  // Retyping a field's own value changes nothing, yet it was typed: a focused field is trusted.
  if (done && (after !== before || (isField && document.activeElement === target))) return { ok: true, value: true };
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
    target.appendChild(document.createTextNode(text));
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return { ok: true, value: true };
  }
  return { ok: false, error: "the element does not accept text" };
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
  var target = (document.activeElement as HTMLElement | null) || document.body;
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
    var editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    var shortcut = k.ctrl || k.meta || k.alt;
    if (k.key === "Enter" && !shortcut) {
      if (target instanceof HTMLInputElement) {
        if (target.form) target.form.requestSubmit();
      } else if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
        document.execCommand(target.isContentEditable ? "insertParagraph" : "insertText", false, "\n");
      } else if (target instanceof HTMLAnchorElement || target instanceof HTMLButtonElement) {
        target.click();
      }
    } else if ((k.ctrl || k.meta) && k.key.toLowerCase() === "a") {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select();
      else document.execCommand("selectAll");
    } else if (editable && !shortcut && (k.key === "Backspace" || k.key === "Delete")) {
      document.execCommand(k.key === "Backspace" ? "delete" : "forwardDelete");
    } else if (editable && !shortcut && text !== null) {
      document.execCommand("insertText", false, text);
    }
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true, value: true };
}

export function viewportInPage(): PageResult<{ w: number; h: number }> {
  return { ok: true, value: { w: window.innerWidth, h: window.innerHeight } };
}
