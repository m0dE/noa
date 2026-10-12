/**
 * Schedules in words, for task rows, details and the form's summary line:
 * "Daily at 9:00 AM", "Every weekday at 9:00 AM and 6:30 PM",
 * "Every 2 weeks on Mon and Thu at 18:30", "Monthly on the 1st at 08:00".
 * Never raw cron: a rule this cannot put in words still reads as a sentence.
 */
import { allMonthDays, allWeekdays, parseCron, type CronLine } from "./cron.js";
import { dateInZone, readStoredRepeat, type LegacyRepeatRule, type RepeatInterval, type RepeatSchedule } from "./schedule.js";
import { localTimeZone, parseIsoDate } from "./zoned-time.js";

export interface TextOptions {
  /** 12-hour times ("9:00 AM"); false: 24-hour ("09:00"). Default: the runtime locale's choice. */
  hour12?: boolean;
  /** For dates: the year is left out when it is this one. */
  now?: Date;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const NTH_NAMES: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last" };
/** Monday first, the order the week is shown in. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
/** Lists longer than this read as a count and a span. */
const MAX_LISTED_TIMES = 6;

/** True when this runtime's locale writes times with AM/PM. */
export function prefersHour12(): boolean {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 ?? false;
  } catch {
    return false;
  }
}

/** "9:00 AM" or "09:00". */
export function timeText(h: number, m: number, hour12: boolean): string {
  const mm = String(m).padStart(2, "0");
  if (!hour12) return `${String(h).padStart(2, "0")}:${mm}`;
  return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "Sep 28", with the year when it is not `now`'s. */
export function dateText(date: string, now = new Date()): string {
  const d = parseIsoDate(date);
  if (!d) return date;
  return `${MONTH_SHORT[d.month - 1]} ${d.day}${d.year === now.getFullYear() ? "" : `, ${d.year}`}`;
}

const sorted = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);
const weekOrder = (days: Iterable<number>) => [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** When in the day: "at 9:00 AM and 6:30 PM", "every hour", "every 2 hours at :15", "10 times a day, 8:00 AM to 5:00 PM". */
function timesPhrase(lines: readonly CronLine[], hour12: boolean): string {
  const minutes = new Set(lines.flatMap((l) => l.minutes));
  const hourSets = lines.map((l) => l.hours);
  if (minutes.size === 1 && lines.length === 1) {
    const m = lines[0]!.minutes[0]!;
    const hours = hourSets[0]!;
    const step = hours.length > 1 ? hours[1]! - hours[0]! : 0;
    const evenly = hours.length > 2 && hours.every((h, i) => h === hours[0]! + i * step);
    const at = m ? ` at :${String(m).padStart(2, "0")}` : "";
    if (evenly && hours[0] === 0 && hours.at(-1)! + step > 23) return `${step === 1 ? "every hour" : `every ${step} hours`}${at}`;
    if (evenly && step === 1) return `every hour${at} from ${timeText(hours[0]!, m, hour12)} to ${timeText(hours.at(-1)!, m, hour12)}`;
  }
  const times = sorted(new Set(lines.flatMap((l) => l.hours.flatMap((h) => l.minutes.map((m) => h * 60 + m)))));
  const text = (t: number) => timeText(Math.floor(t / 60), t % 60, hour12);
  if (times.length > MAX_LISTED_TIMES) return `${times.length} times a day, ${text(times[0]!)} to ${text(times.at(-1)!)}`;
  return `at ${listText(times.map(text))}`;
}

function weekdayList(days: readonly number[], long: boolean): string {
  return listText(weekOrder(days).map((d) => (long ? WEEKDAY_NAMES[d]! : WEEKDAY_SHORT[d]!)));
}

/** Which days, for lines that share their day fields: "Daily", "Every weekday", "Monthly on the 1st", … */
function daysPhrase(l: CronLine, interval: RepeatInterval | undefined): string {
  const every = interval && interval.every > 1 ? interval : undefined;
  const allMonths = l.months.size === 12;
  const monthsSuffix = allMonths ? "" : ` in ${listText(sorted(l.months).map((m) => MONTH_SHORT[m - 1]!))}`;
  const unitSuffix = (unit: RepeatInterval["unit"]) => (every && every.unit !== unit ? `, every ${plural(every.every, every.unit)}` : "");
  const w = l.weekdays;
  const domDays = sorted(l.monthDays.days);
  const domText = listText([...domDays.map(ordinal), ...(l.monthDays.last ? ["last day"] : [])].map((x, i) => (i === 0 ? `the ${x}` : x)));
  const monthlyDow = [
    ...w.nth.map((x) => `the ${NTH_NAMES[x.n]} ${WEEKDAY_NAMES[x.weekday]}`),
    ...weekOrder(w.last).map((d) => `the last ${WEEKDAY_NAMES[d]}`),
  ];

  const either = l.monthDaysRestricted && l.weekdaysRestricted;
  const everyDom = allMonthDays(l);
  const everyDow = allWeekdays(l) && !monthlyDow.length;
  if ((everyDom && everyDow) || (either && (everyDom || everyDow))) {
    if (every?.unit === "day") return `Every ${every.every} days${monthsSuffix}`;
    return `${allMonths ? "Daily" : "Every day"}${monthsSuffix}${unitSuffix("day")}`;
  }
  if (everyDom) {
    if (monthlyDow.length && !w.days.size) {
      const lead = every?.unit === "month" ? `Every ${every.every} months on` : allMonths ? "Monthly on" : "On";
      return `${lead} ${listText(monthlyDow)}${monthsSuffix}${unitSuffix("month")}`;
    }
    const days = sorted(w.days);
    if (!monthlyDow.length) {
      if (every?.unit === "week") return `Every ${every.every} weeks on ${weekdayList(days, days.length === 1)}${monthsSuffix}`;
      const name = same(days, [1, 2, 3, 4, 5]) ? "Every weekday" : same(days, [0, 6]) ? "Every weekend day" : days.length === 7 ? "Daily" : `Every ${weekdayList(days, days.length === 1)}`;
      return `${name}${monthsSuffix}${unitSuffix("week")}`;
    }
    return `On ${weekdayList(days, false)} and ${listText(monthlyDow)}${monthsSuffix}${unitSuffix("week")}`;
  }
  if (everyDow) {
    if (every?.unit === "month") return `Every ${every.every} months on ${domText}${monthsSuffix}`;
    if (l.months.size === 1 && domDays.length === 1 && !l.monthDays.last) return `Every year on ${MONTH_SHORT[sorted(l.months)[0]! - 1]} ${domDays[0]}${unitSuffix("month")}`;
    return `${allMonths ? "Monthly on" : "On"} ${domText}${monthsSuffix}${unitSuffix("month")}`;
  }
  const dow = [...(w.days.size ? [`${either ? "every " : ""}${weekdayList(sorted(w.days), true)}`] : []), ...monthlyDow];
  const tail = `${monthsSuffix}${every ? `, every ${plural(every.every, every.unit)}` : ""}`;
  // Both fields restricted: cron runs on either; one of them `*`-based (e.g. `*/2`): on both.
  return either ? `On ${domText} of the month or ${listText(dow)}${tail}` : `On ${domText} of the month if it is ${listText(dow)}${tail}`;
}

const dayKey = (l: CronLine) => l.source.split(" ").slice(2).join(" ");

/** A cron text with an optional interval in words, e.g. "Every weekday at 9:00 AM". Invalid cron: "Custom schedule". */
export function describeCron(cron: string, interval?: RepeatInterval, opts: TextOptions = {}): string {
  const parsed = parseCron(cron);
  if (!parsed.ok) return "Custom schedule";
  const hour12 = opts.hour12 ?? prefersHour12();
  // Lines on the same days read as one phrase with all their times.
  const groups = new Map<string, CronLine[]>();
  for (const l of parsed.lines) groups.set(dayKey(l), [...(groups.get(dayKey(l)) ?? []), l]);
  const parts = [...groups.values()].map((lines) => {
    const days = daysPhrase(lines[0]!, interval);
    const times = timesPhrase(lines, hour12);
    if (times.startsWith("at ")) return `${days} ${times}`;
    return days === "Daily" ? times[0]!.toUpperCase() + times.slice(1) : `${days}, ${times}`;
  });
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toLowerCase() + p.slice(1))).join("; ");
}

/** A repeat rule in words: the days and times, then its start, end and run count ("…, starting Sep 28, until Dec 31"). */
export function describeRepeat(stored: RepeatSchedule | LegacyRepeatRule, opts: TextOptions = {}): string {
  // A rule stored before rules became cron ({ dailyAt }, in this runtime's zone) reads the same; anything else just "Repeats".
  const repeat = readStoredRepeat(stored, localTimeZone());
  if (!repeat) return "Repeats";
  const now = opts.now ?? new Date();
  const extra: string[] = [];
  if (repeat.start && repeat.start > dateInZone(now.getTime(), repeat.tz)) extra.push(`starting ${dateText(repeat.start, now)}`);
  if (repeat.end) extra.push(`until ${dateText(repeat.end, now)}`);
  if (repeat.count !== undefined) extra.push(`for ${plural(repeat.count, "run")}`);
  return [describeCron(repeat.cron, repeat.interval, opts), ...extra].join(", ");
}
