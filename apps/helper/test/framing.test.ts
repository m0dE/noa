import { describe, expect, it } from "vitest";
import { encodeNativeMessage, NativeDecoder, MAX_NATIVE_OUT } from "../src/native-framing.js";
import { encodeLine, LineDecoder } from "../src/line-framing.js";

describe("native framing", () => {
  it("round trips a message with a 4-byte little-endian length prefix", () => {
    const frame = encodeNativeMessage({ id: "1", method: "helper.hello", params: { text: "héllo ✓" } });
    const len = frame.readUInt32LE(0);
    expect(len).toBe(frame.length - 4);
    const out = new NativeDecoder().push(frame);
    expect(out).toEqual([{ id: "1", method: "helper.hello", params: { text: "héllo ✓" } }]);
  });

  it("reassembles frames split across chunks, even inside the header", () => {
    const frame = encodeNativeMessage({ a: 1, b: "x".repeat(100) });
    const dec = new NativeDecoder();
    expect(dec.push(frame.subarray(0, 2))).toEqual([]);
    expect(dec.push(frame.subarray(2, 30))).toEqual([]);
    expect(dec.push(frame.subarray(30))).toEqual([{ a: 1, b: "x".repeat(100) }]);
  });

  it("decodes several frames delivered in one chunk", () => {
    const buf = Buffer.concat([encodeNativeMessage({ n: 1 }), encodeNativeMessage({ n: 2 }), encodeNativeMessage({ n: 3 }).subarray(0, 5)]);
    const dec = new NativeDecoder();
    expect(dec.push(buf)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(dec.push(encodeNativeMessage({ n: 3 }).subarray(5))).toEqual([{ n: 3 }]);
  });

  it("refuses to encode messages over 1 MB", () => {
    expect(() => encodeNativeMessage({ big: "x".repeat(MAX_NATIVE_OUT) })).toThrow(/too large/);
  });

  it("rejects an incoming frame header over the 64 MB limit", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
    expect(() => new NativeDecoder().push(header)).toThrow(/too large/);
  });
});

describe("line framing", () => {
  it("round trips newline-delimited JSON", () => {
    const line = encodeLine({ id: "1", result: { text: "a\nb" } });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(new LineDecoder().push(line)).toEqual([{ id: "1", result: { text: "a\nb" } }]);
  });

  it("buffers partial lines and multi-byte characters split across chunks", () => {
    const bytes = Buffer.from(encodeLine({ s: "✓✓" }) + encodeLine({ s: 2 }), "utf8");
    const dec = new LineDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...dec.push(bytes.subarray(i, i + 3)));
    expect(out).toEqual([{ s: "✓✓" }, { s: 2 }]);
  });

  it("skips blank lines", () => {
    expect(new LineDecoder().push('\n{"a":1}\r\n\n')).toEqual([{ a: 1 }]);
  });
});
