import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, redactSettings, type ExtensionSettings } from "@noa/shared";
import { adjustedFields, buildSettingsPatch, HELPER_WHY, helperCheckCommand, helperDiagnostics, helperInstallCommand, helperInstallCommandWindows, helperNeedsInstall, helperOutdated, helperStatus, localSetupCommand } from "../../src/options/settings-patch.js";

const saved: ExtensionSettings = redactSettings({ ...DEFAULT_SETTINGS, anthropicApiKey: "sk-real" });

describe("buildSettingsPatch", () => {
  it("is empty when nothing changed", () => {
    const { anthropicApiKey: _a, jevApiKey: _j, ...form } = saved;
    expect(buildSettingsPatch(saved, form)).toEqual({});
  });
  it("includes only changed plain fields", () => {
    expect(buildSettingsPatch(saved, { brain: "claude-api", intervalMinutes: 15, jevEnabled: false })).toEqual({
      brain: "claude-api",
      jevEnabled: false,
    });
  });
  it("skips undefined (blank number inputs)", () => {
    expect(buildSettingsPatch(saved, { maxToolCalls: undefined })).toEqual({});
  });
  it("never leaks redacted markers from the form", () => {
    const form = { anthropicApiKey: "set" } as unknown as Partial<ExtensionSettings>;
    expect(buildSettingsPatch({ ...saved, anthropicApiKey: "" }, form)).toEqual({});
  });
});

it("adjustedFields reports values the background clamped", () => {
  const after = { ...saved, delayMaxSec: 60, maxToolCalls: 500, anthropicApiKey: "set" };
  expect(adjustedFields({ delayMaxSec: 10, maxToolCalls: 500, anthropicApiKey: "sk-new" }, after)).toEqual(["delayMaxSec"]);
});

describe("helperStatus", () => {
  const info = { version: "0.2.0", jevAvailable: false, claudePath: "C:\\claude.exe", logDir: "x", ptyAvailable: true };
  it("not connected", () => {
    expect(helperStatus(null)).toMatchObject({ tone: "muted", headline: "Helper not connected" });
    expect(helperStatus(null).details).toEqual([HELPER_WHY]);
    expect(helperStatus(null, "Helper not installed")).toEqual({ tone: "bad", headline: "Helper not installed", details: [HELPER_WHY] });
    expect(helperStatus(null, "Helper crashed")).toEqual({
      tone: "bad",
      headline: "Helper crashed",
      details: ["Chrome started the helper, but it stopped before answering. Run the command below again, then click Connect."],
    });
    expect(helperStatus(null, "Helper installed for another extension ID").details).toEqual([]);
  });
  it("connected with a passing self-test", () => {
    const s = helperStatus({ ...info, selfTest: { ok: true, ms: 4200, at: "t" } });
    expect(s.tone).toBe("ok");
    expect(s.headline).toBe("Helper connected");
    expect(s.details).toEqual(["Claude Code: C:\\claude.exe", "Self-test passed (4.2 s)"]);
  });
  it("a scripted helper needs no Claude Code", () => {
    const s = helperStatus({ ...info, brain: "scripted", claudePath: null });
    expect(s.tone).toBe("ok");
    expect(s.details).toEqual(["Runs tasks with the scripted brain (no Claude Code)"]);
  });
  it("warns on missing claude or a failed self-test", () => {
    const missing = helperStatus({ ...info, claudePath: null, selfTest: { ok: false, error: "Claude Code was not found.", ms: 0, at: "t" } });
    expect(missing).toMatchObject({ tone: "warn", claudeMissing: true, details: [] });
    expect(helperStatus(info).claudeMissing).toBeUndefined();
    const failed = helperStatus({ ...info, selfTest: { ok: false, error: "not logged in", ms: 1, at: "t" } });
    expect(failed.tone).toBe("warn");
    expect(failed.details).toContain("Self-test failed: not logged in");
  });
});

describe("helperInstallCommand", () => {
  it("pipes the site's installer into sh with this extension's id", () => {
    expect(helperInstallCommand("abcdefghijklmnopabcdefghijklmnop")).toBe(
      "curl -fsSL https://noa.bot/helper/install.sh | sh -s -- --extension-id abcdefghijklmnopabcdefghijklmnop",
    );
  });
  // The site's current helper changes with every deploy; reinstalling it left an extension built from other code
  // saying "Helper out of date" however often the user ran the command.
  it("asks for the helper code this extension was built with", () => {
    expect(helperInstallCommand("abcdefghijklmnopabcdefghijklmnop", "baab02a9cf9d")).toBe(
      "curl -fsSL https://noa.bot/helper/baab02a9cf9d/install.sh | sh -s -- --extension-id abcdefghijklmnopabcdefghijklmnop",
    );
    expect(helperInstallCommandWindows("abcdefghijklmnopabcdefghijklmnop", "baab02a9cf9d")).toBe(
      '$env:NOA_EXTENSION_ID="abcdefghijklmnopabcdefghijklmnop"; irm https://noa.bot/helper/baab02a9cf9d/install.ps1 | iex',
    );
  });
});

describe("localSetupCommand", () => {
  it("one npx command for this extension and the helper code it was built with (none from a dev build)", () => {
    expect(localSetupCommand("abcdefghijklmnopabcdefghijklmnop", "baab02a9cf9d")).toBe("npx -y noa-local-llm --extension-id abcdefghijklmnopabcdefghijklmnop --helper-code baab02a9cf9d");
    expect(localSetupCommand("abcdefghijklmnopabcdefghijklmnop", "dev")).toBe("npx -y noa-local-llm --extension-id abcdefghijklmnopabcdefghijklmnop");
  });
});

// An extension paired with an older helper keeps the old behaviour of clicks and tools; the helper's version string
// never changed, so nothing showed it was out of date.
describe("helperOutdated: a helper built from other code than this extension", () => {
  const h = { version: "0.2.0", jevAvailable: true, claudePath: "C:\\claude.exe", logDir: "L" };
  it("is out of date with another code id, or none (built before code ids); says how to update it for its install", () => {
    expect(helperOutdated({ ...h, code: "aaa", install: "checkout" }, "aaa")).toBeNull();
    expect(helperOutdated({ ...h, code: "aaa", install: "checkout" }, "bbb")).toBe("It is older than this extension, so recent fixes are missing. In your Noa checkout, pull and run pnpm build, then click Re-check.");
    expect(helperOutdated({ ...h, code: "aaa", install: "noa-folder" }, "bbb")).toBe("It is older than this extension, so recent fixes are missing. Run the command below to update it, then click Re-check.");
    expect(helperOutdated({ ...h, code: "aaa", install: "app" }, "bbb")).toMatch(/Update Noa Browser\.$/);
    expect(helperOutdated(h, "bbb")).toBe("It is older than this extension, so recent fixes are missing. Run the command below to update it, then click Re-check.");
  });
  it("never for a build without ids (tests, the harness), a helper run from source, or the scripted brain", () => {
    expect(helperOutdated(h, "dev")).toBeNull();
    expect(helperOutdated({ ...h, code: "dev" }, "bbb")).toBeNull();
    expect(helperOutdated({ ...h, brain: "scripted" }, "bbb")).toBeNull();
  });
  it("the settings page warns, first thing under the headline", () => {
    const s = helperStatus({ ...h, code: "aaa", install: "checkout", selfTest: { ok: true, ms: 900, at: "x" } }, undefined, "bbb");
    expect(s.tone).toBe("warn");
    expect(s.headline).toBe("Helper connected · out of date");
    expect(s.details[0]).toMatch(/^It is older than this extension/);
    expect(helperStatus({ ...h, code: "bbb", selfTest: { ok: true, ms: 900, at: "x" } }, undefined, "bbb").tone).toBe("ok");
  });
});

describe("installing the helper on Windows", () => {
  // Windows had no installer: first-time users were told to build the helper from the repository.
  it("is one PowerShell command, with the extension's id", () => {
    expect(helperInstallCommandWindows("abcdefghijklmnopabcdefghijklmnop")).toBe('$env:NOA_EXTENSION_ID="abcdefghijklmnopabcdefghijklmnop"; irm https://noa.bot/helper/install.ps1 | iex');
  });
  it("the install steps show again for an out-of-date helper the command installed (not one from a checkout or an app)", () => {
    const h = { version: "0.2.0", jevAvailable: true, claudePath: "C", logDir: "L" };
    expect(helperNeedsInstall({ ...h, code: "aaa", install: "noa-folder" }, "bbb")).toBe(true);
    expect(helperNeedsInstall(h, "bbb")).toBe(true);
    expect(helperNeedsInstall({ ...h, code: "aaa", install: "checkout" }, "bbb")).toBe(false);
    expect(helperNeedsInstall({ ...h, code: "aaa", install: "app" }, "bbb")).toBe(false);
    expect(helperNeedsInstall({ ...h, code: "bbb", install: "noa-folder" }, "bbb")).toBe(false);
  });
});

describe("helper diagnostics", () => {
  it("has our words, Chrome's, the versions and the command that shows why on the computer", () => {
    const text = helperDiagnostics({
      error: "Helper crashed",
      chromeError: "Error when communicating with the native messaging host.",
      extensionVersion: "0.4.0",
      extensionId: "enpgjinoecjfmomfkpjokgcledffmink",
      expectedCode: "c0e6c5fa1835",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      at: new Date("2026-10-21T06:00:00Z"),
      os: "windows",
    });
    expect(text.split("\n").slice(0, 5)).toEqual([
      "Helper: Helper crashed",
      "Chrome said: Error when communicating with the native messaging host.",
      "Extension: v0.4.0 (enpgjinoecjfmomfkpjokgcledffmink), helper code c0e6c5fa1835",
      "Browser: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Time: 2026-10-21T06:00:00.000Z",
    ]);
    expect(text).toContain("run this in PowerShell");
    expect(text.endsWith(helperCheckCommand("windows"))).toBe(true);
    expect(helperDiagnostics({ error: "Helper exited", extensionVersion: "1", extensionId: "x", userAgent: "u", at: new Date(0), os: "mac" })).toContain(
      "Chrome said: (nothing)",
    );
  });

  it("the check command starts the launcher with --check and empty stdin, then shows it and the log", () => {
    expect(helperCheckCommand("windows")).toContain('$null | & "$n\\host\\noa-host.cmd" --check');
    expect(helperCheckCommand("mac")).toContain('n="$HOME/Library/Application Support/noa"');
    expect(helperCheckCommand("linux")).toContain('"$n/host/noa-host.sh" --check </dev/null');
  });
});
