/**
 * Cron expressions: standard 5-field lines (minute hour day-of-month month
 * day-of-week) with lists, ranges and steps, month and weekday names, and
 * Vixie cron's day rule (when both day fields are restricted, a day matches
 * either). Two widely used extensions are accepted for monthly schedules:
 * `L` in day-of-month (the last day) and, in day-of-week, `1#2` (the second
 * Monday) and `5L` (the last Friday).
 *
 * A schedule may hold several lines (one per line, or separated by `;`), and
 * runs at the times of any of them: "09:00 and 18:30 every day" is
 * "0 9 * * *" plus "30 18 * * *", which one line cannot say.
 */

export interface CronDays {
  /** Days of the month 1-31. */
  days: ReadonlySet<number>;
  /** `L`: the last day of the month. */
  last: boolean;
}

export interface CronWeekdays {
  /** 0 = Sunday … 6 = Saturday. */
  days: ReadonlySet<number>;
  /** `1#2`: the nth (1-5) such weekday of the month. */
  nth: readonly { weekday: number; n: number }[];
  /** `5L`: the last such weekday of the month. */
  last: ReadonlySet<number>;
}

export interface CronLine {
  /** The line as given, whitespace collapsed. */
  source: string;
  minutes: readonly number[];
  hours: readonly number[];
  monthDays: CronDays;
  months: ReadonlySet<number>;
  weekdays: CronWeekdays;
  /** The day-of-month field is not `*` (Vixie: a field starting with `*` does not restrict). */
  monthDaysRestricted: boolean;
  weekdaysRestricted: boolean;
}

export type CronParse = { ok: true; lines: CronLine[] } | { ok: false; error: string };

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

class CronError extends Error {}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** Names for min, min+1, … (JAN = 1, SUN = 0). */
  names?: readonly string[];
}

const FIELDS = {
  minute: { name: "minute", min: 0, max: 59 },
  hour: { name: "hour", min: 0, max: 23 },
  monthDay: { name: "day-of-month", min: 1, max: 31 },
  month: { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  weekday: { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES },
} satisfies Record<string, FieldSpec>;

function value(text: string, f: FieldSpec): number {
  const named = f.names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) return named + f.min;
  if (!/^\d+$/.test(text)) throw new CronError(`${f.name} "${text}" is not a number`);
  const n = Number(text);
  if (n < f.min || n > f.max) throw new CronError(`${f.name} ${n} is outside ${f.min}-${f.max}`);
  return n;
}

/** One list item of a field: `*`, `a`, `a-b`, each optionally `/step`; `a/step` runs to the field's end. */
function item(text: string, f: FieldSpec, out: Set<number>): void {
  const [range, stepText, extra] = text.split("/");
  if (extra !== undefined || range === "") throw new CronError(`${f.name} "${text}" is not valid`);
  let step = 1;
  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${f.name} step "${stepText}" must be a positive number`);
    step = Number(stepText);
  }
  let lo: number;
  let hi: number;
  if (range === "*") [lo, hi] = [f.min, f.max];
  else if (range!.includes("-")) {
    const [a, b, more] = range!.split("-");
    if (more !== undefined || !a || !b) throw new CronError(`${f.name} "${text}" is not valid`);
    [lo, hi] = [value(a, f), value(b, f)];
    if (hi < lo) throw new CronError(`${f.name} range ${range} goes backwards`);
  } else {
    lo = value(range!, f);
    hi = stepText === undefined ? lo : f.max;
  }
  for (let v = lo; v <= hi; v += step) out.add(v);
}

function numbers(text: string, f: FieldSpec): number[] {
  const out = new Set<number>();
  for (const part of text.split(",")) item(part, f, out);
  return [...out].sort((a, b) => a - b);
}

function monthDays(text: string): CronDays {
  const days = new Set<number>();
  let last = false;
  for (const part of text.split(",")) {
    if (part.toUpperCase() === "L") last = true;
    else item(part, FIELDS.monthDay, days);
  }
  return { days, last };
}

function weekdays(text: string): CronWeekdays {
  const days = new Set<number>();
  const nth: { weekday: number; n: number }[] = [];
  const last = new Set<number>();
  const one = (t: string) => value(t, FIELDS.weekday) % 7;
  for (const part of text.split(",")) {
    const hash = /^(\w+)#(\d+)$/.exec(part);
    const lastOf = /^(\w+)L$/i.exec(part);
    if (hash) {
      const n = Number(hash[2]);
      if (n < 1 || n > 5) throw new CronError(`day-of-week "${part}": the week must be 1-5`);
      nth.push({ weekday: one(hash[1]!), n });
    } else if (lastOf && !/^\d*$/.test(part)) {
      last.add(one(lastOf[1]!));
    } else {
      const raw = new Set<number>();
      item(part, FIELDS.weekday, raw);
      for (const d of raw) days.add(d % 7);
    }
  }
  return { days, nth, last };
}

function line(text: string): CronLine {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(`"${text.trim()}" has ${fields.length} field${fields.length === 1 ? "" : "s"}; a cron line has 5: minute hour day-of-month month day-of-week`);
  }
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return {
    source: fields.join(" "),
    minutes: numbers(min, FIELDS.minute),
    hours: numbers(hour, FIELDS.hour),
    monthDays: monthDays(dom),
    months: new Set(numbers(month, FIELDS.month)),
    weekdays: weekdays(dow),
    monthDaysRestricted: !dom.startsWith("*"),
    weekdaysRestricted: !dow.startsWith("*"),
  };
}

/** The lines of a schedule: split on new lines and `;`, blank ones dropped. */
export function cronLines(text: string): string[] {
  return text
    .split(/[\n;]/)
    .map((l) => l.trim().split(/\s+/).join(" "))
    .filter(Boolean);
}

/** Parses one or more cron lines. The error names the problem in words a person can fix. */
export function parseCron(text: string): CronParse {
  const sources = cronLines(text);
  if (!sources.length) return { ok: false, error: "The cron expression is empty" };
  try {
    return { ok: true, lines: sources.map(line) };
  } catch (err) {
    if (err instanceof CronError) return { ok: false, error: err.message };
    throw err;
  }
}

/** The canonical text of a schedule: its lines, each with single spaces, one per line. */
export function formatCron(text: string): string {
  return cronLines(text).join("\n");
}

/** The distinct times of day ("HH:MM", sorted) the lines can run at. */
export function cronTimes(lines: readonly CronLine[]): string[] {
  const out = new Set<string>();
  for (const l of lines) for (const h of l.hours) for (const m of l.minutes) out.add(`${pad(h)}:${pad(m)}`);
  return [...out].sort();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Days in a month (1-12) of a year. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True when the line's day fields match this calendar date (Vixie: either day field when both are restricted). */
export function cronMatchesDay(l: CronLine, year: number, month: number, day: number): boolean {
  if (!l.months.has(month)) return false;
  const dim = daysInMonth(year, month);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domOk = l.monthDays.days.has(day) || (l.monthDays.last && day === dim);
  const w = l.weekdays;
  const dowOk =
    w.days.has(weekday) ||
    w.nth.some((x) => x.weekday === weekday && Math.ceil(day / 7) === x.n) ||
    (w.last.has(weekday) && day + 7 > dim);
  // Vixie cron: either field when both are restricted, else both (a `*` field matches every day).
  return l.monthDaysRestricted && l.weekdaysRestricted ? domOk || dowOk : domOk && dowOk;
}

/** Every day of the month (e.g. `*`, `1-31`). */
export const allMonthDays = (l: CronLine) => l.monthDays.days.size === 31;
/** Every day of the week, with no nth or last weekday (e.g. `*`, `0-6`). */
export const allWeekdays = (l: CronLine) => l.weekdays.days.size === 7;
