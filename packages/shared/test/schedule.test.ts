import { describe, expect, it } from "vitest";
import {
  CreateTaskInput,
  cronProblem,
  defaultRepeatForm,
  describeCron,
  describeRepeat,
  formToRepeat,
  fromZonedInputs,
  isDueNow,
  legacyToRepeat,
  nextOccurrence,
  nextRun,
  parseCron,
  readStoredRepeat,
  repeatLabel,
  repeatToForm,
  requestedSchedule,
  RepeatSchedule,
  scheduleLabel,
  settleSchedule,
  timesToCron,
  toZonedInputs,
  tzOffsetMs,
  UpdateTaskInput,
  whenText,
  zonedTimeToUtc,
  openSchedule,
  saveSchedule,
  SCHEDULE_MODES,
  withMode,
  type RepeatForm,
  type ScheduleDraft,
} from "../src/index.js";

const rule = (cron: string, tz = "UTC", extra: Partial<RepeatSchedule> = {}): RepeatSchedule => RepeatSchedule.parse({ cron, tz, ...extra });
const next = (r: RepeatSchedule, after: string) => nextRun(r, new Date(after))?.toISOString() ?? null;
/** The first `n` runs after `after`. */
const runs = (r: RepeatSchedule, after: string, n: number) => {
  const out: string[] = [];
  let t = new Date(after);
  for (let i = 0; i < n; i++) {
    const at = nextRun(r, t);
    if (!at) break;
    out.push(at.toISOString());
    t = at;
  }
  return out;
};

describe("parseCron", () => {
  it("reads lists, ranges, steps and names", () => {
    const p = parseCron("0,30 9-17/4 * JAN-mar mon-FRI");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const l = p.lines[0]!;
    expect(l.minutes).toEqual([0, 30]);
    expect(l.hours).toEqual([9, 13, 17]);
    expect([...l.months]).toEqual([1, 2, 3]);
    expect([...l.weekdays.days].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(l.monthDaysRestricted).toBe(false);
    expect(l.weekdaysRestricted).toBe(true);
  });

  it("reads a/step to the end of the field, 7 as Sunday, L and #", () => {
    const p = parseCron("5/20 */6 L * 7,5L,1#2");
    if (!p.ok) throw new Error(p.error);
    const l = p.lines[0]!;
    expect(l.minutes).toEqual([5, 25, 45]);
    expect(l.hours).toEqual([0, 6, 12, 18]);
    expect(l.monthDays.last).toBe(true);
    expect([...l.weekdays.days]).toEqual([0]);
    expect([...l.weekdays.last]).toEqual([5]);
    expect(l.weekdays.nth).toEqual([{ weekday: 1, n: 2 }]);
  });

  it("takes several lines, split by new lines or ;", () => {
    const p = parseCron(" 0 9 * * * ;\n\n30  18 * * *");
    expect(p.ok && p.lines.map((l) => l.source)).toEqual(["0 9 * * *", "30 18 * * *"]);
  });

  it.each([
    ["", "The cron expression is empty"],
    ["0 9 * *", 'has 4 fields'],
    ["60 9 * * *", "minute 60 is outside 0-59"],
    ["0 24 * * *", "hour 24 is outside 0-23"],
    ["0 9 0 * *", "day-of-month 0 is outside 1-31"],
    ["0 9 * 13 *", "month 13 is outside 1-12"],
    ["0 9 * * 8", "day-of-week 8 is outside 0-7"],
    ["0 9 * * 5-1", "range 5-1 goes backwards"],
    ["0 9 * * 1#6", "the week must be 1-5"],
    ["*/0 9 * * *", "step \"0\" must be a positive number"],
    ["x 9 * * *", 'minute "x" is not a number'],
    ["0 9 * * FOO", 'day-of-week "FOO" is not a number'],
  ])("rejects %j", (text, message) => {
    const p = parseCron(text);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain(message);
  });
});

describe("cronProblem: limits", () => {
  it("allows up to 24 runs a day (the old dailyAt cap)", () => {
    expect(cronProblem("0 * * * *")).toBeNull();
    expect(cronProblem("*/30 * * * *")).toBe("That runs up to 48 times a day; the most is 24");
    expect(cronProblem("* 9 * * *")).toMatch(/60 times a day/);
    // Across lines: the distinct times together.
    expect(cronProblem("0 0-11 * * *\n0 12-23 * * *")).toBeNull();
    expect(cronProblem("0 0-11 * * *\n0 12-23 * * *\n30 9 * * *")).toMatch(/25 times a day/);
  });
});

describe("zoned inputs", () => {
  it("round-trips date and time inputs in a zone", () => {
    const at = fromZonedInputs("2026-09-28", "09:30", "Asia/Seoul")!;
    expect(new Date(at).toISOString()).toBe("2026-09-28T00:30:00.000Z");
    expect(toZonedInputs(at, "Asia/Seoul")).toEqual({ date: "2026-09-28", time: "09:30" });
    expect(fromZonedInputs("2026-02-30", "09:30", "UTC")).toBeNull();
    expect(fromZonedInputs("2026-02-10", "9:30", "UTC")).toBeNull();
  });

  it("keeps the old offset helpers", () => {
    expect(tzOffsetMs(Date.parse("2026-01-01T00:00:00Z"), "Asia/Kolkata")).toBe(5.5 * 3_600_000);
    expect(new Date(zonedTimeToUtc(2026, 7, 1, 12, 0, "America/New_York")).toISOString()).toBe("2026-07-01T16:00:00.000Z");
  });
});

describe("nextRun", () => {
  it("runs strictly after the given time, across the day boundary", () => {
    const r = rule("0 9 * * *");
    expect(next(r, "2026-09-23T08:59:00Z")).toBe("2026-09-23T09:00:00.000Z");
    expect(next(r, "2026-09-23T09:00:00Z")).toBe("2026-09-24T09:00:00.000Z");
  });

  it("combines lines (09:00 and 18:30)", () => {
    const r = rule(timesToCron(["09:00", "18:30"]));
    expect(runs(r, "2026-09-23T10:00:00Z", 3)).toEqual(["2026-09-23T18:30:00.000Z", "2026-09-24T09:00:00.000Z", "2026-09-24T18:30:00.000Z"]);
  });

  it("works in the rule's zone (a half-hour zone whose day starts before UTC's)", () => {
    const r = rule("15 0 * * *", "Asia/Kolkata");
    expect(next(r, "2026-09-23T18:40:00Z")).toBe("2026-09-23T18:45:00.000Z");
  });

  it("weekdays: Friday evening to Monday morning, and weekday names in the zone", () => {
    const r = rule("0 9 * * 1-5", "America/New_York");
    // Fri 2026-09-25 10:00 EDT -> Mon 2026-09-28 09:00 EDT.
    expect(next(r, "2026-09-25T14:00:00Z")).toBe("2026-09-28T13:00:00.000Z");
  });

  it("spring forward (New York, 2026-03-08): a skipped time runs after the jump, once", () => {
    const tz = "America/New_York";
    expect(next(rule("0 9 * * *", tz), "2026-03-07T15:00:00Z")).toBe("2026-03-08T13:00:00.000Z"); // 09:00 EDT
    const r = rule("30 2 * * *", tz);
    expect(runs(r, "2026-03-08T05:00:00Z", 2)).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    // 02:30 and 03:30 both land on 03:30 EDT: one run.
    expect(runs(rule("30 2,3 * * *", tz), "2026-03-08T05:00:00Z", 2)).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
  });

  it("fall back (New York, 2026-11-01): a doubled time runs once, the first time", () => {
    const tz = "America/New_York";
    const r = rule("30 1 * * *", tz);
    expect(runs(r, "2026-11-01T04:00:00Z", 2)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
    // Hourly: 01:00 happens twice but runs once; the day has 24 runs, not 25.
    const hourly = runs(rule("0 * * * *", tz), "2026-11-01T04:00:00Z", 24);
    expect(new Set(hourly).size).toBe(24);
    expect(hourly.filter((t) => t.startsWith("2026-11-01T05") || t.startsWith("2026-11-01T06"))).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z"].slice(0, 1));
  });

  it("DST in the southern hemisphere (Sydney, 2026-10-04 02:00 -> 03:00)", () => {
    const r = rule("30 2 * * *", "Australia/Sydney");
    // 02:30 AEST does not exist that night: 03:30 AEDT (16:30 UTC the day before).
    expect(next(r, "2026-10-03T12:00:00Z")).toBe("2026-10-03T16:30:00.000Z");
  });

  it("month ends: the 31st skips short months; L is the last day", () => {
    expect(runs(rule("0 9 31 * *"), "2026-01-31T10:00:00Z", 3)).toEqual(["2026-03-31T09:00:00.000Z", "2026-05-31T09:00:00.000Z", "2026-07-31T09:00:00.000Z"]);
    expect(runs(rule("0 9 L * *"), "2026-01-31T10:00:00Z", 3)).toEqual(["2026-02-28T09:00:00.000Z", "2026-03-31T09:00:00.000Z", "2026-04-30T09:00:00.000Z"]);
    expect(next(rule("0 9 L * *"), "2028-02-01T00:00:00Z")).toBe("2028-02-29T09:00:00.000Z");
  });

  it("Feb 29 waits for the next leap year", () => {
    expect(next(rule("0 9 29 2 *"), "2026-03-01T00:00:00Z")).toBe("2028-02-29T09:00:00.000Z");
    expect(next(rule("0 9 29 2 *"), "2096-03-01T00:00:00Z")).toBe("2104-02-29T09:00:00.000Z"); // 2100 is not a leap year
  });

  it("nth and last weekday of the month", () => {
    expect(runs(rule("0 9 * * 1#1"), "2026-09-01T00:00:00Z", 3)).toEqual(["2026-09-07T09:00:00.000Z", "2026-10-05T09:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
    expect(runs(rule("0 17 * * 5L"), "2026-09-01T00:00:00Z", 2)).toEqual(["2026-09-25T17:00:00.000Z", "2026-10-30T17:00:00.000Z"]);
  });

  it("Vixie day rule: either field when both are restricted, both when one is *-based", () => {
    // The 13th or any Friday.
    expect(runs(rule("0 9 13 * 5"), "2026-11-01T00:00:00Z", 3)).toEqual(["2026-11-06T09:00:00.000Z", "2026-11-13T09:00:00.000Z", "2026-11-20T09:00:00.000Z"]);
    // Every other weekday from Sunday (0,2,4,6), every day of the month.
    expect(runs(rule("0 9 * * */2"), "2026-09-27T10:00:00Z", 2)).toEqual(["2026-09-29T09:00:00.000Z", "2026-10-01T09:00:00.000Z"]);
  });

  it("start and end days (inclusive, in the zone)", () => {
    const r = rule("0 9 * * *", "Asia/Seoul", { start: "2026-10-01", end: "2026-10-02" });
    expect(runs(r, "2026-09-20T00:00:00Z", 5)).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
    expect(next(r, "2026-10-02T00:00:00Z")).toBeNull();
  });

  it("every 2 weeks on Mon and Thu, counted from the start's week", () => {
    const r = rule("30 18 * * 1,4", "UTC", { start: "2026-09-28", interval: { every: 2, unit: "week" } });
    expect(runs(r, "2026-09-26T00:00:00Z", 4)).toEqual([
      "2026-09-28T18:30:00.000Z",
      "2026-10-01T18:30:00.000Z",
      "2026-10-12T18:30:00.000Z",
      "2026-10-15T18:30:00.000Z",
    ]);
  });

  it("every 3 days and every 2 months, from the start", () => {
    expect(runs(rule("0 9 * * *", "UTC", { start: "2026-09-30", interval: { every: 3, unit: "day" } }), "2026-09-01T00:00:00Z", 3)).toEqual([
      "2026-09-30T09:00:00.000Z",
      "2026-10-03T09:00:00.000Z",
      "2026-10-06T09:00:00.000Z",
    ]);
    expect(runs(rule("0 8 1 * *", "UTC", { start: "2026-11-15", interval: { every: 2, unit: "month" } }), "2026-09-01T00:00:00Z", 3)).toEqual([
      "2027-01-01T08:00:00.000Z",
      "2027-03-01T08:00:00.000Z",
      "2027-05-01T08:00:00.000Z",
    ]);
  });

  it("a rule that never runs has no next run", () => {
    expect(next(rule("0 9 30 2 *"), "2026-01-01T00:00:00Z")).toBeNull();
    expect(next(rule("0 9 * * *", "UTC", { end: "2026-01-01" }), "2026-06-01T00:00:00Z")).toBeNull();
  });
});

describe("nextOccurrence and settleSchedule", () => {
  it("counts runs down and stops after the last", () => {
    const r = rule("0 9 * * *", "UTC", { count: 2 });
    const second = nextOccurrence(r, new Date("2026-09-23T09:05:00Z"))!;
    expect(second).toEqual({ at: new Date("2026-09-24T09:00:00Z"), repeat: { ...r, count: 1 } });
    expect(nextOccurrence(second.repeat, new Date("2026-09-24T09:05:00Z"))).toBeNull();
    expect(nextOccurrence(rule("0 9 * * *"), new Date("2026-09-23T09:05:00Z"))!.repeat).toEqual(rule("0 9 * * *"));
  });

  it("settles the first run and anchors an interval", () => {
    const now = new Date("2026-09-23T10:00:00Z");
    expect(settleSchedule(null, null, now)).toEqual({ notBefore: null, repeat: null });
    expect(settleSchedule("2026-09-24T12:00:00+02:00", null, now)).toEqual({ notBefore: "2026-09-24T10:00:00.000Z", repeat: null });
    const weekly = settleSchedule(null, rule("0 9 * * 1", "UTC", { interval: { every: 2, unit: "week" } }), now);
    expect(weekly).toEqual({ notBefore: "2026-09-28T09:00:00.000Z", repeat: { cron: "0 9 * * 1", tz: "UTC", start: "2026-09-28", interval: { every: 2, unit: "week" } } });
    // every 1 is no interval.
    expect(settleSchedule(null, rule("0 9 * * *", "UTC", { interval: { every: 1, unit: "day" } }), now).repeat).toEqual({ cron: "0 9 * * *", tz: "UTC" });
    expect(() => settleSchedule(null, rule("0 9 * * *", "UTC", { end: "2026-01-01" }), now)).toThrow(/never runs/);
  });
});

describe("RepeatSchedule validation", () => {
  it("normalizes the cron text and checks zone, dates and limits", () => {
    expect(RepeatSchedule.parse({ cron: " 0  9 * * * ;30 18 * * *", tz: "Europe/Berlin" }).cron).toBe("0 9 * * *\n30 18 * * *");
    for (const bad of [
      { cron: "0 9 * * *", tz: "Mars/Olympus" },
      { cron: "0 9 * *", tz: "UTC" },
      { cron: "*/5 * * * *", tz: "UTC" },
      { cron: "0 9 * * *", tz: "UTC", start: "2026-02-30" },
      { cron: "0 9 * * *", tz: "UTC", start: "2026-10-02", end: "2026-10-01" },
      { cron: "0 9 * * *", tz: "UTC", interval: { every: 0, unit: "week" } },
      { cron: "0 9 * * *", tz: "UTC", interval: { every: 2, unit: "year" } },
      { cron: "0 9 * * *", tz: "UTC", count: 0 },
    ]) {
      expect(RepeatSchedule.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("legacy dailyAt", () => {
  it("becomes cron lines, one per minute with its hours", () => {
    expect(timesToCron(["09:00"])).toBe("0 9 * * *");
    expect(timesToCron(["18:00", "09:00", "21:00"])).toBe("0 9,18,21 * * *");
    expect(timesToCron(["09:00", "18:30", "18:00"])).toBe("0 9,18 * * *\n30 18 * * *");
    expect(legacyToRepeat({ dailyAt: ["09:00", "18:30"] }, "Asia/Seoul")).toEqual({ cron: "0 9 * * *\n30 18 * * *", tz: "Asia/Seoul" });
    expect(legacyToRepeat({ dailyAt: ["09:00"] })).toEqual({ cron: "0 9 * * *", tz: "UTC" });
  });

  it("stored rules are read in either shape", () => {
    expect(readStoredRepeat({ dailyAt: ["07:15"] }, "Europe/Berlin")).toEqual({ cron: "15 7 * * *", tz: "Europe/Berlin" });
    expect(readStoredRepeat({ cron: "0 9 * * 1", tz: "UTC" })).toEqual({ cron: "0 9 * * 1", tz: "UTC" });
    expect(readStoredRepeat({ nonsense: 1 })).toBeNull();
    expect(readStoredRepeat(null)).toBeNull();
  });

  it("task inputs take schedule or the legacy fields, not both", () => {
    expect(CreateTaskInput.safeParse({ instructions: "x", repeat: { dailyAt: ["09:00"] }, tz: "UTC" }).success).toBe(true);
    expect(CreateTaskInput.safeParse({ instructions: "x", schedule: { repeat: { cron: "0 9 * * *", tz: "UTC" } } }).success).toBe(true);
    const both = CreateTaskInput.safeParse({ instructions: "x", notBefore: "2026-09-24T09:00:00Z", schedule: { at: "2026-09-24T09:00:00Z" } });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toBe("use schedule or notBefore, not both");
    expect(UpdateTaskInput.safeParse({ schedule: null }).success).toBe(true);
  });

  it("requestedSchedule converts what was asked", () => {
    expect(requestedSchedule({ repeat: { dailyAt: ["09:00", "18:30"] }, tz: "Asia/Seoul", notBefore: "2026-09-24T09:00:00Z" })).toEqual({
      at: "2026-09-24T09:00:00Z",
      repeat: { cron: "0 9 * * *\n30 18 * * *", tz: "Asia/Seoul" },
    });
    expect(requestedSchedule({})).toEqual({ at: undefined, repeat: undefined });
    expect(requestedSchedule({ tz: "Asia/Kolkata" })).toEqual({ at: undefined, repeat: undefined, retz: "Asia/Kolkata" });
    expect(requestedSchedule({ repeat: null })).toEqual({ at: undefined, repeat: null });
    expect(requestedSchedule({ schedule: null })).toEqual({ at: null, repeat: null });
    const r = rule("0 9 * * 1");
    expect(requestedSchedule({ schedule: { repeat: r } })).toEqual({ at: null, repeat: r });
  });
});

describe("describeCron", () => {
  const d = (cron: string, interval?: RepeatSchedule["interval"], hour12 = true) => describeCron(cron, interval, { hour12 });
  it.each([
    ["0 9 * * *", undefined, true, "Daily at 9:00 AM"],
    ["0 9 * * 1-5\n30 18 * * 1-5", undefined, true, "Every weekday at 9:00 AM and 6:30 PM"],
    ["30 18 * * 1,4", { every: 2, unit: "week" as const }, false, "Every 2 weeks on Mon and Thu at 18:30"],
    ["0 8 1 * *", undefined, false, "Monthly on the 1st at 08:00"],
    ["0 9 * * 1", undefined, true, "Every Monday at 9:00 AM"],
    ["0 9 * * 1,3,5", undefined, true, "Every Mon, Wed and Fri at 9:00 AM"],
    ["0 10 * * 0,6", undefined, true, "Every weekend day at 10:00 AM"],
    ["0 9 * * 1#1", undefined, true, "Monthly on the first Monday at 9:00 AM"],
    ["0 17 * * 5L", undefined, true, "Monthly on the last Friday at 5:00 PM"],
    ["0 9 L * *", undefined, true, "Monthly on the last day at 9:00 AM"],
    ["0 9 1,15 * *", undefined, true, "Monthly on the 1st and 15th at 9:00 AM"],
    ["0 9 * * *", { every: 3, unit: "day" as const }, true, "Every 3 days at 9:00 AM"],
    ["0 9 1 * *", { every: 3, unit: "month" as const }, true, "Every 3 months on the 1st at 9:00 AM"],
    ["0 9 25 12 *", undefined, true, "Every year on Dec 25 at 9:00 AM"],
    ["0 9 * 1,7 *", undefined, true, "Every day in Jan and Jul at 9:00 AM"],
    ["0 * * * *", undefined, true, "Every hour"],
    ["15 */2 * * *", undefined, true, "Every 2 hours at :15"],
    ["0 9-17 * * 1-5", undefined, true, "Every weekday, every hour from 9:00 AM to 5:00 PM"],
    ["0 9 13 * 5", undefined, true, "On the 13th of the month or every Friday at 9:00 AM"],
    ["0 9 * * 1-5\n0 10 * * 0,6", undefined, true, "Every weekday at 9:00 AM; every weekend day at 10:00 AM"],
    ["0 0,2,4,6,8,10,12 * * *", undefined, false, "7 times a day, 00:00 to 12:00"],
    ["not cron", undefined, true, "Custom schedule"],
  ])("%j -> %s", (cron, interval, hour12, text) => {
    expect(d(cron, interval, hour12)).toBe(text);
  });

  it("describes start, end and count", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    const r = rule(timesToCron(["09:00", "18:30"], "* * 1-5"), "UTC", { start: "2026-09-28", end: "2026-12-31" });
    expect(describeRepeat(r, { hour12: true, now })).toBe("Every weekday at 9:00 AM and 6:30 PM, starting Sep 28, until Dec 31");
    expect(describeRepeat(rule("0 9 * * *", "UTC", { start: "2026-09-01", end: "2027-01-31", count: 5 }), { hour12: true, now })).toBe(
      "Daily at 9:00 AM, until Jan 31, 2027, for 5 runs",
    );
  });
});

describe("form <-> rule", () => {
  const base = (over: Partial<RepeatForm>): RepeatForm => ({ ...defaultRepeatForm({ date: "2026-09-28", time: "09:00", tz: "UTC" }), ...over });
  const build = (over: Partial<RepeatForm>) => {
    const r = formToRepeat(base(over));
    if (!r.ok) throw new Error(r.error);
    return r.repeat;
  };

  it("starts daily at the scheduled time, on its day", () => {
    expect(defaultRepeatForm({ date: "2026-09-28", time: "09:00", tz: "UTC" })).toMatchObject({ frequency: "daily", times: ["09:00"], start: "2026-09-28", weekdays: [1], monthly: { by: "day", day: 28 } });
  });

  it.each<[string, Partial<RepeatForm>, Partial<RepeatSchedule>]>([
    ["daily with 2 times", { times: ["18:30", "09:00"] }, { cron: "0 9 * * *\n30 18 * * *" }],
    ["every 2 days", { every: 2 }, { cron: "0 9 * * *", interval: { every: 2, unit: "day" } }],
    ["weekly Mon/Wed/Fri", { frequency: "weekly", weekdays: [5, 1, 3] }, { cron: "0 9 * * 1,3,5" }],
    ["every 2 weeks", { frequency: "weekly", weekdays: [1, 4], every: 2, times: ["18:30"] }, { cron: "30 18 * * 1,4", interval: { every: 2, unit: "week" } }],
    ["monthly on day 1", { frequency: "monthly", monthly: { by: "day", day: 1 } }, { cron: "0 9 1 * *" }],
    ["monthly on the last day", { frequency: "monthly", monthly: { by: "day", day: -1 } }, { cron: "0 9 L * *" }],
    ["monthly first Monday", { frequency: "monthly", monthly: { by: "weekday", nth: 1, weekday: 1 } }, { cron: "0 9 * * 1#1" }],
    ["monthly last Friday", { frequency: "monthly", monthly: { by: "weekday", nth: -1, weekday: 5 } }, { cron: "0 9 * * 5L" }],
    ["custom cron", { frequency: "custom", cron: "*/15 9-11 * * 1-5" }, { cron: "*/15 9-11 * * 1-5" }],
    ["with an end date", { ends: "on", endDate: "2026-12-31" }, { end: "2026-12-31" }],
    ["after 5 runs", { ends: "after", count: 5 }, { count: 5 }],
  ])("%s builds the rule and opens again the same", (_name, over, want) => {
    const r = build(over);
    expect(r).toMatchObject({ tz: "UTC", start: "2026-09-28", ...want });
    const again = repeatToForm(r, { date: "2026-09-28", time: "09:00" });
    const back = formToRepeat(again);
    expect(back.ok && back.repeat).toEqual(r);
    if (over.frequency !== "custom") expect(again.frequency).toBe(over.frequency ?? "daily");
  });

  it("opens rules the choices cannot say as Custom, keeping their interval", () => {
    const r = rule("*/15 9-11 * * 1-5");
    expect(repeatToForm(r, { date: "2026-09-28", time: "09:00" })).toMatchObject({ frequency: "custom", cron: "*/15 9-11 * * 1-5" });
    expect(repeatToForm(rule("0 9 * 1 *"), { date: "2026-09-28", time: "09:00" }).frequency).toBe("custom");
    expect(repeatToForm(rule("0 9 13 * 5"), { date: "2026-09-28", time: "09:00" }).frequency).toBe("custom");
    expect(repeatToForm(rule("0 9 * * 1#5"), { date: "2026-09-28", time: "09:00" }).frequency).toBe("custom");
    const odd = rule("0 9 * * 1", "UTC", { start: "2026-09-28", interval: { every: 3, unit: "day" } });
    const f = repeatToForm(odd, { date: "2026-09-28", time: "09:00" });
    expect(f).toMatchObject({ frequency: "custom", customInterval: { every: 3, unit: "day" } });
    const back = formToRepeat(f);
    expect(back.ok && back.repeat).toEqual(odd);
  });

  it("opens names and ranges as the choices they are", () => {
    expect(repeatToForm(rule("0 9 * * MON-FRI"), { date: "2026-09-28", time: "09:00" })).toMatchObject({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5] });
    expect(repeatToForm(rule("0,30 9 * * *"), { date: "2026-09-28", time: "09:00" })).toMatchObject({ frequency: "daily", times: ["09:00", "09:30"] });
  });

  it.each<[Partial<RepeatForm>, string, string]>([
    [{ frequency: "weekly", weekdays: [] }, "weekdays", "Pick at least one day of the week"],
    [{ times: [] }, "times", "Add a time"],
    [{ times: ["9am"] }, "times", "Times must be like 09:30"],
    [{ every: 0 }, "every", '"Every" must be 1 to 99'],
    [{ ends: "on", endDate: "" }, "endDate", "Pick the end date"],
    [{ ends: "on", endDate: "2026-09-01" }, "endDate", "The end date is before the start date"],
    [{ ends: "after", count: 0 }, "count", "The number of runs must be 1 to 1000"],
    [{ frequency: "custom", cron: "" }, "cron", "Write a cron expression, e.g. 0 9 * * 1-5"],
    [{ frequency: "custom", cron: "0 9 * *" }, "cron", '"0 9 * *" has 4 fields; a cron line has 5: minute hour day-of-month month day-of-week'],
    [{ frequency: "custom", cron: "* * * * *" }, "cron", "That runs up to 1440 times a day; the most is 24"],
  ])("says what to fix: %j", (over, field, error) => {
    expect(formToRepeat(base(over))).toEqual({ ok: false, field, error });
  });
});

describe("schedule: One time or Repeat", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const ctx = { tz: "UTC", now };
  const edit = (d: ScheduleDraft, over: Partial<ScheduleDraft>): ScheduleDraft => ({ ...d, ...over });
  const editRule = (d: ScheduleDraft, over: Partial<RepeatForm>): ScheduleDraft => ({ ...d, rule: { ...d.rule, ...over }, ruleTouched: true });

  it("names the two modes in one place, One time first", () => {
    expect(SCHEDULE_MODES).toEqual([
      ["once", "One time"],
      ["repeat", "Repeat"],
    ]);
  });

  it("a new task opens as One time, empty: as soon as possible", () => {
    const d = openSchedule(null, ctx);
    expect(d).toMatchObject({ mode: "once", date: "", time: "", tz: "UTC", ruleTouched: false });
    expect(saveSchedule(d, now)).toEqual({ ok: true, value: { at: null, repeat: null } });
  });

  it("One time saves its date and time and no rule", () => {
    const d = edit(openSchedule(null, ctx), { date: "2026-09-30", time: "15:00" });
    expect(saveSchedule(d, now)).toEqual({ ok: true, value: { at: "2026-09-30T15:00:00.000Z", repeat: null } });
  });

  it("One time with a time only runs today at that time", () => {
    const d = edit(openSchedule(null, ctx), { time: "18:00" });
    expect(saveSchedule(d, now)).toEqual({ ok: true, value: { at: "2026-09-27T18:00:00.000Z", repeat: null } });
  });

  it("One time with a date but no valid time says so, on the time field", () => {
    const d = edit(openSchedule(null, ctx), { date: "2026-09-30", time: "" });
    expect(saveSchedule(d, now)).toEqual({ ok: false, field: "time", error: "Pick a date and a time" });
  });

  it("Repeat saves the rule and no first time: Starts and the rule give the first run", () => {
    const d = withMode(openSchedule(null, ctx), "repeat", now);
    const saved = saveSchedule(d, now);
    expect(saved).toEqual({ ok: true, value: { at: null, repeat: { cron: "0 9 * * *", tz: "UTC", start: "2026-09-27" } } });
  });

  it("switching to Repeat starts the rule from the One time date and time until the rule is changed", () => {
    const once = edit(openSchedule(null, ctx), { date: "2026-10-02", time: "08:15" });
    const rep = withMode(once, "repeat", now);
    expect(rep.rule).toMatchObject({ start: "2026-10-02", times: ["08:15"], weekdays: [5], monthly: { by: "day", day: 2 } });
    // Changed by the user: switching away and back keeps it.
    const changed = editRule(rep, { frequency: "weekly", weekdays: [1, 3] });
    const back = withMode(edit(withMode(changed, "once", now), { date: "2026-11-01" }), "repeat", now);
    expect(back.rule).toEqual(changed.rule);
  });

  it("switching modes keeps the other mode's values; only the chosen one is saved", () => {
    const once = edit(openSchedule(null, ctx), { date: "2026-10-02", time: "08:15" });
    const rep = editRule(withMode(once, "repeat", now), { frequency: "weekly", weekdays: [2] });
    const again = withMode(rep, "once", now);
    expect(again).toMatchObject({ mode: "once", date: "2026-10-02", time: "08:15" });
    expect(saveSchedule(again, now)).toEqual({ ok: true, value: { at: "2026-10-02T08:15:00.000Z", repeat: null } });
    const rep2 = withMode(again, "repeat", now);
    expect(rep2.rule).toEqual(rep.rule);
    expect(saveSchedule(rep2, now)).toEqual({ ok: true, value: { at: null, repeat: { cron: "15 8 * * 2", tz: "UTC", start: "2026-10-02" } } });
  });

  it("Repeat says what to fix: the rule's fields, and a rule that never runs", () => {
    const rep = withMode(openSchedule(null, ctx), "repeat", now);
    expect(saveSchedule(editRule(rep, { times: [] }), now)).toEqual({ ok: false, field: "times", error: "Add a time" });
    const never = editRule(rep, { start: "2026-09-01", ends: "on", endDate: "2026-09-02" });
    expect(saveSchedule(never, now)).toEqual({ ok: false, field: "start", error: "This rule never runs: check its days, start and end" });
  });

  it("Repeat ignores a bad One time date it is not saving", () => {
    const bad = edit(openSchedule(null, ctx), { date: "2026-09-30", time: "" });
    expect(saveSchedule(withMode(bad, "repeat", now), now).ok).toBe(true);
  });

  it("editing a one-time task opens One time with its date and time", () => {
    const d = openSchedule({ at: "2026-10-05T14:30:00.000Z", repeat: null }, ctx);
    expect(d).toMatchObject({ mode: "once", date: "2026-10-05", time: "14:30", ruleTouched: false });
    expect(d.rule).toMatchObject({ start: "2026-10-05", times: ["14:30"] });
    expect(saveSchedule(d, now)).toEqual({ ok: true, value: { at: "2026-10-05T14:30:00.000Z", repeat: null } });
  });

  it("editing a repeating task opens Repeat with its rule, in the rule's zone; saving One time drops the rule", () => {
    const repeat = rule("0 9 * * 1,3,5", "America/New_York", { start: "2026-09-28", end: "2026-12-31" });
    const d = openSchedule({ at: "2026-09-28T13:00:00.000Z", repeat }, ctx);
    expect(d).toMatchObject({ mode: "repeat", tz: "America/New_York", ruleTouched: true, date: "2026-09-28", time: "09:00" });
    expect(d.rule).toMatchObject({ frequency: "weekly", weekdays: [1, 3, 5], start: "2026-09-28", ends: "on", endDate: "2026-12-31" });
    expect(saveSchedule(d, now)).toEqual({ ok: true, value: { at: null, repeat } });
    expect(saveSchedule(withMode(d, "once", now), now)).toEqual({ ok: true, value: { at: "2026-09-28T13:00:00.000Z", repeat: null } });
  });
});

describe("task rows: due now and schedule labels", () => {
  const NOW = Date.parse("2026-09-26T12:00:00Z");
  const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
  const o = { hour12: true, tz: "UTC" };

  it("isDueNow: pending with its time come; the account's queue also takes paused tasks whose retry time came", () => {
    expect(isDueNow({ status: "pending", notBefore: null, retryAfter: null }, NOW)).toBe(true);
    expect(isDueNow({ status: "pending", notBefore: iso(-1), retryAfter: iso(-1) }, NOW)).toBe(true);
    expect(isDueNow({ status: "pending", notBefore: iso(5), retryAfter: null }, NOW)).toBe(false);
    expect(isDueNow({ status: "pending", notBefore: null, retryAfter: iso(5) }, NOW)).toBe(false);
    expect(isDueNow({ status: "paused", notBefore: null, retryAfter: iso(-5) }, NOW)).toBe(false);
    expect(isDueNow({ status: "paused", notBefore: null, retryAfter: iso(-5) }, NOW, "account")).toBe(true);
    expect(isDueNow({ status: "paused", notBefore: null, retryAfter: null }, NOW, "account")).toBe(false);
    expect(isDueNow({ status: "running", notBefore: null, retryAfter: null }, NOW, "account")).toBe(false);
  });

  it("whenText: today, tomorrow, this week, later", () => {
    expect(whenText(iso(180), NOW, o)).toBe("Today 3:00 PM");
    expect(whenText(iso(24 * 60 - 180), NOW, o)).toBe("Tomorrow 9:00 AM");
    expect(whenText(iso(3 * 24 * 60), NOW, o)).toBe("Tue 12:00 PM");
    expect(whenText("2026-10-12T09:00:00Z", NOW, o)).toBe("Oct 12, 9:00 AM");
    expect(whenText("2027-01-02T09:00:00Z", NOW, { hour12: false, tz: "UTC" })).toBe("Jan 2, 2027, 09:00");
    expect(whenText("2026-09-27T00:30:00Z", NOW, { hour12: false, tz: "Asia/Seoul" })).toBe("Tomorrow 09:30"); // 21:00 on the 26th in Seoul now
  });

  it("scheduleLabel: the rule in words, else once at a time, due now, or once", () => {
    const pending = { status: "pending" as const, retryAfter: null };
    expect(scheduleLabel({ ...pending, notBefore: iso(60), repeat: rule("0 9 * * *") }, NOW, o)).toBe("Daily at 9:00 AM");
    expect(scheduleLabel({ ...pending, notBefore: iso(180), repeat: null }, NOW, o)).toBe("Once · Today 3:00 PM");
    expect(scheduleLabel({ ...pending, notBefore: null }, NOW, o)).toBe("Due now");
    expect(scheduleLabel({ status: "done", notBefore: null, retryAfter: null }, NOW, o)).toBe("Once");
  });

  it("a rule stored before rules became cron ({ dailyAt }) reads the same; anything unreadable just repeats", () => {
    const legacy = { dailyAt: ["09:00", "18:30"] };
    expect(repeatLabel(legacy, o)).toBe("Daily at 9:00 AM and 6:30 PM");
    expect(describeRepeat(legacy, o)).toBe("Daily at 9:00 AM and 6:30 PM");
    expect(scheduleLabel({ status: "pending", notBefore: iso(60), retryAfter: null, repeat: legacy as never }, NOW, o)).toBe("Daily at 9:00 AM and 6:30 PM");
    expect(repeatLabel({ nonsense: true } as never, o)).toBe("Repeats");
    expect(repeatLabel({ cron: 42, tz: "UTC" } as never, o)).toBe("Repeats");
  });
});
