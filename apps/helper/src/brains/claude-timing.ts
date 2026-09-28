/**
 * Claude Code's timing for the conversation's trace, read from its
 * stream-json output (with --include-partial-messages):
 *
 * - claude.ready: from spawning the process (or taking one started ahead,
 *   prewarmedMs ago) to its `system/init` line.
 * - model.call: one per Messages request, from Claude Code's
 *   `system/status: requesting` to the stream's message_stop: time to the
 *   response (message_start), to the first token, text and tool call, the
 *   number of text deltas and the last one, tokens (message_start and
 *   message_delta usage) and the stop reason. `sinceInputMs`: from the input
 *   that led to it (a message written to stdin, or the tool result Claude
 *   Code echoes as a `user` line) to the request: Claude Code's own time.
 * - claude.result: Claude Code's own summary of the turn (`result` line):
 *   its duration, API time, number of model calls, cost and usage.
 *
 * Deltas are only counted. Every line is untrusted JSON: each field is
 * checked before use.
 */
import { stopwatch, type TraceDraft } from "@noa/shared";
import { usageOf } from "@noa/core";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A model call being streamed (ms since the process was spawned). */
interface Call {
  t: number;
  at: number;
  sinceInputMs?: number;
  responseMs?: number;
  firstTokenMs?: number;
  firstTextMs?: number;
  firstToolMs?: number;
  lastTextMs?: number;
  deltas: number;
  tools: number;
  usage: Obj;
  stop?: string;
  model?: string;
}

export class ClaudeStreamTimer {
  private readonly clock: () => number;
  private readonly now: () => number;
  private spawnedAt: { t: number; at: number; prewarmedMs?: number } | null = null;
  private ready = false;
  /** When the last input reached Claude Code (a message on stdin, or a tool result). */
  private lastInputAt: number | null = null;
  private call: Call | null = null;
  /** Why the brain stopped the last request (interrupted); the next result is that stop's. */
  private stoppedWhy: string | null = null;

  constructor(
    private readonly out: (e: TraceDraft) => void,
    /** Milliseconds on a monotonic clock, and the wall clock (tests pass fakes). */
    clock: { mono?: () => number; now?: () => number } = {},
  ) {
    this.clock = clock.mono ?? stopwatch();
    this.now = clock.now ?? (() => Date.now());
  }

  /** The process was just spawned; with prewarmedMs, one started that long ago (ClaudeCodeBrain.warm) was just taken. */
  spawned(warm?: { prewarmedMs: number }): void {
    this.spawnedAt = { t: this.now(), at: this.clock(), ...(warm ? { prewarmedMs: warm.prewarmedMs } : {}) };
  }

  /**
   * The brain stopped the running request (why): its model.call row is written now, marked `interrupted`, and
   * the result that follows is the stop's, not an error.
   */
  interrupted(why: string): void {
    this.stoppedWhy = why;
    const call = this.call;
    if (call) this.endCall(call, this.clock(), why);
  }

  /** A user message was written to Claude Code's stdin. */
  sent(): void {
    this.lastInputAt = this.clock();
  }

  /** One parsed stream-json line. */
  line(value: unknown): void {
    const ev = obj(value);
    if (!ev) return;
    const at = this.clock();
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") this.onInit(ev, at);
        else if (ev.subtype === "status" && ev.status === "requesting") this.startCall(at);
        return;
      case "stream_event":
        if (!ev.parent_tool_use_id) this.onStream(obj(ev.event), at);
        return;
      case "user":
        // Claude Code echoes each tool result as a user line: the next request answers it.
        this.lastInputAt = at;
        return;
      case "result":
        this.onResult(ev);
        return;
    }
  }

  private onInit(ev: Obj, at: number): void {
    if (this.ready || !this.spawnedAt) return;
    this.ready = true;
    const data: NonNullable<TraceDraft["data"]> = {};
    const model = str(ev.model);
    const version = str(ev.claude_code_version);
    if (model) data.model = model;
    if (version) data.version = version;
    if (this.spawnedAt.prewarmedMs !== undefined) data.prewarmedMs = this.spawnedAt.prewarmedMs;
    this.out({ t: this.spawnedAt.t, ms: round(at - this.spawnedAt.at), cat: "brain", name: "claude.ready", data });
  }

  private startCall(at: number): Call {
    const call: Call = { t: this.now(), at, deltas: 0, tools: 0, usage: {} };
    if (this.lastInputAt !== null) call.sinceInputMs = round(at - this.lastInputAt);
    this.call = call;
    return call;
  }

  private onStream(e: Obj | null, at: number): void {
    if (!e) return;
    // No "requesting" line before it (older Claude Code): the call starts at its first stream event.
    const call = this.call ?? this.startCall(at);
    const since = round(at - call.at);
    switch (e.type) {
      case "message_start": {
        call.responseMs ??= since;
        const m = obj(e.message);
        call.model ??= str(m?.model);
        Object.assign(call.usage, obj(m?.usage) ?? {});
        return;
      }
      case "content_block_start": {
        const type = str(obj(e.content_block)?.type);
        call.firstTokenMs ??= since;
        if (type === "text") call.firstTextMs ??= since;
        if (type === "tool_use") {
          call.firstToolMs ??= since;
          call.tools++;
        }
        return;
      }
      case "content_block_delta": {
        call.firstTokenMs ??= since;
        if (str(obj(e.delta)?.type) === "text_delta") {
          call.firstTextMs ??= since;
          call.lastTextMs = since;
          call.deltas++;
        }
        return;
      }
      case "message_delta": {
        const stop = str(obj(e.delta)?.stop_reason);
        if (stop) call.stop = stop;
        Object.assign(call.usage, obj(e.usage) ?? {});
        return;
      }
      case "message_stop":
        this.endCall(call, at);
        return;
    }
  }

  private endCall(call: Call, at: number, interrupted?: string): void {
    this.call = null;
    const data: NonNullable<TraceDraft["data"]> = { deltas: call.deltas, toolUses: call.tools };
    if (interrupted) data.interrupted = interrupted;
    if (call.model) data.model = call.model;
    for (const k of ["sinceInputMs", "responseMs", "firstTokenMs", "firstTextMs", "firstToolMs", "lastTextMs"] as const) {
      const v = call[k];
      if (v !== undefined) data[k] = v;
    }
    if (call.stop) data.stop = call.stop;
    Object.assign(data, usageOf(call.usage));
    this.out({ t: call.t, ms: round(at - call.at), cat: "model", name: "model.call", data });
  }

  private onResult(ev: Obj): void {
    const data: NonNullable<TraceDraft["data"]> = {};
    const put = (key: string, v: number | undefined) => {
      if (v !== undefined) data[key] = v;
    };
    put("durationMs", num(ev.duration_ms));
    put("apiMs", num(ev.duration_api_ms));
    put("modelCalls", num(ev.num_turns));
    const cost = num(ev.total_cost_usd);
    if (cost !== undefined) data.costUsd = Math.round(cost * 1e6) / 1e6;
    Object.assign(data, usageOf(obj(ev.usage) ?? undefined));
    const failed = ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success");
    if (failed && this.stoppedWhy) data.interrupted = this.stoppedWhy;
    else if (failed) data.error = str(ev.subtype) ?? true;
    this.stoppedWhy = null;
    this.out({ t: this.now(), cat: "brain", name: "claude.result", data });
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
