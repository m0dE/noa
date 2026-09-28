/**
 * The user's report (Sep 28): "why does it remain at 'needs you' when it has completed the job". A repeating
 * account job posted on X as @arrrfun; the post check read X's post page before X showed the post, so the run
 * ended "retry" (the job's third failure in a row: paused, Needs you). The user wrote "try"; the agent found the
 * post already live and said so, but the turn's check failed the same way and the job stayed paused.
 *
 * These run the real post check (core verifyXPost) on the page as the extension read it (x-status-page.ts).
 */
import { describe, expect, it } from "vitest";
import { verifyXPost, type BrowserCaller } from "@noa/core";
import type { PageSnapshot } from "@noa/shared";
import { claimFixture } from "../fixtures.js";
import { Runner } from "../../src/engine/runner.js";
import { harness, runAll, setupRunnerTests, type Harness } from "./harness.js";
import { ARRR_POST_TITLE, ARRR_POST_URL, ARRR_TYPED, xStatusShell } from "../../../../packages/core/test/x-status-page.js";

setupRunnerTests();

const SERIES = "s01M3J59D36A3ZMCW3RZAN7VY36";
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
  h.deps.core = { ...h.deps.core, verifyXPost };
  const held: string[] = [];
  h.deps.holdSeries = async (_source, _series, reason) => {
    held.push(reason);
    return true;
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
  h.claims.push(claimFixture("c1", { instructions: INSTRUCTIONS, account: "@arrrfun", seriesId: SERIES }));
  return { h, held, claimed };
}

describe("the X post check on the run of an account job (the user's trace)", () => {
  it("X shows its frame first and the post a moment later: the run is done, its job not paused", async () => {
    const { h, held } = await arrrJob();
    xPostPage(h, () => [xStatusShell("X"), xStatusShell(ARRR_POST_TITLE)]);
    await runAll(h);
    expect(h.results.map((r) => [r.taskId, r.body.outcome, r.body.url])).toEqual([["c1", "done", ARRR_POST_URL]]);
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
    expect(h.results.map((r) => [r.taskId, r.body.outcome])).toEqual([["c1", "retry"]]);
    expect(held).toEqual([`Paused after 3 failed runs in a row. Last: could not verify the post: "100gb month free zero servers to babysit" not found on ${ARRR_POST_URL}`]);
    const sessionId = (await h.sessions.list())[0]!.sessionId;

    // The user writes "try": the agent opens the post, sees it live and does not post it again.
    shown = true;
    h.brain.continueScript = (o) => {
      o.onEvent({ type: "tool_call", id: "t2", name: "read_page", args: {} });
      return { outcome: "done", summary: "already posted by an earlier attempt", url: ARRR_POST_URL };
    };
    // The account's queue hands the run's task (paused with the job) to this runner, which reports it done.
    h.claims.push(claimFixture("c1", { instructions: INSTRUCTIONS, account: "@arrrfun", seriesId: SERIES, attempts: 2 }));
    await h.runner.message(sessionId, "try");
    await h.runner.idle();
    await h.sessions.flush();

    const s = await h.sessions.get(sessionId);
    expect(s).toMatchObject({ outcome: "done", url: ARRR_POST_URL });
    expect(claimed).toEqual([undefined, undefined, "c1"]);
    expect(h.results.map((r) => [r.taskId, r.body.outcome, r.body.url])).toEqual([
      ["c1", "retry", ARRR_POST_URL],
      ["c1", "done", ARRR_POST_URL],
    ]);
    expect(h.brain.starts).toHaveLength(1);
    expect((await h.runner.state()).failures).toBeUndefined();
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
