/**
 * The TODO tools: from the chat the agent puts a task in the user's TODO list
 * (schedule_task: "check again in 3 hours", "make a repeat task for what we
 * just did"), lists the waiting ones (list_scheduled_tasks), and changes or
 * cancels one (update_scheduled_task, cancel_scheduled_task). What the tools,
 * the extension that answers them (engine/schedule-task.ts) and the chat's
 * cards share: their arguments, the schedule in words, the messages, and the
 * RPC the helper calls. The schedule itself is the task schedule model
 * (schedule.ts).
 */
import { z } from "zod";
import { plansWithText } from "./billing.js";
import { ScheduleInput } from "./schedule.js";
import { describeRepeat, prefersHour12, timeText } from "./schedule-text.js";
import { MAX_ACCOUNT_CHARS, MAX_INSTRUCTIONS_CHARS, type LocalTask } from "./task.js";
import type { TodoToolName } from "./tools.js";
import { tzOffsetMs, wallTime } from "./zoned-time.js";

// ---- The tools' arguments ---------------------------------------------------

const TaskText = z.string().trim().min(1).max(MAX_INSTRUCTIONS_CHARS);
const TASK_TEXT_RULE =
  "The task exactly as it will run later: on its own, in a fresh session with no memory of this chat. State the goal and every step in order, with the URLs, account names, search terms, names and values it needs, and what to report or when to stop. Never 'same as before', 'what we just did' or 'the page from earlier'.";
const AT_RULE =
  "at: ISO 8601 with a UTC offset (e.g. 2026-09-26T18:45:00-04:00): the user's offset for a time they say, or the offset of the zone a page shows a time in (a 2:00 PM PT event is 14:00-07:00 in summer); it must be in the future";
const Account = z.string().trim().min(1).max(MAX_ACCOUNT_CHARS);
const TaskId = z.string().trim().min(1).max(200).describe("The task's id, as list_scheduled_tasks or schedule_task gave it");

/** schedule_task's arguments: a task for the user's TODO list, written from the conversation, and when it runs. */
export const ScheduleTaskArgs = z.object({
  task: TaskText.describe(TASK_TEXT_RULE),
  schedule: ScheduleInput.refine((s) => !!s.at || !!s.repeat, "give `at` (a one-off time), `repeat`, or both").describe(
    `When it runs. ${AT_RULE}: the one-off time, or a repeat's first run. repeat: { cron: one or more 5-field lines 'minute hour day-of-month month day-of-week' (e.g. '0 9 * * *' daily 9:00, '0 9 * * 1-5' weekdays 9:00, '30 8 * * 1' Mondays 8:30), tz: the IANA time zone the cron times are in (the user's, unless the times are another zone's), start / end: first and last day as YYYY-MM-DD, interval: { every: N, unit: 'day' | 'week' | 'month' } for every N days/weeks/months, count: the number of runs }.`,
  ),
  account: Account.optional().describe("The account the task acts as (e.g. an X handle '@name'), when the chat used one"),
});
export type ScheduleTaskArgs = z.infer<typeof ScheduleTaskArgs>;

/** schedule_task's description for the model (the prompt says when to use it). */
export const SCHEDULE_TASK_DESCRIPTION =
  "Put a task in the user's TODO list, to run later at a time or on a repeat (e.g. 'check again in 3 hours', 'make this a daily task at 9am', 'repeat what we just did every Monday'). It runs by itself later with no memory of this chat, so `task` must be complete on its own. The user sees it in their jobs list at once, with Undo in the chat. Only when the user asks for something to run later or again.";

export const ListScheduledTasksArgs = z.object({});
export type ListScheduledTasksArgs = z.infer<typeof ListScheduledTasksArgs>;

export const LIST_SCHEDULED_TASKS_DESCRIPTION =
  "List the tasks waiting in the user's TODO list (not yet run, paused or running): each one's id, first line, next run in the user's time and its schedule in words. Call it to find a task's id before update_scheduled_task or cancel_scheduled_task.";

/** update_scheduled_task's arguments: what changes of a waiting task (at least one of task, schedule, account). */
export const UpdateScheduledTaskArgs = z
  .object({
    task_id: TaskId,
    task: TaskText.optional().describe(`New instructions, replacing the old. ${TASK_TEXT_RULE} Omit to keep them.`),
    schedule: ScheduleInput.optional().describe(
      `What changes of when it runs; omit a field to keep it. ${AT_RULE}: the new time of its next (or only) run. repeat: a new repeat rule (same shape as schedule_task's), replacing the old one; null makes it run only once.`,
    ),
    account: Account.nullable().optional().describe("The account it acts as; null clears it. Omit to keep it"),
  })
  .refine((a) => a.task !== undefined || a.schedule !== undefined || a.account !== undefined, "give what changes: task, schedule or account");
export type UpdateScheduledTaskArgs = z.infer<typeof UpdateScheduledTaskArgs>;

export const UPDATE_SCHEDULED_TASK_DESCRIPTION =
  "Change a waiting task in the user's TODO list: its instructions, when it runs, or its account. Give only what changes. To move a task to another time, change its schedule here; never cancel it and schedule a new one. The chat shows a card with Undo. Changing a task this chat did not schedule may first wait for the user's OK on an approval card: do not ask in words first.";

export const CancelScheduledTaskArgs = z.object({ task_id: TaskId });
export type CancelScheduledTaskArgs = z.infer<typeof CancelScheduledTaskArgs>;

export const CANCEL_SCHEDULED_TASK_DESCRIPTION =
  "Cancel a waiting task in the user's TODO list so it does not run (it is over in their jobs list; a repeating task stops repeating). Only when the user asks to cancel, delete or drop it. The chat shows a card with Undo. Cancelling a task this chat did not schedule may first wait for the user's OK on an approval card: do not ask in words first.";

// ---- What they store and answer ---------------------------------------------

/** A task schedule_task stored: what the tool answers the model, and what the chat's card shows. */
export interface ScheduledTask {
  /** The TODO list's task id (Undo deletes it; View in TODO finds its row). */
  taskId: string;
  instructions: string;
  /** The schedule in words ("Every weekday at 9:00 AM"), in the user's time zone. */
  when: string;
  /** When it runs first (ISO), when known. */
  nextRunAt: string | null;
  /** nextRunAt in the user's words and zone ("tomorrow at 9:00 AM"); null: as soon as possible. */
  nextRun: string | null;
  /** The user's IANA time zone, which `when` and `nextRun` are in. */
  timeZone: string;
}

/** A TODO task's fields a change can touch, as they were: Undo of update_scheduled_task puts them back. */
export interface TodoTaskFields {
  instructions: string;
  account: string | null;
  schedule: ScheduleInput;
  /** The agent had written the instructions (Task.agentAuthored); absent: the user had. */
  agentAuthored?: true;
}

/** What update_scheduled_task / cancel_scheduled_task did to a task (its chat card). */
export type TodoChange = "updated" | "cancelled";

/** Tasks list_scheduled_tasks shows: they have not run yet, or wait to go on. */
export const WAITING_TASK_STATUSES = ["pending", "paused", "running"] as const satisfies readonly LocalTask["status"][];
/** Of those, the ones the TODO list lets change (the API edits and cancels only these). */
export const CHANGEABLE_TASK_STATUSES = ["pending", "paused"] as const satisfies readonly LocalTask["status"][];
/** Most tasks list_scheduled_tasks names (the soonest first). */
export const MAX_LISTED_TASKS = 50;
/** Longest first line a listed task shows. */
const MAX_LISTED_TITLE = 100;

/** The refusal on a plan without the TODO list (error-help.ts gives it a Choose a plan button). */
export const SCHEDULE_PLAN_REQUIRED = `Scheduling needs ${plansWithText("todo")}.`;
/** The refusal while signed out: the TODO list is the account's (error-help.ts gives it a Log in button). */
export const SCHEDULE_SIGN_IN = "Scheduling needs you to log in to Noa.";

const titleOf = (instructions: string) => instructions.split("\n")[0]!.trim();

/** "Next run: tomorrow at 9:00 AM in the user's time zone (America/New_York)." */
const nextRunLine = (s: Pick<ScheduledTask, "nextRun" | "timeZone">) => `Next run: ${s.nextRun ?? "as soon as possible"} in the user's time zone (${s.timeZone}).`;

/** What schedule_task answers the model once the task is stored. */
export function scheduledTaskText(s: ScheduledTask): string {
  return `Scheduled in the user's TODO list (task ${s.taskId}): "${titleOf(s.instructions)}" · ${s.when}. ${nextRunLine(s)} It shows in their jobs list now, and the chat shows them a card with Undo. Tell them in one short line, with the time in their time zone.`;
}

/** What update_scheduled_task / cancel_scheduled_task answer the model once the change is made. */
export function changedTaskText(change: TodoChange, s: ScheduledTask): string {
  const title = titleOf(s.instructions);
  if (change === "cancelled") {
    return `Cancelled task ${s.taskId} in the user's TODO list: "${title}". It will not run (it is over in their jobs list), and the chat shows them a card with Undo. Tell them in one short line.`;
  }
  return `Changed task ${s.taskId} in the user's TODO list: "${title}" · ${s.when}. ${nextRunLine(s)} The chat shows them a card with Undo. Tell them in one short line, with the time in their time zone.`;
}

/**
 * What list_scheduled_tasks answers: the waiting tasks, soonest first, one compact line each
 * (- t7 · "Open the Vendor call link" · next run Thu, Oct 1 at 4:50 PM · once), times in the user's zone.
 */
export function scheduledTasksText(
  tasks: readonly Pick<LocalTask, "id" | "instructions" | "account" | "notBefore" | "repeat" | "status">[],
  opts: { now: Date; timeZone: string; hour12?: boolean },
): string {
  const hour12 = opts.hour12 ?? prefersHour12();
  const waiting = tasks
    .filter((t) => (WAITING_TASK_STATUSES as readonly string[]).includes(t.status))
    .sort((a, b) => (a.notBefore ? Date.parse(a.notBefore) : 0) - (b.notBefore ? Date.parse(b.notBefore) : 0));
  if (!waiting.length) return "The user's TODO list has no waiting tasks.";
  const lines = waiting.slice(0, MAX_LISTED_TASKS).map((t) => {
    const title = titleOf(t.instructions);
    const parts = [
      t.id,
      `"${title.length > MAX_LISTED_TITLE ? `${title.slice(0, MAX_LISTED_TITLE - 1)}…` : title}"`,
      `next run ${t.notBefore ? momentText(t.notBefore, opts.now, opts.timeZone, hour12) : "as soon as possible"}`,
      t.repeat ? `${describeRepeat(t.repeat, { now: opts.now, hour12 })}${t.repeat.tz === opts.timeZone ? "" : ` (${t.repeat.tz})`}` : "once",
      ...(t.status === "pending" ? [] : [t.status]),
      ...(t.account ? [`as ${t.account}`] : []),
    ];
    return `- ${parts.join(" · ")}`;
  });
  const more = waiting.length - lines.length;
  return [
    `${waiting.length} waiting task${waiting.length === 1 ? "" : "s"} in the user's TODO list (times in ${opts.timeZone}, the user's zone):`,
    ...lines,
    ...(more > 0 ? [`(and ${more} more, later)`] : []),
  ].join("\n");
}

/** The answer of a TODO tool: the model's text; isError when nothing was done (the text says why). */
export interface TodoToolResult {
  text: string;
  isError?: boolean;
}

/** RPC the helper calls on the extension for the TODO tools (Claude Code brain), with the task session's id. */
export type TodoMethods = {
  "todo.call": { params: { sessionId: string; tool: TodoToolName; args: unknown }; result: TodoToolResult };
};

/** The calendar day of `instant` in `tz`, comparable as a string ("2026-09-26"). */
const dayKey = (instant: number, tz: string) => {
  const w = wallTime(instant, tz);
  return `${w.year}-${w.month}-${w.day}`;
};

/** "today at 6:45 PM", "tomorrow at 9:00 AM", "Mon, Oct 5 at 9:30 AM": `iso` as seen in `tz`. */
export function momentText(iso: string, now: Date, tz: string, hour12: boolean): string {
  const t = Date.parse(iso);
  const w = wallTime(t, tz);
  const day =
    dayKey(t, tz) === dayKey(now.getTime(), tz)
      ? "today"
      : dayKey(t, tz) === dayKey(now.getTime() + 86_400_000, tz)
        ? "tomorrow"
        : new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  return `${day} at ${timeText(w.hour, w.minute, hour12)}`;
}

/**
 * A schedule in words for the user: "Once, today at 6:45 PM", "Every weekday at 9:00 AM",
 * "Daily at 9:00 AM (Europe/Lisbon), first run tomorrow at 9:00 AM". One-off times are shown in
 * `timeZone` (the user's); a repeat's times are its own zone's, named when it is another one.
 */
export function describeSchedule(s: ScheduleInput, opts: { now: Date; timeZone: string; hour12?: boolean }): string {
  const { now, timeZone } = opts;
  const hour12 = opts.hour12 ?? prefersHour12();
  if (!s.repeat) return s.at ? `Once, ${momentText(s.at, now, timeZone, hour12)}` : "Once, as soon as possible";
  const zone = s.repeat.tz === timeZone ? "" : ` (${s.repeat.tz})`;
  const first = s.at ? `, first run ${momentText(s.at, now, timeZone, hour12)}` : "";
  return `${describeRepeat(s.repeat, { now, hour12 })}${zone}${first}`;
}

/** "+05:30": `tz`'s UTC offset at `instant`. */
function offsetText(instant: number, tz: string): string {
  const minutes = Math.round(tzOffsetMs(instant, tz) / 60_000);
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The line every turn's prompt gives the agent, so it can turn "after 3 hours" or "tomorrow morning" into a
 * schedule_task time: "The user's time: Saturday, September 26, 2026, 3:45 PM in America/New_York (UTC-04:00)."
 */
export function userTimeLine(timeZone: string, now: Date): string {
  const when = now.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
  return `The user's time: ${when.replace(" at ", ", ")} in ${timeZone} (UTC${offsetText(now.getTime(), timeZone)}).`;
}
