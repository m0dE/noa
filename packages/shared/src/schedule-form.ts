/**
 * The add/edit form's schedule as plain data. It is One time (a date and time;
 * empty = as soon as possible) or Repeat (a rule whose first run comes from
 * its start and its days and times). Both modes' values are kept while the
 * user switches; only the chosen one is saved.
 *
 * The repeat part's choices (frequency, every N, weekdays, a day of the month,
 * times, start and end) build the cron; a stored rule opens in them when they
 * can say it, else as "Custom" with its cron.
 * Pure: the side panel and the dashboard share it (ui/schedule-fields.ts).
 */
import { allMonthDays, allWeekdays, parseCron, type CronLine } from "./cron.js";
import {
  MAX_REPEAT_COUNT,
  MAX_REPEAT_INTERVAL,
  MAX_REPEAT_TIMES,
  nextRun,
  RepeatSchedule,
  timesToCron,
  type RepeatInterval,
  type RepeatUnit,
} from "./schedule.js";
import { fromZonedInputs, parseIsoDate, toZonedInputs } from "./zoned-time.js";

export type Frequency = "daily" | "weekly" | "monthly" | "custom";
/** -1: the last. */
export type MonthlyRule = { by: "day"; day: number } | { by: "weekday"; nth: number; weekday: number };
export type Ends = "never" | "on" | "after";

export interface RepeatForm {
  frequency: Frequency;
  /** "Every N days/weeks/months" (daily, weekly, monthly). */
  every: number;
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  monthly: MonthlyRule;
  /** "HH:MM", 24 h. */
  times: string[];
  /** "YYYY-MM-DD" or "". */
  start: string;
  ends: Ends;
  endDate: string;
  count: number;
  /** Custom: the cron text. */
  cron: string;
  /** Custom: a stored rule's interval, kept as it was (the Custom choice has no field for it). */
  customInterval?: RepeatInterval;
  tz: string;
}

export const FREQUENCY_UNIT: Record<Exclude<Frequency, "custom">, RepeatUnit> = { daily: "day", weekly: "week", monthly: "month" };

/** A fresh form: daily at `time`, starting `date`. */
export function defaultRepeatForm(o: { date: string; time: string; tz: string }): RepeatForm {
  const d = parseIsoDate(o.date);
  const weekday = d ? new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() : 1;
  const day = d?.day ?? 1;
  return {
    frequency: "daily",
    every: 1,
    weekdays: [weekday],
    monthly: { by: "day", day },
    times: [o.time],
    start: o.date,
    ends: "never",
    endDate: "",
    count: 10,
    cron: timesToCron([o.time]),
    tz: o.tz,
  };
}

export type FormField = "every" | "weekdays" | "times" | "start" | "endDate" | "count" | "cron";
export type FormResult = { ok: true; repeat: RepeatSchedule } | { ok: false; field: FormField; error: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The day-of-month, month and day-of-week fields for the form's frequency. */
function dayFields(f: RepeatForm): string {
  switch (f.frequency) {
    case "weekly":
      return `* * ${[...new Set(f.weekdays)].sort((a, b) => a - b).join(",")}`;
    case "monthly": {
      const m = f.monthly;
      if (m.by === "day") return `${m.day === -1 ? "L" : m.day} * *`;
      return `* * ${m.weekday}${m.nth === -1 ? "L" : `#${m.nth}`}`;
    }
    default:
      return "* * *";
  }
}

/** The rule the form describes, or the first field that needs fixing. */
export function formToRepeat(f: RepeatForm): FormResult {
  const fail = (field: FormField, error: string): FormResult => ({ ok: false, field, error });
  let cron: string;
  let interval: RepeatInterval | undefined;
  if (f.frequency === "custom") {
    if (!f.cron.trim()) return fail("cron", "Write a cron expression, e.g. 0 9 * * 1-5");
    cron = f.cron;
    interval = f.customInterval;
  } else {
    if (!Number.isInteger(f.every) || f.every < 1 || f.every > MAX_REPEAT_INTERVAL) return fail("every", `"Every" must be 1 to ${MAX_REPEAT_INTERVAL}`);
    if (f.frequency === "weekly" && !f.weekdays.length) return fail("weekdays", "Pick at least one day of the week");
    const times = [...new Set(f.times.filter(Boolean))];
    if (!times.length) return fail("times", "Add a time");
    if (times.some((t) => !TIME.test(t))) return fail("times", "Times must be like 09:30");
    if (times.length > MAX_REPEAT_TIMES) return fail("times", `At most ${MAX_REPEAT_TIMES} times a day`);
    cron = timesToCron(times.sort(), dayFields(f));
    if (f.every > 1) interval = { every: f.every, unit: FREQUENCY_UNIT[f.frequency] };
  }
  if (f.start && !parseIsoDate(f.start)) return fail("start", "The start date is not valid");
  if (f.ends === "on") {
    if (!parseIsoDate(f.endDate)) return fail("endDate", "Pick the end date");
    if (f.start && f.endDate < f.start) return fail("endDate", "The end date is before the start date");
  }
  if (f.ends === "after" && (!Number.isInteger(f.count) || f.count < 1 || f.count > MAX_REPEAT_COUNT)) {
    return fail("count", `The number of runs must be 1 to ${MAX_REPEAT_COUNT}`);
  }
  const parsed = RepeatSchedule.safeParse({
    cron,
    tz: f.tz,
    ...(f.start ? { start: f.start } : {}),
    ...(f.ends === "on" ? { end: f.endDate } : {}),
    ...(interval ? { interval } : {}),
    ...(f.ends === "after" ? { count: f.count } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return fail(issue.path[0] === "end" ? "endDate" : "cron", issue.message);
  }
  return { ok: true, repeat: parsed.data };
}

const dayKey = (l: CronLine) => l.source.split(" ").slice(2).join(" ");

/** The frequency and day choices that build these day fields, or null when the form cannot say them. */
function daysToForm(l: CronLine): Pick<RepeatForm, "frequency" | "weekdays" | "monthly"> | null {
  if (l.months.size !== 12) return null;
  const w = l.weekdays;
  const doms = [...l.monthDays.days];
  const everyDom = allMonthDays(l);
  const everyDow = allWeekdays(l);
  if (l.monthDaysRestricted && l.weekdaysRestricted) {
    // Either field matches: one of them covering every day makes it daily; else the form cannot say it.
    return everyDom || everyDow ? { frequency: "daily", weekdays: [], monthly: { by: "day", day: 1 } } : null;
  }
  if (everyDom && everyDow) return { frequency: "daily", weekdays: [], monthly: { by: "day", day: 1 } };
  if (everyDow) {
    if (doms.length + (l.monthDays.last ? 1 : 0) !== 1) return null;
    return { frequency: "monthly", weekdays: [], monthly: { by: "day", day: l.monthDays.last ? -1 : doms[0]! } };
  }
  if (!everyDom) return null;
  const monthly = w.nth.length + w.last.size;
  if (monthly === 0) return { frequency: "weekly", weekdays: [...w.days].sort((a, b) => a - b), monthly: { by: "day", day: 1 } };
  if (monthly === 1 && !w.days.size) {
    const nth = w.nth[0];
    if (nth && nth.n > 4) return null;
    return { frequency: "monthly", weekdays: [], monthly: { by: "weekday", nth: nth ? nth.n : -1, weekday: nth ? nth.weekday : [...w.last][0]! } };
  }
  return null;
}

/**
 * A stored rule in the form: its frequency, days and times when the form's
 * choices build exactly its cron again, else Custom with the cron as it is.
 */
export function repeatToForm(r: RepeatSchedule, fallback: { date: string; time: string }): RepeatForm {
  const base = defaultRepeatForm({ ...fallback, tz: r.tz });
  const common: RepeatForm = {
    ...base,
    start: r.start ?? "",
    ends: r.end ? "on" : r.count !== undefined ? "after" : "never",
    endDate: r.end ?? "",
    count: r.count ?? base.count,
    cron: r.cron,
    tz: r.tz,
  };
  const custom: RepeatForm = { ...common, frequency: "custom", ...(r.interval ? { customInterval: r.interval } : {}) };
  const parsed = parseCron(r.cron);
  if (!parsed.ok) return custom;
  // Times written as a pattern (e.g. "*/15 9-11") stay as written: the form would list each one.
  const listedTimes = parsed.lines.every((l) => l.source.split(" ").slice(0, 2).every((f) => /^\d+(,\d+)*$/.test(f)));
  if (!listedTimes) return custom;
  const keys = new Set(parsed.lines.map(dayKey));
  const days = keys.size === 1 ? daysToForm(parsed.lines[0]!) : null;
  if (!days) return custom;
  const unit = FREQUENCY_UNIT[days.frequency as Exclude<Frequency, "custom">];
  if (r.interval && r.interval.every > 1 && r.interval.unit !== unit) return custom;
  const times = [...new Set(parsed.lines.flatMap((l) => l.hours.flatMap((h) => l.minutes.map((m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`))))].sort();
  const form: RepeatForm = {
    ...common,
    ...days,
    weekdays: days.weekdays.length ? days.weekdays : base.weekdays,
    monthly: days.frequency === "monthly" ? days.monthly : base.monthly,
    every: r.interval?.every ?? 1,
    times,
  };
  // The form's choices hold the same days and times; they build the cron in its own words.
  return formToRepeat(form).ok ? form : custom;
}

// ---- the whole schedule: One time or Repeat ---------------------------------

export type ScheduleMode = "once" | "repeat";
export const SCHEDULE_MODES: readonly [ScheduleMode, string][] = [
  ["once", "One time"],
  ["repeat", "Repeat"],
];

/** A task's schedule as the form reads and writes it. */
export interface ScheduleValue {
  /** One time: when, ISO; null = as soon as possible. Repeat: null (the rule gives the first run). */
  at: string | null;
  repeat: RepeatSchedule | null;
}

export interface ScheduleDraft {
  mode: ScheduleMode;
  /** One time: "YYYY-MM-DD" and "HH:MM" in `tz`; both "" = as soon as possible. */
  date: string;
  time: string;
  /** Repeat: the rule's choices. */
  rule: RepeatForm;
  /** The user changed the rule: switching to Repeat no longer starts it from the One time date and time. */
  ruleTouched: boolean;
  tz: string;
}

export type ScheduleField = FormField | "date" | "time";
export type ScheduleSave = { ok: true; value: ScheduleValue } | { ok: false; field: ScheduleField; error: string };

/** A rule starting from a date and time: daily at that time (09:00 when there is none), from that day. */
function ruleFrom(date: string, time: string, tz: string, now: Date): RepeatForm {
  const today = toZonedInputs(now.getTime(), tz).date;
  return defaultRepeatForm({ date: date || today, time: time || "09:00", tz });
}

/** A task's schedule in the form (null: a new task). A repeating task opens in its rule's zone. */
export function openSchedule(value: ScheduleValue | null, o: { tz: string; now: Date }): ScheduleDraft {
  const tz = value?.repeat?.tz ?? o.tz;
  const at = value?.at ? toZonedInputs(Date.parse(value.at), tz) : { date: "", time: "" };
  const rule = value?.repeat ? repeatToForm(value.repeat, at.date ? at : { date: toZonedInputs(o.now.getTime(), tz).date, time: "09:00" }) : ruleFrom(at.date, at.time, tz, o.now);
  return { mode: value?.repeat ? "repeat" : "once", date: at.date, time: at.time, rule, ruleTouched: !!value?.repeat, tz };
}

/** The draft in `mode`. An untouched rule starts from the One time date and time (keeping its frequency and every N). */
export function withMode(d: ScheduleDraft, mode: ScheduleMode, now: Date): ScheduleDraft {
  if (mode === "once" || d.ruleTouched) return { ...d, mode };
  return { ...d, mode, rule: { ...ruleFrom(d.date, d.time, d.tz, now), frequency: d.rule.frequency, every: d.rule.every } };
}

/** The One time date and time as an instant; "" when empty (as soon as possible); null when not a valid date and time. */
export function onceInstant(d: Pick<ScheduleDraft, "date" | "time" | "tz">, now: Date): string | "" | null {
  if (!d.date && !d.time) return "";
  const at = fromZonedInputs(d.date || toZonedInputs(now.getTime(), d.tz).date, d.time, d.tz);
  return at === null ? null : new Date(at).toISOString();
}

/** What the chosen mode saves, or the field to fix. One time never saves a rule; Repeat never saves a first time. */
export function saveSchedule(d: ScheduleDraft, now: Date): ScheduleSave {
  if (d.mode === "once") {
    const at = onceInstant(d, now);
    if (at === null) return { ok: false, field: d.date ? "time" : "date", error: "Pick a date and a time" };
    return { ok: true, value: { at: at || null, repeat: null } };
  }
  const built = formToRepeat({ ...d.rule, tz: d.tz });
  if (!built.ok) return built;
  if (!nextRun(built.repeat, now)) return { ok: false, field: "start", error: "This rule never runs: check its days, start and end" };
  return { ok: true, value: { at: null, repeat: built.repeat } };
}
