/**
 * Every failure the side panel shows, in plain words with the button that
 * fixes it: one short line, at most one short second line, up to two fixes,
 * whether trying again may help, and the technical text for Details. The
 * chat's error cards, its end cards, the composer's message line and the
 * header's status line all read errors through `errorHelp`. Pure.
 *
 * The texts come from the brains, the helper link, the account server and
 * Chrome. Our own texts are matched by their constants; foreign ones (HTTP,
 * network, Chrome) by pattern.
 */
import {
  HOSTED_AI_UNAVAILABLE,
  HOSTED_AI_UNAVAILABLE_CODE,
  NOT_SET_UP,
  OUT_OF_CREDIT,
  PLAN_REQUIRED,
  PLAN_REQUIRED_MESSAGES,
  SCHEDULE_PLAN_REQUIRED,
  SCHEDULE_SIGN_IN,
} from "@noa/shared";
import { CLAUDE_CODE_GONE, HOSTED_LABEL, HOSTED_NO_CREDIT, HOSTED_SIGN_IN, NO_AI } from "../engine/brain-resolver.js";
import { HELPER_NOT_INSTALLED } from "../helper-link.js";

/** What a fix button does (the side panel binds each kind to its action, see error-view.ts). */
export type ErrorFixKind = "own-claude" | "claude-code" | "api-key" | "set-up-ai" | "use-hosted" | "topup" | "plans" | "login" | "new-tab";

export interface ErrorFix {
  kind: ErrorFixKind;
  label: string;
  /** The button's tooltip: where it goes. */
  title: string;
}

export interface ErrorHelp {
  /** One short plain line: no status codes, no vendor jargon. */
  message: string;
  /** At most one short second line. */
  hint?: string;
  /** The buttons that fix it, the main one first (at most two). */
  fixes: ErrorFix[];
  /** Trying again may work (a Retry is offered where the run can go on). */
  retry: boolean;
  /** The original text, behind Details, when the message does not already say all of it. */
  details?: string;
  /** False for an error this module does not recognize (the message is then generic). */
  known: boolean;
}

export const FIXES = {
  ownClaude: { kind: "own-claude", label: "Use your own Claude", title: "Set up Local Claude Code or a Claude API key in Settings" },
  claudeCode: { kind: "claude-code", label: "Set up Claude Code", title: "Install or reconnect the helper for Local Claude Code in Settings" },
  apiKey: { kind: "api-key", label: "Add API key", title: "Enter your Claude API key in Settings" },
  setUpAi: { kind: "set-up-ai", label: "Set up AI", title: "Choose how Noa thinks: your own Claude or Noa AI" },
  useHosted: { kind: "use-hosted", label: `Use ${HOSTED_LABEL}`, title: `Switch to ${HOSTED_LABEL}, paid from your usage credit` },
  topup: { kind: "topup", label: "Top up", title: "Buy usage credit on the dashboard" },
  plans: { kind: "plans", label: "Choose a plan", title: "Pick a plan on the dashboard" },
  login: { kind: "login", label: "Log in", title: "Log in with Google" },
  newTab: { kind: "new-tab", label: "Open a new tab", title: "Open a new tab and go to the site you want" },
} as const satisfies Record<string, ErrorFix>;

const WAIT_A_MINUTE = "Wait a minute, then retry.";

interface Rule {
  test: (text: string) => boolean;
  help: (text: string) => Omit<ErrorHelp, "details" | "known">;
}

const has = (re: RegExp) => (t: string) => re.test(t);
const startsWith = (prefix: string) => (t: string) => t.startsWith(prefix);

/** "retry in 12 s", "try again in 3 minutes": the wait a server asked for. */
function waitHint(text: string): string {
  const m = /(?:retry|try again|retrying)[^\d]{0,12}(\d+)\s*(s|sec|seconds?|m|min|minutes?)\b/i.exec(text);
  if (!m) return WAIT_A_MINUTE;
  const unit = m[2]!.toLowerCase().startsWith("m") ? "min" : "s";
  return `Wait ${m[1]} ${unit}, then retry.`;
}

/** First match wins: the specific before the general. */
const RULES: Rule[] = [
  {
    test: (t) => t.startsWith(HOSTED_AI_UNAVAILABLE) || t.includes(HOSTED_AI_UNAVAILABLE_CODE) || t.includes(NOT_SET_UP.hostedAi),
    help: () => ({ message: `${HOSTED_LABEL} is unavailable right now.`, hint: "Try again later, or use your own Claude.", fixes: [FIXES.ownClaude], retry: true }),
  },
  {
    test: (t) => t.startsWith(OUT_OF_CREDIT) || t === HOSTED_NO_CREDIT || /^out of credit\b/i.test(t),
    help: () => ({ message: "You're out of usage credit.", hint: "Top up, or use your own Claude.", fixes: [FIXES.topup, FIXES.ownClaude], retry: true }),
  },
  {
    // schedule_task on a plan without the TODO list (engine/schedule-task.ts).
    test: startsWith(SCHEDULE_PLAN_REQUIRED),
    help: () => ({ message: SCHEDULE_PLAN_REQUIRED, fixes: [FIXES.plans], retry: false }),
  },
  {
    test: (t) => t.includes(PLAN_REQUIRED) || Object.values(PLAN_REQUIRED_MESSAGES).some((m) => t.includes(m)),
    help: (t) => ({ message: Object.values(PLAN_REQUIRED_MESSAGES).find((m) => t.includes(m)) ?? "This needs a paid plan.", fixes: [FIXES.plans], retry: false }),
  },
  {
    // schedule_task while signed out: the TODO list is the account's.
    test: startsWith(SCHEDULE_SIGN_IN),
    help: () => ({ message: "You're not logged in.", hint: "Log in to schedule tasks.", fixes: [FIXES.login], retry: false }),
  },
  {
    test: startsWith(CLAUDE_CODE_GONE),
    help: () => ({
      message: "Local Claude Code isn't connected.",
      hint: `Auto won't switch this chat to paid ${HOSTED_LABEL}.`,
      fixes: [FIXES.claudeCode, FIXES.useHosted],
      retry: true,
    }),
  },
  {
    test: (t) => t === HOSTED_SIGN_IN || /\bnot signed in\b|rejected the sign-in|session (has )?expired|sign in again/i.test(t),
    help: () => ({ message: "You're not logged in.", hint: `Log in to use ${HOSTED_LABEL}.`, fixes: [FIXES.login], retry: true }),
  },
  {
    test: startsWith(HELPER_NOT_INSTALLED),
    help: () => ({ message: "The Claude Code helper isn't installed.", fixes: [FIXES.claudeCode], retry: false }),
  },
  {
    test: has(/^helper (disconnected|not connected|exited|crashed|error)|helper installed for another/i),
    help: () => ({ message: "Local Claude Code isn't connected.", fixes: [FIXES.claudeCode, FIXES.useHosted], retry: true }),
  },
  {
    test: has(/^claude code (not found|self-test)/i),
    help: (t) => ({
      message: /not found/i.test(t) ? "Claude Code isn't installed on this computer." : "Claude Code isn't ready.",
      ...(/not logged in|login|log in/i.test(t) ? { hint: "Log in to Claude Code, then test it again." } : {}),
      fixes: [FIXES.claudeCode],
      retry: false,
    }),
  },
  {
    test: has(/^no claude api key/i),
    help: () => ({ message: "No Claude API key is set.", fixes: [FIXES.apiKey], retry: false }),
  },
  {
    test: has(/\bkey rejected\b|invalid x-api-key|authentication_error/i),
    help: () => ({ message: "Your Claude API key was refused.", hint: "Check the key in Settings.", fixes: [FIXES.apiKey], retry: false }),
  },
  {
    // "No AI set up: Claude Code self-test failed: ..." is about its reason; "No AI set up. Install ..." about the choice.
    test: startsWith(NO_AI),
    help: (t) => {
      const reason = /^:\s*(.+)$/.exec(t.slice(NO_AI.length))?.[1];
      const inner = reason ? RULES.find((r) => r.test(reason)) : undefined;
      return inner ? inner.help(reason!) : { message: "No AI is set up yet.", fixes: [FIXES.setUpAi], retry: false };
    },
  },
  {
    test: has(/cannot access (contents of|a chrome)|cannot be scripted|chrome doesn't let extensions|chrome:\/\/|chrome-extension:\/\//i),
    help: () => ({ message: "Chrome blocks extensions on this page.", hint: "Open a normal web page and try again.", fixes: [FIXES.newTab], retry: true }),
  },
  {
    test: has(/rate[ _-]?limit|usage[ _-]?limit|too many (hosted ai )?requests|\b429\b/i),
    help: (t) => ({ message: "Too many requests right now.", hint: waitHint(t), fixes: [], retry: true }),
  },
  {
    test: has(/overloaded|\b529\b/i),
    help: () => ({ message: "Claude is overloaded right now.", hint: WAIT_A_MINUTE, fixes: [], retry: true }),
  },
  {
    test: has(/network error|failed to fetch|fetch failed|networkerror|\bECONN[A-Z]*\b|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|\btimeout\b|not reachable|unreachable/i),
    help: () => ({ message: "Couldn't reach the server.", hint: "Check your connection, then retry.", fixes: [], retry: true }),
  },
  {
    test: has(/server error|\bHTTP 5\d\d\b|unreadable response/i),
    help: () => ({ message: "The AI service had a problem.", hint: WAIT_A_MINUTE, fixes: [], retry: true }),
  },
];

/** The plain words and fixes for an error text (an error event, a failed turn's reason, a refused request). */
export function errorHelp(text: string): ErrorHelp {
  const raw = text.trim();
  const rule = RULES.find((r) => r.test(raw));
  if (!rule) return { message: "Something went wrong.", fixes: [], retry: true, known: false, ...(raw ? { details: raw } : {}) };
  const h = rule.help(raw);
  const help: ErrorHelp = { message: h.message, fixes: h.fixes, retry: h.retry, known: true };
  if (h.hint) help.hint = h.hint;
  // The technical text is kept behind Details unless the message already is it.
  if (raw && raw !== h.message && `${raw}.` !== h.message) help.details = raw;
  return help;
}
