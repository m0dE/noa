// A mock calendar for the TODO tools' end-to-end test (test/e2e/calendar-schedule.mjs): a week view whose events
// have a title, date and time, duration, attendees, a description and a meeting link; one repeats weekly; the
// calendar shows Pacific Time and one event London time. The week starts today (in the calendar's zone) and runs
// 8 days, so each weekday after today is in it once.
//
// - calendarWeek(now): the events, each with its start as an instant and as ISO 8601 with its own zone's offset.
// - calendarServer(week): serves the page at /week.
// - calendarPlanner(week): the Messages API replies of a model that uses the TODO tools on this calendar
//   (createFakeAnthropic({ plan })), for five requests: add Thursday's Vendor call, add all meetings 10 minutes
//   before (several tool calls in one reply), make the weekly standup repeat, move the Vendor call TODO to
//   Friday 3pm, cancel the dentist TODO.
//
// Times are computed here with Intl only (not with the product's zoned-time.ts), so the test checks the product
// against an independent conversion.
import { createServer } from "node:http";
import { history, textOf } from "../fake-cloud/servers.mjs";

export const CALENDAR_ZONE = "America/Los_Angeles";
export const LONDON = "Europe/London";
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The wall-clock fields of `instant` in `tz`. */
function wall(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(instant))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** `tz`'s UTC offset at `instant`, in minutes. */
function offsetMinutes(instant, tz) {
  const w = wall(instant, tz);
  return Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The instant of a wall-clock time in `tz` (two passes settle a DST change between the guess and the answer). */
export function zonedInstant({ year, month, day }, hour, minute, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let instant = naive - offsetMinutes(naive, tz) * 60_000;
  instant = naive - offsetMinutes(instant, tz) * 60_000;
  return instant;
}

/** ISO 8601 of `instant` as a wall time in `tz` with its offset: "2026-10-01T15:00:00+01:00". */
export function isoInZone(instant, tz) {
  const w = wall(instant, tz);
  const off = offsetMinutes(instant, tz);
  const pad = (n) => String(n).padStart(2, "0");
  const sign = off < 0 ? "-" : "+";
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** The calendar day `days` after `instant`'s day in `tz`, with its weekday (0 = Sunday). */
function dayAfter(instant, days, tz) {
  const w = wall(instant, tz);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

/** The first `weekday` strictly after today in `tz`. */
export function nextWeekday(now, weekday, tz) {
  for (let n = 1; n <= 7; n++) {
    const d = dayAfter(now.getTime(), n, tz);
    if (d.weekday === weekday) return d;
  }
  throw new Error("unreachable");
}

/** "3:00 PM" in `tz`. */
const clock = (instant, tz) => new Date(instant).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
/** "BST", "PDT": the zone's short name at `instant`. */
const zoneName = (instant, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(instant)).find((p) => p.type === "timeZoneName").value;

/** The week's events: title, start (instant and ISO in its zone), minutes, zone, attendees, description, link. */
export function calendarWeek(now) {
  const at = (day, hour, minute, tz) => {
    const start = zonedInstant(day, hour, minute, tz);
    return { day, start, startIso: isoInZone(start, tz), tz };
  };
  const monday = nextWeekday(now, 1, CALENDAR_ZONE);
  const events = [
    {
      id: "breakfast",
      title: "Breakfast sync",
      ...at(dayAfter(now.getTime(), 0, CALENDAR_ZONE), 0, 5, CALENDAR_ZONE),
      minutes: 15,
      attendees: ["Priya Raman"],
      description: "Quick check-in before the day starts.",
      link: "https://meet.calendar.test/breakfast-sync",
    },
    {
      id: "standup",
      title: "Weekly standup",
      ...at(monday, 9, 30, CALENDAR_ZONE),
      minutes: 15,
      attendees: ["Priya Raman", "Tom Becker", "Ana Souza"],
      description: "Team standup: yesterday, today, blockers.",
      link: "https://meet.calendar.test/weekly-standup",
      repeats: "Repeats every week on Monday",
    },
    {
      id: "design",
      title: "Design review",
      ...at(nextWeekday(now, 3, CALENDAR_ZONE), 13, 0, CALENDAR_ZONE),
      minutes: 60,
      attendees: ["Ana Souza", "Lee Park"],
      description: "Review the new onboarding screens.",
      link: "https://meet.calendar.test/design-review",
    },
    {
      id: "vendor",
      title: "Vendor call",
      ...at(nextWeekday(now, 4, CALENDAR_ZONE), 15, 0, LONDON),
      minutes: 30,
      attendees: ["Oliver Hughes (Acme Supplies)", "Tom Becker"],
      description: "Quarterly pricing with Acme Supplies. Bring the Q3 order numbers.",
      link: "https://meet.calendar.test/vendor-call",
    },
    {
      id: "dentist",
      title: "Dentist",
      ...at(nextWeekday(now, 5, CALENDAR_ZONE), 10, 0, CALENDAR_ZONE),
      minutes: 45,
      attendees: [],
      description: "Dr. Kim, 1200 Main St. Appointment, not a meeting.",
      link: null,
    },
  ];
  const days = Array.from({ length: 8 }, (_, n) => dayAfter(now.getTime(), n, CALENDAR_ZONE));
  return { now, days, events, byId: Object.fromEntries(events.map((e) => [e.id, e])) };
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sameDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day;

/** The week view's HTML. */
export function calendarHtml(week) {
  const dayTitle = (d) => `${WEEKDAYS[d.weekday]}, ${new Date(Date.UTC(d.year, d.month - 1, d.day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
  const eventHtml = (e) => {
    const end = e.start + e.minutes * 60_000;
    const zone = e.tz === CALENDAR_ZONE ? `PT (${zoneName(e.start, e.tz)})` : `London time (${zoneName(e.start, e.tz)})`;
    return `<article class="event" id="ev-${e.id}">
      <h3>${escape(e.title)}</h3>
      <p class="when">${clock(e.start, e.tz)} – ${clock(end, e.tz)} ${zone} · ${e.minutes} min</p>
      ${e.repeats ? `<p class="repeats">${escape(e.repeats)}</p>` : ""}
      ${e.attendees.length ? `<p class="who">Attendees: ${e.attendees.map(escape).join(", ")}</p>` : ""}
      <p class="what">${escape(e.description)}</p>
      ${e.link ? `<p><a href="${e.link}">Join meeting: ${e.link}</a></p>` : ""}
    </article>`;
  };
  const columns = week.days
    .map((d) => {
      const events = week.events.filter((e) => sameDay(e.day, d));
      return `<section class="day"><h2>${dayTitle(d)}</h2>${events.length ? events.map(eventHtml).join("") : '<p class="free">No events</p>'}</section>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Week view · Team Calendar</title>
    <style>body{font:14px system-ui;margin:16px}.week{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.day{border:1px solid #ccc;padding:8px}.event{background:#eef;margin:6px 0;padding:6px}</style>
    <h1>Team Calendar</h1><p>Week view · Times in Pacific Time (PT) unless an event says otherwise</p>
    <div class="week">${columns}</div>`;
}

/** Serves the week at /week. Resolves to { port, close }. */
export function calendarServer(week) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/week")) return res.end(calendarHtml(week));
    res.statusCode = 404;
    res.end("<title>Not found</title>Not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() })));
}

// ---- The scripted model ----------------------------------------------------------

/** The user's words of the current turn, the index of that message, and the user's zone (from "The user's time"). */
function currentRequest(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    // A follow-up comes in the same message as the results of the turn before (its task_complete's).
    const text = textOf(blocks.filter((b) => b.type === "text"));
    if (!text.trim()) continue;
    const tz = /The user's time: .* in (\S+) \(UTC/.exec(text)?.[1] ?? null;
    // The first turn's request is between <<< and >>>; a follow-up (buildFollowUpMessage) is the paragraph after the
    // user's time and their tab (after "The user's message:"), before the approvals line.
    const paragraphs = text.split("\n\n").filter((p) => !/^(The user's time:|Approvals:|Memory from earlier)/.test(p.trim()));
    const words = /<<<\n([\s\S]*?)\n>>>/.exec(text)?.[1] ?? /The user's message:\n([\s\S]*?)(\n\n|$)/.exec(text)?.[1] ?? paragraphs.at(-1) ?? "";
    return { index: i, words: words.trim(), tz };
  }
  return { index: 0, words: "", tz: null };
}

const meetingTask = (e) => `Open the meeting link for "${e.title}" (${e.link}) in a new tab so the user can join; then tell them it is open.`;

/**
 * The replies of a model that uses the TODO tools on this calendar. Each reply: { text, tool } or { text, tools }.
 * The user's zone comes from the prompt's "The user's time" line, as a model would read it.
 */
export function calendarPlanner(week) {
  let userTz = null;
  return (body) => {
    const tools = new Set((body.tools ?? []).map((t) => t.name));
    const missing = ["read_page", "schedule_task", "list_scheduled_tasks", "update_scheduled_task", "cancel_scheduled_task", "task_complete"].filter((n) => !tools.has(n));
    if (missing.length) return { text: "I cannot do this without my tools.", tool: { name: "task_fail", input: { reason: `tools missing: ${missing.join(", ")}` } } };
    const messages = body.messages ?? [];
    const req = currentRequest(messages);
    userTz = req.tz ?? userTz;
    const calls = history(messages.slice(req.index));
    const last = calls.at(-1);
    const ask = req.words.toLowerCase();
    const done = (text, summary) => ({ text, tool: { name: "task_complete", input: { summary } } });
    const read = () => ({ text: "Reading your calendar.", tool: { name: "read_page", input: {} } });
    const nextRun = (result) => /Next run: (.+?) in the user's time zone/.exec(result ?? "")?.[1] ?? "(time not given)";
    const idOf = (list, word) => new RegExp(`^- (\\S+) · "[^"]*${word}`, "im").exec(list ?? "")?.[1] ?? null;

    if (ask.includes("meetings")) {
      if (!calls.some((c) => c.name === "read_page")) return read();
      if (!calls.some((c) => c.name === "schedule_task")) {
        // Every event with a meeting link, 10 minutes before it starts (the Breakfast sync has passed: the tool says so).
        const meetings = week.events.filter((e) => e.link);
        return {
          text: `Adding ${meetings.length} meetings as TODOs, each 10 minutes before it starts.`,
          tools: meetings.map((e) => ({ name: "schedule_task", input: { task: meetingTask(e), schedule: { at: isoInZone(e.start - 10 * 60_000, e.tz) } } })),
        };
      }
      const added = calls.filter((c) => c.name === "schedule_task" && /^Scheduled/.test(c.result));
      return done(`Added ${added.length} meetings: ${added.map((c) => nextRun(c.result)).join("; ")} (your time).`, `Added ${added.length} meetings as TODOs`);
    }
    if (ask.includes("standup")) {
      if (!calls.some((c) => c.name === "read_page")) return read();
      if (last?.name === "read_page") {
        const s = week.byId.standup;
        const w = wall(s.start, CALENDAR_ZONE);
        return { text: "", tool: { name: "schedule_task", input: { task: meetingTask(s), schedule: { repeat: { cron: `${w.minute} ${w.hour} * * 1`, tz: CALENDAR_ZONE } } } } };
      }
      return done(`The weekly standup repeats every Monday; next run ${nextRun(last?.result)} your time.`, "Made the weekly standup a repeating task");
    }
    if (ask.includes("move")) {
      if (!calls.some((c) => c.name === "list_scheduled_tasks")) return { text: "", tool: { name: "list_scheduled_tasks", input: {} } };
      if (last?.name === "list_scheduled_tasks") {
        const id = idOf(last.result, "Vendor call");
        if (!id) return done("I could not find the Vendor call TODO.", "No Vendor call TODO found");
        const friday = nextWeekday(week.now, 5, userTz);
        return { text: "", tool: { name: "update_scheduled_task", input: { task_id: id, schedule: { at: isoInZone(zonedInstant(friday, 15, 0, userTz), userTz) } } } };
      }
      return last?.result && !/^Changed/.test(last.result) ? done(`Not moved: ${last.result}`, "Could not move the Vendor call TODO") : done(`Moved: the Vendor call TODO now runs ${nextRun(last?.result)} your time.`, "Moved the Vendor call TODO");
    }
    if (ask.includes("cancel")) {
      if (!calls.some((c) => c.name === "list_scheduled_tasks")) return { text: "", tool: { name: "list_scheduled_tasks", input: {} } };
      if (last?.name === "list_scheduled_tasks") {
        const id = idOf(last.result, "Dentist");
        if (!id) return done("I could not find a dentist TODO.", "No dentist TODO found");
        return { text: "", tool: { name: "cancel_scheduled_task", input: { task_id: id } } };
      }
      return /^Cancelled/.test(last?.result ?? "") ? done("Cancelled the dentist TODO.", "Cancelled the dentist TODO") : done(`Not cancelled: ${last?.result}`, "Could not cancel the dentist TODO");
    }
    if (ask.includes("vendor call")) {
      if (!calls.some((c) => c.name === "read_page")) return read();
      if (last?.name === "read_page") {
        if (!last.result.includes("Vendor call")) return { text: "", tool: { name: "task_fail", input: { reason: "No Vendor call on this calendar page" } } };
        const v = week.byId.vendor;
        const task = `Vendor call with Acme Supplies (Oliver Hughes, Tom Becker): quarterly pricing, bring the Q3 order numbers. Open ${v.link} to join.`;
        return { text: "", tool: { name: "schedule_task", input: { task, schedule: { at: v.startIso } } } };
      }
      return done(`Added the Vendor call: ${nextRun(last?.result)} your time (3:00 PM London time).`, "Added the Vendor call to the TODO list");
    }
    return done("I am not sure what to do.", "Nothing to do");
  };
}
