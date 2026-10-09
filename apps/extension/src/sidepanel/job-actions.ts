/**
 * The job page's "⋯" menu: which actions a job offers (only those that apply to it now), in words. Pure; the page
 * (job-page.ts) runs them.
 */
import type { Job } from "./jobs.js";

export type JobActionId = "run" | "pause" | "resume" | "hold" | "release" | "schedule" | "trust" | "raw" | "rename" | "cancel" | "delete";

export interface JobAction {
  id: JobActionId;
  label: string;
  /** What it does (the item's tooltip). */
  title: string;
  danger?: true;
}

/** The Raw item's tooltip. */
export const RAW_TITLE = "The whole conversation with how long each step took (to find what is slow); copy it or download it for the developer";

/** Trust: on a task the agent wrote (Task.agentAuthored). */
export const TRUST_TITLE = "The agent wrote this task. Trust it to do what it says without asking you, like a task you wrote";

/** Pause on a job that waits: its tooltip (also the Scheduled view's Pause). */
export const HOLD_TITLE = "Keep it from running, with its repeats, until you resume it";
/** Resume on a paused job. */
export const RELEASE_TITLE = "Put it back on its schedule";

/** Pause on an account task running in another browser (or under a runner that is gone). */
export const STOP_ELSEWHERE_TITLE = "Stop this run and keep it from running, with its repeats, until you resume it";

/** A task that waits (pending or paused) can still be changed. */
const waits = (job: Job) => job.task?.status === "pending" || job.task?.status === "paused";

/**
 * The account's task runs, but not in this browser (another browser runs it, or its runner is gone while the task
 * still counts as running): the account stops it (the runner loses its lease).
 */
const runsElsewhere = (job: Job, source: "local" | "account") => source === "account" && !job.running && job.task?.status === "running";

/**
 * source: where the TODO list lives (the signed-in account's queue, or this browser). Running tasks of the account's
 * queue cannot be deleted from here; this browser's can be once stopped.
 */
export function jobActions(job: Job, source: "local" | "account"): JobAction[] {
  const t = job.task;
  const s = job.session;
  const out: JobAction[] = [];
  // On hold, it runs again only once resumed (Run now would end the pause with its run).
  if (t && !job.running && !job.held && (t.status === "pending" || t.status === "paused" || t.status === "failed")) {
    out.push({ id: "run", label: "Run now", title: t.status === "pending" ? "Run it now instead of waiting for its time" : "Run it again now, from the start" });
  }
  if (job.running) out.push({ id: "pause", label: "Pause", title: "Stop the agent here; the job waits for you (Resume goes on)" });
  if (job.held) out.push({ id: "release", label: "Resume", title: RELEASE_TITLE });
  // A job that waits for its time can be paused (one that needs the user has Resume for that instead).
  else if (t && !job.running && t.status === "pending") out.push({ id: "hold", label: "Pause", title: HOLD_TITLE });
  else if (runsElsewhere(job, source)) out.push({ id: "hold", label: "Pause", title: STOP_ELSEWHERE_TITLE });
  if (!job.running && !job.held && job.state === "needs" && canResume(job, source)) {
    out.push({ id: "resume", label: "Resume", title: source === "account" && t ? "Put it back in the queue to run now" : "Pick up where it stopped" });
  }
  if (t && waits(job)) out.push({ id: "schedule", label: "Edit schedule", title: "Change when it runs: one time, or on a repeat" });
  else if (job.kind === "chat" && s?.source === "adhoc" && s.instructions?.trim()) {
    out.push({ id: "schedule", label: "Schedule", title: "Run this request again later, or on a repeat" });
  }
  if (t?.agentAuthored && waits(job)) out.push({ id: "trust", label: "Trust", title: TRUST_TITLE });
  if (s) out.push({ id: "raw", label: "Raw", title: RAW_TITLE });
  // A task's name is its series' (a run that keeps its instructions carries it; older runs are named by the task).
  if (s && (job.kind === "chat" ? s.source === "adhoc" : !!s.instructions)) out.push({ id: "rename", label: "Rename", title: "Give this job your own name" });
  if (t && source === "account" && waits(job)) out.push({ id: "cancel", label: "Cancel", title: "It will not run" });
  else if (t && runsElsewhere(job, source)) out.push({ id: "cancel", label: "Cancel", title: "Stop this run; it will not run again" });
  if (!job.running && !(t?.status === "running" && source === "account")) {
    out.push({ id: "delete", label: "Delete", title: job.kind === "task" ? "Delete the task and its runs" : "Delete this chat", danger: true });
  }
  return out;
}

/**
 * Resume goes on from the job's last run: a stopped conversation in this browser; the account's queue runs a paused
 * task again by itself (tasks.retry).
 */
function canResume(job: Job, source: "local" | "account"): boolean {
  if (job.task && source === "account") return job.task.status === "paused";
  return !!job.session?.endedAt && job.session.source !== "cloud";
}
