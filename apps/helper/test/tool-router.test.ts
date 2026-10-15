import { afterEach, describe, expect, it, vi } from "vitest";
import { createJev, createToolExecutor, type JevLike } from "@noa/core";
import type { PageSnapshot } from "@noa/shared";
import { connectPipe, pipePathFor, startPipeServer } from "../src/pipe-server.js";
import { AttachedSessions, ToolRouter, type InteractiveTools } from "../src/tool-router.js";
import { INTERACTIVE_TASK_ID } from "../src/mcp-tools.js";
import { FakeX } from "./fake-x.js";

describe("ToolRouter", () => {
  it("routes by task id, refuses unknown tasks and tools, and serves the interactive executor", async () => {
    const x = new FakeX();
    const interactiveExec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent: () => {}, mediaPaths: [] });
    const router = new ToolRouter({
      getSession: () => null,
      getInteractive: () => ({ allowedTools: new Set(["read_page", "task_complete"]), executor: interactiveExec }),
    });
    expect((await router.call("S9", "read_page", {})).text).toMatch(/No running task S9/);
    expect((await router.call(INTERACTIVE_TASK_ID, "read_page", {})).text).toContain("URL:");
    expect((await router.call(INTERACTIVE_TASK_ID, "click", { index: 1 })).text).toMatch(/not available in an attached session/);
    // task_* in interactive mode: the executor has no onTaskEnd
    expect((await router.call(INTERACTIVE_TASK_ID, "task_complete", { summary: "x" })).text).toMatch(/no task to end in an attached session/);
    expect(router.allowedTools(INTERACTIVE_TASK_ID)).toEqual(["read_page", "task_complete"]);
  });
});

describe("attached sessions (mcp-server.js --attach)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const PAGE: PageSnapshot = { url: "https://a.test/", title: "A", text: "", truncated: false, elements: [{ index: 0, tag: "button", role: "button", name: "Save", inViewport: true }] };
  /** Attached sessions whose Jev never answers (a slow spell): each request is aborted at the deadline. */
  function slowSessions() {
    const jevs: JevLike[] = [];
    const hang: typeof fetch = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const sessions = new AttachedSessions((): InteractiveTools => {
      const jev = createJev("k", { endpoint: "https://jev.test/v1/ai/jev", fetch: hang });
      jevs.push(jev);
      return { allowedTools: new Set(["read_page"]), jev: true, executor: createToolExecutor({ browser: new FakeX().caller(), jev, jevThreshold: 0.8, onEvent: () => {}, mediaPaths: [] }) };
    });
    return { sessions, jevs };
  }
  const late = async (jev: JevLike) => {
    const p = jev.decide({ goal: "click Save", snapshot: PAGE }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    return p;
  };

  it("each session has its own Jev: one session's pause does not carry to the next session, or to one beside it", async () => {
    vi.useFakeTimers();
    const { sessions, jevs } = slowSessions();
    const a = sessions.get(1);
    expect(sessions.get(1)).toBe(a);
    await late(jevs[0]!);
    await late(jevs[0]!);
    expect(jevs[0]!.paused?.()).toMatchObject({ why: expect.stringMatching(/slower than 3 s on 2 steps in a row/) });
    // Another attached session at the same time: not paused.
    expect(sessions.get(2)).not.toBe(a);
    expect(jevs[1]!.paused?.()).toBeNull();
    // The first session ends (its MCP server's connection closed); a new one starts afresh.
    sessions.end(1);
    expect(sessions.size).toBe(1);
    sessions.get(3);
    expect(jevs).toHaveLength(3);
    expect(jevs[2]!.paused?.()).toBeNull();
    // One late answer in the new session is the first in its row (asked, not skipped).
    expect(await late(jevs[2]!)).toMatchObject({ skipped: false });
  });

  it("the pipe tells which connection a call came on, and when it closed; the router serves that connection's session", async () => {
    const sessions = new AttachedSessions((): InteractiveTools => ({
      allowedTools: new Set(["read_page"]),
      executor: createToolExecutor({ browser: new FakeX().caller(), jev: null, jevThreshold: 0.8, onEvent: () => {}, mediaPaths: [] }),
    }));
    const served: InteractiveTools[] = [];
    const router = new ToolRouter({ getSession: () => null, getInteractive: (client) => (served.push(sessions.get(client)), sessions.get(client)) });
    const closed: number[] = [];
    const path = pipePathFor(800_000 + Math.floor(Math.random() * 99_999));
    const server = await startPipeServer(path, "tok", {
      toolCall: (p, client) => router.call(p.taskId || INTERACTIVE_TASK_ID, p.name, p.args, client),
      toolList: (p, client) => ({ names: router.allowedTools(p.taskId || INTERACTIVE_TASK_ID, client) }),
      closed: (client) => (closed.push(client), sessions.end(client)),
    });
    try {
      const one = await connectPipe(path);
      const two = await connectPipe(path);
      for (const c of [one, one, two]) expect((await c.peer.call("tool.call", { token: "tok", taskId: "", name: "read_page", args: {} })).text).toContain("URL:");
      expect(served[0]).toBe(served[1]);
      expect(served[2]).not.toBe(served[0]);
      expect(sessions.size).toBe(2);
      one.close();
      await one.closed;
      await vi.waitFor(() => expect(closed).toHaveLength(1));
      expect(sessions.size).toBe(1);
      two.close();
      await two.closed;
      await vi.waitFor(() => expect(sessions.size).toBe(0));
      expect(closed).toHaveLength(2);
      expect(closed[0]).not.toBe(closed[1]);
    } finally {
      await server.close();
    }
  });
});
