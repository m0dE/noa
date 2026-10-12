/**
 * The task details sheet: a modal <dialog> over the side panel with
 * everything known about a task or a chat message (see task-details.ts for
 * the model). Closed by its Close button, Esc or a click on the backdrop;
 * focus then goes back to what opened it.
 */
import type { SessionInfo } from "@noa/shared";
import { uiRequest } from "../ui-protocol.js";
import { copyText, h } from "../ui/dom.js";
import { detailsModel, linkParts, type DetailsInput, type DetailsModel, type DetailsTask, type PreviousRun } from "./task-details.js";

/** Previous runs listed at first; "Show all" lists the rest. */
export const RUNS_SHOWN = 10;

/**
 * A task's previous runs: a collapsed section ("Previous runs · 12"), each run one line (its date and the start of
 * what it produced) that opens to the whole output and the run's note.
 */
export function renderPreviousRuns(runs: readonly PreviousRun[], earlier?: string): HTMLElement {
  const item = (r: PreviousRun) =>
    h(
      "li",
      null,
      h(
        "details.run",
        null,
        h("summary", null, h("span.run-when", null, r.when), h("span.run-line", null, r.line)),
        r.output ? renderText(r.output) : null,
        r.note ? h("p.run-note", null, r.output ? `Note: ${r.note}` : r.note) : null,
      ),
    );
  const list = h("ol.runs", null, ...runs.slice(0, RUNS_SHOWN).map(item));
  const more = runs.length > RUNS_SHOWN ? h("button.ghost.small", { type: "button" }, `Show all ${runs.length}`) : null;
  more?.addEventListener("click", () => {
    list.append(...runs.slice(RUNS_SHOWN).map(item));
    more.remove();
  });
  return h(
    "details.sheet-runs",
    null,
    h("summary.sheet-label", null, `Previous runs · ${runs.length}`),
    list,
    more,
    earlier ? h("p.sheet-note", null, `Older: ${earlier}`) : null,
  );
}

/** The instructions with their line breaks, and http(s) links that open in a new tab. */
export function renderText(text: string): HTMLElement {
  return h(
    "div.sheet-text",
    null,
    ...linkParts(text).map((p) => ("url" in p ? h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.url) : p.text)),
  );
}

let current: HTMLDialogElement | null = null;

/** Where focus goes when the sheet closes: the trigger, or its replacement if the list re-rendered meanwhile. */
function returnFocus(trigger: HTMLElement | null): void {
  if (!trigger) return;
  const id = trigger.dataset.taskId;
  const target = trigger.isConnected ? trigger : id ? document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) : null;
  target?.focus();
}

export function openDetails(model: DetailsModel, trigger: HTMLElement | null): HTMLDialogElement {
  current?.close();
  const back: HTMLElement | null = trigger;

  const msg = h("span.msg", { role: "status" });
  const copyBtn = h("button.ghost.small", { type: "button", disabled: !model.text }, model.copyLabel);
  const closeBtn = h("button.ghost.small", { type: "button" }, "Close");

  const rows: HTMLElement[] = [];
  if (model.chip) rows.push(h("dt", null, "Status"), h("dd", null, h("span.chip", { "data-tone": model.chip.tone, title: model.chip.hint || null }, model.chip.label)));
  for (const f of model.fields) {
    const value = f.href ? h("a", { href: f.href, target: "_blank", rel: "noopener noreferrer", title: f.href }, f.value) : f.value;
    rows.push(h("dt", null, f.label), h("dd", { class: [f.mono ? "mono" : "", f.tone ? `tone-${f.tone}` : ""].filter(Boolean).join(" ") || null }, value));
  }

  const dialog = h(
    "dialog.sheet",
    { "aria-labelledby": "sheet-title" },
    h(
      "div.sheet-in",
      null,
      h("div.sheet-head", null, h("h2", { id: "sheet-title" }, model.heading), h("span.spacer"), closeBtn),
      h(
        "div.sheet-body",
        null,
        h("div.sheet-label", null, model.textLabel),
        model.text ? renderText(model.text) : h("p.sheet-note", null, model.emptyText),
        model.textNote ? h("p.sheet-note", null, model.textNote) : null,
        rows.length ? h("dl.sheet-fields", null, ...rows) : null,
        model.previousRuns?.length || model.earlierRuns ? renderPreviousRuns(model.previousRuns ?? [], model.earlierRuns) : null,
        model.files.length
          ? h(
              "div.sheet-files",
              null,
              h("div.sheet-label", null, "Files"),
              h("ul.files", null, ...model.files.map((f) => h("li", { title: [f.name, f.detail].filter(Boolean).join(" · ") }, h("span", null, f.name), f.detail ? h("span.file-detail", null, f.detail) : null))),
            )
          : null,
      ),
      h("div.sheet-actions", null, copyBtn, msg),
    ),
  );

  closeBtn.addEventListener("click", () => dialog.close());
  // A click on the backdrop lands on the dialog itself (its content fills it).
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (current === dialog) current = null;
    returnFocus(back);
  });
  copyBtn.addEventListener("click", () => {
    void copyText(model.text, dialog).then((ok) => {
      msg.textContent = ok ? "Copied." : "Could not copy. Select the text and copy it instead.";
      msg.dataset.tone = ok ? "ok" : "bad";
    });
  });

  document.body.append(dialog);
  current = dialog;
  dialog.showModal();
  closeBtn.focus();
  return dialog;
}

/** A task's runs in this browser, newest first. */
export async function runsOfTask(taskId: string): Promise<SessionInfo[]> {
  return (await uiRequest({ type: "sessions.list", taskId })).sessions;
}

/** What the task's memory keeps of its earlier runs (none when memory cannot say). */
async function keptRuns(task: Pick<DetailsTask, "instructions" | "account" | "seriesId">): Promise<Pick<DetailsInput, "runs">> {
  try {
    const { runs } = await uiRequest({ type: "memory.taskRuns", task: { instructions: task.instructions, account: task.account, seriesId: task.seriesId ?? null } });
    return runs.length ? { runs } : {};
  } catch {
    return {};
  }
}

/**
 * Everything known about a run's task (its TODO entry, when the list has it)
 * or a TODO entry's runs (the latest one, and what its memory keeps of the
 * earlier ones), for the sheet. Lookups are best effort: what could not be
 * loaded is left out.
 */
export async function gatherDetails(from: { session: SessionInfo } | { task: DetailsTask; listSource: "local" | "account" }): Promise<DetailsInput> {
  if ("task" in from) {
    const kept = keptRuns(from.task);
    try {
      const [latest] = await runsOfTask(from.task.id);
      return { ...from, session: latest ?? null, ...(await kept) };
    } catch {
      return { ...from, ...(await kept) };
    }
  }
  const s = from.session;
  if (s.source === "adhoc" || !s.taskId) return { session: s };
  try {
    const list = await uiRequest({ type: "tasks.list" });
    const task = list.tasks.find((t) => t.id === s.taskId) ?? null;
    return { session: s, task, listSource: list.source ?? "local", ...(task ? await keptRuns(task) : {}) };
  } catch {
    return { session: s };
  }
}

/** Gathers what is known, then opens the sheet. */
export async function showDetails(from: Parameters<typeof gatherDetails>[0], trigger: HTMLElement | null): Promise<void> {
  const input = await gatherDetails(from);
  openDetails(detailsModel(input), trigger);
}
