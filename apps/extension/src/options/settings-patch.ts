/** Pure helpers for the options page: building settings.save patches and status text. */
import { HELPER_INSTALL_PS1_URL, HELPER_INSTALL_URL, SECRET_SETTING_KEYS, type ExtensionSettings, type HelperInfo } from "@noa/shared";
import { HELPER_CODE } from "../build-config.js";
import { HELPER_NOT_INSTALLED } from "../helper-link.js";

/** Why the helper is needed at all: people sign in to Claude Code and expect that to be enough. */
export const HELPER_WHY = "Signing in to Claude Code is not enough: Chrome reaches it only through this helper.";

/**
 * The Terminal command that installs the helper for this extension (macOS, Linux): the installer
 * downloads the helper itself, so it needs no checkout of the repo.
 */
export function helperInstallCommand(extensionId: string): string {
  return `curl -fsSL ${HELPER_INSTALL_URL} | sh -s -- --extension-id ${extensionId}`;
}

/** The PowerShell command that does the same on Windows (install.ps1 takes the id from NOA_EXTENSION_ID). */
export function helperInstallCommandWindows(extensionId: string): string {
  return `$env:NOA_EXTENSION_ID="${extensionId}"; irm ${HELPER_INSTALL_PS1_URL} | iex`;
}

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

/**
 * Why the connected helper is out of date, with how to update it for the way it is installed; null when it runs the
 * code this extension was built for (`expected`, build-config.ts). A helper from before code ids reports none: it is
 * out of date too. Fixes in clicks, Jev and the tools run in the helper with Local Claude Code, so an old one
 * keeps the old behaviour whatever the extension's version.
 */
export function helperOutdated(helper: HelperInfo, expected: string): string | null {
  if (helper.brain === "scripted" || expected === "dev" || helper.code === "dev" || helper.code === expected) return null;
  const how =
    helper.install === "checkout"
      ? "In your Noa checkout, pull and run pnpm build, then click Re-check."
      : helper.install === "noa-folder"
        ? "To update it, run the install command below again, then click Re-check."
        : helper.install === "app"
          ? "Update Noa Browser."
          : "To update it, run the install command below again (or, in a copy of the Noa repository, pull and run pnpm build), then click Re-check.";
  return `Helper out of date: it is an older version than this extension, so recent fixes are missing. ${how}`;
}

/** An out-of-date helper that the install command updates (installed by it, or from before install kinds were reported). */
export function helperNeedsInstall(helper: HelperInfo, expected: string = HELPER_CODE): boolean {
  return helperOutdated(helper, expected) !== null && helper.install !== "checkout" && helper.install !== "app";
}

export function helperStatus(helper: HelperInfo | null, helperError?: string, expectedCode: string = HELPER_CODE): HelperStatus {
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
  const outdated = helperOutdated(helper, expectedCode);
  if (outdated) details.unshift(outdated);
  const tone = (!scripted && !helper.claudePath) || (st && !st.ok) || outdated ? "warn" : "ok";
  return { tone, headline: `Helper connected · v${helper.version}${outdated ? " · out of date" : ""}`, details };
}
