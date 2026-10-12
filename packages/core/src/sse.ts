/**
 * Streaming Messages responses (stream: true) over plain fetch: a
 * server-sent events reader and the accumulator that rebuilds the final
 * message from the stream's events.
 * https://docs.anthropic.com/en/api/messages-streaming
 */
import type { MessagesResponse } from "./anthropic.js";

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits an SSE byte stream into events (event: / data: fields, blank line ends one). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  const line = function* (l: string): Generator<SseEvent> {
    if (l === "") {
      if (data.length || event) yield { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      ended = done;
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A lone \r at the end may be the first half of \r\n: wait for more.
      let m: RegExpExecArray | null;
      const re = /\r\n|\n|\r(?!$)/g;
      let start = 0;
      while ((m = re.exec(buf))) {
        yield* line(buf.slice(start, m.index));
        start = m.index + m[0].length;
      }
      buf = buf.slice(start);
      if (done) {
        if (buf.endsWith("\r")) buf = buf.slice(0, -1);
        if (buf) yield* line(buf);
        yield* line("");
        return;
      }
    }
  } finally {
    // The reader stopped early (message_stop, a bad event, an abort): close the connection instead of leaving it streaming.
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** An `error` event in the stream, or a stream that makes no sense. */
export class StreamError extends Error {
  constructor(
    message: string,
    /** The API's error type, e.g. overloaded_error. */
    readonly errorType: string,
  ) {
    super(message);
  }
}

/** The fields of a stream event's data the accumulator reads (untrusted JSON: each is checked before use). */
interface StreamEventData {
  type?: unknown;
  index?: unknown;
  message?: { content?: unknown; [k: string]: unknown };
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  error?: { type?: unknown; message?: unknown };
}

/** A content block being filled from the stream. */
type OpenBlock = { type: string; [k: string]: unknown };

/**
 * Rebuilds a MessagesResponse from stream events. Text deltas are passed to
 * onText as they come; tool_use input is the joined input_json_delta parts,
 * parsed when the block stops; thinking text and signatures are kept so the
 * block can be sent back. onToolStart: a tool_use block started (from then on
 * the reply is an action, not only words).
 */
export class MessageAccumulator {
  private msg: MessagesResponse | null = null;
  private json = new Map<number, string>();
  private stopped = false;

  constructor(
    private readonly onText?: (messageId: string, index: number, text: string) => void,
    private readonly onToolStart?: () => void,
  ) {}

  /** True once message_stop came. */
  get done(): boolean {
    return this.stopped;
  }

  /** The message so far (complete once done). */
  get message(): MessagesResponse | null {
    return this.msg;
  }

  apply(ev: SseEvent): void {
    if (ev.event === "ping") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      throw new StreamError(`unreadable stream event (${ev.event})`, "stream_error");
    }
    const d = (parsed && typeof parsed === "object" ? parsed : {}) as StreamEventData;
    const type = typeof d.type === "string" ? d.type : ev.event;
    if (type === "error") {
      const e = d.error ?? {};
      throw new StreamError(`${e.type ? `${String(e.type)}: ` : ""}${String(e.message ?? "stream error")}`, typeof e.type === "string" ? e.type : "error");
    }
    if (type === "message_start") {
      const m = d.message ?? {};
      this.msg = { ...m, content: Array.isArray(m.content) ? [...m.content] : [] } as MessagesResponse;
      return;
    }
    const msg = this.msg;
    if (!msg) {
      if (type === "message_stop") this.stopped = true;
      return;
    }
    const index = typeof d.index === "number" ? d.index : null;
    const blockAt = (i: number) => msg.content[i] as OpenBlock | undefined;
    switch (type) {
      case "content_block_start": {
        if (index === null) return;
        const block: OpenBlock = { type: "", ...(d.content_block ?? {}) };
        if (block.type === "tool_use") {
          this.json.set(index, "");
          this.onToolStart?.();
        }
        msg.content[index] = block;
        if (block.type === "text" && typeof block.text === "string" && block.text) this.onText?.(msg.id, index, block.text);
        return;
      }
      case "content_block_delta": {
        const block = index === null ? undefined : blockAt(index);
        if (!block || index === null) return;
        const delta = d.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = String(block.text ?? "") + delta.text;
          if (delta.text) this.onText?.(msg.id, index, delta.text);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          this.json.set(index, (this.json.get(index) ?? "") + delta.partial_json);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = String(block.thinking ?? "") + delta.thinking;
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature = delta.signature;
        } else if (delta.type === "citations_delta" && delta.citation) {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
        }
        return;
      }
      case "content_block_stop": {
        const block = index === null ? undefined : blockAt(index);
        const raw = index === null ? undefined : this.json.get(index);
        if (block && raw !== undefined) {
          this.json.delete(index!);
          try {
            block.input = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            throw new StreamError(`unreadable tool input for ${String(block.name)}`, "stream_error");
          }
        }
        return;
      }
      case "message_delta": {
        if (d.delta && "stop_reason" in d.delta) msg.stop_reason = typeof d.delta.stop_reason === "string" ? d.delta.stop_reason : null;
        if (d.usage && typeof d.usage === "object") msg.usage = { ...(msg.usage ?? {}), ...d.usage };
        return;
      }
      case "message_stop":
        this.stopped = true;
        return;
      default:
        return;
    }
  }
}
