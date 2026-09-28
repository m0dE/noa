/**
 * A task's instructions on its job's page, and the way to change them: the first lines (Show all for the rest), Edit
 * (the text becomes a box: Save or Cancel, Ctrl+Enter or Escape); its schedule is changed from the page's "⋯". Saving changes the task's
 * waiting row (the next run is given the new words; its series and memory stay), as the user's own words: a task the
 * agent wrote is the user's once they edit it (the patch says so).
 *
 * A task only waiting (pending or paused) can be changed; while a run goes on, Edit says to wait for it to end. A task
 * that never ran shows its request as the page's opening bubble instead of the text (`intro`).
 */
import { errorMessage, MAX_INSTRUCTIONS_CHARS } from "@noa/shared";
import { flash, h } from "../ui/dom.js";
import type { JobTask } from "./jobs.js";

/** Longer than this (or more lines than INSTRUCTIONS_LINES) shows cut, with Show all. */
const SHORT_CHARS = 180;
const INSTRUCTIONS_LINES = 3;

export interface InstructionsDeps {
  /** Saves the task's new instructions (then the page shows them). */
  save(task: JobTask, instructions: string): Promise<void>;
}

export interface InstructionsState {
  task: JobTask;
  /** Shown in place of the text: a task that never ran has its request as the page's opening bubble. */
  intro?: HTMLElement;
}

export interface InstructionsView {
  readonly el: HTMLElement;
  /** The task as it is now (the box, while open, is left as typed). */
  update(state: InstructionsState): void;
  /** Another job: the box closes, the text shows cut. */
  reset(): void;
}

/** Whether a task's instructions can be edited now: "yes", "later" (a run goes on), or "no" (nothing will run). */
export function editable(task: Pick<JobTask, "status">): "yes" | "later" | "no" {
  if (task.status === "pending" || task.status === "paused") return "yes";
  return task.status === "running" ? "later" : "no";
}

/** Why a new text cannot be saved ("" when it can). */
export function instructionsProblem(text: string): string {
  const t = text.trim();
  if (!t) return "Write what the job should do.";
  if (t.length > MAX_INSTRUCTIONS_CHARS) return `At most ${MAX_INSTRUCTIONS_CHARS.toLocaleString()} characters (now ${t.length.toLocaleString()}).`;
  return "";
}

const isLong = (text: string) => text.length > SHORT_CHARS || text.split(/\r?\n/).length > INSTRUCTIONS_LINES;

export function initInstructions(deps: InstructionsDeps): InstructionsView {
  const el = h("section.job-instr", { "aria-labelledby": "job-instr-head" });
  let state: InstructionsState | null = null;
  let editing = false;
  let expanded = false;
  let saving = false;
  /** What the block was drawn from. */
  let drawnSig = "";
  const saved = h("span.msg.job-instr-saved", { role: "status" });

  function actions(): HTMLElement {
    const s = state!;
    const can = editable(s.task);
    const out = h("div.job-instr-actions");
    if (can !== "no") {
      const edit = h(
        "button.small.ghost.job-instr-edit",
        can === "later" ? { type: "button", "aria-disabled": "true", title: "You can edit the instructions once this run ends" } : { type: "button", title: "Change what the next runs do" },
        "Edit",
      );
      edit.setAttribute("aria-label", "Edit instructions");
      edit.addEventListener("click", () => can === "yes" && startEdit());
      out.append(edit);
    }
    out.append(saved);
    return out;
  }

  function textView(text: string): HTMLElement[] {
    const long = isLong(text);
    const body = h("p.job-instr-text", { id: "job-instr-text", "data-cut": String(long && !expanded) }, text);
    if (!long) return [body];
    const more = h("button.link.job-instr-more", { type: "button", "aria-expanded": String(expanded), "aria-controls": "job-instr-text" }, expanded ? "Show less" : "Show all");
    more.addEventListener("click", () => {
      expanded = !expanded;
      draw();
      el.querySelector<HTMLElement>(".job-instr-more")?.focus();
    });
    return [body, more];
  }

  function editor(): HTMLElement {
    const box = h("textarea.job-instr-box", { "aria-label": "Instructions", "aria-describedby": "job-instr-msg", maxlength: MAX_INSTRUCTIONS_CHARS, spellcheck: "true", rows: 3 });
    box.value = state!.task.instructions;
    const msg = h("p.msg.job-instr-msg", { id: "job-instr-msg", role: "alert" });
    const save = h("button.small.primary", { type: "button" }, "Save");
    const cancel = h("button.small.ghost", { type: "button" }, "Cancel");
    const grow = () => {
      box.style.height = "auto";
      box.style.height = `${box.scrollHeight + 2}px`;
    };
    box.addEventListener("input", () => {
      grow();
      if (msg.textContent) flash(msg, "");
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stopEdit();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit();
      }
    });
    save.addEventListener("click", () => void submit());
    cancel.addEventListener("click", () => stopEdit());

    async function submit(): Promise<void> {
      if (saving) return;
      const text = box.value.trim();
      const problem = instructionsProblem(text);
      if (problem) return flash(msg, problem, "bad");
      if (text === state!.task.instructions.trim()) return stopEdit();
      saving = true;
      save.disabled = true;
      flash(msg, "Saving…");
      try {
        await deps.save(state!.task, text);
        saving = false;
        stopEdit();
        flash(saved, "Saved. The next run uses them.", "ok");
      } catch (err) {
        saving = false;
        save.disabled = false;
        flash(msg, `Couldn't save: ${errorMessage(err)}`, "bad");
      }
    }
    requestAnimationFrame(grow);
    return h("div.job-instr-editor", null, box, h("div.job-instr-editor-row", null, msg, cancel, save));
  }

  function startEdit(): void {
    editing = true;
    flash(saved, "");
    draw();
    const box = el.querySelector<HTMLTextAreaElement>(".job-instr-box");
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }

  function stopEdit(): void {
    editing = false;
    draw();
    el.querySelector<HTMLElement>(".job-instr-edit")?.focus();
  }

  function draw(): void {
    if (!state) return el.replaceChildren();
    const head = h("div.job-instr-head", null, h("h2.job-instr-title", { id: "job-instr-head" }, "Instructions"), editing ? null : actions());
    const body = editing ? [editor()] : state.intro ? [state.intro] : textView(state.task.instructions);
    el.classList.toggle("intro", !editing && !!state.intro);
    el.replaceChildren(head, ...body);
  }

  return {
    el,
    update(next) {
      const was = state;
      state = next;
      // The box keeps what is typed; the rest follows the task (drawn again only when that changes, so the focus stays).
      if (editing && was?.task.id === next.task.id && editable(next.task) === "yes") return;
      const sig = JSON.stringify([next.task.id, next.task.instructions, editable(next.task), !!next.intro]);
      if (!editing && sig === drawnSig) return;
      drawnSig = sig;
      editing = false;
      draw();
    },
    reset() {
      drawnSig = "";
      state = null;
      editing = false;
      expanded = false;
      saving = false;
      flash(saved, "");
      el.replaceChildren();
    },
  };
}
