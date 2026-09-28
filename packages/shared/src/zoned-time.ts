/**
 * Wall-clock time in an IANA time zone, using only Intl.DateTimeFormat (no
 * time zone data shipped): the offset of a zone at an instant, and the
 * instant of a local date and time. Repeating tasks are computed with these
 * in the task's zone, by the API and by the extension alike.
 */
import { z } from "zod";

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when `tz` is an IANA time zone name this runtime knows (e.g. "America/New_York"). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name. */
export const TimeZone = z.string().min(1).max(64).refine(isValidTimeZone, "unknown IANA time zone");

/** This runtime's own zone (the browser's), "UTC" when it has none. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock fields of `instant` (ms) in `tz`. */
export function wallTime(instant: number, tz: string): WallTime {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! };
}

/** UTC offset of `tz` at `instant`, in ms (local = utc + offset). */
export function tzOffsetMs(instant: number, tz: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const w = wallTime(whole, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
}

/**
 * The instant of a local wall-clock time in `tz`, with the same rules as
 * JavaScript's `new Date(y, m, d, h, min)` in a local zone: a time skipped by
 * a DST jump moves forward by the jump (02:30 -> 03:30), and a time that
 * happens twice resolves to the earlier one.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = tzOffsetMs(wall - DAY_MS, tz);
  const after = tzOffsetMs(wall + DAY_MS, tz);
  const valid = [...new Set([before, after])]
    .map((off) => wall - off)
    .filter((t) => tzOffsetMs(t, tz) === wall - t)
    .sort((a, b) => a - b);
  if (valid.length) return valid[0]!;
  // Skipped by a forward jump: read it with the offset in force before the jump.
  return wall - before;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" and "HH:MM" of `instant` in `tz` (what date and time inputs hold). */
export function toZonedInputs(instant: number, tz: string): { date: string; time: string } {
  const w = wallTime(instant, tz);
  return { date: `${w.year}-${pad(w.month)}-${pad(w.day)}`, time: `${pad(w.hour)}:${pad(w.minute)}` };
}

/** The instant of a "YYYY-MM-DD" date and "HH:MM" time in `tz`; null when either is not valid. */
export function fromZonedInputs(date: string, time: string, tz: string): number | null {
  const d = parseIsoDate(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) return null;
  return zonedTimeToUtc(d.year, d.month, d.day, Number(t[1]), Number(t[2]), tz);
}

/** A calendar date "YYYY-MM-DD" split into numbers, or null when it is not a real date. */
export function parseIsoDate(date: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** A calendar date "YYYY-MM-DD". */
export const IsoDate = z.string().refine((s) => parseIsoDate(s) !== null, "not a date like 2026-09-28");
