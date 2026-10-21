import { describe, expect, it } from "vitest";
import { cleanFileMeta, fileSearchText, imageSize, imageSizeOfBytes } from "../src/index.js";

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

const PNG = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(1200), be32(800), [8, 6, 0, 0, 0]);
// SOI, an APP1 segment (as a large EXIF block would be), then the frame header.
const app1 = new Array(3000).fill(0x41);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe1], be16(app1.length + 2), app1, [0xff, 0xc4], be16(4), [0, 0], [0xff, 0xc2], be16(17), [8], be16(480), be16(640), [3], new Array(9).fill(0));

describe("imageSize", () => {
  it("reads PNG, GIF, JPEG (past its other segments), WebP and BMP headers", () => {
    expect(imageSizeOfBytes(PNG)).toEqual({ width: 1200, height: 800 });
    expect(imageSizeOfBytes(bytes("GIF89a", le16(320), le16(200), new Array(10).fill(0)))).toEqual({ width: 320, height: 200 });
    expect(imageSizeOfBytes(JPEG)).toEqual({ width: 640, height: 480 });
    expect(imageSizeOfBytes(bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", be32(10).reverse(), [0, 0, 0, 0], le24(1919), le24(1079)))).toEqual({ width: 1920, height: 1080 });
    // VP8L: 14 bits of width - 1, then 14 bits of height - 1.
    const bits = (99 & 0x3fff) | ((49 & 0x3fff) << 14);
    expect(imageSizeOfBytes(bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255], [0, 0, 0, 0, 0]))).toEqual({ width: 100, height: 50 });
    expect(imageSizeOfBytes(bytes("BM", new Array(16).fill(0), [0x20, 3, 0, 0], [0x58, 0x02, 0, 0], [0, 0, 0, 0]))).toEqual({ width: 800, height: 600 });
  });

  it("reads a JPEG's frame header without reading the segments before it", () => {
    const reads: [number, number][] = [];
    const size = imageSize((offset, length) => (reads.push([offset, length]), JPEG.subarray(offset, offset + length)));
    expect(size).toEqual({ width: 640, height: 480 });
    expect(reads.reduce((n, [, l]) => n + l, 0)).toBeLessThan(100);
  });

  it("is null for other files and for headers cut short", () => {
    expect(imageSizeOfBytes(bytes("%PDF-1.4 a document of some sort"))).toBeNull();
    expect(imageSizeOfBytes(PNG.subarray(0, 20))).toBeNull();
    expect(imageSizeOfBytes(JPEG.subarray(0, 500))).toBeNull();
    expect(imageSizeOfBytes(new Uint8Array())).toBeNull();
  });
});

describe("cleanFileMeta", () => {
  it("keeps the valid fields, trimmed and cut to their limits, and only web addresses", () => {
    expect(cleanFileMeta({ width: 800, height: 600, source: "https://a.test/x.png", page: "javascript:alert(1)", pageTitle: "  A\n page ", about: "x".repeat(400), extra: 1 })).toEqual({
      width: 800,
      height: 600,
      source: "https://a.test/x.png",
      pageTitle: "A page",
      about: "x".repeat(300),
    });
  });

  it("drops a size without both sides, and is undefined when nothing is left", () => {
    expect(cleanFileMeta({ width: 800 })).toBeUndefined();
    expect(cleanFileMeta({ source: "data:image/png;base64,AAAA", about: "  " })).toBeUndefined();
    expect(cleanFileMeta("not an object")).toBeUndefined();
  });
});

describe("fileSearchText", () => {
  it("says what makes a file stand out: its name as words, folder, shape and kind, note, page and site", () => {
    expect(
      fileSearchText({
        name: "IMG_3302-frontView.png",
        folder: "products",
        contentType: "image/png",
        meta: { width: 1200, height: 800, about: "Stoneware mug", pageTitle: "Mugs – Shop", page: "https://www.shop.test/mugs" },
      }),
    ).toBe('IMG 3302 front View png. in products. landscape picture. Stoneware mug. from the page "Mugs – Shop". on shop.test');
    expect(fileSearchText({ name: "notes.txt" })).toBe("notes txt");
  });
});
