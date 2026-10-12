/**
 * The jobs list's view model (pure): every chat, one-off task, repeating task and past run is a job, in one list.
 *
 * A job is either a chat (a conversation started in the panel, by voice or through the API: one session) or a task
 * (a TODO task with its repeats, Task.seriesId, and the runs this browser has of them). A repeating task is one job,
 * however many times it ran; a run whose task is gone stays with the others of its series. The list groups jobs by
 * what they need: Needs you (an approval or the user's answer waits, a task paused), Running, Upcoming (a task
 * waiting for its time; "scheduled" in the code), Recent (the rest, newest first).
 *
 * Two views (JobView): Home has those groups, Upcoming cut to its soonest UPCOMING_ON_HOME; Scheduled has every job
 * with a schedule (one row per series: waiting, running a repeat, or paused), soonest first, the paused ones last. A
 * job the user paused (state "paused": its task on hold with PAUSED_BY_USER) is only in Scheduled; one paused because
 * its runs kept failing needs the user (Needs you) and is among Scheduled's paused ones too.
 *
 * The user clears the list (UiState.dismissals): a need they dismissed goes to Recent ("Dismissed"), and a job they
 * put away leaves the list until it does something again (search still finds it). A need nobody answered for
 * STALE_NEEDS_MS goes to Recent by itself ("Waited for you"), except one that cannot move on without the user: an
 * approval still open in a live run (it ends by itself when it expires), or a repeating task paused (it would never
 * run again unnoticed).
 */
import {
  formatRelative,
  isOnHold,
  PAUSED_BY_USER,
  repeatLabel,
  taskNextTime,
  USER_STOP_REASON,
  whenText,
  type LocalTask,
  type RepeatSchedule,
  type SessionInfo,
} from "@noa/shared";
import type { JobDismissal, LocalMediaInfo } from "../ui-protocol.js";
import { firstLine } from "./format.js";

/** Home's groups (needs, running, scheduled = Upcoming, recent), and the Scheduled view's (active, paused). */
export type JobGroupId = "needs" | "running" | "scheduled" | "recent" | "active" | "paused";

/** The list's two views: Home (what needs you, runs, comes next and ran), and every scheduled job. */
export type JobView = "home" | "scheduled";

/** Home's Upcoming shows this many (the soonest); the Scheduled view shows them all. */
export const UPCOMING_ON_HOME = 3;

/** Where a job is: what its row's icon and its page's subtitle say. */
export type JobState = "needs" | "running" | "due" | "scheduled" | "retry" | "paused" | "done" | "failed" | "stopped" | "cancelled" | "dismissed" | "lapsed";

/** A need nobody answered for this long goes to Recent by itself (see the top of this file). */
export const STALE_NEEDS_MS = 24 * 60 * 60 * 1000;

/** A TODO task as the list has it (its repeat rule read in the current shape; cloud tasks may lack media). */
export type JobTask = Omit<LocalTask, "repeat"> & { repeat?: RepeatSchedule | null; media?: LocalMediaInfo[] };

export interface Job {
  /** "chat:<session id>" or "task:<series id>": stays the same while the job lives (a new run keeps it). */
  key: string;
  kind: "chat" | "task";
  title: string;
  state: JobState;
  group: JobGroupId;
  /** The task's row that stands for it now (the one waiting, running or paused, else the newest). */
  task: JobTask | null;
  /** Every row of the task's series (each repeat is one), newest first. */
  tasks: JobTask[];
  /** The conversation the job's page shows and the composer goes on with: the chat, or the newest run. */
  session: SessionInfo | null;
  /** Its runs in this browser, oldest first (a chat: itself). */
  runs: SessionInfo[];
  /** One of its runs is running in this browser now. */
  running: boolean;
  /** When it last did something (ISO). */
  at: string;
  /** When it runs next (a waiting task; null: its time has come, or it does not wait). */
  next: string | null;
  repeat: RepeatSchedule | null;
  /** Why it needs you, or why it failed ("" when there is nothing to say). */
  reason: string;
  /** The site its newest run ended on ("x.com"; "" when unknown). */
  site: string;
  /** What it needs the user for, as one mark (the paused task row or the run): dismissing it names this. Null: nothing. */
  needs: string | null;
  /** The user put it away: not in the list (search finds it). */
  archived: boolean;
  /** Its task is on hold (paused by the user, or after its runs kept failing): only Resume puts it back on its schedule. */
  held: boolean;
  /** It has a schedule (it waits to run, runs a repeat, or is paused): a row of the Scheduled view. */
  scheduled: boolean;
}

export interface JobInputs {
  /** The sessions listed (newest first). */
  sessions: readonly SessionInfo[];
  /** UiState.runningSessions: the newest copy of those running. */
  running: readonly SessionInfo[];
  tasks: readonly JobTask[];
  /** UiState.awaitingApproval. */
  awaitingApproval?: readonly string[];
  /** UiState.dismissals. */
  dismissals?: Readonly<Record<string, JobDismissal>>;
}

export const GROUP_LABELS: Record<JobGroupId, string> = {
  needs: "Needs you",
  running: "Running",
  scheduled: "Upcoming",
  recent: "Recent",
  active: "Next runs",
  paused: "Paused",
};
const GROUP_ORDER: readonly JobGroupId[] = ["needs", "running", "scheduled", "recent"];

export const STATE_LABELS: Record<JobState, string> = {
  needs: "Needs you",
  running: "Running",
  due: "Due now",
  scheduled: "Scheduled",
  retry: "Retrying",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  cancelled: "Cancelled",
  dismissed: "Dismissed",
  lapsed: "Waited for you",
};

const GROUP_OF: Record<JobState, JobGroupId> = {
  needs: "needs",
  running: "running",
  due: "scheduled",
  scheduled: "scheduled",
  retry: "scheduled",
  paused: "paused",
  done: "recent",
  failed: "recent",
  stopped: "recent",
  cancelled: "recent",
  dismissed: "recent",
  lapsed: "recent",
};

/** An approval card waits in a running conversation. */
export const APPROVAL_REASON = "Waiting for your OK";

/** A chat's title when it has none (an empty send: "look at this page"). */
const UNTITLED = "Look at this page";

export const chatKey = (sessionId: string): string => `chat:${sessionId}`;
export const taskKey = (seriesId: string): string => `task:${seriesId}`;
/** The series a task belongs to (older tasks without one: their own). */
export const seriesOf = (t: Pick<JobTask, "id" | "seriesId">): string => t.seriesId ?? t.id;

/** The site of an address, without "www."; "" when it has none. */
export function siteOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

const later = (a: string, b: string) => (a >= b ? a : b);
const lastActive = (s: SessionInfo) => s.endedAt ?? s.startedAt;

/** The job a session belongs to: its task's series (also when the task is gone), else its own chat. */
export function jobKeyOf(s: Pick<SessionInfo, "sessionId" | "source" | "taskId" | "seriesId">, seriesOfTask: ReadonlyMap<string, string> = new Map()): string {
  if (s.source === "adhoc") return chatKey(s.sessionId);
  const series = (s.taskId && seriesOfTask.get(s.taskId)) || s.seriesId || s.taskId;
  return series ? taskKey(series) : chatKey(s.sessionId);
}

/** The row that stands for a series: the one running, else paused, else waiting, else the newest (rows newest first). */
function currentTask(rows: readonly JobTask[]): JobTask {
  for (const status of ["running", "paused", "pending"] as const) {
    const t = rows.find((r) => r.status === status);
    if (t) return t;
  }
  return rows[0]!;
}

/** Where a conversation is, when its task (if any) does not say (also each run of a job's runs list, job-runs.ts). */
export function sessionState(s: SessionInfo, running: boolean, awaiting: boolean): { state: JobState; reason: string } {
  if (running) return awaiting ? { state: "needs", reason: APPROVAL_REASON } : { state: "running", reason: "" };
  // Not running and never ended: its worker stopped under it.
  if (!s.endedAt) return { state: "stopped", reason: "" };
  switch (s.outcome) {
    case "done":
      return { state: "done", reason: "" };
    case "failed":
      return { state: "failed", reason: s.reason ?? "" };
    case "paused":
    case "retry":
      // Stopped by the user: over, not waiting for them.
      return s.reason === USER_STOP_REASON ? { state: "stopped", reason: "" } : { state: "needs", reason: s.reason ?? "" };
    default:
      return { state: "stopped", reason: "" };
  }
}

function taskState(t: JobTask, now: number): { state: JobState; reason: string } {
  switch (t.status) {
    case "running":
      return { state: "running", reason: "" };
    case "paused":
      // Paused by the user: it waits for them to resume it, it does not need them.
      if (t.pauseReason === PAUSED_BY_USER && !t.retryAfter) return { state: "paused", reason: "" };
      return { state: "needs", reason: t.pauseReason ?? "" };
    case "pending": {
      if (t.retryAfter && Date.parse(t.retryAfter) > now) return { state: "retry", reason: t.failReason ?? "" };
      const next = taskNextTime(t);
      return { state: next && Date.parse(next) > now ? "scheduled" : "due", reason: "" };
    }
    case "done":
      return { state: "done", reason: "" };
    case "failed":
      return { state: "failed", reason: t.failReason ?? "" };
    case "cancelled":
      return { state: "cancelled", reason: "" };
  }
}

/** "@name" an X (or other) account goes by, after a space: "… on X as @mecharoyalecom" (never an email's "@example"). */
const HANDLE = /(?:\s+(?:as|from|for|by|with|using)\s+|\s+)(@[A-Za-z0-9_]{2,30})(?![\w@])/;

/**
 * A request as a title, with what tells it apart from similar jobs first: the account it acts as ("@mecharoyalecom ·
 * Post one new original post on X"), from its words or its task's account.
 */
export function distinctTitle(text: string, account?: string | null): string {
  const m = HANDLE.exec(text);
  if (m) return `${m[1]} · ${(text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim()}`;
  const acct = account?.trim();
  if (acct?.startsWith("@") && !text.startsWith("@") && !text.toLowerCase().includes(acct.toLowerCase())) return `${acct} · ${text}`;
  return text;
}

/**
 * A task's title: the name its series was given (the user's newest, else the title model's first, chat-titles.ts),
 * else its request with what tells it apart first.
 */
function taskTitle(runs: readonly SessionInfo[], task: JobTask | null): string {
  const named = runs.filter((r) => r.titleBy === "user").at(-1) ?? runs.find((r) => r.titleBy === "model");
  if (named?.title.trim()) return named.title.trim();
  const request = firstLine(task?.instructions ?? "") || firstLine(runs.at(-1)?.instructions ?? "") || firstLine(runs.at(-1)?.title ?? "");
  return request ? distinctTitle(request, task?.account) : UNTITLED;
}

/** Every job, in no particular order (see groupJobs). */
export function buildJobs(input: JobInputs, now = Date.now()): Job[] {
  const live = new Map(input.running.map((s) => [s.sessionId, s]));
  const awaiting = new Set(input.awaitingApproval ?? []);
  const sessions = new Map(input.sessions.map((s) => [s.sessionId, live.get(s.sessionId) ?? s]));
  for (const s of input.running) if (!sessions.has(s.sessionId)) sessions.set(s.sessionId, s);

  const seriesTasks = new Map<string, JobTask[]>();
  const seriesOfTask = new Map<string, string>();
  for (const t of input.tasks) {
    const series = seriesOf(t);
    seriesOfTask.set(t.id, series);
    seriesTasks.set(series, [...(seriesTasks.get(series) ?? []), t]);
  }
  const runsOf = new Map<string, SessionInfo[]>();
  for (const s of sessions.values()) {
    const key = jobKeyOf(s, seriesOfTask);
    runsOf.set(key, [...(runsOf.get(key) ?? []), s]);
  }
  for (const series of seriesTasks.keys()) if (!runsOf.has(taskKey(series))) runsOf.set(taskKey(series), []);

  const jobs: Job[] = [];
  for (const [key, list] of runsOf) {
    const runs = [...list].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
    const newest = runs.at(-1) ?? null;
    const liveRun = runs.find((r) => live.has(r.sessionId)) ?? null;
    const kind = key.startsWith("task:") ? "task" : "chat";
    const rows = [...(seriesTasks.get(key.slice("task:".length)) ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const task = kind === "task" && rows.length ? currentTask(rows) : null;
    const session = liveRun ?? newest;
    const where =
      liveRun || !task
        ? sessionState(session!, !!liveRun, !!liveRun && awaiting.has(liveRun.sessionId))
        : taskState(task, now);
    const at = [task?.updatedAt, newest ? lastActive(newest) : undefined].filter((x): x is string => !!x).reduce(later, "");
    // What it needs the user for: the paused task row, or the run (live: an approval).
    const byTask = !liveRun && !!task;
    const needs = where.state !== "needs" ? null : byTask ? `task:${task!.id}:${task!.updatedAt}` : `run:${session!.sessionId}:${session!.endedAt ?? "live"}`;
    const dismissal = input.dismissals?.[key];
    let state = where.state;
    if (needs && dismissal?.needs === needs) state = "dismissed";
    else if (needs && !liveRun && !(byTask && task!.repeat)) {
      const since = byTask ? task!.updatedAt : lastActive(session!);
      if (now - Date.parse(since) > STALE_NEEDS_MS) state = "lapsed";
    }
    jobs.push({
      key,
      kind,
      title: kind === "task" ? taskTitle(runs, task) : firstLine(session?.title ?? "") || UNTITLED,
      state,
      group: GROUP_OF[state],
      task,
      tasks: rows,
      session,
      runs,
      running: !!liveRun,
      at,
      next: task?.status === "pending" ? taskNextTime(task) : null,
      repeat: task?.repeat ?? null,
      reason: where.reason,
      site: siteOf(session?.url),
      needs: state === "needs" ? needs : null,
      archived: GROUP_OF[state] === "recent" && !!dismissal?.archivedAt && at <= dismissal.archivedAt,
      held: !!task && isOnHold(task),
      scheduled: !!task && (task.status === "pending" || task.status === "paused" || (task.status === "running" && !!task.repeat)),
    });
  }
  return jobs;
}

/** The words of a search, lower case. */
export const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** The job's title, instructions or site holds every word of the search (in any order). */
export function jobMatches(job: Job, words: readonly string[]): boolean {
  if (!words.length) return true;
  const text = [job.title, job.task?.instructions, ...job.runs.map((r) => r.instructions ?? r.title), job.site, ...job.runs.map((r) => siteOf(r.url))]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

export interface JobGroup {
  id: JobGroupId;
  label: string;
  jobs: Job[];
}

const byLatest = (a: Job, b: Job) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
/** Soonest first; a job whose time has come (no next time) before any that waits. */
const bySoonest = (a: Job, b: Job) => (a.next ? Date.parse(a.next) : -Infinity) - (b.next ? Date.parse(b.next) : -Infinity) || a.title.localeCompare(b.title);

/** The groups that have jobs (matching the search), in order: Needs you, Running, Upcoming, Recent. Jobs put away show only in a search. */
export function groupJobs(jobs: readonly Job[], query = ""): JobGroup[] {
  const words = searchWords(query);
  const shown = jobs.filter((j) => (words.length || !j.archived) && jobMatches(j, words));
  return GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABELS[id],
    jobs: shown.filter((j) => j.group === id).sort(id === "scheduled" ? bySoonest : byLatest),
  })).filter((g) => g.jobs.length > 0);
}

/** A view's groups, and what Home's Upcoming leaves to the Scheduled view. */
export interface ViewLayout {
  groups: JobGroup[];
  /** Home: the upcoming jobs its Upcoming leaves out (0: it shows them all). */
  upcomingHidden: number;
  /** The Scheduled view's rows for this search ("All scheduled (N)"). */
  scheduledCount: number;
}

/**
 * What a view shows for a search. Home: groupJobs, Upcoming cut to its soonest UPCOMING_ON_HOME while nothing is
 * searched (a search shows every match). Scheduled: scheduledGroups.
 */
export function viewLayout(view: JobView, jobs: readonly Job[], query = ""): ViewLayout {
  const scheduled = scheduledGroups(jobs, query);
  const scheduledCount = scheduled.reduce((n, g) => n + g.jobs.length, 0);
  if (view === "scheduled") return { groups: scheduled, upcomingHidden: 0, scheduledCount };
  const cut = searchWords(query).length === 0;
  let upcomingHidden = 0;
  const groups = groupJobs(jobs, query).map((g) => {
    if (g.id !== "scheduled" || !cut || g.jobs.length <= UPCOMING_ON_HOME) return g;
    upcomingHidden = g.jobs.length - UPCOMING_ON_HOME;
    return { ...g, jobs: g.jobs.slice(0, UPCOMING_ON_HOME) };
  });
  return { groups, upcomingHidden, scheduledCount };
}

/** When a scheduled job comes next, for sorting: running now first, then those that need the user (no time), then by time (a due one: its passed time). */
function nextKey(job: Job): number {
  if (job.running) return -Infinity;
  return job.next ? Date.parse(job.next) : Number.MIN_SAFE_INTEGER;
}

/**
 * The Scheduled view: every job with a schedule (one row per series) matching the search, soonest first ("Next
 * runs"), then the paused ones ("Paused", by title). A schedule is never put away, so dismissed jobs are listed too.
 */
export function scheduledGroups(jobs: readonly Job[], query = ""): JobGroup[] {
  const words = searchWords(query);
  const all = jobs.filter((j) => j.scheduled && jobMatches(j, words));
  const active = all.filter((j) => !j.held).sort((a, b) => nextKey(a) - nextKey(b) || a.title.localeCompare(b.title));
  const paused = all.filter((j) => j.held).sort((a, b) => a.title.localeCompare(b.title));
  const groups: JobGroup[] = [
    { id: "active", label: GROUP_LABELS.active, jobs: active },
    { id: "paused", label: GROUP_LABELS.paused, jobs: paused },
  ];
  return groups.filter((g) => g.jobs.length > 0);
}

/** A row of the Scheduled view, in words, with its Pause or Resume. */
export interface ScheduleRow extends JobRow {
  /** pause: it waits for its time; resume: it is on hold; null: neither now (it runs, or it needs the user). */
  toggle: "pause" | "resume" | null;
}

/** Under the title its schedule ("Daily at 9:00 AM"; a one-off: "Once"), on the right when it runs next ("Paused" while on hold). */
export function scheduleRow(job: Job, now = Date.now()): ScheduleRow {
  const rule = repeatLabel(job.repeat) || "Once";
  const when = job.held
    ? STATE_LABELS.paused
    : job.running
      ? "now"
      : job.group === "scheduled"
        ? line(nextWords(job, now).replace(/^(retries )?today /, "$1"))
        : STATE_LABELS[job.state];
  // A pause that needs the user says why (its runs kept failing, a login, ...).
  const why = job.state === "needs" || isLeftNeed(job) ? job.reason : "";
  const toggle = job.held ? "resume" : !job.running && job.task?.status === "pending" ? "pause" : null;
  const next = job.held || job.running || job.group !== "scheduled" ? "" : nextWords(job, now) === "due now" ? "due now" : `next ${nextWords(job, now)}`;
  const label = [job.title, job.held ? STATE_LABELS.paused : STATE_LABELS[job.state], rule, next, why].filter(Boolean).join(", ");
  return { title: job.title, when, meta: line(rule, why), label, toggle };
}

/** A row of the list, in words. */
export interface JobRow {
  title: string;
  /** Right side: when it ran, or when it runs next. */
  when: string;
  /** Under the title, quietly: why it needs you, its repeat rule, or its site ("" for none). */
  meta: string;
  /** Everything above in one sentence, for screen readers. */
  label: string;
}

/** Words joined into one line, which alone starts with a capital: "Daily at 9:00 AM · next tomorrow 9:00 AM". */
function line(...parts: (string | false | null | undefined)[]): string {
  const text = parts.filter(Boolean).join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A time in words inside a line: "tomorrow 9:00 AM" (whenText starts it with a capital; weekdays and months keep theirs). */
const inLine = (when: string): string => when.replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase());

/** When a waiting job runs, in words, inside a line ("due now", "retries today 3:00 PM", "tomorrow 9:00 AM"). */
function nextWords(job: Job, now: number): string {
  if (job.state === "due" || !job.next) return "due now";
  const at = inLine(whenText(job.next, now));
  return job.state === "retry" ? `retries ${at}` : at;
}

export function jobRow(job: Job, now = Date.now()): JobRow {
  const rule = repeatLabel(job.repeat);
  // Standing alone on the right: today's time without "today".
  const when =
    job.group === "scheduled" ? line(nextWords(job, now).replace(/^(retries )?today /, "$1")) : job.state === "running" ? "now" : formatRelative(job.at, now);
  // A need that was left (dismissed, or it waited too long) still says what it was.
  const left = isLeftNeed(job);
  const meta = job.group === "needs" ? job.reason : left ? line(job.state === "lapsed" && STATE_LABELS.lapsed, job.reason) || job.site : job.group === "scheduled" && rule ? rule : job.site;
  const next = job.group !== "scheduled" ? when : nextWords(job, now) === "due now" ? "due now" : job.state === "retry" ? nextWords(job, now) : `next ${nextWords(job, now)}`;
  const label = [job.title, STATE_LABELS[job.state], job.group === "scheduled" ? [rule, next].filter(Boolean).join(", ") : when, job.group === "needs" || left ? job.reason : job.site]
    .filter(Boolean)
    .join(", ");
  return { title: job.title, when, meta, label };
}

/** The job page's one line under its title: "Daily at 9:00 AM · next tomorrow 9:00 AM", "Done · 5 min ago", ... */
export function jobSubtitle(job: Job, now = Date.now()): string {
  const rule = repeatLabel(job.repeat);
  switch (job.group) {
    case "scheduled": {
      const next = nextWords(job, now);
      if (next === "due now" || job.state === "retry") return line(rule, next);
      return rule ? line(rule, `next ${next}`) : line("once", next);
    }
    case "needs":
      return line(STATE_LABELS.needs, job.reason);
    case "running":
      return line(STATE_LABELS.running, rule);
    case "paused":
      return line(STATE_LABELS.paused, rule || "once");
    default:
      return line(STATE_LABELS[job.state], isLeftNeed(job) && job.reason, formatRelative(job.at, now), rule);
  }
}

/** A need the user dismissed, or one that waited too long for them. */
const isLeftNeed = (job: Job): boolean => job.state === "dismissed" || job.state === "lapsed";
