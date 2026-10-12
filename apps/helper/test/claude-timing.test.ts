import { describe, expect, it } from "vitest";
import type { TraceDraft } from "@noa/shared";
import { ClaudeStreamTimer } from "../src/brains/claude-timing.js";

const T0 = Date.parse("2026-09-26T10:00:00Z");

function timer() {
  let mono = 0;
  const out: TraceDraft[] = [];
  const t = new ClaudeStreamTimer((e) => out.push(e), { mono: () => mono, now: () => T0 + mono });
  return { t, out, at: (ms: number) => (mono = ms) };
}

const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event });

describe("Claude Code timing from stream-json", () => {
  it("the process's start, each model call's waits and stream, and Claude Code's own summary", () => {
    const { t, out, at } = timer();
    t.spawned();
    at(5);
    t.sent();
    at(1800);
    t.line({ type: "system", subtype: "init", model: "claude-sonnet-5", claude_code_version: "2.1.282" });
    at(1805);
    t.line({ type: "system", subtype: "status", status: "requesting" });
    at(3300);
    t.line(stream({ type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: 8, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 500 } } }));
    at(3350);
    t.line(stream({ type: "content_block_start", content_block: { type: "text" } }));
    for (let i = 0; i < 40; i++) {
      at(3400 + i * 20);
      t.line(stream({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }));
    }
    at(4400);
    t.line(stream({ type: "content_block_start", content_block: { type: "tool_use" } }));
    // A subagent's stream is not the main loop's.
    t.line({ type: "stream_event", parent_tool_use_id: "toolu_1", event: { type: "message_stop" } });
    at(4600);
    t.line(stream({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 250 } }));
    t.line(stream({ type: "message_stop" }));
    at(5200);
    // The tool result Claude Code echoes: the next request answers it.
    t.line({ type: "user", message: { content: [] } });
    at(5210);
    t.line({ type: "system", subtype: "status", status: "requesting" });
    at(6000);
    t.line(stream({ type: "message_start", message: { usage: { input_tokens: 3 } } }));
    t.line(stream({ type: "message_stop" }));
    t.line({ type: "result", subtype: "success", duration_ms: 6100, duration_api_ms: 4100, num_turns: 2, total_cost_usd: 0.0421337, usage: { input_tokens: 11, output_tokens: 260 } });

    expect(out.map((e) => e.name)).toEqual(["claude.ready", "model.call", "model.call", "claude.result"]);
    expect(out[0]).toMatchObject({ t: T0, ms: 1800, cat: "brain", data: { model: "claude-sonnet-5", version: "2.1.282" } });
    expect(out[1]).toMatchObject({
      t: T0 + 1805,
      ms: 2795,
      cat: "model",
      data: { model: "claude-sonnet-5", sinceInputMs: 1800, responseMs: 1495, firstTokenMs: 1545, firstTextMs: 1545, firstToolMs: 2595, lastTextMs: 2375, deltas: 40, toolUses: 1, stop: "tool_use", inTokens: 8, outTokens: 250, cacheReadTokens: 18_000, cacheWriteTokens: 500 },
    });
    expect(out[2]!.data).toMatchObject({ sinceInputMs: 10, responseMs: 790, deltas: 0, inTokens: 3 });
    expect(out[3]).toMatchObject({ cat: "brain", data: { durationMs: 6100, apiMs: 4100, modelCalls: 2, costUsd: 0.042134, inTokens: 11, outTokens: 260 } });
  });

  it("ignores what it cannot read, and reports a failed result", () => {
    const { t, out } = timer();
    for (const bad of [null, 3, "x", [], { type: "stream_event", event: "nope" }, { type: "system", subtype: "init" }]) t.line(bad);
    t.line({ type: "result", subtype: "error_max_turns", is_error: true });
    expect(out.map((e) => e.name)).toEqual(["claude.result"]);
    expect(out[0]!.data).toMatchObject({ error: "error_max_turns" });
  });
});
