/** The automation level in the runner: the agent's prompts carry its line, and the approval gate gets each run's context. */
import { describe, expect, it, vi } from "vitest";
import { automationPromptLine } from "@noa/shared";
import { harness, runAll, setupRunnerTests } from "./harness.js";

setupRunnerTests();

describe("Runner: approvals", () => {
  it("a chat run is told its level; the gate gets the level, the instructions and when the turn's limit ends", async () => {
    const h = harness({ automationLevel: "ask_consequential", maxTaskMinutes: 10 });
    h.brain.script = () => "hang";
    const started = Date.now();
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Post 'hi' on X" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(h.brain.starts[0]!.task.approvals).toBe(automationPromptLine("ask_consequential"));
    const ctx = await h.runner.gateContext(sessionId);
    expect(ctx).toMatchObject({ level: "ask_consequential", instructions: "Post 'hi' on X" });
    expect(ctx.endsAt! - started).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await h.runner.idle();
  });

  it("a scheduled run follows the scheduled setting (does what its task says)", async () => {
    const h = harness({ automationLevel: "ask_all", scheduledAutomation: "full_within_task" });
    await h.store.add({ instructions: "Post hello", account: null });
    let ctx: Awaited<ReturnType<typeof h.runner.gateContext>> | null = null;
    h.brain.script = async (opts) => {
      ctx = await h.runner.gateContext(opts.sessionId);
      return { outcome: "done", summary: "posted" };
    };
    await runAll(h);
    expect(h.brain.starts[0]!.task.approvals).toBe(automationPromptLine("full_within_task"));
    expect(ctx).toMatchObject({ level: "full_within_task", instructions: "Post hello" });
  });

  it("Full autonomy covers scheduled runs too, agent-written ones included: nothing waits, no Trust needed", async () => {
    const h = harness({ automationLevel: "full", scheduledAutomation: "full_within_task" });
    await h.store.add({ instructions: "Post hello", account: null });
    await h.store.add({ instructions: "Post goodbye", account: null, agentAuthored: true });
    const ctxs: Awaited<ReturnType<typeof h.runner.gateContext>>[] = [];
    h.brain.script = async (opts) => {
      ctxs.push(await h.runner.gateContext(opts.sessionId));
      return { outcome: "done", summary: "posted" };
    };
    await runAll(h);
    expect(h.brain.starts.map((s) => s.task.approvals)).toEqual([automationPromptLine("full"), automationPromptLine("full")]);
    expect(ctxs.map((c) => c.level)).toEqual(["full", "full"]);
  });

  it("below Full autonomy, a scheduled job the agent wrote is held (ask_consequential) and the gate knows why", async () => {
    const h = harness({ automationLevel: "ask_consequential", scheduledAutomation: "full_within_task" });
    await h.store.add({ instructions: "Post goodbye", account: null, agentAuthored: true });
    let ctx: Awaited<ReturnType<typeof h.runner.gateContext>> | null = null;
    h.brain.script = async (opts) => {
      ctx = await h.runner.gateContext(opts.sessionId);
      return { outcome: "done", summary: "posted" };
    };
    await runAll(h);
    expect(ctx).toMatchObject({ level: "ask_consequential", agentAuthored: true });
  });

  it("full autonomy: its own line (nothing waits, act on a clear request); a level changed between turns is in the next message", async () => {
    const h = harness({ automationLevel: "full" });
    h.brain.script = () => ({ outcome: "done", summary: "ok" });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Post 'hi' on X" });
    await h.runner.idle();
    expect(h.brain.starts[0]!.task.approvals).toBe(automationPromptLine("full"));
    h.settings = { ...h.settings, automationLevel: "ask_all" };
    await h.runner.message(sessionId, "now reply to Maya");
    await h.runner.idle();
    const next = h.brain.continues[0]?.text ?? h.brain.starts[1]?.task.instructions ?? "";
    expect(next).toContain("now reply to Maya");
    expect(next).toContain(automationPromptLine("ask_all"));
  });

  it("no running session: the chat level, no deadline", async () => {
    const h = harness({ automationLevel: "ask_all" });
    expect(await h.runner.gateContext("nope")).toEqual({ level: "ask_all", instructions: "", account: null });
  });
});
