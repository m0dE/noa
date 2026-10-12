import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PipeMethods } from "@noa/shared";
import { pipePathFor, startPipeServer, connectPipe, type PipeServer } from "../src/pipe-server.js";
import { toMcpResult, toolsFromEnv } from "../src/mcp-tools.js";
import { buildMcpConfig } from "../src/session/session-setup.js";

const MCP_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp-server.js");

const received: Omit<PipeMethods["tool.call"]["params"], "token">[] = [];
let pipe: PipeServer;
const pipePath = pipePathFor(900_000 + Math.floor(Math.random() * 99_999));
const TOKEN = "t0ken-of-this-helper";

beforeAll(async () => {
  pipe = await startPipeServer(pipePath, TOKEN, {
    toolCall: async (p) => {
      received.push(p);
      if (p.name === "screenshot") return { image: { base64: "aGVsbG8=", mimeType: "image/jpeg" } };
      if (p.name === "click") return { text: "click failed: element 9 not found", isError: true };
      return { text: `URL: https://x.com/home\nrelayed ${p.name} for ${p.taskId}` };
    },
    toolList: () => ({ names: ["read_page"] }),
  });
});
afterAll(async () => {
  await pipe.close();
});

async function connect(tools: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_JS],
    env: { ...getDefaultEnvironment(), NOA_PIPE: pipePath, NOA_PIPE_TOKEN: TOKEN, NOA_TASK: "T9", NOA_TOOLS: tools },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("pipe", () => {
  it("relays tool.call and tool.list between peers", async () => {
    const c = await connectPipe(pipePath);
    expect(await c.peer.call("tool.list", { token: TOKEN, taskId: "T" })).toEqual({ names: ["read_page"] });
    received.length = 0;
    const r = await c.peer.call("tool.call", { token: TOKEN, taskId: "T", name: "read_page", args: {} });
    expect(r.text).toContain("relayed read_page for T");
    // The token is checked, not passed on.
    expect(received).toEqual([{ taskId: "T", name: "read_page", args: {} }]);
    c.close();
    await c.closed;
  });

  it("answers no call without the helper's token (any other process of the user that finds the pipe)", async () => {
    const c = await connectPipe(pipePath);
    received.length = 0;
    for (const token of ["guess", "", undefined]) {
      await expect(c.peer.call("tool.call", { token, taskId: "interactive", name: "get_credential", args: { site: "bank.test" } } as never)).rejects.toThrow(/not authorized/);
      await expect(c.peer.call("tool.list", { token, taskId: "interactive" } as never)).rejects.toThrow(/not authorized/);
    }
    expect(received).toEqual([]);
    c.close();
    await c.closed;
  });
});

describe("mcp-server.js over stdio", () => {
  it("registers only NOA_TOOLS and relays calls over the pipe", async () => {
    const client = await connect("read_page,screenshot,click,task_complete");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["click", "read_page", "screenshot", "task_complete"]);
      const click = tools.find((t) => t.name === "click")!;
      expect(click.description).toMatch(/Click an element by index/);
      expect((click.inputSchema as any).properties.index.type).toBe("integer");
      expect((click.inputSchema as any).required).toEqual(["index"]);

      received.length = 0;
      const r = await client.callTool({ name: "read_page", arguments: {} });
      expect(r.content).toEqual([{ type: "text", text: "URL: https://x.com/home\nrelayed read_page for T9" }]);
      expect(received).toEqual([{ taskId: "T9", name: "read_page", args: {} }]);

      const shot = await client.callTool({ name: "screenshot", arguments: {} });
      expect(shot.content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }]);

      const bad = await client.callTool({ name: "click", arguments: { index: 9 } });
      expect(bad.isError).toBe(true);
      expect(received.at(-1)).toEqual({ taskId: "T9", name: "click", args: { index: 9 } });

      // Schema validation happens in the MCP server; invalid args never reach the pipe.
      const before = received.length;
      const invalid = await client.callTool({ name: "click", arguments: { index: "x" } }).catch((e: Error) => ({ isError: true, error: e }));
      expect(invalid.isError).toBe(true);
      expect(received.length).toBe(before);
    } finally {
      await client.close();
    }
  });

  it("exits when Claude Code goes away (stdin closes), though the helper's pipe is still open", async () => {
    const child = spawn(process.execPath, [MCP_JS], {
      env: { ...getDefaultEnvironment(), NOA_PIPE: pipePath, NOA_PIPE_TOKEN: TOKEN, NOA_TASK: "T9", NOA_TOOLS: "read_page" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      // Once it answers initialize, it is connected to the pipe and serving.
      const answered = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
      await answered;
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.stdin.end();
      expect(await Promise.race([exited, new Promise<"still running">((r) => setTimeout(() => r("still running"), 5000))])).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("task_* take an optional follow-up suggestion of at most 80 characters, relayed as given", async () => {
    const client = await connect("task_complete,task_fail,task_pause");
    try {
      const { tools } = await client.listTools();
      for (const t of tools) {
        const props = (t.inputSchema as any).properties;
        expect(props.suggestion).toMatchObject({ type: "string", maxLength: 80 });
        expect(props.suggestion.description).toMatch(/runs only if they accept and send it/);
        expect((t.inputSchema as any).required ?? []).not.toContain("suggestion");
      }
      expect(tools.find((t) => t.name === "task_complete")!.description).toMatch(/suggestion/);

      received.length = 0;
      const args = { summary: "Checked email", suggestion: "Reply to Jordan and say I'll sign by Thursday" };
      await client.callTool({ name: "task_complete", arguments: args });
      expect(received).toEqual([{ taskId: "T9", name: "task_complete", args }]);

      const long = await client
        .callTool({ name: "task_complete", arguments: { summary: "x", suggestion: "x".repeat(81) } })
        .catch((e: Error) => ({ isError: true, error: e }));
      expect(long.isError).toBe(true);
      expect(received).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("offers act only when the helper allows it", async () => {
    const withAct = await connect("act,read_page");
    try {
      expect((await withAct.listTools()).tools.map((t) => t.name).sort()).toEqual(["act", "read_page"]);
    } finally {
      await withAct.close();
    }
  });
});

describe("mcp-server.js --attach", () => {
  it("finds the helper through helper.json and serves the interactive tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "bt-attach-"));
    try {
      writeFileSync(join(home, "helper.json"), JSON.stringify({ pipe: pipePath, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString() }));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_JS, "--attach"],
        env: { ...getDefaultEnvironment(), NOA_HOME: home },
        stderr: "pipe",
      });
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);
      try {
        // tool.list from the helper answers ["read_page"]; the interactive list is narrowed to it
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["read_page"]);
        await client.callTool({ name: "read_page", arguments: {} });
        expect(received.at(-1)).toEqual({ taskId: "interactive", name: "read_page", args: {} });
      } finally {
        await client.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("explains that the helper is not running", () => {
    const home = mkdtempSync(join(tmpdir(), "bt-attach-"));
    try {
      const r = spawnSync(process.execPath, [MCP_JS, "--attach"], { env: { ...process.env, NOA_HOME: home }, encoding: "utf8", timeout: 20_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/helper is not running: open Chrome with the Noa extension/);
      // a stale helper.json (dead pid) is treated the same
      writeFileSync(join(home, "helper.json"), JSON.stringify({ pipe: "\\.\pipe\nope", pid: 999_999_99, startedAt: "" }));
      const r2 = spawnSync(process.execPath, [MCP_JS, "--attach"], { env: { ...process.env, NOA_HOME: home }, encoding: "utf8", timeout: 20_000 });
      expect(r2.status).toBe(1);
      expect(r2.stderr).toMatch(/open Chrome with the Noa extension/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("mcp helpers", () => {
  it("a task session's MCP server is given the pipe's token with the pipe", () => {
    const cfg = buildMcpConfig({ nodePath: "node", mcpServerPath: "mcp.js", pipePath, pipeToken: TOKEN, taskId: "T1", toolNames: ["read_page"] });
    expect(cfg.mcpServers.noa.env).toMatchObject({ NOA_PIPE: pipePath, NOA_PIPE_TOKEN: TOKEN, NOA_TASK: "T1" });
  });

  it("parses the tool list env", () => {
    expect(toolsFromEnv("read_page, act,bogus")).toEqual(["read_page", "act"]);
    expect(toolsFromEnv(undefined)).toContain("task_pause");
  });

  it("converts ToolResult to MCP content", () => {
    expect(toMcpResult({ text: "a", image: { base64: "b", mimeType: "image/png" }, isError: true })).toEqual({
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "b", mimeType: "image/png" },
      ],
      isError: true,
    });
    expect(toMcpResult({})).toEqual({ content: [{ type: "text", text: "ok" }] });
  });
});
