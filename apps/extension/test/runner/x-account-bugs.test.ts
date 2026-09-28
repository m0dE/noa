/**
 * Regression tests for the repeating X jobs of 2026-09-28 (build c2852cb): a Rooftop Chat post landed on
 * @mecharoyalecom, and a later voice question ("Is this test done?") on the @mecharoyalecom job was answered with
 * "X is signed in as @rooftopchat and can't be switched automatically" without switch_x_account being called.
 */
import { describe, expect, it, vi } from "vitest";
import type { StampedAgentEvent } from "@noa/shared";
import { claimFixture } from "../fixtures.js";
import { buildFollowUpInstructions } from "../../src/continue.js";
import { harness, parallel, runAll, setupRunnerTests } from "./harness.js";

setupRunnerTests();

const MECHA = "Post one new original post on X as @mecharoyalecom (Mecha Royale). This repeats 3 times a day.";
const SWITCH_FAILED =
  "switch_x_account step 3 failed: clicked the @mecharoyalecom entry but the switcher does not show @mecharoyalecom yet. Do it yourself with read_page and act (give the element index), then verify with a screenshot. If the account is not signed in, call task_pause.";
const PAUSE_REASON =
  "X is signed in as @rooftopchat and switch_x_account couldn't switch to @mecharoyalecom (it's probably in the collapsed Personal accounts section). The user needs to switch by hand.";

describe("B: a message to an X job's conversation after its agent session is gone", () => {
  it("a cloud X job keeps its account in the fresh session (the voice question's run got 'Account: none given')", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k" });
    h.claims.push(claimFixture("01M3J8GMHQM8YS7EP2B8REBFA2", { instructions: MECHA, account: "@mecharoyalecom" }));
    h.brain.script = (o) => {
      o.onEvent({ type: "tool_call", id: "t1", name: "switch_x_account", args: { handle: "@mecharoyalecom" } });
      o.onEvent({ type: "tool_result", id: "t1", name: "switch_x_account", text: SWITCH_FAILED, isError: true });
      return { outcome: "paused", reason: PAUSE_REASON };
    };
    await runAll(h);
    expect(h.brain.starts[0]!.task.account).toBe("@mecharoyalecom");
    const session = (await h.sessions.list()).find((s) => s.source === "cloud")!;

    // The Claude Code session closed; the user asks by voice.
    h.brain.open.clear();
    h.brain.script = () => ({ outcome: "paused", reason: "Not done" });
    await h.runner.message(session.sessionId, "Is this test done?", { voice: true });
    await h.runner.idle();
    await h.sessions.flush();
    const fresh = h.brain.starts[1]!;
    expect(fresh.task.account).toBe("@mecharoyalecom");
  });

  it("the fresh-session summary does not hand an earlier switch_x_account failure on as final", () => {
    const events = [
      { type: "tool_call", id: "t1", name: "switch_x_account", args: { handle: "@mecharoyalecom" } },
      { type: "tool_result", id: "t1", name: "switch_x_account", text: SWITCH_FAILED, isError: true },
      { type: "tool_call", id: "t4", name: "task_pause", args: { reason: PAUSE_REASON } },
      { type: "tool_result", id: "t4", name: "task_pause", text: "Task paused for the human. Stop now." },
    ].map((e, i) => ({ ...e, ts: `2026-09-28T05:56:${10 + i}.000Z` })) as StampedAgentEvent[];
    const text = buildFollowUpInstructions({
      instructions: MECHA,
      session: { outcome: "paused", reason: PAUSE_REASON },
      events,
      text: "Is this test done?",
    });
    // The agent is told to try the switch again itself before asking the user to do it by hand.
    expect(text).toMatch(/switch_x_account[^\n]*(again|retry)/i);
  });
});

describe("A: two X jobs never use X at the same time", () => {
  it("two X runs waiting for the X turn do not both start when it is freed", async () => {
    const { h, overlaps, startsOf, finishTask } = parallel({ maxParallelTasks: 3 });
    await h.store.add({ instructions: "Post one new original post on X as @getbnty", account: "@getbnty" });
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(startsOf()).toEqual(["t1"]));

    // Two X runs started beside it (e.g. a voice/chat turn and a one-off) wait for the X turn.
    const a = await h.runner.runAdhoc({ instructions: "Post on X as @mecharoyalecom: gm", account: "@mecharoyalecom" });
    const b = await h.runner.runAdhoc({ instructions: "Post on X as @rooftopchat: gm", account: "@rooftopchat" });
    await h.sessions.flush();
    expect(startsOf()).toEqual(["t1"]);

    await finishTask("t1");
    await vi.waitFor(() => expect(startsOf().length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 50));
    const xRunning = overlaps.map((running) => running.filter((id) => id !== "t1"));
    // Only one of them may hold X; the other must still be waiting.
    expect(Math.max(...xRunning.map((r) => r.length))).toBeLessThanOrEqual(1);
    expect(startsOf()).toHaveLength(2);
    for (const s of [a, b]) {
      const i = h.brain.starts.findIndex((x) => x.sessionId === s.sessionId);
      if (i >= 0) h.brain.ctls[i]!.resolve({ outcome: "done" });
    }
    await vi.waitFor(() => expect(startsOf()).toHaveLength(3));
    h.brain.ctls[2]!.resolve({ outcome: "done" });
    await h.runner.idle();
  });
});
