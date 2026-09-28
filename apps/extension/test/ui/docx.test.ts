import { describe, expect, it } from "vitest";
import { docxText, DocxError, wordXmlText } from "../../src/sidepanel/attachments/docx.js";

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

/** A zip archive of these entries (stored or deflated), the way Word writes a .docx. */
async function zip(entries: { name: string; text: string; store?: boolean }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.text);
    const body = e.store ? data : await deflate(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, e.store ? 0 : 8, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, e.store ? 0 : 8, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const dirLength = centrals.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirLength, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...parts, ...centrals, new Uint8Array(end.buffer)] as BlobPart[]).arrayBuffer());
}

const BODY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Launch plan</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Post on </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Friday</w:t></w:r><w:r><w:tab/><w:t>9:00 &amp; 18:00</w:t></w:r></w:p>
<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two &#233;</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Day</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Posts</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Mon</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr/></w:body></w:document>`;

const EXPECTED = "Launch plan\nPost on Friday\t9:00 & 18:00\nLine one\nLine two é\nDay\tPosts\nMon\t3";

describe("docxText", () => {
  it("reads the paragraphs, tabs, breaks and table cells of word/document.xml (deflated)", async () => {
    const bytes = await zip([
      { name: "[Content_Types].xml", text: "<Types/>" },
      { name: "word/styles.xml", text: "<w:styles><w:t>not body text</w:t></w:styles>" },
      { name: "word/document.xml", text: BODY },
    ]);
    expect(await docxText(bytes)).toBe(EXPECTED);
  });

  it("reads a stored (uncompressed) entry too", async () => {
    expect(await docxText(await zip([{ name: "word/document.xml", text: BODY, store: true }]))).toBe(EXPECTED);
  });

  it("says plainly what is wrong with a file that is not a Word document", async () => {
    await expect(docxText(new TextEncoder().encode("just text, not a zip"))).rejects.toThrow(DocxError);
    await expect(docxText(await zip([{ name: "xl/workbook.xml", text: "<x/>" }]))).rejects.toThrow("not a Word document (no word/document.xml)");
  });

  it("wordXmlText ignores XML outside text runs", () => {
    expect(wordXmlText('<w:p><w:r><w:instrText>PAGE</w:instrText><w:t>Hi</w:t></w:r></w:p><w:p/>')).toBe("Hi");
  });
});
