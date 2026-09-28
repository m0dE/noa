/**
 * Which brain runs tasks right now:
 * - noa: the hosted "Noa AI"; signed in with usage credit left
 *   or an active paid plan.
 * - claude-code: helper connected, Claude Code found, self-test passed.
 * - claude-api: an Anthropic API key is set.
 * - auto: the user's own Claude first (claude-code, else claude-api), else
 *   Noa, else nothing.
 * This is the one place the order lives: the runner and the settings page's
 * "Right now this picks ..." both ask it.
 */
import type { BrainKind, ExtensionSettings, HelperInfo } from "@noa/shared";
import { HELPER_NOT_INSTALLED } from "../helper-link.js";
import type { BrainStatus } from "../ui-protocol.js";

export interface BrainInputs {
  settings: Pick<ExtensionSettings, "brain" | "anthropicApiKey" | "jevApiKey" | "jevEnabled">;
  helper: HelperInfo | null;
  helperError?: string | null;
  /** The Noa account (null or absent: signed out). */
  account?: { signedIn: boolean; hostedUsable: boolean; outOfCredit?: boolean } | null;
}

/** What the hosted brain is called. */
export const HOSTED_LABEL = "Noa AI";
export const HOSTED_SIGN_IN = `Sign in to use ${HOSTED_LABEL}`;
export const HOSTED_NO_CREDIT = `Out of usage credit: subscribe or top up to use ${HOSTED_LABEL}`;
/** No brain can run tasks (the status note says why, when there is one). */
export const NO_AI = "No AI set up";
/** Auto would move a conversation from the user's own Claude Code to the paid hosted AI: it refuses instead. */
export const CLAUDE_CODE_GONE = `Local Claude Code is not available, and Auto does not move this chat to ${HOSTED_LABEL} on its own`;


/** Why the hosted AI cannot be used, or null when it can. */
function hostedProblem(account: BrainInputs["account"]): string | null {
  if (!account?.signedIn) return HOSTED_SIGN_IN;
  if (!account.hostedUsable) return HOSTED_NO_CREDIT;
  return null;
}

/** Why local Claude Code cannot be used, or null when it can. */
function claudeCodeProblem(helper: HelperInfo | null, helperError?: string | null): string | null {
  if (!helper) return helperError || "Helper not connected";
  if (helper.brain === "scripted") return null;
  if (!helper.claudePath) return "Claude Code not found";
  if (!helper.selfTest) return "Claude Code self-test not run yet";
  if (!helper.selfTest.ok) return `Claude Code self-test failed${helper.selfTest.error ? `: ${helper.selfTest.error}` : ""}`;
  return null;
}

/**
 * The note when no brain works: what to do next. With the helper connected
 * the local Claude Code problem is the one to fix; without it, the choices.
 */
function nothingUsable(inputs: BrainInputs, ccProblem: string): string {
  const head = inputs.account?.signedIn ? "Out of credit" : NO_AI;
  if (inputs.helper) return `${head}: ${ccProblem}.`;
  const helperErr = inputs.helperError;
  const helperStep = !helperErr || helperErr === HELPER_NOT_INSTALLED ? "Install the helper" : "Reconnect the helper";
  const last = inputs.account?.signedIn ? "top up" : "log in";
  return `${head}. ${helperStep}, add a Claude API key, or ${last}.`;
}

/**
 * Where a brain's Jev comes from without a Jev key in Settings: "hosted", the
 * hosted AI's own (/v1/ai/jev; a key here is not used); "helper", the
 * helper's own key (TYPESAFE_API_KEY in its environment; a key here takes
 * priority); null, nowhere (Jev needs the user's key). The runner's
 * jevActive, the settings page and its Test Jev button all ask this.
 */
export function builtInJev(brain: BrainKind | null, helper: HelperInfo | null): "hosted" | "helper" | null {
  if (brain === "noa") return "hosted";
  if (brain === "claude-code" && helper?.jevAvailable) return "helper";
  return null;
}

function jevActiveFor(brain: BrainKind | null, inputs: BrainInputs): boolean {
  const s = inputs.settings;
  if (!s.jevEnabled || !brain) return false;
  return !!s.jevApiKey || !!builtInJev(brain, inputs.helper);
}

/**
 * Whether a run with these settings may use Claude Code, so the helper
 * should be connected first: when it is chosen, and in Auto (it comes first).
 */
export function needsHelper(settings: Pick<ExtensionSettings, "brain">): boolean {
  return settings.brain === "claude-code" || settings.brain === "auto";
}

/**
 * Why the next turn of a conversation must not run on `next`, or null when it
 * may: Auto never moves a chat from the user's own Claude Code to the paid
 * hosted AI by itself (e.g. after the helper disconnected), since that costs
 * the user money. A chosen brain, or a new chat, resolves as usual.
 */
export function autoSwitchRefusal(mode: ExtensionSettings["brain"], from: BrainKind, next: BrainKind): string | null {
  return mode === "auto" && from === "claude-code" && next === "noa" ? CLAUDE_CODE_GONE : null;
}

export function resolveBrain(inputs: BrainInputs): BrainStatus {
  const { settings, helper } = inputs;
  const hasApiKey = !!settings.anthropicApiKey;
  const ccProblem = claudeCodeProblem(helper, inputs.helperError);
  const hosted = hostedProblem(inputs.account);
  let effective: BrainKind | null = null;
  let note: string | undefined;
  switch (settings.brain) {
    case "noa":
      if (!hosted) effective = "noa";
      else note = hosted;
      break;
    case "claude-code":
      if (!ccProblem) effective = "claude-code";
      else note = ccProblem;
      break;
    case "claude-api":
      if (hasApiKey) effective = "claude-api";
      else note = "No Claude API key set";
      break;
    default:
      // The user's own Claude first, then the hosted AI.
      if (!ccProblem) effective = "claude-code";
      else if (hasApiKey) effective = "claude-api";
      else if (!hosted) effective = "noa";
      else note = nothingUsable(inputs, ccProblem);
      // The helper is there but Claude Code does not work: say why another brain runs.
      if (effective && effective !== "claude-code" && helper) note = `Using ${effective === "claude-api" ? "the Claude API key" : HOSTED_LABEL} (${ccProblem})`;
  }
  const status: BrainStatus = {
    effective,
    helper,
    hasApiKey,
    jevActive: jevActiveFor(effective, inputs),
  };
  if (note) status.note = note;
  if (!helper && inputs.helperError) status.helperError = inputs.helperError;
  return status;
}
