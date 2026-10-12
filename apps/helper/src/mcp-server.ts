/**
 * Stdio MCP server that exposes the Noa tools and relays every call
 * over the named pipe to the helper.
 *
 * Spawned by a task session's Claude Code (see the session's mcp-config.json), with env:
 *   NOA_PIPE   pipe path of the helper
 *   NOA_PIPE_TOKEN  the token every pipe call carries
 *   NOA_TASK   session id of the task (empty: the attached session's tools)
 *   NOA_TOOLS  comma list of tool names to register (default: all)
 *   NOA_JEV    "1": Jev picks act's elements (read_page and act are described for that mode)
 *
 * Or from the user's own Claude Code:
 *   claude mcp add noa -- node <repo>/apps/helper/dist/mcp-server.js --attach
 * which finds the running helper through %LOCALAPPDATA%\noa\helper.json
 * and offers the interactive tools (no task_*).
 *
 * stdout carries MCP JSON-RPC only; diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage, INTERACTIVE_TOOL_NAMES, MCP_SERVER_NAME, RPC_CLOSED, rpcErrorCode, toolArgsSchema, toolDescription, type ToolName } from "@noa/shared";
import { connectPipe, type PipeClient } from "./pipe-server.js";
import { INTERACTIVE_TASK_ID, TOOL_CALL_TIMEOUT_MS, TOOL_LIST_TIMEOUT_MS, toMcpResult, toolsFromEnv } from "./mcp-tools.js";
import { HELPER_VERSION, loadConfig } from "./config.js";
import { ENV } from "./env-names.js";
import { isPidAlive, readHelperFile } from "./helper-file.js";

const NOT_RUNNING =
  "Noa helper is not running: open Chrome with the Noa extension (it starts the helper), then restart this MCP server.";

/** Diagnostics go to stderr: stdout carries MCP frames only. */
function warn(message: string): void {
  process.stderr.write(`Noa mcp-server: ${message}\n`);
}

function fail(message: string, code = 1): never {
  warn(message);
  process.exit(code);
}

async function main(): Promise<void> {
  // Safety net: keep stdout for MCP frames only.
  const toStderr = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const attach = process.argv.includes("--attach");
  let pipePath: string;
  let token: string;
  let taskId: string;
  let tools: ToolName[];
  let jev = false;
  if (attach) {
    const cfg = loadConfig();
    const info = readHelperFile(cfg.helperFilePath);
    if (!info || !isPidAlive(info.pid)) fail(NOT_RUNNING);
    pipePath = info.pipe;
    token = info.token;
    taskId = INTERACTIVE_TASK_ID;
    tools = [...INTERACTIVE_TOOL_NAMES];
  } else {
    const p = process.env[ENV.pipe];
    if (!p) fail(`${ENV.pipe} is not set (use --attach to connect to the running helper)`, 2);
    pipePath = p;
    token = process.env[ENV.pipeToken] ?? "";
    taskId = process.env[ENV.task] || INTERACTIVE_TASK_ID;
    tools = toolsFromEnv(process.env[ENV.tools]);
    jev = process.env[ENV.jev] === "1";
  }

  let pipe: PipeClient;
  try {
    pipe = await connectPipe(pipePath);
  } catch (e) {
    fail(attach ? NOT_RUNNING : `cannot connect to ${pipePath}: ${errorMessage(e)}`);
  }
  if (attach) {
    // Ask the helper which tools this session allows; a helper that does not answer cannot run them either.
    try {
      const list = await pipe.peer.call("tool.list", { token, taskId }, { timeoutMs: TOOL_LIST_TIMEOUT_MS });
      if (list.names.length) tools = tools.filter((n) => list.names.includes(n));
      jev = list.jev === true;
    } catch (e) {
      fail(`${NOT_RUNNING} (${errorMessage(e)})`);
    }
  }

  const server = new McpServer({ name: MCP_SERVER_NAME, version: HELPER_VERSION });
  for (const name of tools) {
    server.registerTool(name, { description: toolDescription(name, jev), inputSchema: toolArgsSchema(name, jev) }, async (args: unknown): Promise<CallToolResult> => {
      try {
        const r = await pipe.peer.call("tool.call", { token, taskId, name, args: args ?? {} }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
        return toMcpResult(r);
      } catch (e) {
        return toMcpResult({ text: `${name} failed: ${rpcErrorCode(e) === RPC_CLOSED ? NOT_RUNNING : errorMessage(e)}`, isError: true });
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  let exiting = false;
  const exit = (why: string) => {
    if (exiting) return;
    exiting = true;
    warn(`${why}, exiting`);
    pipe.close();
    void server.close().finally(() => process.exit(0));
  };
  // The helper went away: nothing useful left to do.
  void pipe.closed.then(() => exit("pipe closed"));
  // Claude Code went away (the SDK's stdio transport does not notice): without this, the open pipe would keep this process alive until the helper stops.
  process.stdin.once("end", () => exit("stdin closed"));
}

main().catch((e) => {
  warn(e instanceof Error ? String(e.stack) : String(e));
  process.exit(1);
});
