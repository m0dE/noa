// Stands in for claude.exe in stream-json mode: echoes its args, then answers
// every stdin user message with an assistant text and a result event, and
// exits when stdin closes. FAKE_CLAUDE_HANG=1: never exits until killed.
// FAKE_CLAUDE_SLOW_MS: how long the model "thinks" before answering each message.
// FAKE_CLAUDE_PARTIAL=1: stream the answer first as --include-partial-messages
// stream_event lines (one text_delta per word, 5 ms apart), like Claude Code 2.1.
// FAKE_CLAUDE_TOOL=1: the model first calls a tool that runs for FAKE_CLAUDE_SLOW_MS
// (a tool_use block, then its tool_result), then answers (FAKE_CLAUDE_ANSWER_MS after
// that request starts: time for an interrupt to stop it).
// Like Claude Code: each request starts with a `system/status: requesting` line;
// with --replay-user-messages every stdin message is echoed (isReplay) when it is
// read; a message that arrives while a tool runs is read with the tool's result
// (merged into the same turn: one result, its answer says "(and: ...)"); a
// control_request "interrupt" stops the model's request (an error result
// "error_during_execution"), and the next stdin message starts a new turn;
// a set_max_thinking_tokens control_request is echoed as a system/fake_thinking line;
// set_model switches the model later init lines name (a model starting "bad-" is
// refused with an error control_response, as Claude Code refuses one its probe fails).
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
// Like real Claude Code, the init event names the model it runs (and comes again with every later turn).
const modelAt = args.indexOf("--model");
let model = modelAt >= 0 ? args[modelAt + 1] : "fake";
const init = () => out({ type: "system", subtype: "init", model, args, cwd: process.cwd(), nested: process.env.CLAUDECODE ?? null, child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null });
init();
let turns = 0;
process.stdout.write("not json\n");
const slow = Number(process.env.FAKE_CLAUDE_SLOW_MS || 0);
const replay = args.includes("--replay-user-messages");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const se = (event) => out({ type: "stream_event", event, session_id: "s", parent_tool_use_id: null, uuid: "u" });
const echo = (content) => replay && out({ type: "user", message: { role: "user", content }, isReplay: true });
/** stdin user messages not read yet. */
const inbox = [];
let wake = null;
let closed = false;
/** The model's request in progress, which an interrupt stops. */
let current = null;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "control_request") {
    if (msg.request?.subtype === "set_model" && String(msg.request.model).startsWith("bad-")) {
      out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "API error: 404 · model not changed" } });
      return;
    }
    if (msg.request?.subtype === "set_model") model = msg.request.model;
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
    if (msg.request?.subtype === "interrupt" && current) current.interrupted = true;
    // Shown so tests can see it (real Claude Code only acks it).
    if (msg.request?.subtype === "set_max_thinking_tokens") out({ type: "system", subtype: "fake_thinking", max_thinking_tokens: msg.request.max_thinking_tokens });
    return;
  }
  inbox.push(msg.message.content);
  wake?.();
});
rl.on("close", () => {
  closed = true;
  wake?.();
});

async function answer(content) {
  if (turns++ > 0) init();
  echo(content);
  let text = `got: ${content}`;
  const id = `msg_fake_${turns}`;
  const request = (current = { interrupted: false });
  out({ type: "system", subtype: "status", status: "requesting" });
  if (process.env.FAKE_CLAUDE_TOOL === "1") {
    const toolId = `toolu_fake_${turns}`;
    se({ type: "message_start", message: { id: `${id}_tool`, type: "message", role: "assistant", content: [] } });
    se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: "mcp__noa__read_page", input: {} } });
    se({ type: "message_stop" });
    out({ type: "assistant", message: { id: `${id}_tool`, role: "assistant", content: [{ type: "tool_use", id: toolId, name: "mcp__noa__read_page", input: {} }] } });
    await sleep(slow);
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "page" }] } });
    // Messages that came in while the tool ran are read now, with its result.
    for (const merged of inbox.splice(0)) {
      echo(merged);
      text += ` (and: ${merged})`;
    }
    out({ type: "system", subtype: "status", status: "requesting" });
    await sleep(Number(process.env.FAKE_CLAUDE_ANSWER_MS || 0));
  } else if (slow) await sleep(slow);
  if (request.interrupted) {
    out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" });
    return;
  }
  if (process.env.FAKE_CLAUDE_PARTIAL === "1") {
    se({ type: "message_start", message: { id, type: "message", role: "assistant", content: [] } });
    se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const part of text.split(/(?<= )/)) {
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
      await sleep(5);
    }
    se({ type: "message_stop" });
  }
  out({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "✓ done" });
}

for (;;) {
  if (!inbox.length) {
    if (closed) break;
    await new Promise((r) => (wake = r));
    wake = null;
    continue;
  }
  await answer(inbox.shift());
}
if (process.env.FAKE_CLAUDE_HANG === "1") setInterval(() => {}, 1000);
else process.exit(0);
