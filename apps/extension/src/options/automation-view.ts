/**
 * Settings > Permission, as data: the chat levels and the scheduled-task
 * choice (from automation.ts, so the words are the same everywhere), which
 * is checked, whether full autonomy is on (a warning that stays, and the
 * scheduled choice greyed out: full autonomy covers scheduled jobs), and when a
 * change needs the user to confirm it. The page (automation-section.ts)
 * only renders this. Pure.
 */
import {
  AUTOMATION_LEVELS,
  SCHEDULED_AUTOMATION_CHOICES,
  type AutomationChoice,
  type AutomationLevel,
  type ExtensionSettings,
  type ScheduledAutomation,
} from "@noa/shared";

export interface AutomationOption<T extends string> extends AutomationChoice<T> {
  checked: boolean;
  /** Shown but not in effect (the scheduled choices while full autonomy is on): greyed out, not pickable. */
  disabled?: true;
}

export interface AutomationView {
  levels: AutomationOption<AutomationLevel>[];
  scheduled: AutomationOption<ScheduledAutomation>[];
  /** Shown under the levels while full autonomy is on; null otherwise. */
  warning: string | null;
  /** Shown above the scheduled choices while full autonomy is on (they do not apply then); null otherwise. */
  scheduledNote: string | null;
}

export const FULL_AUTONOMY_WARNING =
  "Full autonomy is on: the agent posts, sends, pays and deletes without asking you, in chats and scheduled jobs. A page that tricks it can make it do so too.";

/** Why the scheduled choices are greyed out: full autonomy never asks, scheduled jobs included (effectiveLevel). */
export const SCHEDULED_UNDER_FULL_NOTE = "Full autonomy is on, so scheduled jobs never ask either. These choices apply when Full autonomy is off.";

export function automationView(s: Pick<ExtensionSettings, "automationLevel" | "scheduledAutomation">): AutomationView {
  return {
    levels: AUTOMATION_LEVELS.map((l) => ({ ...l, checked: l.id === s.automationLevel })),
    scheduled: SCHEDULED_AUTOMATION_CHOICES.map((c) => ({ ...c, checked: c.id === s.scheduledAutomation, ...(s.automationLevel === "full" ? { disabled: true as const } : {}) })),
    warning: s.automationLevel === "full" ? FULL_AUTONOMY_WARNING : null,
    scheduledNote: s.automationLevel === "full" ? SCHEDULED_UNDER_FULL_NOTE : null,
  };
}

/** Turning on a level that never asks needs a confirmation (the dialog below); every other change saves at once. */
export function needsConfirmation(next: AutomationLevel, current: AutomationLevel): boolean {
  return next !== current && AUTOMATION_LEVELS.some((l) => l.id === next && l.dangerous);
}

export const FULL_AUTONOMY_CONFIRM = {
  title: "Turn on full autonomy?",
  body: [
    "The agent will post, send messages, pay, delete and submit forms without asking you first, in chats and scheduled jobs (jobs the agent scheduled too).",
    "A web page can contain instructions that trick an AI agent. With full autonomy nothing stops a tricked agent before it acts.",
  ],
  confirm: "Turn on full autonomy",
  cancel: "Keep asking",
} as const;
