import { describe, expect, it } from "vitest";
import { USER_STOP_REASON, type SessionInfo } from "@noa/shared";
import type { JobTask } from "../../src/sidepanel/jobs.js";
import { dayLabel, needsMoreRows, RUNS_PAGE, runCounts, runItems, runPage, type RunItem } from "../../src/sidepanel/job-runs.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const utcDay = (iso: string) => iso.slice(0, 10);
const DAY = 24 * 60;

function run(id: string, min: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "cloud", taskId: `row-${id}`, seriesId: "s1", title: "Post a tip", brain: "claude-api", jev: false, startedAt: at(min), endedAt: at(min + 3), outcome: "done", ...extra };
}
function row(id: string, min: number, extra: Partial<JobTask> = {}): JobTask {
  return {
    id,
    instructions: "Post a tip",
    account: null,
    mediaIds: [],
    notBefore: null,
    priority: 0,
    status: "done",
    attempts: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryAfter: null,
    resultSummary: null,
    resultUrl: null,
    resultScreenshotId: null,
    pauseReason: null,
    failReason: null,
    createdAt: at(min - 10),
    updatedAt: at(min),
    seriesId: "s1",
    ...extra,
  } as JobTask;
}
/** n runs a day apart, newest first from `from` minutes, each `make(i)`. */
const daily = (n: number, make: (i: number) => Partial<SessionInfo>, from = -60) => Array.from({ length: n }, (_, i) => run(`r${i}`, from - i * DAY, make(i)));
const keys = (items: readonly RunItem[]) => items.map((i) => i.key);

describe("runItems: every run of a job, newest first", () => {
  it("a run is a conversation of this browser, or a task row that ran without one here", () => {
    const items = runItems({
      sessions: [run("a", -100, { outcome: "failed", reason: "X asked to confirm the login\nTry again" }), run("b", -10, { summary: "Posted the tip" })],
      rows: [
        row("row-a", -97, { status: "failed", failReason: "X asked to confirm the login" }),
        row("c", -2000, { resultSummary: "Posted from the other browser" }),
        row("d", -3000, { status: "paused", pauseReason: "Out of usage credit" }),
        // The waiting repeat, and one paused before it ever ran: not runs.
        row("next", 1000, { status: "pending", attempts: 0 }),
        row("held", -50, { status: "paused", attempts: 0, pauseReason: "Paused by you" }),
      ],
    });
    expect(items.map((i) => [i.key, i.state, i.line])).toEqual([
      ["b", "done", "Posted the tip"],
      ["a", "failed", "X asked to confirm the login"],
      ["task:c", "done", "Posted from the other browser"],
      ["task:d", "needs", "Out of usage credit"],
    ]);
    expect(items[0]!.session?.sessionId).toBe("b");
    expect(items[2]).toMatchObject({ session: null, task: expect.objectContaining({ id: "c" }) });
  });

  it("a run going on now is running; one the user stopped is stopped", () => {
    const items = runItems({ sessions: [run("live", -1, { endedAt: undefined, outcome: undefined }), run("s", -50, { outcome: "paused", reason: USER_STOP_REASON })], rows: [], running: new Set(["live"]) });
    expect(items.map((i) => [i.key, i.state])).toEqual([
      ["live", "running"],
      ["s", "stopped"],
    ]);
  });

  it("counts every run and those done, failed and needing the user", () => {
    const items = runItems({ sessions: daily(6, (i) => (i < 3 ? {} : i < 5 ? { outcome: "failed", reason: "down" } : { outcome: "paused", reason: "log in" })), rows: [] });
    expect(runCounts(items)).toEqual({ all: 6, done: 3, failed: 2, needs: 1 });
  });
});

describe("runPage: a page of runs, grouped by day, the same outcome in a row folded", () => {
  it("groups runs by the day of the newest, newest day first", () => {
    const items = runItems({ sessions: [run("a", -60), run("b", -120, { summary: "second" }), run("c", -60 - DAY, { summary: "yesterday's" })], rows: [] });
    const page = runPage(items, "all", RUNS_PAGE, utcDay);
    expect(page.days.map((d) => [d.day, d.rows.map((r) => r.key)])).toEqual([
      ["2026-09-27", ["a", "b"]],
      ["2026-09-26", ["c"]],
    ]);
    expect(page).toMatchObject({ shown: 3, total: 3 });
  });

  it("folds runs in a row with the same outcome and reason into one row, across days, under its newest run's day", () => {
    const same = { outcome: "paused" as const, reason: "I couldn't switch X to @getbnty" };
    // Newest first: done, 7 times the same need, then failed for the same reason (another outcome: not folded).
    const items = runItems({ sessions: daily(9, (i) => (i === 0 ? { summary: "Posted" } : i <= 7 ? same : { ...same, outcome: "failed" })), rows: [] });
    const page = runPage(items, "all", RUNS_PAGE, utcDay);
    const rows = page.days.flatMap((d) => d.rows);
    expect(rows.map((r) => [r.state, r.runs.length])).toEqual([
      ["done", 1],
      ["needs", 7],
      ["failed", 1],
    ]);
    expect(rows[1]!.line).toBe("I couldn't switch X to @getbnty");
    // The folded row sits under the day of its newest run.
    expect(page.days.map((d) => d.rows.length)).toEqual([1, 1, 1]);
    expect(page.days[1]!.day).toBe(utcDay(rows[1]!.runs[0]!.at));
  });

  it("does not fold runs with another reason, nor a run still going", () => {
    const items = runItems({ sessions: [run("a", -1, { endedAt: undefined, outcome: undefined }), run("b", -30, { endedAt: undefined, outcome: undefined }), run("c", -60, { outcome: "failed", reason: "one" }), run("d", -90, { outcome: "failed", reason: "two" })], rows: [], running: new Set(["a", "b"]) });
    expect(runPage(items, "all", RUNS_PAGE, utcDay).days.flatMap((d) => d.rows.map((r) => r.runs.length))).toEqual([1, 1, 1, 1]);
  });

  it("filters: failed, needs you, done; folding follows the filter", () => {
    const items = runItems({ sessions: daily(5, (i) => (i % 2 ? { outcome: "failed", reason: "down" } : { summary: `post ${i}` })), rows: [] });
    const failed = runPage(items, "failed", RUNS_PAGE, utcDay);
    // Two failed runs, with done ones between them: in the filtered list they are in a row.
    expect(failed.days.flatMap((d) => d.rows).map((r) => [r.state, r.runs.map((x) => x.key)])).toEqual([["failed", ["r1", "r3"]]]);
    expect(failed.total).toBe(2);
    expect(runPage(items, "done", RUNS_PAGE, utcDay).total).toBe(3);
    expect(runPage(items, "needs", RUNS_PAGE, utcDay)).toMatchObject({ days: [], shown: 0, total: 0 });
  });

  it("pages: only the first `limit` runs are in the page, whatever the total", () => {
    const items = runItems({ sessions: daily(300, (i) => ({ summary: `post ${i}` })), rows: [] });
    const first = runPage(items, "all", RUNS_PAGE, utcDay);
    expect(first).toMatchObject({ shown: 50, total: 300 });
    expect(first.days.flatMap((d) => d.rows)).toHaveLength(50);
    expect(runPage(items, "all", 2 * RUNS_PAGE, utcDay).shown).toBe(100);
    expect(runPage(items, "all", 1000, utcDay).shown).toBe(300);
  });
});

describe("needsMoreRows: whether the next page of the series' task rows is needed", () => {
  const items = runItems({ sessions: [], rows: Array.from({ length: 60 }, (_, i) => row(`t${i}`, -i * 60, { status: i % 3 ? "done" : "failed", failReason: "down" })) });
  it("not when every row is loaded", () => {
    expect(needsMoreRows(items, "all", RUNS_PAGE, null)).toBe(false);
  });
  it("when fewer runs than the page are known back to the oldest row loaded", () => {
    const oldest = items.at(-1)!.at;
    expect(needsMoreRows(items, "all", RUNS_PAGE, oldest)).toBe(false);
    // 20 failed runs are known: a page of 50 failed ones needs older rows.
    expect(needsMoreRows(items, "failed", RUNS_PAGE, oldest)).toBe(true);
  });
});

describe("dayLabel", () => {
  it("today, yesterday, else the date (with the year when it is not this one)", () => {
    const now = new Date(2026, 8, 27, 12).getTime();
    expect(dayLabel("2026-09-27", now, "en-US")).toBe("Today");
    expect(dayLabel("2026-09-26", now, "en-US")).toBe("Yesterday");
    expect(dayLabel("2026-09-22", now, "en-US")).toBe("Tue, Sep 22");
    expect(dayLabel("2025-12-31", now, "en-US")).toBe("Wed, Dec 31, 2025");
  });
});
