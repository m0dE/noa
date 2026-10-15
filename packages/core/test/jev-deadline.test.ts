/** A slow Jev: each act step waits for it at most JEV_DEADLINE_MS, and a run stops asking it for a while after JEV_SLOW_LIMIT late answers in a row. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, PageSnapshot, TraceDraft } from "@noa/shared";
import { OutOfCreditError } from "../src/api-errors.js";
import { createActGate, JEV_BACK_NOTE, jevPausedNote, listMode, runAct } from "../src/act.js";
import { createToolExecutor } from "../src/executor.js";
import { WORDS_HEADING } from "../src/page-format.js";
import { JEV_DEADLINE_MS, JEV_SKIP_MS, JEV_SLOW_LIMIT, jevFromClient, JevSlowError, withoutCreditPause, type JevClientLike } from "../src/jev.js";
import { noSleep } from "./helpers.js";

const PAGE: PageSnapshot = {
  url: "https://cloud.example/projects",
  title: "Projects",
  text: "Projects",
  truncated: false,
  elements: Array.from({ length: 6 }, (_, i) => ({ index: i, tag: "button", role: "button", name: i === 4 ? "Delete" : `b${i}`, inViewport: true })),
};
const ANSWER = { operation: { choice: "click", confidence: 0.95 }, target: { choice: "4", confidence: 0.95 } };

/**
 * A systemOne client that answers each request after `delays[i]` ms (the last one repeats), and stops at the
 * request's abort signal, as the proxy client and TypeSafe's SDK do. ignoreAbort: never stops.
 */
function slowClient(delays: number[], { ignoreAbort = false } = {}) {
  const log: { at: number; aborted: boolean; answered: boolean }[] = [];
  const client: JevClientLike = {
    systemOne(_request, options) {
      const delay = delays[Math.min(log.length, delays.length - 1)]!;
      const entry = { at: Date.now(), aborted: false, answered: false };
      log.push(entry);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => ((entry.answered = true), resolve({ answers: ANSWER })), delay);
        if (ignoreAbort) return;
        options?.signal?.addEventListener("abort", () => {
          entry.aborted = true;
          clearTimeout(timer);
          reject(new Error("This operation was aborted"));
        });
      });
    },
  };
  return { client, log };
}

/** decide() with the fake clock run until it settles; resolves to its decision or its error. */
async function decideNow(jev: ReturnType<typeof jevFromClient>): Promise<{ ok: true; ms: number } | { ok: false; err: unknown; ms: number }> {
  const started = Date.now();
  const p = jev.decide({ goal: "click Delete", snapshot: PAGE }).then(
    () => ({ ok: true as const, ms: Date.now() - started }),
    (err: unknown) => ({ ok: false as const, err, ms: Date.now() - started }),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  return p;
}

describe("Jev's deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the numbers: a 3 s deadline, a skip after 2 late answers in a row, for 60 s", () => {
    expect([JEV_DEADLINE_MS, JEV_SLOW_LIMIT, JEV_SKIP_MS]).toEqual([3_000, 2, 60_000]);
  });

  it("fast Jev: every answer is used, however many steps", async () => {
    const { client, log } = slowClient([450, 1950, 300]);
    const jev = jevFromClient(client);
    for (let i = 0; i < 10; i++) {
      const r = await decideNow(jev);
      expect(r.ok).toBe(true);
    }
    expect(log).toHaveLength(10);
    expect(log.every((r) => r.answered && !r.aborted)).toBe(true);
  });

  it("an answer slower than the deadline is dropped at the deadline (the request aborted) with JevSlowError", async () => {
    const { client, log } = slowClient([12_000]);
    const r = await decideNow(jevFromClient(client));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.err).toBeInstanceOf(JevSlowError);
    expect((r.err as JevSlowError).skipped).toBe(false);
    expect((r.err as Error).message).toBe("Jev did not answer within 3 s");
    expect(r.ms).toBe(JEV_DEADLINE_MS);
    expect(log[0]).toMatchObject({ aborted: true, answered: false });
  });

  it("holds the deadline even when the client does not stop at the abort", async () => {
    const { client } = slowClient([12_000], { ignoreAbort: true });
    const r = await decideNow(jevFromClient(client));
    expect(r.ok).toBe(false);
    expect(r.ms).toBe(JEV_DEADLINE_MS);
  });

  it("each smaller try (after max_tokens_exceeded) has its own deadline: a page that needs them is not a slow Jev", async () => {
    /** Tries refused as too long after 1.2 s each but the last, which answers after `last` ms (abort stops it). */
    const refusing = (last: number) => {
      const sizes: number[] = [];
      const client: JevClientLike = {
        systemOne: (req, options) =>
          new Promise((resolve, reject) => {
            sizes.push(req.state.elements.length);
            const third = sizes.length % 3 === 0;
            const timer = setTimeout(() => (third ? resolve({ answers: ANSWER }) : reject(new Error("Jev HTTP 400: max_tokens_exceeded"))), third ? last : 1_200);
            options?.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))));
          }),
      };
      return { client, sizes };
    };
    // 1.2 + 1.2 + 1.2 s: past one 3 s deadline in all, but every request was answered in time.
    const big = refusing(1_200);
    const jev = jevFromClient(big.client);
    for (let i = 0; i < 2; i++) {
      const r = await decideNow(jev);
      expect(r).toMatchObject({ ok: true, ms: 3_600 });
    }
    expect(big.sizes).toHaveLength(6);
    // Not counted as late: two such steps in a row do not pause Jev.
    expect(jev.paused?.()).toBeNull();
    // A smaller try that is itself late is: it fails at its own deadline (1.2 + 1.2 + 3 s) and counts toward the skip.
    const slowLast = refusing(12_000);
    const jev2 = jevFromClient(slowLast.client);
    const r1 = await decideNow(jev2);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.err).toBeInstanceOf(JevSlowError);
    expect(r1.ms).toBe(2_400 + JEV_DEADLINE_MS);
    await decideNow(jev2);
    expect(jev2.paused?.()).toMatchObject({ retry: false });
    const skipped = await decideNow(jev2);
    expect(skipped.ok === false && (skipped.err as JevSlowError).skipped).toBe(true);
    expect(slowLast.sizes).toHaveLength(6);
    // Fast refusals still get the halving retry and an answer.
    let m = 0;
    const quick: JevClientLike = { systemOne: async () => (++m < 3 ? Promise.reject(new Error("Jev HTTP 400: max_tokens_exceeded")) : { answers: ANSWER }) };
    expect((await decideNow(jevFromClient(quick))).ok).toBe(true);
    expect(m).toBe(3);
  });

  it("after 2 late answers in a row the run stops asking Jev for 60 s, then asks again: in time ends the skipping", async () => {
    const { client, log } = slowClient([12_000, 12_000, 400]);
    const jev = jevFromClient(client);
    const first = await decideNow(jev);
    const second = await decideNow(jev);
    expect([first.ok, second.ok]).toEqual([false, false]);
    expect(log).toHaveLength(2);
    // Skipped: not asked, at once.
    const skipped = await decideNow(jev);
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) {
      expect(skipped.err).toBeInstanceOf(JevSlowError);
      expect((skipped.err as JevSlowError).skipped).toBe(true);
      expect((skipped.err as Error).message).toMatch(/^Jev was slower than 3 s on 2 steps in a row, so it is not asked for \d+(\.\d)? s$/);
    }
    expect(log).toHaveLength(2);
    // decideNow moved the clock 20 s per call; past the skip, Jev is asked again, answers in time, and is used from then on.
    await vi.advanceTimersByTimeAsync(JEV_SKIP_MS);
    const probe = await decideNow(jev);
    expect(probe.ok).toBe(true);
    expect(log).toHaveLength(3);
    expect((await decideNow(jev)).ok).toBe(true);
    expect(log).toHaveLength(4);
  });

  it("a late answer after the skip starts another skip at once; one late answer alone does not skip", async () => {
    const { client, log } = slowClient([12_000, 12_000, 12_000, 400, 12_000, 400, 12_000]);
    const jev = jevFromClient(client);
    await decideNow(jev);
    await decideNow(jev);
    await vi.advanceTimersByTimeAsync(JEV_SKIP_MS);
    const probe = await decideNow(jev);
    expect(probe.ok).toBe(false);
    expect(log).toHaveLength(3);
    const again = await decideNow(jev);
    expect(again.ok === false && (again.err as JevSlowError).skipped).toBe(true);
    expect(log).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(JEV_SKIP_MS);
    // In time, late, in time, late: never two in a row, so never skipped.
    for (const ok of [true, false, true, false]) expect((await decideNow(jev)).ok).toBe(ok);
    expect(log).toHaveLength(7);
  });

  it("each JevLike (one per run) keeps its own count", async () => {
    const slow = slowClient([12_000]);
    const a = jevFromClient(slow.client);
    await decideNow(a);
    await decideNow(a);
    const b = jevFromClient(slow.client);
    const r = await decideNow(b);
    expect(r.ok === false && (r.err as JevSlowError).skipped).toBe(false);
    expect(slow.log).toHaveLength(3);
  });

  it("no usage credit is still OutOfCreditError (not slowness), and the cloud Jev's no-credit switch-off still works", async () => {
    const client: JevClientLike = { systemOne: async () => Promise.reject(new OutOfCreditError("Out of usage credit")) };
    const r = await decideNow(jevFromClient(client));
    expect(r.ok === false && r.err).toBeInstanceOf(OutOfCreditError);
    const off = withoutCreditPause(jevFromClient(client));
    const first = off.decide({ goal: "g", snapshot: PAGE });
    await expect(first).rejects.toThrow("Noa's cloud Jev: Out of usage credit");
    await expect(off.decide({ goal: "g", snapshot: PAGE })).rejects.toThrow("Noa's cloud Jev: Out of usage credit");
  });
});

describe("act with a slow Jev", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a step past the deadline is left to the model with candidates; once skipped, the next act stops at once; the model's index pick runs", async () => {
    const { client, log } = slowClient([12_000]);
    const jev = jevFromClient(client);
    const events: AgentEvent[] = [];
    const clicks: number[] = [];
    const gate = createActGate();
    const ctx = {
      browser: (async (method: string, params: { index?: number }) => {
        if (method === "browser.readPage") return PAGE;
        if (method === "browser.click") clicks.push(params.index!);
        return { ok: true };
      }) as never,
      jev,
      jevThreshold: 0.8,
      sleep: noSleep,
      emit: (e: AgentEvent) => void events.push(e),
      outOfCredit: () => ({ text: "out of credit", isError: true }),
      gate,
    };
    const act = async (steps: Parameters<typeof runAct>[0]) => {
      const p = runAct(steps, ctx);
      await vi.advanceTimersByTimeAsync(20_000);
      return p;
    };
    const first = await act([{ goal: "click Delete" }]);
    expect(first.text).toContain('step 1: "click Delete": Jev did not answer within 3 s');
    expect(first.text).toContain("not confident at step 1");
    expect(first.text).toMatch(/\[4\] button "Delete"/);
    const second = await act([{ goal: "click b2" }]);
    expect(second.text).toContain('step 1: "click b2": Jev did not answer within 3 s');
    const third = await act([{ goal: "click b3" }]);
    expect(third.text).toMatch(/step 1: "click b3": Jev was slower than 3 s on 2 steps in a row, so it is not asked for/);
    expect(log).toHaveLength(2);
    const jevEvents = events.filter((e) => e.type === "jev");
    expect(jevEvents.map((e) => e.type === "jev" && [e.operation, e.ms])).toEqual([
      ["slow", JEV_DEADLINE_MS],
      ["slow", JEV_DEADLINE_MS],
      ["skipped", 0],
    ]);
    // The model picks from the candidates it was given.
    const picked = await act([{ goal: "click b3", index: 3 }]);
    expect(picked.text).toContain("(picked by Claude)");
    expect(clicks).toEqual([3]);
  });
});

describe("a paused Jev (too slow for this run): index mode until it answers in time again", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A tool executor over PAGE with a Jev that answers after `delays` (see slowClient). */
  function setupRun(delays: number[]) {
    const { client, log } = slowClient(delays);
    const jev = jevFromClient(client);
    const clicks: number[] = [];
    const traces: TraceDraft[] = [];
    const exec = createToolExecutor({
      browser: {
        call: (async (method: string, params: { index?: number }) => {
          if (method === "browser.readPage") return PAGE;
          if (method === "browser.click") clicks.push(params.index!);
          return { ok: true };
        }) as never,
      },
      jev,
      jevThreshold: 0.8,
      onEvent: () => {},
      onTrace: (e) => void traces.push(e),
      mediaPaths: [],
      sleep: noSleep,
    });
    const call = async (name: "read_page" | "act", args: unknown) => {
      const p = exec.call(name, args);
      await vi.advanceTimersByTimeAsync(20_000);
      return (await p).text ?? "";
    };
    return { jev, log, clicks, traces, call };
  }
  const INDEXED = /^\[4\] button "Delete"/m;
  const SLOW = { why: "it was slower than 3 s on 2 steps in a row", retry: false };

  it("2 late answers pause it: read_page and act list index numbers and say why, index steps run, Jev is not asked", async () => {
    const { jev, log, clicks, call } = setupRun([12_000]);
    const words = await call("read_page", {});
    expect(words).toContain(WORDS_HEADING);
    expect(words).not.toMatch(INDEXED);
    // Late once: candidates for that step, still in Jev mode.
    const first = await call("act", { steps: [{ goal: "click Delete" }] });
    expect(first).toContain("Jev was not sure which element step 1 means");
    expect(jev.paused?.()).toBeNull();
    // Late twice: paused. The result is the whole list with index numbers, saying why.
    const second = await call("act", { steps: [{ goal: "click b2" }, { goal: "click b3" }] });
    expect(second).toContain('step 1: "click b2": Jev did not answer within 3 s');
    expect(second).toContain(jevPausedNote(SLOW));
    expect(second).toContain("and the rest by index too");
    expect(second).toMatch(INDEXED);
    expect(jev.paused?.()).toEqual(SLOW);
    // Index steps that no candidate list offered run directly, without asking Jev; the page after has index numbers.
    const picked = await call("act", { steps: [{ goal: "click b2", index: 2 }, { goal: "click Delete", index: 4 }] });
    expect(picked).toContain("All 2 step(s) done");
    expect(picked).toContain("step 2: clicked [4] (picked by Claude)");
    expect(picked).toContain(jevPausedNote(SLOW));
    expect(picked).toMatch(INDEXED);
    expect(clicks).toEqual([2, 4]);
    expect(log).toHaveLength(2);
    const read = await call("read_page", {});
    expect(read.startsWith(jevPausedNote(SLOW))).toBe(true);
    expect(read).not.toContain(WORDS_HEADING);
    expect(read).toMatch(INDEXED);
  });

  it("past the skip, an index step asks Jev on the side; in time, the next result is in words, says Jev is back, and index steps are refused again", async () => {
    const { jev, log, clicks, traces, call } = setupRun([12_000, 12_000, 400]);
    await call("read_page", {});
    await call("act", { steps: [{ goal: "click Delete" }] });
    await call("act", { steps: [{ goal: "click b2" }] });
    expect(jev.paused?.()?.retry).toBe(false);
    await vi.advanceTimersByTimeAsync(JEV_SKIP_MS);
    expect(jev.paused?.()?.retry).toBe(true);
    // The model's index runs at once; Jev is asked about the same step meanwhile (its answer is not used).
    const probed = await call("act", { steps: [{ goal: "click b2", index: 2 }] });
    expect(probed).toContain("step 1: clicked [2] (picked by Claude)");
    expect(clicks).toEqual([2]);
    expect(log).toHaveLength(3);
    expect(traces.filter((t) => t.name === "jev.probe").map((t) => t.data)).toEqual([{ goal: "click b2", inTime: true, operation: "click", confidence: 0.95 }]);
    expect(jev.paused?.()).toBeNull();
    // The model's last list had index numbers: its index steps still run, and this result switches back to words.
    const back = await call("act", { steps: [{ goal: "click b3", index: 3 }] });
    expect(back).toContain("step 1: clicked [3] (picked by Claude)");
    expect(back).toContain(JEV_BACK_NOTE);
    expect(back).toContain(WORDS_HEADING);
    expect(back).not.toMatch(INDEXED);
    // Word mode again: an index without candidates is refused, and Jev picks from words.
    const refused = await call("act", { steps: [{ goal: "click Delete", index: 4 }] });
    expect(refused).toContain("act refused; nothing was run.");
    const jevPick = await call("act", { steps: [{ goal: "click Delete" }] });
    expect(jevPick).toContain("(picked by Jev");
    expect(clicks).toEqual([2, 3, 4]);
    const read = await call("read_page", {});
    expect(read).not.toContain(JEV_BACK_NOTE);
    expect(read).toContain(WORDS_HEADING);
  });

  it("past the skip, an index step clicks the element the model's list numbered, even on a changed page: no read before it acts", async () => {
    // A page that renumbers its elements on each read, as the extension does: after a new element at the top, every
    // element's number moves up one. A click goes by the numbers of the last read.
    let names = PAGE.elements.map((e) => e.name);
    let numbered = names;
    const calls: string[] = [];
    const clicked: string[] = [];
    const read = (): PageSnapshot => {
      numbered = names;
      return { ...PAGE, elements: names.map((name, index) => ({ index, tag: "button", role: "button", name, inViewport: true })) };
    };
    const { client, log } = slowClient([12_000, 12_000, 400]);
    const jev = jevFromClient(client);
    const traces: TraceDraft[] = [];
    const exec = createToolExecutor({
      browser: {
        call: (async (method: string, params: { index?: number }) => {
          calls.push(method);
          if (method === "browser.readPage") return read();
          if (method === "browser.click") clicked.push(numbered[params.index!]!);
          return { ok: true };
        }) as never,
      },
      jev,
      jevThreshold: 0.8,
      onEvent: () => {},
      onTrace: (e) => void traces.push(e),
      mediaPaths: [],
      sleep: noSleep,
    });
    const call = async (name: "read_page" | "act", args: unknown) => {
      const p = exec.call(name, args);
      await vi.advanceTimersByTimeAsync(20_000);
      return (await p).text ?? "";
    };
    await call("act", { steps: [{ goal: "click Delete" }] });
    const paused = await call("act", { steps: [{ goal: "click b2" }] });
    expect(paused).toMatch(/^\[2\] button "b2"/m);
    await vi.advanceTimersByTimeAsync(JEV_SKIP_MS);
    expect(jev.paused?.()?.retry).toBe(true);
    names = ["New post", ...names];
    calls.length = 0;
    const r = await call("act", { steps: [{ goal: "click b2", index: 2 }] });
    expect(r).toContain("step 1: clicked [2] (picked by Claude)");
    expect(clicked).toEqual(["b2"]);
    expect(calls[0]).toBe("browser.click");
    expect(calls.filter((m) => m === "browser.readPage")).toHaveLength(1);
    // Jev was still asked on the side, with the page read for the result.
    expect(log).toHaveLength(3);
    expect(traces.filter((t) => t.name === "jev.probe").map((t) => t.data?.inTime)).toEqual([true]);
    expect(jev.paused?.()).toBeNull();
  });

  it("past the skip, a late probe pauses it again: lists keep their index numbers", async () => {
    const { jev, log, traces, call } = setupRun([12_000]);
    await call("act", { steps: [{ goal: "click Delete" }] });
    await call("act", { steps: [{ goal: "click b2" }] });
    await vi.advanceTimersByTimeAsync(JEV_SKIP_MS);
    await call("act", { steps: [{ goal: "click b2", index: 2 }, { goal: "click b3", index: 3 }] });
    // One probe per act call, not one per step.
    expect(log).toHaveLength(3);
    expect(traces.filter((t) => t.name === "jev.probe").map((t) => t.data?.inTime)).toEqual([false]);
    expect(jev.paused?.()?.retry).toBe(false);
    const read = await call("read_page", {});
    expect(read).toMatch(INDEXED);
    expect(read.startsWith(jevPausedNote(SLOW))).toBe(true);
  });

  it("Jev off for lack of credit (the cloud Jev's switch-off) is paused too: index mode for the rest of the run", async () => {
    const off = withoutCreditPause(jevFromClient({ systemOne: async () => Promise.reject(new OutOfCreditError("Out of usage credit")) }));
    expect(off.paused?.()).toBeNull();
    await expect(off.decide({ goal: "g", snapshot: PAGE })).rejects.toThrow("Noa's cloud Jev: Out of usage credit");
    const pause = { why: "Noa's cloud Jev: Out of usage credit", retry: false };
    expect(off.paused?.()).toEqual(pause);
    const gate = createActGate();
    expect(listMode(off, gate)).toEqual({ words: false, note: jevPausedNote(pause) });
    expect(gate.listed).toBe("indices");
  });
});

describe("the skip window runs on a monotonic clock", () => {
  it("setting the wall clock back (or forward) neither stretches nor ends the skip", async () => {
    const late = { systemOne: () => new Promise<never>(() => undefined) } as unknown as JevClientLike;
    const jev = jevFromClient(late, { deadlineMs: 20, slowLimit: 2, skipMs: 60_000 });
    await expect(jev.decide({ goal: "g", snapshot: PAGE })).rejects.toThrow(JevSlowError);
    await expect(jev.decide({ goal: "g", snapshot: PAGE })).rejects.toThrow(JevSlowError);
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow - 3_600_000);
    try {
      const back = (await jev.decide({ goal: "g", snapshot: PAGE }).catch((e: unknown) => e)) as JevSlowError;
      expect(back.skipped).toBe(true);
      expect(back.message).toMatch(/not asked for (60|59) s/);
      spy.mockReturnValue(realNow + 3_600_000);
      expect(((await jev.decide({ goal: "g", snapshot: PAGE }).catch((e: unknown) => e)) as JevSlowError).skipped).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
