/**
 * Settings > Permission: the chat agent's level (Ask before every
 * action / Ask before posting, sending or paying / Full autonomy) and the
 * scheduled tasks' choice. Saves by itself like the rest of the page; turning
 * on full autonomy first asks in a dialog, and while it is on a warning stays
 * under the levels. What shows comes from automation-view.ts.
 */
import { errorMessage, type AutomationLevel, type ExtensionSettings, type ScheduledAutomation } from "@noa/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, flash, h } from "../ui/dom.js";
import { automationView, FULL_AUTONOMY_CONFIRM, needsConfirmation, type AutomationOption } from "./automation-view.js";

export interface AutomationSection {
  render(state: UiState): void;
}

export function initAutomationSection(opts: { onState(state: UiState): void }): AutomationSection {
  const levels = $("automation-levels");
  const scheduled = $("scheduled-automation");
  const scheduledNote = $("scheduled-automation-note");
  const warning = $("automation-warning");
  const msg = $("automation-msg");
  const dialog = $<HTMLDialogElement>("automation-confirm");
  let settings: ExtensionSettings | null = null;

  $("automation-confirm-title").textContent = FULL_AUTONOMY_CONFIRM.title;
  $("automation-confirm-body").replaceChildren(...FULL_AUTONOMY_CONFIRM.body.map((p) => h("p", null, p)));
  const ok = $("automation-confirm-ok");
  const cancel = $("automation-confirm-cancel");
  ok.textContent = FULL_AUTONOMY_CONFIRM.confirm;
  cancel.textContent = FULL_AUTONOMY_CONFIRM.cancel;
  ok.addEventListener("click", () => dialog.close("confirm"));
  cancel.addEventListener("click", () => dialog.close("cancel"));

  async function save(patch: Partial<ExtensionSettings>): Promise<void> {
    try {
      opts.onState(await uiRequest({ type: "settings.save", settings: patch }));
      flash(msg, "");
    } catch (err) {
      flash(msg, `Not saved: ${errorMessage(err)}`, "bad");
      draw();
    }
  }

  /** The confirmation dialog's answer: true when the user confirmed (Keep asking and Esc are no). */
  function confirmFull(): Promise<boolean> {
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.returnValue = "";
      dialog.showModal();
    });
  }

  async function pickLevel(next: AutomationLevel): Promise<void> {
    const current = settings?.automationLevel;
    if (!current || next === current) return;
    if (needsConfirmation(next, current) && !(await confirmFull())) {
      draw();
      return;
    }
    await save({ automationLevel: next });
  }

  function rows<T extends string>(name: string, options: AutomationOption<T>[], onPick: (id: T) => void): HTMLElement[] {
    return options.map((o) => {
      const input = h("input", { type: "radio", name, value: o.id, checked: o.checked, disabled: o.disabled ?? false, onchange: () => onPick(o.id) });
      return h(
        "div.opt",
        { "data-automation": o.id, "data-dangerous": o.dangerous ?? false },
        h("label.opt-head", null, input, h("span.opt-text", null, h("b", null, o.label), h("small.opt-detail", null, o.detail))),
      );
    });
  }

  function draw(): void {
    if (!settings) return;
    const v = automationView(settings);
    levels.replaceChildren(...rows("automationLevel", v.levels, (id) => void pickLevel(id)));
    scheduled.replaceChildren(...rows<ScheduledAutomation>("scheduledAutomation", v.scheduled, (id) => void save({ scheduledAutomation: id })));
    warning.hidden = !v.warning;
    warning.textContent = v.warning ?? "";
    scheduledNote.hidden = !v.scheduledNote;
    scheduledNote.textContent = v.scheduledNote ?? "";
  }

  return {
    render(state) {
      const s = state.settings;
      // Redrawn only when these settings change: a redraw would drop the focus of a radio being used.
      if (settings && s.automationLevel === settings.automationLevel && s.scheduledAutomation === settings.scheduledAutomation) {
        settings = s;
        return;
      }
      settings = s;
      draw();
    },
  };
}
