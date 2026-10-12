/**
 * The text of a Word document (.docx), for the model to read. A .docx is a zip
 * archive whose word/document.xml holds the body; this reads that one entry
 * (stored or deflated, the only methods Word writes) with the browser's own
 * DecompressionStream, then takes the text of its runs, keeping paragraphs,
 * tabs, line breaks and table cells. No library: a zip reader for one entry and
 * a WordprocessingML text walk are a few dozen lines, and the document's
 * layout, images and styles are not needed.
 */

/** Largest document.xml read (a zip bomb stops here). */
export const MAX_DOCX_XML_BYTES = 50 * 1024 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const BODY = "word/document.xml";

export class DocxError extends Error {}

/** The document's text: one line per paragraph, tabs between table cells. */
export async function docxText(bytes: Uint8Array): Promise<string> {
  return wordXmlText(await zipEntry(bytes, BODY));
}

/** One entry of a zip archive, decompressed, as text. */
async function zipEntry(bytes: Uint8Array, name: string): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  // The end of central directory record is in the last 64 KB + 22 bytes (after it only a comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxError("not a Word document (no zip directory)");
  const entries = u16(eocd + 10);
  let at = u32(eocd + 16);
  const decoder = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || u32(at) !== CENTRAL) throw new DocxError("damaged Word document (zip directory)");
    const method = u16(at + 10);
    const packed = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const next = at + 46 + nameLength + u16(at + 30) + u16(at + 32);
    if (decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)) === name) {
      if (size > MAX_DOCX_XML_BYTES) throw new DocxError("the document is too large to read");
      const local = u32(at + 42);
      if (u32(local) !== LOCAL) throw new DocxError("damaged Word document (zip entry)");
      const start = local + 30 + u16(local + 26) + u16(local + 28);
      const data = bytes.subarray(start, start + packed);
      if (method === 0) return decoder.decode(data);
      if (method === 8) return decoder.decode(await inflate(data));
      throw new DocxError(`unsupported compression in the Word document (method ${method})`);
    }
    at = next;
  }
  throw new DocxError("not a Word document (no word/document.xml)");
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOCX_XML_BYTES) {
      await reader.cancel();
      throw new DocxError("the document is too large to read");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/**
 * The text of WordprocessingML (document.xml): the characters of <w:t> runs, a tab for <w:tab/> and between table
 * cells, a line break for <w:br/>, <w:cr/> and at the end of each paragraph and table row.
 */
export function wordXmlText(xml: string): string {
  let out = "";
  let inText = false;
  for (const m of xml.matchAll(/<(\/?)([A-Za-z0-9]+:)?([A-Za-z]+)\b[^>]*?(\/?)>|([^<]+)/g)) {
    const [, closing, , tag, selfClosing, text] = m;
    if (text !== undefined) {
      if (inText) out += decodeEntities(text);
      continue;
    }
    if (tag === "t") inText = !closing && !selfClosing;
    else if (tag === "tab" && !closing) out += "\t";
    else if ((tag === "br" || tag === "cr") && !closing) out += "\n";
    else if (closing && tag === "p") out += "\n";
    else if (closing && tag === "tc") out += "\t";
    else if (closing && tag === "tr") out = `${out.replace(/[\t\n]+$/, "")}\n`;
  }
  // Cells end with a paragraph too: no line break right before a cell's tab.
  return out
    .replace(/\n\t/g, "\t")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
