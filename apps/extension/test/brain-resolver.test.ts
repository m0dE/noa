import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type BrainMode, type HelperInfo } from "@noa/shared";
import { autoSwitchRefusal, builtInJev, CLAUDE_CODE_GONE, needsHelper, resolveBrain } from "../src/engine/brain-resolver.js";

const base: HelperInfo = { version: "2", jevAvailable: false, claudePath: "C:\\claude.exe", logDir: "L" };
const ok: HelperInfo = { ...base, selfTest: { ok: true, ms: 900, at: "2026-09-24T00:00:00Z" } };
const failed: HelperInfo = { ...base, selfTest: { ok: false, error: "not logged in", ms: 900, at: "2026-09-24T00:00:00Z" } };
const noClaude: HelperInfo = { ...base, claudePath: null };
const notTested: HelperInfo = { ...base };
const scripted: HelperInfo = { ...base, brain: "scripted", claudePath: null };

function r(mode: BrainMode, helper: HelperInfo | null, key: boolean, extra: Partial<typeof DEFAULT_SETTINGS> = {}) {
  return resolveBrain({ settings: { ...DEFAULT_SETTINGS, brain: mode, anthropicApiKey: key ? "sk" : "", ...extra }, helper, helperError: helper ? null : "Helper not installed" });
}

describe("resolveBrain", () => {
  it.each([
    // mode, helper, api key, expected
    ["auto", ok, false, "claude-code"],
    ["auto", ok, true, "claude-code"],
    ["auto", scripted, false, "claude-code"],
    ["auto", failed, true, "claude-api"],
    ["auto", noClaude, true, "claude-api"],
    ["auto", notTested, true, "claude-api"],
    ["auto", null, true, "claude-api"],
    ["auto", null, false, null],
    ["auto", failed, false, null],
    ["claude-code", ok, false, "claude-code"],
    ["claude-code", failed, true, null],
    ["claude-code", null, true, null],
    ["claude-api", ok, true, "claude-api"],
    ["claude-api", ok, false, null],
  ] as const)("%s with helper %# -> %s", (mode, helper, key, expected) => {
    expect(r(mode, helper, key).effective).toBe(expected);
  });

  it("explains why nothing is usable", () => {
    const s = r("auto", null, false);
    expect(s.note).toBe("No AI set up. Install the helper, add a Claude API key, or log in.");
    expect(s.helperError).toBe("Helper not installed");
    const exited = resolveBrain({ settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "" }, helper: null, helperError: "Helper exited" });
    expect(exited.note).toBe("No AI set up. Reconnect the helper, add a Claude API key, or log in.");
    expect(r("auto", failed, false).note).toBe("No AI set up: Claude Code self-test failed: not logged in.");
    expect(r("claude-code", failed, true).note).toMatch(/self-test failed: not logged in/);
    expect(r("claude-code", noClaude, true).note).toMatch(/not found/);
    expect(r("claude-api", ok, false).note).toMatch(/No Claude API key/);
    expect(r("auto", failed, true).note).toMatch(/Using the Claude API key/);
    expect(r("auto", ok, false).note).toBeUndefined();
  });

  it("reports hasApiKey and helper info", () => {
    const s = r("auto", ok, true);
    expect(s.hasApiKey).toBe(true);
    expect(s.helper).toBe(ok);
  });

  it("jevActive: needs jevEnabled and a key (or the helper's own key for Claude Code)", () => {
    expect(r("claude-api", ok, true, { jevApiKey: "j" }).jevActive).toBe(true);
    expect(r("claude-api", ok, true, { jevApiKey: "j", jevEnabled: false }).jevActive).toBe(false);
    expect(r("claude-api", { ...ok, jevAvailable: true }, true).jevActive).toBe(false);
    expect(r("claude-code", { ...ok, jevAvailable: true }, false).jevActive).toBe(true);
    expect(r("claude-code", ok, false).jevActive).toBe(false);
    expect(r("auto", null, false, { jevApiKey: "j" }).jevActive).toBe(false);
  });
});

describe("builtInJev", () => {
  it("the hosted AI brings its own Jev; local Claude Code the helper's own key when it has one; else none", () => {
    expect(builtInJev("noa", null)).toBe("hosted");
    expect(builtInJev("claude-code", { ...base, jevAvailable: true })).toBe("helper");
    expect(builtInJev("claude-code", base)).toBeNull();
    expect(builtInJev("claude-api", { ...base, jevAvailable: true })).toBeNull();
    expect(builtInJev(null, null)).toBeNull();
  });
});

describe("resolveBrain with the Noa account", () => {
  const OUT = null;
  const signedOut = { signedIn: false, hostedUsable: false };
  const credit = { signedIn: true, hostedUsable: true };
  const noCredit = { signedIn: true, hostedUsable: false, outOfCredit: true };
  const ra = (mode: BrainMode, account: typeof credit | typeof signedOut | null, helper: HelperInfo | null, key: boolean) =>
    resolveBrain({ settings: { ...DEFAULT_SETTINGS, brain: mode, anthropicApiKey: key ? "sk" : "" }, helper, helperError: helper ? null : "Helper not installed", account });

  it.each([
    // mode, account, helper, own key, expected: Auto takes the user's own Claude first.
    ["auto", credit, ok, true, "claude-code"],
    ["auto", credit, ok, false, "claude-code"],
    ["auto", credit, null, true, "claude-api"],
    ["auto", credit, failed, true, "claude-api"],
    ["auto", credit, null, false, "noa"],
    ["auto", credit, notTested, false, "noa"],
    ["auto", noCredit, ok, true, "claude-code"],
    ["auto", noCredit, null, true, "claude-api"],
    ["auto", noCredit, null, false, OUT],
    ["auto", signedOut, ok, false, "claude-code"],
    ["auto", signedOut, null, true, "claude-api"],
    ["auto", null, null, false, OUT],
    ["noa", credit, ok, true, "noa"],
    ["noa", noCredit, ok, true, OUT],
    ["noa", signedOut, ok, true, OUT],
    ["claude-code", credit, ok, false, "claude-code"],
    ["claude-api", credit, ok, true, "claude-api"],
  ] as const)("%s, account %o, helper %#, key %s -> %s", (mode, account, helper, key, expected) => {
    expect(ra(mode, account, helper, key).effective).toBe(expected);
  });

  it("explains what the hosted AI needs", () => {
    expect(ra("noa", signedOut, ok, true).note).toBe("Sign in to use Noa AI");
    expect(ra("noa", noCredit, ok, true).note).toMatch(/^Out of usage credit/);
    expect(ra("auto", noCredit, null, false).note).toBe("Out of credit. Install the helper, add a Claude API key, or top up.");
    expect(ra("auto", signedOut, null, false).note).toBe("No AI set up. Install the helper, add a Claude API key, or log in.");
    // The helper is there but Claude Code does not work: the note says why the hosted AI runs.
    expect(ra("auto", credit, failed, false).note).toBe("Using Noa AI (Claude Code self-test failed: not logged in)");
    expect(ra("auto", credit, null, false).note).toBeUndefined();
  });

  it("the hosted AI brings its own Jev (no key needed); off when Jev is switched off", () => {
    expect(ra("auto", credit, null, false).jevActive).toBe(true);
    expect(resolveBrain({ settings: { ...DEFAULT_SETTINGS, jevEnabled: false }, helper: null, account: credit }).jevActive).toBe(false);
  });
});

describe("needsHelper", () => {
  it("whenever Claude Code may run: chosen, or Auto (it comes first); not for the API brains", () => {
    expect(needsHelper({ brain: "claude-code" })).toBe(true);
    expect(needsHelper({ brain: "auto" })).toBe(true);
    expect(needsHelper({ brain: "claude-api" })).toBe(false);
    expect(needsHelper({ brain: "noa" })).toBe(false);
  });
});

describe("autoSwitchRefusal", () => {
  it("Auto never moves a Claude Code chat to the paid hosted AI by itself", () => {
    expect(autoSwitchRefusal("auto", "claude-code", "noa")).toBe(CLAUDE_CODE_GONE);
    expect(autoSwitchRefusal("auto", "claude-code", "claude-api")).toBeNull();
    expect(autoSwitchRefusal("auto", "claude-code", "claude-code")).toBeNull();
    expect(autoSwitchRefusal("auto", "noa", "claude-code")).toBeNull();
    // A brain the user chose is theirs to pay for.
    expect(autoSwitchRefusal("noa", "claude-code", "noa")).toBeNull();
  });
});
