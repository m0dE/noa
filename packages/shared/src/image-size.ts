/**
 * A picture's width and height from its file header (PNG, JPEG, GIF, WebP, BMP), without decoding it: what
 * list_files shows for a picture in the user's files. `read(offset, length)` gives the file's bytes from offset (fewer
 * at its end), so a caller with a file on disk reads only the few small pieces the header needs (a JPEG's size comes
 * after its other segments, which are skipped, not read).
 */

export interface PictureSize {
  width: number;
  height: number;
}

/** JPEG segments walked at most before giving up (a real file reaches its frame header in a handful). */
const MAX_JPEG_SEGMENTS = 200;

/** The size the header says; null for another kind of file, or a header cut short or not understood. */
export function imageSize(read: (offset: number, length: number) => Uint8Array): PictureSize | null {
  const head = read(0, 32);
  if (head.length < 10) return null;
  const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
  const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  const le32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + ((b[i + 3]! << 24) >>> 0);
  const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const ok = (width: number, height: number): PictureSize | null => (width > 0 && height > 0 ? { width, height } : null);

  // PNG: the IHDR chunk comes first.
  if (head[0] === 0x89 && ascii(head, 1, 3) === "PNG" && head.length >= 24 && ascii(head, 12, 4) === "IHDR") return ok(be32(head, 16), be32(head, 20));
  if (ascii(head, 0, 4) === "GIF8") return ok(le16(head, 6), le16(head, 8));
  if (head[0] === 0x42 && head[1] === 0x4d && head.length >= 26) {
    // BMP: a BITMAPINFOHEADER (or later) has 32-bit sizes; a negative height means top-down rows.
    return ok(Math.abs(le32(head, 18) | 0), Math.abs(le32(head, 22) | 0));
  }
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP" && head.length >= 30) {
    const kind = ascii(head, 12, 4);
    if (kind === "VP8X") return ok(1 + (head[24]! | (head[25]! << 8) | (head[26]! << 16)), 1 + (head[27]! | (head[28]! << 8) | (head[29]! << 16)));
    if (kind === "VP8L" && head[20] === 0x2f) {
      const bits = le32(head, 21);
      return ok(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
    if (kind === "VP8 ") return ok(le16(head, 26) & 0x3fff, le16(head, 28) & 0x3fff);
    return null;
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    // JPEG: walk the segments to the frame header (SOF0-SOF15 but DHT C4, JPG C8 and DAC CC).
    let at = 2;
    for (let n = 0; n < MAX_JPEG_SEGMENTS; n++) {
      const seg = read(at, 9);
      if (seg.length < 4 || seg[0] !== 0xff) return null;
      const marker = seg[1]!;
      // Fill bytes before a marker.
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      // Markers without a length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      const length = be16(seg, 2);
      if (length < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return seg.length >= 9 ? ok(be16(seg, 7), be16(seg, 5)) : null;
      }
      at += 2 + length;
    }
  }
  return null;
}

/** imageSize of bytes in memory. */
export function imageSizeOfBytes(bytes: Uint8Array): PictureSize | null {
  return imageSize((offset, length) => bytes.subarray(offset, offset + length));
}
