/**
 * Pure logic for the options page: its sections, what each brain option shows
 * and allows, which fields are visible, and inline validation. The page
 * (options.ts) only renders what these functions return.
 */
import {
  CLAUDE_MODELS,
  DEFAULT_MODEL,
  ExtensionSettings,
  formatCents,
  isClaudeModel,
  OUT_OF_CREDIT,
  PERMISSION_TITLE,
  planName,
  REASONING_LEVELS,
  type BrainMode,
  type ReasoningLevel,
} from "@noa/shared";
import { isPaidActive } from "../account/types.js";
import { builtInJev, HOSTED_LABEL, resolveBrain } from "../engine/brain-resolver.js";
import { brainLabel, modelLabel } from "../ui/labels.js";
import type { AccountView, BrainStatus } from "../ui-protocol.js";

// ---------------------------------------------------------------- sections (the sidebar)

export const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "keys", label: "API keys" },
  { id: "ai", label: "AI" },
  { id: "permission", label: PERMISSION_TITLE },
  { id: "tasks", label: "Tasks" },
  { id: "logins", label: "Site logins" },
  { id: "memory", label: "Memory" },
  { id: "advanced", label: "Advanced" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * Other names a link may use for a section (options.html#jev opens AI, at its Jev group). "speed" was Jev's own tab;
 * automation (with approvals) was on AI and the schedule on Tasks before they moved to Permission.
 */
const SECTION_ALIASES: Record<string, SectionId> = {
  brain: "ai",
  model: "ai",
  helper: "ai",
  jev: "ai",
  speed: "ai",
  voice: "ai",
  automation: "permission",
  approvals: "permission",
  permissions: "permission",
  autonomy: "permission",
  "api-keys": "keys",
  billing: "account",
  schedule: "permission",
  vault: "logins",
  memories: "memory",
  cloud: "advanced",
  "self-hosting": "advanced",
};

const hashName = (hash: string | null | undefined) => (hash ?? "").replace(/^#/, "").trim().toLowerCase();

/** "#ai" / "ai" / "#jev" -> the section; null for anything unknown. */
export function sectionFromHash(hash: string | null | undefined): SectionId | null {
  const id = hashName(hash);
  if (!id) return null;
  if (SECTIONS.some((s) => s.id === id)) return id as SectionId;
  return SECTION_ALIASES[id] ?? null;
}

/** Links that name a group inside a section -> that group's element id. */
const ANCHORS: Record<string, string> = { jev: "jev-group", speed: "jev-group", voice: "voice-group", schedule: "schedule-group" };

/** "#jev" -> "jev-group": the group to scroll to once its section shows; null for a section's own link. */
export function anchorFromHash(hash: string | null | undefined): string | null {
  return ANCHORS[hashName(hash)] ?? null;
}

/** The section an arrow key moves to (wraps around); Home / End go to the ends. */
export function nextSection(current: SectionId, key: string): SectionId | null {
  const i = SECTIONS.findIndex((s) => s.id === current);
  const n = SECTIONS.length;
  if (key === "ArrowRight" || key === "ArrowDown") return SECTIONS[(i + 1) % n]!.id;
  if (key === "ArrowLeft" || key === "ArrowUp") return SECTIONS[(i - 1 + n) % n]!.id;
  if (key === "Home") return SECTIONS[0].id;
  if (key === "End") return SECTIONS[n - 1]!.id;
  return null;
}

// ---------------------------------------------------------------- brain options

/** What the page has on screen right now (may differ from the saved settings until saved). */
export interface Draft {
  brain: BrainMode;
  jevEnabled: boolean;
  cloudEnabled: boolean;
  anthropicModel: string;
  /** Absent: the saved setting. */
  reasoning?: ReasoningLevel;
}

export interface ViewInput {
  /** Saved settings, secrets redacted to "set" / "". */
  settings: ExtensionSettings;
  draft: Draft;
  brain: BrainStatus;
  account?: AccountView | null;
}

export type Tone = "ok" | "warn" | "bad" | "";

export interface HostedAccount {
  /** "Free plan" / "Plus plan". */
  plan: string;
  /** "$4.21 usage credit left" or "No usage credit left". */
  credit: string;
  tone: Tone;
  /** Opens the dashboard's Billing page. get-plan: on the free plan; top-up: a paid plan with no credit left. null: nothing to buy (or billing is off). */
  action: { kind: "get-plan" | "top-up"; label: string } | null;
}

export interface BrainOption {
  value: BrainMode;
  label: string;
  /** One line under the label. */
  detail: string;
  /** false: shown but cannot be picked (Noa AI while signed out). */
  enabled: boolean;
}

export interface SettingsView {
  signedIn: boolean;
  options: BrainOption[];
  /** Under Auto: which brain it would pick right now. */
  autoPick: { text: string; tone: Tone };
  /** Under Noa AI when signed in: plan, credit, what to buy. */
  hosted: HostedAccount | null;
  /** Signed out: the "Log in to use Noa AI" action under Noa AI. */
  showHostedSignIn: boolean;
  /** The chosen brain cannot run right now: why, and what happens instead. */
  brainProblem: string | null;
  showApiKey: boolean;
  /** Claude API selected without a key. */
  apiKeyMissing: boolean;
  showHelper: boolean;
  showModel: boolean;
  model: ModelChoice;
  /** Under Reasoning: what the chosen level does. */
  reasoningHint: string;
  /** "Think harder when stuck": Fast only (Thorough already thinks). */
  showReasoningAutoRaise: boolean;
  /** Jev's threshold and Test button (Jev on). */
  showJevFields: boolean;
  /** The Jev key field: Jev on, and the brain that runs does not bring its own Jev. */
  showJevKey: boolean;
  /** Under "Use Jev": what Jev needs with the brain that runs. */
  jevUseHint: string;
  /** Under "Test Jev": what the test sends. */
  jevTestHint: string;
  /** Under the key field: where Jev's key comes from, when that is not obvious. */
  jevNote: string | null;
  showCloudFields: boolean;
}

export interface ModelChoice {
  /** The select's value: a known model id, or "custom". */
  selected: string;
  /** The custom model id field is shown. */
  custom: boolean;
  /** One line under the model select. */
  hint: string;
}

export const CUSTOM_MODEL = "custom";

/** The account as the brain resolver sees it (mirrors AccountService.brainAccount). */
export function brainAccount(a: AccountView | null | undefined): { signedIn: boolean; hostedUsable: boolean; outOfCredit: boolean } {
  if (!a?.signedIn) return { signedIn: false, hostedUsable: false, outOfCredit: false };
  const credit = a.credit?.totalCents ?? 0;
  const hostedUsable = (credit > 0 && !a.outOfCredit) || isPaidActive(a.plan);
  return { signedIn: true, hostedUsable, outOfCredit: !!a.outOfCredit || (!!a.credit && credit <= 0) };
}

function hostedAccount(a: AccountView): HostedAccount {
  const paid = isPaidActive(a.plan);
  const cents = a.credit?.totalCents;
  const noCredit = !!a.outOfCredit || cents === 0;
  const credit = cents === undefined ? (a.outOfCredit ? "No usage credit left" : "Usage credit not loaded") : noCredit ? "No usage credit left" : `${formatCents(cents)} usage credit left`;
  const canBuy = a.stripeConfigured !== false;
  let action: HostedAccount["action"] = null;
  if (canBuy && !paid) action = { kind: "get-plan", label: "Get a plan" };
  else if (canBuy && noCredit) action = { kind: "top-up", label: "Top up" };
  return { plan: `${planName(a.plan?.id)} plan`, credit, tone: noCredit ? "warn" : "", action };
}

function modelChoice(draft: Draft): ModelChoice {
  const id = draft.anthropicModel.trim();
  const known = isClaudeModel(id);
  const selected = known ? id : CUSTOM_MODEL;
  let hint = "Used by every brain. You can also switch it from the side panel.";
  if (draft.brain === "noa") {
    hint = known || !id ? "Noa AI runs this model." : `Noa AI does not offer this model, so it runs ${modelLabel(DEFAULT_MODEL)}.`;
  } else if (draft.brain === "auto" && !known && id) {
    hint = `If Auto picks Noa AI, it runs ${modelLabel(DEFAULT_MODEL)} instead: it does not offer this model.`;
  }
  return { selected, custom: selected === CUSTOM_MODEL, hint };
}

export function settingsView(input: ViewInput): SettingsView {
  const { settings, draft, brain } = input;
  const account = input.account ?? null;
  const acct = brainAccount(account);
  const signedIn = acct.signedIn;

  // What Auto would pick right now: the runner's own resolver, with brain = auto.
  const auto = resolveBrain({
    settings: { ...settings, brain: "auto" },
    helper: brain.helper,
    helperError: brain.helperError ?? null,
    account: acct,
  });
  const autoPick = auto.effective
    ? { text: `Right now this picks ${auto.effective === "claude-code" ? "Local Claude Code" : brainLabel(auto.effective)}.`, tone: "ok" as Tone }
    : {
        text: brain.helper ? "Nothing set up yet." : "Nothing set up yet. Signed in to Claude Code? Also install the helper: pick Local Claude Code.",
        tone: "bad" as Tone,
      };

  // The chosen brain as the runner resolves it (same function, the draft's choice).
  const chosen = resolveBrain({
    settings: { ...settings, brain: draft.brain },
    helper: brain.helper,
    helperError: brain.helperError ?? null,
    account: acct,
  });
  let brainProblem: string | null = null;
  if (draft.brain === "noa" && !signedIn) {
    brainProblem = "Logged out. Log in or pick another brain.";
  } else if (draft.brain === "noa" && !chosen.effective) {
    brainProblem = `${OUT_OF_CREDIT}. Top up or pick another brain.`;
  }
  // Local Claude Code and the Claude API say what is missing in their own inline sections.

  const options: BrainOption[] = [
    { value: "auto", label: "Auto", detail: "Uses your own Claude first, then Noa AI.", enabled: true },
    {
      value: "noa",
      label: "Noa AI",
      detail: signedIn ? "Hosted by Noa, paid from your usage credit. Nothing to set up." : "Hosted by Noa. Needs an account.",
      enabled: signedIn,
    },
    { value: "claude-code", label: "Local Claude Code", detail: "Your Claude subscription, through the helper app.", enabled: true },
    { value: "claude-api", label: "Claude API", detail: "Your Anthropic API key, straight from Chrome.", enabled: true },
  ];

  // Jev for the brain the draft would run: the hosted AI brings its own; else a key here, else the helper's own key.
  const jevSource = builtInJev(chosen.effective, brain.helper);
  const jevUseHint =
    jevSource === "hosted"
      ? `Included with ${HOSTED_LABEL}. Speeds up single steps.`
      : jevSource === "helper"
        ? "Speeds up single steps. Uses the helper's own Jev key unless you set one here."
        : "Speeds up single steps. Needs a Jev key.";
  const jevTestHint = jevSource === "hosted" ? `Sends one test request to ${HOSTED_LABEL}, billed to your usage credit.` : "Sends one test request.";
  const jevNote =
    jevSource === "helper" && !settings.jevApiKey
      ? "With local Claude Code the helper uses its own Jev key (TYPESAFE_API_KEY in its .env file). A key entered here takes priority and also works with the Claude API."
      : null;

  return {
    signedIn,
    options,
    autoPick,
    hosted: signedIn && account ? hostedAccount(account) : null,
    showHostedSignIn: !signedIn,
    brainProblem,
    showApiKey: draft.brain === "claude-api",
    apiKeyMissing: draft.brain === "claude-api" && !settings.anthropicApiKey,
    showHelper: draft.brain === "claude-code",
    // Every brain runs the chosen model (the hosted AI only its own list).
    showModel: true,
    model: modelChoice(draft),
    reasoningHint: REASONING_LEVELS.find((r) => r.id === (draft.reasoning ?? settings.reasoning))?.detail ?? "",
    showReasoningAutoRaise: (draft.reasoning ?? settings.reasoning) === "fast",
    showJevFields: draft.jevEnabled,
    showJevKey: draft.jevEnabled && jevSource !== "hosted",
    jevUseHint,
    jevTestHint,
    jevNote: draft.jevEnabled ? jevNote : null,
    showCloudFields: draft.cloudEnabled,
  };
}

/** The Reasoning select's choices. */
export function reasoningOptions(): { id: ReasoningLevel; label: string }[] {
  return REASONING_LEVELS.map((r) => ({ id: r.id, label: r.label }));
}

/** Models the select offers: the side panel's list (Noa AI runs every one of them). */
export function modelOptions(): { id: string; label: string }[] {
  return CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label }));
}

// ---------------------------------------------------------------- form values and validation

export const NUMBER_FIELDS = [
  "jevThreshold",
  "intervalMinutes",
  "delayMinSec",
  "delayMaxSec",
  "maxToolCalls",
  "maxTaskMinutes",
  "maxParallelTasks",
  "retryAfterMinutes",
  "pauseRetryMinutes",
  "maxConsecutiveFailures",
] as const satisfies readonly (keyof ExtensionSettings)[];
export const TEXT_FIELDS = ["anthropicModel", "apiBase", "accountApiBase"] as const satisfies readonly (keyof ExtensionSettings)[];
export const BOOL_FIELDS = ["jevEnabled", "cloudEnabled", "reasoningAutoRaise", "showControlOverlay"] as const satisfies readonly (keyof ExtensionSettings)[];
export type NumberField = (typeof NUMBER_FIELDS)[number];
export type TextField = (typeof TEXT_FIELDS)[number];
export type BoolField = (typeof BOOL_FIELDS)[number];

export interface NumberRule {
  min: number;
  max: number;
  int: boolean;
}

/** The allowed range of a number field, read from the settings schema. */
function numberRule(key: NumberField): NumberRule {
  const schema = ExtensionSettings.shape[key].unwrap();
  return { min: schema.minValue ?? -Infinity, max: schema.maxValue ?? Infinity, int: schema.isInt };
}

/** The allowed range of each number (the settings schema's bounds). */
export const NUMBER_RULES = Object.fromEntries(NUMBER_FIELDS.map((k) => [k, numberRule(k)])) as Record<NumberField, NumberRule>;

/** Raw values as the form holds them. */
export type FormValues = { brain: BrainMode; reasoning: ReasoningLevel } & Record<NumberField | TextField, string> & Record<BoolField, boolean>;

/** Settings -> what the form shows. */
export function formValues(s: ExtensionSettings): FormValues {
  const out: Record<string, unknown> = { brain: s.brain, reasoning: s.reasoning };
  for (const k of NUMBER_FIELDS) out[k] = String(s[k]);
  for (const k of TEXT_FIELDS) out[k] = s[k];
  for (const k of BOOL_FIELDS) out[k] = s[k];
  return out as FormValues;
}

const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/** Plain-language problems, by field. Fields with a problem are not saved. */
export function validateForm(v: FormValues): Partial<Record<NumberField | TextField, string>> {
  const errors: Partial<Record<NumberField | TextField, string>> = {};
  for (const k of NUMBER_FIELDS) {
    const raw = v[k].trim();
    const r = NUMBER_RULES[k];
    const range = `${r.min} to ${r.max}`;
    if (raw === "") errors[k] = `Enter a number from ${range}.`;
    else if (!Number.isFinite(Number(raw))) errors[k] = `Enter a number from ${range}.`;
    else if (r.int && !Number.isInteger(Number(raw))) errors[k] = `Enter a whole number from ${range}.`;
    else if (Number(raw) < r.min || Number(raw) > r.max) errors[k] = `Enter a number from ${range}.`;
  }
  if (!errors.delayMinSec && !errors.delayMaxSec && Number(v.delayMaxSec) < Number(v.delayMinSec)) {
    errors.delayMaxSec = "Make this at least the shortest pause.";
  }
  if (!v.anthropicModel.trim()) errors.anthropicModel = "Enter a model id, for example claude-sonnet-5.";
  else if (/\s/.test(v.anthropicModel.trim())) errors.anthropicModel = "A model id has no spaces.";
  if (!v.accountApiBase.trim()) errors.accountApiBase = "Enter the account server's address.";
  else if (!isHttpUrl(v.accountApiBase.trim())) errors.accountApiBase = "Enter a full address starting with https://";
  if (v.apiBase.trim() && !isHttpUrl(v.apiBase.trim())) errors.apiBase = "Enter a full address starting with https://";
  return errors;
}

/** Form values -> settings, leaving out fields with a problem (they keep their saved value). */
export function parseForm(v: FormValues): Partial<Omit<ExtensionSettings, "anthropicApiKey" | "jevApiKey" | "runnerKey">> {
  const errors = validateForm(v);
  const out: Record<string, unknown> = { brain: v.brain, reasoning: v.reasoning };
  for (const k of NUMBER_FIELDS) if (!errors[k]) out[k] = Number(v[k].trim());
  for (const k of TEXT_FIELDS) {
    if (errors[k]) continue;
    const t = v[k].trim();
    out[k] = k === "apiBase" || k === "accountApiBase" ? t.replace(/\/+$/, "") : t;
  }
  for (const k of BOOL_FIELDS) out[k] = v[k];
  return out;
}
