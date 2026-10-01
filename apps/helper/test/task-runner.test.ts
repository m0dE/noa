import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { EventEmitter, getEventListeners } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperErrorCode, TODO_TOOLS, type AgentEvent, type AgentTask, type RunConfig } from "@noa/shared";
import { agentError, classifyFailure, ENDED_WITHOUT_RESULT, EXITED_WITHOUT_RESULT, TASK_FAIL_RECHECK, type JevLike } from "@noa/core";
import { TaskRunner, type RunTaskParams, type TaskRunnerDeps } from "../src/task-runner.js";
import { ToolRouter } from "../src/tool-router.js";
import { AttachmentInbox } from "../src/session/attachments.js";
import { LiveLog } from "../src/logger.js";
import { INTERACTIVE_TASK_ID } from "../src/mcp-tools.js";
import { ScriptedBrain } from "../src/brains/scripted.js";
import type { Brain, BrainContext } from "../src/brains/brain.js";
import { WarmClaude, type WarmSpec } from "../src/brains/claude-code.js";
import { FakeX } from "./fake-x.js";
import { noSleep } from "../../../packages/core/test/helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8, isRetry: false };
const fakeJev: JevLike = { decide: async () => ({ operation: "blocked", index: null, confidence: 0 }) };

function params(over: Partial<AgentTask> = {}, rest: Partial<RunTaskParams> = {}): RunTaskParams {
  return {
    sessionId: "S1",
    task: { id: "T1", instructions: "Post: hello from Noa", account: null, ...over },
    mediaPaths: [],
    config: CONFIG,
    ...rest,
  };
}

function setup(x: FakeX, over: Partial<TaskRunnerDeps> & { brain?: (router: ToolRouter) => Brain } = {}) {
  let runner!: TaskRunner;
  const events: { sessionId: string; event: AgentEvent }[] = [];
  const router = new ToolRouter({ getSession: (id) => runner.session(id) });
  runner = new TaskRunner({
    runsDir: join(dir, "runs"),
    mcpServerPath: "C:\\helper\\dist\\mcp-server.js",
    pipePath: "\\\\.\\pipe\\noa-test",
    pipeToken: "test-token",
    browser: x.caller(),
    envJevKey: "env-key",
    makeJev: () => fakeJev,
    makeBrain: () => (over.brain ? over.brain(router) : new ScriptedBrain((t, n, a) => router.call(t, n, a), { sleep: noSleep })),
    notify: (sessionId, event) => events.push({ sessionId, event }),
    sleep: noSleep,
    ...over,
    inbox: over.inbox ?? new AttachmentInbox(join(dir, "incoming")),
  });
  return { runner, router, events };
}

/** A brain that runs `steps` then waits until aborted (or until its input closes, like Claude Code). */
function customBrain(steps: (ctx: BrainContext) => Promise<void>, hang: "abort" | "input" | false = false): Brain {
  return {
    run: async (ctx) => {
      await steps(ctx);
      if (hang === "abort") await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
      if (hang === "input") await new Promise<void>((r) => ctx.input.onClose(r));
    },
  };
}

describe("TaskRunner with ScriptedBrain", () => {
  it("posts, switching account and attaching media, completes with the post URL, and emits events", async () => {
    const x = new FakeX({ account: "alice" });
    const { runner, events } = setup(x);
    const media = "C:\\Downloads\\noa-media\\S1\\cat.png";
    const result = await runner.run(
      params({ account: "@bob", instructions: "Open https://x.com/compose/post and publish. Post: gm from bob" }, { mediaPaths: [media] }),
    );
    expect(result).toMatchObject({ outcome: "done", url: "https://x.com/bob/status/1000", summary: "Posted: gm from bob" });
    expect(x.posts).toEqual([{ account: "bob", text: "gm from bob", files: [media], url: "https://x.com/bob/status/1000" }]);
    expect(runner.busy).toBe(false);
    expect(existsSync(result.logPath!)).toBe(true);
    const logged = readFileSync(result.logPath!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(logged.some((e) => e.type === "tool_call" && e.name === "switch_x_account")).toBe(true);
    // helper.event notifications: tool events from the executor, then task_end
    expect(events.every((e) => e.sessionId === "S1")).toBe(true);
    expect(events.filter((e) => e.event.type === "tool_call").map((e) => (e.event as { name: string }).name)).toContain("upload");
    expect(events.at(-1)!.event).toEqual({ type: "task_end", outcome: "done", summary: "Posted: gm from bob", url: "https://x.com/bob/status/1000" });
    // Jev (the fake always refuses) left both picks to the brain, which chose from act's candidates; the count comes before task_end.
    expect(events.at(-2)!.event).toEqual({
      type: "status",
      text: "Jev chose 0 of 2 element picks (clicks and typing); Claude chose 2",
      picks: { jev: 0, claude: 2 },
    });
  });

  it("with Jev on: the MCP server describes the tools for Jev, and the router reports it", async () => {
    const x = new FakeX();
    let seen: BrainContext | undefined;
    const { runner, router } = setup(x, { brain: () => customBrain(async (ctx) => void (seen = ctx), "abort") });
    const done = runner.run(params());
    await vi.waitFor(() => expect(seen).toBeDefined());
    const cfg = JSON.parse(readFileSync(seen!.mcpConfigPath, "utf8"));
    expect(cfg.mcpServers.noa.env.NOA_JEV).toBe("1");
    expect(router.jev("S1")).toBe(true);
    expect(seen!.systemPrompt).toMatch(/Jev picks the element of every act step/);
    expect(seen!.systemPrompt).not.toMatch(/each naming the element index/);
    runner.abort("S1", "test over");
    await done;
  });

  it("writes the MCP config; act replaces click and type even when Jev is off", async () => {
    const x = new FakeX();
    let seen: BrainContext | undefined;
    const { runner } = setup(x, { brain: () => customBrain(async (ctx) => void (seen = ctx)) });
    await runner.run(params({}, { config: { ...CONFIG, jevEnabled: false } }));
    const cfg = JSON.parse(readFileSync(seen!.mcpConfigPath, "utf8"));
    expect(cfg).toEqual({
      mcpServers: {
        noa: {
          command: process.execPath,
          args: ["C:\\helper\\dist\\mcp-server.js"],
          env: { NOA_PIPE: "\\\\.\\pipe\\noa-test", NOA_PIPE_TOKEN: "test-token", NOA_TASK: "S1", NOA_TOOLS: expect.any(String), NOA_JEV: "0" },
        },
      },
    });
    const tools = cfg.mcpServers.noa.env.NOA_TOOLS.split(",");
    expect(tools).toContain("act");
    expect(tools).not.toContain("click");
    expect(tools).not.toContain("type");
    expect(seen!.allowedTools).toContain("mcp__noa__task_complete");
    expect(seen!.allowedTools).toContain("mcp__noa__act");
    expect(seen!.systemPrompt).toMatch(/each naming the element index/);
    expect(seen!.prompt).toContain("Post: hello from Noa");
  });

  it("uses Jev when enabled with a key from the config or the environment", async () => {
    const x = new FakeX();
    const seen: string[][] = [];
    const keys: string[] = [];
    const brain = () => customBrain(async (ctx) => void seen.push(ctx.allowedTools));
    const makeJev = (k: string) => (keys.push(k), fakeJev);
    await setup(x, { brain, makeJev }).runner.run(params());
    await setup(x, { brain, makeJev }).runner.run(params({}, { config: { ...CONFIG, jevApiKey: "cfg-key" } }));
    await setup(x, { brain, makeJev, envJevKey: null }).runner.run(params());
    for (const s of seen) expect(s).toContain("mcp__noa__act");
    // Only the runs with a key created a Jev client.
    expect(keys).toEqual(["env-key", "cfg-key"]);
  });

  it("offers generate_image unless image generation is turned off (config.imageGeneration)", async () => {
    const seen: string[][] = [];
    const brain = () => customBrain(async (ctx) => void seen.push(ctx.allowedTools));
    await setup(new FakeX(), { brain }).runner.run(params());
    await setup(new FakeX(), { brain }).runner.run(params({}, { config: { ...CONFIG, imageGeneration: false } }));
    expect(seen[0]).toContain("mcp__noa__generate_image");
    expect(seen[1]).not.toContain("mcp__noa__generate_image");
    expect(seen[1]).toContain("mcp__noa__upload");
  });

  it("passes the extension's model (config.model) to the brain, none when unset", async () => {
    const seen: (string | undefined)[] = [];
    const brain = () => customBrain(async (ctx) => void seen.push(ctx.model));
    await setup(new FakeX(), { brain }).runner.run(params({}, { config: { ...CONFIG, model: " claude-opus-5-5 " } }));
    await setup(new FakeX(), { brain }).runner.run(params());
    expect(seen).toEqual(["claude-opus-5-5", undefined]);
  });

  it("uses the retry prompt when isRetry", async () => {
    let seen: BrainContext | undefined;
    await setup(new FakeX(), { brain: () => customBrain(async (ctx) => void (seen = ctx)) }).runner.run(
      params({ account: "@bob" }, { config: { ...CONFIG, isRetry: true } }),
    );
    expect(seen!.prompt).toMatch(/this is a retry/);
    expect(seen!.prompt).toContain("https://x.com/bob");
  });

  it("pauses on a login page", async () => {
    const x = new FakeX({ url: "https://x.com/i/flow/login" });
    const r = await setup(x).runner.run(params());
    expect(r).toMatchObject({ outcome: "paused", reason: "X is asking to log in" });
  });

  it("pauses when the account cannot be switched to", async () => {
    const x = new FakeX({ accounts: ["alice"] });
    const r = await setup(x).runner.run(params({ account: "@zed" }));
    expect(r.outcome).toBe("paused");
    expect(r.reason).toMatch(/Could not switch to @zed/);
    expect(x.posts).toHaveLength(0);
  });

  it("runs several sessions at once, one turn per session; abort is keyed by sessionId", async () => {
    const { runner } = setup(new FakeX(), { brain: () => customBrain(async () => {}, "abort") });
    const first = runner.run(params());
    const second = runner.run(params({}, { sessionId: "S2" }));
    expect(runner.openSessions.sort()).toEqual(["S1", "S2"]);
    await expect(runner.run(params())).rejects.toMatchObject({ code: HelperErrorCode.busy });
    expect(runner.abort("S3", "wrong session")).toBe(false);
    runner.abort("S1", "test over");
    expect(await first).toMatchObject({ outcome: "failed", reason: "test over" });
    expect(runner.openSessions).toEqual(["S2"]);
    runner.abort("S2", "done too");
    expect(await second).toMatchObject({ outcome: "failed", reason: "done too" });
    expect(runner.busy).toBe(false);
  });

  it("each session's browser calls carry its session id, so the extension acts in that session's tab", async () => {
    const x = new FakeX({ account: "alice" });
    const seen: { method: string; sessionId?: string }[] = [];
    const inner = x.caller();
    const browser = { call: (method: any, p: any) => (seen.push({ method, sessionId: p?.sessionId }), inner.call(method, p)) } as typeof inner;
    const { runner } = setup(x, { browser });
    await Promise.all([runner.run(params()), runner.run(params({ instructions: "Post: from two" }, { sessionId: "S2" }))]);
    expect(seen.length).toBeGreaterThan(4);
    expect(new Set(seen.map((c) => c.sessionId))).toEqual(new Set(["S1", "S2"]));
  });

  it("single-turn brains end with their turn: continueSession says the session ended", async () => {
    const { runner } = setup(new FakeX());
    expect(await runner.run(params())).toMatchObject({ outcome: "done" });
    expect(runner.openSessions).toEqual([]);
    await expect(runner.continueSession({ sessionId: "S1", text: "again", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
  });

  it("task_complete's follow-up suggestion comes back with the result and its task_end; the system prompt asks for it", async () => {
    let prompt = "";
    const suggestion = "Reply to Jordan and say I'll sign by Thursday";
    const { runner, events } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          prompt = ctx.systemPrompt;
          await router.call(ctx.taskId, "task_complete", { summary: "Checked email", suggestion });
        }),
    });
    expect(await runner.run(params({ instructions: "check my email" }, { config: { ...CONFIG, jevEnabled: false } }))).toMatchObject({ outcome: "done", summary: "Checked email", suggestion });
    expect(events.at(-1)!.event).toEqual({ type: "task_end", outcome: "done", summary: "Checked email", suggestion });
    expect(prompt).toContain("give it as `suggestion`");
  });

  it("refuses the reserved interactive session id", async () => {
    await expect(setup(new FakeX()).runner.run(params({}, { sessionId: INTERACTIVE_TASK_ID }))).rejects.toThrow(/reserved/);
  });

  it("forcePause wins over a task_* result", async () => {
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          await router.call(ctx.taskId, "task_complete", { summary: "done" });
          setTimeout(() => runner.forcePause(ctx.taskId, "login page appeared"), 10);
        }, "abort"),
    });
    expect(await runner.run(params())).toMatchObject({ outcome: "paused", reason: "login page appeared" });
  });

  it("fails at the time limit", async () => {
    const { runner } = setup(new FakeX(), { brain: () => customBrain(async () => {}, "abort") });
    const r = await runner.run(params({}, { config: { ...CONFIG, maxTaskMinutes: 0.001 } }));
    expect(r).toMatchObject({ outcome: "failed", reason: "Task time limit of 0.001 minutes reached" });
  });

  it("fails when the agent exits without a result, or with the last Claude error", async () => {
    expect(await setup(new FakeX(), { brain: () => customBrain(async () => {}) }).runner.run(params())).toMatchObject({
      outcome: "failed",
      reason: EXITED_WITHOUT_RESULT,
    });
    const limited = customBrain(async (ctx) => ctx.emit({ type: "error", text: "Claude Code: Claude AI usage limit reached" }));
    expect(await setup(new FakeX(), { brain: () => limited }).runner.run(params())).toMatchObject({
      outcome: "failed",
      reason: "Claude Code: Claude AI usage limit reached",
    });
  });

  it("reports brain crashes", async () => {
    const { runner } = setup(new FakeX(), { brain: () => ({ run: async () => Promise.reject(new Error("spawn ENOENT")) }) });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: agentError("spawn ENOENT") });
  });

  it("closes the brain's input after a task_* call, then aborts after the grace period", async () => {
    let aborted = false;
    let inputClosed = false;
    const { runner } = setup(new FakeX(), {
      finishGraceMs: 30,
      brain: (router) =>
        customBrain(async (ctx) => {
          ctx.input.onClose(() => (inputClosed = true));
          // A Fast turn's first task_fail is answered with a recheck (core reasoning.ts); the second one ends it.
          await router.call(ctx.taskId, "task_fail", { reason: "cannot" });
          await router.call(ctx.taskId, "task_fail", { reason: "cannot" });
          ctx.signal.addEventListener("abort", () => (aborted = true));
        }, "abort"),
    });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: "cannot" });
    expect(inputClosed).toBe(true);
    expect(aborted).toBe(true);
  });

  it("reasoning: three failures of one tool raise the session's reasoning (the brain sees it, the Raw view gets a line); a step that works lowers it", async () => {
    const seen: { kind: string; thinking: boolean }[] = [];
    const { runner, events } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          ctx.reasoning!.onChange((c) => seen.push({ kind: c.kind, thinking: ctx.reasoning!.thinking }));
          expect(ctx.reasoning!.thinking).toBe(false);
          for (const tab of ["t91", "t92", "t93"]) await router.call(ctx.taskId, "switch_tab", { tab });
          await router.call(ctx.taskId, "navigate", { url: "https://x.com/home" });
          await router.call(ctx.taskId, "task_complete", { summary: "done" });
        }),
    });
    expect(await runner.run(params())).toMatchObject({ outcome: "done" });
    expect(seen).toEqual([
      { kind: "raise", thinking: true },
      { kind: "lower", thinking: false },
    ]);
    const lines = events.flatMap(({ event: e }) => (e.type === "trace" && e.trace.name.startsWith("reasoning.") ? [[e.trace.name, e.trace.data?.why, e.trace.src]] : []));
    expect(lines).toEqual([
      ["reasoning.raise", "switch_tab failed 3 times in a row", "helper"],
      ["reasoning.lower", "navigate worked", "helper"],
    ]);
  });

  it("reasoning: Thorough (from the run's config) thinks from the start and never raises or rechecks task_fail", async () => {
    let thinking: boolean | undefined;
    let failAnswer: string | undefined;
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          thinking = ctx.reasoning!.thinking;
          failAnswer = (await router.call(ctx.taskId, "task_fail", { reason: "cannot" })).text;
        }),
    });
    expect(await runner.run(params({}, { config: { ...CONFIG, reasoning: "thorough" } }))).toMatchObject({ outcome: "failed", reason: "cannot" });
    expect(thinking).toBe(true);
    expect(failAnswer).not.toBe(TASK_FAIL_RECHECK);
  });

  it("reasoning: a Fast turn's first task_fail gets one recheck (and a raise); never once the tool call limit is reached", async () => {
    const answers: (string | undefined)[] = [];
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          answers.push((await router.call(ctx.taskId, "task_fail", { reason: "cannot" })).text);
          answers.push((await router.call(ctx.taskId, "task_fail", { reason: "cannot" })).text);
        }),
    });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: "cannot" });
    expect(answers[0]).toBe(TASK_FAIL_RECHECK);
    expect(answers[1]).not.toBe(TASK_FAIL_RECHECK);

    let atLimit: string | undefined;
    const limited = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          for (let i = 0; i < 5; i++) await router.call(ctx.taskId, "read_page", {});
          atLimit = (await router.call(ctx.taskId, "task_fail", { reason: "out of steps" })).text;
        }),
    });
    expect(await limited.runner.run(params({}, { config: { ...CONFIG, maxToolCalls: 5 } }))).toMatchObject({ outcome: "failed", reason: "out of steps" });
    expect(atLimit).not.toBe(TASK_FAIL_RECHECK);
  });

  it("delivers user messages to the brain and emits user_message", async () => {
    const got: string[] = [];
    let router!: ToolRouter;
    const { runner, events } = setup(new FakeX(), {
      brain: (r) => {
        router = r;
        return customBrain(async (ctx) => {
          ctx.interjections.onAdd((t) => {
            got.push(t);
            // Like Claude Code: the message goes in as a message of its own, the model reads it, then finishes.
            ctx.interjections.seen(ctx.interjections.handOff("next_step")!);
            void router.call(ctx.taskId, "task_complete", { summary: `heard ${t}` });
          });
        }, "input");
      },
    });
    const run = runner.run(params());
    expect(runner.sendUserMessage("nope", "hi")).toBe(false);
    expect(runner.sendUserMessage("S1", "stop after this")).toBe(true);
    expect(await run).toMatchObject({ outcome: "done", summary: "heard stop after this" });
    expect(got).toEqual(["stop after this"]);
    expect(events.some((e) => e.event.type === "user_message")).toBe(true);
    expect(runner.sendUserMessage("S1", "too late")).toBe(false);
  });

  it("a mid-task 'no, use page B' redirects the turn: ending on page A before reading it is refused", async () => {
    const x = new FakeX({ url: "https://mail.test/u/0" });
    let router!: ToolRouter;
    const results: string[] = [];
    let messageSent!: () => void;
    const sent = new Promise<void>((r) => (messageSent = r));
    const { runner, events } = setup(x, {
      brain: (r) => {
        router = r;
        // Like the Claude Code brain: a message typed mid-turn goes to the agent as a message of its own,
        // which the model reads at its next step. This model had already written its answer about page A.
        return customBrain(async (ctx) => {
          let inbox: string | null = null;
          ctx.interjections.onAdd(() => (inbox = ctx.interjections.handOff("next_step")));
          const call = async (name: string, args: unknown = {}) => {
            const out = await router.call(ctx.taskId, name as never, args);
            results.push(out.text ?? "");
            return out;
          };
          await call("navigate", { url: "https://mail.test/u/0" });
          await call("read_page");
          await sent;
          const refused = await call("task_complete", { summary: "Summarised page A" });
          expect(refused.isError).toBe(true);
          // Its next step: it reads the message and follows it.
          expect(inbox).toContain("no, use page B");
          ctx.interjections.seen(inbox!);
          await call("navigate", { url: "https://mail.test/u/2" });
          await call("task_complete", { summary: "Summarised page B" });
        }, "input");
      },
    });
    const run = runner.run(params());
    await vi.waitFor(() => expect(results).toHaveLength(2));
    // The user speaks while the agent is on page A; the turn is not over, so the message is taken.
    expect(runner.sendUserMessage("S1", "no, use page B")).toBe(true);
    messageSent();
    expect(await run).toMatchObject({ outcome: "done", summary: "Summarised page B" });
    expect(results[2]).toBe("Not recorded: the user sent you a new message, so task_complete was not called. Read that message (it follows) and do what it asks before ending.");
    expect(x.url).toBe("https://mail.test/u/2");
    const mine = events.map((e) => e.event);
    expect(mine.filter((e) => e.type === "task_end")).toEqual([expect.objectContaining({ outcome: "done", summary: "Summarised page B" })]);
    expect(mine.filter((e) => e.type === "user_message")).toEqual([{ type: "user_message", text: "no, use page B" }]);
    const traced = mine.flatMap((e) => (e.type === "trace" && e.trace.name === "interjection" ? [e.trace] : []));
    expect(traced).toEqual([expect.objectContaining({ cat: "user", src: "helper", data: { route: "next_step", count: 1 } })]);
  });

  it("the scripted brain acknowledges user messages", async () => {
    const x = new FakeX();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading = false;
    const slow = { call: async (m: any, p: any) => (m === "browser.readPage" ? ((reading = true), await gate) : undefined, x.handle(m, p)) };
    const { runner, events } = setup(x, { browser: slow as any });
    const run = runner.run(params());
    // The brain is running (waiting for the page) when the message arrives.
    await vi.waitFor(() => expect(reading).toBe(true));
    expect(runner.sendUserMessage("S1", "hello brain")).toBe(true);
    release();
    await run;
    expect(events.some((e) => e.event.type === "assistant_text" && e.event.text === "Scripted brain received: hello brain")).toBe(true);
  });

  it("enforces the tool call limit: errors past the max, abort at max + 5", async () => {
    const texts: (string | undefined)[] = [];
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          for (let i = 0; i < 20 && !ctx.signal.aborted; i++) texts.push((await router.call(ctx.taskId, "read_page", {})).text);
        }),
    });
    const r = await runner.run(params({}, { config: { ...CONFIG, maxToolCalls: 3 } }));
    expect(texts.slice(0, 3).every((t) => t?.startsWith("URL:"))).toBe(true);
    expect(texts[3]).toBe("Tool call limit of 3 reached. Call task_fail now with a short reason.");
    expect(texts).toHaveLength(8);
    expect(r).toMatchObject({ outcome: "failed", reason: "Tool call limit exceeded (3 calls)" });
  });

  it("still accepts task_fail past the tool call limit", async () => {
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          for (let i = 0; i < 4; i++) await router.call(ctx.taskId, "read_page", {});
          await router.call(ctx.taskId, "task_fail", { reason: "too many steps" });
        }),
    });
    expect(await runner.run(params({}, { config: { ...CONFIG, maxToolCalls: 3 } }))).toMatchObject({ outcome: "failed", reason: "too many steps" });
  });

  it("saves screenshots beside the log", async () => {
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          await router.call(ctx.taskId, "screenshot", {});
          await router.call(ctx.taskId, "task_complete", { summary: "ok" });
        }),
    });
    const r = await runner.run(params());
    expect(readdirSync(join(r.logPath!, ".."))).toContain("screenshot-001.jpg");
  });
});

/**
 * Like headless Claude Code with stdin kept open: every message (the prompt,
 * then each follow-up) is answered with task_complete; it exits when its input
 * closes or it is aborted.
 */
function chatBrain(router: ToolRouter, opts: { ignoreClose?: boolean } = {}): Brain {
  return {
    persistent: true,
    run: async (ctx) => {
      const answer = (text: string) => void router.call(ctx.taskId, "task_complete", { summary: `did: ${text.slice(-40)}` });
      answer(ctx.task!.instructions);
      ctx.input.onMessage((text) => answer(text));
      await new Promise<void>((resolve) => {
        if (!opts.ignoreClose) ctx.input.onClose(resolve);
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

describe("TaskRunner: kept-open sessions (persistent brain)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function chatSetup(over: Partial<TaskRunnerDeps> = {}, brainOpts: { ignoreClose?: boolean } = {}) {
    const changes: string[][] = [];
    const t = setup(new FakeX(), { brain: (router) => chatBrain(router, brainOpts), onSessionsChanged: (open) => changes.push(open), ...over });
    return { ...t, changes };
  }

  it("stays open after task_*; continueSession runs the next turn in the same session", async () => {
    const { runner, events, changes } = chatSetup();
    expect(await runner.run(params())).toMatchObject({ outcome: "done", summary: "did: Post: hello from Noa" });
    expect(runner.openSessions).toEqual(["S1"]);
    expect(runner.busy).toBe(false);
    expect(changes).toEqual([["S1"]]);

    const next = await runner.continueSession({ sessionId: "S1", text: "now like it", config: CONFIG });
    expect(next).toMatchObject({ outcome: "done", summary: expect.stringContaining("now like it") });
    const mine = events.filter((e) => e.sessionId === "S1").map((e) => e.event);
    // The follow-up shows as the user's message, then its own task_end.
    const i = mine.findIndex((e) => e.type === "user_message");
    expect(mine[i]).toEqual({ type: "user_message", text: "now like it" });
    expect(mine.filter((e) => e.type === "task_end")).toHaveLength(2);
    expect(mine.slice(i).some((e) => e.type === "task_end")).toBe(true);
  });

  it("a follow-up whose model setting changed switches the open session's model before its message (the same model, or none, does not)", async () => {
    const seen: string[] = [];
    const { runner } = setup(new FakeX(), {
      brain: (router) => {
        const inner = chatBrain(router);
        return {
          persistent: true,
          run: (ctx) => {
            seen.push(`start ${ctx.model}`);
            ctx.onModelChange?.((m) => seen.push(`switch ${m}`));
            // The one input subscriber is the inner brain: see its messages as they reach it.
            const onMessage = ctx.input.onMessage.bind(ctx.input);
            ctx.input.onMessage = (fn) => onMessage((text) => (seen.push(`message ${text}`), fn(text)));
            return inner.run(ctx);
          },
        };
      },
    });
    await runner.run(params({}, { config: { ...CONFIG, model: "claude-sonnet-5" } }));
    for (const [text, model] of [["a", "claude-sonnet-5"], ["b", "claude-opus-5-5"], ["c", undefined], ["d", "claude-opus-5-5"]] as const)
      await runner.continueSession({ sessionId: "S1", text, config: { ...CONFIG, ...(model ? { model } : {}) } });
    expect(seen.map((s) => s.replace(/^message .*?(\w)$/, "message $1"))).toEqual([
      "start claude-sonnet-5",
      "message a",
      "switch claude-opus-5-5",
      "message b",
      "message c",
      "message d",
    ]);
  });

  /** A persistent brain that starts agents ahead (like Claude Code): each warm() is a stand-in process. */
  function warmSetup(over: Partial<TaskRunnerDeps> = {}) {
    const warmed: { spec: WarmSpec; warm: WarmClaude; exit: () => void }[] = [];
    const runs: BrainContext[] = [];
    const t = setup(new FakeX(), {
      ...over,
      brain: (router) => {
        const inner = chatBrain(router);
        return {
          persistent: true,
          warm: (spec) => {
            const child = Object.assign(new EventEmitter(), { exitCode: null, pid: undefined, stdin: null }) as unknown as ChildProcess;
            const warm = new WarmClaude([spec.model ?? "default", String(spec.thinking), spec.systemPrompt], child);
            warmed.push({ spec, warm, exit: () => child.emit("exit", 0) });
            return warm;
          },
          run: (ctx) => {
            runs.push(ctx);
            // Taken when started with the same settings, as ClaudeCodeBrain does.
            const taken = ctx.warm?.take([ctx.model ?? "default", String(ctx.reasoning?.thinking), ctx.systemPrompt]);
            if (!taken) ctx.warm?.stop();
            return inner.run(ctx);
          },
        };
      },
    });
    return { ...t, warmed, runs };
  }

  it("prewarm: the next new session takes the agent started ahead, with its run folder; its tool calls reach the session", async () => {
    const { runner, router, warmed, runs } = warmSetup();
    expect(runner.prewarm({ ...CONFIG, model: "claude-sonnet-5" })).toBe(true);
    // The same settings again keep it.
    expect(runner.prewarm({ ...CONFIG, model: "claude-sonnet-5" })).toBe(true);
    expect(warmed).toHaveLength(1);
    const { spec, warm } = warmed[0]!;
    expect(spec).toMatchObject({ model: "claude-sonnet-5", thinking: false });
    const mcp = JSON.parse(readFileSync(spec.mcpConfigPath, "utf8"));
    const toolTaskId = mcp.mcpServers.noa.env.NOA_TASK as string;
    expect(toolTaskId).toMatch(/^warm-/);

    const r = await runner.run(params({}, { config: { ...CONFIG, model: "claude-sonnet-5" } }));
    // The session's own task_complete went through the spare's task id.
    expect(r).toMatchObject({ outcome: "done", summary: "did: Post: hello from Noa" });
    expect(runs[0]!.warm).toBe(warm);
    expect(runs[0]!.taskId).toBe(toolTaskId);
    expect(runs[0]!.mcpConfigPath).toBe(spec.mcpConfigPath);
    expect(warm.ready).toBe(false);
    expect(r.logPath).toBe(join(spec.mcpConfigPath, "..", "log.jsonl"));
    // Its tools answer to the spare's task id only.
    expect(runner.session(toolTaskId)?.taskId).toBe(toolTaskId);
    expect((await router.call("S1", "read_page", {})).text).toMatch(/^No running task S1/);
    // Taken once: the next new session starts its own.
    await runner.run(params({}, { sessionId: "S2" }));
    expect(runs[1]!.warm).toBeUndefined();
    expect(runs[1]!.taskId).toBe("S2");
  });

  it("prewarm: other settings replace the spare; a session started with others does not take it; an unused one stops (time, shutdown, exit)", async () => {
    const { runner, warmed, runs } = warmSetup({ warmMs: 30 });
    runner.prewarm({ ...CONFIG, model: "claude-sonnet-5" });
    runner.prewarm({ ...CONFIG, model: "claude-opus-5-5" });
    expect(warmed.map((w) => [w.spec.model, w.warm.ready])).toEqual([
      ["claude-sonnet-5", false],
      ["claude-opus-5-5", true],
    ]);
    // Another model: offered, but the brain does not take it (stopped), and starts its own.
    await runner.run(params({}, { config: { ...CONFIG, model: "claude-sonnet-5" } }));
    expect(runs[0]!.warm).toBe(warmed[1]!.warm);
    expect(warmed[1]!.warm.ready).toBe(false);
    // Another Jev setting: its MCP config differs, so it is not offered at all.
    runner.prewarm({ ...CONFIG, jevEnabled: false });
    await runner.run(params({}, { sessionId: "S2" }));
    expect(runs[1]!.warm).toBeUndefined();
    expect(warmed[2]!.warm.ready).toBe(false);
    // Another image generation setting: its tools differ, so it is not offered either.
    runner.prewarm({ ...CONFIG, imageGeneration: false });
    await runner.run(params({}, { sessionId: "S3" }));
    expect(runs[2]!.warm).toBeUndefined();
    expect(warmed[3]!.warm.ready).toBe(false);
    // Unused: stopped after warmMs.
    runner.prewarm(CONFIG);
    await vi.waitFor(() => expect(warmed[4]!.warm.ready).toBe(false));
    // A spare whose process exited is replaced.
    runner.prewarm(CONFIG);
    warmed[5]!.exit();
    runner.prewarm(CONFIG);
    expect(warmed).toHaveLength(7);
    runner.shutdown("bye");
    expect(warmed[6]!.warm.ready).toBe(false);
  });

  it("prewarm: a brain that starts nothing ahead says so", () => {
    const { runner } = setup(new FakeX());
    expect(runner.prewarm(CONFIG)).toBe(false);
  });

  it("endSession closes it: continueSession then says 'session ended'", async () => {
    const { runner, changes } = chatSetup();
    await runner.run(params());
    expect(runner.endSession("S1")).toBe(true);
    await wait(10);
    expect(runner.openSessions).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    await expect(runner.continueSession({ sessionId: "S1", text: "again", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
    expect(runner.endSession("S1")).toBe(false);
  });

  it("an agent that ignores the close is killed after abortWaitMs", async () => {
    const { runner } = chatSetup({ abortWaitMs: 30 }, { ignoreClose: true });
    await runner.run(params());
    runner.endSession("S1");
    await wait(5);
    expect(runner.openSessions).toEqual(["S1"]);
    await wait(80);
    expect(runner.openSessions).toEqual([]);
  });

  it("closes an idle session after idleSessionMs", async () => {
    const { runner } = chatSetup({ idleSessionMs: 40 });
    await runner.run(params());
    expect(runner.openSessions).toEqual(["S1"]);
    await wait(120);
    expect(runner.openSessions).toEqual([]);
  });

  it("keeps at most maxSessions open: a new run closes the oldest idle one", async () => {
    const { runner } = chatSetup({ maxSessions: 2 });
    await runner.run(params({}, { sessionId: "A" }));
    await wait(2);
    await runner.run(params({}, { sessionId: "B" }));
    await runner.run(params({}, { sessionId: "C" }));
    await wait(10);
    expect(runner.openSessions.sort()).toEqual(["B", "C"]);
    await expect(runner.continueSession({ sessionId: "A", text: "x", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
  });

  it("a turn that goes idle without a task_* call fails as ended without a result, which is retried later", async () => {
    const idleBrain: Brain = {
      persistent: true,
      run: async (ctx) => {
        ctx.idle?.();
        await new Promise<void>((r) => ctx.input.onClose(r));
      },
    };
    const { runner } = setup(new FakeX(), { brain: () => idleBrain });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: ENDED_WITHOUT_RESULT });
    expect(classifyFailure(ENDED_WITHOUT_RESULT)).toBe("transient");
    runner.endSession("S1");
  });

  it("an aborted turn ends the session", async () => {
    const { runner } = setup(new FakeX(), { brain: () => ({ persistent: true, run: (ctx) => new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true })) }) });
    const run = runner.run(params());
    await wait(5);
    runner.forcePause("S1", "stopped by user");
    expect(await run).toEqual(expect.objectContaining({ outcome: "paused", reason: "stopped by user" }));
    expect(runner.openSessions).toEqual([]);
    await expect(runner.continueSession({ sessionId: "S1", text: "go on", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
  });
});

describe("TaskRunner: secrets, closing sessions, long-lived sessions", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a password from get_credential reaches the agent but not the run log, live.log or the extension's events", async () => {
    const x = new FakeX({ credentials: { "example.com": { username: "u", password: "s3cret-pw" } } });
    const live = new LiveLog(join(dir, "logs"));
    let got = "";
    const brain = (router: ToolRouter) =>
      customBrain(async (ctx) => {
        got = (await router.call(ctx.taskId, "get_credential", { site: "example.com" })).text ?? "";
        // What Claude Code echoes on stdout (logged raw), what it says, and what it types.
        ctx.log({ type: "claude", event: { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: got }] }] } } });
        ctx.emit({ type: "assistant_text", text: "Signed in with s3cret-pw" });
        await router.call(ctx.taskId, "paste", { text: "s3cret-pw" });
        await router.call(ctx.taskId, "task_complete", { summary: "signed in" });
      });
    const { runner, events } = setup(x, { brain, live });
    const result = await runner.run(params());
    expect(result.outcome).toBe("done");
    expect(got).toContain("password: s3cret-pw");
    expect(readFileSync(result.logPath!, "utf8")).not.toContain("s3cret-pw");
    expect(readFileSync(live.path, "utf8")).not.toContain("s3cret-pw");
    expect(JSON.stringify(events)).not.toContain("s3cret-pw");
    expect(events.some((e) => e.event.type === "assistant_text" && e.event.text === "Signed in with [redacted]")).toBe(true);
  });

  it("shutdown also stops sessions that were closed to make room or replaced, and waits for them", async () => {
    const contexts: BrainContext[] = [];
    const brain = (router: ToolRouter): Brain => {
      const inner = chatBrain(router, { ignoreClose: true });
      return { persistent: true, run: (ctx) => (contexts.push(ctx), inner.run(ctx)) };
    };
    const { runner } = setup(new FakeX(), { brain, maxSessions: 1, abortWaitMs: 60_000 });
    await runner.run(params({}, { sessionId: "A" }));
    await runner.run(params({}, { sessionId: "B" })); // A is closed to make room, but its agent ignores the close
    await runner.run(params({}, { sessionId: "B" })); // B is replaced the same way
    expect(runner.openSessions).toEqual(["B"]);
    expect(contexts).toHaveLength(3);
    expect(contexts.some((c) => c.signal.aborted)).toBe(false);

    let allClosed = false;
    void runner.whenAllClosed().then(() => (allClosed = true));
    await wait(10);
    expect(allClosed).toBe(false);
    runner.shutdown("helper shutting down");
    await runner.whenAllClosed();
    expect(contexts.every((c) => c.signal.aborted)).toBe(true);
  });

  it("a kept-open session's turns do not pile up abort listeners", async () => {
    let signal!: AbortSignal;
    const brain = (router: ToolRouter): Brain => {
      const inner = chatBrain(router);
      return { persistent: true, run: (ctx) => ((signal = ctx.signal), inner.run(ctx)) };
    };
    const { runner } = setup(new FakeX(), { brain });
    await runner.run(params());
    const before = getEventListeners(signal, "abort").length;
    for (let i = 0; i < 12; i++) expect((await runner.continueSession({ sessionId: "S1", text: `turn ${i}`, config: CONFIG })).outcome).toBe("done");
    expect(getEventListeners(signal, "abort").length).toBe(before);
    runner.endSession("S1");
  });
});

describe("TaskRunner: memory tools", () => {
  it("offers remember / recall / forget to Claude Code and sends them to the extension with the session's id", async () => {
    const x = new FakeX();
    const asked: unknown[] = [];
    let seen: BrainContext | undefined;
    const args = { kind: "account", subject: "Work email", text: "admin@runhq.io is Google /u/2" };
    const { runner } = setup(x, {
      memory: async (sessionId, tool, a) => {
        asked.push([sessionId, tool, a]);
        return { text: "Remembered [m1] Work email." };
      },
      brain: (r) =>
        customBrain(async (ctx) => {
          seen = ctx;
          const res = await r.call("S1", "remember", args);
          await r.call("S1", "task_complete", { summary: res.isError ? `error: ${res.text}` : res.text ?? "", memory_note: "Checked the work inbox." });
        }),
    });
    const result = await runner.run(params());
    expect(asked).toEqual([["S1", "remember", args]]);
    expect(result).toMatchObject({ outcome: "done", summary: "Remembered [m1] Work email.", memoryNote: "Checked the work inbox." });
    expect(seen!.allowedTools).toEqual(expect.arrayContaining(["mcp__noa__remember", "mcp__noa__recall", "mcp__noa__forget"]));
    expect(seen!.systemPrompt).toMatch(/Memory: /);
  });
});

describe("TaskRunner: the TODO tools", () => {
  it("offers them to Claude Code and sends each to the extension with the session's id; its answer is the tool result", async () => {
    const x = new FakeX();
    const asked: unknown[] = [];
    let seen: BrainContext | undefined;
    const args = { task: "Open https://shop.example.com/orders/48213 and tell me whether it shipped.", schedule: { at: "2026-09-26T22:45:00-04:00" } };
    const results: string[] = [];
    const { runner } = setup(x, {
      todo: async (sessionId, tool, a) => {
        asked.push([sessionId, tool, a]);
        return tool === "cancel_scheduled_task" ? { text: "Not done: the user did not approve this action.", isError: true } : { text: `${tool} ok` };
      },
      brain: (r) =>
        customBrain(async (ctx) => {
          seen = ctx;
          for (const [tool, a] of [["schedule_task", args], ["list_scheduled_tasks", {}], ["update_scheduled_task", { task_id: "t9", task: "Open the link" }], ["cancel_scheduled_task", { task_id: "t9" }]] as const) {
            const res = await r.call("S1", tool, a);
            results.push(`${res.isError ? "error" : "ok"}: ${res.text}`);
          }
          await r.call("S1", "task_complete", { summary: "done" });
        }),
    });
    const result = await runner.run(params());
    expect(asked).toEqual([
      ["S1", "schedule_task", args],
      ["S1", "list_scheduled_tasks", {}],
      ["S1", "update_scheduled_task", { task_id: "t9", task: "Open the link" }],
      ["S1", "cancel_scheduled_task", { task_id: "t9" }],
    ]);
    expect(results).toEqual(["ok: schedule_task ok", "ok: list_scheduled_tasks ok", "ok: update_scheduled_task ok", "error: Not done: the user did not approve this action."]);
    expect(result).toMatchObject({ outcome: "done", summary: "done" });
    for (const tool of TODO_TOOLS) expect(seen!.allowedTools).toContain(`mcp__noa__${tool}`);
    expect(seen!.systemPrompt).toMatch(/Scheduling: when the user asks/);
  });
});

describe("TaskRunner: attachments", () => {
  const photo = { ref: { id: "a1", name: "cat.png", type: "image/png", size: 4, kind: "image" as const, width: 2, height: 2 }, fresh: true };
  const notes = { ref: { id: "a2", name: "notes.txt", type: "text/plain", size: 5, kind: "text" as const }, fresh: true, text: "hello" };

  /** A kept-open brain that records the prompt and each follow-up, and answers each with task_complete. */
  function recordingBrain(router: ToolRouter, seen: { ctx?: BrainContext; messages: string[]; results?: string[] }, followUp?: (taskId: string) => Promise<string>): Brain {
    return {
      persistent: true,
      run: async (ctx) => {
        seen.ctx = ctx;
        void router.call(ctx.taskId, "task_complete", { summary: "first" });
        ctx.input.onMessage((text) => {
          seen.messages.push(text);
          void (async () => {
            if (followUp) (seen.results ??= []).push(await followUp(ctx.taskId));
            await router.call(ctx.taskId, "task_complete", { summary: "next" });
          })();
        });
        await new Promise<void>((resolve) => ctx.input.onClose(resolve));
      },
    };
  }

  it("moves sent files into the run folder's attachments folder, where Claude Code runs and may Read them", async () => {
    const seen: { ctx?: BrainContext; messages: string[] } = { messages: [] };
    const inbox = new AttachmentInbox(join(dir, "incoming"));
    const { runner } = setup(new FakeX(), { inbox, brain: (router) => recordingBrain(router, seen) });
    // Two pieces, in order.
    expect(inbox.put({ sessionId: "S1", id: "a1", offset: 0, dataBase64: Buffer.from("PN").toString("base64") })).toEqual({ size: 2 });
    expect(inbox.put({ sessionId: "S1", id: "a1", offset: 2, dataBase64: Buffer.from("G!").toString("base64") })).toEqual({ size: 4 });
    inbox.put({ sessionId: "S1", id: "a2", offset: 0, dataBase64: Buffer.from("hello").toString("base64") });
    await runner.run(params({ instructions: "What is in the picture?" }, { attachments: [photo, notes] }));
    const ctx = seen.ctx!;
    const readDir = join(join(ctx.mcpConfigPath, ".."), "attachments");
    expect(ctx.readDir).toBe(readDir);
    expect(readFileSync(join(readDir, "cat.png"), "utf8")).toBe("PNG!");
    expect(ctx.prompt).toContain(`1. cat.png (image, 2x2): to look at it, Read ${join(readDir, "cat.png")}`);
    expect(ctx.prompt).toContain("2. notes.txt (text file, 5 B), its text:\n<<<\nhello\n>>>");
    expect(ctx.systemPrompt).toMatch(/no file access except Read on the files the user attached/);
    // The scripted brain uploads what the task has: its files are among them.
    expect(ctx.task!.mediaPaths).toEqual([join(readDir, "cat.png"), join(readDir, "notes.txt")]);
    // Nothing is left waiting.
    expect(existsSync(join(dir, "incoming", "S1", "a1"))).toBe(false);
    runner.endSession("S1");
  });

  it("a follow-up's files are placed beside the earlier ones; upload may attach them, and the message lists them", async () => {
    const seen: { ctx?: BrainContext; messages: string[]; results?: string[] } = { messages: [] };
    const inbox = new AttachmentInbox(join(dir, "incoming"));
    const x = new FakeX({ url: "https://x.com/compose/post" });
    // The follow-up's turn uploads the new file.
    const upload = async (taskId: string) => {
      await router.call(taskId, "read_page", {});
      const r = await router.call(taskId, "upload", { index: 3, paths: [join(seen.ctx!.readDir!, "cat-2.png")] });
      return r.text ?? "";
    };
    const { runner, router } = setup(x, { inbox, brain: (r) => recordingBrain(r, seen, upload) });
    inbox.put({ sessionId: "S1", id: "a1", offset: 0, dataBase64: Buffer.from("one").toString("base64") });
    await runner.run(params({}, { attachments: [photo] }));
    inbox.put({ sessionId: "S1", id: "a3", offset: 0, dataBase64: Buffer.from("two").toString("base64") });
    const second = { ref: { ...photo.ref, id: "a3" }, fresh: true };
    await runner.continueSession({ sessionId: "S1", text: "and this one", config: CONFIG, attachments: [{ ...photo, fresh: false }, second] });
    const readDir = seen.ctx!.readDir!;
    // Same name: made unique.
    expect(readFileSync(join(readDir, "cat-2.png"), "utf8")).toBe("two");
    expect(seen.messages[0]).toMatch(/and this one\n\nFiles the user attached to this message \(1\):\n1\. cat\.png \(image, 2x2\): to look at it, Read .*cat-2\.png/);
    expect(seen.messages[0]).toMatch(/Files the user attached earlier in this conversation \(1\):\n2\. cat\.png .*Read .*cat\.png/);
    // upload took the new file (the session's tools allow it from that turn on).
    expect(seen.results).toEqual(["Attached 1 file(s) to [3]."]);
    expect(x.files).toEqual([join(readDir, "cat-2.png")]);
    runner.endSession("S1");
  });

  it("refuses pieces out of order, too large, or with ids that are not plain names", () => {
    const inbox = new AttachmentInbox(join(dir, "incoming"));
    expect(() => inbox.put({ sessionId: "S1", id: "a1", offset: 5, dataBase64: "AAAA" })).toThrow(/expected the piece at 0, got 5/);
    expect(() => inbox.put({ sessionId: "S1", id: "../evil", offset: 0, dataBase64: "AAAA" })).toThrow(/invalid attachment id/);
    expect(() => inbox.put({ sessionId: "..", id: "a1", offset: 0, dataBase64: "AAAA" })).toThrow(/invalid session id/);
    const big = Buffer.alloc(600 * 1024).toString("base64");
    expect(() => inbox.put({ sessionId: "S1", id: "a1", offset: 0, dataBase64: big })).toThrow(/a piece can be at most/);
  });

  it("an attachment that never arrived is listed without a path (the model is told it cannot open it)", async () => {
    const seen: { ctx?: BrainContext; messages: string[] } = { messages: [] };
    const { runner } = setup(new FakeX(), { brain: (router) => recordingBrain(router, seen) });
    await runner.run(params({}, { attachments: [photo] }));
    expect(seen.ctx!.prompt).toContain("1. cat.png (image, 2x2): you cannot open this kind of file; you can upload it.");
    runner.endSession("S1");
  });
});
