import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, redactSettings, type ExtensionSettings } from "@noa/shared";
import { adjustedFields, buildSettingsPatch, HELPER_WHY, helperStatus } from "../../src/options/settings-patch.js";

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
    expect(helperStatus(null, "Helper exited")).toEqual({ tone: "bad", headline: "Helper exited", details: [] });
  });
  it("connected with a passing self-test", () => {
    const s = helperStatus({ ...info, selfTest: { ok: true, ms: 4200, at: "t" } });
    expect(s.tone).toBe("ok");
    expect(s.headline).toBe("Helper connected · v0.2.0");
    expect(s.details).toEqual(["Claude Code: C:\\claude.exe", "Self-test passed (4.2 s)"]);
  });
  it("a scripted helper needs no Claude Code", () => {
    const s = helperStatus({ ...info, brain: "scripted", claudePath: null });
    expect(s.tone).toBe("ok");
    expect(s.details).toEqual(["Runs tasks with the scripted brain (no Claude Code)"]);
  });
  it("warns on missing claude or a failed self-test", () => {
    expect(helperStatus({ ...info, claudePath: null }).tone).toBe("warn");
    const failed = helperStatus({ ...info, selfTest: { ok: false, error: "not logged in", ms: 1, at: "t" } });
    expect(failed.tone).toBe("warn");
    expect(failed.details).toContain("Self-test failed: not logged in");
  });
});
