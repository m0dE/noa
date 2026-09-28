import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES, DEFAULT_SETTINGS, HelperErrorCode, RpcError, type AgentEvent, type HelperNotifications, type TaskRunResult } from "@noa/shared";
import type { AgentSession, ApiAgentOptions } from "@noa/core";
import { ApiBrain } from "../src/engine/api-brain.js";
import { SessionEndedError, type BrainContinueOptions, type BrainStartOptions } from "../src/engine/brains.js";
import { ClaudeCodeBrain, type HelperLike } from "../src/engine/claude-code-brain.js";

function opts(events: AgentEvent[], extra: Partial<BrainStartOptions> = {}): BrainStartOptions {
  return {
    sessionId: "s1",
    task: { id: "t1", instructions: "do it", account: null },
    mediaPaths: ["C:\\a.png"],
    config: { maxToolCalls: 10, maxTaskMinutes: 5, jevEnabled: true, jevThreshold: 0.8, isRetry: false },
    settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "sk", jevApiKey: "jk" },
    onEvent: (e) => events.push(e),
    ...extra,
  };
}

function fakeHelper() {
  const calls: { method: string; params: any }[] = [];
  const notif = new Map<string, Set<(p: any) => void>>();
  const disc = new Set<(r: string) => void>();
  const info = new Set<(i: any) => void>();
  let finish!: (r: TaskRunResult) => void;
  let fail!: (e: Error) => void;
  const helper: HelperLike = {
    call: ((method: string, params: any) => {
      calls.push({ method, params });
      if (method === "helper.runTask" || method === "helper.continueSession") return new Promise((res, rej) => ((finish = res), (fail = rej)));
      if (method === "helper.sendUserMessage") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    }) as HelperLike["call"],
    onNotification: ((m: string, fn: (p: any) => void) => {
      if (!notif.has(m)) notif.set(m, new Set());
      notif.get(m)!.add(fn);
      return () => notif.get(m)!.delete(fn);
    }) as HelperLike["onNotification"],
    onDisconnect: (fn) => {
      disc.add(fn);
      return () => disc.delete(fn);
    },
    onInfo: (fn) => {
      info.add(fn);
      return () => info.delete(fn);
    },
  };
  return {
    helper,
    calls,
    finish: (r: TaskRunResult) => finish(r),
    fail: (e: Error) => fail(e),
    notify: <N extends keyof HelperNotifications>(m: N, p: HelperNotifications[N]) => notif.get(m)?.forEach((fn) => fn(p)),
    disconnect: (r: string) => disc.forEach((fn) => fn(r)),
    hello: (openSessions: string[]) => info.forEach((fn) => fn({ version: "2", jevAvailable: false, claudePath: "c", logDir: "l", openSessions })),
    listenerCount: () => [...notif.values()].reduce((n, s) => n + s.size, 0) + disc.size,
  };
}

describe("ClaudeCodeBrain", () => {
  it("runs helper.runTask with sessionId and media paths, forwards only its session's events", async () => {
    const f = fakeHelper();
    const events: AgentEvent[] = [];
    const brain = new ClaudeCodeBrain(f.helper);
    const base = f.listenerCount();
    const run = brain.start(opts(events));
    expect(f.calls[0]).toEqual({
      method: "helper.runTask",
      params: { sessionId: "s1", task: { id: "t1", instructions: "do it", account: null }, mediaPaths: ["C:\\a.png"], config: expect.objectContaining({ isRetry: false }) },
    });
    f.notify("helper.event", { sessionId: "s1", event: { type: "status", text: "mine" } });
    f.notify("helper.event", { sessionId: "other", event: { type: "status", text: "not mine" } });
    expect(events).toEqual([{ type: "status", text: "mine" }]);

    expect(await run.sendUserMessage("hi")).toBe(true);
    expect(f.calls[1]).toEqual({ method: "helper.sendUserMessage", params: { sessionId: "s1", text: "hi" } });
    run.abort("login page", "paused");
    run.abort("stuck", "failed");
    expect(f.calls.slice(2)).toEqual([
      { method: "helper.forcePause", params: { sessionId: "s1", reason: "login page" } },
      { method: "helper.abortTask", params: { sessionId: "s1", reason: "stuck" } },
    ]);
    f.finish({ outcome: "done", summary: "ok" });
    expect(await run.done).toEqual({ outcome: "done", summary: "ok" });
    expect(f.listenerCount()).toBe(base);
  });

  it("hands over a session's timings that arrive after its turn ended (the call that wrote task_complete ends after the tool ran)", async () => {
    const f = fakeHelper();
    const late: [string, unknown][] = [];
    const brain = new ClaudeCodeBrain(f.helper, { onLateTrace: (sessionId, trace) => late.push([sessionId, trace]) });
    const events: AgentEvent[] = [];
    const run = brain.start(opts(events));
    const call = { t: 1, ms: 9400, cat: "model", name: "model.call", src: "helper" } as const;
    // While the run listens, its traces are its events.
    f.notify("helper.event", { sessionId: "s1", event: { type: "trace", trace: call } });
    expect(events).toHaveLength(1);
    expect(late).toEqual([]);
    f.finish({ outcome: "done", summary: "ok" });
    await run.done;
    f.notify("helper.event", { sessionId: "s1", event: { type: "trace", trace: call } });
    f.notify("helper.event", { sessionId: "s1", event: { type: "assistant_text", text: "after the turn" } });
    expect(late).toEqual([["s1", call]]);
    expect(events).toHaveLength(1);
  });

  it("prewarm asks the helper to start the next session's agent with the run config", () => {
    const f = fakeHelper();
    const config = opts([]).config;
    new ClaudeCodeBrain(f.helper).prewarm(config);
    expect(f.calls).toEqual([{ method: "helper.prewarm", params: { config } }]);
  });

  it("a helper disconnect ends the run as retry", async () => {
    const f = fakeHelper();
    const run = new ClaudeCodeBrain(f.helper).start(opts([]));
    f.disconnect("Native host has exited.");
    expect(await run.done).toEqual({ outcome: "retry", reason: "helper disconnected: Native host has exited." });
  });

  it("a runTask error ends the run as retry", async () => {
    const f = fakeHelper();
    const run = new ClaudeCodeBrain(f.helper).start(opts([]));
    f.fail(new Error("boom"));
    expect(await run.done).toEqual({ outcome: "retry", reason: "helper error: boom" });
  });
});

function contOpts(events: AgentEvent[], extra: Partial<BrainContinueOptions> = {}): BrainContinueOptions {
  return {
    sessionId: "s1",
    text: "now like it",
    config: { maxToolCalls: 7, maxTaskMinutes: 5, jevEnabled: true, jevThreshold: 0.8, isRetry: false },
    settings: { ...DEFAULT_SETTINGS },
    onEvent: (e) => events.push(e),
    ...extra,
  };
}

describe("ClaudeCodeBrain: conversations", () => {
  it("tracks the helper's open sessions (hello, helper.sessions, disconnect)", () => {
    const f = fakeHelper();
    const changed = vi.fn();
    const brain = new ClaudeCodeBrain(f.helper, { onSessionsChanged: changed });
    f.hello(["a"]);
    expect(brain.openSessions()).toEqual(["a"]);
    f.notify("helper.sessions", { open: ["a", "b"] });
    expect(brain.isOpen("b")).toBe(true);
    f.notify("helper.sessions", { open: ["a", "b"] });
    expect(changed).toHaveBeenCalledTimes(2);
    f.disconnect("gone");
    expect(brain.openSessions()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("continue: helper.continueSession in the open session, its events, its result", async () => {
    const f = fakeHelper();
    const brain = new ClaudeCodeBrain(f.helper);
    f.notify("helper.sessions", { open: ["s1"] });
    const events: AgentEvent[] = [];
    const run = brain.continue(contOpts(events));
    expect(f.calls[0]).toEqual({ method: "helper.continueSession", params: { sessionId: "s1", text: "now like it", config: expect.objectContaining({ maxToolCalls: 7 }) } });
    f.notify("helper.event", { sessionId: "s1", event: { type: "assistant_text", text: "liking" } });
    f.finish({ outcome: "done", summary: "liked" });
    expect(await run.done).toEqual({ outcome: "done", summary: "liked" });
    expect(events).toEqual([{ type: "assistant_text", text: "liking" }]);
  });

  it("continue fails with SessionEndedError when the session is gone (known, or said by the helper)", async () => {
    const f = fakeHelper();
    const brain = new ClaudeCodeBrain(f.helper);
    await expect(brain.continue(contOpts([])).done).rejects.toBeInstanceOf(SessionEndedError);
    expect(f.calls).toEqual([]);
    f.notify("helper.sessions", { open: ["s1"] });
    const run = brain.continue(contOpts([]));
    f.fail(new RpcError("session ended", HelperErrorCode.sessionEnded));
    await expect(run.done).rejects.toBeInstanceOf(SessionEndedError);
    // Other helper errors are a temporary problem, as for runTask.
    const again = brain.continue(contOpts([]));
    f.fail(new Error("busy"));
    expect(await again.done).toEqual({ outcome: "retry", reason: "helper error: busy" });
  });

  it("end closes the helper session", async () => {
    const f = fakeHelper();
    const brain = new ClaudeCodeBrain(f.helper);
    f.notify("helper.sessions", { open: ["s1"] });
    await brain.end("s1");
    expect(f.calls).toEqual([{ method: "helper.endSession", params: { sessionId: "s1" } }]);
    expect(brain.isOpen("s1")).toBe(false);
  });
});

describe("ApiBrain: conversations", () => {
  function agentStub(label: string) {
    let resolve!: (r: TaskRunResult) => void;
    const agent: AgentSession & { next: AgentSession | null; continued: { text: string; config?: unknown }[] } = {
      sessionId: "s1",
      sendUserMessage: vi.fn(),
      abort: vi.fn(),
      done: new Promise<TaskRunResult>((r) => (resolve = r)),
      next: null,
      continued: [],
      continueWith(text, o) {
        agent.continued.push({ text, config: o?.config });
        return agent.next ?? agentStub(`${label}+`).agent;
      },
    };
    return { agent, finish: (r: TaskRunResult) => resolve(r) };
  }

  function apiBrain(now = { t: 0 }) {
    const emits: { onEvent: (e: AgentEvent) => void }[] = [];
    const first = agentStub("a");
    const core = {
      createJev: vi.fn(),
      startApiAgent: vi.fn((o: ApiAgentOptions) => (emits.push({ onEvent: o.onEvent }), first.agent)),
    };
    const brain = new ApiBrain({ core, browser: { call: vi.fn() as never }, now: () => now.t });
    return { brain, first, emits, core, now };
  }

  it("keeps the history: the next message continues the same agent, events go to the new turn", async () => {
    const { brain, first, emits } = apiBrain();
    const turn1: AgentEvent[] = [];
    const run1 = brain.start(opts(turn1));
    first.finish({ outcome: "done" });
    await run1.done;
    expect(brain.openSessions()).toEqual(["s1"]);
    const second = agentStub("b");
    first.agent.next = second.agent;
    const turn2: AgentEvent[] = [];
    const run2 = brain.continue(contOpts(turn2));
    expect(first.agent.continued).toEqual([{ text: "now like it", config: expect.objectContaining({ maxToolCalls: 7 }) }]);
    emits[0]!.onEvent({ type: "assistant_text", text: "turn 2 says hi" });
    expect(turn1).toEqual([]);
    expect(turn2).toEqual([{ type: "assistant_text", text: "turn 2 says hi" }]);
    await run2.sendUserMessage("faster");
    expect(second.agent.sendUserMessage).toHaveBeenCalledWith("faster");
    second.finish({ outcome: "done", summary: "liked" });
    expect(await run2.done).toEqual({ outcome: "done", summary: "liked" });
  });

  it("unknown, ended or idle-expired conversations fail with SessionEndedError (a restart loses them)", async () => {
    const { brain, first, now } = apiBrain();
    await expect(brain.continue(contOpts([], { sessionId: "nope" })).done).rejects.toBeInstanceOf(SessionEndedError);
    brain.start(opts([]));
    first.finish({ outcome: "done" });
    await first.agent.done;
    await Promise.resolve();
    now.t += 31 * 60_000;
    expect(brain.isOpen("s1")).toBe(false);
    await expect(brain.continue(contOpts([])).done).rejects.toBeInstanceOf(SessionEndedError);
    const b = apiBrain();
    b.brain.start(opts([]));
    await b.brain.end("s1");
    expect(b.brain.openSessions()).toEqual([]);
  });

  it("keeps at most three conversations", () => {
    const { brain } = apiBrain();
    for (const id of ["a", "b", "c", "d"]) brain.start(opts([], { sessionId: id }));
    expect(brain.openSessions()).toEqual(["b", "c", "d"]);
  });
});

describe("ApiBrain", () => {
  it("starts core.startApiAgent with the key, model, browser and a Jev client", async () => {
    const jev = { decide: vi.fn() };
    let got: ApiAgentOptions | null = null;
    const session: AgentSession = {
      sessionId: "s1",
      sendUserMessage: vi.fn(),
      abort: vi.fn(),
      done: Promise.resolve({ outcome: "done" }),
    };
    const core = {
      createJev: vi.fn(() => jev),
      startApiAgent: vi.fn((o: ApiAgentOptions) => ((got = o), session)),
    };
    const browser = { call: vi.fn() as never };
    const run = new ApiBrain({ core, browser }).start(opts([]));
    expect(core.createJev).toHaveBeenCalledWith("jk", undefined);
    expect(got).toMatchObject({ sessionId: "s1", apiKey: "sk", model: DEFAULT_SETTINGS.anthropicModel, jev, mediaPaths: ["C:\\a.png"] });
    // Browser calls go to the run's tab (here the default browser).
    await got!.browser.call("browser.currentUrl", {});
    expect(browser.call).toHaveBeenCalledWith("browser.currentUrl", {});
    expect(await run.sendUserMessage("more")).toBe(true);
    expect(session.sendUserMessage).toHaveBeenCalledWith("more");
    run.abort("login", "paused");
    expect(session.abort).toHaveBeenCalledWith("login", "paused");
    expect(await run.done).toEqual({ outcome: "done" });
  });

  it("no Jev without a key or when disabled", () => {
    const core = { createJev: vi.fn(), startApiAgent: vi.fn(() => ({ sessionId: "s", sendUserMessage() {}, abort() {}, done: new Promise<never>(() => {}) })) };
    const brain = new ApiBrain({ core, browser: { call: vi.fn() as never } });
    brain.start(opts([], { settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "sk", jevApiKey: "" } }));
    brain.start(opts([], { settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "sk", jevApiKey: "jk", jevEnabled: false } }));
    expect(core.createJev).not.toHaveBeenCalled();
    expect((core.startApiAgent.mock.calls as unknown as [ApiAgentOptions][]).map((c) => c[0].jev)).toEqual([null, null]);
  });

  it("the TODO tools go to the scheduler for this conversation; without one the agent gets none", async () => {
    const got: ApiAgentOptions[] = [];
    const core = {
      createJev: vi.fn(),
      startApiAgent: vi.fn((o: ApiAgentOptions) => (got.push(o), { sessionId: "s1", sendUserMessage() {}, abort() {}, done: new Promise<never>(() => {}) })),
    };
    const answer = { text: "Scheduled in the user's TODO list (task t9)" };
    const todoTool = vi.fn(async () => answer);
    new ApiBrain({ core, browser: { call: vi.fn() as never }, todoTool }).start(opts([]));
    const args = { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } };
    expect(await got[0]!.todo!("schedule_task", args)).toBe(answer);
    expect(todoTool).toHaveBeenCalledWith("s1", "schedule_task", args);
    await got[0]!.todo!("cancel_scheduled_task", { task_id: "t9" });
    expect(todoTool).toHaveBeenLastCalledWith("s1", "cancel_scheduled_task", { task_id: "t9" });
    new ApiBrain({ core, browser: { call: vi.fn() as never } }).start(opts([]));
    expect(got[1]!.todo).toBeUndefined();
  });

  it("remember / recall / forget go to the memory of this conversation; without it the agent gets none", async () => {
    const got: ApiAgentOptions[] = [];
    const core = {
      createJev: vi.fn(),
      startApiAgent: vi.fn((o: ApiAgentOptions) => (got.push(o), { sessionId: "s1", sendUserMessage() {}, abort() {}, done: new Promise<never>(() => {}) })),
    };
    const memoryTool = vi.fn(async () => ({ text: "ok" }));
    new ApiBrain({ core, browser: { call: vi.fn() as never }, memoryTool }).start(opts([]));
    expect(await got[0]!.memory!("recall", { query: "x" })).toEqual({ text: "ok" });
    expect(memoryTool).toHaveBeenCalledWith("s1", "recall", { query: "x" });
    new ApiBrain({ core, browser: { call: vi.fn() as never } }).start(opts([]));
    expect(got[1]!.memory).toBeUndefined();
  });

  it("a throwing startApiAgent becomes a failed run", async () => {
    const core = {
      createJev: vi.fn(),
      startApiAgent: vi.fn(() => {
        throw new Error("not implemented");
      }),
    };
    const run = new ApiBrain({ core, browser: { call: vi.fn() as never } }).start(opts([]));
    expect(await run.done).toEqual({ outcome: "failed", reason: "Could not start the Claude API agent: not implemented" });
  });
});

describe("ClaudeCodeBrain: attachments", () => {
  const big = { ref: { id: "a1", name: "cat.png", type: "image/png", size: 1_200_000, kind: "image" as const }, fresh: true, blob: new Blob([new Uint8Array(1_200_000).fill(7)]) };
  const small = { ref: { id: "a2", name: "n.txt", type: "text/plain", size: 2, kind: "text" as const }, fresh: true, blob: new Blob(["hi"]), text: "hi" };

  it("sends each file to the helper in pieces of ATTACHMENT_CHUNK_BYTES, then starts the task naming them (bytes and paths stay out)", async () => {
    const f = fakeHelper();
    const run = new ClaudeCodeBrain(f.helper).start(opts([], { attachments: [big, small] }));
    await vi.waitFor(() => expect(f.calls.some((c) => c.method === "helper.runTask")).toBe(true));
    const pieces = f.calls.filter((c) => c.method === "helper.putAttachment").map((c) => [c.params.id, c.params.offset, atob(c.params.dataBase64).length]);
    expect(pieces).toEqual([
      ["a1", 0, ATTACHMENT_CHUNK_BYTES],
      ["a1", ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES],
      ["a1", 2 * ATTACHMENT_CHUNK_BYTES, 1_200_000 - 2 * ATTACHMENT_CHUNK_BYTES],
      ["a2", 0, 2],
    ]);
    expect(f.calls.at(-1)!.params.attachments).toEqual([
      { ref: big.ref, fresh: true },
      { ref: small.ref, fresh: true, text: "hi" },
    ]);
    f.finish({ outcome: "done" });
    await run.done;
  });

  it("a follow-up sends only its own files; the earlier ones are named again", async () => {
    const f = fakeHelper();
    const brain = new ClaudeCodeBrain(f.helper);
    f.hello(["s1"]);
    const run = brain.continue({ ...opts([]), text: "more", attachments: [{ ...big, fresh: false }, small] } as BrainContinueOptions);
    await vi.waitFor(() => expect(f.calls.some((c) => c.method === "helper.continueSession")).toBe(true));
    expect(f.calls.filter((c) => c.method === "helper.putAttachment").map((c) => c.params.id)).toEqual(["a2"]);
    expect(f.calls.at(-1)!.params.attachments.map((a: { ref: { id: string }; fresh: boolean }) => [a.ref.id, a.fresh])).toEqual([
      ["a1", false],
      ["a2", true],
    ]);
    f.finish({ outcome: "done" });
    await run.done;
  });
});

describe("ApiBrain: attachments", () => {
  it("gives the agent loop the files without their Blob: a fresh image's bytes as base64, each with its upload path", () => {
    let got: ApiAgentOptions | null = null;
    const agent: AgentSession = { sessionId: "s1", sendUserMessage: vi.fn(), abort: vi.fn(), done: new Promise(() => {}) };
    const core = { createJev: vi.fn(), startApiAgent: vi.fn((o: ApiAgentOptions) => ((got = o), agent)) };
    const ref = { id: "a1", name: "cat.png", type: "image/png", size: 3, kind: "image" as const };
    new ApiBrain({ core, browser: { call: vi.fn() as never } }).start(opts([], { attachments: [{ ref, fresh: true, blob: new Blob(["png"]), base64: "cG5n", path: "C:\dl\cat.png" }] }));
    expect(got!.attachments).toEqual([{ ref, fresh: true, base64: "cG5n", path: "C:\dl\cat.png" }]);
  });
});
