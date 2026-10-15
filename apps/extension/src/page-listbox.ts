/**
 * A custom dropdown's options (an ARIA combobox: browser.type chooses one), and a text field's suggestions, for both drivers: they run in the page (through chrome.scripting.executeScript, or Runtime.evaluate),
 * serialized with Function.prototype.toString. Keep them self-contained (no imports at run time, no module scope),
 * plain ES2020; what they need comes as arguments (PageMarks).
 */
import type { ListOption, PageMarks, Suggestions } from "./driver-common.js";
import type { PageResult } from "./scroll-probe.js";

/**
 * The option of custom dropdown `index` (typeTargetInPage said "listbox") that
 * `text` names, from its open list. Before the click that opens it (`opened`
 * false): the shown role=option items of the listboxes tied to it (that it
 * controls or owns, aria-controls / aria-owns, or holds, or whose option is
 * its aria-activedescendant), whatever aria-expanded says, as shown options
 * mean it is open; and it notes which listboxes the page shows now. After
 * that click (`opened` true): those tied lists, else a listbox the page shows
 * now but did not before the click (its popup, wherever the page put it).
 * A listbox shown already before the click and not tied to it is another
 * list of the page (e.g. "Recently viewed") and never used. Matched as
 * selectOptionInPage matches a label. Returns the option's label, an element
 * number to click it by (its read_page number, else a new one past the
 * others, which the next read_page clears) and whether it is selected
 * already, or null while no option is shown. An unknown or ambiguous name is
 * an error that lists the options.
 */
export function listOptionInPage(marks: PageMarks, index: number, text: string, opened: boolean): PageResult<ListOption | null> {
  var shadowMarks = (window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || [];
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    shadowMarks.filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  function norm(s: string): string {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }
  function labelOf(o: HTMLElement): string {
    return (o.getAttribute("aria-label") || o.innerText || o.textContent || "").replace(/\s+/g, " ").trim();
  }
  function shown(e: Element): boolean {
    return e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  }
  var root = el.getRootNode() as Document | ShadowRoot;
  function byId(id: string): Element | null {
    return id ? root.getElementById(id) || document.getElementById(id) : null;
  }
  var lists: Element[] = [];
  var ids = ((el.getAttribute("aria-controls") || "") + " " + (el.getAttribute("aria-owns") || "")).split(/\s+/);
  for (var i = 0; i < ids.length; i++) {
    var tied = byId(ids[i]!);
    if (tied) lists.push(tied);
  }
  var active = byId(el.getAttribute("aria-activedescendant") || "");
  var activeList = active && active.closest('[role="listbox"]');
  if (activeList) lists.push(activeList);
  lists.push(el);
  // The listboxes shown before the click, kept in the page between the calls of one browser.type.
  var key = marks.shadow + "Lists";
  var store = window as unknown as Record<string, Element[] | undefined>;
  var showing = (Array.prototype.slice.call(document.querySelectorAll('[role="listbox"]')) as Element[]).filter(shown);
  if (!opened) store[key] = showing;
  function optionsIn(list: Element[]): HTMLElement[] {
    var out: HTMLElement[] = [];
    for (var j = 0; j < list.length; j++) {
      var found = list[j]!.querySelectorAll('[role="option"]');
      for (var k = 0; k < found.length; k++) {
        var o = found[k] as HTMLElement;
        if (out.indexOf(o) < 0 && shown(o) && o.getAttribute("aria-disabled") !== "true") out.push(o);
      }
    }
    return out;
  }
  var options = optionsIn(lists);
  if (!options.length && opened) {
    var before = store[key] || [];
    options = optionsIn(
      showing.filter(function (l) {
        return before.indexOf(l) < 0;
      }),
    );
  }
  if (!options.length) return { ok: true, value: null };
  var want = norm(text);
  function only(pred: (o: HTMLElement) => boolean): HTMLElement[] {
    return options.filter(pred);
  }
  var match = only(function (o) {
    return norm(labelOf(o)) === want;
  });
  if (!match.length && want) match = only(function (o) {
    return norm(labelOf(o)).indexOf(want) === 0;
  });
  if (!match.length && want) match = only(function (o) {
    return norm(labelOf(o)).indexOf(want) >= 0;
  });
  if (match.length !== 1) {
    var listed = (match.length ? match : options).slice(0, 40).map(function (o) {
      return JSON.stringify(labelOf(o));
    });
    var what = match.length ? "matches several options" : "matches no option";
    return { ok: false, error: JSON.stringify(text) + " " + what + " of dropdown " + index + "; its options" + (match.length ? " that match" : "") + ": " + listed.join(", ") };
  }
  var option = match[0]!;
  var mark = option.getAttribute(marks.attr);
  if (mark === null) {
    var max = -1;
    var all = (Array.prototype.slice.call(document.querySelectorAll("[" + marks.attr + "]")) as Element[]).concat(shadowMarks);
    for (var m = 0; m < all.length; m++) max = Math.max(max, Number(all[m]!.getAttribute(marks.attr)) || 0);
    mark = String(max + 1);
    option.setAttribute(marks.attr, mark);
    if (option.getRootNode() !== document) {
      shadowMarks.push(option);
      (window as unknown as Record<string, Element[]>)[marks.shadow] = shadowMarks;
    }
  }
  return { ok: true, value: { label: labelOf(option), index: Number(mark), selected: option.getAttribute("aria-selected") === "true" } };
}

/**
 * Whether the option element `option` of custom dropdown `index`, labelled
 * `label`, now shows as chosen: it is aria-selected, or the dropdown's shown
 * value (its value, aria-valuetext or text) names it. `shows` is that shown
 * value, for the error when it is not.
 */
export function optionChosenInPage(marks: PageMarks, index: number, option: number, label: string): PageResult<{ chosen: boolean; shows: string }> {
  var shadowMarks = (window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || [];
  function byMark(n: number): HTMLElement | null {
    return (document.querySelector("[" + marks.attr + '="' + Math.trunc(n) + '"]') ||
      shadowMarks.filter(function (m) {
        return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(n));
      })[0] ||
      null) as HTMLElement | null;
  }
  var el = byMark(index);
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  function norm(s: string): string {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }
  var shows = (el instanceof HTMLInputElement ? el.value : el.getAttribute("aria-valuetext") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  var opt = byMark(option);
  var selected = !!opt && opt.getAttribute("aria-selected") === "true";
  return { ok: true, value: { chosen: selected || (norm(label) !== "" && norm(shows).indexOf(norm(label)) >= 0), shows: shows } };
}

/**
 * The suggestions of the text field just typed into (element `index`, or the field its click focused inside it), when
 * the page says it suggests values as you type: an ARIA combobox (role=combobox on the field or on the element that
 * holds it, or aria-autocomplete list or both) whose role=option items show in a listbox tied to it (that it controls
 * or owns, aria-controls / aria-owns, or whose option is its aria-activedescendant). A search box (type=search,
 * role=searchbox, or inside a search landmark) suggests nothing here: Enter searches what was typed.
 *
 * "none": not such a field; "waiting": no option shown yet; "pick": the one shown option whose label is `text`
 * (case and spacing ignored), with an element number to click it by, as listOptionInPage gives; "shown": the
 * labels of the options shown, none of them the text.
 */
export function suggestionsInPage(marks: PageMarks, index: number, text: string): PageResult<Suggestions> {
  var shadowMarks = (window as unknown as Record<string, Element[] | undefined>)[marks.shadow] || [];
  var el = (document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') ||
    shadowMarks.filter(function (m) {
      return m.isConnected && m.getAttribute(marks.attr) === String(Math.trunc(index));
    })[0] ||
    null) as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  var field: HTMLElement | null = el;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    // A wrapper: the field its click focused, inside it.
    var a = document.activeElement as HTMLElement | null;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
    field = a && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && el.contains(a) ? a : null;
  }
  if (!field) return { ok: true, value: { kind: "none" } };
  function role(e: Element): string {
    return (e.getAttribute("role") || "").split(" ")[0] || "";
  }
  var autocomplete = (field.getAttribute("aria-autocomplete") || "").toLowerCase();
  var combo = role(field) === "combobox" || autocomplete === "list" || autocomplete === "both" || (el !== field && role(el) === "combobox");
  if (!combo) return { ok: true, value: { kind: "none" } };
  if ((field instanceof HTMLInputElement && field.type === "search") || role(field) === "searchbox" || field.closest('[role="search"], search')) {
    return { ok: true, value: { kind: "none" } };
  }
  function norm(s: string): string {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }
  function labelOf(o: HTMLElement): string {
    return (o.getAttribute("aria-label") || o.innerText || o.textContent || "").replace(/\s+/g, " ").trim();
  }
  function shown(e: Element): boolean {
    return e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  }
  var root = field.getRootNode() as Document | ShadowRoot;
  function byId(id: string): HTMLElement | null {
    return id ? root.getElementById(id) || document.getElementById(id) : null;
  }
  var lists: Element[] = [];
  var owners = el === field ? [field] : [field, el];
  for (var w = 0; w < owners.length; w++) {
    var owner = owners[w]!;
    var ids = ((owner.getAttribute("aria-controls") || "") + " " + (owner.getAttribute("aria-owns") || "")).split(/\s+/);
    for (var i = 0; i < ids.length; i++) {
      var tied = byId(ids[i]!);
      if (tied && lists.indexOf(tied) < 0) lists.push(tied);
    }
    var active = byId(owner.getAttribute("aria-activedescendant") || "");
    var activeList = active && active.closest('[role="listbox"]');
    if (activeList && lists.indexOf(activeList) < 0) lists.push(activeList);
  }
  var options: HTMLElement[] = [];
  for (var j = 0; j < lists.length; j++) {
    var found = lists[j]!.querySelectorAll('[role="option"]');
    for (var k = 0; k < found.length; k++) {
      var o = found[k] as HTMLElement;
      if (options.indexOf(o) < 0 && shown(o) && o.getAttribute("aria-disabled") !== "true") options.push(o);
    }
  }
  if (!options.length) return { ok: true, value: { kind: "waiting" } };
  var want = norm(text);
  var exact = options.filter(function (o) {
    return norm(labelOf(o)) === want;
  });
  if (exact.length !== 1 || !want) return { ok: true, value: { kind: "shown", labels: options.slice(0, 10).map(labelOf) } };
  var option = exact[0]!;
  var mark = option.getAttribute(marks.attr);
  if (mark === null) {
    var max = -1;
    var all = (Array.prototype.slice.call(document.querySelectorAll("[" + marks.attr + "]")) as Element[]).concat(shadowMarks);
    for (var m = 0; m < all.length; m++) max = Math.max(max, Number(all[m]!.getAttribute(marks.attr)) || 0);
    mark = String(max + 1);
    option.setAttribute(marks.attr, mark);
    if (option.getRootNode() !== document) {
      shadowMarks.push(option);
      (window as unknown as Record<string, Element[]>)[marks.shadow] = shadowMarks;
    }
  }
  return { ok: true, value: { kind: "pick", label: labelOf(option), index: Number(mark) } };
}
