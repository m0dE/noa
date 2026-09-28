/**
 * Regression tests from a production trace (scheduled cloud TODO run "Post one new original post on X as
 * @rooftopchat", Claude Code + Jev): act step 2 "click the Post button" read the page at +38.88 s, then its
 * browser.click only started at +532.84 s (the gate held it: the traced call's clock starts inside the gate).
 * Meanwhile the user opened voice and sent two messages (interjections at +509.29 and +519.82, both delivered
 * only when act returned at +533.47), the Post click went out at +532.84, and the run ended
 * "paused · Stopped by the user" at +537.81. The post went live.
 *
 * What must hold: a waiting approval ends as allowed only by an explicit Allow; a message from the user or
 * Stop ends it as not done at once; an unattended scheduled run does not wait silently for minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentEvent, type BrowserMethod, type PageSnapshot, type TraceEvent } from "@noa/shared";
import type { BrowserCaller } from "@noa/core";
import { ApprovalBroker } from "../../src/approval/broker.js";
import { ApprovalGate } from "../../src/approval/gate.js";
import type { SystemOneLike } from "../../src/approval/jev-judge.js";
import type { AgentSlot, SlotPool } from "../../src/agent-slots.js";
import { Runner } from "../../src/engine/runner.js";
import { harness, runAll, setupRunnerTests } from "../runner/harness.js";
import { el } from "./cases.js";

const INSTRUCTIONS = "Post one new original post on X as @rooftopchat";
/**
 * The trace's task asks for a post on X, so its Post click now runs (the task's words win over Jev). The tests of what
 * happens while a click waits use this one instead: it asks for a post but names no site, so Jev decides, and says no.
 */
const SITE_UNNAMED = "Post one new original post";
const POST_TEXT = "Sunday 1pm on the rooftop: bring a friend.";
const editor = el("textbox", "Post text", { tag: "div", testId: "tweetTextarea_0", index: 42 });
const postBtn = el("button", "Post", { testId: "tweetButtonInline", index: 43 });
const X_HOME: PageSnapshot = { url: "https://x.com/home", title: "Home / X", text: "What is happening?!", elements: [editor, postBtn], truncated: false };

/** A browser that records what ran (the page is always X's home composer). */
function fakeBrowser() {
  const ran: BrowserMethod[] = [];
  const browser: BrowserCaller = {
    call: async (method) => {
      ran.push(method);
      return (method === "browser.readPage" ? X_HOME : { ok: true }) as never;
    },
  };
  return { browser, ran, clicked: () => ran.includes("browser.click") };
}

/** Jev as it may answer for the Post click: it publishes, and (a sure "no") the task does not ask for it. */
const jevVeto: SystemOneLike = {
  systemOne: async () => ({ answers: { consequence: { choice: "publish", confidence: 0.97 }, within: { choice: "no", confidence: 0.9 } } }),
};

/** A promise's state without waiting for it. */
async function stateOf(p: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  let s: "pending" | "resolved" | "rejected" = "pending";
  p.then(
    () => (s = "resolved"),
    () => (s = "rejected"),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return s;
}

describe("a scheduled run's Post click that needs approval (unattended)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T13:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("does not wait silently for minutes: the click is refused (not done) promptly instead of hanging until someone answers", async () => {
    const b = fakeBrowser();
    const events: AgentEvent[] = [];
    const notified: string[] = [];
    const broker = new ApprovalBroker({ note: (_s, e) => void events.push(e), newId: () => "ap1", onRequest: (_s, r) => void notified.push(r.action) });
    const gate = new ApprovalGate(b.browser, () => "sched-1", {
      context: async () => ({ level: "full_within_task", instructions: SITE_UNNAMED }),
      request: (s, ask, opts) => broker.request(s, ask, opts),
      jev: () => jevVeto,
    });
    await gate.browser.call("browser.readPage", {});
    await gate.browser.call("browser.type", { index: 42, text: POST_TEXT });
    const click = gate.browser.call("browser.click", { index: 43 });
    click.catch(() => {});
    // The trace: 8 min 14.3 s from the page read to the click.
    await vi.advanceTimersByTimeAsync(494_000);
    const state = await stateOf(click);
    const waiting = broker.waiting("sched-1").map((r) => r.action);
    console.log(`[repro] after 494 s: click promise ${state}; waiting approvals ${JSON.stringify(waiting)}; clicked=${b.clicked()}; notifications ${JSON.stringify(notified)}`);
    expect(b.clicked()).toBe(false);
    // An unattended scheduled run must not sit on an approval for minutes: the click is settled (refused) long before.
    expect(state).toBe("rejected");
    expect(waiting).toEqual([]);
  });
});

// ------------------------------------------------------------------ the runner: interjections and Stop

setupRunnerTests();

/**
 * One agent slot whose browser passes the real approval gate and broker, and whose release ends the session's
 * waiting approvals, as AgentSlots does (agent-slots.ts: take/release).
 */
function gatedSlot(h: ReturnType<typeof harness>, jev: SystemOneLike | null = null) {
  const b = fakeBrowser();
  const events: AgentEvent[] = [];
  const traces: TraceEvent[] = [];
  let sessionId: string | null = null;
  const broker = new ApprovalBroker({
    note: async (s, e) => {
      events.push(e);
      if (!(await h.sessions.note(s, e))) throw new Error(`No conversation ${s}`);
    },
    newId: () => `ap${events.length}`,
    trace: (_s, row) => void traces.push(row),
  });
  const gate = new ApprovalGate(b.browser, () => sessionId, {
    context: (s) => h.runner.gateContext(s),
    request: (s, ask, opts) => broker.request(s, ask, opts),
    jev: () => jev,
    trace: (_s, row) => void traces.push(row),
  });
  const slot: AgentSlot = {
    index: 0,
    prepare: async () => 7,
    browser: gate.browser,
    isAgentTab: async (tabId) => tabId === 7,
    screenshot: async () => ({ base64: btoa("JPG"), mimeType: "image/jpeg" }),
    onWait: () => () => {},
  };
  const pool: SlotPool = {
    size: 1,
    take: (_i, s) => {
      sessionId = s;
      gate.release();
      return slot;
    },
    release: (_i, s) => {
      if (sessionId !== s) return;
      sessionId = null;
      gate.release();
      broker.end(s);
    },
    endChat: async () => {},
  };
  return { b, broker, events, traces, pool, slot };
}

/**
 * A run like Claude Code's: its act tool is in the middle of step 2 (the Post click, waiting in the gate), and the
 * turn's result only comes once that tool call returns (the helper's MCP call to the extension is still open).
 */
function postingRun(h: ReturnType<typeof harness>, g: ReturnType<typeof gatedSlot>) {
  const click: { promise: Promise<unknown> | null } = { promise: null };
  h.brain.script = (_opts, ctl) => {
    void (async () => {
      await g.slot.browser.call("browser.readPage", {});
      await g.slot.browser.call("browser.type", { index: 42, text: POST_TEXT });
      click.promise = g.slot.browser.call("browser.click", { index: 43 });
      const r = await click.promise.then(
        () => ({ ok: true }),
        (e: unknown) => ({ ok: false, e }),
      );
      // The tool call returned: now the turn can end (stopped, or on its own).
      ctl.resolve(ctl.aborts.length ? { outcome: "paused", reason: ctl.aborts[0]!.reason } : r.ok ? { outcome: "done", summary: "posted" } : { outcome: "paused", reason: "not approved" });
    })();
    return "hang";
  };
  // Aborting does not end the run by itself while the tool call is open (see above): FakeBrain.abort resolves
  // `done` with this, a promise that never settles; the script above resolves it once the click returns.
  h.brain.onAbort = () => new Promise<never>(() => {}) as never;
  return click;
}

describe("Runner: an approval waiting while the user interjects and stops (production trace)", () => {
  function setup() {
    const h = harness({ automationLevel: "ask_consequential" });
    const g = gatedSlot(h);
    h.deps.slots = g.pool;
    h.runner = new Runner(h.deps);
    const click = postingRun(h, g);
    return { h, g, click };
  }

  it("a message from the user while the Post click waits ends that approval (not done); a later Allow cannot post", async () => {
    const { h, g, click } = setup();
    const { sessionId } = await h.runner.runAdhoc({ instructions: INSTRUCTIONS });
    await vi.waitFor(() => expect(g.broker.waiting(sessionId)).toHaveLength(1));
    const card = g.broker.waiting(sessionId)[0]!;
    console.log(`[repro] approval waiting: ${card.action} on ${card.site} (${card.why}), text ${JSON.stringify(card.text)}`);
    // +509.29 and +519.82: the user's two messages.
    await h.runner.say("So why is it talking about Sunday 1 PM on the rooftop?", sessionId, { voice: true });
    await h.runner.say("I'm asking you a question", sessionId, { voice: true });
    await new Promise((r) => setTimeout(r, 20));
    const stillWaiting = g.broker.waiting(sessionId).map((r) => r.id);
    console.log(`[repro] after two messages: approvals still waiting ${JSON.stringify(stillWaiting)}; clicked=${g.b.clicked()}`);
    // Whatever answers the old card now must not post.
    const late = g.broker.answer(sessionId, card.id, "allow_once");
    await click.promise!.catch(() => {});
    console.log(`[repro] a late allow_once was ${late ? "accepted" : "refused"}; clicked=${g.b.clicked()}`);
    expect(stillWaiting).toEqual([]);
    expect(g.b.clicked()).toBe(false);
    h.runner.stop(sessionId);
  });

  it("Stop while the Post click waits ends the approval at once; a later Allow cannot post", async () => {
    const { h, g, click } = setup();
    const { sessionId } = await h.runner.runAdhoc({ instructions: INSTRUCTIONS });
    await vi.waitFor(() => expect(g.broker.waiting(sessionId)).toHaveLength(1));
    const card = g.broker.waiting(sessionId)[0]!;
    expect(h.runner.stop(sessionId)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const stillWaiting = g.broker.waiting(sessionId).map((r) => r.id);
    const resolved = g.events.filter((e) => e.type === "approval_resolved");
    console.log(`[repro] after Stop: approvals still waiting ${JSON.stringify(stillWaiting)}; resolved ${JSON.stringify(resolved)}`);
    const late = g.broker.answer(sessionId, card.id, "allow_once");
    await click.promise!.catch(() => {});
    console.log(`[repro] after Stop, a late allow_once was ${late ? "accepted" : "refused"}; clicked=${g.b.clicked()}`);
    expect(stillWaiting).toEqual([]);
    expect(resolved).toEqual([{ type: "approval_resolved", id: card.id, outcome: "ended" }]);
    expect(g.b.clicked()).toBe(false);
  });
});

// ------------------------------------------------------------------ (d) unattended scheduled runs, (e) the Jev veto in the trace

const NEEDS_OK = 'Needs your OK to: Click "Post" (publishes) — open to allow';

describe("Runner: a scheduled run whose Post click needs approval", () => {
  function scheduled(opts: { watching?: boolean } = {}) {
    const h = harness({ automationLevel: "ask_consequential", scheduledAutomation: "full_within_task" });
    const g = gatedSlot(h, jevVeto);
    h.deps.slots = g.pool;
    if (opts.watching !== undefined) h.deps.watching = async () => opts.watching!;
    h.runner = new Runner(h.deps);
    const click = postingRun(h, g);
    // Pausing ends the run with the runner's reason (the click has already returned refused).
    h.brain.onAbort = (reason, outcome) => ({ outcome: outcome as "paused", reason });
    return { h, g, click };
  }

  it("nobody watching: pauses at once with what needs the OK; the card stays in the thread; the TODO row needs you; one notification says what", async () => {
    const { h, g } = scheduled();
    const task = await h.store.add({ instructions: SITE_UNNAMED, account: null });
    const started = Date.now();
    await runAll(h);
    const [session] = await h.sessions.list(5, task.id);
    expect(session).toMatchObject({ outcome: "paused", reason: NEEDS_OK });
    expect(await h.store.get(task.id)).toMatchObject({ status: "paused", pauseReason: NEEDS_OK });
    expect(g.b.clicked()).toBe(false);
    expect(g.broker.waiting()).toEqual([]);
    // The card: asked, then ended as paused (kept, not answered by anyone).
    const approvals = g.events.filter((e) => e.type === "approval_request" || e.type === "approval_resolved");
    expect(approvals.map((e) => e.type)).toEqual(["approval_request", "approval_resolved"]);
    expect(approvals[1]).toMatchObject({ outcome: "paused" });
    expect(h.notifications).toEqual([{ title: "Task paused", message: NEEDS_OK }]);
    // Not minutes: no timer had to run out.
    expect(Date.now() - started).toBeLessThan(5_000);
    // The trace: the gate's verdicts (the task asks for a post but says not where, and Jev said no) and what ended the approval.
    const judge = g.traces.find((t) => t.name === "approval.judge");
    expect(judge?.data).toMatchObject({ action: 'Click "Post"', level: "full_within_task", withinRules: "unsure", withinJev: "no 0.90", within: false, waits: true });
    expect(g.traces.find((t) => t.name === "approval.wait")?.data).toMatchObject({ outcome: "paused", by: "unattended" });
  });

  it("its conversation open in a side panel: the card waits for the user, and Allow posts", async () => {
    const { h, g, click } = scheduled({ watching: true });
    await h.store.add({ instructions: SITE_UNNAMED, account: null });
    const done = runAll(h);
    await vi.waitFor(() => expect(g.broker.waiting()).toHaveLength(1));
    const [card] = g.broker.waiting();
    expect(g.b.clicked()).toBe(false);
    const sessionId = (await h.sessions.list(1))[0]!.sessionId;
    expect(g.broker.answer(sessionId, card!.id, "allow_once", "keyboard")).toBe(true);
    await click.promise;
    await done;
    expect(g.b.clicked()).toBe(true);
    expect(g.traces.find((t) => t.name === "approval.wait")?.data).toMatchObject({ outcome: "allow_once", by: "keyboard" });
  });
});

describe("Runner: the trace's own task (a post on X as an account)", () => {
  it("posts on its own: the task asks for that post on that site, so Jev's no does not pause it", async () => {
    const h = harness({ automationLevel: "ask_consequential", scheduledAutomation: "full_within_task" });
    const g = gatedSlot(h, jevVeto);
    h.deps.slots = g.pool;
    h.runner = new Runner(h.deps);
    const click = postingRun(h, g);
    const task = await h.store.add({ instructions: INSTRUCTIONS, account: null });
    await runAll(h);
    await click.promise;
    expect(g.b.clicked()).toBe(true);
    expect(g.events.filter((e) => e.type === "approval_request")).toEqual([]);
    expect((await h.store.get(task.id))?.status).not.toBe("paused");
    expect(g.traces.find((t) => t.name === "approval.judge")?.data).toMatchObject({ withinRules: "yes", withinJev: null, within: true, waits: false });
  });

  it("the same words written by the agent (a page may have put them there) pause for the user's OK; after Trust they post", async () => {
    const h = harness({ automationLevel: "ask_consequential", scheduledAutomation: "full_within_task" });
    const g = gatedSlot(h, jevVeto);
    h.deps.slots = g.pool;
    h.runner = new Runner(h.deps);
    postingRun(h, g);
    h.brain.onAbort = (reason, outcome) => ({ outcome: outcome as "paused", reason });
    const task = await h.store.add({ instructions: INSTRUCTIONS, account: null, agentAuthored: true });
    await runAll(h);
    expect(g.b.clicked()).toBe(false);
    expect(await h.store.get(task.id)).toMatchObject({ status: "paused", pauseReason: NEEDS_OK });
    expect(g.traces.find((t) => t.name === "approval.judge")?.data).toMatchObject({ level: "ask_consequential", waits: true });

    // Trust on the TODO row (tasks.update with agentAuthored: false), then Continue.
    await h.store.update(task.id, { agentAuthored: false });
    await h.store.retry(task.id);
    const click = postingRun(h, g);
    await runAll(h);
    await click.promise;
    expect(g.b.clicked()).toBe(true);
  });
});

describe("ApprovalGate: attended waits end as not done, never as allowed", () => {
  it("no answer in time denies (the click does not run)", async () => {
    vi.useFakeTimers();
    try {
      const b = fakeBrowser();
      const broker = new ApprovalBroker({ note: () => {}, newId: () => "ap1", timeoutMs: 60_000 });
      const gate = new ApprovalGate(b.browser, () => "chat-1", { context: async () => ({ level: "ask_consequential", attended: true }), request: (s, ask, opts) => broker.request(s, ask, opts) });
      await gate.browser.call("browser.readPage", {});
      await gate.browser.call("browser.type", { index: 42, text: POST_TEXT });
      const click = gate.browser.call("browser.click", { index: 43 });
      const refused = expect(click).rejects.toThrow(/No answer in time/);
      await vi.advanceTimersByTimeAsync(60_000);
      await refused;
      expect(b.clicked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a run stopped while its action was judged does not act, even at full autonomy", async () => {
    const b = fakeBrowser();
    let stopped = false;
    const gate = new ApprovalGate(b.browser, () => "chat-1", { context: async () => ({ level: "full", stopped: () => stopped }), request: async () => "allow_once" });
    await gate.browser.call("browser.readPage", {});
    stopped = true;
    await expect(gate.browser.call("browser.click", { index: 43 })).rejects.toThrow(/Not done/);
    expect(b.clicked()).toBe(false);
  });
});
