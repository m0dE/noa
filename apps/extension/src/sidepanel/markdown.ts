/**
 * A small, safe Markdown renderer for Claude's text in the chat. It builds
 * DOM nodes (createElement / text nodes only, never innerHTML), so HTML in
 * the text shows as text. Links are kept only for http(s) URLs.
 *
 * Blocks: paragraphs (single newlines are line breaks), ATX headings, fenced
 * code, ordered and unordered lists (nested by indentation), blockquotes,
 * horizontal rules and simple pipe tables. Inline: `code`, **bold**,
 * *italic* / _italic_, ~~strike~~, [links](https://...), <https://...> and
 * bare https:// URLs, and backslash escapes.
 *
 * While text streams in, the last block is rendered "open": an unclosed code
 * fence is a code block to the end, and an unclosed ** / * / ` / ~~ or a
 * half-written link is closed or hidden instead of showing as raw marks.
 * MarkdownView re-renders only the blocks that changed.
 */
import { trimUrlEnd } from "./format.js";

export type Block =
  | { type: "p"; src: string; text: string }
  | { type: "h"; src: string; level: number; text: string }
  | { type: "code"; src: string; lang: string; text: string; closed: boolean }
  | { type: "list"; src: string; ordered: boolean; start: number; items: string[][] }
  | { type: "quote"; src: string; lines: string[] }
  | { type: "hr"; src: string }
  | { type: "table"; src: string; head: string[]; align: ("left" | "right" | "center" | null)[]; rows: string[][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isBlank = (l: string) => !l.trim();

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Removes up to `n` leading spaces (a tab counts as 4). */
function dedent(line: string, n: number): string {
  let i = 0;
  let col = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    col += line[i] === "\t" ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

function indentOf(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === " ") col++;
    else if (c === "\t") col += 4;
    else break;
  }
  return col;
}

/** Top-level blocks of Markdown text, each with the source lines it came from. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const start = i;
    const src = () => lines.slice(start, i).join("\n");

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
        if (close.test(l)) {
          closed = true;
          i++;
          break;
        }
        body.push(dedent(l, indent));
        i++;
      }
      out.push({ type: "code", src: src(), lang: fence[2] ?? "", text: body.join("\n"), closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      i++;
      out.push({ type: "h", src: src(), level: heading[1]!.length, text: heading[2] ?? "" });
      continue;
    }

    if (HR.test(line)) {
      i++;
      out.push({ type: "hr", src: src() });
      continue;
    }

    if (QUOTE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const m = QUOTE.exec(lines[i]!);
        // Lazy continuation: a plain line right after a quote line stays in the quote.
        if (!m && startsBlock(lines[i]!)) break;
        q.push(m ? m[1]! : lines[i]!);
        i++;
      }
      out.push({ type: "quote", src: src(), lines: q });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const base = indentOf(line);
      const ordered = /\d/.test(item[2]!);
      const start0 = ordered ? parseInt(item[2]!, 10) : 1;
      const items: string[][] = [];
      let cur: string[] | null = null;
      let contentIndent = 0;
      while (i < lines.length) {
        const l = lines[i]!;
        const m = LIST_ITEM.exec(l);
        if (m && indentOf(l) <= base + 1 && /\d/.test(m[2]!) === ordered) {
          cur = [m[3] ?? ""];
          items.push(cur);
          contentIndent = indentOf(l) + m[2]!.length + 1;
          i++;
          continue;
        }
        if (m && indentOf(l) <= base + 1) break; // another kind of list
        if (isBlank(l)) {
          // A blank line continues the list only if more of it follows.
          let j = i + 1;
          while (j < lines.length && isBlank(lines[j]!)) j++;
          const next = lines[j];
          if (next === undefined) break;
          const nm = LIST_ITEM.exec(next);
          const sameList = nm && indentOf(next) <= base + 1 && /\d/.test(nm[2]!) === ordered;
          if (!sameList && indentOf(next) < Math.min(contentIndent, base + 2)) break;
          cur!.push("");
          i++;
          continue;
        }
        if (indentOf(l) > base + 1) {
          cur!.push(dedent(l, contentIndent));
          i++;
          continue;
        }
        // Lazy continuation of the item's paragraph.
        if (startsBlock(l)) break;
        cur!.push(l.trim());
        i++;
      }
      for (const it of items) while (it.at(-1) === "") it.pop();
      out.push({ type: "list", src: src(), ordered, start: start0, items });
      continue;
    }

    // A pipe table: header row, separator, rows.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) rows.push(splitRow(lines[i++]!));
      out.push({ type: "table", src: src(), head, align, rows });
      continue;
    }

    // Paragraph: until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!.trim());
    out.push({ type: "p", src: src(), text: para.join("\n") });
  }
  return out;
}

// ---- Inline -------------------------------------------------------------

/** http(s) URLs only (no javascript:, data:, relative or protocol-relative links). */
export function safeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function link(href: string, children: Node[]): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  a.append(...children);
  return a;
}

function wrap(tag: "strong" | "em" | "del" | "code", children: Node[] | string): HTMLElement {
  const el = document.createElement(tag);
  if (typeof children === "string") el.textContent = children;
  else el.append(...children);
  return el;
}

/**
 * Closes what the tail of streaming text left open, so it renders as it will
 * once complete: an odd ` or ** / * / ~~, and a half-written [link](url.
 */
export function closeDangling(text: string): string {
  let t = text;
  // A link whose URL is still coming: show its text only.
  t = t.replace(/\[([^\]\n]*)\]\([^)\s]*$/, "$1");
  // A lone "[" or "![" at the very end.
  t = t.replace(/!?\[[^\]\n]*$/, (m) => m.replace(/^!?\[/, ""));
  // The start of a code fence ("`" or "``" alone on the last line).
  t = t.replace(/(^|\n) {0,3}(`{1,2}|~{1,2})$/, "$1");
  const code = (t.match(/`/g) ?? []).length;
  if (code % 2 === 1) return /`\s*$/.test(t) ? closeDangling(t.replace(/`\s*$/, "")) : `${t}\``;
  // Outside code spans, count emphasis marks.
  const plain = t.replace(/`[^`]*`/g, "");
  let tail = "";
  if ((plain.match(/~~/g) ?? []).length % 2 === 1) tail = `~~${tail}`;
  const strong = (plain.match(/\*\*/g) ?? []).length;
  const singles = (plain.replace(/\*\*/g, "").replace(/^[ \t]*\*[ \t]/gm, "").match(/\*/g) ?? []).length;
  if (singles % 2 === 1) tail = `*${tail}`;
  if (strong % 2 === 1) tail = `**${tail}`;
  // A mark with nothing after it yet ("**" at the very end) would render as an empty tag: drop it.
  if (tail && /(\*\*|~~|\*)$/.test(t) && !/\\(\*\*|~~|\*)$/.test(t)) {
    const m = /(\*\*|~~|\*)+$/.exec(t)!;
    const stripped = t.slice(0, m.index);
    if (stripped !== t) return closeDangling(stripped);
  }
  return t + tail;
}

/** Inline Markdown to DOM nodes. `\n` becomes <br>. */
export function renderInline(text: string): Node[] {
  const out: Node[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const parts = buf.split("\n");
    parts.forEach((p, k) => {
      if (k) out.push(document.createElement("br"));
      if (p) out.push(document.createTextNode(p));
    });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);

    if (c === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        let code = text.slice(i + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        flush();
        out.push(wrap("code", code));
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    if (c === "[") {
      const m = /^\[((?:[^\][\\]|\\.)*)\]\(\s*<?([^()\s<>]*(?:\([^()\s]*\)[^()\s<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (m) {
        const href = safeUrl(m[2]!);
        flush();
        const label = renderInline(m[1]!);
        if (href) out.push(link(href, label.length ? label : [document.createTextNode(href)]));
        else out.push(...label);
        i += m[0].length;
        continue;
      }
    }

    if (c === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(rest);
      const href = m && safeUrl(m[1]!);
      if (m && href) {
        flush();
        out.push(link(href, [document.createTextNode(m[1]!)]));
        i += m[0].length;
        continue;
      }
    }

    // A bare scheme with no host after it ("https://" at the end of a streamed chunk, or before a
    // space) matches nothing here and stays plain text.
    const bare = (c === "h" || c === "H") && !/[\w/]$/.test(buf) ? /^https?:\/\/[^\s<>`]+/i.exec(rest) : null;
    if (bare) {
      const url = trimUrlEnd(bare[0]);
      const href = safeUrl(url);
      if (href) {
        flush();
        out.push(link(href, [document.createTextNode(url)]));
        i += url.length;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const double = text[i + 1] === c;
      if (c === "~" && !double) {
        buf += c;
        i++;
        continue;
      }
      const mark = double ? c + c : c;
      const prev = i > 0 ? text[i - 1]! : " ";
      const next = text[i + mark.length] ?? " ";
      // Opens only before a non-space; _ only at a word start (snake_case stays as is).
      const canOpen = !/\s/.test(next) && !(c === "_" && /\w/.test(prev));
      if (canOpen) {
        const end = findClose(text, i + mark.length, mark);
        if (end > 0) {
          flush();
          const inner = renderInline(text.slice(i + mark.length, end));
          out.push(wrap(c === "~" ? "del" : double ? "strong" : "em", inner));
          i = end + mark.length;
          continue;
        }
      }
      buf += mark;
      i += mark.length;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Index of the closing `mark` for an opener before `from`, or -1. Skips code spans. */
function findClose(text: string, from: number, mark: string): number {
  const c = mark[0]!;
  let i = from;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      i = end > 0 ? end + run.length : i + run.length;
      continue;
    }
    if (text.startsWith(mark, i)) {
      const prev = text[i - 1] ?? " ";
      const after = text[i + mark.length] ?? " ";
      // A single * that is half of ** belongs to a nested strong: skip the pair.
      if (mark.length === 1 && after === c) {
        const inner = findClose(text, i + 2, c + c);
        if (inner > 0) {
          i = inner + 2;
          continue;
        }
        i += 2;
        continue;
      }
      const closes = !/\s/.test(prev) && i > from && !(c === "_" && /\w/.test(after));
      if (closes) return i;
    }
    i++;
  }
  return -1;
}

// ---- Blocks to DOM ------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, children: Node[] = [], cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...children);
  return e;
}

function inline(text: string, open: boolean): Node[] {
  return renderInline(open ? closeDangling(text) : text);
}

/** Markdown (a fragment of one, while streaming) to nodes. */
function renderBlocks(blocks: Block[], open: boolean): Node[] {
  return blocks.map((b, k) => renderBlock(b, open && k === blocks.length - 1));
}

export function renderBlock(b: Block, open = false): HTMLElement {
  switch (b.type) {
    case "p":
      return el("p", inline(b.text, open));
    case "h":
      // Headings are small in a side panel: # and ## share a size, ### and below are a step down.
      return el(`h${Math.min(6, Math.max(1, b.level))}` as "h1", inline(b.text, open));
    case "hr":
      return el("hr");
    case "code": {
      const code = el("code");
      code.textContent = b.text;
      if (b.lang) code.setAttribute("data-lang", b.lang);
      const pre = el("pre", [code]);
      if (!b.closed && open) pre.setAttribute("data-open", "true");
      return pre;
    }
    case "quote":
      return el("blockquote", renderBlocks(parseBlocks(b.lines.join("\n")), open));
    case "list": {
      const list = el(b.ordered ? "ol" : "ul");
      if (b.ordered && b.start !== 1) list.setAttribute("start", String(b.start));
      b.items.forEach((lines, k) => {
        const last = open && k === b.items.length - 1;
        const inner = parseBlocks(lines.join("\n"));
        const li = el("li");
        // A tight item's first paragraph is its text, not a <p>.
        if (inner[0]?.type === "p" && !lines.includes("")) {
          li.append(...inline(inner[0].text, last && inner.length === 1));
          li.append(...renderBlocks(inner.slice(1), last));
        } else {
          li.append(...renderBlocks(inner, last));
        }
        list.append(li);
      });
      return list;
    }
    case "table": {
      const thead = el("thead", [el("tr", b.head.map((c, k) => cell("th", c, b.align[k] ?? null)))]);
      const tbody = el(
        "tbody",
        b.rows.map((r) => el("tr", b.head.map((_, k) => cell("td", r[k] ?? "", b.align[k] ?? null)))),
      );
      return el("div", [el("table", [thead, tbody])], "md-table");
    }
  }
}

function cell(tag: "th" | "td", text: string, align: string | null): HTMLElement {
  const c = el(tag, renderInline(text));
  if (align) c.setAttribute("style", `text-align: ${align}`);
  return c;
}

/** Markdown to a fragment. `streaming`: the text is still being written (the last block renders open). */
/**
 * A container that shows Markdown and can be updated as text grows: blocks
 * whose source did not change keep their DOM (no flicker, selections in
 * earlier paragraphs survive); only the changed tail is rebuilt.
 */
export class MarkdownView {
  private keys: string[] = [];

  constructor(readonly root: HTMLElement) {}

  update(text: string, streaming = false): void {
    const blocks = parseBlocks(text);
    const kids = [...this.root.children];
    const keys = blocks.map((b, k) => (streaming && k === blocks.length - 1 ? `open\u0000${b.src}` : b.src));
    let same = 0;
    while (same < keys.length && same < this.keys.length && keys[same] === this.keys[same] && kids[same]) same++;
    for (const k of kids.slice(same)) k.remove();
    for (let k = same; k < blocks.length; k++) this.root.append(renderBlock(blocks[k]!, streaming && k === blocks.length - 1));
    this.keys = keys;
  }
}
