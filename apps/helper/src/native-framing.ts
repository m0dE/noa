/**
 * Chrome native messaging framing: a 4-byte little-endian length followed by
 * that many bytes of UTF-8 JSON. Chrome caps host -> extension messages at
 * 1 MB and extension -> host messages at 64 MB.
 */

export const MAX_NATIVE_IN = 64 * 1024 * 1024;
export const MAX_NATIVE_OUT = 1024 * 1024;

export class FrameTooLargeError extends Error {}

export function encodeNativeMessage(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > MAX_NATIVE_OUT) {
    throw new FrameTooLargeError(`native message too large: ${body.length} bytes (max ${MAX_NATIVE_OUT})`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Streaming decoder. Feed raw stdin chunks, get complete messages back. */
export class NativeDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_NATIVE_IN) {
        this.buf = Buffer.alloc(0);
        throw new FrameTooLargeError(`incoming native message too large: ${len} bytes`);
      }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body));
    }
    return out;
  }
}
