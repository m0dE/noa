import { describe, expect, it } from "vitest";
import { ClaudeTurnState, userMessageText } from "../src/brains/claude-turn-state.js";

const requesting = { type: "system", subtype: "status", status: "requesting" };
const stream = (event: object) => ({ type: "stream_event", event, parent_tool_use_id: null });
const toolUse = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__noa__read_page", input: {} }] } });
const toolResult = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "page" }] } });
const echo = (content: string) => ({ type: "user", message: { role: "user", content }, isReplay: true });
const result = { type: "result", subtype: "success" };

describe("ClaudeTurnState", () => {
  it("counts stdin messages until Claude Code echoes each one (read)", () => {
    const s = new ClaudeTurnState();
    s.wrote();
    s.wrote();
    expect(s.pendingInput).toBe(true);
    expect(s.line(echo("first"))).toBe("first");
    expect(s.pendingInput).toBe(true);
    expect(s.line({ type: "user", message: { content: [{ type: "text", text: "sec" }, { type: "text", text: "ond" }] }, isReplay: true })).toBe("second");
    expect(s.pendingInput).toBe(false);
    expect(s.line(toolResult("t1"))).toBeNull();
  });

  it("is interruptible only while the model writes or thinks, with no action started", () => {
    const s = new ClaudeTurnState();
    expect(s.interruptible).toBe(false);
    s.line(requesting);
    expect(s.interruptible).toBe(true);
    s.line(stream({ type: "message_start", message: { id: "m1" } }));
    s.line(stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
    expect(s.interruptible).toBe(true);
    s.line(stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use" } }));
    expect(s.interruptible).toBe(false);
    s.line(stream({ type: "message_stop" }));
    s.line(toolUse("t1"));
    // The tool runs until its result.
    s.line(requesting);
    expect(s.interruptible).toBe(false);
    s.line(toolResult("t1"));
    expect(s.interruptible).toBe(true);
    s.line(result);
    expect(s.interruptible).toBe(false);
  });

  it("a request that starts after a tool result without reading what was written before it missed that input", () => {
    const s = new ClaudeTurnState();
    s.line(requesting);
    s.line(toolUse("t1"));
    s.wrote(); // while the tool runs
    s.line(toolResult("t1"));
    s.line(requesting); // no echo in between: not read with the result
    expect(s.missedInput).toBe(true);
    s.line(echo("x"));
    expect(s.missedInput).toBe(false);

    // Read with the tool's result (echo before the request): nothing missed.
    s.line(toolUse("t2"));
    s.wrote();
    s.line(toolResult("t2"));
    s.line(echo("y"));
    s.line(requesting);
    expect(s.missedInput).toBe(false);

    // Written after the tool result: that request may still read it (a new turn's echo comes late).
    s.line(toolUse("t3"));
    s.line(toolResult("t3"));
    s.wrote();
    s.line(requesting);
    expect(s.missedInput).toBe(false);
  });

  it("reads user message text from a string or text blocks only", () => {
    expect(userMessageText("hi")).toBe("hi");
    expect(userMessageText([{ type: "image" }])).toBeNull();
    expect(userMessageText(42)).toBeNull();
  });
});
