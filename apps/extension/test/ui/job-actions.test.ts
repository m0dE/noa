import { describe, expect, it } from "vitest";
import type { SessionInfo, TaskStatus } from "@noa/shared";
import { jobActions } from "../../src/sidepanel/job-actions.js";
import { buildJobs, type JobTask } from "../../src/sidepanel/jobs.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

function session(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: id, instructions: `Do ${id}`, brain: "claude-api", jev: false, startedAt: at(-10), endedAt: at(-8), outcome: "done", ...extra };
}
function task(status: TaskStatus, extra: Partial<JobTask> = {}): JobTask {
  return { id: "t", instructions: "Post the tip", account: null, mediaIds: [], notBefore: at(60), priority: 0, status, attempts: 1, leaseOwner: null, leaseExpiresAt: null, retryAfter: null, resultSummary: null, resultUrl: null, resultScreenshotId: null, pauseReason: null, failReason: null, createdAt: at(-100), updatedAt: at(-100), ...extra } as JobTask;
}
const live = (s: SessionInfo): SessionInfo => ({ ...s, endedAt: undefined, outcome: undefined });

function labels(opts: { sessions?: SessionInfo[]; running?: SessionInfo[]; tasks?: JobTask[] }, source: "local" | "account" = "local"): string[] {
  const [job] = buildJobs({ sessions: opts.sessions ?? [], running: opts.running ?? [], tasks: opts.tasks ?? [] }, NOW);
  return jobActions(job!, source).map((a) => a.label);
}

describe("a chat's menu", () => {
  it("ended: schedule its request, Raw, Rename, Delete", () => {
    expect(labels({ sessions: [session("c")] })).toEqual(["Schedule", "Raw", "Rename", "Delete"]);
  });
  it("running: Pause; no Delete (its tab is the page's own row, not a menu item)", () => {
    const s = live(session("c"));
    expect(labels({ sessions: [s], running: [s] })).toEqual(["Pause", "Schedule", "Raw", "Rename"]);
  });
  it("stopped for the user: Resume", () => {
    expect(labels({ sessions: [session("c", { outcome: "paused", reason: "Log in to X" })] })).toEqual(["Resume", "Schedule", "Raw", "Rename", "Delete"]);
  });
  it("an empty send (look at the page) has no request to schedule", () => {
    expect(labels({ sessions: [session("c", { instructions: "" })] })).toEqual(["Raw", "Rename", "Delete"]);
  });
});

describe("a task's menu", () => {
  it("waiting: Run now, Edit schedule, Delete (this browser) or Cancel too (the account's queue)", () => {
    expect(labels({ tasks: [task("pending")] })).toEqual(["Run now", "Pause", "Edit schedule", "Delete"]);
    expect(labels({ tasks: [task("pending")] }, "account")).toEqual(["Run now", "Pause", "Edit schedule", "Cancel", "Delete"]);
  });
  it("written by the agent: Trust while it waits", () => {
    expect(labels({ tasks: [task("pending", { agentAuthored: true })] })).toEqual(["Run now", "Pause", "Edit schedule", "Trust", "Delete"]);
    expect(labels({ tasks: [task("done", { agentAuthored: true })] })).not.toContain("Trust");
  });
  it("paused with a run here: Resume goes on from it; Raw shows it", () => {
    const run = session("r", { source: "local", taskId: "t", outcome: "paused", reason: "Log in" });
    expect(labels({ tasks: [task("paused")], sessions: [run] })).toEqual(["Run now", "Resume", "Edit schedule", "Raw", "Rename", "Delete"]);
    // The account's queue runs it again by itself.
    expect(labels({ tasks: [task("paused")] }, "account")).toEqual(["Run now", "Resume", "Edit schedule", "Cancel", "Delete"]);
  });
  it("paused by the user, or after its runs kept failing: Resume puts it back on its schedule; no Run now", () => {
    const menu = (reason: string, source: "local" | "account" = "local") => jobActions(buildJobs({ sessions: [], running: [], tasks: [task("paused", { pauseReason: reason })] }, NOW)[0]!, source);
    expect(menu("Paused by you").map((a) => a.label)).toEqual(["Resume", "Edit schedule", "Delete"]);
    expect(menu("Paused by you")[0]).toMatchObject({ id: "release", title: "Put it back on its schedule" });
    expect(menu("Paused after 3 failed runs in a row. Last: boom", "account").map((a) => [a.id, a.label])).toEqual([
      ["release", "Resume"],
      ["schedule", "Edit schedule"],
      ["cancel", "Cancel"],
      ["delete", "Delete"],
    ]);
    // Waiting for its time: Pause keeps it (and its repeats) from running.
    const waiting = jobActions(buildJobs({ sessions: [], running: [], tasks: [task("pending")] }, NOW)[0]!, "local");
    expect(waiting.find((a) => a.id === "hold")).toMatchObject({ label: "Pause", title: "Keep it from running, with its repeats, until you resume it" });
  });
  it("running here: Pause, Raw; running elsewhere in the account's queue: nothing to do but wait", () => {
    const run = live(session("r", { source: "local", taskId: "t" }));
    expect(labels({ tasks: [task("running")], sessions: [run], running: [run] })).toEqual(["Pause", "Raw", "Rename"]);
    expect(labels({ tasks: [task("running")] }, "account")).toEqual([]);
  });
  it("over: Raw, Rename and Delete; failed: Run now too", () => {
    const run = session("r", { source: "local", taskId: "t" });
    expect(labels({ tasks: [task("done")], sessions: [run] })).toEqual(["Raw", "Rename", "Delete"]);
    expect(labels({ tasks: [task("failed")], sessions: [run] })).toEqual(["Run now", "Raw", "Rename", "Delete"]);
  });
  it("Rename: a task whose run keeps its instructions (the series' name); an older run is named by its task", () => {
    const old = session("r", { source: "local", taskId: "t", instructions: undefined });
    expect(labels({ tasks: [task("done")], sessions: [old] })).toEqual(["Raw", "Delete"]);
  });
});
