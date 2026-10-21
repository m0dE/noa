import type { AgentEvent } from "@noa/shared";
import { describe, expect, it } from "vitest";
import { madeProgress, ToolProgress, TurnBudget } from "../src/index.js";

let id = 0;
/** One tool call and its result, as the executor emits them. */
function step(name: string, args: unknown, text: string, isError = false): AgentEvent[] {
  const i = `c${++id}`;
  return [{ type: "tool_call", id: i, name, args }, { type: "tool_result", id: i, name, text, ...(isError ? { isError: true } : {}) }];
}

describe("ToolProgress", () => {
  it("counts actions that worked with an outcome new to the turn", () => {
    const p = new ToolProgress();
    const feed = (evs: AgentEvent[]) => evs.forEach((e) => p.observe(e));
    feed(step("act", { steps: [{ index: 4 }] }, "Clicked. Statement March"));
    feed(step("act", { steps: [{ index: 4 }] }, "Clicked. Statement March")); // the same again
    feed(step("act", { steps: [{ index: 4 }] }, "Clicked. Statement April")); // same call, a new page
    feed(step("save_file", { download: true }, "Saved Noa/x.pdf"));
    feed(step("save_file", { download: true }, "No download", true)); // failed
    feed(step("read_page", {}, "a page never read before")); // only looks
    feed(step("task_complete", { summary: "ok" }, "done")); // not counted at all
    expect(p).toMatchObject({ calls: 6, fresh: 3 });
  });
});

describe("madeProgress", () => {
  it("needs a share of the calls (at least one) to be new outcomes", () => {
    expect(madeProgress(0, 0)).toBe(false);
    expect(madeProgress(60, 11)).toBe(false);
    expect(madeProgress(60, 12)).toBe(true);
    expect(madeProgress(3, 1)).toBe(true);
  });
});

describe("TurnBudget", () => {
  const run = (b: TurnBudget, evs: AgentEvent[]) => {
    const verdict = b.next();
    if (verdict === "run") evs.forEach((e) => b.observe(e));
    return verdict;
  };

  it("gives a round that got somewhere another round", () => {
    const b = new TurnBudget(5);
    const verdicts = Array.from({ length: 23 }, (_, i) => run(b, step("navigate", { url: `https://bank.test/s/${i}` }, `URL: https://bank.test/s/${i}`)));
    expect(verdicts.every((v) => v === "run")).toBe(true);
    expect(b.allowed).toBe(25);
  });

  it("refuses past a round that got nowhere new, then stops", () => {
    const b = new TurnBudget(5);
    // The click's outcome was seen before the round: each one again is nothing new.
    step("act", { steps: [{ index: 2 }] }, "Clicked. Nothing changed").forEach((e) => b.observe(e));
    const verdicts = Array.from({ length: 10 }, () => run(b, step("act", { steps: [{ index: 2 }] }, "Clicked. Nothing changed")));
    expect(verdicts).toEqual(["run", "run", "run", "run", "run", "refuse", "refuse", "refuse", "refuse", "stop"]);
    expect(b.spent).toBe(true);
  });

  it("a later round that stalls is refused even after rounds that progressed", () => {
    const b = new TurnBudget(5);
    for (let i = 0; i < 5; i++) run(b, step("navigate", { url: `https://bank.test/s/${i}` }, `page ${i}`));
    const stalled = Array.from({ length: 6 }, () => run(b, step("read_page", {}, "same page")));
    expect(stalled.slice(0, 5)).toEqual(["run", "run", "run", "run", "run"]);
    expect(stalled[5]).toBe("refuse");
  });
});
