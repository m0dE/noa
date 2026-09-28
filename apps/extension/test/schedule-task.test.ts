import { describe, expect, it, vi } from "vitest";
import { approvalRefusalText, PLAN_REQUIRED, PLAN_REQUIRED_MESSAGES, SCHEDULE_PLAN_REQUIRED, SCHEDULE_SIGN_IN, settleSchedule, type LocalTask, type SessionInfo } from "@noa/shared";
import type { TodoSource } from "../src/account/todo-source.js";
import type { NewLocalTask } from "../src/engine/local-store.js";
import { TaskScheduler, type TaskSchedulerDeps, type TodoAccess } from "../src/engine/schedule-task.js";
import type { TaskPatch } from "../src/ui-protocol.js";
import { SessionStore } from "../src/engine/sessions.js";
import { ApiRequestError } from "../src/http-client.js";
import { MemoryKvDb } from "./memory-kv.js";

const NY = "America/New_York";
/** Sat Sep 26 2026, 15:45 in New York. */
const NOW = new Date("2026-09-26T19:45:00Z");
const SESSION: SessionInfo = { sessionId: "s1", source: "adhoc", title: "Check my order", brain: "claude-api", jev: false, startedAt: NOW.toISOString() };

/** A TODO list in memory, with what was added and deleted. */
function memoryTodo(opts: { failAdd?: Error } = {}) {
  const tasks = new Map<string, LocalTask>();
  const added: NewLocalTask[] = [];
  const patches: [string, TaskPatch][] = [];
  let n = 0;
  const source: TodoSource = {
    kind: "account",
    list: async () => ({ tasks: [...tasks.values()].map((t) => ({ ...t, media: [] })), locked: false }),
    add: async (input) => {
      if (opts.failAdd) throw opts.failAdd;
      added.push(input);
      const task = {
        id: `t${++n}`,
        instructions: input.instructions,
        account: input.account ?? null,
        mediaIds: [],
        notBefore: input.notBefore ?? null,
        repeat: input.repeat ?? null,
        status: "pending",
        ...(input.agentAuthored ? { agentAuthored: true } : {}),
      } as unknown as LocalTask;
      tasks.set(task.id, task);
      return task;
    },
    // Like the TODO list: a patch changes what it names; a new rule without a time runs at its next time.
    update: async (id, patch) => {
      patches.push([id, patch]);
      const t = tasks.get(id)!;
      const next = { ...t };
      if (patch.instructions !== undefined) next.instructions = patch.instructions;
      if (patch.account !== undefined) next.account = patch.account;
      if (patch.repeat !== undefined) next.repeat = patch.repeat;
      if (patch.notBefore !== undefined) next.notBefore = patch.notBefore;
      else if (patch.repeat) next.notBefore = settleSchedule(null, patch.repeat, NOW).notBefore;
      // Like the TODO list: new instructions are the user's unless the patch says the agent wrote them.
      if (patch.agentAuthored !== undefined) next.agentAuthored = patch.agentAuthored;
      else if (patch.instructions !== undefined && patch.instructions !== t.instructions) next.agentAuthored = false;
      tasks.set(id, next);
      return next;
    },
    delete: async (id) => tasks.delete(id),
    retry: async (id) => {
      const t = { ...tasks.get(id)!, status: "pending" as const };
      tasks.set(id, t);
      return t;
    },
    cancel: async (id) => {
      const t = { ...tasks.get(id)!, status: "cancelled" as const };
      tasks.set(id, t);
      return t;
    },
    pause: async (id, reason) => {
      const t = { ...tasks.get(id)!, status: "paused" as const, pauseReason: reason ?? "Paused by you" };
      tasks.set(id, t);
      return t;
    },
    resume: async (id) => {
      const t = { ...tasks.get(id)!, status: "pending" as const, pauseReason: null };
      tasks.set(id, t);
      return t;
    },
    holdSeries: async () => null,
    releaseHold: async () => [],
    seriesPage: async () => ({ tasks: [], nextCursor: null }),
  };
  /** A task the user made in the TODO tab (not in this chat). */
  const own = (task: Partial<LocalTask> & { id: string; instructions: string }) => {
    const t = { account: null, mediaIds: [], notBefore: null, repeat: null, status: "pending", ...task } as unknown as LocalTask;
    tasks.set(t.id, t);
    return t;
  };
  return { source, tasks, added, patches, own };
}

async function setup(opts: { access?: TodoAccess; failAdd?: Error; approve?: TaskSchedulerDeps["approve"]; onEdited?: TaskSchedulerDeps["onEdited"] } = {}) {
  const sessions = new SessionStore(new MemoryKvDb(), { now: () => NOW });
  await sessions.create(SESSION);
  const todo = memoryTodo(opts);
  let changes = 0;
  const scheduler = new TaskScheduler({
    todo: async () => todo.source,
    access: async () => opts.access ?? "ok",
    sessions,
    timeZone: () => NY,
    now: () => NOW,
    hour12: true,
    newId: () => `c${++changes}`,
    ...(opts.approve ? { approve: opts.approve } : {}),
    ...(opts.onEdited ? { onEdited: opts.onEdited } : {}),
  });
  const events = async () => (await sessions.eventsOf("s1")).map(({ ts: _ts, sessionId: _s, ...e }) => e);
  return { scheduler, sessions, todo, events };
}

describe("TaskScheduler.schedule", () => {
  it("a one-off check-up: stored in the TODO list, the chat gets its card, the model its confirmation", async () => {
    const t = await setup();
    const task = "Open https://shop.example.com/orders/42 and tell me whether order 42 has shipped.";
    const r = await t.scheduler.schedule("s1", { task, schedule: { at: "2026-09-26T22:45:00-04:00" } });
    // The agent wrote it: its runs do not take it as the user's word until the user trusts it (Task.agentAuthored).
    expect(t.todo.added).toEqual([{ instructions: task, notBefore: "2026-09-27T02:45:00.000Z", repeat: null, agentAuthored: true }]);
    expect(r).toEqual({ taskId: "t1", instructions: task, when: "Once, today at 10:45 PM", nextRunAt: "2026-09-27T02:45:00.000Z", nextRun: "today at 10:45 PM", timeZone: NY });
    expect(await t.events()).toEqual([{ type: "task_scheduled", taskId: "t1", instructions: task, schedule: { at: "2026-09-26T22:45:00-04:00" } }]);
  });

  it("a daily repeat with an account: its first run is the rule's next time", async () => {
    const t = await setup();
    const r = await t.scheduler.schedule("s1", { task: "Post gm on X", account: "@alpha", schedule: { repeat: { cron: "0 9 * * *", tz: NY } } });
    expect(t.todo.added).toEqual([{ instructions: "Post gm on X", account: "@alpha", notBefore: "2026-09-27T13:00:00.000Z", repeat: { cron: "0 9 * * *", tz: NY }, agentAuthored: true }]);
    expect(r.when).toBe("Daily at 9:00 AM");
    expect(r.nextRunAt).toBe("2026-09-27T13:00:00.000Z");
  });

  it("refuses bad arguments with what to fix, and stores nothing", async () => {
    const t = await setup();
    await expect(t.scheduler.schedule("s1", { task: "", schedule: { at: "2026-09-26T22:45:00Z" } })).rejects.toThrow(/task/);
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: {} })).rejects.toThrow(/at.*repeat/);
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { repeat: { cron: "0 25 * * *", tz: NY } } })).rejects.toThrow(/hour 25/);
    expect(t.todo.added).toEqual([]);
    expect(await t.events()).toEqual([]);
  });

  it("refuses a time that has passed", async () => {
    const t = await setup();
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T09:00:00-04:00" } })).rejects.toThrow(/passed/);
    expect(t.todo.added).toEqual([]);
  });

  it("on a plan without the TODO list: nothing stored, the chat shows the plan card, the model is told to relay it", async () => {
    const t = await setup({ access: "no-plan" });
    const err = await t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } }).catch((e: Error) => e);
    expect((err as Error).message).toContain(SCHEDULE_PLAN_REQUIRED);
    expect((err as Error).message).toMatch(/Nothing was scheduled/);
    expect(t.todo.added).toEqual([]);
    expect(await t.events()).toEqual([{ type: "error", text: SCHEDULE_PLAN_REQUIRED }]);
  });

  it("signed out: nothing stored, the chat offers Log in", async () => {
    const t = await setup({ access: "signed-out" });
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } })).rejects.toThrow(SCHEDULE_SIGN_IN);
    expect(await t.events()).toEqual([{ type: "error", text: SCHEDULE_SIGN_IN }]);
  });

  it("the server's plan refusal (a plan cached here that changed) reads the same", async () => {
    const refusal = new ApiRequestError(403, PLAN_REQUIRED_MESSAGES.todo, { error: PLAN_REQUIRED, feature: "todo", message: PLAN_REQUIRED_MESSAGES.todo });
    const t = await setup({ failAdd: refusal });
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } })).rejects.toThrow(SCHEDULE_PLAN_REQUIRED);
    expect(await t.events()).toEqual([{ type: "error", text: SCHEDULE_PLAN_REQUIRED }]);
  });
});

describe("TaskScheduler.undo", () => {
  it("deletes the task and marks the card undone; a second undo changes nothing", async () => {
    const t = await setup();
    const { taskId } = await t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } });
    await t.scheduler.undo("s1", taskId);
    expect(t.todo.tasks.has(taskId)).toBe(false);
    await t.scheduler.undo("s1", taskId);
    expect((await t.events()).map((e) => e.type)).toEqual(["task_scheduled", "task_unscheduled"]);
  });

  it("only undoes a task this chat scheduled", async () => {
    const t = await setup();
    await expect(t.scheduler.undo("s1", "t-other")).rejects.toThrow(/not scheduled in this chat/);
  });
});

/** The Vendor call as a calendar shows it: Thu Oct 1, 2:00 PM Pacific (5:00 PM in New York). */
const VENDOR_AT = "2026-10-01T14:00:00-07:00";

describe("TaskScheduler.tool", () => {
  it("schedule_task: the answer names the time in the user's zone, whatever zone the time came in", async () => {
    const t = await setup();
    const r = await t.scheduler.tool("s1", "schedule_task", { task: "Open the Vendor call link https://meet.example/vendor", schedule: { at: VENDOR_AT } });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Once, Thu, Oct 1 at 5:00 PM");
    expect(r.text).toContain("Next run: Thu, Oct 1 at 5:00 PM in the user's time zone (America/New_York).");
    expect(t.todo.added[0]!.notBefore).toBe("2026-10-01T21:00:00.000Z");
  });

  it("list_scheduled_tasks: the waiting tasks with ids and next runs in the user's zone", async () => {
    const t = await setup();
    t.todo.own({ id: "u1", instructions: "Dentist: leave at 2:30", notBefore: "2026-10-01T18:30:00.000Z" });
    t.todo.own({ id: "u2", instructions: "Old report", status: "done" });
    await t.scheduler.tool("s1", "schedule_task", { task: "Open the Vendor call link", schedule: { at: VENDOR_AT } });
    const r = await t.scheduler.tool("s1", "list_scheduled_tasks", {});
    expect(r.text.split("\n")).toEqual([
      "2 waiting tasks in the user's TODO list (times in America/New_York, the user's zone):",
      expect.stringMatching(/^- u1 . "Dentist: leave at 2:30" . next run Thu, Oct 1 at 2:30 PM . once$/),
      expect.stringMatching(/^- t1 . "Open the Vendor call link" . next run Thu, Oct 1 at 5:00 PM . once$/),
    ]);
  });

  it("refusals and bad arguments come back as errors the model reads, with nothing done", async () => {
    const t = await setup({ access: "no-plan" });
    const r = await t.scheduler.tool("s1", "list_scheduled_tasks", {});
    expect(r).toEqual({ isError: true, text: expect.stringContaining(`${SCHEDULE_PLAN_REQUIRED} Nothing was changed.`) });
    const ok = await setup();
    expect((await ok.scheduler.tool("s1", "update_scheduled_task", { task_id: "t1" })).text).toMatch(/^update_scheduled_task arguments: .*give what changes/);
    expect((await ok.scheduler.tool("s1", "cancel_scheduled_task", { task_id: "nope" })).text).toBe(
      "There is no task nope in the user's TODO list: call list_scheduled_tasks for the ids. Nothing was changed.",
    );
  });
});

describe("TaskScheduler.update", () => {
  it("tells memory what the task was and is (its history follows the series); a failure there never fails the change", async () => {
    const seen: [string, string][] = [];
    const t = await setup({ onEdited: async (before, after) => void seen.push([before.instructions, after.instructions]) });
    t.todo.own({ id: "u9", instructions: "Post a tip", seriesId: "S1" } as never);
    await t.scheduler.tool("s1", "update_scheduled_task", { task_id: "u9", task: "Post a grounded tip. No price talk." });
    expect(seen).toEqual([["Post a tip", "Post a grounded tip. No price talk."]]);
    const failing = await setup({ onEdited: async () => { throw new Error("memory down"); } });
    failing.todo.own({ id: "u8", instructions: "Post a tip" });
    expect((await failing.scheduler.tool("s1", "update_scheduled_task", { task_id: "u8", task: "Post another tip" })).isError).toBeUndefined();
  });

  it("a task this chat scheduled moves without asking; the chat gets a Changed card with what it was", async () => {
    const approve = vi.fn(async () => {});
    const t = await setup({ approve });
    const { taskId } = await t.scheduler.schedule("s1", { task: "Open the Vendor call link", schedule: { at: VENDOR_AT } });
    // "Move it to Friday 3pm": 3:00 PM in New York.
    const r = await t.scheduler.tool("s1", "update_scheduled_task", { task_id: taskId, schedule: { at: "2026-10-02T15:00:00-04:00" } });
    expect(r.text).toContain(`Changed task ${taskId} in the user's TODO list`);
    expect(r.text).toContain("Next run: Fri, Oct 2 at 3:00 PM in the user's time zone (America/New_York).");
    expect(approve).not.toHaveBeenCalled();
    expect(t.todo.patches).toEqual([[taskId, { notBefore: "2026-10-02T19:00:00.000Z" }]]);
    expect((await t.events()).at(-1)).toEqual({
      type: "task_changed",
      changeId: "c1",
      taskId,
      change: "updated",
      instructions: "Open the Vendor call link",
      schedule: { at: "2026-10-02T19:00:00.000Z" },
      before: { instructions: "Open the Vendor call link", account: null, schedule: { at: "2026-10-01T21:00:00.000Z" }, agentAuthored: true },
    });
  });

  it("a task the user made waits for their OK; the card shows the new time and instructions", async () => {
    const approve = vi.fn(async () => {});
    const t = await setup({ approve });
    t.todo.own({ id: "u1", instructions: "Weekly standup notes", notBefore: "2026-09-28T13:30:00.000Z", repeat: { cron: "30 9 * * 1", tz: NY } });
    await t.scheduler.update("s1", { task_id: "u1", task: "Open the standup link", schedule: { repeat: { cron: "30 9 * * 1-5", tz: NY } } });
    expect(approve).toHaveBeenCalledWith("s1", {
      action: 'Change the scheduled job "Weekly standup notes"',
      site: "",
      why: "changes one of your scheduled jobs",
      text: "When: Every weekday at 9:30 AM\nTask: Open the standup link",
    });
    expect(t.todo.tasks.get("u1")).toMatchObject({ instructions: "Open the standup link", repeat: { cron: "30 9 * * 1-5", tz: NY } });
  });

  it("not approved: nothing changes, no card, and the model reads the refusal", async () => {
    const refusal = approvalRefusalText("deny", 'Change the scheduled job "Weekly standup notes"');
    const t = await setup({ approve: async () => Promise.reject(new Error(refusal)) });
    t.todo.own({ id: "u1", instructions: "Weekly standup notes", notBefore: "2026-09-28T13:30:00.000Z" });
    expect(await t.scheduler.tool("s1", "update_scheduled_task", { task_id: "u1", schedule: { at: "2026-09-29T09:30:00-04:00" } })).toEqual({ isError: true, text: refusal });
    expect(t.todo.patches).toEqual([]);
    expect(await t.events()).toEqual([]);
  });

  it("repeat null makes a repeating task run once; a past time and a finished task are refused", async () => {
    const t = await setup();
    t.todo.own({ id: "u1", instructions: "Standup", notBefore: "2026-09-28T13:30:00.000Z", repeat: { cron: "30 9 * * 1", tz: NY } });
    t.todo.own({ id: "u2", instructions: "Ran already", status: "done" });
    await t.scheduler.update("s1", { task_id: "u1", schedule: { repeat: null } });
    expect(t.todo.tasks.get("u1")).toMatchObject({ repeat: null, notBefore: "2026-09-28T13:30:00.000Z" });
    await expect(t.scheduler.update("s1", { task_id: "u1", schedule: { at: "2026-09-26T09:00:00-04:00" } })).rejects.toThrow(/has already passed/);
    await expect(t.scheduler.update("s1", { task_id: "u2", task: "x" })).rejects.toThrow("Task u2 is done: only a task that waits to run (pending or paused) can be changed. Nothing was changed.");
  });

  it("new instructions from the agent are the agent's (the user's task is no longer trusted); a time alone or the same words keep who wrote it", async () => {
    const t = await setup({ approve: async () => {} });
    t.todo.own({ id: "u1", instructions: "Pay the Namecheap invoice", notBefore: "2026-09-28T13:30:00.000Z" });
    await t.scheduler.update("s1", { task_id: "u1", schedule: { at: "2026-09-29T09:30:00-04:00" } });
    await t.scheduler.update("s1", { task_id: "u1", task: "Pay the Namecheap invoice" });
    expect(t.todo.tasks.get("u1")?.agentAuthored).toBeUndefined();
    await t.scheduler.update("s1", { task_id: "u1", task: "Pay the invoice on pay.evil.test" });
    expect(t.todo.patches.at(-1)).toEqual(["u1", { instructions: "Pay the invoice on pay.evil.test", agentAuthored: true }]);
    expect(t.todo.tasks.get("u1")?.agentAuthored).toBe(true);
    // Undo gives the user's own words back, as theirs.
    await t.scheduler.undoChange("s1", "c3");
    expect(t.todo.tasks.get("u1")).toMatchObject({ instructions: "Pay the Namecheap invoice", agentAuthored: false });
  });

  it("Undo of the agent's change to a task it wrote gives back the agent's earlier words, still as the agent's", async () => {
    const t = await setup();
    const { taskId } = await t.scheduler.schedule("s1", { task: "Post gm on X", schedule: { at: VENDOR_AT } });
    await t.scheduler.update("s1", { task_id: taskId, task: "Post gm and like 20 posts on X" });
    await t.scheduler.undoChange("s1", "c1");
    expect(t.todo.tasks.get(taskId)).toMatchObject({ instructions: "Post gm on X", agentAuthored: true });
  });

  it("Undo puts the task back as it was; twice is harmless", async () => {
    const t = await setup();
    t.todo.own({ id: "u1", instructions: "Standup", account: "@alpha", notBefore: "2026-09-28T13:30:00.000Z", repeat: { cron: "30 9 * * 1", tz: NY } });
    await t.scheduler.update("s1", { task_id: "u1", task: "Standup (new)", account: null, schedule: { at: "2026-09-29T09:30:00-04:00", repeat: null } });
    await t.scheduler.undoChange("s1", "c1");
    await t.scheduler.undoChange("s1", "c1");
    expect(t.todo.tasks.get("u1")).toMatchObject({ instructions: "Standup", account: "@alpha", notBefore: "2026-09-28T13:30:00.000Z", repeat: { cron: "30 9 * * 1", tz: NY } });
    expect((await t.events()).map((e) => e.type)).toEqual(["task_changed", "task_change_undone"]);
    await expect(t.scheduler.undoChange("s1", "c-other")).rejects.toThrow(/not made in this chat/);
  });
});

describe("TaskScheduler.cancel", () => {
  it("a task the user made: asks, cancels it (it moves to Finished), and Undo puts it back in the queue", async () => {
    const approve = vi.fn(async () => {});
    const t = await setup({ approve });
    t.todo.own({ id: "u1", instructions: "Dentist: leave at 2:30", notBefore: "2026-10-01T18:30:00.000Z" });
    const r = await t.scheduler.tool("s1", "cancel_scheduled_task", { task_id: "u1" });
    expect(r.text).toMatch(/^Cancelled task u1 in the user's TODO list: "Dentist: leave at 2:30"\. It will not run/);
    expect(approve).toHaveBeenCalledWith("s1", { action: 'Cancel the scheduled job "Dentist: leave at 2:30"', site: "", why: "cancels one of your scheduled jobs" });
    expect(t.todo.tasks.get("u1")!.status).toBe("cancelled");
    expect((await t.events()).at(-1)).toEqual({
      type: "task_changed",
      changeId: "c1",
      taskId: "u1",
      change: "cancelled",
      instructions: "Dentist: leave at 2:30",
      schedule: { at: "2026-10-01T18:30:00.000Z" },
    });
    await t.scheduler.undoChange("s1", "c1");
    expect(t.todo.tasks.get("u1")!.status).toBe("pending");
    // Cancelled already: nothing more to cancel.
    await t.scheduler.cancel("s1", { task_id: "u1" });
    await expect(t.scheduler.cancel("s1", { task_id: "u1" })).rejects.toThrow(/is cancelled/);
  });

  it("a task this chat scheduled is cancelled without asking; after its Undo it would ask", async () => {
    const approve = vi.fn(async () => {});
    const t = await setup({ approve });
    const { taskId } = await t.scheduler.schedule("s1", { task: "x", schedule: { at: VENDOR_AT } });
    await t.scheduler.cancel("s1", { task_id: taskId });
    expect(approve).not.toHaveBeenCalled();
    const again = await t.scheduler.schedule("s1", { task: "y", schedule: { at: VENDOR_AT } });
    await t.scheduler.undo("s1", again.taskId);
    t.todo.own({ id: again.taskId, instructions: "y" });
    await t.scheduler.cancel("s1", { task_id: again.taskId });
    expect(approve).toHaveBeenCalledTimes(1);
  });
});
