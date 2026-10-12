/**
 * Anthropic Messages API wire format and one-request transport over fetch.
 * https://docs.anthropic.com/en/api/messages, tool use and prompt caching.
 */
import { z } from "zod";
import { ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL, errorMessage, HOSTED_AI_UNAVAILABLE, toolArgsSchema, toolDescription, type ToolName, type ToolResult } from "@noa/shared";
import { errorDetail, isHostedAiUnavailable, outOfCreditError, type CreditShortfall } from "./api-errors.js";
import { MessageAccumulator, StreamError, readSse } from "./sse.js";
import type { ReasoningParams, ThinkingParam } from "./reasoning.js";

export const MAX_TOKENS = 4096;

export type CacheControl = { type: "ephemeral" };
export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: (TextBlock | ImageBlock)[];
  is_error?: boolean;
}
/** Blocks we send or receive. Unknown response blocks (e.g. thinking) are passed back untouched. */
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

export interface MessageParam {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system: TextBlock[];
  tools: AnthropicTool[];
  messages: MessageParam[];
  /** Server-sent events instead of one JSON response (see postMessages' stream option). */
  stream?: boolean;
  /** The model's thinking for this request (reasoning.ts: reasoningParams). Absent: the model's default. */
  thinking?: ThinkingParam;
  output_config?: ReasoningParams["output_config"];
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: Record<string, unknown>;
}

const schemaCache = new Map<string, Record<string, unknown>>();

/** JSON schema of a tool's input, from ToolArgs (ToolArgsJev with Jev on: other field descriptions). */
export function toolInputSchema(name: ToolName, jev = false): Record<string, unknown> {
  const key = `${name}:${jev}`;
  let s = schemaCache.get(key);
  if (!s) {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(toolArgsSchema(name, jev), { io: "input" }) as Record<string, unknown>;
    s = rest;
    schemaCache.set(key, s);
  }
  return s;
}

/** Tool definitions in the given order; the last one carries the cache breakpoint. */
export function toolDefinitions(names: ToolName[], jev = false): AnthropicTool[] {
  return names.map((name, i) => {
    const t: AnthropicTool = { name, description: toolDescription(name, jev), input_schema: toolInputSchema(name, jev) };
    if (i === names.length - 1) t.cache_control = { type: "ephemeral" };
    return t;
  });
}

/** Blocks a cache breakpoint may sit on (thinking blocks may not). */
const CACHEABLE_BLOCKS: ReadonlySet<string> = new Set(["text", "image", "document", "tool_use", "tool_result"]);

/**
 * The conversation with a cache breakpoint on its last cacheable block, so each request reads the one before it
 * from the cache and writes only what was added since (prompt caching's multi-turn pattern). Only that block is
 * copied: the history itself stays unmarked, so a single breakpoint moves forward turn by turn. With the tools'
 * and the system prompt's, a request has 3 of the 4 allowed.
 */
export function withConversationCache(messages: MessageParam[]): MessageParam[] {
  const last = messages.at(-1);
  if (!last) return messages;
  let at = last.content.length - 1;
  while (at >= 0 && !CACHEABLE_BLOCKS.has(last.content[at]!.type)) at--;
  if (at < 0) return messages;
  const content = last.content.slice();
  content[at] = { ...content[at]!, cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content }];
}

export function buildRequest(opts: { model: string; system: string; tools: ToolName[]; messages: MessageParam[]; jev?: boolean; reasoning?: ReasoningParams }): MessagesRequest {
  const { max_tokens = MAX_TOKENS, ...thinking } = opts.reasoning ?? {};
  return {
    model: opts.model,
    max_tokens,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: toolDefinitions(opts.tools, opts.jev === true),
    messages: withConversationCache(opts.messages),
    ...thinking,
  };
}

export function toolResultBlock(toolUseId: string, r: ToolResult): ToolResultBlock {
  const content: (TextBlock | ImageBlock)[] = [];
  if (r.text) content.push({ type: "text", text: r.text });
  if (r.image) content.push({ type: "image", source: { type: "base64", media_type: r.image.mimeType, data: r.image.base64 } });
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  const block: ToolResultBlock = { type: "tool_result", tool_use_id: toolUseId, content };
  if (r.isError) block.is_error = true;
  return block;
}

export type PostResult =
  | { kind: "ok"; message: MessagesResponse }
  /** 402 from the Noa API: the account has no usage credit left, or too little for this request (`shortfall`); pauseReason says which. */
  | { kind: "credit"; reason: string; pauseReason: string; topupUrl?: string; shortfall?: CreditShortfall }
  /** 429, 529, 5xx, network: worth retrying; retryAfterMs when the server said when (retry-after-ms / retry-after). */
  | { kind: "transient"; reason: string; retryAfterMs?: number }
  /** 401/403. */
  | { kind: "auth"; reason: string }
  | { kind: "error"; reason: string };

/**
 * Where Messages requests go and how they authenticate. Default: Anthropic
 * with x-api-key. The Noa hosted AI takes the same body at
 * `${apiBase}/v1/ai/messages` with the session token as a bearer.
 */
export interface MessagesTransport {
  /** Full URL of the Messages endpoint. Default ANTHROPIC_MESSAGES_URL. */
  url?: string;
  /** "x-api-key" (Anthropic, default) or "bearer" (Authorization: Bearer <key>). */
  auth?: "x-api-key" | "bearer";
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Name used in error reasons. Default "Claude API". */
  label?: string;
}

/** Streaming: text as it is written (`messageId:index` names the text block), and the start of a tool call. */
export interface StreamOptions {
  onText(messageId: string, index: number, text: string): void;
  onToolStart?(): void;
}

/** API error types in a stream's error event that are worth a retry. */
const TRANSIENT_STREAM_ERRORS = new Set(["overloaded_error", "api_error", "rate_limit_error", "stream_error", "timeout_error"]);

/**
 * One POST /v1/messages. Never throws (an abort comes back as an error
 * result). With `stream`, the request asks for server-sent events and the
 * message is rebuilt from them (text reported through onText as it comes);
 * a JSON answer (an endpoint that does not stream) is read as usual.
 */
export async function postMessages(
  doFetch: typeof fetch,
  apiKey: string,
  body: MessagesRequest,
  signal?: AbortSignal,
  transport: MessagesTransport = {},
  stream?: StreamOptions,
): Promise<PostResult> {
  const label = transport.label ?? "Claude API";
  let res: Response;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", ...(transport.headers ?? {}) };
    if (transport.auth === "bearer") headers.authorization = `Bearer ${apiKey}`;
    else {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(stream ? { ...body, stream: true } : body) };
    if (signal) init.signal = signal;
    res = await doFetch(transport.url ?? ANTHROPIC_MESSAGES_URL, init);
  } catch (e) {
    if (signal?.aborted) return { kind: "error", reason: "aborted" };
    return { kind: "transient", reason: `${label} network error: ${errorMessage(e)}` };
  }
  if (res.ok && stream && res.body && /text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
    return readStream(res.body, stream, label, signal);
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { kind: "transient", reason: `${label} network error while reading the response: ${errorMessage(e)}` };
  }
  const s = res.status;
  if (res.ok) {
    try {
      return { kind: "ok", message: JSON.parse(text) as MessagesResponse };
    } catch {
      return { kind: "transient", reason: `${label} returned an unreadable response (HTTP ${s})` };
    }
  }
  if (s === 402) {
    const credit = outOfCreditError(text);
    const r: PostResult = { kind: "credit", reason: credit.message, pauseReason: credit.pauseReason };
    if (credit.topupUrl) r.topupUrl = credit.topupUrl;
    if (credit.shortfall) r.shortfall = credit.shortfall;
    return r;
  }
  // The hosted AI's own credentials were refused: retrying will not help, and there is nothing technical to show.
  if (isHostedAiUnavailable(text)) return { kind: "error", reason: HOSTED_AI_UNAVAILABLE };
  const detail = errorDetail(text);
  const status = `(HTTP ${s}${detail ? `: ${detail}` : ""})`;
  const rejected = transport.auth === "bearer" ? `${label} rejected the sign-in` : `${label} key rejected`;
  if (s === 401 || s === 403) return { kind: "auth", reason: `${rejected} ${status}` };
  const transient = (reason: string): PostResult => {
    const after = retryAfterMs(res.headers);
    return after === undefined ? { kind: "transient", reason } : { kind: "transient", reason, retryAfterMs: after };
  };
  if (s === 429) return transient(`${label} rate limit ${status}`);
  if (s === 529) return transient(`${label} overloaded ${status}`);
  if (s >= 500) return transient(`${label} server error ${status}`);
  return { kind: "error", reason: `${label} error ${status}` };
}

/**
 * When the server asks the client to retry: `retry-after-ms` (milliseconds,
 * Anthropic), else `retry-after` (seconds, or an HTTP date). Undefined when
 * neither is there or readable.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = Number.parseFloat(headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function readStream(body: ReadableStream<Uint8Array>, stream: StreamOptions, label: string, signal?: AbortSignal): Promise<PostResult> {
  const acc = new MessageAccumulator(
    (id, i, t) => {
      try {
        stream.onText(id, i, t);
      } catch {
        /* a listener must not break the stream */
      }
    },
    () => {
      try {
        stream.onToolStart?.();
      } catch {
        /* a listener must not break the stream */
      }
    },
  );
  try {
    for await (const ev of readSse(body)) {
      acc.apply(ev);
      if (acc.done) break;
    }
  } catch (e) {
    if (signal?.aborted) return { kind: "error", reason: "aborted" };
    if (e instanceof StreamError) {
      const reason = `${label} stream error (${e.message})`;
      return TRANSIENT_STREAM_ERRORS.has(e.errorType) ? { kind: "transient", reason } : { kind: "error", reason };
    }
    return { kind: "transient", reason: `${label} network error while reading the response: ${errorMessage(e)}` };
  }
  if (signal?.aborted) return { kind: "error", reason: "aborted" };
  const message = acc.message;
  if (!message || !acc.done) return { kind: "transient", reason: `${label} stream ended early` };
  // Blocks are filled by index; a gap would break the history sent back.
  message.content = message.content.filter(Boolean);
  return { kind: "ok", message };
}
