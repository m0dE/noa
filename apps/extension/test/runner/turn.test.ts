/** Runner turns: results and their classification, post verification, pause URLs, preparation errors. */
import { describe, expect, it, vi } from "vitest";
import { DEBUGGER_CANCELED } from "../../src/cdp.js";
import { typedTextsOf } from "../../src/engine/run/turn.js";
import { AGENT_TAB, env, harness, runAll, setupRunnerTests } from "./harness.js";

setupRunnerTests();

describe("Runner: one turn", () => {
  it("permanent failure is recorded as failed", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "x" });
    h.brain.script = () => ({ outcome: "failed", reason: "button not found" });
    await runAll(h);
    expect(await h.store.get(t.id)).toMatchObject({ status: "failed", failReason: "button not found" });
  });

  it("a transient failure becomes retry with retryAfterMinutes", async () => {
    const h = harness({ retryAfterMinutes: 7 });
    const t = await h.store.add({ instructions: "x" });
    h.brain.script = () => ({ outcome: "failed", reason: "usage limit reached" });
    await runAll(h);
    expect(await h.store.get(t.id)).toMatchObject({
      status: "pending",
      failReason: "usage limit reached",
      retryAfter: new Date(env.clock + 7 * 60_000).toISOString(),
    });
    const [s] = await h.sessions.list();
    expect(s!.outcome).toBe("retry");
  });

  it("a second attempt runs with isRetry", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "x" });
    h.brain.script = () => ({ outcome: "retry", reason: "network" });
    await runAll(h);
    env.clock += 11 * 60_000;
    h.brain.script = () => ({ outcome: "done" });
    await runAll(h);
    expect(h.brain.starts.map((s) => s.config.isRetry)).toEqual([false, true]);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("pauses the session when the agent tab hits a login URL", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "x" });
    await h.store.add({ instructions: "second" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    await h.runner.onTabUpdated(99, { url: "https://x.com/i/flow/login" }); // not the agent tab
    expect(h.brain.ctls[0]!.aborts).toEqual([]);
    await h.runner.onTabUpdated(AGENT_TAB, { url: "https://x.com/i/flow/login" });
    await h.runner.idle();
    expect(h.brain.ctls[0]!.aborts).toEqual([{ reason: "X is asking to log in", outcome: "paused" }]);
    expect(await h.store.get(t.id)).toMatchObject({ status: "paused", pauseReason: "X is asking to log in" });
    expect(h.notifications).toEqual([{ title: "Task paused", message: "X is asking to log in" }]);
    // The run stops after a pause: the second task was not started.
    expect(h.brain.starts).toHaveLength(1);
  });

  it("verifies X posts: verified stays done, unverified becomes retry", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "Post on X from @me. Post: hello world, this is the post body" });
    h.brain.script = (opts) => {
      // What the agent typed is what must be on the post page, not the instructions.
      opts.onEvent({ type: "tool_call", id: "1", name: "act", args: { steps: [{ goal: "open composer" }, { goal: "type", text: "hi" }] } });
      opts.onEvent({ type: "tool_call", id: "2", name: "mcp__noa__type", args: { index: 3, text: "hello world, this is the post body" } });
      return { outcome: "done", url: "https://x.com/me/status/123" };
    };
    await runAll(h);
    expect(h.verify).toHaveBeenCalledWith(h.browser, "https://x.com/me/status/123", "hello world, this is the post body", undefined);
    expect(await h.store.get(a.id)).toMatchObject({ status: "done" });

    h.brain.script = () => ({ outcome: "done", url: "https://x.com/me/status/123" });
    const b = await h.store.add({ instructions: "Post: second" });
    h.verify.mockResolvedValueOnce({ ok: false, detail: "text not found" });
    await runAll(h);
    expect(await h.store.get(b.id)).toMatchObject({ status: "pending", failReason: "could not verify the post: text not found" });

    // Non-X URLs are not verified.
    h.verify.mockClear();
    await h.store.add({ instructions: "other" });
    h.brain.script = () => ({ outcome: "done", url: "https://example.com/done" });
    await runAll(h);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("the debugger infobar Cancel fails the session", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "a" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    h.runner.onDebuggerCanceled();
    await h.runner.idle();
    expect(await h.store.get(a.id)).toMatchObject({ status: "failed", failReason: DEBUGGER_CANCELED });
  });

  it("a preparation error (e.g. media) is recorded without starting the brain", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "a" });
    h.deps.media.materialize = async () => {
      throw new Error("Writing a.png failed: disk full");
    };
    await runAll(h);
    expect(h.brain.starts).toHaveLength(0);
    expect(await h.store.get(a.id)).toMatchObject({ status: "failed", failReason: "Writing a.png failed: disk full" });
  });
});

describe("typedTextsOf", () => {
  it("collects text from type, paste and act steps only", () => {
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "type", args: { index: 1, text: "a" } })).toEqual(["a"]);
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "mcp__noa__paste", args: { text: "b" } })).toEqual(["b"]);
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "act", args: { steps: [{ goal: "x" }, { goal: "y", text: "c" }] } })).toEqual(["c"]);
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "click", args: { index: 1 } })).toEqual([]);
    expect(typedTextsOf({ type: "assistant_text", text: "d" })).toEqual([]);
  });
});
