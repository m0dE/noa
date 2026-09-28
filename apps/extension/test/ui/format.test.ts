import { describe, expect, it } from "vitest";
import type { UiState } from "../../src/ui-protocol.js";
import {
  DEFAULT_SETTINGS,
  formatBytes,
  formatCents,
  formatRelative,
  planName,
  planStatusText,
  repeatLabel,
  splitTasks,
  taskChip,
  taskNextTime,
} from "@noa/shared";
import { FIXES } from "../../src/sidepanel/error-help.js";
import { accountLabel, bytesToBase64, clockLabel, firstLine, modelChip, statusLine, todoGate } from "../../src/sidepanel/format.js";
import { modelLabel } from "../../src/ui/labels.js";

const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime(); // local noon
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 24 + dayOffset, h, m).toISOString();

function state(over: Partial<UiState> = {}, brain: Partial<UiState["brain"]> = {}): UiState {
  return {
    settings: DEFAULT_SETTINGS,
    brain: { effective: "claude-code", helper: null, hasApiKey: false, jevActive: false, ...brain },
    running: null,
    runningSessions: [],
    openConversations: [],
    ...over,
  };
}

describe("statusLine", () => {
  it("names the brain in use", () => {
    expect(statusLine(state())).toEqual({ tone: "ok", text: "Claude Code" });
    expect(statusLine(state({}, { effective: "claude-api", jevActive: true })).text).toBe("Claude API + Jev");
  });
  it("says what is wrong in plain words, with the fix of the chat's error cards", () => {
    const note = "No AI set up. Install the helper, add a Claude API key, or log in.";
    expect(statusLine(state({}, { effective: null, note }))).toEqual({ tone: "bad", text: "AI model not detected", title: note, action: FIXES.setUpAi });
    expect(statusLine(state({}, { effective: null, note: "Helper not installed" }))).toMatchObject({ text: "The Claude Code helper isn't installed", action: FIXES.claudeCode });
    expect(statusLine(state({}, { effective: null, note: "No Claude API key set" }))).toMatchObject({ text: "No Claude API key is set", action: FIXES.apiKey });
    expect(statusLine(state({}, { effective: null, note: "Sign in to use Noa AI" }))).toMatchObject({ text: "You're not logged in", action: FIXES.login });
    // A reason it does not know: still a way to fix it.
    expect(statusLine(state({}, { effective: null, note: "Something odd" }))).toMatchObject({ text: "Something went wrong", title: "Something odd", action: FIXES.setUpAi });
  });
  it("says once when a plan without the TODO list keeps scheduled jobs from running, with Choose a plan", () => {
    const account = { signedIn: true, user: { id: "u", email: "a@b.c" } } as unknown as UiState["account"];
    expect(statusLine(state({ account }), { lockedWaiting: 3 })).toEqual({
      tone: "warn",
      text: "3 scheduled jobs won't run on your plan",
      title: "Your plan doesn't include the TODO list; the jobs are kept and run again when you subscribe.",
      action: FIXES.plans,
    });
    expect(statusLine(state({ account }), { lockedWaiting: 1 }).text).toBe("1 scheduled job won't run on your plan");
    // Nothing waits (or signed out): nothing to say.
    expect(statusLine(state({ account }), { lockedWaiting: 0 }).tone).toBe("ok");
    expect(statusLine(state(), { lockedWaiting: 2 }).tone).toBe("ok");
    // No AI at all comes first.
    expect(statusLine(state({ account }, { effective: null }), { lockedWaiting: 3 }).action).toEqual(FIXES.setUpAi);
  });
  it("offers Retry while the old pause of every run is not converted into paused jobs", () => {
    const s = statusLine(state({ pauseMigration: "HTTP 404" }));
    expect(s).toMatchObject({ tone: "warn", text: "Your account's jobs wait until each is paused", action: "retry-pause" });
    expect(s.title).toMatch(/Not done yet: HTTP 404$/);
    expect(statusLine(state({ pauseMigration: "x" }, { effective: null })).action).toEqual(FIXES.setUpAi);
  });
});

describe("times", () => {
  it("formatRelative", () => {
    expect(formatRelative(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(formatRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(formatRelative(new Date(NOW + 3 * 3600_000).toISOString(), NOW)).toBe("in 3 h");
    expect(formatRelative(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe("2 days ago");
    expect(formatRelative(new Date(NOW - 86400_000).toISOString(), NOW)).toBe("1 day ago");
    expect(formatRelative("nope", NOW)).toBe("");
  });
  it("clockLabel", () => {
    expect(clockLabel(at(14, 30), NOW)).toBe("today 14:30");
    expect(clockLabel(at(9, 5, 1), NOW)).toBe("tomorrow 09:05");
    expect(clockLabel(at(23, 0, -1), NOW)).toBe("yesterday 23:00");
    expect(clockLabel(at(8, 0, 6), NOW)).toBe("Sep 30 08:00");
  });
});

describe("tasks", () => {
  const base = { notBefore: null, retryAfter: null, createdAt: at(8), updatedAt: at(8) };
  it("chips", () => {
    expect(taskChip({ ...base, status: "pending" }, NOW)).toEqual({ label: "due", tone: "accent" });
    expect(taskChip({ ...base, status: "pending", notBefore: at(15) }, NOW).label).toBe("scheduled");
    expect(taskChip({ ...base, status: "pending", retryAfter: at(12, 10) }, NOW).label).toBe("retry");
    expect(taskChip({ ...base, status: "paused" }, NOW).label).toBe("needs you");
    expect(taskChip({ ...base, status: "failed" }, NOW).tone).toBe("bad");
  });
  it("next time is the later of notBefore and retryAfter, only while pending", () => {
    expect(taskNextTime({ status: "pending", notBefore: at(15), retryAfter: at(13) })).toBe(at(15));
    expect(taskNextTime({ status: "pending", notBefore: null, retryAfter: at(13) })).toBe(at(13));
    expect(taskNextTime({ status: "done", notBefore: at(15), retryAfter: null })).toBeNull();
  });
  it("splits active and finished in a useful order", () => {
    const t = (id: string, status: "pending" | "running" | "done" | "failed" | "paused", extra = {}) => ({ id, status, ...base, ...extra });
    const { active, finished } = splitTasks([
      t("later", "pending", { notBefore: at(18) }),
      t("old-done", "done", { updatedAt: at(9) }),
      t("run", "running"),
      t("now", "pending"),
      t("new-fail", "failed", { updatedAt: at(11) }),
      t("ask", "paused"),
    ]);
    expect(active.map((x) => x.id)).toEqual(["run", "ask", "now", "later"]);
    expect(finished.map((x) => x.id)).toEqual(["new-fail", "old-done"]);
  });
  it("labels", () => {
    expect(repeatLabel({ cron: "0 9,18 * * *", tz: "UTC" }, { hour12: true })).toBe("Daily at 9:00 AM and 6:00 PM");
    expect(repeatLabel({ cron: "0 9 * * 1-5", tz: "UTC", end: "2026-12-31" }, { hour12: false, now: new Date("2026-09-24T00:00:00Z") })).toBe("Every weekday at 09:00, until Dec 31");
    expect(repeatLabel(null)).toBe("");
    expect(accountLabel("myhandle")).toBe("@myhandle");
    expect(accountLabel("@myhandle")).toBe("@myhandle");
    expect(accountLabel("Work Gmail")).toBe("Work Gmail");
    expect(accountLabel(null)).toBe("");
  });
  it("firstLine", () => {
    expect(firstLine("\n  Post this\nsecond")).toBe("Post this");
    expect(firstLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

it("bytesToBase64 round-trips large input", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
  expect(decoded).toEqual(bytes);
  expect(bytesToBase64(new TextEncoder().encode("hi!"))).toBe("aGkh");
});

describe("model chip", () => {
  it("names known models and keeps other ids as typed", () => {
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel(" claude-custom-9 ")).toBe("claude-custom-9");
    expect(modelLabel("")).toBe("Default model");
  });
  it("adds Jev when it is active for the brain in use", () => {
    expect(modelChip(state()).label).toBe("Sonnet 5");
    expect(modelChip(state({}, { jevActive: true })).label).toBe("Sonnet 5 · Jev");
    expect(modelChip(state({}, { effective: null, jevActive: true })).label).toBe("Sonnet 5");
    const opus = state({ settings: { ...DEFAULT_SETTINGS, anthropicModel: "claude-opus-5-5" } }, { jevActive: true });
    expect(modelChip(opus)).toMatchObject({ label: "Opus 5.5 · Jev", model: "claude-opus-5-5", jevActive: true });
  });
  it("offers the Jev switch only when a key exists somewhere", () => {
    expect(modelChip(state()).jevPossible).toBe(false);
    expect(modelChip(state({ settings: { ...DEFAULT_SETTINGS, jevApiKey: "set" } })).jevPossible).toBe(true);
    const helper = { version: "1", jevAvailable: true, claudePath: "c", logDir: "l", ptyAvailable: true };
    expect(modelChip(state({}, { helper })).jevPossible).toBe(true);
    expect(modelChip(state({}, { jevActive: true })).jevPossible).toBe(true);
    expect(modelChip(state({ settings: { ...DEFAULT_SETTINGS, jevEnabled: false } })).jevEnabled).toBe(false);
  });
});

describe("hosted AI in the status line and the model chip", () => {
  const account = (over: Partial<NonNullable<UiState["account"]>> = {}): NonNullable<UiState["account"]> => ({
    signedIn: true,
    signInConfigured: true,
    apiBase: "https://api.test",
    dashboardUrl: "https://api.test/",
    billingUrl: "https://api.test/billing",
    user: { email: "ada@example.com", name: "Ada", pictureUrl: null },
    credit: { subscriptionCents: 421, topupCents: 1000, totalCents: 1421, periodGrantCents: 500, periodEnd: null },
    ...over,
  });

  it("names Noa AI as the brain", () => {
    expect(statusLine(state({ account: account() }, { effective: "noa", jevActive: true }))).toEqual({ tone: "ok", text: "Noa AI + Jev" });
  });

  it("out of credit: the status line says so with a Top up action", () => {
    const out = account({ outOfCredit: true, credit: { subscriptionCents: 0, topupCents: 0, totalCents: 0, periodGrantCents: 0, periodEnd: null } });
    expect(statusLine(state({ account: out }, { effective: "noa" }))).toEqual({ tone: "warn", text: "You're out of usage credit", title: "Out of usage credit", action: FIXES.topup });
    // Auto fell back to nothing usable: still the credit message.
    expect(statusLine(state({ account: out }, { effective: null, note: "x" })).action).toEqual(FIXES.topup);
    // Another brain runs: credit is not the problem.
    expect(statusLine(state({ account: out }, { effective: "claude-code" })).text).toBe("Claude Code");
  });

  it("the chip shows the hosted model, the credit left, and out of credit", () => {
    const chip = modelChip(state({ account: account() }, { effective: "noa", jevActive: true }));
    expect(chip).toMatchObject({ hosted: true, label: "Sonnet 5 · Jev", credit: "$14.21 usage credit left", outOfCredit: false, jevPossible: true });
    const custom = state({ account: account(), settings: { ...DEFAULT_SETTINGS, anthropicModel: "my-model" } }, { effective: "noa" });
    expect(modelChip(custom)).toMatchObject({ model: "claude-sonnet-5", label: "Sonnet 5" });
    const out = modelChip(state({ account: account({ outOfCredit: true }) }, { effective: "noa" }));
    expect(out).toMatchObject({ label: "Out of usage credit", outOfCredit: true });
    expect(modelChip(state({ account: account() })).hosted).toBe(false);
  });
});

describe("shared formatting", () => {
  it("money: cents to dollars, thousands grouped, sub-cent charges not shown as $0.00", () => {
    expect(formatCents(421)).toBe("$4.21");
    expect(formatCents(-12)).toBe("-$0.12");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(0.3)).toBe("<$0.01");
    expect(formatCents(1000, { whole: true })).toBe("$10");
  });
  it("file sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
  });
  it("plans", () => {
    expect(planName("plus")).toBe("Plus");
    expect(planName(undefined)).toBe("Free");
    expect(planStatusText({ status: "past_due", cancelAtPeriodEnd: false })).toBe("Payment overdue");
    expect(planStatusText({ status: "active", cancelAtPeriodEnd: false })).toBeNull();
  });
});

describe("TODO tab gate (the TODO list is a paid feature)", () => {
  const view = (plan?: "free" | "plus", signedIn = true) => ({
    signedIn,
    signInConfigured: true,
    apiBase: "https://api.test",
    dashboardUrl: "https://api.test/",
    billingUrl: "https://api.test/billing",
    ...(plan ? { plan: { id: plan, status: plan === "free" ? "none" : "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } as const } : {}),
  });
  it("signed out: Log in; Free: Get a plan; a paid plan: the list", () => {
    expect(todoGate(null, null)).toBe("loading");
    expect(todoGate(view(undefined, false), null)).toBe("out");
    expect(todoGate(view("free"), null)).toBe("locked");
    expect(todoGate(view("plus"), null)).toBe("in");
  });
  it("the list's word wins over the plan cached in the extension", () => {
    expect(todoGate(view("plus"), true)).toBe("locked");
    expect(todoGate(view("free"), false)).toBe("in");
  });
});
