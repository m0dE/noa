/**
 * wait_for through the tool executor: the browser watches the tab in slices (browser.waitFor) until a condition
 * holds; the wait ends on the condition, its time, one call's limit ("still waiting"), the turn's time limit, a
 * message from the user, or a closed tab. A fake clock moves with each slice, so nothing really waits.
 */
import { describe, expect, it } from "vitest";
import { WAIT_CALL_LIMIT_MS, WAIT_SLICE_MS, WAIT_TURN_MARGIN_MS, type BrowserMethods, type TraceDraft, type WaitCheck, type WaitCheckParams } from "@noa/shared";
import { createToolExecutor, Interjections, WAIT_RETRY_BACKOFF } from "../src/index.js";
import type { BrowserCaller } from "../src/types.js";
import { collect } from "./helpers.js";

const T0 = 1_800_000_000_000;
const PAGE = { url: "https://builder.test/p/1", title: "Builder" };
const DEPLOYED = { kind: "text_appears", text: "Deployed" } as const;

/**
 * A browser whose slices answer `answer(n, params)` (n from 1) after the slice's full time, or `early` ms, on a
 * fake clock; `hang` slices never answer. Records every browser.waitFor and every pause.
 */
function setup(opts: { answer?: (n: number, p: WaitCheckParams) => Partial<WaitCheck>; early?: number; hang?: boolean; turnEndsAt?: number } = {}) {
  let clock = T0;
  const slices: WaitCheckParams[] = [];
  const sleeps: number[] = [];
  const other: string[] = [];
  const browser: BrowserCaller = {
    call: async (method, params) => {
      if (method !== "browser.waitFor") {
        other.push(method);
        return {} as never;
      }
      const p = params as BrowserMethods["browser.waitFor"]["params"];
      slices.push(p);
      if (opts.hang) return new Promise(() => {});
      clock += opts.early ?? p.timeoutMs;
      return { met: null, ...PAGE, fingerprint: `fp${slices.length}`, ...opts.answer?.(slices.length, p) } as never;
    },
  };
  const interjections = new Interjections();
  const traces: TraceDraft[] = [];
  const { events, onEvent } = collect();
  const exec = createToolExecutor({
    browser,
    jev: null,
    jevThreshold: 0.8,
    onEvent,
    mediaPaths: [],
    interjections,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    onTrace: (e) => traces.push(e),
    ...(opts.turnEndsAt !== undefined ? { turnEndsAt: () => opts.turnEndsAt } : {}),
  });
  const span = () => traces.find((e) => e.name === "tool" && e.data?.tool === "wait_for")?.data ?? {};
  return { exec, slices, sleeps, other, interjections, events, span, elapsed: () => clock - T0 };
}

describe("wait_for", () => {
  it("watches the tab in slices until a condition holds: no other browser call, the page's first fingerprint as the baseline", async () => {
    const w = setup({ answer: (n) => (n === 3 ? { met: 1 } : {}) });
    const r = await w.exec.call("wait_for", { tab: "t3", until: [{ kind: "text_appears", text: "Build failed" }, DEPLOYED], minutes: 5 });
    expect(r.isError).toBeUndefined();
    expect(r.text).toBe(`Condition met after 45 s: text "Deployed" appears (t3: ${PAGE.url} "Builder"). Read the page (read_page) to see it.`);
    expect(w.slices.map((s) => s.timeoutMs)).toEqual([WAIT_SLICE_MS, WAIT_SLICE_MS, WAIT_SLICE_MS]);
    expect(w.slices.map((s) => s.baseline)).toEqual([undefined, "fp1", "fp1"]);
    expect(w.slices.every((s) => s.tab === "t3")).toBe(true);
    expect(w.other).toEqual([]);
    expect(w.span()).toMatchObject({ end: "met", waitedMs: 45_000, checks: 3, minutes: 5, met: 'text "Deployed" appears' });
  });

  it("ends when its time is up, the last slice shortened to what is left", async () => {
    const w = setup();
    const r = await w.exec.call("wait_for", { until: [DEPLOYED], minutes: 0.5 });
    expect(r.text).toMatch(/^Not met after 30 s, the time you gave: text "Deployed" appears \(the current tab: https:\/\/builder\.test\/p\/1 "Builder"\)/);
    expect(w.slices.map((s) => s.timeoutMs)).toEqual([15_000, 15_000]);
    expect(w.span()).toMatchObject({ end: "timeout", waitedMs: 30_000 });
  });

  it("answers 'still waiting' after one call's limit, with the minutes left for the next call", async () => {
    const w = setup();
    const r = await w.exec.call("wait_for", { until: [DEPLOYED], minutes: 25 });
    expect(w.elapsed()).toBe(WAIT_CALL_LIMIT_MS);
    expect(r.text).toContain("Still waiting after 10 min 00 s");
    expect(r.text).toContain("call wait_for again with the same until and minutes: 15");
    expect(w.span()).toMatchObject({ end: "call_limit" });
  });

  it("stops before the turn's time limit, and does not start when too little of the turn is left", async () => {
    const w = setup({ turnEndsAt: T0 + 3 * 60_000 });
    const r = await w.exec.call("wait_for", { until: [DEPLOYED], minutes: 10 });
    expect(w.elapsed()).toBe(3 * 60_000 - WAIT_TURN_MARGIN_MS);
    expect(r.text).toMatch(/^Stopped waiting after 2 min 00 s: this turn's time limit is near\..*task_pause/);
    expect(w.span()).toMatchObject({ end: "turn_limit" });

    const late = setup({ turnEndsAt: T0 + 30_000 });
    const r2 = await late.exec.call("wait_for", { until: [DEPLOYED] });
    expect(late.slices).toEqual([]);
    expect(r2.text).toMatch(/^Stopped waiting after 0 s: this turn's time limit is near/);
  });

  it("a message from the user ends the wait at once, even while a slice is watching", async () => {
    const w = setup({ hang: true });
    const pending = w.exec.call("wait_for", { until: [DEPLOYED] });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.slices).toHaveLength(1);
    w.interjections.add("stop waiting, the deploy is cancelled");
    const r = await pending;
    expect(r.text).toBe('Stopped waiting after 0 s: the user sent you a message (it follows). Not met yet: text "Deployed" appears.');
    expect(w.span()).toMatchObject({ end: "user_message", checks: 0 });
  });

  it("a message the model has not read yet ends it before it waits", async () => {
    const w = setup({ hang: true });
    w.interjections.add("actually, reply first");
    const r = await w.exec.call("wait_for", { until: [DEPLOYED] });
    expect(r.text).toMatch(/the user sent you a message/);
  });

  it("a closed tab ends it as an error", async () => {
    const w = setup({ answer: (n) => (n === 2 ? { closed: true, met: null } : {}) });
    const r = await w.exec.call("wait_for", { tab: "t3", until: [DEPLOYED] });
    expect(r).toMatchObject({ isError: true, text: "Stopped waiting after 30 s: t3 was closed." });
    expect(w.span()).toMatchObject({ end: "closed", checks: 2 });
  });

  it("a browser error ends it as an error with the browser's words", async () => {
    const browser: BrowserCaller = { call: async () => Promise.reject(new Error('unknown tab "t9"; call list_tabs')) };
    const traces: TraceDraft[] = [];
    const exec = createToolExecutor({ browser, jev: null, jevThreshold: 0.8, onEvent: () => {}, mediaPaths: [], onTrace: (e) => traces.push(e) });
    const r = await exec.call("wait_for", { tab: "t9", until: [DEPLOYED] });
    expect(r).toMatchObject({ isError: true, text: 'Stopped waiting after 0 s: unknown tab "t9"; call list_tabs' });
    expect(traces.find((e) => e.name === "tool")?.data).toMatchObject({ end: "error" });
  });

  it("slices that answer early (the page was navigating) are asked again after a growing pause", async () => {
    const w = setup({ early: 10, answer: (n) => (n === 7 ? { met: 0 } : {}) });
    await w.exec.call("wait_for", { until: [DEPLOYED] });
    const { firstMs, maxMs } = WAIT_RETRY_BACKOFF;
    expect(w.sleeps).toEqual([firstMs, firstMs * 2, firstMs * 4, firstMs * 8, maxMs, maxMs]);
  });

  it("checks the conditions' arguments", async () => {
    const w = setup();
    const bad = async (until: unknown) => (await w.exec.call("wait_for", { until })).text ?? "";
    expect(await bad([{ kind: "text_appears" }])).toMatch(/text_appears needs text/);
    expect(await bad([{ kind: "element" }])).toMatch(/element needs text \(its label\) or selector/);
    expect(await bad([{ kind: "text_gone", text: "x", state: "visible" }])).toMatch(/state is only for element/);
    expect(await bad([{ kind: "url_matches", text: "/(unclosed/" }])).toMatch(/not a valid regular expression/);
    expect(await bad([])).toMatch(/Invalid arguments for wait_for/);
    expect((await w.exec.call("wait_for", { until: [DEPLOYED], minutes: 31 })).text).toMatch(/Invalid arguments for wait_for: minutes/);
    expect(w.slices).toEqual([]);
  });
});

describe("wait_for and the case file in the system prompt", () => {
  it("says when to wait with wait_for, and (with memory) to keep a case file under the thing's key", async () => {
    const { buildSystemPrompt } = await import("../src/prompts.js");
    const { toolsFor } = await import("@noa/shared");
    const p = buildSystemPrompt({ tools: toolsFor(), jev: false });
    expect(p).toMatch(/- wait_for: Wait, without reading the page again and again/);
    expect(p).toMatch(/call wait_for with what to look for .* when it answers "still waiting", call it again/);
    expect(p).toMatch(/Case file: .*remember with its key the current step, how to reproduce it, what you asked of whom and what you promised.*recall that key first/);
    expect(buildSystemPrompt({ tools: toolsFor().filter((n) => n !== "wait_for" && n !== "remember"), jev: false })).not.toMatch(/wait_for|Case file/);
  });
});
