/**
 * Compact text form of a PageSnapshot, as returned to the model by read_page,
 * and a parser for it (used by the helper's scripted brain, which only sees
 * tool text).
 */
import type { AgentTabInfo, ElementInfo, FoundControl, FoundText, PageSnapshot, ScrollArea, ScrollDirection, ScrollReport } from "@noa/shared";

/**
 * A form field's state: checked or not, its dropdown options, required, and
 * the page's validation message, so the agent sees what is filled and what
 * failed without screenshots or typing again.
 */
function fieldState(el: ElementInfo): string[] {
  const parts: string[] = [];
  if (el.checked !== undefined) parts.push(el.checked ? "checked" : "not checked");
  if (el.options?.length) parts.push(`options=${JSON.stringify(el.options)}`);
  if (el.required) parts.push("required");
  if (el.invalid) parts.push(`invalid: ${JSON.stringify(el.invalid)}`);
  return parts;
}

/**
 * The mark of an element an open modal dialog covers (ElementInfo.covered): clicking or typing into it fails until
 * the dialog is closed.
 */
const COVERED = "behind the open dialog";

export function formatElement(el: ElementInfo): string {
  const parts: string[] = [el.tag];
  if (el.type) parts.push(`type=${el.type}`);
  if (el.testId) parts.push(`testid=${el.testId}`);
  if (el.value) parts.push(`value=${JSON.stringify(el.value)}`);
  parts.push(...fieldState(el));
  if (el.href) parts.push(`href=${el.href}`);
  if (el.disabled) parts.push("disabled");
  if (el.text) parts.push(`text=${JSON.stringify(el.text)}`);
  if (!el.inViewport) parts.push("offscreen");
  if (el.covered) parts.push(COVERED);
  return `[${el.index}] ${el.role || el.tag} ${JSON.stringify(el.name ?? "")} (${parts.join(", ")})`;
}

export function formatElements(elements: ElementInfo[], truncated = false): string {
  const lines = elements.map(formatElement);
  if (truncated) lines.push("(element list truncated)");
  return lines.join("\n");
}

/** Lines in the Jev-mode element list (read_page); the rest is summed up in one line. */
export const WORD_LIST_MAX = 150;

/** Heading of the Jev-mode element list. */
export const WORDS_HEADING =
  "Interactive elements (no index numbers: describe the one you want in words in act, e.g. 'click the Reply button under the first post'; the fast picker finds it):";

export const clipName = (s: string, max = 80) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The element list for Jev mode: role and label per element, without index
 * numbers, identical elements merged ('button "Reply" ×5'), at most `max`
 * lines, in page order. File inputs keep their index, because upload needs it.
 */
export function formatElementsInWords(elements: ElementInfo[], truncated = false, max = WORD_LIST_MAX): string {
  return listInWords(elements, truncated, max).text;
}

/**
 * formatElementsInWords, and the elements it lists. Past `max` lines, the
 * ones in view (and file inputs) are kept first, then the rest in page order;
 * they are shown in page order.
 */
function listInWords(elements: ElementInfo[], truncated: boolean, max: number): { text: string; listed: ElementInfo[] } {
  type Group = { el: ElementInfo; count: number; offscreen: number; disabled: number; members: ElementInfo[] };
  type Entry = Group | { line: string; members: ElementInfo[] };
  const entries: Entry[] = [];
  const groups = new Map<string, Group>();
  for (const el of elements) {
    if (el.tag === "input" && el.type === "file") {
      entries.push({ line: `file input ${JSON.stringify(clipName(el.name ?? ""))} (upload index ${el.index})`, members: [el] });
      continue;
    }
    const key = [el.role || el.tag, el.name, el.type ?? "", el.testId ?? "", el.role === "link" ? (el.href ?? "") : "", el.inDialog ? "dialog" : "", el.covered ? "covered" : "", String(el.checked ?? "")].join("|");
    let g = groups.get(key);
    if (!g) {
      g = { el, count: 0, offscreen: 0, disabled: 0, members: [] };
      groups.set(key, g);
      entries.push(g);
    }
    g.count++;
    g.members.push(el);
    if (!el.inViewport) g.offscreen++;
    if (el.disabled) g.disabled++;
  }
  let kept = entries;
  if (entries.length > max) {
    const inView = (e: Entry) => ("line" in e ? true : e.offscreen < e.count);
    const chosen = new Set(entries.filter(inView).slice(0, max));
    for (const e of entries) if (chosen.size < max) chosen.add(e);
    kept = entries.filter((e) => chosen.has(e));
  }
  const out = kept.map((g) => {
    if ("line" in g) return g.line;
    const { el, count } = g;
    const label = el.name ? JSON.stringify(clipName(el.name)) : "(no label)";
    const parts: string[] = [];
    if (el.type && el.tag === "input") parts.push(`type=${el.type}`);
    if (el.testId) parts.push(`testid=${el.testId}`);
    if (el.text && el.text !== el.name) parts.push(`text=${JSON.stringify(clipName(el.text, 60))}`);
    if (count === 1 && el.value) parts.push(`value=${JSON.stringify(clipName(el.value, 60))}`);
    if (count === 1) parts.push(...fieldState(el));
    else if (el.checked !== undefined) parts.push(el.checked ? "checked" : "not checked");
    if (el.role === "link" && el.href) parts.push(`href=${el.href}`);
    if (el.inDialog) parts.push("in dialog");
    if (el.covered) parts.push(COVERED);
    if (g.disabled === count) parts.push("disabled");
    if (g.offscreen === count) parts.push("offscreen");
    return `${el.role || el.tag} ${label}${count > 1 ? ` ×${count}` : ""}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  });
  if (entries.length > kept.length) out.push(`(${entries.length - kept.length} more elements not listed, out of view; scroll, or describe what you need)`);
  if (truncated) out.push("(element list truncated)");
  return { text: out.join("\n"), listed: kept.flatMap((e) => e.members) };
}

/** Labels shorter than this are not looked for inside longer text lines (see textWithoutElements). */
const MIN_LABEL_IN_LINE = 12;

/**
 * The page's visible text without the lines that only repeat what the
 * element list says: a list's rows that are links, a button's label. On mail
 * and feed pages that is most of the text, which the model would otherwise
 * read twice. A line that says more than a label stays.
 */
export function textWithoutElements(text: string, listed: ElementInfo[]): string {
  const labels = new Set<string>();
  const long: string[] = [];
  for (const el of listed) {
    for (const l of [el.name, el.text]) {
      const s = l?.replace(/\s+/g, " ").trim().replace(/…$/, "");
      if (!s) continue;
      labels.add(s);
      if (s.length >= MIN_LABEL_IN_LINE) long.push(s);
    }
  }
  return text
    .split("\n")
    .filter((raw) => {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line || labels.has(line)) return false;
      return !long.some((l) => line.length >= l.length && line.includes(l) && line.replace(l, "").replace(/[^\p{L}\p{N}]/gu, "").length <= 3);
    })
    .join("\n");
}

/** read_page's line about frames from other sites whose content it cannot show (see PageSnapshot.frames). */
export function framesNote(snap: PageSnapshot): string[] {
  if (!snap.frames?.length) return [];
  const list = snap.frames.map((f) => `${f.title ? `${JSON.stringify(f.title)} ` : ""}${f.url}`).join("; ");
  return [
    `--- not shown: ${snap.frames.length} frame(s) from another site on this page (${list}). Their content (e.g. an account switcher or a sign-in popup) cannot be read or clicked from here: open the frame's address with navigate, or reach the same thing another way (for accounts: the site's per-account address). ---`,
  ];
}

/** read_page's lines about scrollable areas whose content goes on past what they show (see PageSnapshot.areas). */
export function areasNote(snap: PageSnapshot, before?: PageSnapshot): string[] {
  if (!snap.areas?.length) return [];
  // An area that was there before (same label and height) and moved: a click scrolls its element into view, which
  // changes the rows a long list draws.
  const moved = (a: ScrollArea) => before?.areas?.some((b) => b.label === a.label && b.height === a.height && b.above !== a.above) === true;
  return [
    `--- ${AREAS_HEADING}: what is scrolled out of view in them may be missing from the lists above (long lists draw only the rows in view), so they are not complete lists. scroll with the area's index scrolls inside it ---`,
    ...snap.areas.map((a) => {
      const parts = [`${a.height} px tall`];
      if (a.above > 0) parts.push(`${a.above} px more above`);
      if (a.below > 0) parts.push(`${a.below} px more below`);
      if (a.inDialog) parts.push("in dialog");
      if (moved(a)) parts.push("it scrolled during these steps, so the rows it shows changed");
      const shows = a.first ? `, shows ${JSON.stringify(a.first)}${a.last ? ` to ${JSON.stringify(a.last)}` : ""}` : "";
      return `area index=${a.index}${a.label ? ` ${JSON.stringify(a.label)}` : ""}${shows} (${parts.join(", ")})`;
    }),
  ];
}
const AREAS_HEADING = "scrollable areas with more content than they show";

/** The heading of read_page's page text. */
export const TEXT_HEADING = "--- visible text ---";

/**
 * Compact text form of a snapshot, as returned by read_page. words (Jev on):
 * the element list without index numbers (formatElementsInWords).
 */
export function formatSnapshot(snap: PageSnapshot, opts: { words?: boolean } = {}): string {
  const words = opts.words ? listInWords(snap.elements, snap.truncated, WORD_LIST_MAX) : null;
  return [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    ...(words ? [WORDS_HEADING, words.text] : [formatElements(snap.elements, snap.truncated)]),
    ...areasNote(snap),
    TEXT_HEADING,
    textWithoutElements(snap.text, words ? words.listed : snap.elements),
    ...(snap.textCut ? [TEXT_CUT] : []),
    ...framesNote(snap),
  ].join("\n");
}

/** After the page text of a page with more text than read_page returns (PageSnapshot.textCut). */
export const TEXT_CUT = "--- the page's text goes on past here (cut); find_text finds text anywhere on the page ---";

/** URL, title and the element list, without the page text (used when act stops). */
export function formatCompact(snap: PageSnapshot): string {
  return [`URL: ${snap.url}`, `Title: ${snap.title}`, formatElements(snap.elements, snap.truncated)].join("\n");
}

/** Elements listed per tab when read_page reads several tabs (the full list is one switch_tab + read_page away). */
export const MULTI_TAB_ELEMENTS = 80;

/** One line per agent tab: "t2 (current) https://... "Title"". */
export function formatTabs(tabs: AgentTabInfo[]): string {
  if (!tabs.length) return "(no tabs)";
  return tabs
    .map((t) => `${t.id}${t.current ? " (current)" : ""}${t.user ? " (the user's tab)" : ""} ${t.url} ${JSON.stringify(t.title)}${t.error ? ` [${t.error}]` : ""}`)
    .join("\n");
}

/** read_page with `tabs`: each tab's snapshot (or error) under its own header. words: Jev mode (see formatSnapshot). */
export function formatTabSnapshots(reads: ({ tab: string; snap: PageSnapshot } | { tab: string; error: string })[], opts: { words?: boolean } = {}): string {
  return reads
    .map((r) => {
      const header = `===== Tab ${r.tab} =====`;
      if ("error" in r) return `${header}\nCould not read this tab: ${r.error}`;
      const { snap } = r;
      if (opts.words) {
        const list = listInWords(snap.elements, snap.truncated, MULTI_TAB_ELEMENTS);
        return `${header}\n${[`URL: ${snap.url}`, `Title: ${snap.title}`, WORDS_HEADING, list.text, ...areasNote(snap), TEXT_HEADING, textWithoutElements(snap.text, list.listed), ...(snap.textCut ? [TEXT_CUT] : [])].join("\n")}`;
      }
      const extra = snap.elements.length - MULTI_TAB_ELEMENTS;
      if (extra <= 0) return `${header}\n${formatSnapshot(snap)}`;
      const shown = snap.elements.slice(0, MULTI_TAB_ELEMENTS);
      const note = `(${extra} more elements; switch_tab to ${r.tab} and call read_page for the full list)`;
      const body = [`URL: ${snap.url}`, `Title: ${snap.title}`, formatElements(shown), note, ...areasNote(snap), TEXT_HEADING, textWithoutElements(snap.text, shown), ...(snap.textCut ? [TEXT_CUT] : [])];
      return `${header}\n${body.join("\n")}`;
    })
    .join("\n\n");
}

/** What a scripted brain can recover from read_page text. */
export interface ParsedPage {
  url: string;
  title: string;
  text: string;
  /** Elements; index is -1 for elements listed in words (Jev mode), which have none. */
  elements: Pick<ElementInfo, "index" | "role" | "name" | "tag" | "type" | "testId" | "disabled" | "href">[];
  /** The element list was in words (Jev mode): act steps must describe elements. */
  words: boolean;
}

const ELEMENT_LINE = /^\[(\d+)\] (\S+) ("(?:[^"\\]|\\.)*") \((.*)\)$/;
const WORDS_LINE = /^(\S+) ("(?:[^"\\]|\\.)*"|\(no label\))(?: ×\d+)?(?: \((.*)\))?$/;
const FILE_INPUT_LINE = /^file input ("(?:[^"\\]|\\.)*") \(upload index (\d+)\)$/;

export function parseSnapshotText(text: string): ParsedPage {
  const page: ParsedPage = { url: "", title: "", text: "", elements: [], words: false };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("--- visible text")) {
      page.text = lines.slice(i + 1).join("\n");
      break;
    }
    if (line.startsWith("URL: ")) page.url = line.slice(5);
    else if (line.startsWith("Title: ")) page.title = line.slice(7);
    else if (line === WORDS_HEADING) page.words = true;
    else if (page.words && !line.startsWith("[")) {
      const file = FILE_INPUT_LINE.exec(line);
      if (file) {
        page.elements.push({ index: Number(file[2]), role: "button", name: JSON.parse(file[1]!) as string, tag: "input", type: "file" });
        continue;
      }
      const m = WORDS_LINE.exec(line);
      if (!m) continue;
      const el: ParsedPage["elements"][number] = { index: -1, role: m[1]!, name: m[2]!.startsWith('"') ? (JSON.parse(m[2]!) as string) : "", tag: "" };
      for (const p of (m[3] ?? "").split(", ")) {
        if (p.startsWith("type=")) el.type = p.slice(5);
        else if (p.startsWith("testid=")) el.testId = p.slice(7);
        else if (p.startsWith("href=")) el.href = p.slice(5);
        else if (p === "disabled") el.disabled = true;
      }
      page.elements.push(el);
    } else {
      const m = ELEMENT_LINE.exec(line);
      if (!m) continue;
      const parts = m[4]!.split(", ");
      const el: ParsedPage["elements"][number] = {
        index: Number(m[1]),
        role: m[2]!,
        name: JSON.parse(m[3]!) as string,
        tag: parts[0] ?? "",
      };
      for (const p of parts.slice(1)) {
        if (p.startsWith("type=")) el.type = p.slice(5);
        else if (p.startsWith("testid=")) el.testId = p.slice(7);
        else if (p.startsWith("href=")) el.href = p.slice(5);
        else if (p === "disabled") el.disabled = true;
      }
      page.elements.push(el);
    }
  }
  return page;
}

const num = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The scroll tool's answer: what actually moved and where the view is now, or
 * why nothing moved. Without a report (older drivers) just the request.
 */
export function formatScroll(
  req: { direction: ScrollDirection; amount?: number | undefined; index?: number | undefined },
  r: Partial<ScrollReport>,
): string {
  const { direction, amount, index } = req;
  if (r.moved === undefined || r.target === undefined || r.position === undefined || r.size === undefined || r.view === undefined) {
    return `Scrolled ${direction}${amount ? ` ${amount}x` : ""}${index !== undefined ? ` inside [${index}]` : ""}.`;
  }
  const vertical = direction === "up" || direction === "down";
  const end = { down: "at the bottom", up: "at the top", left: "at the left edge", right: "at the right edge" }[direction];
  const range = Math.max(0, r.size - r.view);
  const container = r.containerIndex !== undefined ? `[${r.containerIndex}]` : index !== undefined ? `the scrollable area around [${index}]` : "a scrollable area";
  if (r.moved > 0) {
    const pct = range > 0 ? Math.min(100, Math.round((100 * r.position) / range)) : 100;
    const atEnd = direction === "down" || direction === "right" ? r.position >= range - 1 : r.position <= 0;
    const where =
      r.target === "page"
        ? index !== undefined
          ? " (the page; the element has no scroll area of its own)"
          : ""
        : index !== undefined
          ? ` inside ${container}`
          : ` inside ${container} of the page, not the page itself`;
    // Moved further than it shows at once: what was between the old and the new view was never in view.
    const skipped = r.moved > r.view ? ` It moved more than the ${num(r.view)} px it shows at once, so ${num(r.moved - r.view)} px of content in between were never in view (scroll back ${vertical ? (direction === "down" ? "up" : "down") : direction === "right" ? "left" : "right"} with amount 1 to see them).` : "";
    return `Scrolled ${direction} ${num(r.moved)} px${where} (now ${num(r.position)} of ${num(r.size)}; ${pct}% ${vertical ? "down" : "across"}${atEnd ? `; ${end}` : ""}).${skipped}`;
  }
  const what = r.target === "page" ? "the page" : container;
  switch (r.reason) {
    case "end":
      return `Nothing moved: ${what} is already ${end}.`;
    case "frame":
      return "Nothing moved in the page: the wheel was over an embedded frame (iframe); try scrolling inside another element (give its index).";
    case "ignored":
      return `Nothing moved: ${what} can scroll ${direction} (now ${num(r.position)} of ${num(r.size)}) but did not react to the wheel; try press_key ${vertical ? (direction === "down" ? "PageDown" : "PageUp") : direction === "left" ? "ArrowLeft" : "ArrowRight"}, or scroll inside an element (give its index).`;
    default:
      return index !== undefined
        ? `Nothing moved: [${index}] and the page around it don't scroll ${vertical ? direction : "sideways"}.`
        : `Nothing moved: this part of the page doesn't scroll${vertical ? "" : " sideways"}; try scrolling inside an element (give its index).`;
  }
}

/** A control next to found text: role, label, value or checked state, and (Jev off) its index. */
function foundControl(c: FoundControl, words: boolean): string {
  const state = c.checked !== undefined ? (c.checked ? " (checked)" : " (not checked)") : c.value !== undefined ? ` value=${JSON.stringify(c.value)}` : "";
  const index = !words && c.index !== undefined ? `[${c.index}] ` : "";
  return `${index}${c.role} ${JSON.stringify(c.name)}${state}`;
}

/**
 * find_text's answer: how often the text occurs, each place (row, item, paragraph) with its text and the controls in
 * it, and which one is in view now. words (Jev on): the controls without index numbers.
 */
export function formatFound(text: string, f: FoundText, opts: { words?: boolean; place?: number | undefined } = {}): string {
  const q = JSON.stringify(text);
  if (f.total === 0) return `${q} is not on this page (its shown text and form fields were searched, case and spacing aside).`;
  const times = f.total === 1 ? "once" : `${f.total} times`;
  const places = f.placeCount === 1 ? "" : ` in ${f.placeCount} places`;
  const lines = [`${q} occurs ${times}${places} on the page.`];
  if (f.scrolledTo !== null) lines.push(`Place ${f.scrolledTo} is scrolled into view now${f.placeCount > 1 ? ` (give place to go to another)` : ""}.`);
  else if (opts.place !== undefined && opts.place > f.placeCount) lines.push(`There is no place ${opts.place}; nothing was scrolled.`);
  for (const p of f.places) {
    const where = p.inViewport ? "in view" : "offscreen";
    const twice = p.matches > 1 ? `, ${p.matches} matches` : "";
    lines.push(`${p.number}. (${where}${twice}) ${JSON.stringify(p.context)}`);
    if (p.controls.length) lines.push(`   controls: ${p.controls.map((c) => foundControl(c, !!opts.words)).join("; ")}`);
  }
  const shown = f.places.length;
  if (f.placeCount > shown) lines.push(`(${f.placeCount - shown} more places not listed: search for longer text to narrow it down, or give place to go to one)`);
  return lines.join("\n");
}

/** An element as the page change compares it: same role, label, kind and target. */
const lookKey = (el: ElementInfo) => [el.role || el.tag, el.name, el.type ?? "", el.testId ?? "", el.href ?? "", el.inDialog ? "dialog" : ""].join("|");
/** The state act can change: a field's value, checked, validation, enabled. */
const stateKey = (el: ElementInfo) => JSON.stringify([el.value ?? "", el.checked ?? null, el.invalid ?? "", el.disabled ?? false]);
export const withoutHash = (url: string) => url.replace(/#.*$/, "");

/** Lines of new text shown after act (the rest is one read_page away). */
export const CHANGE_TEXT_MAX = 1500;
/** Elements listed per kind of change after act. */
export const CHANGE_ELEMENTS_MAX = 40;

/** What changed between two reads of the same page: elements that appeared, went away or changed state, new text, new frames. */
function pageDiff(before: PageSnapshot, after: PageSnapshot) {
  const was = new Map<string, ElementInfo[]>();
  for (const el of before.elements) was.set(lookKey(el), [...(was.get(lookKey(el)) ?? []), el]);
  const appeared: ElementInfo[] = [];
  const changed: ElementInfo[] = [];
  for (const el of after.elements) {
    const same = was.get(lookKey(el));
    const prior = same?.shift();
    if (!prior) appeared.push(el);
    else if (stateKey(prior) !== stateKey(el)) changed.push(el);
  }
  const gone = [...was.values()].flat();
  const oldLines = new Set(before.text.split("\n").map((l) => l.trim()));
  const newText = textWithoutElements(
    after.text
      .split("\n")
      .filter((l) => !oldLines.has(l.trim()))
      .join("\n"),
    after.elements,
  );
  const newFrames = (after.frames ?? []).filter((f) => !(before.frames ?? []).some((b) => b.url === f.url));
  return { appeared, changed, gone, newText, newFrames };
}

/**
 * What act changed on the page (Jev mode), instead of the whole page again:
 * the elements that appeared, went away or changed state (a field's value,
 * checked, its validation message), and the new text. When the address
 * changed (another page), the new page in full.
 */
export function formatPageChange(before: PageSnapshot, after: PageSnapshot): string {
  if (withoutHash(before.url) !== withoutHash(after.url)) return formatSnapshot(after, { words: true });
  const { appeared, changed, gone, newText: allNewText, newFrames } = pageDiff(before, after);
  const newText = allNewText.length > CHANGE_TEXT_MAX ? `${allNewText.slice(0, CHANGE_TEXT_MAX)}… (more in read_page)` : allNewText;
  const out = [`URL: ${after.url}`, `Title: ${after.title}`];
  if (!appeared.length && !gone.length && !changed.length && !newText && !newFrames.length) {
    out.push("Nothing on the page changed since before these steps: no element appeared, went away or changed state, and no new text (a change inside a frame from another site would not show here).");
    return out.join("\n");
  }
  out.push("What changed on the page since before these steps (read_page shows all of it):");
  if (appeared.length) out.push(`Appeared (${appeared.length}):`, listInWords(appeared, false, CHANGE_ELEMENTS_MAX).text);
  if (changed.length) out.push(`Changed (${changed.length}):`, listInWords(changed, false, CHANGE_ELEMENTS_MAX).text);
  if (gone.length) out.push(`Gone (${gone.length}):`, listInWords(gone, false, 15).text.replace(/ \(([^)]*)\)$/gm, ""));
  if (newText) out.push("New text:", newText);
  out.push(...areasNote(after, before));
  out.push(...framesNote({ ...after, frames: newFrames }));
  return out.join("\n");
}

/** A value an act step typed, and the label of the field it went into. */
export type TypedValue = { field: string; text: string };

const looseText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The values a call typed that the page does not show now, in its text or any field's value: after a submit, the page
 * that came back does not confirm them (a confirmation without the details, a field reset to another value).
 */
export function notShownValues(typed: TypedValue[], after: PageSnapshot): TypedValue[] {
  const page = looseText([after.text, ...after.elements.flatMap((el) => [el.value ?? "", el.text ?? "", el.name ?? ""])].join("\n"));
  return typed.filter((t) => looseText(t.text) && !page.includes(looseText(t.text)));
}

/** Typed values as a list: the field's label and the value, e.g. `"Labels" "billing, urgent"`. */
export const formatTypedValues = (values: TypedValue[]) => values.map((t) => `${t.field ? `${JSON.stringify(clipName(t.field, 40))} ` : ""}${JSON.stringify(clipName(t.text, 60))}`).join(", ");

/**
 * How the final answer names a value the page did not confirm: in a sentence that says so itself
 * (unacknowledgedValues), as the results ask.
 */
export const UNCONFIRMED_RULE = 'Your answer may name these values or their fields only in a sentence that says they are not confirmed, e.g. "I entered X in Y, not confirmed: the page did not show it back."';

/** The line for notShownValues, or "" when there are none. */
export function formatNotShown(missing: TypedValue[]): string {
  if (!missing.length) return "";
  return `Typed but not shown on the page now: ${formatTypedValues(missing)}. The page does not show these values back: they are entered, not confirmed. ${UNCONFIRMED_RULE}\n`;
}

/** A step's effect when the page did not change at all (formatStepEffect). */
export const NOTHING_CHANGED = "nothing on the page changed";

/** Whether a value is stated in a text: each of its words (3 characters or more) is in it. */
export function statesValue(text: string, value: string): boolean {
  const words = looseText(value).match(/[\p{L}\p{N}][\p{L}\p{N}@._-]{2,}/gu) ?? [];
  const t = looseText(text);
  return words.length > 0 && words.every((w) => t.includes(w));
}

/** A list item line: "- x", "* x", "• x", "1. x". */
const LIST_ITEM = /^\s*(?:[-*\u2022]|\d+[.)])\s+/;

/**
 * A text's sentences, where a claim and what qualifies it are read together: each line split at sentence ends, except
 * a list and the line ending in ":" that introduces it, which are one ("The page did not show these back: / - Plan:
 * Pro / - Size: L").
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let list: string | null = null;
  for (const line of text.split(/\s*\n\s*/)) {
    if (list !== null && LIST_ITEM.test(line)) {
      list += `\n${line}`;
      continue;
    }
    if (list !== null) out.push(list);
    list = null;
    const parts = line.split(/(?<=[.!?])\s+/).filter((t) => t.trim());
    if (parts.length && /:\s*$/.test(line)) list = parts.pop()!;
    out.push(...parts);
  }
  if (list !== null) out.push(list);
  return out;
}

/**
 * A sentence that says something was not confirmed, in the words the results use: a negation and, at most three words
 * after it with no punctuation between, confirm / verify / save / persist ("not confirmed", "no confirmation",
 * "couldn't verify", "wasn't saved", "not been persisted"), or show / display / echo ... back later in the
 * sentence ("did not show them back", "didn't show the plan, size or department back", "not redisplayed"), or "unconfirmed" / "unverified" / "unsaved". Not any
 * negation: "no errors shown" says nothing about the value.
 */
const NEGATION = String.raw`(?:\b(?:not|never|no|none|neither|nothing|cannot|without)|n['’]t)(?:\s+\p{L}+){0,3}?\s+`;
const NOT_CONFIRMED = new RegExp(
  String.raw`${NEGATION}(?:confirm|verif|sav(?:e|ed|ing)\b|persist|redisplay|(?:show|display|echo|repeat|reflect)\p{L}*\b[^.!?\n]{0,80}?\bback\b)|\bun(?:confirmed|verified|saved)\b`,
  "iu",
);

/** Whether a sentence says that what it names was not confirmed (NOT_CONFIRMED). */
export const saysNotConfirmed = (sentence: string) => NOT_CONFIRMED.test(sentence);

/** Words that, right after a field's name, make it name the control, not what it holds: "the Labels field". */
const CONTROL = /^\s*(?:field|box|input|textbox|text box|dropdown|menu|select|selector|picker)s?\b/i;

/** Whether a sentence names a field's value by the field ("with both labels"), not only its control ("the Labels field"). */
function namesField(sentence: string, field: string): boolean {
  const t = looseText(sentence);
  const f = looseText(field);
  if (!f) return false;
  // Each mention of the field's name that is followed by "field", "box"... is the control: taken out before matching.
  let rest = "";
  let at = 0;
  for (let i = t.indexOf(f); i >= 0; i = t.indexOf(f, i + 1)) {
    if (CONTROL.test(t.slice(i + f.length))) {
      rest += t.slice(at, i);
      at = i + f.length;
    }
  }
  return statesValue(rest + t.slice(at), field);
}

/**
 * The values a text names (the value, or its field: "with both labels") that none of its sentences naming them says
 * are not confirmed, with the sentences that name them. A value is named in a sentence when every word of it, or of
 * one of its own sentences, is in it. The text is one thing the user reads or hears on its own (the answer, the
 * summary, the spoken line): a value it names, it says there is not confirmed.
 */
export function unacknowledgedValues<T extends TypedValue>(text: string, values: T[]): { value: T; sentences: string[] }[] {
  const out: { value: T; sentences: string[] }[] = [];
  const sentences = sentencesOf(text);
  for (const v of values) {
    const names = (s: string) => sentencesOf(v.text).some((n) => statesValue(s, n)) || (!!v.field && namesField(s, v.field));
    const naming = sentences.filter(names);
    if (naming.length && !naming.some(saysNotConfirmed)) out.push({ value: v, sentences: naming });
  }
  return out;
}

/** Roles of fields a click only focuses (to type into them). */
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "file"]);
/** A field a click only focuses: a text box, a select, a text input or textarea. */
export const isEditable = (el: ElementInfo) => EDITABLE_ROLES.has(el.role) || el.tag === "textarea" || el.tag === "select" || (el.tag === "input" && !BUTTON_INPUTS.has(el.type ?? "text"));

/**
 * After a send: the form was replaced by a result (its fields went away and new text, or another page, came), i.e.
 * the page took it and most likely made something (an issue, an order, a booking). Returns what the page shows
 * instead (clipped), or null when the form is still there (an error next to it, nothing changed).
 */
export function formSent(before: PageSnapshot, after: PageSnapshot): string | null {
  const { gone, newText } = pageDiff(before, after);
  const otherPage = withoutHash(before.url) !== withoutHash(after.url);
  const fieldsGone = otherPage ? before.elements.some(isEditable) && !after.elements.some(isEditable) : gone.some(isEditable);
  if (!fieldsGone) return null;
  const text = (otherPage ? `${after.title}\n${after.text}` : newText).trim().replace(/\s*\n\s*/g, " / ");
  return text ? clipName(text, 160) : null;
}

/** Elements named per kind in a step's effect line. */
const EFFECT_ELEMENTS_MAX = 4;
/** Characters of new text quoted in a step's effect line. */
const EFFECT_TEXT_MAX = 200;

/**
 * What one step (a key press) did to the page, as one short factual line: the address it went to; else the elements
 * that went away, appeared or changed and the new text (an Enter that submitted a form and left a confirmation, a
 * validation error); else that nothing on the page changed. So a result says what the key caused, not only that it was
 * pressed.
 */
export function formatStepEffect(before: PageSnapshot, after: PageSnapshot): string {
  if (withoutHash(before.url) !== withoutHash(after.url)) return `the page went to ${after.url} (${JSON.stringify(after.title)})`;
  const { appeared, changed, gone, newText, newFrames } = pageDiff(before, after);
  const names = (els: ElementInfo[]) => {
    const shown = els.slice(0, EFFECT_ELEMENTS_MAX).map((el) => `${el.role || el.tag} ${JSON.stringify(clipName(el.name ?? "", 40))}`);
    return `${shown.join(", ")}${els.length > shown.length ? `, ${els.length - shown.length} more` : ""}`;
  };
  const parts: string[] = [];
  if (gone.length) parts.push(`${gone.length} element(s) went away (${names(gone)})`);
  if (appeared.length) parts.push(`${appeared.length} appeared (${names(appeared)})`);
  if (changed.length) parts.push(`${changed.length} changed (${names(changed)})`);
  const text = newText.trim().replace(/\s*\n\s*/g, " / ");
  if (text) parts.push(`new text: ${JSON.stringify(clipName(text, EFFECT_TEXT_MAX))}`);
  if (newFrames.length) parts.push(`${newFrames.length} frame(s) from another site appeared`);
  return parts.length ? `on the page, ${parts.join("; ")}` : NOTHING_CHANGED;
}
