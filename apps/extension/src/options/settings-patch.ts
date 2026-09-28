/** Pure helpers for the options page: building settings.save patches and status text. */
import { SECRET_SETTING_KEYS, type ExtensionSettings, type HelperInfo } from "@noa/shared";
import { HELPER_NOT_INSTALLED } from "../helper-link.js";

/** Why the helper is needed at all: people sign in to Claude Code and expect that to be enough. */
export const HELPER_WHY = "Signing in to Claude Code is not enough: Chrome reaches it only through this helper.";

/** A key field: masked, saved one by one with its own buttons (secret-field.ts). */
export type SecretKey = (typeof SECRET_SETTING_KEYS)[number];

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * Only the form fields that differ from the saved settings. Keys never go
 * through here: they save with their own buttons (secret-field.ts).
 */
export function buildSettingsPatch(saved: ExtensionSettings, form: Partial<Omit<ExtensionSettings, SecretKey>>): Partial<ExtensionSettings> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || isSecretKey(key)) continue;
    if (value !== saved[key as keyof ExtensionSettings]) patch[key] = value;
  }
  return patch as Partial<ExtensionSettings>;
}

/** Non-secret fields whose saved value differs from what was sent (clamped or rejected). */
export function adjustedFields(patch: Partial<ExtensionSettings>, saved: ExtensionSettings): (keyof ExtensionSettings)[] {
  return (Object.keys(patch) as (keyof ExtensionSettings)[]).filter(
    (k) => !isSecretKey(k) && patch[k] !== saved[k],
  );
}

export interface HelperStatus {
  tone: "ok" | "warn" | "bad" | "muted";
  headline: string;
  details: string[];
}

export function helperStatus(helper: HelperInfo | null, helperError?: string): HelperStatus {
  if (!helper) {
    return {
      tone: helperError ? "bad" : "muted",
      headline: helperError || "Helper not connected",
      details: !helperError || helperError === HELPER_NOT_INSTALLED ? [HELPER_WHY] : [],
    };
  }
  // A scripted helper (tests) runs tasks without Claude Code, so it never has one.
  const scripted = helper.brain === "scripted";
  const details: string[] = [];
  details.push(scripted ? "Runs tasks with the scripted brain (no Claude Code)" : helper.claudePath ? `Claude Code: ${helper.claudePath}` : "Claude Code not found on this computer");
  const st = helper.selfTest;
  if (st) details.push(st.ok ? `Self-test passed (${(st.ms / 1000).toFixed(1)} s)` : `Self-test failed: ${st.error ?? "unknown error"}`);
  else if (helper.claudePath) details.push("Self-test not run yet");
  const tone = (!scripted && !helper.claudePath) || (st && !st.ok) ? "warn" : "ok";
  return { tone, headline: `Helper connected · v${helper.version}`, details };
}
