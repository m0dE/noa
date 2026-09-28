/**
 * How a task reads in a list, the same in the side panel's jobs and the
 * dashboard: its status chip and tooltip, list order, when it runs in words,
 * and whether it is due. Pure and DOM-free.
 */
import { plural } from "./format.js";
import type { LegacyRepeatRule, RepeatSchedule } from "./schedule.js";
import { describeRepeat, prefersHour12, timeText, WEEKDAY_SHORT, type TextOptions } from "./schedule-text.js";
import type { TaskStatus } from "./task.js";
import { localTimeZone, wallTime } from "./zoned-time.js";

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

export interface Chip {
  label: string;
  tone: Tone;
}

type Timing = { status: TaskStatus; notBefore?: string | null; retryAfter?: string | null };

/** The pause reason of a job the user paused (Pause on its row or in its menu): it waits until they resume it. */
export const PAUSED_BY_USER = "Paused by you";
/** Starts the pause reason of a job paused because its runs kept failing (failureHoldReason). */
export const FAILURE_HOLD_PREFIX = "Paused after ";

/** Why a job was paused after `failures` failed runs in a row, the last one for `last`. */
export function failureHoldReason(failures: number, last: string): string {
  return `${FAILURE_HOLD_PREFIX}${failures} failed runs in a row. Last: ${last}`;
}

/**
 * The task is on hold: paused, with no time to come back by itself, by the user or after repeated failures. Only
 * resuming it (tasks.resume) puts it back on its schedule; a pause that needs the user for something else (a login,
 * an approval) is not a hold.
 */
export function isOnHold(task: { status: TaskStatus; retryAfter?: string | null; pauseReason?: string | null }): boolean {
  if (task.status !== "paused" || task.retryAfter) return false;
  const reason = task.pauseReason ?? "";
  return reason === PAUSED_BY_USER || reason.startsWith(FAILURE_HOLD_PREFIX);
}

/** When a pending task becomes due (the later of notBefore and retryAfter). */
export function taskNextTime(task: Timing): string | null {
  if (task.status !== "pending") return null;
  const times = [task.notBefore, task.retryAfter].filter((t): t is string => !!t);
  if (!times.length) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export function taskChip(task: Timing & { pauseReason?: string | null }, now = Date.now()): Chip {
  if (task.status === "paused" && task.pauseReason === PAUSED_BY_USER && !task.retryAfter) return { label: "paused", tone: "muted" };
  switch (task.status) {
    case "pending": {
      if (task.retryAfter && Date.parse(task.retryAfter) > now) return { label: "retry", tone: "warn" };
      const next = taskNextTime(task);
      if (next && Date.parse(next) > now) return { label: "scheduled", tone: "muted" };
      return { label: "due", tone: "accent" };
    }
    case "running":
      return { label: "running", tone: "accent" };
    case "done":
      return { label: "done", tone: "ok" };
    case "failed":
      return { label: "failed", tone: "bad" };
    case "paused":
      return { label: "needs you", tone: "warn" };
    case "cancelled":
      return { label: "cancelled", tone: "muted" };
  }
}

/** Plain-language tooltips for the status chips on tasks and runs. */
const CHIP_HINTS: Record<string, string> = {
  due: "Its time has come: it runs at the next check, or right away with Run now",
  scheduled: "Waits until the time shown, then runs at the next check",
  retry: "Stopped for a temporary reason; it is tried again by itself later",
  running: "The agent is working on it now",
  done: "Finished",
  failed: "Did not work and will not be tried again by itself; the reason is shown",
  "needs you": "The agent stopped because it needs you (a login, a code, a choice); the reason is shown",
  cancelled: "Cancelled; it will not run",
  paused: "Paused by you; it does not run until you resume it",
};

export function chipHint(label: string): string {
  return CHIP_HINTS[label] ?? "";
}

type Sortable = Timing & { createdAt: string; updatedAt: string };

/** Active tasks (running, needs you, pending) first by due time; finished ones newest first. */
export function splitTasks<T extends Sortable>(tasks: readonly T[]): { active: T[]; finished: T[] } {
  const isActive = (t: T) => t.status === "pending" || t.status === "running" || t.status === "paused";
  const rank = (t: T) => (t.status === "running" ? 0 : t.status === "paused" ? 1 : 2);
  const when = (t: T) => Date.parse(taskNextTime(t) ?? t.createdAt);
  const active = tasks.filter(isActive).sort((a, b) => rank(a) - rank(b) || when(a) - when(b));
  const finished = tasks
    .filter((t) => !isActive(t))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { active, finished };
}

/** A repeat rule in words ("Daily at 9:00 AM"), an old { dailyAt } one too; no repeat -> "". Never raw cron. */
export function repeatLabel(repeat: RepeatSchedule | LegacyRepeatRule | null | undefined, opts: TextOptions = {}): string {
  return repeat ? describeRepeat(repeat, opts) : "";
}

/**
 * True when a task would start at the next check: pending with its time
 * come. `account`: the account's queue, which also takes up a paused task
 * once its retry time has come (the API's claim does the same in SQL).
 * The extension's scheduler picks local tasks with this, and the dashboard
 * counts "Run due (N)" with it.
 */
export function isDueNow(task: Timing, now = Date.now(), source: "local" | "account" = "local"): boolean {
  const passed = (iso: string | null | undefined) => !iso || Date.parse(iso) <= now;
  if (task.status === "pending") return passed(task.notBefore) && passed(task.retryAfter);
  return source === "account" && task.status === "paused" && !!task.retryAfter && passed(task.retryAfter);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time soon, in words: "Today 3:00 PM", "Tomorrow 9:00 AM", "Fri 9:00 AM", "Oct 12, 9:00 AM" (in `tz`, default this runtime's). */
export function whenText(iso: string, now = Date.now(), opts: { hour12?: boolean; tz?: string } = {}): string {
  const tz = opts.tz ?? localTimeZone();
  const hour12 = opts.hour12 ?? prefersHour12();
  const w = wallTime(Date.parse(iso), tz);
  const n = wallTime(now, tz);
  const days = Math.round((Date.UTC(w.year, w.month - 1, w.day) - Date.UTC(n.year, n.month - 1, n.day)) / 86_400_000);
  const time = timeText(w.hour, w.minute, hour12);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY_SHORT[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()]} ${time}`;
  return `${MONTHS[w.month - 1]} ${w.day}${w.year === n.year ? "" : `, ${w.year}`}, ${time}`;
}

/**
 * How a task's schedule reads in a list row: its repeat rule in words
 * ("Daily at 9:00 AM"), else "Once · Today 3:00 PM" while it waits, "Due now"
 * when its time has come, and "Once" when it is over.
 */
export function scheduleLabel(
  task: Timing & { repeat?: RepeatSchedule | null },
  now = Date.now(),
  opts: { hour12?: boolean; tz?: string } = {},
): string {
  if (task.repeat) return repeatLabel(task.repeat, { ...opts, now: new Date(now) });
  if (task.status !== "pending") return "Once";
  const next = taskNextTime(task);
  return next && Date.parse(next) > now ? `Once · ${whenText(next, now, opts)}` : "Due now";
}

/** The TODO list on a plan without it (the side panel's Schedule and the dashboard's TODO page say the same). */
export const TODO_LOCKED = {
  title: "TODO needs a paid plan",
  why: "Tasks are stored in your account and run on schedule.",
  action: "Get a plan",
} as const;

/** "You have 3 saved tasks; they come back when you subscribe." ("" for none): what a locked list keeps. */
export function keptTasksText(n: number): string {
  if (n <= 0) return "";
  return n === 1 ? "You have 1 saved task; it comes back when you subscribe." : `You have ${plural(n, "saved task")}; they come back when you subscribe.`;
}
