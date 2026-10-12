/**
 * Edit schedule / Schedule, from a job's "⋯" menu: a sheet over the panel with the schedule fields (One time |
 * Repeat, @noa/shared/schedule-fields). A task's schedule is changed in place; a chat's request becomes a
 * new task that runs at that time (then its job opens). Scheduling needs the TODO list: signed out the sheet offers
 * Log in, on a plan without it Get a plan. Closed by Cancel, Esc or the backdrop; focus goes back to what opened it.
 */
import { TODO_LOCKED, type LocalTask } from "@noa/shared";
import { createScheduleFields } from "@noa/shared/schedule-fields";
import { uiRequest } from "../ui-protocol.js";
import { busy, flash, h } from "../ui/dom.js";
import type { TodoGate } from "./format.js";
import type { Job } from "./jobs.js";

export interface ScheduleSheetDeps {
  /** Whether scheduling is possible: signed out, a plan without the TODO list, or the list is there. */
  gate: TodoGate;
  onSignIn(): void;
  onBilling(): void;
  /** The schedule was saved: a task's (changed), or the chat's request as a new task. */
  onSaved(task: LocalTask, created: boolean): void;
}

/** Signed out: scheduling lives in the account. */
export const SCHEDULE_SIGNED_OUT = { title: "Log in to schedule", why: "Scheduled jobs are kept in your account and run on time.", action: "Log in" } as const;

export function openScheduleSheet(job: Job, trigger: HTMLElement | null, deps: ScheduleSheetDeps): HTMLDialogElement {
  const task = job.task;
  const heading = task ? "Edit schedule" : "Schedule";
  const msg = h("p.msg", { id: "sched-msg", role: "alert" });
  const cancel = h("button.ghost.small", { type: "button" }, "Cancel");
  const body = h("div.sheet-body");
  const actions = h("div.sheet-actions", null, msg, h("span.spacer"), cancel);
  const form = h("form.sheet-in", { novalidate: true }, h("div.sheet-head", null, h("h2", { id: "sched-title" }, heading)), body, actions);
  const dialog = h("dialog.sheet.schedule-sheet", { "aria-labelledby": "sched-title" }, form);
  const close = () => dialog.close();
  form.addEventListener("submit", (e) => e.preventDefault());

  if (deps.gate === "out" || deps.gate === "locked") {
    // Nothing to fill in: what the account lacks, and the way to get it.
    const words = deps.gate === "out" ? SCHEDULE_SIGNED_OUT : TODO_LOCKED;
    const go = h("button.primary.small", { type: "button", id: "sched-gate-btn" }, words.action);
    go.addEventListener("click", () => {
      close();
      if (deps.gate === "out") deps.onSignIn();
      else deps.onBilling();
    });
    body.append(h("p.sheet-gate-title", null, words.title), h("p.sheet-note", null, words.why));
    actions.append(go);
  } else {
    const request = task?.instructions ?? job.session?.instructions ?? "";
    const fields = createScheduleFields({ id: "sched", value: task ? { at: task.notBefore, repeat: task.repeat ?? null } : null, ...(task?.repeat ? { timeZone: task.repeat.tz } : {}) });
    body.append(h("div.sheet-label", null, task ? "Task" : "Request"), h("div.sheet-text.sched-request", null, request), fields.element);
    const save = h("button.primary.small", { type: "submit", id: "sched-save" }, task ? "Save" : "Schedule");
    actions.append(save);
    body.addEventListener("input", () => flash(msg, ""));
    form.addEventListener("submit", () => {
      const when = fields.read();
      if (!when.ok) {
        when.focus.focus();
        return flash(msg, when.error, "bad");
      }
      const { at, repeat } = when.value;
      void busy(
        save,
        async () => {
          const saved = task
            ? (await uiRequest({ type: "tasks.update", id: task.id, patch: { notBefore: at, repeat } })).task
            : (await uiRequest({ type: "tasks.add", instructions: request, ...(job.session?.account ? { account: job.session.account } : {}), ...(at ? { notBefore: at } : {}), ...(repeat ? { repeat } : {}) })).task;
          close();
          deps.onSaved(saved, !task);
        },
        msg,
      );
    });
  }

  cancel.addEventListener("click", close);
  // A click on the backdrop lands on the dialog itself (its content fills it).
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (trigger?.isConnected) trigger.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  (dialog.querySelector<HTMLElement>("input[type=radio]:checked, #sched-gate-btn") ?? cancel).focus();
  return dialog;
}
