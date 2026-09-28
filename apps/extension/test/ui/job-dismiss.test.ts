import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@noa/shared";
import { Dismisser, dismissalOf, undoText, UNDO_MS, type Dismissal } from "../../src/sidepanel/job-dismiss.js";
import { buildJobs, type JobTask } from "../../src/sidepanel/jobs.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: id,
  source: "adhoc",
  title: `Chat ${id}`,
  brain: "claude-api",
  jev: false,
  startedAt: at(-10),
  endedAt: at(-8),
  outcome: "done",
  ...extra,
});
const task = (id: string, extra: Partial<JobTask>): JobTask =>
  ({
    id,
    instructions: `Task ${id}`,
    account: null,
    mediaIds: [],
    notBefore: null,
    priority: 0,
    status: "paused",
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryAfter: null,
    resultSummary: null,
    resultUrl: null,
    resultScreenshotId: null,
    pauseReason: "Log in",
    failReason: null,
    createdAt: at(-60),
    updatedAt: at(-60),
    ...extra,
  }) as JobTask;

const live = session("asks", { endedAt: undefined, outcome: undefined });
const jobs = new Map(
  buildJobs(
    {
      sessions: [live, session("dates", { outcome: "paused", reason: "Pick dates" }), session("done")],
      running: [live],
      awaitingApproval: ["asks"],
      tasks: [task("once", {}), task("daily", { repeat: { cron: "0 9 * * *", tz: "UTC" } }), task("later", { status: "pending", notBefore: at(60), pauseReason: null })],
    },
    NOW,
  ).map((j) => [j.key, j]),
);
const job = (key: string) => jobs.get(key)!;

describe("dismissalOf: what dismissing a job does", () => {
  it("a live run waiting for an approval is stopped (never allowed)", () => {
    expect(dismissalOf(job("chat:asks"), "local", NOW)).toEqual({
      key: "chat:asks",
      title: "Chat asks",
      entry: { at: at(0), needs: "run:asks:live" },
      action: { type: "stop", sessionId: "asks" },
    });
  });

  it("a one-off task the account's queue paused is cancelled; a repeating one, or this browser's, only leaves Needs you", () => {
    expect(dismissalOf(job("task:once"), "account", NOW)?.action).toEqual({ type: "cancel", taskId: "once" });
    expect(dismissalOf(job("task:once"), "local", NOW)?.action).toBeUndefined();
    expect(dismissalOf(job("task:daily"), "account", NOW)).toMatchObject({ entry: { needs: `task:daily:${at(-60)}` } });
    expect(dismissalOf(job("task:daily"), "account", NOW)?.action).toBeUndefined();
  });

  it("a chat that stopped for the user leaves Needs you; a Recent job is put away; upcoming jobs are not dismissed", () => {
    expect(dismissalOf(job("chat:dates"), "local", NOW)).toEqual({ key: "chat:dates", title: "Chat dates", entry: { at: at(0), needs: `run:dates:${at(-8)}` } });
    expect(dismissalOf(job("chat:done"), "local", NOW)).toEqual({ key: "chat:done", title: "Chat done", entry: { at: at(0), archivedAt: at(-8) } });
    expect(dismissalOf(job("task:later"), "local", NOW)).toBeNull();
  });

  it("Undo's line names one job, or counts them", () => {
    const d = (title: string): Dismissal => ({ key: "chat:x", title, entry: { at: at(0) } });
    expect(undoText([d("Post the photo")])).toBe("Dismissed “Post the photo”");
    expect(undoText([d("Post one new original post on X as @mecharoyalecom today")])).toBe("Dismissed “Post one new original post on X as @mec…”");
    expect(undoText([d("a"), d("b"), d("c")])).toBe("Dismissed 3 jobs");
  });
});

describe("Dismisser: Undo for a few seconds, then for real", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const setup = () => {
    const committed: (readonly Dismissal[])[] = [];
    const pending: Record<string, unknown>[] = [];
    const offers: (string | null)[] = [];
    let release: () => void = () => {};
    const d = new Dismisser({
      commit: async (b) => {
        committed.push(b);
        await new Promise<void>((r) => (release = r));
      },
      onPending: (p) => void pending.push(p),
      offerUndo: (b) => void offers.push(b ? undoText(b) : null),
    });
    return { d, committed, pending, offers, release: () => release() };
  };
  const a = dismissalOf(job("chat:dates"), "local", NOW)!;
  const b = dismissalOf(job("chat:done"), "local", NOW)!;

  it("shows it done at once, offers Undo, and commits when the time is over", async () => {
    const t = setup();
    t.d.dismiss([a]);
    expect(t.pending.at(-1)).toEqual({ "chat:dates": a.entry });
    expect(t.offers).toEqual(["Dismissed “Chat dates”"]);
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(t.committed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.committed).toEqual([[a]]);
    expect(t.offers.at(-1)).toBeNull();
    // Still shown dismissed while the commit is out; then the state says so.
    expect(t.pending.at(-1)).toEqual({ "chat:dates": a.entry });
    t.release();
    await vi.runAllTimersAsync();
    expect(t.pending.at(-1)).toEqual({});
  });

  it("Undo takes it back: nothing is committed", async () => {
    const t = setup();
    t.d.dismiss([a]);
    t.d.undo();
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(t.committed).toEqual([]);
    expect(t.pending.at(-1)).toEqual({});
    expect(t.offers.at(-1)).toBeNull();
  });

  it("a new dismissal commits the one before (Undo is for the newest); both stay shown dismissed meanwhile", () => {
    const t = setup();
    t.d.dismiss([a]);
    t.d.dismiss([b]);
    expect(t.committed).toEqual([[a]]);
    expect(t.pending.at(-1)).toEqual({ "chat:dates": a.entry, "chat:done": b.entry });
    expect(t.offers.at(-1)).toBe("Dismissed “Chat done”");
  });

  it("flush (the panel is hidden) commits now", () => {
    const t = setup();
    t.d.dismiss([a, b]);
    void t.d.flush();
    expect(t.committed).toEqual([[a, b]]);
  });
});
