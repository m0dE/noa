/**
 * Compact text form of a PageSnapshot, as returned to the model by read_page,
 * and a parser for it (used by the helper's scripted brain, which only sees
 * tool text).
 */
import type { AgentTabInfo, ElementInfo, PageSnapshot, ScrollDirection, ScrollReport } from "@noa/shared";

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

const clipName = (s: string, max = 80) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

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
    const key = [el.role || el.tag, el.name, el.type ?? "", el.testId ?? "", el.role === "link" ? (el.href ?? "") : "", el.inDialog ? "dialog" : "", String(el.checked ?? "")].join("|");
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
    TEXT_HEADING,
    textWithoutElements(snap.text, words ? words.listed : snap.elements),
    ...framesNote(snap),
  ].join("\n");
}

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
    .map((t) => `${t.id}${t.current ? " (current)" : ""} ${t.url} ${JSON.stringify(t.title)}${t.error ? ` [${t.error}]` : ""}`)
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
        return `${header}\n${[`URL: ${snap.url}`, `Title: ${snap.title}`, WORDS_HEADING, list.text, TEXT_HEADING, textWithoutElements(snap.text, list.listed)].join("\n")}`;
      }
      const extra = snap.elements.length - MULTI_TAB_ELEMENTS;
      if (extra <= 0) return `${header}\n${formatSnapshot(snap)}`;
      const shown = snap.elements.slice(0, MULTI_TAB_ELEMENTS);
      const note = `(${extra} more elements; switch_tab to ${r.tab} and call read_page for the full list)`;
      const body = [`URL: ${snap.url}`, `Title: ${snap.title}`, formatElements(shown), note, TEXT_HEADING, textWithoutElements(snap.text, shown)];
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
    return `Scrolled ${direction} ${num(r.moved)} px${where} (now ${num(r.position)} of ${num(r.size)}; ${pct}% ${vertical ? "down" : "across"}${atEnd ? `; ${end}` : ""}).`;
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

/** An element as the page change compares it: same role, label, kind and target. */
const lookKey = (el: ElementInfo) => [el.role || el.tag, el.name, el.type ?? "", el.testId ?? "", el.href ?? "", el.inDialog ? "dialog" : ""].join("|");
/** The state act can change: a field's value, checked, validation, enabled. */
const stateKey = (el: ElementInfo) => JSON.stringify([el.value ?? "", el.checked ?? null, el.invalid ?? "", el.disabled ?? false]);
const withoutHash = (url: string) => url.replace(/#.*$/, "");

/** Lines of new text shown after act (the rest is one read_page away). */
export const CHANGE_TEXT_MAX = 1500;
/** Elements listed per kind of change after act. */
export const CHANGE_ELEMENTS_MAX = 40;

/**
 * What act changed on the page (Jev mode), instead of the whole page again:
 * the elements that appeared, went away or changed state (a field's value,
 * checked, its validation message), and the new text. When the address
 * changed (another page), the new page in full.
 */
export function formatPageChange(before: PageSnapshot, after: PageSnapshot): string {
  if (withoutHash(before.url) !== withoutHash(after.url)) return formatSnapshot(after, { words: true });
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
  let newText = textWithoutElements(
    after.text
      .split("\n")
      .filter((l) => !oldLines.has(l.trim()))
      .join("\n"),
    after.elements,
  );
  if (newText.length > CHANGE_TEXT_MAX) newText = `${newText.slice(0, CHANGE_TEXT_MAX)}… (more in read_page)`;
  const newFrames = (after.frames ?? []).filter((f) => !(before.frames ?? []).some((b) => b.url === f.url));
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
  out.push(...framesNote({ ...after, frames: newFrames }));
  return out.join("\n");
}
