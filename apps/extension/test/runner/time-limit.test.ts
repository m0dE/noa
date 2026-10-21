/**
 * The turn's time limit counts active time: waiting (a wait_for slice, an approval the user has not answered) is
 * left out. The brains get the wall ceiling as their own limit.
 */
import { describe, expect, it, vi } from "vitest";
import { timeLimitReached } from "@noa/core";
import { TURN_WALL_MINUTES, type AgentEvent } from "@noa/shared";
import { ActiveClock } from "../../src/engine/run/deadline.js";
import { harness, setupRunnerTests } from "./harness.js";

setupRunnerTests();

describe("ActiveClock", () => {
  it("reaches its limit only in active time; overlapping waits count once; stop() silences it", () => {
    vi.useFakeTimers();
    const hit = vi.fn();
    const clock = new ActiveClock(60_000, hit);
    vi.advanceTimersByTime(20_000);
    const endA = clock.wait();
    const endB = clock.wait();
    vi.advanceTimersByTime(10 * 60_000);
    endA();
    vi.advanceTimersByTime(10 * 60_000);
    expect(clock.activeMs).toBe(20_000);
    endB();
    endB();
    vi.advanceTimersByTime(39_999);
    expect(hit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hit).toHaveBeenCalledTimes(1);

    const quiet = vi.fn();
    const stopped = new ActiveClock(1000, quiet);
    stopped.stop();
    vi.advanceTimersByTime(5000);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("asks extend at the limit: true runs it on for another limit", () => {
    vi.useFakeTimers();
    const hit = vi.fn();
    const answers = [true, false];
    const clock = new ActiveClock(60_000, hit, Date.now, () => answers.shift()!);
    vi.advanceTimersByTime(60_000);
    expect(hit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(hit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hit).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([]);
  });
});

describe("Runner: the time limit", () => {
  it("waits in the slot do not count: a 1-minute limit outlasts a 5-minute wait, then stops the turn in active time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = harness({ maxTaskMinutes: 1 });
    h.brain.script = () => "hang";
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Wait for the deploy" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(h.brain.starts[0]!.config.maxTaskMinutes).toBe(TURN_WALL_MINUTES);
    const ctx = await h.runner.gateContext(sessionId);
    expect(ctx.endsAt! - Date.now()).toBeGreaterThan((TURN_WALL_MINUTES - 1) * 60_000);

    await vi.advanceTimersByTimeAsync(30_000);
    const endWait = h.slotWait();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.brain.ctls[0]!.aborts).toEqual([]);
    endWait();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.brain.ctls[0]!.aborts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.brain.ctls[0]!.aborts).toEqual([{ reason: timeLimitReached(1), outcome: "failed" }]);
    await h.runner.idle();
  });
});

describe("Runner: the time limit of a turn still getting somewhere", () => {
  it("runs on for another limit while new pages keep coming, and stops after one that got nowhere", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = harness({ maxTaskMinutes: 1 });
    let emit!: (e: AgentEvent) => void;
    h.brain.script = (opts) => ((emit = opts.onEvent), "hang");
    await h.runner.runAdhoc({ instructions: "Download every statement" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    const step = (i: number) => {
      emit({ type: "tool_call", id: `c${i}`, name: "navigate", args: { url: `https://bank.test/s/${i}` } });
      emit({ type: "tool_result", id: `c${i}`, name: "navigate", text: `URL: https://bank.test/s/${i}` });
    };
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      step(i);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.brain.ctls[0]!.aborts).toEqual([]);
    // The second minute: the page read over and over (only looking, nothing new done).
    for (let i = 0; i < 3; i++) {
      emit({ type: "tool_call", id: `r${i}`, name: "read_page", args: {} });
      emit({ type: "tool_result", id: `r${i}`, name: "read_page", text: "URL: https://bank.test/s/2" });
    }
    await vi.advanceTimersByTimeAsync(14_000);
    expect(h.brain.ctls[0]!.aborts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.brain.ctls[0]!.aborts).toEqual([{ reason: timeLimitReached(1), outcome: "failed" }]);
    await h.runner.idle();
  });
});
