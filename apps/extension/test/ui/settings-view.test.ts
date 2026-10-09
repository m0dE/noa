import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, redactSettings, type ExtensionSettings, type HelperInfo } from "@noa/shared";
import { applySettingsPatch, loadSettings, saveSettingsPatch } from "../../src/settings-store.js";
import { buildSettingsPatch } from "../../src/options/settings-patch.js";
import {
  CUSTOM_MODEL,
  formValues,
  anchorFromHash,
  nextSection,
  parseForm,
  SECTIONS,
  sectionFromHash,
  settingsView,
  validateForm,
  type Draft,
  type ViewInput,
} from "../../src/options/settings-view.js";
import type { AccountView, BrainStatus } from "../../src/ui-protocol.js";
import { installChromeFake } from "../chrome-fake.js";

const HELPER: HelperInfo = { version: "0.2.0", jevAvailable: true, claudePath: "C:\\claude.exe", logDir: "C:\\logs", selfTest: { ok: true, ms: 5000, at: "2026-09-25T00:00:00Z" } } as HelperInfo;
const SIGNED_OUT: AccountView = { signedIn: false, signInConfigured: true, apiBase: "https://api.test", dashboardUrl: "https://api.test/", billingUrl: "https://api.test/billing", filesUrl: "https://api.test/files" };
const user = { email: "a@example.com", name: "Ada", pictureUrl: null };
const credit = (cents: number) => ({ subscriptionCents: 0, topupCents: cents, totalCents: cents, periodGrantCents: 0, periodEnd: null });
const FREE_EMPTY: AccountView = { ...SIGNED_OUT, signedIn: true, user, plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false }, credit: credit(0), stripeConfigured: true };
const FREE_TOPPED: AccountView = { ...FREE_EMPTY, credit: credit(750) };
const PLUS: AccountView = { ...FREE_EMPTY, plan: { id: "plus", status: "active", currentPeriodEnd: "2026-10-25T00:00:00Z", cancelAtPeriodEnd: false }, credit: credit(1540) };
const PLUS_EMPTY: AccountView = { ...PLUS, credit: credit(0) };

function view(opts: {
  brain?: ExtensionSettings["brain"];
  draft?: Partial<Draft>;
  settings?: Partial<ExtensionSettings>;
  account?: AccountView | null;
  helper?: HelperInfo | null;
  helperError?: string;
  effective?: BrainStatus["effective"];
}) {
  const settings = redactSettings({ ...DEFAULT_SETTINGS, brain: opts.brain ?? "auto", ...opts.settings });
  const input: ViewInput = {
    settings,
    draft: { brain: settings.brain, jevEnabled: settings.jevEnabled, anthropicModel: settings.anthropicModel, ...opts.draft },
    brain: { effective: opts.effective ?? null, helper: opts.helper === undefined ? null : opts.helper, hasApiKey: !!settings.anthropicApiKey, jevActive: false, ...(opts.helperError ? { helperError: opts.helperError } : {}) },
    account: opts.account === undefined ? SIGNED_OUT : opts.account,
  };
  return settingsView(input);
}
const option = (v: ReturnType<typeof settingsView>, value: string) => v.options.find((o) => o.value === value)!;

describe("sidebar sections", () => {
  it("maps hashes and aliases to sections", () => {
    expect(sectionFromHash("#ai")).toBe("ai");
    expect(sectionFromHash("AI")).toBe("ai");
    // Speed (Jev) is part of the AI section; its old links and a remembered "speed" land there.
    expect(sectionFromHash("#jev")).toBe("ai");
    expect(sectionFromHash("#speed")).toBe("ai");
    expect(sectionFromHash("speed")).toBe("ai");
    expect(sectionFromHash("#voice")).toBe("ai");
    expect(sectionFromHash("#vault")).toBe("logins");
    expect(sectionFromHash("#brain")).toBe("ai");
    expect(sectionFromHash("#source")).toBe("ai");
    // API keys are made on the dashboard now: an old #keys link lands on Account, as billing does.
    expect(sectionFromHash("#keys")).toBe("account");
    expect(sectionFromHash("#api-keys")).toBe("account");
    expect(sectionFromHash("#billing")).toBe("account");
    // Automation (approvals) moved from AI, and the schedule from Tasks, to Permission; old links land there.
    expect(sectionFromHash("#permission")).toBe("permission");
    expect(sectionFromHash("#automation")).toBe("permission");
    expect(sectionFromHash("#approvals")).toBe("permission");
    expect(sectionFromHash("#schedule")).toBe("permission");
    expect(sectionFromHash("#nope")).toBeNull();
    expect(sectionFromHash("")).toBeNull();
    expect(sectionFromHash(null)).toBeNull();
  });
  it("arrow keys (up/down in the column, left/right in the narrow row) move and wrap; Home and End go to the ends; other keys do nothing", () => {
    expect(SECTIONS.map((t) => t.label)).toEqual(["Account", "AI", "Permission", "Tasks", "Site logins", "Memory", "Advanced"]);
    expect(nextSection("account", "ArrowRight")).toBe("ai");
    expect(nextSection("ai", "ArrowLeft")).toBe("account");
    expect(nextSection("ai", "ArrowUp")).toBe("account");
    expect(nextSection("ai", "ArrowDown")).toBe("permission");
    expect(nextSection("ai", "ArrowRight")).toBe("permission");
    expect(nextSection("permission", "ArrowRight")).toBe("tasks");
    expect(nextSection("account", "ArrowLeft")).toBe(SECTIONS[SECTIONS.length - 1]!.id);
    expect(nextSection("advanced", "ArrowRight")).toBe("account");
    expect(nextSection("tasks", "Home")).toBe("account");
    expect(nextSection("tasks", "End")).toBe("advanced");
    expect(nextSection("tasks", "a")).toBeNull();
  });
  it("anchorFromHash: the group a link names inside its section (Jev, Voice), else none", () => {
    expect(anchorFromHash("#jev")).toBe("jev-group");
    expect(anchorFromHash("#speed")).toBe("jev-group");
    expect(anchorFromHash("#voice")).toBe("voice-group");
    expect(anchorFromHash("#source")).toBe("source-group");
    expect(anchorFromHash("#brain")).toBe("source-group");
    expect(anchorFromHash("#model")).toBe("model-group");
    expect(anchorFromHash("#ai")).toBeNull();
    // Automation is the Permission section's first group: its old link opens the section at the top; #schedule scrolls.
    expect(anchorFromHash("#automation")).toBeNull();
    expect(anchorFromHash("#schedule")).toBe("schedule-group");
    expect(anchorFromHash("")).toBeNull();
  });
});

describe("Noa AI option", () => {
  it("signed out: disabled, with a log-in action and no credit", () => {
    const v = view({ account: SIGNED_OUT });
    expect(option(v, "noa").enabled).toBe(false);
    expect(v.showHostedSignIn).toBe(true);
    expect(v.hosted).toBeNull();
    expect(v.signedIn).toBe(false);
  });
  it("no account view at all counts as signed out", () => {
    expect(option(view({ account: null }), "noa").enabled).toBe(false);
  });
  it("signed in on the free plan: enabled, plan and credit inline, Get a plan", () => {
    const v = view({ account: FREE_EMPTY });
    expect(option(v, "noa").enabled).toBe(true);
    expect(v.showHostedSignIn).toBe(false);
    expect(v.hosted).toEqual({ plan: "Free plan", credit: "No usage credit left", tone: "warn", action: { kind: "get-plan", label: "Get a plan" } });
  });
  it("free plan with top-up credit still offers a plan", () => {
    expect(view({ account: FREE_TOPPED }).hosted).toMatchObject({ credit: "$7.50 usage credit left", tone: "", action: { kind: "get-plan" } });
  });
  it("paid plan with credit: nothing to buy", () => {
    expect(view({ account: PLUS }).hosted).toEqual({ plan: "Plus plan", credit: "$15.40 usage credit left", tone: "", action: null });
  });
  it("paid plan with no credit: Top up", () => {
    expect(view({ account: PLUS_EMPTY }).hosted?.action).toEqual({ kind: "top-up", label: "Top up" });
  });
  it("billing not set up on the server: no buy action", () => {
    expect(view({ account: { ...FREE_EMPTY, stripeConfigured: false } }).hosted?.action).toBeNull();
  });
  it("saved as the brain while signed out: says no tasks run (the runner does not fall back)", () => {
    const v = view({ brain: "noa", account: SIGNED_OUT, helper: HELPER, settings: { anthropicApiKey: "sk" } });
    expect(v.brainProblem).toMatch(/Logged out/);
    expect(v.showHostedSignIn).toBe(true);
  });
  it("chosen with no credit on the free plan: says so", () => {
    expect(view({ brain: "noa", account: FREE_EMPTY }).brainProblem).toMatch(/Out of usage credit/);
  });
  it("chosen and usable: no problem", () => {
    expect(view({ brain: "noa", account: PLUS }).brainProblem).toBeNull();
  });
});

describe("what each brain reveals", () => {
  it("API key and Test key only for Claude API", () => {
    for (const brain of ["auto", "noa", "claude-code"] as const) expect(view({ draft: { brain } }).showApiKey).toBe(false);
    expect(view({ draft: { brain: "claude-api" } }).showApiKey).toBe(true);
  });
  it("follows the choice on screen before it is saved", () => {
    expect(view({ brain: "auto", draft: { brain: "claude-api" } }).showApiKey).toBe(true);
  });
  it("flags a missing key only for Claude API", () => {
    expect(view({ draft: { brain: "claude-api" } }).apiKeyMissing).toBe(true);
    expect(view({ draft: { brain: "claude-api" }, settings: { anthropicApiKey: "sk" } }).apiKeyMissing).toBe(false);
    expect(view({ draft: { brain: "auto" } }).apiKeyMissing).toBe(false);
  });
  it("helper status only for local Claude Code", () => {
    expect(view({ draft: { brain: "claude-code" } }).showHelper).toBe(true);
    expect(view({ draft: { brain: "auto" } }).showHelper).toBe(false);
    expect(view({ draft: { brain: "claude-api" } }).showHelper).toBe(false);
  });
});

describe("Auto says what it would pick now", () => {
  it("the user's own Claude first: local Claude Code when the helper works, even with credit", () => {
    expect(view({ account: PLUS, helper: HELPER }).autoPick.text).toBe("Right now this picks Local Claude Code.");
    expect(view({ account: FREE_EMPTY, helper: HELPER }).autoPick.text).toBe("Right now this picks Local Claude Code.");
  });
  it("then the Claude API key, then Noa AI when signed in with credit", () => {
    expect(view({ account: PLUS, settings: { anthropicApiKey: "sk" } }).autoPick.text).toBe("Right now this picks Claude API.");
    expect(view({ account: PLUS }).autoPick.text).toBe("Right now this picks Noa AI.");
  });
  it("Claude API with a key and no helper", () => {
    expect(view({ settings: { anthropicApiKey: "sk" } }).autoPick).toEqual({ text: "Right now this picks Claude API.", tone: "ok" });
  });
  it("nothing set up", () => {
    expect(view({ helperError: "not found" }).autoPick).toEqual({
      text: "Nothing set up yet. Signed in to Claude Code? Also install the helper: pick Local Claude Code.",
      tone: "bad",
    });
  });
  it("is the same whatever brain is saved", () => {
    expect(view({ brain: "claude-api", account: PLUS }).autoPick.text).toMatch(/Noa AI/);
  });
});

describe("model, Jev and cloud", () => {
  it("known model selected; custom ids select Custom…", () => {
    expect(view({}).model).toMatchObject({ selected: "claude-sonnet-5", custom: false });
    expect(view({ draft: { anthropicModel: "claude-x-test" } }).model).toMatchObject({ selected: CUSTOM_MODEL, custom: true });
  });
  it("tells that Noa AI runs Sonnet 5 for a model it does not offer", () => {
    expect(view({ draft: { brain: "noa", anthropicModel: "claude-x-test" } }).model.hint).toMatch(/runs Sonnet 5/);
    expect(view({ draft: { brain: "auto", anthropicModel: "claude-x-test" } }).model.hint).toMatch(/Sonnet 5/);
    expect(view({ draft: { brain: "claude-api", anthropicModel: "claude-x-test" } }).model.hint).not.toMatch(/Sonnet 5/);
  });
  it("model is shown for every brain (all of them run it)", () => {
    for (const brain of ["auto", "noa", "claude-code", "claude-api"] as const) expect(view({ draft: { brain } }).showModel).toBe(true);
  });
  it("Jev fields only when Jev is on", () => {
    expect(view({ draft: { jevEnabled: true } }).showJevFields).toBe(true);
    expect(view({ draft: { jevEnabled: false } }).showJevFields).toBe(false);
  });
  it("Jev note: the order of Jev sources; none when off", () => {
    expect(view({ helper: HELPER }).jevNote).toMatch(/TYPESAFE_API_KEY.*Noa's cloud Jev/);
    expect(view({ helper: HELPER, draft: { jevEnabled: false } }).jevNote).toBeNull();
  });
  it("Noa AI (chosen, or picked by Auto) includes Jev: no key field, no key in the copy", () => {
    for (const brain of ["noa", "auto"] as const) {
      const v = view({ account: PLUS, draft: { brain } });
      expect(v.showJevKey).toBe(false);
      expect(v.showJevFields).toBe(true);
      expect(v.jevUseHint).toBe("Clicking and typing: Noa's cloud Jev, billed to your usage credit. Approval checks: Noa's cloud Jev, billed to your usage credit.");
      expect(`${v.jevUseHint} ${v.jevTestHint} ${v.jevNote ?? ""}`).not.toMatch(/key/i);
    }
  });
  it("says which Jev each job uses: a key here, the helper's own, or Noa's cloud Jev", () => {
    const api = view({ account: PLUS, draft: { brain: "claude-api" }, settings: { anthropicApiKey: "set" } });
    expect(api.showJevKey).toBe(true);
    expect(api.jevUseHint).toBe("Clicking and typing: Noa's cloud Jev, billed to your usage credit. Approval checks: Noa's cloud Jev, billed to your usage credit.");
    const cc = view({ helper: HELPER, draft: { brain: "claude-code" } });
    expect(cc.showJevKey).toBe(true);
    expect(cc.jevUseHint).toBe("Clicking and typing: the helper's own Jev key. Approval checks: none (add a Jev key, or log in to use Noa's cloud Jev).");
    expect(view({ helper: HELPER, account: PLUS, draft: { brain: "claude-code" } }).jevUseHint).toMatch(/Approval checks: Noa's cloud Jev/);
    expect(view({ helper: HELPER, draft: { brain: "claude-code" }, settings: { jevApiKey: "set" } }).jevUseHint).toBe(
      "Clicking and typing: your Jev key. Approval checks: your Jev key.",
    );
    expect(view({ draft: { brain: "claude-api", jevEnabled: false } }).showJevKey).toBe(false);
  });
});

describe("validation", () => {
  const ok = formValues(DEFAULT_SETTINGS);
  it("defaults are valid", () => {
    expect(validateForm(ok)).toEqual({});
  });
  it("explains ranges, whole numbers, blanks and the pause order", () => {
    expect(validateForm({ ...ok, maxParallelTasks: "9" }).maxParallelTasks).toBe("Enter a number from 1 to 4.");
    expect(validateForm({ ...ok, maxParallelTasks: "1.5" }).maxParallelTasks).toBe("Enter a whole number from 1 to 4.");
    expect(validateForm({ ...ok, intervalMinutes: "" }).intervalMinutes).toMatch(/from 1 to 1440/);
    expect(validateForm({ ...ok, jevThreshold: "abc" }).jevThreshold).toMatch(/0 to 1/);
    expect(validateForm({ ...ok, delayMinSec: "100", delayMaxSec: "50" }).delayMaxSec).toMatch(/at least the shortest/);
  });
  it("checks addresses and the model id", () => {
    expect(validateForm({ ...ok, accountApiBase: "" }).accountApiBase).toMatch(/Enter the account server/);
    expect(validateForm({ ...ok, accountApiBase: "example.com" }).accountApiBase).toMatch(/https:\/\//);
    expect(validateForm({ ...ok, anthropicModel: " " }).anthropicModel).toBeDefined();
    expect(validateForm({ ...ok, anthropicModel: "claude sonnet" }).anthropicModel).toBeDefined();
  });
  it("leaves fields with a problem out of what is saved", () => {
    const parsed = parseForm({ ...ok, maxParallelTasks: "9", intervalMinutes: "20" });
    expect(parsed).not.toHaveProperty("maxParallelTasks");
    expect(parsed.intervalMinutes).toBe(20);
  });
});

describe("storage round-trip", () => {
  beforeEach(() => {
    installChromeFake();
  });
  const secrets = (s: ExtensionSettings) => ({ anthropicApiKey: s.anthropicApiKey, jevApiKey: s.jevApiKey });

  it("an untouched form changes nothing", () => {
    const saved = redactSettings({ ...DEFAULT_SETTINGS, anthropicApiKey: "sk", brain: "claude-code", accountApiBase: "https://acct.test" });
    expect(buildSettingsPatch(saved, parseForm(formValues(saved)))).toEqual({});
  });

  it("every field saved from the form reads back the same, under the same storage key", async () => {
    const chrome = installChromeFake();
    chrome.storage.local.data.settings = { ...DEFAULT_SETTINGS, anthropicApiKey: "sk-keep", jevApiKey: "jev-keep" };
    const before = await loadSettings();
    const v = formValues(redactSettings(before));
    const edited = {
      ...v,
      brain: "claude-api" as const,
      anthropicModel: "claude-opus-5-5",
      jevEnabled: false,
      jevThreshold: "0.65",
      accountApiBase: "https://acct.example.com//",
      showControlOverlay: false,
      intervalMinutes: "30",
      delayMinSec: "5",
      delayMaxSec: "15",
      maxToolCalls: "80",
      maxTaskMinutes: "20",
      maxParallelTasks: "3",
      retryAfterMinutes: "11",
      pauseRetryMinutes: "12",
      maxConsecutiveFailures: "0",
    };
    const patch = buildSettingsPatch(redactSettings(before), parseForm(edited));
    const after = await saveSettingsPatch(patch);
    expect(await loadSettings()).toEqual(after);
    expect(Object.keys(chrome.storage.local.data)).toContain("settings");
    expect(after).toEqual({
      ...before,
      brain: "claude-api",
      anthropicModel: "claude-opus-5-5",
      jevEnabled: false,
      jevThreshold: 0.65,
      accountApiBase: "https://acct.example.com",
      showControlOverlay: false,
      intervalMinutes: 30,
      delayMinSec: 5,
      delayMaxSec: 15,
      maxToolCalls: 80,
      maxTaskMinutes: 20,
      maxParallelTasks: 3,
      retryAfterMinutes: 11,
      pauseRetryMinutes: 12,
      maxConsecutiveFailures: 0,
    });
    // Keys the form never touched are kept; the form shows them back as saved.
    expect(secrets(after)).toEqual({ anthropicApiKey: "sk-keep", jevApiKey: "jev-keep" });
    expect(formValues(redactSettings(after))).toEqual({ ...edited, accountApiBase: "https://acct.example.com" });
  });

  it("keys: set, replace and remove save one key at a time", async () => {
    await saveSettingsPatch({ anthropicApiKey: "sk-1" });
    expect((await loadSettings()).anthropicApiKey).toBe("sk-1");
    // Each key field saves just its own key (secret-field.ts).
    await saveSettingsPatch({ jevApiKey: "j-1" });
    await saveSettingsPatch({ anthropicApiKey: "" });
    const s = await loadSettings();
    expect(secrets(s)).toEqual({ anthropicApiKey: "", jevApiKey: "j-1" });
  });

  it("a redacted marker never overwrites a stored key", () => {
    const stored = { ...DEFAULT_SETTINGS, anthropicApiKey: "sk-real" };
    expect(applySettingsPatch(stored, { anthropicApiKey: "set" }).anthropicApiKey).toBe("sk-real");
  });
});

describe("options: Reasoning", () => {
  it("defaults to Fast with Think harder when stuck on; the switch shows only for Fast, and the hint follows the draft", () => {
    expect(DEFAULT_SETTINGS.reasoning).toBe("fast");
    expect(DEFAULT_SETTINGS.reasoningAutoRaise).toBe(true);
    const fast = view({});
    expect(fast.showReasoningAutoRaise).toBe(true);
    expect(fast.reasoningHint).toMatch(/little thinking/);
    const thorough = view({ draft: { reasoning: "thorough" } });
    expect(thorough.showReasoningAutoRaise).toBe(false);
    expect(thorough.reasoningHint).toMatch(/Thinks before steps/);
    // No draft value: the saved setting.
    expect(view({ settings: { reasoning: "thorough" } }).showReasoningAutoRaise).toBe(false);
  });

  it("the form keeps both fields: settings -> form -> settings", () => {
    const s = { ...DEFAULT_SETTINGS, reasoning: "thorough" as const, reasoningAutoRaise: false };
    const v = formValues(s);
    expect(v.reasoning).toBe("thorough");
    expect(v.reasoningAutoRaise).toBe(false);
    expect(parseForm(v)).toMatchObject({ reasoning: "thorough", reasoningAutoRaise: false });
  });
});
