import { MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_OPTIONS, MAX_SNAPSHOT_TEXT, type PageSnapshot } from "@noa/shared";
import { PAGE_MARKS, type PageMarks } from "./driver-common.js";

/** The Runtime.evaluate expression that runs snapshotPage in the page. */
export function snapshotExpression(): string {
  return `(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, ${MAX_SNAPSHOT_TEXT}, ${MAX_SNAPSHOT_ELEMENTS}, ${MAX_SNAPSHOT_OPTIONS})`;
}

/**
 * Runs inside the page via Runtime.evaluate. It must stay self-contained:
 * no imports, no references to module scope, plain ES2020, because it is
 * serialized with Function.prototype.toString.
 */
export function snapshotPage(marks: PageMarks, maxText: number, maxElements: number, maxOptions: number): PageSnapshot {
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

  /** The parent, or for the top of a shadow root its host. */
  function parentOf(e: Element): Element | null {
    if (e.parentElement) return e.parentElement;
    var root = e.getRootNode() as ShadowRoot;
    return root && root.host ? root.host : null;
  }

  function isVisible(el: Element): boolean {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    for (var e: Element | null = el; e; e = parentOf(e)) {
      if (getComputedStyle(e).display === "none") return false;
    }
    return true;
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
    var text = (el as HTMLElement).innerText;
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
    for (var c = 0; c < all.length; c++) {
      var cand = all[c]!;
      if (/^(LABEL|OPTION|SCRIPT|STYLE|svg|path|g|use)$/.test(cand.tagName)) continue;
      if (getComputedStyle(cand).cursor !== "pointer") continue;
      var parent = cand.parentElement;
      if (parent && getComputedStyle(parent).cursor === "pointer") continue;
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
   * system's text field keeps its <textarea> in one). Closed shadow roots cannot be read.
   */
  function controls(root: Document | ShadowRoot, extra: Element[], out: Element[]): Element[] {
    var all = root.querySelectorAll("*");
    for (var c = 0; c < all.length; c++) {
      var e = all[c]!;
      if (e.matches(SELECTOR) || extra.indexOf(e) >= 0) out.push(e);
      if (e.shadowRoot) controls(e.shadowRoot, extra, out);
    }
    return out;
  }

  var elements: PageSnapshot["elements"] = [];
  var truncated = false;
  var nodes = controls(document, scriptClickables(), []);
  for (var n = 0; n < nodes.length; n++) {
    var el = nodes[n]!;
    var tag = el.tagName.toLowerCase();
    var inputType = tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : undefined;
    var isFile = inputType === "file";
    if (inputType === "hidden") continue;
    if (!isFile && !isVisible(el)) continue;
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    var index = elements.length;
    el.setAttribute(ATTR, String(index));
    if (el.getRootNode() !== document) shadowMarked.push(el);
    var rect = el.getBoundingClientRect();
    var info: PageSnapshot["elements"][number] = {
      index: index,
      tag: tag,
      role: implicitRole(el),
      name: nameOf(el),
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw && rect.width > 0,
    };
    if (inputType) info.type = inputType;
    if (tag !== "input" && tag !== "textarea" && tag !== "select") {
      var inner = (el as HTMLElement).innerText;
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
    if (el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) info.inDialog = true;
    elements.push(info);
  }

  var bodyText = document.body ? document.body.innerText || "" : "";
  var text = bodyText
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim()
    .slice(0, maxText);

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
  var snap: PageSnapshot = { url: location.href, title: document.title, text: text, elements: elements, truncated: truncated };
  if (frames.length) snap.frames = frames;
  return snap;
}
