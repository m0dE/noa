/**
 * When a task runs: once (`at`, or as soon as possible), or again and again
 * by a repeat rule stored as cron in an IANA time zone.
 *
 *   schedule: { at?: ISO datetime, repeat?: { cron, tz, start?, end?, interval?, count? } }
 *
 * - cron: one or more 5-field lines (see cron.ts); the task runs at the times
 *   of any line.
 * - start / end: the first and last calendar day (in tz) a run may fall on.
 * - interval: "every N days/weeks/months", which cron cannot say (`*\/2` in
 *   the day field restarts every month). A cron time counts only in every Nth
 *   day, week (Monday to Sunday) or month, counted from `start`, the anchor:
 *   a rule with an interval always has a start (filled with the first run's
 *   day when left out).
 * - count: runs left, this one included. Each next occurrence carries one
 *   less; the one with count 1 is the last.
 *
 * `at` is the first run; without it the first run is the rule's next time.
 * Each later run is the rule's next time after the previous one ended, so a
 * late or long run never makes two runs in a row.
 */
import { z } from "zod";
import { cronLines, cronMatchesDay, cronTimes, daysInMonth, formatCron, parseCron, type CronLine } from "./cron.js";
import { IsoDate, parseIsoDate, TimeZone, wallTime, zonedTimeToUtc } from "./zoned-time.js";

/** Times a day a repeating task can run (every distinct time of its cron lines together). */
export const MAX_REPEAT_TIMES = 24;
/** Lines one repeat rule can hold. */
export const MAX_CRON_LINES = MAX_REPEAT_TIMES;
export const MAX_CRON_CHARS = 1000;
/** Largest N of "every N days/weeks/months". */
export const MAX_REPEAT_INTERVAL = 99;
/** Largest "ends after N runs". */
export const MAX_REPEAT_COUNT = 1000;
/** How far ahead the next run is looked for (a Feb 29 rule waits up to 8 years). */
const SEARCH_YEARS = 12;

export const RepeatUnit = z.enum(["day", "week", "month"]);
export type RepeatUnit = z.infer<typeof RepeatUnit>;

/** Why a cron text cannot be a repeat rule, or null when it can. */
export function cronProblem(text: string): string | null {
  const parsed = parseCron(text);
  if (!parsed.ok) return parsed.error;
  if (parsed.lines.length > MAX_CRON_LINES) return `At most ${MAX_CRON_LINES} cron lines`;
  const perDay = cronTimes(parsed.lines).length;
  if (perDay > MAX_REPEAT_TIMES) return `That runs up to ${perDay} times a day; the most is ${MAX_REPEAT_TIMES}`;
  return null;
}

const Cron = z
  .string()
  .max(MAX_CRON_CHARS)
  .superRefine((text, ctx) => {
    const problem = cronProblem(text);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .transform(formatCron);

export const RepeatInterval = z.object({
  every: z.number().int().min(1).max(MAX_REPEAT_INTERVAL),
  unit: RepeatUnit,
});
export type RepeatInterval = z.infer<typeof RepeatInterval>;

/** A repeat rule. See the top of this file. */
export const RepeatSchedule = z
  .object({
    cron: Cron,
    tz: TimeZone,
    start: IsoDate.optional(),
    end: IsoDate.optional(),
    interval: RepeatInterval.optional(),
    count: z.number().int().min(1).max(MAX_REPEAT_COUNT).optional(),
  })
  .refine((r) => !r.start || !r.end || r.end >= r.start, { message: "the end date is before the start date", path: ["end"] });
export type RepeatSchedule = z.infer<typeof RepeatSchedule>;

/** Input of a task's schedule (POST/PATCH /v1/tasks). */
export const ScheduleInput = z.object({
  /** The first (or only) run; omitted: as soon as possible, or the rule's first time. */
  at: z.iso.datetime({ offset: true }).nullable().optional(),
  repeat: RepeatSchedule.nullable().optional(),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

/** A task's schedule as the API returns it: `at` is when this task (occurrence) runs, null = as soon as possible. */
export const TaskSchedule = z.object({
  at: z.string().nullable(),
  repeat: RepeatSchedule.nullable(),
});
export type TaskSchedule = z.infer<typeof TaskSchedule>;

/** The old repeat rule, still accepted: every day at these "HH:MM" times, in the task's `tz` (default UTC). */
export const LegacyRepeatRule = z.object({
  dailyAt: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
    .min(1)
    .max(MAX_REPEAT_TIMES),
});
export type LegacyRepeatRule = z.infer<typeof LegacyRepeatRule>;

/**
 * Times of day ("HH:MM") on the given day fields ("* * *" = every day) as
 * cron lines: one line per distinct minute, with its hours, by minute.
 * ("09:00", "18:00", "18:30" -> "0 9,18 …" and "30 18 …".) The D1 migration
 * that converted stored rules builds the same text.
 */
export function timesToCron(times: readonly string[], dayFields = "* * *"): string {
  const byMinute = new Map<number, Set<number>>();
  for (const t of times) {
    const [h, m] = t.split(":").map(Number) as [number, number];
    byMinute.set(m, (byMinute.get(m) ?? new Set()).add(h));
  }
  return [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([m, hours]) => `${m} ${[...hours].sort((a, b) => a - b).join(",")} ${dayFields}`)
    .join("\n");
}

/** { dailyAt } in `tz` (default UTC) as a repeat rule. */
export function legacyToRepeat(rule: LegacyRepeatRule, tz?: string | null): RepeatSchedule {
  return { cron: timesToCron(rule.dailyAt), tz: tz || "UTC" };
}

/** A stored rule in either shape (a row written before the change may still hold { dailyAt }). */
export function readStoredRepeat(value: unknown, legacyTz?: string | null): RepeatSchedule | null {
  const current = RepeatSchedule.safeParse(value);
  if (current.success) return current.data;
  const legacy = LegacyRepeatRule.safeParse(value);
  return legacy.success ? legacyToRepeat(legacy.data, legacyTz) : null;
}

// ---- Calendar days -------------------------------------------------------

/** A calendar date as whole days since 1970-01-01. */
const epochDay = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
const fromEpochDay = (n: number) => {
  const d = new Date(n * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};
/** Monday-based week number (1970-01-01 was a Thursday). */
const weekIndex = (day: number) => Math.floor((day + 3) / 7);

function isoDay(date: string): number {
  const d = parseIsoDate(date)!;
  return epochDay(d.year, d.month, d.day);
}

/** "YYYY-MM-DD" of `instant` in `tz`. */
export function dateInZone(instant: number, tz: string): string {
  const w = wallTime(instant, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

function inInterval(interval: RepeatInterval | undefined, anchor: number | null, day: number): boolean {
  if (!interval || interval.every === 1 || anchor === null) return true;
  let diff: number;
  if (interval.unit === "day") diff = day - anchor;
  else if (interval.unit === "week") diff = weekIndex(day) - weekIndex(anchor);
  else {
    const a = fromEpochDay(anchor);
    const d = fromEpochDay(day);
    diff = d.year * 12 + d.month - (a.year * 12 + a.month);
  }
  return diff >= 0 && diff % interval.every === 0;
}

function linesOf(repeat: RepeatSchedule): CronLine[] {
  const parsed = parseCron(repeat.cron);
  if (!parsed.ok) throw new Error(`invalid repeat rule: ${parsed.error}`);
  return parsed.lines;
}

/**
 * The rule's first time strictly after `after`, within its start and end
 * days and interval; null when it has none (ended, or never matches).
 * DST: a time skipped by a jump forward runs at the moment after the jump
 * (02:30 -> 03:30); a time that happens twice runs once, the first time.
 */
export function nextRun(repeat: RepeatSchedule, after: Date): Date | null {
  const lines = linesOf(repeat);
  const tz = repeat.tz;
  const afterMs = after.getTime();
  const anchor = repeat.start ? isoDay(repeat.start) : null;
  const last = repeat.end ? isoDay(repeat.end) : Infinity;
  const today = wallTime(afterMs, tz);
  // A time a DST jump moved can land on the next local day's instant: start one day back.
  let day = Math.max(epochDay(today.year, today.month, today.day) - 1, anchor ?? -Infinity);
  const stop = Math.min(last, day + Math.ceil(SEARCH_YEARS * 366));
  const months = new Set(lines.flatMap((l) => [...l.months]));
  while (day <= stop) {
    const { year, month, day: dom } = fromEpochDay(day);
    if (!months.has(month)) {
      day += daysInMonth(year, month) - dom + 1;
      continue;
    }
    if (inInterval(repeat.interval, anchor, day)) {
      let best: number | null = null;
      for (const l of lines) {
        if (!cronMatchesDay(l, year, month, dom)) continue;
        for (const h of l.hours) {
          for (const m of l.minutes) {
            const at = zonedTimeToUtc(year, month, dom, h, m, tz);
            if (at > afterMs && (best === null || at < best)) best = at;
          }
        }
      }
      if (best !== null) return new Date(best);
    }
    day++;
  }
  return null;
}

/**
 * The occurrence after a run of a repeating task ended at `after`: when it
 * runs and its rule (one run fewer when counted); null when the rule is over.
 */
export function nextOccurrence(repeat: RepeatSchedule, after: Date): { at: Date; repeat: RepeatSchedule } | null {
  if (repeat.count !== undefined && repeat.count <= 1) return null;
  const at = nextRun(repeat, after);
  if (!at) return null;
  return { at, repeat: repeat.count === undefined ? repeat : { ...repeat, count: repeat.count - 1 } };
}

/**
 * A new task's schedule, settled: the first run (`at`, else the rule's next
 * time after `now`, else null = as soon as possible) and the rule as stored
 * (an interval gets its anchor: the first run's day). Throws when a repeat
 * rule has no run at all.
 */
export function settleSchedule(
  at: string | null | undefined,
  repeat: RepeatSchedule | null | undefined,
  now: Date,
): { notBefore: string | null; repeat: RepeatSchedule | null } {
  const first = at ? new Date(at).toISOString() : null;
  if (!repeat) return { notBefore: first, repeat: null };
  let rule: RepeatSchedule = { ...repeat, cron: formatCron(repeat.cron) };
  if (rule.interval?.every === 1) {
    const { interval: _drop, ...rest } = rule;
    rule = rest;
  }
  const notBefore = first ?? nextRun(rule, now)?.toISOString() ?? null;
  if (!notBefore) throw new ScheduleError("This repeat rule never runs: check its days, start and end");
  if (rule.interval && !rule.start) rule = { ...rule, start: dateInZone(Date.parse(notBefore), rule.tz) };
  return { notBefore, repeat: rule };
}

/**
 * When a paused task runs once resumed: a repeating one whose time went by while it was paused at its rule's next
 * time after `now` (the runs it missed are skipped, not made up at once); otherwise at its own time (a one-off whose
 * time went by: now).
 */
export function resumedNotBefore(notBefore: string | null, repeat: RepeatSchedule | null | undefined, now: Date): string | null {
  if (!repeat || !notBefore || Date.parse(notBefore) > now.getTime()) return notBefore;
  return nextRun(repeat, now)?.toISOString() ?? notBefore;
}

/** A schedule that cannot be used (the API answers 400 with its message). */
export class ScheduleError extends Error {}

/** True when the text is one or more valid cron lines (used by forms before the full rule is checked). */
export function isCron(text: string): boolean {
  return cronLines(text).length > 0 && cronProblem(text) === null;
}
