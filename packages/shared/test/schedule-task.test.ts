import { describe, expect, it } from "vitest";
import {
  CANCEL_SCHEDULED_TASK_DESCRIPTION,
  CancelScheduledTaskArgs,
  changedTaskText,
  CONVERSATION_TOOLS,
  INTERACTIVE_TOOL_NAMES,
  LIST_SCHEDULED_TASKS_DESCRIPTION,
  MAX_LISTED_TASKS,
  scheduledTasksText,
  TODO_TOOLS,
  TOOL_DESCRIPTIONS,
  UPDATE_SCHEDULED_TASK_DESCRIPTION,
  UpdateScheduledTaskArgs,
  type LocalTask,
  describeRepeat,
  describeSchedule,
  ScheduleTaskArgs,
  SCHEDULE_PLAN_REQUIRED,
  SCHEDULE_SIGN_IN,
  SCHEDULE_TASK_DESCRIPTION,
  scheduledTaskText,
  userTimeLine,
  type ScheduleInput,
} from "../src/index.js";

const NY = "America/New_York";
/** Sat Sep 26 2026, 15:45 in New York (EDT, UTC-4). */
const NOW = new Date("2026-09-26T19:45:00Z");
const describeNy = (s: ScheduleInput) => describeSchedule(s, { now: NOW, timeZone: NY, hour12: true });

describe("ScheduleTaskArgs", () => {
  it("takes a one-off time or a repeat, with the task written out", () => {
    expect(ScheduleTaskArgs.safeParse({ task: "Check the order status at https://shop.example.com/orders/42", schedule: { at: "2026-09-26T18:45:00-04:00" } }).success).toBe(true);
    const repeat = ScheduleTaskArgs.parse({ task: " Post gm on X from @alpha ", schedule: { repeat: { cron: "0 9 * * 1-5", tz: NY } }, account: "@alpha" });
    expect(repeat.task).toBe("Post gm on X from @alpha");
    expect(repeat.schedule.repeat?.cron).toBe("0 9 * * 1-5");
  });

  it("refuses an empty task, a schedule with neither time nor repeat, a time without an offset, a bad cron or zone", () => {
    const bad = [
      { task: "  ", schedule: { at: "2026-09-26T18:45:00Z" } },
      { task: "x", schedule: {} },
      { task: "x", schedule: { at: null, repeat: null } },
      { task: "x", schedule: { at: "2026-09-26T18:45:00" } },
      { task: "x", schedule: { repeat: { cron: "every day", tz: NY } } },
      { task: "x", schedule: { repeat: { cron: "0 9 * * *", tz: "Mars/Olympus" } } },
    ];
    for (const args of bad) expect(ScheduleTaskArgs.safeParse(args).success, JSON.stringify(args)).toBe(false);
  });

  it("tells the model the task must stand on its own", () => {
    expect(SCHEDULE_TASK_DESCRIPTION).toMatch(/TODO list/);
    expect(SCHEDULE_TASK_DESCRIPTION).toMatch(/no memory of this chat/);
    const task = ScheduleTaskArgs.shape.task.description ?? "";
    expect(task).toMatch(/no memory of this chat/i);
    expect(task).toMatch(/URLs/);
    expect(task).toMatch(/Never 'same as before'/);
  });
});

describe("describeSchedule", () => {
  it("a one-off time: today, tomorrow, or its date, in the user's zone", () => {
    expect(describeNy({ at: "2026-09-26T22:45:00Z" })).toBe("Once, today at 6:45 PM");
    expect(describeNy({ at: "2026-09-27T13:00:00Z" })).toBe("Once, tomorrow at 9:00 AM");
    expect(describeNy({ at: "2026-10-05T13:30:00Z" })).toBe("Once, Mon, Oct 5 at 9:30 AM");
    expect(describeSchedule({ at: "2026-09-26T22:45:00Z" }, { now: NOW, timeZone: NY, hour12: false })).toBe("Once, today at 18:45");
  });

  it("a repeat in the schedule model's words; another zone and a first run are said", () => {
    const weekdays = { cron: "0 9 * * 1-5", tz: NY };
    expect(describeNy({ repeat: weekdays })).toBe(describeRepeat(weekdays, { now: NOW, hour12: true }));
    expect(describeNy({ repeat: weekdays })).toBe("Every weekday at 9:00 AM");
    expect(describeNy({ repeat: { cron: "0 9 * * *", tz: "Europe/Lisbon" } })).toMatch(/9:00 AM \(Europe\/Lisbon\)$/);
    expect(describeNy({ at: "2026-09-28T13:00:00Z", repeat: weekdays })).toBe("Every weekday at 9:00 AM, first run Mon, Sep 28 at 9:00 AM");
  });
});

describe("messages", () => {
  it("say what scheduling needs, and what was stored", () => {
    expect(SCHEDULE_PLAN_REQUIRED).toBe("Scheduling needs a paid plan.");
    expect(SCHEDULE_SIGN_IN).toMatch(/log in/i);
    const text = scheduledTaskText({
      taskId: "t9",
      instructions: "Check the order status\nat the shop",
      when: "Once, today at 6:45 PM",
      nextRunAt: "2026-09-26T22:45:00.000Z",
      nextRun: "today at 6:45 PM",
      timeZone: NY,
    });
    expect(text).toContain('"Check the order status"');
    expect(text).toContain("Once, today at 6:45 PM");
    expect(text).toContain("t9");
    // The model is told the time in the user's zone, by name, to confirm it in its reply.
    expect(text).toContain("Next run: today at 6:45 PM in the user's time zone (America/New_York).");
  });

  it("say what was changed or cancelled, with the time in the user's zone", () => {
    const task = { taskId: "t3", instructions: "Open the Vendor call link", when: "Once, Fri, Oct 2 at 3:00 PM", nextRunAt: "2026-10-02T19:00:00.000Z", nextRun: "Fri, Oct 2 at 3:00 PM", timeZone: NY };
    expect(changedTaskText("updated", task)).toBe(
      `Changed task t3 in the user's TODO list: "Open the Vendor call link" · Once, Fri, Oct 2 at 3:00 PM. Next run: Fri, Oct 2 at 3:00 PM in the user's time zone (America/New_York). The chat shows them a card with Undo. Tell them in one short line, with the time in their time zone.`,
    );
    expect(changedTaskText("cancelled", task)).toMatch(/^Cancelled task t3 in the user's TODO list: "Open the Vendor call link"\. It will not run/);
  });
});

describe("times from another zone (a calendar that shows PT or London time)", () => {
  it("an ISO time with that zone's offset is shown at the same instant in the user's zone", () => {
    // Thu Oct 1, 2:00 PM Pacific (PDT, UTC-7) is 5:00 PM in New York.
    expect(ScheduleTaskArgs.parse({ task: "x", schedule: { at: "2026-10-01T14:00:00-07:00" } }).schedule.at).toBe("2026-10-01T14:00:00-07:00");
    expect(describeNy({ at: "2026-10-01T14:00:00-07:00" })).toBe("Once, Thu, Oct 1 at 5:00 PM");
    // 3:00 PM in London (BST, UTC+1) is 10:00 AM in New York; UTC ("Z") works the same.
    expect(describeNy({ at: "2026-10-01T15:00:00+01:00" })).toBe("Once, Thu, Oct 1 at 10:00 AM");
    expect(describeNy({ at: "2026-10-01T14:00:00Z" })).toBe("Once, Thu, Oct 1 at 10:00 AM");
    // After London leaves summer time (Oct 25) but before New York does (Nov 1): 5 hours apart, not 4.
    expect(describeNy({ at: "2026-10-27T15:00:00+00:00" })).toBe("Once, Tue, Oct 27 at 11:00 AM");
    // Half-hour zones: 9:30 AM in India (UTC+5:30) is midnight in New York.
    expect(describeNy({ at: "2026-09-28T09:30:00+05:30" })).toBe("Once, Mon, Sep 28 at 12:00 AM");
  });

  it("a repeat kept in the event's zone says that zone; its first run is in the user's", () => {
    const standup = { cron: "30 9 * * 1", tz: "America/Los_Angeles" };
    expect(describeNy({ repeat: standup })).toBe("Every Monday at 9:30 AM (America/Los_Angeles)");
    expect(describeNy({ at: "2026-09-28T09:30:00-07:00", repeat: standup })).toBe("Every Monday at 9:30 AM (America/Los_Angeles), first run Mon, Sep 28 at 12:30 PM");
  });

  it("a time without an offset is refused (the zone would be a guess)", () => {
    expect(ScheduleTaskArgs.safeParse({ task: "x", schedule: { at: "2026-10-01T14:00:00" } }).success).toBe(false);
    expect(UpdateScheduledTaskArgs.safeParse({ task_id: "t1", schedule: { at: "2026-10-01T14:00:00" } }).success).toBe(false);
  });
});

describe("UpdateScheduledTaskArgs and CancelScheduledTaskArgs", () => {
  it("take the task's id and only what changes", () => {
    expect(UpdateScheduledTaskArgs.parse({ task_id: " t1 ", schedule: { at: "2026-10-02T15:00:00-04:00" } })).toEqual({ task_id: "t1", schedule: { at: "2026-10-02T15:00:00-04:00" } });
    expect(UpdateScheduledTaskArgs.parse({ task_id: "t1", schedule: { repeat: null } }).schedule).toEqual({ repeat: null });
    expect(UpdateScheduledTaskArgs.parse({ task_id: "t1", account: null }).account).toBeNull();
    expect(UpdateScheduledTaskArgs.parse({ task_id: "t1", task: "Open https://meet.example/v" }).task).toBe("Open https://meet.example/v");
    expect(CancelScheduledTaskArgs.parse({ task_id: "t1" })).toEqual({ task_id: "t1" });
  });

  it("refuse a change of nothing, a missing id and a bad repeat", () => {
    for (const bad of [{ task_id: "t1" }, { schedule: { at: "2026-10-02T15:00:00Z" } }, { task_id: "", task: "x" }, { task_id: "t1", schedule: { repeat: { cron: "0 25 * * *", tz: NY } } }]) {
      expect(UpdateScheduledTaskArgs.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(CancelScheduledTaskArgs.safeParse({}).success).toBe(false);
  });

  it("are offered to the model with descriptions that say how they are used", () => {
    expect(TOOL_DESCRIPTIONS.list_scheduled_tasks).toBe(LIST_SCHEDULED_TASKS_DESCRIPTION);
    expect(UPDATE_SCHEDULED_TASK_DESCRIPTION).toMatch(/never cancel it and schedule a new one/);
    expect(CANCEL_SCHEDULED_TASK_DESCRIPTION).toMatch(/Undo/);
    expect(TODO_TOOLS).toEqual(["schedule_task", "list_scheduled_tasks", "update_scheduled_task", "cancel_scheduled_task"]);
    for (const t of TODO_TOOLS) {
      expect(CONVERSATION_TOOLS).toContain(t);
      expect(INTERACTIVE_TOOL_NAMES).not.toContain(t);
    }
  });
});

describe("scheduledTasksText", () => {
  const task = (id: string, over: Partial<LocalTask> = {}) =>
    ({ id, instructions: `Task ${id}\nmore lines`, account: null, notBefore: null, repeat: null, status: "pending", ...over }) as LocalTask;
  const list = (tasks: LocalTask[]) => scheduledTasksText(tasks, { now: NOW, timeZone: NY, hour12: true });

  it("the waiting tasks, soonest first, one line each, times in the user's zone", () => {
    const text = list([
      task("b", { notBefore: "2026-10-01T21:00:00.000Z" }),
      task("done", { status: "done", notBefore: "2026-09-26T10:00:00.000Z" }),
      task("a", { notBefore: "2026-09-28T16:30:00.000Z", repeat: { cron: "30 9 * * 1", tz: "America/Los_Angeles" }, status: "paused", account: "@alpha" }),
      task("gone", { status: "cancelled" }),
    ]);
    expect(text.split("\n")).toEqual([
      "2 waiting tasks in the user's TODO list (times in America/New_York, the user's zone):",
      '- a · "Task a" · next run Mon, Sep 28 at 12:30 PM · Every Monday at 9:30 AM (America/Los_Angeles) · paused · as @alpha',
      '- b · "Task b" · next run Thu, Oct 1 at 5:00 PM · once',
    ]);
  });

  it("says when there is none, and how many more when the list is long", () => {
    expect(list([task("x", { status: "failed" })])).toBe("The user's TODO list has no waiting tasks.");
    const many = Array.from({ length: MAX_LISTED_TASKS + 3 }, (_, i) => task(`t${i}`, { notBefore: new Date(NOW.getTime() + (i + 1) * 3_600_000).toISOString() }));
    const lines = list(many).split("\n");
    expect(lines).toHaveLength(MAX_LISTED_TASKS + 2);
    expect(lines.at(-1)).toBe("(and 3 more, later)");
  });
});

describe("userTimeLine", () => {
  it("the user's date, time, zone and UTC offset, for the prompt's relative times", () => {
    expect(userTimeLine(NY, NOW)).toBe("The user's time: Saturday, September 26, 2026, 3:45 PM in America/New_York (UTC-04:00).");
    expect(userTimeLine("Asia/Kolkata", NOW)).toBe("The user's time: Sunday, September 27, 2026, 1:15 AM in Asia/Kolkata (UTC+05:30).");
    expect(userTimeLine("UTC", NOW)).toBe("The user's time: Saturday, September 26, 2026, 7:45 PM in UTC (UTC+00:00).");
  });
});
