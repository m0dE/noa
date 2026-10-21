import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Interjections } from "@noa/core";
import type { AgentEvent } from "@noa/shared";
import { UserInput, type BrainContext } from "../src/brains/brain.js";
import { mapRunLine, OpencodeBrain, RESULT_REMINDER } from "../src/brains/opencode.js";
import { buildOpencodeConfig, noaFolderOpencode, OPENCODE_TOOLS_OFF, opencodeEnv, opencodeRunArgs, resolveOpencodePath } from "../src/opencode-process.js";
import { localSummarize } from "../src/memory-summarize.js";

const FAKE = fileURLToPath(new URL("./support/fake-opencode.mjs", import.meta.url));

describe("finding OpenCode", () => {
  const base = "/noa";
  it("NOA_OPENCODE_PATH, then the one noa-local-llm installed in Noa's folder, then the PATH, then OpenCode's own installer's", () => {
    const own = noaFolderOpencode(base);
    expect(own).toBe(join(base, "opencode", "node_modules", "opencode-ai", "bin", "opencode.exe"));
    expect(resolveOpencodePath({ NOA_OPENCODE_PATH: " /x/opencode " }, base, { exists: () => false })).toBe("/x/opencode");
    expect(resolveOpencodePath({}, base, { exists: (p) => p === own, where: () => "/usr/bin/opencode" })).toBe(own);
    expect(resolveOpencodePath({}, base, { exists: (p) => p === "/usr/bin/opencode", where: () => "/usr/bin/opencode\n" })).toBe("/usr/bin/opencode");
    const installed = join("/home/u", ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    expect(resolveOpencodePath({ USERPROFILE: "/home/u" }, base, { exists: (p) => p === installed, where: () => { throw new Error("not found"); } })).toBe(installed);
    expect(resolveOpencodePath({}, base, { exists: () => false, where: () => "" })).toBeNull();
  });
});

describe("a session's OpenCode config", () => {
  const spec = { serverUrl: "http://localhost:11434/v1/", model: "qwen3:8b", systemPromptPath: "/run/system-prompt.txt", mcp: { command: "node", args: ["/h/mcp-server.js"], env: { NOA_TASK: "s1" } } };

  it("the local server (with /v1 trimmed and put back), its model, Noa's prompt and MCP server; no shell or files; no title call", () => {
    const c = buildOpencodeConfig(spec) as any;
    expect(c.provider["noa-local"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Local model",
      options: { baseURL: "http://localhost:11434/v1" },
      models: { "qwen3:8b": { name: "qwen3:8b", tool_call: true, limit: { context: 32768, output: 8192 } } },
    });
    expect(c.model).toBe("noa-local/qwen3:8b");
    expect(c.small_model).toBe("noa-local/qwen3:8b");
    expect(c.mcp.noa).toEqual({ type: "local", command: ["node", "/h/mcp-server.js"], environment: { NOA_TASK: "s1" }, enabled: true });
    expect(c.agent.noa.prompt).toBe("{file:/run/system-prompt.txt}");
    expect(c.agent.noa.tools.bash).toBe(false);
    for (const t of OPENCODE_TOOLS_OFF) expect(c.agent.noa.tools[t]).toBe(false);
    // Web search, web pages and skills stay.
    for (const t of ["websearch", "webfetch", "skill"]) expect(c.agent.noa.tools[t]).toBeUndefined();
    expect(c.agent.title).toEqual({ disable: true });
    expect((buildOpencodeConfig({ ...spec, apiKey: "k" }) as any).provider["noa-local"].options.apiKey).toBe("k");
    expect(() => buildOpencodeConfig({ ...spec, serverUrl: "localhost" })).toThrow(/not a web address/);
  });

  it("web search on, the config in the environment, Claude Code's prompt files left out; the message on stdin", () => {
    const env = opencodeEnv({ a: 1 }, { PATH: "/bin" });
    expect(env).toMatchObject({ PATH: "/bin", OPENCODE_CONFIG_CONTENT: '{"a":1}', OPENCODE_ENABLE_EXA: "1", OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" });
    expect(opencodeRunArgs({})).toEqual(["run", "--format", "json", "--thinking", "--agent", "noa"]);
    expect(opencodeRunArgs({ session: "ses_1", files: ["/a.png"] })).toEqual(["run", "--format", "json", "--thinking", "--agent", "noa", "--session", "ses_1", "--file", "/a.png"]);
  });
});

describe("OpenCode's JSON events", () => {
  it("text, reasoning as live thinking, its own tools as calls and results, errors; Noa's tools left to the executor", () => {
    expect(mapRunLine({ type: "text", part: { id: "t", text: " hi " } })).toEqual([{ type: "assistant_text", text: "hi" }]);
    expect(mapRunLine({ type: "reasoning", part: { id: "r", text: "hmm" } })).toEqual([{ type: "assistant_text_delta", id: "r", text: "hmm", thinking: true }]);
    expect(mapRunLine({ type: "tool_use", part: { tool: "websearch", callID: "c", state: { status: "completed", input: { query: "q" }, output: "found" } } })).toEqual([
      { type: "tool_call", id: "c", name: "websearch", args: { query: "q" } },
      { type: "tool_result", id: "c", name: "websearch", text: "found" },
    ]);
    expect(mapRunLine({ type: "tool_use", part: { tool: "webfetch", callID: "d", state: { status: "error", input: {}, error: "404" } } })[1]).toEqual({ type: "tool_result", id: "d", name: "webfetch", text: "404", isError: true });
    expect(mapRunLine({ type: "tool_use", part: { tool: "noa_click", callID: "e", state: { status: "completed" } } })).toEqual([]);
    expect(mapRunLine({ type: "error", error: { name: "APIError", data: { message: "Bad Request" } } })).toEqual([{ type: "error", text: "OpenCode: Bad Request" }]);
    expect(mapRunLine({ type: "step_start" })).toEqual([]);
    expect(mapRunLine(null)).toEqual([]);
  });
});

describe("OpencodeBrain", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "noa-opencode-"));
    log = join(dir, "fake.jsonl");
    process.env.FAKE_OC_LOG = log;
    writeFileSync(join(dir, "mcp-config.json"), JSON.stringify({ mcpServers: { noa: { command: "node", args: ["/h/mcp-server.js"], env: { NOA_TASK: "s1" } } } }));
  });
  afterEach(() => {
    delete process.env.FAKE_OC_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  function context(prompt: string, extra: Partial<BrainContext> = {}) {
    const events: AgentEvent[] = [];
    const logged: Record<string, unknown>[] = [];
    let idle = 0;
    const input = new UserInput();
    const controller = new AbortController();
    // A turn has its result once the model called noa_task_complete (in the fake: in each turn's reminder run).
    const turnOver = () => runs().filter((r) => r.message.startsWith("You stopped")).length > idle;
    const ctx: BrainContext = {
      taskId: "s1",
      prompt,
      systemPrompt: "You are Noa.",
      model: "qwen3:8b",
      mcpConfigPath: join(dir, "mcp-config.json"),
      allowedTools: [],
      signal: controller.signal,
      log: (e) => logged.push(e),
      emit: (e) => events.push(e),
      input,
      interjections: new Interjections(),
      idle: () => idle++,
      turnOver,
      ...extra,
    };
    return { ctx, events, logged, input, controller, idle: () => idle };
  }

  const brain = () => new OpencodeBrain({ opencodePath: process.execPath, prefixArgs: [FAKE], serverUrl: "http://localhost:11434", model: "fallback" });

  it("runs the message, reminds once of the result when it stopped without one, stops the run after the result, and continues the session for a follow-up", async () => {
    const c = context("Please read the page.");
    const done = brain().run(c.ctx);
    // Turn 1: the answer, then the reminder's run, which is stopped once the result is in.
    await expect.poll(() => c.idle(), { timeout: 10_000 }).toBe(1);
    let r = runs();
    expect(r.map((x) => x.message)).toEqual(["Please read the page.", RESULT_REMINDER]);
    expect(r[0].args).toEqual(["run", "--format", "json", "--thinking", "--agent", "noa"]);
    expect(r[1].args).toEqual(["run", "--format", "json", "--thinking", "--agent", "noa", "--session", "ses_fake"]);
    expect(r[0].config.model).toBe("noa-local/qwen3:8b");
    expect(r[0].config.agent.noa.prompt).toMatch(/^\{file:.*system-prompt-[0-9a-f]{16}\.txt\}$/);
    expect(r[0].exa).toBe("1");
    expect(c.logged).toContainEqual(expect.objectContaining({ type: "opencode_stop", reason: "turn over" }));
    expect(c.events).toContainEqual({ type: "assistant_text", text: "NX-48213" });
    expect(c.events).toContainEqual({ type: "assistant_text_delta", id: "r1", text: "Let me look.", thinking: true });
    // The stopped run is not an error.
    expect(c.events.filter((e) => e.type === "error")).toEqual([]);

    // A follow-up continues the same OpenCode session, and gets its own reminder.
    c.input.push("Now search the web.");
    await expect.poll(() => runs().length, { timeout: 10_000 }).toBe(4);
    await expect.poll(() => c.idle(), { timeout: 10_000 }).toBe(2);
    r = runs();
    expect(r[2].message).toBe("Now search the web.");
    expect(r[2].args).toContain("--session");
    expect(c.events).toContainEqual({ type: "tool_call", id: "c2", name: "websearch", args: { query: "ollama release" } });
    c.input.close();
    await done;
  });

  it("says when OpenCode fails (the server refused), and ends the turn without a reminder", async () => {
    const c = context("crash please", { turnOver: () => false });
    const done = brain().run(c.ctx);
    await expect.poll(() => c.idle(), { timeout: 10_000 }).toBe(1);
    expect(c.events.filter((e) => e.type === "error").map((e) => (e as { text: string }).text)).toEqual(["OpenCode: Bad Request: no such model", "OpenCode exited with code 1"]);
    // No reminder after a failed run: it would only fail again.
    expect(runs().map((x) => x.message)).toEqual(["crash please"]);
    c.input.close();
    await done;
  });

  it("an abort stops the running OpenCode and ends the session", async () => {
    const c = context("Please read the page.", { turnOver: () => false });
    const done = brain().run(c.ctx);
    await expect.poll(() => runs().length, { timeout: 10_000 }).toBe(2);
    c.controller.abort("user stop");
    await done;
    expect(c.logged).toContainEqual(expect.objectContaining({ type: "opencode_kill" }));
  });
});

describe("localSummarize (memory.summarize for the Local model)", () => {
  it("one chat completion from the user's server with the conversation's model; the server's error said", async () => {
    const calls: [string, RequestInit][] = [];
    const ok = (async (url: string, init: RequestInit) => (calls.push([url, init]), Response.json({ choices: [{ message: { content: '{"episode":null}' } }] }))) as unknown as typeof fetch;
    expect(await localSummarize({ serverUrl: "http://localhost:11434", model: "qwen3:8b", system: "SYS", prompt: "P", fetch: ok })).toEqual({ text: '{"episode":null}' });
    expect(calls[0]![0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({ model: "qwen3:8b", messages: [{ role: "system", content: "SYS" }, { role: "user", content: "P" }] });
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBeUndefined();
    const refused = (async () => Response.json({ error: { message: "model not found" } }, { status: 404 })) as unknown as typeof fetch;
    await expect(localSummarize({ serverUrl: "http://localhost:11434", model: "x", system: "S", prompt: "P", fetch: refused })).rejects.toThrow("The local model's server answered HTTP 404: model not found");
  });
});
