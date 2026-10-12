import { currentAccountApiBase, ExtensionSettings, parseSettings, REDACTED, SECRET_SETTING_KEYS } from "@noa/shared";

/** The periodic due check, every intervalMinutes. */
export const ALARM_NAME = "noa-run";
/** One-shot alarm for the next task that becomes due (notBefore / retryAfter); set by the service worker. */
export const DUE_ALARM = "noa-due";
const SETTINGS_KEY = "settings";
const RUNNER_ID_KEY = "runnerId";

export async function loadSettings(): Promise<ExtensionSettings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return parseSettings(got[SETTINGS_KEY]);
}

/** Settings of the removed runner-key cloud sync; runnerKey is a secret, so they are deleted from storage. */
const REMOVED_SETTING_KEYS = ["cloudEnabled", "apiBase", "runnerKey"];

/**
 * Writes the stored account server back at its current address when it is an
 * earlier default (loadSettings already reads it that way), so storage, the
 * Advanced tab and the session agree, and deletes REMOVED_SETTING_KEYS. Runs
 * at every service worker start: install, update and browser start. True when it wrote.
 */
export async function migrateStoredSettings(): Promise<boolean> {
  const raw: unknown = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return false;
  const next: Record<string, unknown> = { ...raw };
  let changed = false;
  for (const key of REMOVED_SETTING_KEYS) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }
  const stored = next.accountApiBase;
  if (typeof stored === "string" && currentAccountApiBase(stored) !== stored) {
    next.accountApiBase = currentAccountApiBase(stored);
    changed = true;
  }
  if (!changed) return false;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return true;
}

/** Raw partial update (tests and set-up): no secret rules. */
export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  return storeSettings(parseSettings({ ...(await loadSettings()), ...patch }));
}

/**
 * Applies a partial update from the UI. Secret fields: omitted (or the
 * redaction marker REDACTED) keeps the stored value, "" clears it, anything
 * else replaces it. Unknown keys are ignored; invalid values keep the old value.
 */
export function applySettingsPatch(current: ExtensionSettings, patch: Partial<ExtensionSettings>): ExtensionSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in current) || value === undefined) continue;
    if ((SECRET_SETTING_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== "string" || value === REDACTED) continue;
      next[key] = value.trim();
      continue;
    }
    const field = ExtensionSettings.shape[key as keyof ExtensionSettings];
    if (field.safeParse(value).success) next[key] = value;
  }
  return parseSettings(next);
}

/** settings.save from the UI: partial update with the secret rules above. */
export async function saveSettingsPatch(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  return storeSettings(applySettingsPatch(await loadSettings(), patch));
}

async function storeSettings(next: ExtensionSettings): Promise<ExtensionSettings> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Stable random runner ID, created on first use. */
export async function getRunnerId(): Promise<string> {
  const got = await chrome.storage.local.get(RUNNER_ID_KEY);
  const existing = got[RUNNER_ID_KEY];
  if (typeof existing === "string" && existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [RUNNER_ID_KEY]: id });
  return id;
}

async function scheduleAlarm(intervalMinutes: number): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalMinutes, delayInMinutes: intervalMinutes });
}

/** On install and startup: create the alarm unless one with the right period exists. */
export async function ensureAlarm(): Promise<void> {
  const settings = await loadSettings();
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (alarm && alarm.periodInMinutes === settings.intervalMinutes) return;
  await scheduleAlarm(settings.intervalMinutes);
}

/** chrome.storage.onChanged handler: reschedule when the interval changes. */
export async function handleStorageChange(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
): Promise<void> {
  const change = changes[SETTINGS_KEY];
  if (areaName !== "local" || !change) return;
  const before = parseSettings(change.oldValue).intervalMinutes;
  const after = parseSettings(change.newValue).intervalMinutes;
  if (before !== after || change.oldValue === undefined) await scheduleAlarm(after);
}
