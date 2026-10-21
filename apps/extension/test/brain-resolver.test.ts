import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type BrainMode, type HelperInfo } from "@noa/shared";
import { approvalJevSource, jevSourceFor, needsHelper, resolveBrain } from "../src/engine/brain-resolver.js";

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

  it("local model: runs only when picked, on OpenCode in the helper, with a server address and a model; Auto never picks it", () => {
    // OpenCode found; Claude Code missing or failing does not matter.
    const opencode: HelperInfo = { ...noClaude, opencodePath: "/noa/opencode/node_modules/opencode-ai/bin/opencode.exe" };
    expect(r("local", opencode, false, { localModel: "qwen3:8b" }).effective).toBe("local");
    expect(r("local", { ...failed, opencodePath: "/oc" }, false, { localModel: "qwen3:8b" }).effective).toBe("local");
    expect(r("local", opencode, false).note).toBe("No local model picked");
    expect(r("local", opencode, false, { localModel: "qwen3:8b", localModelUrl: "localhost" }).note).toBe("No local model server address set");
    // What to run when the helper or OpenCode is missing.
    expect(r("local", null, false, { localModel: "qwen3:8b" }).note).toBe("Helper not installed: run npx -y noa-local-llm to set up the local model");
    expect(r("local", ok, false, { localModel: "qwen3:8b" }).note).toBe("OpenCode not found: run npx -y noa-local-llm to set up the local model");
    expect(r("auto", opencode, false, { localModel: "qwen3:8b" }).effective).toBeNull();
    // Jev: the key set here first, then the helper's own.
    expect(r("local", opencode, false, { localModel: "qwen3:8b", jevApiKey: "jk" }).jevSource).toBe("key");
    expect(r("local", { ...opencode, jevAvailable: true }, false, { localModel: "qwen3:8b", jevApiKey: "" }).jevSource).toBe("helper");
    expect(needsHelper({ brain: "local" })).toBe(true);
  });

  it("explains why nothing is usable", () => {
    const s = r("auto", null, false);
    expect(s.note).toBe("No AI set up. Log in, install the helper, or add a Claude API key.");
    expect(s.helperError).toBe("Helper not installed");
    const exited = resolveBrain({ settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "" }, helper: null, helperError: "Helper exited" });
    expect(exited.note).toBe("No AI set up. Log in, reconnect the helper, or add a Claude API key.");
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

describe("jevSourceFor", () => {
  const credit = { signedIn: true, hostedUsable: true };
  const broke = { signedIn: true, hostedUsable: false };
  const src = (brain: Parameters<typeof jevSourceFor>[0], helper: typeof base | null, account: typeof credit | null, jevApiKey = "") =>
    jevSourceFor(brain, { settings: { ...DEFAULT_SETTINGS, jevApiKey }, helper, account });
  it("Noa AI always uses the cloud; the others a key here, then the helper's own key, then the cloud", () => {
    expect(src("noa", null, credit, "j")).toBe("cloud");
    expect(src("claude-code", { ...base, jevAvailable: true }, credit, "j")).toBe("key");
    expect(src("claude-code", { ...base, jevAvailable: true }, credit)).toBe("helper");
    // Bug: "even if im using local claude code, if JEV is lacking, then have me use JEV from cloud service".
    expect(src("claude-code", base, credit)).toBe("cloud");
    expect(src("claude-api", { ...base, jevAvailable: true }, credit)).toBe("cloud");
    expect(src("claude-code", base, broke)).toBeNull();
    expect(src("claude-api", null, null)).toBeNull();
    expect(src(null, null, credit)).toBeNull();
  });
  it("approval checks: a key here, else the cloud (the helper's key is out of reach)", () => {
    expect(approvalJevSource({ settings: { ...DEFAULT_SETTINGS, jevApiKey: "j" }, account: credit })).toBe("key");
    expect(approvalJevSource({ settings: DEFAULT_SETTINGS, account: credit })).toBe("cloud");
    expect(approvalJevSource({ settings: DEFAULT_SETTINGS, account: broke })).toBeNull();
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
    // mode, account, helper, own key, expected: Auto takes Noa AI first when it can run, else the user's own Claude.
    ["auto", credit, ok, true, "noa"],
    ["auto", credit, ok, false, "noa"],
    ["auto", credit, null, true, "noa"],
    ["auto", credit, failed, true, "noa"],
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
    expect(ra("auto", noCredit, null, false).note).toBe("Out of credit. Top up, install the helper, or add a Claude API key.");
    expect(ra("auto", signedOut, null, false).note).toBe("No AI set up. Log in, install the helper, or add a Claude API key.");
    // Noa AI runs first, so a broken Claude Code needs no note.
    expect(ra("auto", credit, failed, false).note).toBeUndefined();
    expect(ra("auto", credit, null, false).note).toBeUndefined();
    // Out of credit, the helper is there but Claude Code does not work: the note says why the API key runs.
    expect(ra("auto", noCredit, failed, true).note).toBe("Using the Claude API key (Claude Code self-test failed: not logged in)");
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
