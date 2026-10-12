import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES, toolsFor, type AgentEvent } from "@noa/shared";
import { buildSystemPrompt, interjectionText, Interjections, raiseNote, THINKING_BUDGET_TOKENS, type ReasoningChange } from "@noa/core";
import { ClaudeCodeBrain, buildClaudeArgs, systemPromptFile } from "../src/brains/claude-code.js";
import { apiBillingVarsIn, CLAUDE_RUN_ENV, claudeEnv, resolveClaudePath } from "../src/claude-process.js";
import { UserInput, type BrainContext } from "../src/brains/brain.js";
import { SelfTestCache, parseSelfTestOutput, runSelfTest, selfTestArgs } from "../src/self-test.js";

const SUPPORT = join(dirname(fileURLToPath(import.meta.url)), "support");
const FAKE = join(SUPPORT, "fake-claude.mjs");

let dir: string;
const saved = { CLAUDECODE: process.env.CLAUDECODE, CHILD: process.env.CLAUDE_CODE_CHILD_SESSION };
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bt-claude-")));
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_HANG;
  delete process.env.FAKE_CLAUDE_SLOW_MS;
  delete process.env.FAKE_CLAUDE_PARTIAL;
  delete process.env.FAKE_CLAUDE_TOOL;
  delete process.env.FAKE_CLAUDE_ANSWER_MS;
  for (const [k, v] of [["CLAUDECODE", saved.CLAUDECODE], ["CLAUDE_CODE_CHILD_SESSION", saved.CHILD]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function ctx(signal: AbortSignal, log: Record<string, any>[], events: AgentEvent[], input = new UserInput(), interjections = new Interjections()): BrainContext {
  return {
    taskId: "S1",
    prompt: 'Line one\nLine "two" with \\ backslash and trailing \\',
    systemPrompt: "rules & <stuff> | %PATH%",
    mcpConfigPath: join(dir, "mcp-config.json"),
    allowedTools: ["mcp__noa__read_page", "mcp__noa__task_complete"],
    signal,
    log: (e) => log.push(e),
    emit: (e) => events.push(e),
    input,
    interjections,
  };
}

const brain = () => new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE] });

describe("ClaudeCodeBrain process handling (fake claude)", () => {
  it("passes the exact args, sends the prompt as the first stream-json message, maps events, and exits when all turns are done", async () => {
    process.env.CLAUDECODE = "1"; // must not leak into the child
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const c = ctx(new AbortController().signal, log, events);
    await brain().run(c);
    const init = log.find((e) => e.type === "claude" && e.event.type === "system")!.event;
    // No Reasoning setting given: the default, Fast (thinking off).
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "sonnet", thinking: false }));
    expect(init.cwd).toBe(dir);
    expect(init.nested).toBeNull();
    expect(init.child).toBeNull();
    expect(log.find((e) => e.type === "claude_stdout")).toEqual({ type: "claude_stdout", text: "not json" });
    expect(events.filter((e) => e.type !== "trace")).toEqual([
      { type: "status", text: "Claude Code started (sonnet)" },
      { type: "assistant_text", text: `got: ${c.prompt}` },
    ]);
    // Its timings go on the same stream, as trace events (the extension keeps them apart).
    expect(events.flatMap((e) => (e.type === "trace" ? [[e.trace.name, e.trace.src]] : []))).toEqual([
      ["claude.ready", "helper"],
      ["claude.result", "helper"],
    ]);
    expect(c.input.closed).toBe(true);
    expect(log.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
  });

  it("passes the system prompt in a file in the run folder: the command line stays far below Windows' 32,767 characters", async () => {
    const log: Record<string, any>[] = [];
    // A task session's real prompt, with every tool, Jev and follow-ups (the longest there is).
    const tools = TOOL_NAMES.filter((n) => toolsFor().includes(n));
    const systemPrompt = buildSystemPrompt({ tools, jev: true, followUps: true, readAttachments: true });
    expect(systemPrompt.length).toBeGreaterThan(20_000);
    const c = { ...ctx(new AbortController().signal, log, []), systemPrompt };
    await brain().run(c);
    const args: string[] = log.find((e) => e.type === "claude" && e.event.type === "system")!.event.args;
    expect(args).not.toContain(systemPrompt);
    const file = args[args.indexOf("--append-system-prompt-file") + 1]!;
    expect(dirname(file)).toBe(dir);
    expect(readFileSync(file, "utf8")).toBe(systemPrompt);
    expect([process.execPath, ...args].join(" ").length).toBeLessThan(2_000);
    // The same prompt is the same file (a process started ahead is taken by its args); another is another.
    expect(systemPromptFile(c.mcpConfigPath, systemPrompt)).toBe(file);
    expect(systemPromptFile(c.mcpConfigPath, `${systemPrompt} `)).not.toBe(file);
  });

  it("streams text deltas in batches, then the final text with the same id; the run log keeps only the final text", async () => {
    process.env.FAKE_CLAUDE_PARTIAL = "1";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const c = { ...ctx(new AbortController().signal, log, events), prompt: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty" };
    await brain().run(c);
    const deltas = events.filter((e) => e.type === "assistant_text_delta") as Extract<AgentEvent, { type: "assistant_text_delta" }>[];
    const final = events.find((e) => e.type === "assistant_text") as Extract<AgentEvent, { type: "assistant_text" }>;
    expect(final).toEqual({ type: "assistant_text", text: `got: ${c.prompt}`, id: "msg_fake_1:0" });
    // 22 word deltas over >100 ms arrive batched: more than one, far fewer than 22.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThan(15);
    expect(deltas.every((d) => d.id === "msg_fake_1:0")).toBe(true);
    expect(deltas.map((d) => d.text).join("")).toBe(final.text);
    const shown = events.filter((e) => e.type !== "trace");
    expect(shown.indexOf(final)).toBe(shown.length - 1);
    expect(log.some((e) => e.type === "claude" && e.event.type === "stream_event")).toBe(false);
    expect(log.some((e) => e.type === "claude" && e.event.type === "assistant")).toBe(true);
  });

  it("runs the model chosen in the extension (ctx.model) instead of its default", async () => {
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const c = { ...ctx(new AbortController().signal, log, events), model: "claude-opus-5-5" };
    await brain().run(c);
    const init = log.find((e) => e.type === "claude" && e.event.type === "system")!.event;
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "claude-opus-5-5", thinking: false }));
    expect(log.find((e) => e.type === "claude_start")).toMatchObject({ model: "claude-opus-5-5" });
    expect(events.find((e) => e.type !== "trace")).toEqual({ type: "status", text: "Claude Code started (claude-opus-5-5)" });
  });

  it("a message typed while the model only thinks or writes goes to stdin and interrupts that request, so it is read at once, with no error shown", async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = "400";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const routes: string[] = [];
    const interjections = new Interjections((route) => routes.push(route));
    const run = brain().run(ctx(new AbortController().signal, log, events, new UserInput(), interjections));
    // The model's request is running (Claude Code said "requesting").
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude" && e.event.status === "requesting")).toBe(true));
    interjections.add("no, use page B");
    expect(interjections.unseen).toBe(true);
    await run;
    const texts = events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    // The first answer was never written: the interrupted request was dropped.
    expect(texts).toEqual([`got: ${interjectionText(["no, use page B"])}`]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(log.filter((e) => e.type === "claude_interrupt")).toHaveLength(1);
    // Read (Claude Code echoed it), by way of the interrupt.
    expect(interjections.unseen).toBe(false);
    expect(routes).toEqual(["interrupt"]);
  });

  it("a message typed while a tool runs is no interrupt: Claude Code reads it with the tool's result, in the same turn", async () => {
    process.env.FAKE_CLAUDE_TOOL = "1";
    process.env.FAKE_CLAUDE_SLOW_MS = "300";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const routes: string[] = [];
    const interjections = new Interjections((route) => routes.push(route));
    const c = ctx(new AbortController().signal, log, events, new UserInput(), interjections);
    const run = brain().run(c);
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude" && e.event.type === "assistant")).toBe(true));
    interjections.add("also add a hashtag");
    // Written at once; not read before the tool's result.
    expect(log.find((e) => e.type === "claude_user_message")).toMatchObject({ kind: "next_step" });
    expect(interjections.unseen).toBe(true);
    await run;
    expect(log.some((e) => e.type === "claude_interrupt")).toBe(false);
    const texts = events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual([`got: ${c.prompt} (and: ${interjectionText(["also add a hashtag"])})`]);
    expect(interjections.unseen).toBe(false);
    expect(routes).toEqual(["next_step"]);
  });

  /** A session's reasoning as the task session hands it over, with a trigger for its changes. */
  function reasoningChannel(thinking: boolean) {
    let listener: ((c: ReasoningChange) => void) | null = null;
    return {
      channel: { thinking, onChange: (fn: (c: ReasoningChange) => void) => void (listener = fn) },
      change: (c: ReasoningChange) => listener?.(c),
      subscribed: () => listener !== null,
    };
  }
  const thinkingLines = (log: Record<string, any>[]) => log.filter((e) => e.type === "claude" && e.event.subtype === "fake_thinking").map((e) => e.event.max_thinking_tokens);

  it("a raise in a Fast session turns thinking on and stops the running request, so the note starts a new turn that thinks; a lower turns it off for the next turn", async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = "400";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const r = reasoningChannel(false);
    const c = { ...ctx(new AbortController().signal, log, events), reasoning: r.channel };
    const run = brain().run(c);
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude" && e.event.status === "requesting")).toBe(true));
    r.change({ kind: "raise", thinking: true, why: "act failed 3 times in a row" });
    r.change({ kind: "lower", thinking: false, why: "act worked" });
    await run;
    const init = log.find((e) => e.type === "claude" && e.event.type === "system" && e.event.subtype === "init")!.event;
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "sonnet", thinking: false }));
    expect(thinkingLines(log)).toEqual([THINKING_BUDGET_TOKENS, null]);
    expect(log.find((e) => e.type === "claude_interrupt")).toMatchObject({ reason: "reasoning raised" });
    // The interrupted request's answer was dropped; the note was answered in the new turn. No error shown.
    const texts = events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual([`got: ${raiseNote("act failed 3 times in a row")}`]);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("a raise while a tool runs waits for the next request to stop it (never an action half done)", async () => {
    process.env.FAKE_CLAUDE_TOOL = "1";
    process.env.FAKE_CLAUDE_SLOW_MS = "300";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const r = reasoningChannel(false);
    const run = brain().run({ ...ctx(new AbortController().signal, log, events), reasoning: r.channel });
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude" && e.event.type === "assistant")).toBe(true));
    r.change({ kind: "raise", thinking: true, why: "act failed 3 times in a row" });
    // Sent at once; the stop waits for the tool's result.
    expect(thinkingLines(log)).toEqual([]);
    await vi.waitFor(() => expect(thinkingLines(log)).toEqual([THINKING_BUDGET_TOKENS]));
    expect(log.some((e) => e.type === "claude_interrupt")).toBe(false);
    await run;
    const interruptAt = log.findIndex((e) => e.type === "claude_interrupt");
    const toolResultAt = log.findIndex((e) => e.type === "claude" && e.event.type === "user" && Array.isArray(e.event.message?.content) && e.event.message.content[0]?.type === "tool_result");
    expect(interruptAt).toBeGreaterThan(toolResultAt);
  });

  it("a session started thinking (Thorough) keeps it: no settings flag, and changes send nothing (Claude Code cannot turn it off there)", async () => {
    const log: Record<string, any>[] = [];
    const r = reasoningChannel(true);
    const c = { ...ctx(new AbortController().signal, log, []), reasoning: r.channel };
    await brain().run(c);
    const init = log.find((e) => e.type === "claude" && e.event.type === "system" && e.event.subtype === "init")!.event;
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "sonnet" }));
    r.change({ kind: "turn", thinking: false, why: "new turn (fast)" });
    expect(thinkingLines(log)).toEqual([]);
    expect(log.find((e) => e.type === "claude_thinking_kept")).toBeTruthy();
  });

  it("NOA_THINKING (the brain's forced setting) wins over the Reasoning setting and ignores its changes", async () => {
    const log: Record<string, any>[] = [];
    const r = reasoningChannel(true);
    const c = { ...ctx(new AbortController().signal, log, []), reasoning: r.channel };
    await new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", thinking: false, prefixArgs: [FAKE] }).run(c);
    const init = log.find((e) => e.type === "claude" && e.event.type === "system" && e.event.subtype === "init")!.event;
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "sonnet", thinking: false }));
    expect(r.subscribed()).toBe(false);
  });

  it("closing the input (task_* called) ends stdin so claude exits", async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = "300";
    const log: Record<string, any>[] = [];
    const input = new UserInput();
    const run = brain().run(ctx(new AbortController().signal, log, [], input));
    setTimeout(() => input.close(), 20);
    await run;
    expect(log.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
  });

  it("persistent: keeps stdin open after the turn (idle), sends follow-ups as-is, exits when the input closes", async () => {
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const input = new UserInput();
    let idle = 0;
    const c = { ...ctx(new AbortController().signal, log, events, input), idle: () => idle++ };
    const persistent = new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE], persistent: true });
    expect(persistent.persistent).toBe(true);
    const run = persistent.run(c);
    await vi.waitFor(() => expect(idle).toBe(1), { timeout: 10_000 });
    expect(input.closed).toBe(false);
    input.push("Next message from the user: like it");
    await vi.waitFor(() => expect(idle).toBe(2), { timeout: 10_000 });
    input.close();
    await run;
    const texts = events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual([`got: ${c.prompt}`, "got: Next message from the user: like it"]);
    // Claude Code repeats its init event every turn; "started" shows once.
    expect(events.filter((e) => e.type === "status")).toEqual([{ type: "status", text: "Claude Code started (sonnet)" }]);
    expect(log.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
  });

  it("persistent: the request Claude Code starts after the turn's task_* result is stopped at once; nothing it wrote shows, its rows are still traced, and the session answers the next message", async () => {
    process.env.FAKE_CLAUDE_TOOL = "1";
    process.env.FAKE_CLAUDE_SLOW_MS = "100";
    process.env.FAKE_CLAUDE_ANSWER_MS = "400";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const input = new UserInput();
    let idle = 0;
    // The task_* call runs as the tool: its result is recorded before Claude Code gets the tool's result.
    let over = false;
    const c = { ...ctx(new AbortController().signal, log, events, input), idle: () => idle++, turnOver: () => over };
    const run = new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE], persistent: true }).run(c);
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude" && e.event.type === "assistant")).toBe(true));
    over = true;
    await vi.waitFor(() => expect(idle).toBe(1), { timeout: 10_000 });
    expect(log.filter((e) => e.type === "claude_interrupt")).toEqual([{ type: "claude_interrupt", reason: "turn over" }]);
    expect(events.filter((e) => e.type === "assistant_text" || e.type === "assistant_text_delta" || e.type === "error")).toEqual([]);
    const traces = events.flatMap((e) => (e.type === "trace" ? [e.trace] : []));
    expect(traces.find((t) => t.name === "model.call" && t.data?.interrupted)).toMatchObject({ data: { interrupted: "turn over", toolUses: 0 } });
    expect(traces.find((t) => t.name === "claude.result")).toMatchObject({ data: { interrupted: "turn over" } });
    expect(traces.find((t) => t.name === "claude.result")!.data!.error).toBeUndefined();
    // The next turn runs in the same process, untouched.
    over = false;
    input.push("two");
    await vi.waitFor(() => expect(idle).toBe(2), { timeout: 10_000 });
    input.close();
    await run;
    expect(events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text)).toEqual(["got: two"]);
    expect(log.filter((e) => e.type === "claude_interrupt")).toHaveLength(1);
  });

  it("persistent: a later turn's model setting switches the session's model (set_model) before its message; a refused switch is said", async () => {
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const input = new UserInput();
    let idle = 0;
    let switchModel: ((model: string) => void) | null = null;
    const c = { ...ctx(new AbortController().signal, log, events, input), idle: () => idle++, onModelChange: (fn: (m: string) => void) => void (switchModel = fn) };
    const run = new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE], persistent: true }).run(c);
    await vi.waitFor(() => expect(idle).toBe(1), { timeout: 10_000 });
    switchModel!("claude-opus-5-5");
    input.push("two");
    await vi.waitFor(() => expect(idle).toBe(2), { timeout: 10_000 });
    switchModel!("bad-model");
    input.push("three");
    await vi.waitFor(() => expect(idle).toBe(3), { timeout: 10_000 });
    input.close();
    await run;
    const inits = log.filter((e) => e.type === "claude" && e.event.subtype === "init").map((e) => e.event.model);
    expect(inits).toEqual(["sonnet", "claude-opus-5-5", "claude-opus-5-5"]);
    expect(log.filter((e) => e.type === "claude_model").map((e) => e.model)).toEqual(["claude-opus-5-5", "bad-model"]);
    expect(events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text)).toEqual([
      "Claude Code started (sonnet)",
      "Switched the model to claude-opus-5-5",
      "The model was not switched to bad-model (API error: 404 · model not changed): this session keeps claude-opus-5-5",
    ]);
  });

  it("warm: a session started with the same args takes the process started ahead (its early output kept); with other args it is stopped", async () => {
    const b = brain();
    const c = ctx(new AbortController().signal, [], []);
    const spec = { systemPrompt: c.systemPrompt, mcpConfigPath: c.mcpConfigPath, allowedTools: c.allowedTools, thinking: false };
    const warm = b.warm(spec);
    await new Promise((r) => setTimeout(r, 300));
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    await b.run({ ...ctx(new AbortController().signal, log, events), warm });
    expect(warm.ready).toBe(false);
    expect(log.find((e) => e.type === "claude_start")!.prewarmed.ageMs).toBeGreaterThanOrEqual(250);
    // The init line it wrote while waiting reached the session; the prompt was answered.
    expect(events.filter((e) => e.type === "status")).toEqual([{ type: "status", text: "Claude Code started (sonnet)" }]);
    expect(events.some((e) => e.type === "assistant_text")).toBe(true);
    const ready = events.flatMap((e) => (e.type === "trace" && e.trace.name === "claude.ready" ? [e.trace] : []));
    expect(ready[0]?.data?.prewarmedMs).toBeGreaterThanOrEqual(250);

    // Started with Thorough, taken by a Fast session: not used (stopped), a fresh one runs.
    const other = b.warm({ ...spec, thinking: true });
    const log2: Record<string, any>[] = [];
    await b.run({ ...ctx(new AbortController().signal, log2, []), warm: other });
    expect(other.ready).toBe(false);
    expect(log2.find((e) => e.type === "claude_start")!.prewarmed).toBe("not used: started with other settings");
    expect(log2.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
    await other.closed;
  });

  it("kills the process tree on abort", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    const log: Record<string, any>[] = [];
    const ac = new AbortController();
    const run = brain().run(ctx(ac.signal, log, []));
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude")).toBe(true), { timeout: 10_000 });
    ac.abort(new Error("time limit"));
    await run;
    expect(log.some((e) => e.type === "claude_kill")).toBe(true);
    expect(log.at(-1)?.type).toBe("claude_exit");
  });

  it("rejects when claude cannot be started", async () => {
    await expect(
      new ClaudeCodeBrain({ claudePath: join(dir, "missing.exe"), model: "sonnet" }).run(ctx(new AbortController().signal, [], [])),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("self-test", () => {
  const script = (body: string) => {
    const p = join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, body);
    return p;
  };

  it("uses a one-turn headless call with no tools or settings", () => {
    expect(selfTestArgs()).toEqual(["-p", "Reply with exactly: OK", "--output-format", "json", "--tools", "", "--setting-sources", "", "--no-session-persistence", "--model", "haiku"]);
  });

  it("parses json output", () => {
    expect(parseSelfTestOutput('{"type":"result","subtype":"success","is_error":false,"result":"OK"}', "", 0)).toEqual({ ok: true });
    expect(parseSelfTestOutput('{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}', "", 1)).toEqual({
      ok: false,
      error: "Claude Code error: Invalid API key · Please run /login",
    });
    expect(parseSelfTestOutput("", "boom", 3)).toEqual({ ok: false, error: "Claude Code exited with code 3: boom" });
  });

  it("runs a fake claude: ok, error, and timeout", async () => {
    const ok = script(`process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "OK", args: process.argv.slice(2) }))`);
    const r = await runSelfTest({ claudePath: process.execPath, prefixArgs: [ok] });
    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe("number");
    const bad = script(`process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" })); process.exit(1)`);
    expect(await runSelfTest({ claudePath: process.execPath, prefixArgs: [bad] })).toMatchObject({ ok: false, error: "Claude Code error: Not logged in" });
    const hang = script(`setInterval(() => {}, 1000)`);
    expect(await runSelfTest({ claudePath: process.execPath, prefixArgs: [hang], timeoutMs: 300 })).toMatchObject({
      ok: false,
      error: "Self-test timed out after 0 s",
    });
  });

  it("caches in memory and on disk; scripted is always ok; missing claude fails", async () => {
    let runs = 0;
    const cacheFile = join(dir, "selftest.json");
    const run = async () => (runs++, { ok: true, ms: 5, at: new Date().toISOString() });
    const a = new SelfTestCache({ brain: "claude", claudePath: "C:\\claude.exe", cacheFile, run });
    await a.get();
    await a.get();
    expect(runs).toBe(1);
    const b = new SelfTestCache({ brain: "claude", claudePath: "C:\\claude.exe", cacheFile, run });
    expect(b.cached?.ok).toBe(true);
    await b.get();
    expect(runs).toBe(1);
    await b.get(true);
    expect(runs).toBe(2);
    // a different claude path does not reuse the cache
    expect(new SelfTestCache({ brain: "claude", claudePath: "D:\\other.exe", cacheFile, run }).cached).toBeUndefined();
    expect((await new SelfTestCache({ brain: "scripted", claudePath: null, cacheFile }).get()).ok).toBe(true);
    expect(await new SelfTestCache({ brain: "claude", claudePath: null, cacheFile: null }).get()).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
  });
});

describe("Claude Code executable", () => {
  it("resolves claude from the override, then PATH (.exe only on Windows), then ~/.local/bin", () => {
    expect(resolveClaudePath({ NOA_CLAUDE_PATH: "D:\\c.exe" })).toBe("D:\\c.exe");
    const exe = process.platform === "win32" ? "C:\\bin\\claude.exe" : "/bin/claude";
    expect(resolveClaudePath({}, { where: () => `C:\\bin\\claude\r\n${exe}\r\n`, exists: (p) => p === exe })).toBe(exe);
    const fallback = join("C:\\Users\\me", ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    expect(
      resolveClaudePath({ USERPROFILE: "C:\\Users\\me" }, { where: () => { throw new Error("none"); }, exists: (p) => p === fallback }),
    ).toBe(fallback);
    expect(resolveClaudePath({ USERPROFILE: "C:\\x" }, { where: () => "", exists: () => false })).toBeNull();
  });

  it("strips nested-session variables from the child env", () => {
    const env = claudeEnv({ PATH: "p", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_CHILD_SESSION: "1", NOA_BRAIN: "scripted" });
    expect(env).toEqual({ PATH: "p", ...CLAUDE_RUN_ENV });
  });

  it("turns Claude Code's auto memory off: a smaller system prompt that is the same in every run folder (cacheable across sessions)", () => {
    expect(CLAUDE_RUN_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    // A parent's own value never turns it back on.
    expect(claudeEnv({ PATH: "p", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" }).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("never passes an API key or another endpoint to Claude Code: it runs on the user's own login", () => {
    const parent = { PATH: "p", ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://proxy", ANTHROPIC_MODEL: "m" };
    expect(claudeEnv(parent)).toEqual({ PATH: "p", ANTHROPIC_MODEL: "m", ...CLAUDE_RUN_ENV });
    expect(apiBillingVarsIn(parent)).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
    expect(apiBillingVarsIn({ PATH: "p" })).toEqual([]);
  });
});
