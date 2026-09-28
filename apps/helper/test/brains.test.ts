import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DeltaBatcher, type AgentEvent } from "@noa/shared";
import { UserInput } from "../src/brains/brain.js";
import { extractPostText, extractStartUrl } from "../src/brains/scripted.js";
import { ClaudeStreamMapper, buildClaudeArgs, isNoisyStreamLine, userMessageLine, withoutBase64Data } from "../src/brains/claude-code.js";

describe("UserInput", () => {
  it("queues until subscribed, and refuses after close", () => {
    const input = new UserInput();
    expect(input.push("a")).toBe(true);
    const got: string[] = [];
    input.onMessage((t) => got.push(t));
    input.push("b");
    let closed = 0;
    input.onClose(() => closed++);
    input.close();
    input.close();
    expect(input.push("c")).toBe(false);
    expect(got).toEqual(["a", "b"]);
    expect(closed).toBe(1);
  });
});

describe("ScriptedBrain helpers", () => {
  it("extracts the post text and the start URL", () => {
    expect(extractPostText("Go to the site. Post: hi there ")).toBe("hi there");
    expect(extractPostText("just this")).toBe("just this");
    // A continued conversation quotes the first request: the post is the quoted one, not what follows it.
    expect(extractPostText("--- Continuing a conversation ---\n<<<\nPost on X. Post: hi there\n>>>\nWhat was done so far:\n- typed")).toBe("hi there");
    expect(extractStartUrl("Open http://localhost:8787/compose. Post: see https://ex.com")).toBe("http://localhost:8787/compose");
    expect(extractStartUrl("Post: see https://ex.com")).toBeNull();
    expect(extractStartUrl("no url")).toBeNull();
  });
});

describe("ClaudeCodeBrain helpers", () => {
  it("turns Claude Code's extended thinking off with its settings when asked", () => {
    const base = { systemPrompt: "rules", mcpConfigPath: "C:\run\mcp-config.json", allowedTools: ["mcp__noa__task_complete"], model: "sonnet" };
    const off = buildClaudeArgs({ ...base, thinking: false });
    expect(off.slice(off.indexOf("--settings"), off.indexOf("--settings") + 2)).toEqual(["--settings", '{"alwaysThinkingEnabled":false}']);
    expect(buildClaudeArgs(base)).not.toContain("--settings");
    expect(buildClaudeArgs({ ...base, thinking: true })).not.toContain("--settings");
  });

  it("builds the exact claude arguments (stream-json in and out, prompt on stdin)", () => {
    expect(
      buildClaudeArgs({
        systemPrompt: "rules",
        mcpConfigPath: "C:\\run\\mcp-config.json",
        allowedTools: ["mcp__noa__click", "mcp__noa__task_complete"],
        model: "sonnet",
      }),
    ).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--strict-mcp-config",
      "--mcp-config",
      "C:\\run\\mcp-config.json",
      "--allowedTools",
      "mcp__noa__click,mcp__noa__task_complete",
      "--append-system-prompt-file",
      // In the run folder, named by the prompt's content (see systemPromptFile).
      "C:\\run\\system-prompt-6c621d1a05138a78.txt",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--model",
      "sonnet",
    ]);
    // A task session: its own Read, allowed in its working directory (the attachments folder) and refused elsewhere.
    const read = buildClaudeArgs({ systemPrompt: "rules", mcpConfigPath: "C:\\run\\mcp-config.json", allowedTools: ["mcp__noa__act"], read: true, model: "sonnet" });
    expect(read.slice(read.indexOf("--allowedTools"), read.indexOf("--allowedTools") + 4)).toEqual([
      "--allowedTools",
      "mcp__noa__act,Read(./**)",
      "--permission-mode",
      "dontAsk",
    ]);
    expect(read.slice(read.indexOf("--tools"), read.indexOf("--tools") + 2)).toEqual(["--tools", "Read"]);
    expect(userMessageLine('say "hi"\nnow')).toBe('{"type":"user","message":{"role":"user","content":"say \\"hi\\"\\nnow"}}\n');
  });

  it("maps stream-json events to AgentEvents (no tool events)", () => {
    const mapStreamEvent = (line: unknown) => new ClaudeStreamMapper().map(line);
    expect(
      mapStreamEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "Opening the composer." }, { type: "tool_use", id: "x", name: "mcp__noa__act", input: {} }] },
      }),
    ).toEqual([{ type: "assistant_text", text: "Opening the composer." }]);
    expect(mapStreamEvent({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual([]);
    expect(mapStreamEvent({ type: "result", subtype: "success", is_error: false, result: "done" })).toEqual([]);
    expect(mapStreamEvent({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|123" })).toEqual([
      { type: "error", text: "Claude Code: Claude AI usage limit reached|123" },
    ]);
    expect(mapStreamEvent({ type: "result", subtype: "error_max_turns", is_error: true })).toEqual([{ type: "error", text: "Claude Code: error_max_turns" }]);
    expect(mapStreamEvent({ type: "system", subtype: "init", model: "claude-sonnet-5" })).toEqual([{ type: "status", text: "Claude Code started (claude-sonnet-5)" }]);
  });
});

/** Recorded from real Claude Code 2.1.282: claude -p ... --verbose --include-partial-messages (init trimmed, rate limit line dropped). */
const FIXTURE = readFileSync(new URL("./fixtures/claude-partial-messages.jsonl", import.meta.url), "utf8")
  .trim()
  .split(/\r?\n/)
  .map((l) => JSON.parse(l));

describe("Claude Code partial messages (recorded fixture)", () => {
  it("streams text deltas under one block id, then the full text with that id; thinking is ignored", () => {
    const m = new ClaudeStreamMapper();
    const events = FIXTURE.flatMap((ev) => m.map(ev));
    const msgId = FIXTURE.find((e) => e.event?.type === "message_start").event.message.id as string;
    const deltas = events.filter((e): e is Extract<AgentEvent, { type: "assistant_text_delta" }> => e.type === "assistant_text_delta");
    const finals = events.filter((e): e is Extract<AgentEvent, { type: "assistant_text" }> => e.type === "assistant_text");
    expect(deltas.length).toBe(FIXTURE.filter((e) => e.event?.delta?.type === "text_delta").length);
    expect(deltas.length).toBeGreaterThan(10);
    // Block 0 is thinking; the answer is block 1.
    expect(new Set(deltas.map((d) => d.id))).toEqual(new Set([`${msgId}:1`]));
    expect(finals).toHaveLength(1);
    expect(finals[0]!.id).toBe(`${msgId}:1`);
    expect(deltas.map((d) => d.text).join("")).toBe(finals[0]!.text);
    expect(finals[0]!.text).toContain("**manifest.json**");
    // Final comes after every delta of its block.
    expect(events.indexOf(finals[0]!)).toBeGreaterThan(events.indexOf(deltas.at(-1)!));
    expect(events.filter((e) => e.type !== "assistant_text" && e.type !== "assistant_text_delta")).toEqual([
      { type: "status", text: "Claude Code started (claude-haiku-4-5-20251001)" },
    ]);
  });

  it("keeps stream_event and thinking_tokens lines out of the run log, but not the assistant message", () => {
    const kept = FIXTURE.filter((e) => !isNoisyStreamLine(e)).map((e) => e.type);
    expect(kept).toEqual(["system", "system", "assistant", "assistant", "result"]);
  });

  it("without partial messages (or a message it did not see start), text has no id", () => {
    const m = new ClaudeStreamMapper();
    expect(m.map({ type: "assistant", message: { id: "m9", content: [{ type: "text", text: "hi" }] } })).toEqual([{ type: "assistant_text", text: "hi" }]);
    // Deltas of blocks never started (or before message_start) are dropped.
    expect(m.map({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } })).toEqual([]);
  });

  it("two text blocks in one message each get their own id, in order; whitespace-only blocks still use theirs up", () => {
    const m = new ClaudeStreamMapper();
    const se = (event: unknown) => m.map({ type: "stream_event", event, parent_tool_use_id: null });
    se({ type: "message_start", message: { id: "m1" } });
    expect(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })).toEqual([]);
    expect(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " " } })).toEqual([{ type: "assistant_text_delta", id: "m1:0", text: " " }]);
    expect(m.map({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: " " }] } })).toEqual([]);
    se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "x", input: {} } });
    expect(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } })).toEqual([]);
    se({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
    se({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Done." } });
    expect(m.map({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Done." }] } })).toEqual([{ type: "assistant_text", text: "Done.", id: "m1:2" }]);
    // Subagent streams are ignored.
    expect(m.map({ type: "stream_event", parent_tool_use_id: "tu", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "no" } } })).toEqual([]);
  });
});

describe("Claude Code events in the run log and the chat", () => {
  it("keeps screenshots' base64 data out of the run log (the image files are saved beside it)", () => {
    const data = "A".repeat(200_000);
    const toolResult = {
      type: "user",
      message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }, { type: "text", text: "ok" }] }] },
    };
    const logged = withoutBase64Data(toolResult);
    expect(JSON.stringify(logged).length).toBeLessThan(500);
    expect(logged).toEqual({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "[147 KB of base64 data not logged]" } }, { type: "text", text: "ok" }] }] },
    });
    // The original event is untouched (the mapper still sees it whole).
    expect(toolResult.message.content[0]!.content[0]!.source!.data).toBe(data);
  });

  it("an error result with an API error body reads as plain text, never raw JSON", () => {
    const [e] = new ClaudeStreamMapper().map({
      type: "result",
      subtype: "success",
      is_error: true,
      result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_1"}',
    });
    expect(e).toEqual({ type: "error", text: "Claude Code: API Error: 500 api_error: Internal server error" });
  });
});

describe("DeltaBatcher", () => {
  it("joins deltas of a block for ~50 ms, flushes before other events and when the block changes", () => {
    vi.useFakeTimers();
    try {
      const out: AgentEvent[] = [];
      const b = new DeltaBatcher((e) => out.push(e), 50);
      b.delta("a", "Hel");
      b.delta("a", "lo");
      expect(out).toEqual([]);
      vi.advanceTimersByTime(50);
      expect(out).toEqual([{ type: "assistant_text_delta", id: "a", text: "Hello" }]);
      b.delta("a", " world");
      b.delta("b", "Next");
      expect(out.at(-1)).toEqual({ type: "assistant_text_delta", id: "a", text: " world" });
      b.emit({ type: "assistant_text", text: "Next", id: "b" });
      expect(out.slice(-2)).toEqual([
        { type: "assistant_text_delta", id: "b", text: "Next" },
        { type: "assistant_text", text: "Next", id: "b" },
      ]);
      b.delta("c", "dropped");
      b.discard();
      vi.advanceTimersByTime(100);
      expect(out).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
