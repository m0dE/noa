/** Pure helpers for the options page: building settings.save patches and status text. */
import { helperInstallUrl, LOCAL_SETUP_COMMAND, SECRET_SETTING_KEYS, type ExtensionSettings, type HelperInfo } from "@noa/shared";
import { HELPER_CODE } from "../build-config.js";
import { HELPER_NOT_INSTALLED } from "../helper-link.js";

/** Why the helper is needed at all: people sign in to Claude Code and expect that to be enough. */
export const HELPER_WHY = "Signing in to Claude Code is not enough: Chrome reaches it only through this helper.";

/**
 * The Terminal command that installs the helper for this extension (macOS, Linux): the installer
 * downloads the helper itself, so it needs no checkout of the repo. It is the installer of the helper code this
 * extension was built with, so what it installs is never out of date for it.
 */
export function helperInstallCommand(extensionId: string, code: string = HELPER_CODE): string {
  return `curl -fsSL ${helperInstallUrl("sh", code)} | sh -s -- --extension-id ${extensionId}`;
}

/** The PowerShell command that does the same on Windows (install.ps1 takes the id from NOA_EXTENSION_ID). */
export function helperInstallCommandWindows(extensionId: string, code: string = HELPER_CODE): string {
  return `$env:NOA_EXTENSION_ID="${extensionId}"; irm ${helperInstallUrl("ps1", code)} | iex`;
}

/**
 * The command that sets up the Local model (packages/local-llm): the helper for this extension, from the installer of
 * the helper code it was built with (as helperInstallCommand), then Ollama, a model and OpenCode.
 */
export function localSetupCommand(extensionId: string, code: string = HELPER_CODE): string {
  return `${LOCAL_SETUP_COMMAND} --extension-id ${extensionId}${/^[0-9a-f]{12}$/.test(code) ? ` --helper-code ${code}` : ""}`;
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
  /** Connected, but the helper found no Claude Code: the page says so, with where to get it. */
  claudeMissing?: boolean;
}

/** Chrome started the helper, but it stopped before answering. */
const HELPER_STOPPED = /^helper (crashed|exited)$/i;

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
      : helper.install === "app"
        ? "Update Noa Browser."
        : "Run the command below to update it, then click Re-check.";
  return `It is older than this extension, so recent fixes are missing. ${how}`;
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
      details:
        !helperError || helperError === HELPER_NOT_INSTALLED
          ? [HELPER_WHY]
          : HELPER_STOPPED.test(helperError)
            ? ["Chrome started the helper, but it stopped before answering. Run the command below again, then click Connect."]
            : [],
    };
  }
  // A scripted helper (tests) runs tasks without Claude Code, so it never has one.
  const scripted = helper.brain === "scripted";
  const claudeMissing = !scripted && !helper.claudePath;
  const details: string[] = [];
  if (scripted) details.push("Runs tasks with the scripted brain (no Claude Code)");
  else if (helper.claudePath) details.push(`Claude Code: ${helper.claudePath}`);
  const st = helper.selfTest;
  // Without Claude Code the self-test only says it was not found: claudeMissing says that, with where to get it.
  if (claudeMissing) {
    /* the page's note */
  } else if (st) details.push(st.ok ? `Self-test passed (${(st.ms / 1000).toFixed(1)} s)` : `Self-test failed: ${st.error ?? "unknown error"}`);
  else if (!scripted) details.push("Self-test not run yet");
  const outdated = helperOutdated(helper, expectedCode);
  if (outdated) details.unshift(outdated);
  const tone = claudeMissing || (st && !st.ok) || outdated ? "warn" : "ok";
  return { tone, headline: outdated ? "Helper connected · out of date" : "Helper connected", details, ...(claudeMissing ? { claudeMissing } : {}) };
}

/**
 * The command that starts the helper the way Chrome does and prints what it says (`host.js --check`), then the
 * launcher and the end of the helper's log. stdin is empty, so a helper from before --check ends instead of waiting.
 */
export function helperCheckCommand(os: "windows" | "mac" | "linux"): string {
  if (os === "windows") {
    return '$n="$env:LOCALAPPDATA\\noa"; $null | & "$n\\host\\noa-host.cmd" --check; "exit code: $LASTEXITCODE"; Get-Content "$n\\host\\noa-host.cmd"; Get-Content "$n\\logs\\live.log" -Tail 30';
  }
  const n = os === "mac" ? '"$HOME/Library/Application Support/noa"' : '"${XDG_DATA_HOME:-$HOME/.local/share}/noa"';
  return `n=${n}; "$n/host/noa-host.sh" --check </dev/null; echo "exit code: $?"; cat "$n/host/noa-host.sh"; tail -n 30 "$n/logs/live.log"`;
}

/** What a developer needs to see why the helper does not connect: our words, Chrome's, the versions, and the check. */
export function helperDiagnostics(o: {
  error: string;
  chromeError?: string | null;
  extensionVersion: string;
  extensionId: string;
  expectedCode?: string;
  userAgent: string;
  at: Date;
  os: "windows" | "mac" | "linux";
}): string {
  return [
    `Helper: ${o.error}`,
    `Chrome said: ${o.chromeError || "(nothing)"}`,
    `Extension: v${o.extensionVersion} (${o.extensionId}), helper code ${o.expectedCode ?? HELPER_CODE}`,
    `Browser: ${o.userAgent}`,
    `Time: ${o.at.toISOString()}`,
    "",
    `To see why on this computer, run this in ${o.os === "windows" ? "PowerShell" : "Terminal"} and send what it prints too:`,
    helperCheckCommand(o.os),
  ].join("\n");
}
