/**
 * Spawns dist/host.js as Chrome would and speaks native messaging to it,
 * answering the browser.* calls from a fake X page. Proves the host end to
 * end without Chrome or a model (NOA_BRAIN=scripted).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperErrorCode, type AgentEvent, type BrowserMethod, type RunConfig, type TaskRunResult } from "@noa/shared";
import { ENV } from "../src/env-names.js";
import helperPackage from "../package.json" with { type: "json" };
import { FakeX } from "./fake-x.js";
import { startHost, type HostProcess } from "./support/host-process.js";

let home: string;
let host: HostProcess;
let x: FakeX;
/** While set, browser.readPage waits for it (to inject a user message mid-task). */
let gate: Promise<void> | null = null;
let lastResult: TaskRunResult | null = null;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "bt-host-"));
  x = new FakeX({ account: "alice" });
  host = startHost({
    env: { ...process.env, [ENV.brain]: "scripted", [ENV.home]: home, [ENV.typesafeApiKey]: "", ANTHROPIC_API_KEY: "sk-ant-host-test" },
    browser: async (m: BrowserMethod, p) => {
      if (m === "browser.readPage" && gate) await gate;
      return x.handle(m, p as never);
    },
  });
});

afterAll(() => {
  if (host.child.exitCode === null) host.child.kill();
  rmSync(home, { recursive: true, force: true });
});

const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 2, jevEnabled: true, jevThreshold: 0.8, isRetry: false };

describe("dist/host.js over native messaging", () => {
  it("answers helper.hello with self-test info, and writes helper.json", async () => {
    const { ext, child } = host;
    const info = await ext.call("helper.hello", {}, { timeoutMs: 10_000 });
    expect(info).toEqual({
      version: helperPackage.version,
      jevAvailable: false,
      brain: "scripted",
      claudePath: null,
      logDir: join(home, "logs"),
      openSessions: [],
      selfTest: { ok: true, ms: 0, at: expect.any(String) },
    });
    const again = await ext.call("helper.hello", { selfTest: true }, { timeoutMs: 10_000 });
    expect(again.selfTest?.ok).toBe(true);
    const file = JSON.parse(readFileSync(join(home, "helper.json"), "utf8"));
    // The pipe's token: random per helper start (hex of 32 bytes).
    expect(file).toEqual({ pipe: expect.stringContaining("noa-"), token: expect.stringMatching(/^[0-9a-f]{64}$/), pid: child.pid, startedAt: expect.any(String) });
  });

  it("runs a task with media; events arrive as notifications; a user message reaches the brain", async () => {
    const { ext, events } = host;
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const media = join(home, "cat.png");
    const run = ext.call(
      "helper.runTask",
      {
        sessionId: "S-HOST",
        task: { id: "T-HOST", instructions: "Post: hello from the host test", account: null },
        mediaPaths: [media],
        config: CONFIG,
      },
      { timeoutMs: 60_000 },
    );
    await vi.waitFor(() => expect(events.some((e) => e.event.type === "tool_call")).toBe(true), { timeout: 10_000 });
    expect(await ext.call("helper.sendUserMessage", { sessionId: "S-HOST", text: "please hurry" }, { timeoutMs: 5000 })).toEqual({ ok: true });
    expect(await ext.call("helper.sendUserMessage", { sessionId: "nope", text: "x" }, { timeoutMs: 5000 })).toEqual({ ok: false });
    gate = null;
    open();
    const result = await run;
    lastResult = result;
    expect(result).toMatchObject({ outcome: "done", url: "https://x.com/alice/status/1000", summary: "Posted: hello from the host test" });
    expect(result.logPath).toContain(join(home, "runs", "S-HOST-"));
    expect(x.posts).toEqual([{ account: "alice", text: "hello from the host test", files: [media], url: "https://x.com/alice/status/1000" }]);

    const mine = events.filter((e) => e.sessionId === "S-HOST").map((e) => e.event);
    const types = mine.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(mine).toContainEqual({ type: "user_message", text: "please hurry" });
    expect(mine).toContainEqual({ type: "assistant_text", text: "Scripted brain received: please hurry" });
    expect(mine.at(-1)).toEqual({ type: "task_end", outcome: "done", summary: "Posted: hello from the host test", url: "https://x.com/alice/status/1000" } satisfies AgentEvent);
    expect(mine.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name)).toContain("upload");
  });

  it("continueSession on a session that is not kept open rejects with code session_ended; endSession of an unknown one is ok: false", async () => {
    const { ext } = host;
    await expect(ext.call("helper.continueSession", { sessionId: "S-HOST", text: "again", config: CONFIG }, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: HelperErrorCode.sessionEnded,
    });
    expect(await ext.call("helper.endSession", { sessionId: "S-HOST" }, { timeoutMs: 5000 })).toEqual({ ok: false });
  });

  it("forcePause/abortTask for an unknown session are harmless", async () => {
    const { ext } = host;
    expect(await ext.call("helper.forcePause", { sessionId: "nope", reason: "r" }, { timeoutMs: 5000 })).toEqual({ ok: true });
    expect(await ext.call("helper.abortTask", { sessionId: "nope", reason: "r" }, { timeoutMs: 5000 })).toEqual({ ok: true });
  });

  it("serves a session's run log, and nothing outside the runs folder", async () => {
    const { ext } = host;
    const path = lastResult!.logPath!;
    const log = await ext.call("helper.runLog", { path }, { timeoutMs: 5000 });
    expect(log.truncated).toBe(false);
    const lines = log.text.trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(lines[0]).toMatchObject({ type: "task_start" });
    expect(lines.map((l) => l.type)).toContain("task_result");
    const tail = await ext.call("helper.runLog", { path, maxBytes: 200 }, { timeoutMs: 5000 });
    expect(tail.truncated).toBe(true);
    expect(tail.text.length).toBeLessThanOrEqual(200);
    await expect(ext.call("helper.runLog", { path: join(home, "helper.json") }, { timeoutMs: 5000 })).rejects.toThrow(/not a Noa run log/);
    await expect(ext.call("helper.runLog", { path: join(home, "runs", "..", "selftest.json") }, { timeoutMs: 5000 })).rejects.toThrow(/not a Noa run log/);
  });

  it("returns the live log tail", async () => {
    const { text } = await host.ext.call("helper.getLog", { lines: 300 }, { timeoutMs: 5000 });
    expect(text).toContain("runTask S-HOST -> done");
    expect(text).toContain("S-HOST tool_call");
    // One notice that the API key is not passed on (and never the key itself).
    expect(text.match(/not passing ANTHROPIC_API_KEY to Claude Code/g)).toHaveLength(1);
    expect(text).not.toContain("sk-ant-host-test");
  });

  it("never writes anything but frames to stdout, and exits (removing helper.json) when stdin closes", async () => {
    const { child } = host;
    expect(host.decodeErrors).toEqual([]);
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(host.stderr()).toBe("");
    expect(existsSync(join(home, "helper.json"))).toBe(false);
  });
});
