import { describe, expect, it } from "vitest";
import { MessageAccumulator, StreamError, readSse, type SseEvent } from "../src/sse.js";
import { postMessages, type MessagesRequest } from "../src/anthropic.js";

/** A byte stream that delivers `text` in the given chunk sizes (cycled), to cut lines and UTF-8 characters anywhere. */
function chunked(text: string, sizes: number[] = [7], fail?: Error): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  let k = 0;
  return new ReadableStream({
    pull(c) {
      if (pos >= bytes.length) {
        if (fail) c.error(fail);
        else c.close();
        return;
      }
      const n = sizes[k++ % sizes.length]!;
      c.enqueue(bytes.slice(pos, pos + n));
      pos += n;
    },
  });
}

async function all(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of readSse(body)) out.push(e);
  return out;
}

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A real-shaped stream (from the Messages streaming docs): thinking, text, then a tool_use with its input in parts. */
const STREAM = [
  ev("message_start", { type: "message_start", message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, usage: { input_tokens: 25, output_tokens: 1 } } }),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me check." } }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig==" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  ev("ping", { type: "ping" }),
  ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Héllo **wörld** 🌍" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: ", opening it." } }),
  ev("content_block_stop", { type: "content_block_stop", index: 1 }),
  ev("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "navigate", input: {} } }),
  ev("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"url": "https://ex' } }),
  ev("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'ample.com/ä"}' } }),
  ev("content_block_stop", { type: "content_block_stop", index: 2 }),
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 89 } }),
  ev("message_stop", { type: "message_stop" }),
].join("");

describe("readSse", () => {
  it("splits events across any chunk boundary, CRLF or LF, skipping comments; multi-line data is joined", async () => {
    const text = ": comment\r\nevent: a\r\ndata: 1\r\n\r\nevent: b\ndata: x\ndata: y\n\ndata:no-space\n\n";
    for (const sizes of [[1], [2, 3], [5], [1000]]) {
      expect(await all(chunked(text, sizes))).toEqual([
        { event: "a", data: "1" },
        { event: "b", data: "x\ny" },
        { event: "message", data: "no-space" },
      ]);
    }
  });

  it("a last event without its blank line still comes out; a CR split from its LF is one line end", async () => {
    expect(await all(chunked("event: a\r\ndata: 1\r", [9, 100]))).toEqual([{ event: "a", data: "1" }]);
    expect(await all(chunked("event: a\r\ndata: 1\r\n\r\n", [8, 1, 1, 1]))).toEqual([{ event: "a", data: "1" }]);
  });
});

describe("MessageAccumulator", () => {
  it("rebuilds the message: text deltas reported as they come, tool input from its JSON parts, thinking kept", async () => {
    for (const sizes of [[1], [3, 11], [64]]) {
      const texts: [string, number, string][] = [];
      const acc = new MessageAccumulator((id, i, t) => texts.push([id, i, t]));
      for await (const e of readSse(chunked(STREAM, sizes))) acc.apply(e);
      expect(acc.done).toBe(true);
      expect(texts).toEqual([
        ["msg_01", 1, "Héllo **wörld** 🌍"],
        ["msg_01", 1, ", opening it."],
      ]);
      expect(acc.message).toMatchObject({
        id: "msg_01",
        stop_reason: "tool_use",
        usage: { input_tokens: 25, output_tokens: 89 },
        content: [
          { type: "thinking", thinking: "Let me check.", signature: "sig==" },
          { type: "text", text: "Héllo **wörld** 🌍, opening it." },
          { type: "tool_use", id: "toolu_1", name: "navigate", input: { url: "https://example.com/ä" } },
        ],
      });
    }
  });

  it("a tool_use with no input parts gets {}", () => {
    const acc = new MessageAccumulator();
    acc.apply({ event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: "m", content: [] } }) });
    acc.apply({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "list_tabs", input: {} } }) });
    acc.apply({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) });
    expect(acc.message!.content[0]).toEqual({ type: "tool_use", id: "t", name: "list_tabs", input: {} });
  });

  it("error events and broken tool JSON throw a StreamError with the API's error type", () => {
    const acc = new MessageAccumulator();
    expect(() => acc.apply({ event: "error", data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) })).toThrow(
      expect.objectContaining({ errorType: "overloaded_error", message: "overloaded_error: Overloaded" }),
    );
    expect(() => acc.apply({ event: "x", data: "{not json" })).toThrow(StreamError);
    acc.apply({ event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: "m", content: [] } }) });
    acc.apply({ event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "act", input: {} } }) });
    acc.apply({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"steps": [' } }) });
    expect(() => acc.apply({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) })).toThrow(/unreadable tool input for act/);
  });
});

describe("postMessages with stream", () => {
  const body: MessagesRequest = { model: "m", max_tokens: 10, system: [], tools: [], messages: [] };
  const serve = (res: () => Response) => {
    const sent: any[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return res();
    }) as unknown as typeof fetch;
    return { f, sent };
  };
  const sse = (text: string, fail?: Error) => new Response(chunked(text, [13], fail), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });

  it("asks for a stream, reports text as it comes and returns the whole message", async () => {
    const { f, sent } = serve(() => sse(STREAM));
    const got: string[] = [];
    const r = await postMessages(f, "k", body, undefined, {}, { onText: (id, i, t) => got.push(`${id}:${i}:${t}`) });
    expect(sent[0].stream).toBe(true);
    expect(got).toEqual(["msg_01:1:Héllo **wörld** 🌍", "msg_01:1:, opening it."]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.message.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
  });

  it("without the stream option the request has no stream field", async () => {
    const { f, sent } = serve(() => new Response(JSON.stringify({ id: "m", content: [] }), { status: 200 }));
    expect((await postMessages(f, "k", body)).kind).toBe("ok");
    expect(sent[0].stream).toBeUndefined();
  });

  it("an endpoint that answers JSON anyway (no streaming) still works", async () => {
    const { f } = serve(() => new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } }));
    const got: string[] = [];
    const r = await postMessages(f, "k", body, undefined, {}, { onText: (_id, _i, t) => got.push(t) });
    expect(r).toMatchObject({ kind: "ok", message: { content: [{ type: "text", text: "hi" }] } });
    expect(got).toEqual([]);
  });

  it("errors: an overloaded error event and a dropped connection are transient; an invalid_request error event is not; a stream without message_stop is transient", async () => {
    const start = STREAM.slice(0, STREAM.indexOf("event: content_block_start"));
    const overloaded = start + ev("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    expect(await postMessages(serve(() => sse(overloaded)).f, "k", body, undefined, {}, { onText: () => {} })).toEqual({
      kind: "transient",
      reason: "Claude API stream error (overloaded_error: Overloaded)",
    });
    const invalid = start + ev("error", { type: "error", error: { type: "invalid_request_error", message: "bad" } });
    expect((await postMessages(serve(() => sse(invalid)).f, "k", body, undefined, {}, { onText: () => {} })).kind).toBe("error");
    const dropped = await postMessages(serve(() => sse(start, new TypeError("network reset"))).f, "k", body, undefined, {}, { onText: () => {} });
    expect(dropped).toEqual({ kind: "transient", reason: "Claude API network error while reading the response: network reset" });
    expect(await postMessages(serve(() => sse(start)).f, "k", body, undefined, {}, { onText: () => {} })).toEqual({ kind: "transient", reason: "Claude API stream ended early" });
  });

  it("HTTP errors are read as before (JSON body), e.g. 529", async () => {
    const { f } = serve(() => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 }));
    expect(await postMessages(f, "k", body, undefined, {}, { onText: () => {} })).toEqual({ kind: "transient", reason: "Claude API overloaded (HTTP 529: overloaded_error: Overloaded)" });
  });

  it("an abort mid-stream comes back as aborted", async () => {
    const ac = new AbortController();
    // Up to the first text delta; the stream then stays open until the abort.
    const start = STREAM.slice(0, STREAM.indexOf("\n\n", STREAM.indexOf("text_delta")) + 2);
    const f = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(start));
          ac.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const r = postMessages(f, "k", body, ac.signal, {}, {
      onText: () => ac.abort(),
    });
    expect(await r).toEqual({ kind: "error", reason: "aborted" });
  });
});

describe("stopping early and error pages", () => {
  const body: MessagesRequest = { model: "m", max_tokens: 10, system: [], tools: [], messages: [] };

  /** A stream that sends `text` once and then stays open, recording whether the reader cancelled it. */
  function openStream(text: string) {
    const state = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  it("cancels the response body once message_stop came (the connection is not left open)", async () => {
    const complete = [
      ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], stop_reason: null } }),
      ev("message_stop", { type: "message_stop" }),
    ].join("");
    const { stream, state } = openStream(complete);
    const f = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const r = await postMessages(f, "k", body, undefined, {}, { onText: () => {} });
    expect(r.kind).toBe("ok");
    expect(state.cancelled).toBe(true);
  });

  it("cancels the response body after an error event", async () => {
    const { stream, state } = openStream(ev("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    const f = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const r = await postMessages(f, "k", body, undefined, {}, { onText: () => {} });
    expect(r).toEqual({ kind: "transient", reason: "Claude API stream error (overloaded_error: Overloaded)" });
    expect(state.cancelled).toBe(true);
  });

  it("an HTML error page is summed up by its status, never shown", async () => {
    const f = (async () => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502, headers: { "content-type": "text/html" } })) as typeof fetch;
    expect(await postMessages(f, "k", body)).toEqual({ kind: "transient", reason: "Claude API server error (HTTP 502)" });
  });
});
