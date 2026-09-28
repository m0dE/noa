/**
 * The user's report (Sep 28): "why does it remain at 'needs you' when it has completed the job". A repeating
 * account job posted on X as @arrrfun; the post check read X's post page before X showed the post, so the run
 * ended "retry" (the job's third failure in a row: paused, Needs you). The user wrote "try"; the agent found the
 * post already live and said so, but the turn's check failed the same way and the job stayed paused.
 *
 * These run the real post check (core verifyXPost) on the page as the extension read it (x-status-page.ts).
 */
import { describe, expect, it } from "vitest";
import { classifyFailure, verifyXPost, type BrowserCaller } from "@noa/core";
import type { PageSnapshot } from "@noa/shared";
import { claimFixture, taskFixture } from "../fixtures.js";
import { accountRow } from "../../src/account/todo-source.js";
import { buildJobs } from "../../src/sidepanel/jobs.js";
import { Runner } from "../../src/engine/runner.js";
import { env, harness, runAll, setupRunnerTests, type Harness } from "./harness.js";
import { ARRR_POST_TITLE, ARRR_POST_URL, ARRR_TYPED, xStatusShell } from "../../../../packages/core/test/x-status-page.js";

setupRunnerTests();

/** The job's series and its 16:30 occurrence (the rows in production, Sep 28). */
const SERIES = "01M3J59D36A3ZMCW3RZAN7VY36";
const TASK = "01M3M730QDMD33C87WM1S8Y2CE";
const INSTRUCTIONS = "Post one new original post on X as @arrrfun (ARRR). This repeats 3 times a day.";

/** X's post page in the slot's tab: each open of it reads `pages()` in turn (the last one from then on). */
function xPostPage(h: Harness, pages: () => PageSnapshot[]): void {
  let reads: PageSnapshot[] = [];
  (h.browser as { call: BrowserCaller["call"] }).call = (async (method: string) => {
    if (method === "browser.navigate") {
      reads = pages();
      return { url: ARRR_POST_URL, title: reads[0]!.title };
    }
    if (method === "browser.readPage") return reads.length > 1 ? reads.shift()! : reads[0]!;
    return {};
  }) as never;
}

/** A signed-in harness running the real post check, with the account job two failures in (the third pauses it). */
async function arrrJob() {
  const h = harness({}, { signedIn: true });
  h.deps.core = { verifyXPost, classifyFailure };
  const held: string[] = [];
  h.deps.holdSeries = async (_source, _series, reason) => {
    held.push(reason);
    return true;
  };
  const released: unknown[][] = [];
  h.deps.releaseHold = async (...args) => {
    released.push(args);
    return [];
  };
  const claimed: (string | undefined)[] = [];
  const claim = h.accountQueue.claim;
  h.accountQueue.claim = (runnerId, taskId) => (claimed.push(taskId), claim(runnerId, taskId));
  await chrome.storage.local.set({ runnerState: { failures: { [SERIES]: 2 } } });
  h.runner = new Runner(h.deps);
  // The run: the agent types the post in X's composer, posts it and reports its URL.
  h.brain.script = (o) => {
    o.onEvent({ type: "tool_call", id: "t1", name: "act", args: { steps: [{ goal: "click the Post text box" }, { goal: "type the post", text: ARRR_TYPED }] } });
    return { outcome: "done", summary: "Posted a free-tier/mesh post as @arrrfun", url: ARRR_POST_URL };
  };
  h.claims.push(claimFixture(TASK, { instructions: INSTRUCTIONS, account: "@arrrfun", seriesId: SERIES }));
  return { h, held, claimed, released };
}

describe("the X post check on the run of an account job (the user's trace)", () => {
  it("X shows its frame first and the post a moment later: the run is done, its job not paused", async () => {
    const { h, held } = await arrrJob();
    xPostPage(h, () => [xStatusShell("X"), xStatusShell(ARRR_POST_TITLE)]);
    await runAll(h);
    expect(h.results.map((r) => [r.taskId, r.body.outcome, r.body.url])).toEqual([[TASK, "done", ARRR_POST_URL]]);
    expect(held).toEqual([]);
    expect((await h.runner.state()).failures).toBeUndefined();
    const s = (await h.sessions.list())[0]!;
    expect(s.outcome).toBe("done");
    const statuses = (await h.sessions.eventsOf(s.sessionId)).flatMap((e) => (e.type === "status" ? [e.text] : []));
    expect(statuses).toEqual(["Verifying the post", "Post verified"]);
  });

  it("a follow-up that finds the post already live is done, and the job no longer needs the user", async () => {
    const { h, held, claimed } = await arrrJob();
    // The run: X never shows the post while the check waits (retry, the third failure: the job is paused).
    let shown = false;
    xPostPage(h, () => [xStatusShell(shown ? ARRR_POST_TITLE : "X")]);
    await runAll(h);
    expect(h.results.map((r) => [r.taskId, r.body.outcome])).toEqual([[TASK, "retry"]]);
    expect(held).toEqual([`Paused after 3 failed runs in a row. Last: could not verify the post: "100gb month free zero servers to babysit" not found on ${ARRR_POST_URL}`]);
    const sessionId = (await h.sessions.list())[0]!.sessionId;

    // The user writes "try": the agent opens the post, sees it live and does not post it again.
    shown = true;
    h.brain.continueScript = (o) => {
      o.onEvent({ type: "tool_call", id: "t2", name: "read_page", args: {} });
      return { outcome: "done", summary: "already posted by an earlier attempt", url: ARRR_POST_URL };
    };
    // The account's queue hands the run's task (paused with the job) to this runner, which reports it done.
    h.claims.push(claimFixture(TASK, { instructions: INSTRUCTIONS, account: "@arrrfun", seriesId: SERIES, attempts: 2 }));
    await h.runner.message(sessionId, "try");
    await h.runner.idle();
    await h.sessions.flush();

    const s = await h.sessions.get(sessionId);
    expect(s).toMatchObject({ outcome: "done", url: ARRR_POST_URL });
    expect(claimed).toEqual([undefined, undefined, TASK]);
    expect(h.results.map((r) => [r.taskId, r.body.outcome, r.body.url])).toEqual([
      [TASK, "retry", ARRR_POST_URL],
      [TASK, "done", ARRR_POST_URL],
    ]);
    expect(h.brain.starts).toHaveLength(1);
    expect((await h.runner.state()).failures).toBeUndefined();
  });

  it("the job's page: Needs you on the production rows, Scheduled once the follow-up reported the occurrence done", async () => {
    const repeat = { cron: "30 1,16,20 * * *", tz: "UTC" };
    const held = taskFixture(TASK, {
      instructions: INSTRUCTIONS,
      account: "@arrrfun",
      seriesId: SERIES,
      status: "paused",
      attempts: 1,
      notBefore: "2026-09-28T16:30:00.000Z",
      retryAfter: null,
      pauseReason: `Paused after 3 failed runs in a row. Last: could not verify the post: "100gb/month free. zero servers to babysi" not found on ${ARRR_POST_URL}`,
      createdAt: "2026-09-28T14:35:48.333Z",
      updatedAt: "2026-09-28T16:30:47.914Z",
      schedule: { at: "2026-09-28T16:30:00.000Z", repeat },
    });
    const session = { sessionId: "bad6812f", source: "cloud" as const, title: "@arrrfun: three daily X posts", brain: "claude-code" as const, jev: true, startedAt: "2026-09-28T20:17:17.183Z", endedAt: "2026-09-28T20:17:33.364Z", taskId: TASK, seriesId: SERIES };
    const now = Date.parse("2026-09-28T20:18:00.000Z");
    const stateOf = (tasks: ReturnType<typeof taskFixture>[], outcome: "retry" | "done") =>
      buildJobs({ sessions: [{ ...session, outcome }], running: [], tasks: tasks.map(accountRow) }, now).find((j) => j.key === `task:${SERIES}`)!.state;
    expect(stateOf([held], "retry")).toBe("needs");
    // What the API has after the follow-up's claim and done (finish-held.test.ts in apps/api): the occurrence done, its repeat waiting.
    const done = { ...held, status: "done" as const, pauseReason: null, resultUrl: ARRR_POST_URL, updatedAt: "2026-09-28T20:17:33.500Z" };
    const next = taskFixture("next", { instructions: INSTRUCTIONS, account: "@arrrfun", seriesId: SERIES, notBefore: "2026-09-28T20:30:00.000Z", createdAt: "2026-09-28T20:17:33.500Z", schedule: { at: "2026-09-28T20:30:00.000Z", repeat } });
    expect(stateOf([next, done], "done")).toBe("scheduled");
  });

  it("an unrelated follow-up that ends done leaves the scheduled occurrence as it is (no verified post, no completion)", async () => {
    const { h, claimed } = await arrrJob();
    h.settings.maxConsecutiveFailures = 5;
    xPostPage(h, () => [xStatusShell("X")]);
    await runAll(h);
    h.brain.continueScript = () => ({ outcome: "done", summary: "It is sunny in Seattle" });
    await h.runner.message((await h.sessions.list())[0]!.sessionId, "what's the weather?");
    await h.runner.idle();
    expect(claimed).toEqual([undefined, undefined]);
    expect(h.results.map((r) => r.body.outcome)).toEqual(["retry"]);
    // Nor does it start the job's failures in a row over.
    expect((await h.runner.state()).failures).toEqual({ [SERIES]: 3 });
  });

  it("a follow-up reporting a post it did not verify leaves the occurrence as it is", async () => {
    const { h, claimed } = await arrrJob();
    xPostPage(h, () => [xStatusShell("X")]);
    await runAll(h);
    // X still does not show the post: the turn's check turns its done into retry.
    h.brain.continueScript = () => ({ outcome: "done", summary: "posted", url: ARRR_POST_URL });
    await h.runner.message((await h.sessions.list())[0]!.sessionId, "try");
    await h.runner.idle();
    expect(claimed).toEqual([undefined, undefined]);
  });

  it("a follow-up that gets the work done starts the job's failures in a row over (before it is paused)", async () => {
    const { h, held } = await arrrJob();
    h.settings.maxConsecutiveFailures = 5;
    xPostPage(h, () => [xStatusShell("X")]);
    await runAll(h);
    expect(held).toEqual([]);
    expect((await h.runner.state()).failures).toEqual({ [SERIES]: 3 });
    xPostPage(h, () => [xStatusShell(ARRR_POST_TITLE)]);
    h.brain.continueScript = () => ({ outcome: "done", summary: "already posted by an earlier attempt", url: ARRR_POST_URL });
    await h.runner.message((await h.sessions.list())[0]!.sessionId, "try");
    await h.runner.idle();
    expect((await h.runner.state()).failures).toBeUndefined();
  });

  it("a follow-up that fails again leaves the job's count as it is (only scheduled runs count failures)", async () => {
    const { h } = await arrrJob();
    h.settings.maxConsecutiveFailures = 5;
    xPostPage(h, () => [xStatusShell("X")]);
    await runAll(h);
    h.brain.continueScript = () => ({ outcome: "done", summary: "posted", url: ARRR_POST_URL });
    await h.runner.message((await h.sessions.list())[0]!.sessionId, "try");
    await h.runner.idle();
    expect((await h.runner.state()).failures).toEqual({ [SERIES]: 3 });
    expect(h.results.map((r) => r.body.outcome)).toEqual(["retry"]);
  });
});

/**
 * The other shape a job's hold takes: a run failed for good (in production, the job's 01:30 occurrence
 * 01M3JH5MZYDCH567S1H3378ZWC, "Task time limit of 10 minutes reached"), its repeat was spawned, and the third failure
 * in a row paused that repeat. The user goes on in the failed run's conversation and the post gets verified.
 */
describe("a verified follow-up resumes the job's repeat that was paused after its failures", () => {
  const FAILED = "01M3JH5MZYDCH567S1H3378ZWC";
  const timeLimit = { outcome: "failed" as const, reason: "Task time limit of 10 minutes reached" };

  it("account job: the failed run is reported done, then the series' failure hold is released (not the run's own row)", async () => {
    const { h, held, claimed, released } = await arrrJob();
    h.claims.splice(0, h.claims.length, claimFixture(FAILED, { instructions: INSTRUCTIONS, account: "@arrrfun", seriesId: SERIES }));
    h.brain.script = (o) => {
      o.onEvent({ type: "tool_call", id: "t1", name: "act", args: { steps: [{ goal: "type the post", text: ARRR_TYPED }] } });
      return timeLimit;
    };
    xPostPage(h, () => [xStatusShell(ARRR_POST_TITLE)]);
    await runAll(h);
    expect(held).toEqual(["Paused after 3 failed runs in a row. Last: Task time limit of 10 minutes reached"]);
    h.brain.continueScript = () => ({ outcome: "done", summary: "already posted by an earlier attempt", url: ARRR_POST_URL });
    h.claims.push(claimFixture(FAILED, { instructions: INSTRUCTIONS, account: "@arrrfun", seriesId: SERIES, attempts: 2 }));
    await h.runner.message((await h.sessions.list())[0]!.sessionId, "try");
    await h.runner.idle();
    expect(claimed).toEqual([undefined, undefined, FAILED]);
    expect(h.results.map((r) => [r.taskId, r.body.outcome])).toEqual([
      [FAILED, "failed"],
      [FAILED, "done"],
    ]);
    expect(released).toEqual([["cloud", SERIES, FAILED]]);
  });

  it("account job: an unrelated follow-up that ends done, or a post not verified, releases nothing", async () => {
    const { h, released } = await arrrJob();
    h.brain.script = () => timeLimit;
    xPostPage(h, () => [xStatusShell("X")]);
    await runAll(h);
    const sessionId = (await h.sessions.list())[0]!.sessionId;
    h.brain.continueScript = () => ({ outcome: "done", summary: "It is sunny in Seattle" });
    await h.runner.message(sessionId, "what's the weather?");
    await h.runner.idle();
    h.brain.continueScript = () => ({ outcome: "done", summary: "posted", url: ARRR_POST_URL });
    await h.runner.message(sessionId, "try");
    await h.runner.idle();
    expect(released).toEqual([]);
  });

  it("this browser's job: the repeat held after 3 failed runs waits for its time again; no row is added", async () => {
    const h = harness();
    h.deps.core = { verifyXPost, classifyFailure };
    h.runner = new Runner(h.deps);
    xPostPage(h, () => [xStatusShell(ARRR_POST_TITLE)]);
    const HOURLY = { cron: "0 * * * *", tz: "UTC" };
    const first = await h.store.add({ instructions: INSTRUCTIONS, account: "@arrrfun", notBefore: new Date(env.clock).toISOString(), repeat: HOURLY });
    h.brain.script = (o) => {
      o.onEvent({ type: "tool_call", id: "t1", name: "act", args: { steps: [{ goal: "type the post", text: ARRR_TYPED }] } });
      return timeLimit;
    };
    for (let i = 0; i < 3; i++) {
      await runAll(h);
      env.clock += 60 * 60_000;
    }
    const series = async () => (await h.store.list()).filter((t) => (t.seriesId ?? t.id) === first.id);
    const before = await series();
    expect(before.map((t) => t.status)).toEqual(["failed", "failed", "failed", "paused"]);
    const heldRow = before[3]!;
    expect(heldRow.pauseReason).toBe("Paused after 3 failed runs in a row. Last: Task time limit of 10 minutes reached");

    // The user goes on in the last failed run's conversation before the held repeat's time; the post is verified.
    env.clock -= 30 * 60_000;
    h.brain.continueScript = () => ({ outcome: "done", summary: "already posted by an earlier attempt", url: ARRR_POST_URL });
    const last = (await h.sessions.list())[0]!;
    await h.runner.message(last.sessionId, "try");
    await h.runner.idle();
    const after = await series();
    expect(after.map((t) => [t.id, t.status])).toEqual([...before.slice(0, 2).map((t) => [t.id, "failed"]), [before[2]!.id, "done"], [heldRow.id, "pending"]]);
    expect(after[3]).toMatchObject({ pauseReason: null, notBefore: heldRow.notBefore });
    expect((await h.runner.state()).failures).toBeUndefined();
  });

  it("a series the user paused stays paused", async () => {
    const h = harness();
    h.deps.core = { verifyXPost, classifyFailure };
    h.runner = new Runner(h.deps);
    xPostPage(h, () => [xStatusShell(ARRR_POST_TITLE)]);
    const first = await h.store.add({ instructions: INSTRUCTIONS, account: "@arrrfun", notBefore: new Date(env.clock).toISOString(), repeat: { cron: "0 * * * *", tz: "UTC" } });
    h.brain.script = (o) => {
      o.onEvent({ type: "tool_call", id: "t1", name: "act", args: { steps: [{ goal: "type the post", text: ARRR_TYPED }] } });
      return timeLimit;
    };
    await runAll(h);
    const next = (await h.store.list()).find((t) => t.id !== first.id)!;
    await h.store.pause(next.id);
    h.brain.continueScript = () => ({ outcome: "done", summary: "already posted", url: ARRR_POST_URL });
    await h.runner.message((await h.sessions.list())[0]!.sessionId, "try");
    await h.runner.idle();
    expect(await h.store.get(next.id)).toMatchObject({ status: "paused", pauseReason: "Paused by you" });
  });
});
