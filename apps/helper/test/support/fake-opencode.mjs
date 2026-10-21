// Stands in for `opencode run --format json`: appends {args, message, config} to FAKE_OC_LOG, then answers by the
// message (read from stdin to its end, as OpenCode reads it):
// - "read the page": the model reads the page with Noa's tool and writes the answer, without a task_* call;
// - the result reminder: it calls noa_task_complete, then waits (the brain stops it once the turn has its result);
// - "search": OpenCode's websearch, its result, and the answer; no task_* call either;
// - "crash": an error event and exit code 1.
import { appendFileSync } from "node:fs";

let message = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (message += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  appendFileSync(process.env.FAKE_OC_LOG, JSON.stringify({ args, message, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null"), exa: process.env.OPENCODE_ENABLE_EXA }) + "\n");
  const sessionID = args.includes("--session") ? args[args.indexOf("--session") + 1] : "ses_fake";
  const out = (type, part = {}) => process.stdout.write(JSON.stringify({ type, sessionID, part }) + "\n");
  if (message.startsWith("You stopped")) {
    out("tool_use", { tool: "noa_task_complete", callID: "c9", state: { status: "completed", input: { summary: "done" }, output: "ok" } });
    setInterval(() => {}, 1000);
    return;
  }
  if (message.includes("crash")) {
    process.stdout.write(JSON.stringify({ type: "error", sessionID, error: { name: "APIError", data: { message: "Bad Request: no such model" } } }) + "\n");
    process.exit(1);
  }
  out("step_start");
  out("reasoning", { id: "r1", text: "Let me look." });
  if (message.includes("search")) {
    out("tool_use", { tool: "websearch", callID: "c2", state: { status: "completed", input: { query: "ollama release" }, output: "v0.40.7" } });
    out("text", { id: "t2", text: "v0.40.7" });
  } else {
    out("tool_use", { tool: "noa_read_page", callID: "c1", state: { status: "completed", input: {}, output: "page" } });
    out("text", { id: "t1", text: "NX-48213" });
  }
  out("step_finish");
  process.exit(0);
});
