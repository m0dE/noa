/** Pure formatting helpers for the side panel and the options page. */
import {
  formatCents,
  hostedModel,
  OUT_OF_CREDIT,
  plural,
  type BrainKind,
  type Chip,
  type Tone,
} from "@noa/shared";
import { todoAllowed } from "../account/types.js";
import { BRAIN_LABELS, brainLabel, modelLabel } from "../ui/labels.js";
import type { AccountView, UiState } from "../ui-protocol.js";
import { NO_AI } from "../engine/brain-resolver.js";
import { errorHelp, FIXES, type ErrorFix } from "./error-help.js";


/** "Claude Code · claude-sonnet-5 · Jev on": the agent behind a conversation. */
export function sessionHeadline(s: { brain: BrainKind; model?: string; jev: boolean }): string {
  return [BRAIN_LABELS[s.brain], s.model?.trim() || "default model", s.jev ? "Jev on" : "Jev off"].join(" · ");
}

export interface StatusLine {
  tone: Tone;
  text: string;
  /** The reason as the brains put it, when `text` is its plain-words version (the tooltip). */
  title?: string;
  /**
   * The banner's button, when it has one: the fix of what is wrong (error-help.ts), or trying again to pause the
   * account's jobs for the old pause of every scheduled run (UiState.pauseMigration).
   */
  action?: ErrorFix | "retry-pause";
}

/**
 * True when the hosted AI is (or would be) the brain and the account has no
 * credit: the status line and the model chip say "Out of usage credit".
 */
export function outOfCredit(state: Pick<UiState, "brain" | "settings" | "account">): boolean {
  const a = state.account;
  if (!a?.signedIn || !a.outOfCredit) return false;
  return state.brain.effective === "noa" || state.settings.brain === "noa" || !state.brain.effective;
}

/** A problem in the status line: the plain words of error-help.ts (without the full stop) and its main fix. */
function problemLine(tone: Tone, reason: string): StatusLine {
  const help = errorHelp(reason);
  const line: StatusLine = { tone, text: help.message.replace(/\.$/, ""), action: help.fixes[0] ?? FIXES.setUpAi };
  if (reason !== help.message) line.title = reason;
  return line;
}

/** What the jobs list knows that the status line shows. */
export interface ListFacts {
  /** The account's list is locked (the plan does not include it): its jobs that wait to run and cannot. */
  lockedWaiting: number;
}

/**
 * The slim line at the top of the side panel: what stops jobs from running for the whole account (no usage credit,
 * a plan without the TODO list, no AI), once, with its fix. Nothing is paused for it: jobs run again when it is fixed.
 */
export function statusLine(state: UiState, list: ListFacts = { lockedWaiting: 0 }): StatusLine {
  if (outOfCredit(state)) return problemLine("warn", OUT_OF_CREDIT);
  if (!state.brain.effective) return problemLine("bad", state.brain.note || NO_AI);
  if (state.account?.signedIn && list.lockedWaiting > 0) {
    return { tone: "warn", text: `${plural(list.lockedWaiting, "scheduled job")} won't run on your plan`, title: "Your plan doesn't include the TODO list; the jobs are kept and run again when you subscribe.", action: FIXES.plans };
  }
  if (state.pauseMigration) {
    return {
      tone: "warn",
      text: "Your account's jobs wait until each is paused",
      title: `Scheduled runs were paused for everything before; now each job is paused on its own. Not done yet: ${state.pauseMigration}`,
      action: "retry-pause",
    };
  }
  return { tone: "ok", text: brainLabel(state.brain.effective, state.brain.jevActive) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local clock label: "today 14:30", "tomorrow 09:00", "Sep 30 09:00". */
export function clockLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const t = new Date(now);
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) return `today ${hm}`;
  if (dayDiff === 1) return `tomorrow ${hm}`;
  if (dayDiff === -1) return `yesterday ${hm}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** First non-empty line, clipped. */
export function firstLine(text: string, max = 120): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Punctuation that usually ends the sentence around a link rather than the link itself. */
const URL_TRAILING = `.,;:!?'"]}`;
const count = (s: string, c: string) => s.split(c).length - 1;

/** A URL found in running text without the sentence punctuation after it; a closing paren stays when it closes one inside the link ("Foo_(bar)"). */
export function trimUrlEnd(url: string): string {
  let u = url;
  for (;;) {
    const c = u.at(-1);
    if (c && (URL_TRAILING.includes(c) || (c === ")" && count(u, ")") > count(u, "(")))) u = u.slice(0, -1);
    else return u;
  }
}

export function outcomeChip(outcome: string | undefined): Chip {
  switch (outcome) {
    case undefined:
      return { label: "running", tone: "accent" };
    case "done":
      return { label: "done", tone: "ok" };
    case "failed":
      return { label: "failed", tone: "bad" };
    case "paused":
      return { label: "needs you", tone: "warn" };
    case "retry":
      return { label: "retry", tone: "warn" };
    default:
      return { label: outcome, tone: "muted" };
  }
}

export { bytesToBase64 } from "../base64.js";

/** "me" -> "@me"; labels that are not plain handles stay as typed. */
export function accountLabel(account: string | null | undefined): string {
  const a = account?.trim() ?? "";
  if (!a) return "";
  return /^[A-Za-z0-9_]+$/.test(a) ? `@${a}` : a;
}

export interface ModelChipInfo {
  /** "Sonnet 5 · Jev" or "Sonnet 5"; "Out of usage credit" when the hosted AI has none. */
  label: string;
  /** The hosted Noa AI runs (or would run) the next task: only its models are offered. */
  hosted: boolean;
  /** Hosted: the account's credit ("$4.21 left"), when known. */
  credit?: string;
  outOfCredit: boolean;
  model: string;
  jevActive: boolean;
  /** Whether Jev can be switched on at all (a key here, or the helper has its own). */
  jevPossible: boolean;
  jevEnabled: boolean;
}

/** What the composer's model chip shows: the model that will run, and whether Jev helps. */
export function modelChip(state: Pick<UiState, "settings" | "brain" | "account">): ModelChipInfo {
  const hosted = state.brain.effective === "noa" || (!state.brain.effective && state.settings.brain === "noa");
  const setting = state.settings.anthropicModel;
  const model = hosted ? hostedModel(setting) : setting;
  const jevActive = !!state.brain.effective && state.brain.jevActive;
  const noCredit = outOfCredit(state);
  const info: ModelChipInfo = {
    label: noCredit ? OUT_OF_CREDIT : modelLabel(model) + (jevActive ? " · Jev" : ""),
    hosted,
    outOfCredit: noCredit,
    model,
    jevActive,
    jevPossible: hosted || state.brain.jevActive || !!state.settings.jevApiKey || !!state.brain.helper?.jevAvailable,
    jevEnabled: state.settings.jevEnabled,
  };
  const credit = state.account?.signedIn ? state.account.credit : undefined;
  if (hosted && credit) info.credit = `${formatCents(credit.totalCents)} usage credit left`;
  return info;
}

/** Whether scheduling works: signed out, a plan without the TODO list, or it does. "loading": the account is not known yet. */
export type TodoGate = "loading" | "out" | "locked" | "in";

/**
 * Scheduling's gate (the Schedule sheet). locked: the last list's word (the
 * server judges the plan); before a list arrived, the plan as the account
 * view has it.
 */
export function todoGate(account: AccountView | null, listLocked: boolean | null): TodoGate {
  if (!account) return "loading";
  if (!account.signedIn) return "out";
  return (listLocked ?? !todoAllowed(account.plan)) ? "locked" : "in";
}
