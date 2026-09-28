/** Runner job sources: local tasks, cloud claims, one-off runs. */
import { describe, expect, it, vi } from "vitest";
import { automationPromptLine, localTimeZone, type AgentEvent } from "@noa/shared";
import { Runner } from "../../src/engine/runner.js";
import { claimFixture } from "../fixtures.js";
import { env, harness, runAll, setupRunnerTests } from "./harness.js";

setupRunnerTests();

describe("Runner: local tasks", () => {
  it("runs a due local task: crash marker first, media paths, done recorded, session stored", async () => {
    // Below Full autonomy, a scheduled run follows the scheduled setting (Full autonomy never asks anywhere).
    const h = harness({ automationLevel: "ask_consequential" });
    const t = await h.store.add({ instructions: "Post hello", account: "@me", media: [{ name: "a.png", type: "image/png", dataBase64: btoa("A") }] });
    h.brain.script = async (opts) => {
      // The crash marker is persisted before the brain starts.
      expect(await h.store.get(t.id)).toMatchObject({ status: "running", attempts: 1 });
      opts.onEvent({ type: "assistant_text", text: "working" });
      opts.onEvent({ type: "task_end", outcome: "done", summary: "brain's own" });
      return { outcome: "done", summary: "posted" };
    };
    expect(await runAll(h)).toEqual({ started: true });

    const start = h.brain.starts[0]!;
    // Scheduled runs are told they may do what the task says (Settings > Permission, scheduled tasks).
    expect(start.task).toEqual({ id: t.id, instructions: "Post hello", account: "@me", timeZone: localTimeZone(), approvals: automationPromptLine("full_within_task") });
    expect(start.mediaPaths).toEqual(["C:\\dl\\a.png"]);
    // Scheduled runs use the agent's own tab, in the background.
    expect(h.prepared).toEqual([{ mode: "own-tab" }]);
    expect(start.config).toMatchObject({ isRetry: false, maxToolCalls: 60, jevEnabled: true, model: "claude-sonnet-5" });
    expect(h.materialized[0]!.sources[0]).toMatchObject({ kind: "blob", name: "a.png" });
    expect(h.cleanups).toBe(1);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", resultSummary: "posted" });

    const [session] = await h.sessions.list();
    expect(session).toMatchObject({ source: "local", taskId: t.id, brain: "claude-api", outcome: "done", summary: "posted" });
    const events = await h.sessions.eventsOf(session!.sessionId);
    // The brain's task_end is replaced by the runner's single final one.
    expect(events.filter((e) => e.type === "task_end")).toEqual([expect.objectContaining({ outcome: "done", summary: "posted" })]);
    expect(events.map((e) => e.type)).toEqual(["status", "assistant_text", "task_end"]);
    expect(h.runner.busy).toBe(false);
    expect(h.runner.running).toBeNull();
    expect((await h.runner.state()).lastRunAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("recovers a crashed running task and runs it again with isRetry", async () => {
    const h = harness({ maxTaskMinutes: 10 });
    const t = await h.store.add({ instructions: "x" });
    await h.store.markStarted(t.id); // attempt 1 "crashed"
    env.clock += 13 * 60_000;
    expect(await h.runner.recover()).toBe(1);
    await runAll(h);
    expect(h.brain.starts[0]!.config.isRetry).toBe(true);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", attempts: 2, crashed: false });
  });

  it("no usable brain: stops, sets lastError, notifies once", async () => {
    const h = harness();
    h.noBrain = true;
    await h.store.add({ instructions: "a" });
    await runAll(h);
    await runAll(h);
    expect(h.brain.starts).toHaveLength(0);
    expect((await h.runner.state()).lastError).toBe("No brain available: set a key");
    expect(h.notifications).toEqual([{ title: "Cannot run tasks", message: "No brain available: set a key" }]);
  });
});

describe("Runner: cloud tasks", () => {
  it("claims after local tasks, downloads media with the runner key, reports retry with retryAfterMinutes and a screenshot", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k", retryAfterMinutes: 12 });
    const local = await h.store.add({ instructions: "local first" });
    const claim = claimFixture("c1", { attempts: 2 });
    claim.media = [{ id: "m1", filename: "clip.mp4", contentType: "video/mp4", size: 3 }];
    h.claims.push(claim);
    const order: string[] = [];
    h.brain.script = (opts) => {
      order.push(opts.task.id);
      return opts.task.id === "c1" ? { outcome: "failed", reason: "network error" } : { outcome: "done" };
    };
    await runAll(h);
    expect(order).toEqual([local.id, "c1"]);
    const cloudStart = h.brain.starts[1]!;
    expect(cloudStart.config.isRetry).toBe(true);
    expect(h.materialized[1]!.sources).toEqual([
      { kind: "url", name: "clip.mp4", url: "https://api.test/v1/media/m1", headers: [{ name: "Authorization", value: "Bearer bt_k" }] },
    ]);
    expect(h.results).toEqual([
      {
        taskId: "c1",
        body: { runnerId: "runner-1", outcome: "retry", reason: "network error", retryAfterMinutes: 12, screenshotId: "shot-1" },
      },
    ]);
    const s = (await h.sessions.list()).find((x) => x.source === "cloud");
    expect(s).toMatchObject({ taskId: "c1", outcome: "retry" });
  });

  it("paused cloud tasks use pauseRetryMinutes", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k", pauseRetryMinutes: 30 });
    h.claims.push(claimFixture("c2"));
    h.brain.script = () => ({ outcome: "paused", reason: "2FA" });
    await runAll(h);
    expect(h.results[0]!.body).toMatchObject({ outcome: "paused", reason: "2FA", retryAfterMinutes: 30 });
  });

  it("done and failed cloud results carry no retry delay", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k" });
    h.claims.push(claimFixture("c3"), claimFixture("c4"));
    const outcomes = [{ outcome: "done" as const }, { outcome: "failed" as const, reason: "button not found" }];
    h.brain.script = () => outcomes.shift()!;
    await runAll(h);
    expect(h.results.map((r) => r.body.retryAfterMinutes)).toEqual([undefined, undefined]);
  });

  it("signed in: claims from the account (not the runner-key cloud sync) and reports there", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://selfhosted.test", runnerKey: "bt_k" });
    const runnerKeyClaims = vi.fn(async () => null);
    const orig = h.deps.createApi;
    h.deps.createApi = (st) => ({ ...orig(st), claim: runnerKeyClaims });
    const accountResults: string[] = [];
    const accountClaims = [claimFixture("a1"), null];
    h.deps.accountApi = async () => ({
      claim: async () => accountClaims.shift() ?? null,
      heartbeat: async () => ({}),
      result: async (taskId, body) => void accountResults.push(`${taskId} ${body.outcome}`),
      uploadMedia: async (_b, filename) => ({ id: "shot", filename, contentType: "image/jpeg", size: 1 }),
      mediaUrl: (id) => `https://account.test/v1/media/${id}`,
      authHeaders: () => [{ name: "Authorization", value: "Bearer bt_s_session" }],
    });
    h.runner = new Runner(h.deps);
    h.brain.script = () => ({ outcome: "paused", reason: "Out of usage credit" });
    await runAll(h);
    expect(accountResults).toEqual(["a1 paused"]);
    expect(runnerKeyClaims).not.toHaveBeenCalled();
    expect(h.notifications).toEqual([{ title: "Task paused", message: "Out of usage credit" }]);
  });

  it("signed in without cloud sync: the account queue is still checked", async () => {
    const h = harness();
    const claim = vi.fn(async () => null);
    h.deps.accountApi = async () => ({ claim, heartbeat: async () => ({}), result: async () => {}, uploadMedia: async () => ({}) as never, mediaUrl: () => "", authHeaders: () => [] });
    h.runner = new Runner(h.deps);
    await runAll(h);
    expect(claim).toHaveBeenCalledWith("runner-1");
  });

  it("cloud sync on but not configured: nothing runs, lastError explains", async () => {
    const h = harness({ cloudEnabled: true });
    await runAll(h);
    expect((await h.runner.state()).lastError).toMatch(/API URL or runner key is missing/);
  });
});

describe("Runner: adhoc sessions", () => {
  it("runs a one-off task as a session only, with attachments and user messages", async () => {
    const h = harness();
    let events: AgentEvent[] = [];
    h.brain.script = (_opts, ctl) => {
      void (async () => {
        await vi.waitFor(() => expect(ctl.said).toEqual(["also add a hashtag"]));
        ctl.resolve({ outcome: "done", summary: "did it" });
      })();
      return "hang";
    };
    const { sessionId } = await h.runner.runAdhoc({
      instructions: "  Like the top post  ",
      account: "@me",
      attachments: [{ ref: { name: "x.png", type: "image/png", kind: "image", width: 1, height: 1, thumb: "data:image/jpeg;base64,AA" }, blob: new Blob(["x"], { type: "image/png" }) }],
    });
    expect(await h.sessions.get(sessionId)).toMatchObject({ source: "adhoc", title: "Like the top post", brain: "claude-api" });
    expect(h.runner.running?.sessionId).toBe(sessionId);
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(await h.runner.say("also add a hashtag")).toBe(true);
    await h.runner.idle();
    await h.sessions.flush();
    events = await h.sessions.eventsOf(sessionId);
    // One user_message: the brain's echo is dropped.
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "task_end", outcome: "done", summary: "did it" });
    // The agent is told the user's time in the browser's zone (schedule_task).
    expect(h.brain.starts[0]!.task).toEqual({ id: sessionId, instructions: "Like the top post", account: "@me", timeZone: localTimeZone(), approvals: automationPromptLine("full") });
    // The file is kept in the conversation, shown on the first message, written to Downloads for upload, and its
    // bytes go to the model (the chat's thumbnail does not).
    expect(h.brain.starts[0]!.mediaPaths).toEqual([]);
    const ref = { id: "a1", name: "x.png", type: "image/png", size: 1, kind: "image", width: 1, height: 1 };
    expect((await h.sessions.get(sessionId))!.attachments).toEqual([{ ...ref, thumb: "data:image/jpeg;base64,AA" }]);
    expect(h.brain.starts[0]!.attachments).toEqual([{ ref, fresh: true, blob: expect.any(Blob), path: "C:\\dl\\x.png", base64: btoa("x") }]);
    // One-off runs act on the tab the user is looking at.
    expect(h.prepared).toEqual([{ mode: "current-tab" }]);
    expect(await h.store.list()).toEqual([]);
    expect(await h.runner.say("late")).toBe(false);
  });

  it("fails fast with the brain note when nothing is usable", async () => {
    const h = harness();
    h.noBrain = true;
    await expect(h.runner.runAdhoc({ instructions: "x" })).rejects.toThrow("No brain available: set a key");
    expect(h.runner.busy).toBe(false);
    await expect(h.runner.runAdhoc({ instructions: " " })).rejects.toThrow(/empty/);
  });
});
