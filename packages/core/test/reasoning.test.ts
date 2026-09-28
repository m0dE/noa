import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import {
  MAX_RAISES_PER_TURN,
  ReasoningGovernor,
  reasoningParams,
  StuckDetector,
  STUCK_LIMITS,
  TASK_FAIL_RECHECK,
  THINKING_BUDGET_TOKENS,
  THINKING_MAX_TOKENS,
  type ReasoningChange,
} from "../src/reasoning.js";

let nextId = 1;
/** A tool call and its result, as the executor emits them. */
function step(name: string, args: unknown, result: { text?: string; isError?: boolean } = {}): AgentEvent[] {
  const id = `t${nextId++}`;
  const r: AgentEvent = { type: "tool_result", id, name, text: result.text ?? "ok" };
  if (result.isError) r.isError = true;
  return [{ type: "tool_call", id, name, args }, r];
}
const fail = (name: string, args: unknown = {}, text = `${name} failed`) => step(name, args, { text, isError: true });
const jev = (operation: string, executed: boolean): AgentEvent => ({ type: "jev", goal: "open the menu", operation, index: null, confidence: 0.9, executed, ms: 5 });

function detect(events: AgentEvent[]): (string | null)[] {
  const d = new StuckDetector();
  return events.map((e) => d.observe(e)).filter((why) => why !== null);
}

describe("StuckDetector", () => {
  it("one page-changing tool failing STUCK_LIMITS.toolFailures times in a row is stuck, even with page reads in between", () => {
    const run = [...fail("act", { n: 1 }), ...step("read_page", {}), ...fail("act", { n: 2 }), ...step("screenshot", {}), ...fail("act", { n: 3 })];
    expect(STUCK_LIMITS.toolFailures).toBe(3);
    expect(detect(run)).toEqual(["act failed 3 times in a row"]);
  });

  it("a step that works ends the run of failures; failures of another tool start their own", () => {
    expect(detect([...fail("act"), ...fail("act"), ...step("navigate", { url: "x" }), ...fail("act"), ...fail("act")])).toEqual([]);
    expect(detect([...fail("act"), ...fail("act"), ...fail("navigate"), ...fail("act")])).toEqual([]);
  });

  it("tools that only look or wait are neutral: their failures do not count (a long wait_for is no sign of a stuck plan)", () => {
    expect(detect([...fail("wait_for"), ...fail("wait_for"), ...fail("wait_for"), ...fail("read_page"), ...fail("read_page"), ...fail("read_page")])).toEqual([]);
  });

  it("the same action giving the same result STUCK_LIMITS.sameResult times in a row is no progress; a changing result is progress", () => {
    const click = (text: string) => step("act", { steps: [{ goal: "Next", index: 4 }] }, { text });
    expect(detect([...click("page 1"), ...step("read_page", {}), ...click("page 1"), ...click("page 1")])).toEqual(["the same act gave the same result 3 times in a row"]);
    // Pagination: the same click, a new page each time.
    expect(detect([...click("page 1"), ...click("page 2"), ...click("page 3"), ...click("page 4")])).toEqual([]);
  });

  it("arguments compare by value whatever their key order; scrolling again is never the same action again", () => {
    const run = [...step("act", { a: 1, b: 2 }, { text: "same" }), ...step("act", { b: 2, a: 1 }, { text: "same" }), ...step("act", { a: 1, b: 2 }, { text: "same" })];
    expect(detect(run)).toHaveLength(1);
    const scrolls = Array.from({ length: 5 }, () => step("scroll", { direction: "down" }, { text: "same" })).flat();
    expect(detect(scrolls)).toEqual([]);
  });

  it("Jev answering blocked STUCK_LIMITS.blockedPicks times in a row is stuck; a step Jev did in between resets it", () => {
    expect(detect([jev("blocked", false), jev("blocked", false)])).toEqual([`Jev found no way to do "open the menu" 2 times in a row`]);
    expect(detect([jev("blocked", false), jev("click", true), jev("blocked", false)])).toEqual([]);
  });

  it("task_* calls are never counted (they end the turn, and their refusals are the turn rules')", () => {
    expect(detect([...fail("task_complete"), ...fail("task_complete"), ...fail("task_complete")])).toEqual([]);
  });

  it("says it once, then counts again from zero", () => {
    const run = Array.from({ length: 5 }, (_, i) => fail("act", { i })).flat();
    expect(detect(run)).toEqual(["act failed 3 times in a row"]);
  });
});

function governor(config: { reasoning?: "fast" | "thorough"; reasoningAutoRaise?: boolean } = {}) {
  const changes: ReasoningChange[] = [];
  const g = new ReasoningGovernor(config, (c) => changes.push(c));
  const feed = (events: AgentEvent[]) => events.forEach((e) => g.observe(e));
  return { g, changes, feed };
}
const stuck = () => [...fail("act", { n: 1 }), ...fail("act", { n: 2 }), ...fail("act", { n: 3 })];

describe("ReasoningGovernor", () => {
  it("defaults to Fast with auto-raise: not thinking until the run is stuck, then raised until a page-changing step works", () => {
    const { g, changes, feed } = governor();
    expect(g.thinking).toBe(false);
    feed(stuck());
    expect(g.thinking).toBe(true);
    expect(changes).toEqual([{ kind: "raise", thinking: true, why: "act failed 3 times in a row" }]);
    // Reading the page is no success; a click that works is.
    feed(step("read_page", {}));
    expect(g.raised).toBe(true);
    feed(step("act", { n: 4 }));
    expect(g.thinking).toBe(false);
    expect(changes.at(-1)).toEqual({ kind: "lower", thinking: false, why: "act worked" });
  });

  it(`never loops: at most MAX_RAISES_PER_TURN (${MAX_RAISES_PER_TURN}) raises a turn; a new turn starts over`, () => {
    const { g, changes, feed } = governor();
    for (let i = 0; i < 4; i++) {
      feed(stuck());
      feed(step("act", { ok: i }));
    }
    expect(changes.filter((c) => c.kind === "raise")).toHaveLength(MAX_RAISES_PER_TURN);
    g.startTurn({});
    feed(stuck());
    expect(changes.filter((c) => c.kind === "raise")).toHaveLength(MAX_RAISES_PER_TURN + 1);
  });

  it("Thorough always thinks and never raises; auto-raise off never raises", () => {
    const thorough = governor({ reasoning: "thorough" });
    thorough.feed(stuck());
    expect(thorough.g.thinking).toBe(true);
    expect(thorough.changes).toEqual([]);
    const off = governor({ reasoningAutoRaise: false });
    off.feed(stuck());
    expect(off.g.thinking).toBe(false);
    expect(off.changes).toEqual([]);
    expect(off.g.beforeTaskFail()).toBeNull();
  });

  it("the first task_fail of a Fast turn is answered with TASK_FAIL_RECHECK and raises; the second one runs", () => {
    const { g, changes } = governor();
    expect(g.beforeTaskFail()).toBe(TASK_FAIL_RECHECK);
    expect(changes).toEqual([{ kind: "raise", thinking: true, why: "about to give up (task_fail)" }]);
    expect(g.beforeTaskFail()).toBeNull();
  });

  it("a task_fail while already raised runs (the careful look already happened)", () => {
    const { g, feed } = governor();
    feed(stuck());
    expect(g.beforeTaskFail()).toBeNull();
  });

  it("a new turn resets a raise, and says so when the thinking changes (a new level, or a raise that ends)", () => {
    const { g, changes, feed } = governor();
    feed(stuck());
    g.startTurn({});
    expect(g.thinking).toBe(false);
    expect(changes.at(-1)).toEqual({ kind: "turn", thinking: false, why: "new turn (fast)" });
    g.startTurn({ reasoning: "thorough" });
    expect(changes.at(-1)).toEqual({ kind: "turn", thinking: true, why: "new turn (thorough)" });
    const before = changes.length;
    g.startTurn({ reasoning: "thorough" });
    expect(changes).toHaveLength(before);
  });

  it("a listener that throws does not break the run", () => {
    const g = new ReasoningGovernor({}, () => {
      throw new Error("boom");
    });
    for (const e of stuck()) g.observe(e);
    expect(g.raised).toBe(true);
  });
});

describe("reasoningParams (per model, from Anthropic's thinking table)", () => {
  it("Sonnet 5 (switchable): Fast turns thinking off; raised and Thorough are adaptive with room for the thinking", () => {
    expect(reasoningParams("claude-sonnet-5", "fast")).toEqual({ thinking: { type: "disabled" } });
    for (const when of ["raised", "thorough"] as const) expect(reasoningParams("claude-sonnet-5", when)).toEqual({ thinking: { type: "adaptive" }, max_tokens: THINKING_MAX_TOKENS });
  });

  it("Opus 5.5 and Fable 5.1 (always think; disabled is a 400): Fast is low effort, raised and Thorough their default effort", () => {
    for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
      expect(reasoningParams(model, "fast")).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
      expect(reasoningParams(model, "raised")).toEqual({ thinking: { type: "adaptive" }, max_tokens: THINKING_MAX_TOKENS });
    }
  });

  it("Haiku 4.5 (budget only; adaptive is a 400): thinks only in a Thorough turn, with a budget under max_tokens (a mid-turn raise is ignored by the API)", () => {
    for (const id of ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]) {
      expect(reasoningParams(id, "fast")).toEqual({});
      expect(reasoningParams(id, "raised")).toEqual({});
      expect(reasoningParams(id, "thorough")).toEqual({ thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS }, max_tokens: THINKING_MAX_TOKENS });
    }
    expect(THINKING_BUDGET_TOKENS).toBeGreaterThanOrEqual(1024);
    expect(THINKING_BUDGET_TOKENS).toBeLessThan(THINKING_MAX_TOKENS);
  });

  it("a model Noa does not offer runs as its own default (nothing sent)", () => {
    expect(reasoningParams("claude-some-future-model", "thorough")).toEqual({});
  });
});
