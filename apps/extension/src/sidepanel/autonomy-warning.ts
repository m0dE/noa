/**
 * The side panel's warning while the chat agent has full autonomy (Settings >
 * Permission): one short line under the status, "Permission: Full autonomy
 * (change)", with ✕ at the far right. Its tooltip says what the level lets the
 * agent do. Closing it sets autonomyWarningClosed, which is cleared once full
 * autonomy is off, so turning it on again shows the warning again. Nothing
 * shows at the other levels.
 */
import { AUTOMATION_LEVELS, FULL_AUTONOMY_NAME, PERMISSION_TITLE, type AutomationLevel, type ExtensionSettings } from "@noa/shared";
import { $ } from "../ui/dom.js";
import { openSettings } from "./open-settings.js";

export const AUTONOMY_WARNING_TEXT = `${PERMISSION_TITLE}: ${FULL_AUTONOMY_NAME}`;

/** Whether the warning shows, and whether the closed mark should be cleared (full autonomy is off). */
export function autonomyWarningState(level: AutomationLevel, closed: boolean): { show: boolean; clearClosed: boolean } {
  if (level !== "full") return { show: false, clearClosed: closed };
  return { show: !closed, clearClosed: false };
}

type WarningSettings = Pick<ExtensionSettings, "automationLevel" | "autonomyWarningClosed">;

export function initAutonomyWarning(save: (patch: Partial<ExtensionSettings>) => unknown): { render(settings: WarningSettings): void } {
  const el = $("autonomy-warning");
  $("autonomy-warning-text").textContent = AUTONOMY_WARNING_TEXT;
  el.title = AUTOMATION_LEVELS.find((l) => l.id === "full")?.detail ?? "";
  $("autonomy-warning-change").addEventListener("click", () => void openSettings("permission"));
  $("autonomy-warning-close").addEventListener("click", () => {
    el.hidden = true;
    void save({ autonomyWarningClosed: true });
  });
  return {
    render(settings) {
      const { show, clearClosed } = autonomyWarningState(settings.automationLevel, settings.autonomyWarningClosed);
      el.hidden = !show;
      if (clearClosed) void save({ autonomyWarningClosed: false });
    },
  };
}
