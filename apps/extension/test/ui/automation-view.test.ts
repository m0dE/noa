import { describe, expect, it } from "vitest";
import { applySettingsPatch } from "../../src/settings-store.js";
import { AUTOMATION_LEVELS, DEFAULT_SETTINGS, parseSettings } from "@noa/shared";
import { automationView, FULL_AUTONOMY_WARNING, needsConfirmation, SCHEDULED_UNDER_FULL_NOTE } from "../../src/options/automation-view.js";
import { SECTIONS } from "../../src/options/settings-view.js";
import { AUTONOMY_WARNING_TEXT } from "../../src/sidepanel/autonomy-warning.js";

describe("Settings > Permission", () => {
  it("defaults: ask before posting, sending or paying; scheduled tasks do what they say", () => {
    expect(DEFAULT_SETTINGS.automationLevel).toBe("ask_consequential");
    expect(DEFAULT_SETTINGS.scheduledAutomation).toBe("full_within_task");
    const v = automationView(DEFAULT_SETTINGS);
    expect(v.levels.map((l) => [l.label, l.checked])).toEqual([
      ["Ask before every action", false],
      ["Ask before posting, sending or paying", true],
      ["Full autonomy (dangerous)", false],
    ]);
    expect(v.scheduled.find((c) => c.checked)?.id).toBe("full_within_task");
    expect(v.warning).toBeNull();
  });

  it("full autonomy: marked dangerous, needs a confirmation to turn on, and warns while on", () => {
    expect(needsConfirmation("full", "ask_consequential")).toBe(true);
    expect(needsConfirmation("full", "full")).toBe(false);
    expect(needsConfirmation("ask_all", "full")).toBe(false);
    const v = automationView({ automationLevel: "full", scheduledAutomation: "full_within_task" });
    expect(v.levels.find((l) => l.checked)).toMatchObject({ id: "full", dangerous: true });
    expect(v.warning).toBe(FULL_AUTONOMY_WARNING);
  });

  it("full autonomy covers scheduled jobs: their choices are greyed out with a note, and apply again when it is off", () => {
    const full = automationView({ automationLevel: "full", scheduledAutomation: "full_within_task" });
    expect(full.scheduled.every((c) => c.disabled)).toBe(true);
    expect(full.scheduledNote).toBe(SCHEDULED_UNDER_FULL_NOTE);
    expect(FULL_AUTONOMY_WARNING).toMatch(/scheduled jobs/);
    expect(AUTOMATION_LEVELS.find((l) => l.id === "full")!.detail).toMatch(/^Never asks, in chats and scheduled jobs\./);
    const off = automationView({ automationLevel: "ask_consequential", scheduledAutomation: "full_within_task" });
    expect(off.scheduled.some((c) => c.disabled)).toBe(false);
    expect(off.scheduledNote).toBeNull();
  });

  it("the side panel's banner is short and names the section and the level as Settings shows them", () => {
    expect(AUTONOMY_WARNING_TEXT).toBe("Permission: Full autonomy");
    expect(AUTONOMY_WARNING_TEXT.startsWith(`${SECTIONS.find((t) => t.id === "permission")!.label}: `)).toBe(true);
    expect(automationView({ automationLevel: "full", scheduledAutomation: "full_within_task" }).levels.find((l) => l.id === "full")!.label).toBe("Full autonomy (dangerous)");
  });

  it("stored values: an unknown level falls back to the default; a patch saves a valid one", () => {
    expect(parseSettings({ automationLevel: "yolo" }).automationLevel).toBe("ask_consequential");
    expect(applySettingsPatch(DEFAULT_SETTINGS, { automationLevel: "ask_all" }).automationLevel).toBe("ask_all");
    expect(applySettingsPatch(DEFAULT_SETTINGS, { scheduledAutomation: "nope" as never }).scheduledAutomation).toBe("full_within_task");
  });
});
