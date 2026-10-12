/**
 * The TODO tools (packages/shared schedule-task.ts), answered for a
 * conversation from the user's TODO list:
 *
 * - schedule_task puts a task in it ("check again in 3 hours", "make this a
 *   daily task at 9am");
 * - list_scheduled_tasks lists the waiting tasks (id, next run, schedule in words);
 * - update_scheduled_task changes one (instructions, time, repeat, account);
 * - cancel_scheduled_task cancels one (it is over, like a job's Cancel).
 *
 * The tasks go where the TODO list's tasks go (the signed-in account's list, a
 * paid feature), and the tab shows each change at once (the TODO source's
 * change push). Every change is written to the conversation as a card with
 * View and Undo: task_scheduled (Undo deletes the task) and
 * task_changed (Undo puts the task back as it was, or back in the queue).
 *
 * Approvals: creating a task never waits (the user asked for it, and Undo is
 * right there). Changing or cancelling a task this chat scheduled does not
 * wait either (the same holds). Changing or cancelling any other task (one
 * the user made, or another chat made) waits for the user's
 * OK at every automation level but full autonomy (deps.approve, the session's
 * approval gate): it touches something the user set up on purpose.
 *
 * A chat about a task (Talk about this: SessionInfo.about) ends by saving what
 * the user and the agent agreed on as the task's instructions: that change
 * always shows its card (the new words in full), and once the user allows it
 * there, the words count as the user's (Task.agentAuthored stays off), so the
 * task's runs do not start waiting for approvals the user never asked for.
 *
 * Refusals (signed out, a plan without the TODO list) are also written to
 * the conversation as an error, so the chat shows the button that fixes it;
 * the answer's text is what the agent reads and relays.
 */
import {
  CancelScheduledTaskArgs,
  canChangeTask,
  changedTaskText,
  describeSchedule,
  errorMessage,
  localTimeZone,
  momentText,
  PLAN_REQUIRED,
  prefersHour12,
  SCHEDULE_PLAN_REQUIRED,
  SCHEDULE_SIGN_IN,
  scheduledTasksText,
  scheduledTaskText,
  ScheduleTaskArgs,
  settleSchedule,
  UpdateScheduledTaskArgs,
  type ApprovalRequest,
  type LocalTask,
  type ScheduledTask,
  type ScheduleInput,
  type TodoChange,
  type TodoTaskFields,
  type TodoToolName,
  type TodoToolResult,
} from "@noa/shared";
import type { z } from "zod";
import type { TodoSource } from "../account/todo-source.js";
import { ApiRequestError, NotSignedInError } from "../http-client.js";
import type { TaskPatch } from "../ui-protocol.js";
import type { SessionStore } from "./sessions.js";

/** Whether the user has a TODO list to schedule into: signed in, on a plan that includes it. */
export type TodoAccess = "ok" | "signed-out" | "no-plan";

/** A change to the TODO list the user's OK is asked for (an approval card). */
export type TodoApprovalAsk = Omit<ApprovalRequest, "id" | "expiresAt">;

/** A one-off time this far in the past is still taken (the model's clock arithmetic, a slow turn). */
const PAST_GRACE_MS = 60_000;

export interface TaskSchedulerDeps {
  /** The TODO list's tasks (the account's when signed in). */
  todo(): Promise<TodoSource>;
  access(): Promise<TodoAccess>;
  /** get: which task a chat is about (SessionInfo.about); absent: none is. */
  sessions: Pick<SessionStore, "note" | "eventsOf"> & Partial<Pick<SessionStore, "get">>;
  /**
   * Waits for the user's OK on a change to a task this chat did not schedule, at the session's automation level
   * (approval/gate.ts); throws the refusal the agent reads when it is not given. Resolves true when the user allowed it
   * on its card (false or nothing: it did not wait). Absent: nothing waits.
   */
  approve?(sessionId: string, ask: TodoApprovalAsk): Promise<boolean | void>;
  /** The user's IANA time zone, for the schedule in words. Default: this browser's. */
  timeZone?(): string;
  now?(): Date;
  /** 12-hour times in the schedule's words. Default: the browser locale's choice. */
  hour12?: boolean;
  /** A new change's id (Undo names it). Default: a random UUID. */
  newId?(): string;
  /** A task was changed (update_scheduled_task): its memory follows it (MemoryService.taskEdited). Never fails the change. */
  onEdited?(before: LocalTask, after: LocalTask): Promise<void>;
}

/** What nothing was done, in the refusals: "Nothing was scheduled." / "Nothing was changed." */
type Nothing = "scheduled" | "changed";

/** The refusals the chat shows with a fix button, and the line the agent reads for each. */
const REFUSALS: Record<Exclude<TodoAccess, "ok">, { chat: string; agent: (nothing: Nothing) => string }> = {
  "signed-out": {
    chat: SCHEDULE_SIGN_IN,
    agent: (nothing) => `${SCHEDULE_SIGN_IN} Nothing was ${nothing}. Tell the user; the chat shows them a Log in button. Do not retry.`,
  },
  "no-plan": {
    chat: SCHEDULE_PLAN_REQUIRED,
    agent: (nothing) => `${SCHEDULE_PLAN_REQUIRED} Nothing was ${nothing}. Tell the user; the chat shows them a Choose a plan button. Do not retry.`,
  },
};

/** A refusal already written to the chat: its text is the agent's answer. */
class TodoRefusal extends Error {}

/** Zod's issues as one line the model can act on: "schedule.repeat.cron: hour 25 is outside 0-23". */
function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "arguments"}: ${i.message}`).join("; ");
}

function parseArgs<T extends z.ZodType>(schema: T, raw: unknown, tool: TodoToolName, nothing: Nothing): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${tool} arguments: ${issuesText(parsed.error)}. Nothing was ${nothing}.`);
  return parsed.data;
}

/** A task's schedule as the schedule model says it (its next run, and its repeat rule). */
function scheduleOf(t: Pick<LocalTask, "notBefore" | "repeat">): ScheduleInput {
  return { ...(t.notBefore ? { at: t.notBefore } : {}), ...(t.repeat ? { repeat: t.repeat } : {}) };
}

function fieldsOf(t: LocalTask): TodoTaskFields {
  return { instructions: t.instructions, account: t.account, schedule: scheduleOf(t), ...(t.agentAuthored ? { agentAuthored: true as const } : {}) };
}

const titleOf = (instructions: string) => instructions.split("\n")[0]!.trim();
const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"`;

export class TaskScheduler {
  constructor(private readonly deps: TaskSchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private timeZone(): string {
    return this.deps.timeZone?.() ?? localTimeZone();
  }

  /** One TODO tool call of conversation `sessionId`: the model's answer; isError when nothing was done. */
  async tool(sessionId: string, name: TodoToolName, rawArgs: unknown): Promise<TodoToolResult> {
    try {
      switch (name) {
        case "schedule_task":
          return { text: scheduledTaskText(await this.schedule(sessionId, rawArgs)) };
        case "list_scheduled_tasks":
          return { text: await this.list(sessionId) };
        case "update_scheduled_task":
          return { text: changedTaskText("updated", await this.update(sessionId, rawArgs)) };
        case "cancel_scheduled_task":
          return { text: changedTaskText("cancelled", await this.cancel(sessionId, rawArgs)) };
      }
    } catch (err) {
      return { text: errorMessage(err), isError: true };
    }
  }

  /** Stores the task the agent wrote for conversation `sessionId`. Throws with the reason on refusal (nothing stored). */
  async schedule(sessionId: string, rawArgs: unknown): Promise<ScheduledTask> {
    const args = parseArgs(ScheduleTaskArgs, rawArgs, "schedule_task", "scheduled");
    const now = this.now();
    const at = args.schedule.at ?? null;
    this.assertFuture(at, now, "scheduled");
    const settled = settleSchedule(at, args.schedule.repeat ?? null, now);
    const task = await this.withTodo(sessionId, "scheduled", (todo) =>
      todo.add({
        instructions: args.task,
        ...(args.account ? { account: args.account } : {}),
        notBefore: settled.notBefore,
        repeat: settled.repeat,
        // The agent wrote it (Task.agentAuthored): its runs wait for the user's OK on what it asks until they trust it.
        agentAuthored: true,
      }),
    );
    await this.deps.sessions.note(sessionId, { type: "task_scheduled", taskId: task.id, instructions: task.instructions, schedule: args.schedule });
    return this.described(task.id, task.instructions, args.schedule, settled.notBefore, now);
  }

  /** The waiting tasks in words, for the model. */
  async list(sessionId: string): Promise<string> {
    const { tasks } = await this.withTodo(sessionId, "changed", (todo) => todo.list());
    return scheduledTasksText(tasks, { now: this.now(), timeZone: this.timeZone(), hour12: this.hour12() });
  }

  /** Changes a waiting task (only what the arguments give). Throws with the reason when nothing was changed. */
  async update(sessionId: string, rawArgs: unknown): Promise<ScheduledTask> {
    const args = parseArgs(UpdateScheduledTaskArgs, rawArgs, "update_scheduled_task", "changed");
    const now = this.now();
    this.assertFuture(args.schedule?.at ?? null, now, "changed");
    const patch: TaskPatch = {};
    if (args.task !== undefined) patch.instructions = args.task;
    if (args.account !== undefined) patch.account = args.account;
    if (args.schedule?.at !== undefined) patch.notBefore = args.schedule.at === null ? null : new Date(args.schedule.at).toISOString();
    if (args.schedule?.repeat !== undefined) patch.repeat = args.schedule.repeat;
    const { before, after } = await this.withTodo(sessionId, "changed", async (todo) => {
      const before = await this.changeable(todo, args.task_id, "updated");
      // A run under way keeps its time: its next one comes from the repeat rule when it ends.
      if (before.status === "running" && patch.notBefore) {
        throw new TodoRefusal(`Task ${before.id} is running now, so its next run follows its repeat rule: change its repeat rule or instructions, or give the new time once this run ends. Nothing was changed.`);
      }
      const reviewed = await this.isAbout(sessionId, before);
      const allowed = await this.approveChange(sessionId, before, "updated", this.previewOf(before, patch, now), reviewed);
      // New words from the agent are the agent's, whoever wrote the task (Task.agentAuthored), unless the user allowed
      // these very words on the card of a chat about the task (see the top of this file).
      if (patch.instructions !== undefined && patch.instructions !== before.instructions) patch.agentAuthored = !(reviewed && allowed);
      return { before, after: await todo.update(before.id, patch) };
    });
    const schedule = scheduleOf(after);
    await this.deps.onEdited?.(before, after).catch(() => undefined);
    await this.note(sessionId, { taskId: after.id, change: "updated", instructions: after.instructions, schedule, before: fieldsOf(before) });
    return this.described(after.id, after.instructions, schedule, after.notBefore, now);
  }

  /** Cancels a waiting task (it moves to Finished). Throws with the reason when nothing was changed. */
  async cancel(sessionId: string, rawArgs: unknown): Promise<ScheduledTask> {
    const args = parseArgs(CancelScheduledTaskArgs, rawArgs, "cancel_scheduled_task", "changed");
    const task = await this.withTodo(sessionId, "changed", async (todo) => {
      const task = await this.changeable(todo, args.task_id, "cancelled");
      await this.approveChange(sessionId, task, "cancelled");
      await todo.cancel(task.id);
      return task;
    });
    const schedule = scheduleOf(task);
    await this.note(sessionId, { taskId: task.id, change: "cancelled", instructions: task.instructions, schedule });
    return this.described(task.id, task.instructions, schedule, task.notBefore, this.now());
  }

  /** Undo on a scheduled card: deletes a task this conversation scheduled, and the card says so. Undoing twice is harmless. */
  async undo(sessionId: string, taskId: string): Promise<void> {
    const events = await this.deps.sessions.eventsOf(sessionId);
    if (!events.some((e) => e.type === "task_scheduled" && e.taskId === taskId)) throw new Error("That task was not scheduled in this chat");
    if (events.some((e) => e.type === "task_unscheduled" && e.taskId === taskId)) return;
    await (await this.deps.todo()).delete(taskId);
    await this.deps.sessions.note(sessionId, { type: "task_unscheduled", taskId });
  }

  /**
   * Undo on a changed or cancelled card: an updated task gets its fields back, a cancelled one goes back in the
   * queue (it runs at its time, or at once when that has passed). Undoing twice is harmless.
   */
  async undoChange(sessionId: string, changeId: string): Promise<void> {
    const events = await this.deps.sessions.eventsOf(sessionId);
    const ev = events.find((e) => e.type === "task_changed" && e.changeId === changeId);
    if (ev?.type !== "task_changed") throw new Error("That change was not made in this chat");
    if (events.some((e) => e.type === "task_change_undone" && e.changeId === changeId)) return;
    const todo = await this.deps.todo();
    if (ev.change === "cancelled") await todo.retry(ev.taskId);
    else if (ev.before) {
      const b = ev.before;
      await todo.update(ev.taskId, { instructions: b.instructions, account: b.account, notBefore: b.schedule.at ?? null, repeat: b.schedule.repeat ?? null, agentAuthored: !!b.agentAuthored });
    }
    await this.deps.sessions.note(sessionId, { type: "task_change_undone", changeId });
  }

  private hour12(): boolean {
    return this.deps.hour12 ?? prefersHour12();
  }

  private assertFuture(at: string | null, now: Date, nothing: Nothing): void {
    if (at && Date.parse(at) < now.getTime() - PAST_GRACE_MS) {
      throw new Error(`schedule.at ${at} has already passed (it is now ${now.toISOString()}). Nothing was ${nothing}: give a time in the future.`);
    }
  }

  /** What the model and the card are told of a stored task: its schedule in words and its next run, in the user's zone. */
  private described(taskId: string, instructions: string, schedule: ScheduleInput, nextRunAt: string | null, now: Date): ScheduledTask {
    const timeZone = this.timeZone();
    const hour12 = this.hour12();
    return {
      taskId,
      instructions,
      when: describeSchedule(schedule, { now, timeZone, hour12 }),
      nextRunAt,
      nextRun: nextRunAt ? momentText(nextRunAt, now, timeZone, hour12) : null,
      timeZone,
    };
  }

  /** Runs `fn` on the TODO list when the user has one; a refusal (signed out, no plan) is written to the chat too. */
  private async withTodo<T>(sessionId: string, nothing: Nothing, fn: (todo: TodoSource) => Promise<T>): Promise<T> {
    const access = await this.deps.access();
    if (access !== "ok") return this.refuse(sessionId, access, nothing);
    try {
      return await fn(await this.deps.todo());
    } catch (err) {
      if (err instanceof TodoRefusal) throw err;
      if (err instanceof NotSignedInError) return this.refuse(sessionId, "signed-out", nothing);
      if (err instanceof ApiRequestError && err.body?.error === PLAN_REQUIRED) return this.refuse(sessionId, "no-plan", nothing);
      throw new Error(`The TODO list did not take it: ${errorMessage(err)}. Nothing was ${nothing}.`);
    }
  }

  /** The task `id` as the TODO list has it now, when `change` of it may still be made. */
  private async changeable(todo: TodoSource, id: string, change: TodoChange): Promise<LocalTask> {
    const task = (await todo.list()).tasks.find((t) => t.id === id);
    if (!task) throw new TodoRefusal(`There is no task ${id} in the user's TODO list: call list_scheduled_tasks for the ids. Nothing was changed.`);
    if (!canChangeTask(task, change)) {
      const which = change === "updated" ? "a task that waits to run (pending or paused), or a repeating task while it runs," : "a task that waits to run (pending or paused)";
      throw new TodoRefusal(`Task ${id} is ${task.status}: only ${which} can be ${change}. Nothing was changed.`);
    }
    return task;
  }

  /** The new schedule and instructions in words, for the approval card. */
  private previewOf(task: LocalTask, patch: TaskPatch, now: Date): string {
    const repeat = patch.repeat === undefined ? task.repeat : patch.repeat;
    // A new rule without a time runs first at its next time, which the TODO list settles: the card names the rule only.
    const at = patch.notBefore !== undefined ? patch.notBefore : patch.repeat === undefined ? task.notBefore : null;
    const lines = [`When: ${describeSchedule(scheduleOf({ notBefore: at, repeat }), { now, timeZone: this.timeZone(), hour12: this.hour12() })}`];
    if (patch.instructions !== undefined) lines.push(`Task: ${patch.instructions}`);
    if (patch.account !== undefined) lines.push(`Account: ${patch.account ?? "none"}`);
    return lines.join("\n");
  }

  /** Whether conversation `sessionId` is a chat about `task` (Talk about this on its job's page). */
  private async isAbout(sessionId: string, task: LocalTask): Promise<boolean> {
    const about = (await this.deps.sessions.get?.(sessionId))?.about;
    return !!about && (task.id === about.taskId || (task.seriesId ?? task.id) === about.seriesId);
  }

  /**
   * A change to a task this chat did not schedule waits for the user's OK, and so does saving a chat's review of its
   * task (`reviewed`; see the top of this file). True: the user allowed it on its card.
   */
  private async approveChange(sessionId: string, task: LocalTask, change: TodoChange, text?: string, reviewed = false): Promise<boolean> {
    if (!this.deps.approve) return false;
    const events = await this.deps.sessions.eventsOf(sessionId);
    const ours = events.some((e) => e.type === "task_scheduled" && e.taskId === task.id) && !events.some((e) => e.type === "task_unscheduled" && e.taskId === task.id);
    if (ours && !reviewed) return false;
    const title = quote(titleOf(task.instructions));
    const update = reviewed ? { action: `Save the new instructions of ${title}`, why: "updates this scheduled job with what you agreed on here" } : { action: `Change the scheduled job ${title}`, why: "changes one of your scheduled jobs" };
    try {
      const allowed = await this.deps.approve(sessionId, {
        ...(change === "cancelled" ? { action: `Cancel the scheduled job ${title}`, why: "cancels one of your scheduled jobs" } : update),
        site: "",
        ...(text ? { text } : {}),
      });
      return allowed === true;
    } catch (err) {
      // Not approved: the gate's words (do not retry) are the agent's answer as they are.
      throw new TodoRefusal(errorMessage(err));
    }
  }

  private async note(sessionId: string, change: { taskId: string; change: TodoChange; instructions: string; schedule: ScheduleInput; before?: TodoTaskFields }): Promise<void> {
    const changeId = this.deps.newId?.() ?? crypto.randomUUID();
    await this.deps.sessions.note(sessionId, { type: "task_changed", changeId, ...change });
  }

  private async refuse(sessionId: string, why: Exclude<TodoAccess, "ok">, nothing: Nothing): Promise<never> {
    const r = REFUSALS[why];
    await this.deps.sessions.note(sessionId, { type: "error", text: r.chat });
    throw new TodoRefusal(r.agent(nothing));
  }
}
