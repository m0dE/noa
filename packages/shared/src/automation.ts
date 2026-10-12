/**
 * How much the chat agent may do on its own, and the approval requests it
 * makes when it may not. The extension enforces this before each browser
 * action (apps/extension/src/approval/); the prompts only tell the agent the
 * level so it can plan (e.g. one approval for one final Post click).
 */
import { z } from "zod";
import type { BrowserMethod } from "./browser.js";

/**
 * Chat runs. ask_all: every action that changes something (click, type, key,
 * upload, navigation, tabs) waits for the user's OK; reading never does.
 * ask_consequential: only actions that publish, send, pay, delete, submit a
 * binding form or change account settings wait (the default). full: no
 * approvals at all.
 */
export const AutomationLevel = z.enum(["ask_all", "ask_consequential", "full"]);
export type AutomationLevel = z.infer<typeof AutomationLevel>;
export const DEFAULT_AUTOMATION_LEVEL: AutomationLevel = "ask_consequential";

/**
 * Scheduled runs (the TODO list). full_within_task: the user wrote the task
 * on purpose, so what it asks for runs without approvals; a consequential
 * action the instructions do not ask for still waits. ask_consequential:
 * like chat's ask_consequential.
 */
export const ScheduledAutomation = z.enum(["full_within_task", "ask_consequential"]);
export type ScheduledAutomation = z.infer<typeof ScheduledAutomation>;
export const DEFAULT_SCHEDULED_AUTOMATION: ScheduledAutomation = "full_within_task";

export interface AutomationChoice<T extends string> {
  id: T;
  label: string;
  detail: string;
  /** The choice lets the agent act with no approvals: it needs a confirmation when picked, and shows as a warning. */
  dangerous?: true;
}

/** Where these choices live: the settings tab's name, and the side panel's banner while full autonomy is on. */
export const PERMISSION_TITLE = "Permission";

/** The name of the level that never asks ("Permission: Full autonomy" in the side panel). */
export const FULL_AUTONOMY_NAME = "Full autonomy";

/** The chat levels, as Settings > Permission shows them (safest first). */
export const AUTOMATION_LEVELS: readonly AutomationChoice<AutomationLevel>[] = [
  { id: "ask_all", label: "Ask before every action", detail: "Clicks, typing, keys, uploads and opening pages each wait for your OK. Reading pages never does." },
  {
    id: "ask_consequential",
    label: "Ask before posting, sending or paying",
    detail: "Waits for your OK before it posts, sends a message, pays or buys, deletes, submits a form that commits you, or changes account settings.",
  },
  {
    id: "full",
    label: `${FULL_AUTONOMY_NAME} (dangerous)`,
    detail: "Never asks, in chats and scheduled jobs. The agent can post, send, pay and delete on its own, and a web page that tricks it can make it do so.",
    dangerous: true,
  },
];

/** The scheduled-task choices, as Settings > Permission shows them. */
export const SCHEDULED_AUTOMATION_CHOICES: readonly AutomationChoice<ScheduledAutomation>[] = [
  {
    id: "full_within_task",
    label: "Do what the task says without asking",
    detail:
      "You wrote the task, so what it asks for runs on its own. Posting, sending, paying or deleting that the task does not ask for still waits for your OK. In a task the agent scheduled, all of them wait until you press Trust on it.",
  },
  { id: "ask_consequential", label: "Ask before posting, sending or paying", detail: "Same as the chat's middle level: consequential actions wait for your OK." },
];

/** What makes an action consequential (it cannot be taken back, or commits the user). */
export type ConsequenceKind = "publish" | "send" | "pay" | "delete" | "submit" | "account" | "upload";

/** The why of an approval request, after the action: "Click "Post" on x.com: publishes". */
export const CONSEQUENCE_TEXT: Record<ConsequenceKind, string> = {
  publish: "publishes",
  send: "sends a message",
  pay: "pays or buys",
  delete: "deletes",
  submit: "submits a form that commits you",
  account: "changes account or security settings",
  upload: "sends a file from your computer",
};

/** How long an approval request waits for the user before it counts as denied (less when the turn's time limit comes first). */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * The browser methods that change something: each may wait for an approval
 * (so a caller's timeout for them must allow APPROVAL_TIMEOUT_MS more).
 * Reads, screenshots, scrolling and switching tabs never wait; of the dialog
 * answers, only OK on a confirm or prompt and Leave on "Leave site?" may.
 */
export const APPROVAL_GATED_METHODS = [
  "browser.click",
  "browser.type",
  "browser.paste",
  "browser.pressKey",
  "browser.upload",
  "browser.clickXAccountEntry",
  "browser.navigate",
  "browser.openTabs",
  "browser.closeTabs",
  "browser.handleDialog",
] as const satisfies readonly BrowserMethod[];
export type ApprovalGatedMethod = (typeof APPROVAL_GATED_METHODS)[number];

export function isApprovalGated(method: string): method is ApprovalGatedMethod {
  return (APPROVAL_GATED_METHODS as readonly string[]).includes(method);
}

/** An action the agent is about to take that waits for the user. Shown as a card in the chat. */
export interface ApprovalRequest {
  id: string;
  /** The action in plain words: `Click "Post"`, `Press Enter`, `Open example.com/delete`. */
  action: string;
  /** The site it happens on (host), "" when unknown. */
  site: string;
  /** Why it waits: what it does ("publishes"), or that every action waits at this level. */
  why: string;
  kind?: ConsequenceKind;
  /** The exact text it posts or sends (the text typed before it), when there is one. */
  text?: string;
  /** When it stops waiting (ISO); no answer by then counts as denied. */
  expiresAt: string;
}

/**
 * The user's answer on an approval card. allow_once ("Allow"): just this action; the next one asks again.
 * allow_task ("Allow all until done"): this and every later action run without asking until the agent finishes
 * what it is doing now (the turn ends); the next message or run asks again.
 */
export const ApprovalAnswer = z.enum(["allow_once", "allow_task", "deny"]);
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;

/**
 * How an approval request ended: the user's answer, no answer in time, the turn ended first (Stop, time limit),
 * the user wrote to the agent first (interrupted: the agent reads that before anything else), or nobody was
 * there to answer (paused: an unattended scheduled run pauses at once for the user's OK).
 */
export type ApprovalOutcome = ApprovalAnswer | "timeout" | "ended" | "interrupted" | "paused";

/** Where the user answered an approval: its card's buttons, the card's keys (Alt+Y / Alt+T / Alt+N), or voice. */
export type ApprovalAnsweredBy = "card" | "keyboard" | "voice";

/** What ended an approval request, for the trace: the user's answer (where), or what ended it without one. */
export type ApprovalEndedBy = ApprovalAnsweredBy | "stop" | "message" | "timeout" | "unattended" | "turn_end" | "not_shown";

/** The outcome as the card shows it once answered. */
export const APPROVAL_OUTCOME_TEXT: Record<ApprovalOutcome, string> = {
  allow_once: "Allowed",
  allow_task: "Allowed all until done",
  deny: "Denied",
  timeout: "No answer in time: not done",
  ended: "The task ended before an answer: not done",
  interrupted: "You wrote to the agent first: not done",
  paused: "Paused for your OK: not done yet. Continue the task to do it",
};

/** A run paused because nobody was there to approve an action: the reason the run, the TODO row and the notification show. */
export function approvalPauseReason(r: Pick<ApprovalRequest, "action" | "why" | "kind">): string {
  return `Needs your OK to: ${r.action} (${r.kind ? CONSEQUENCE_TEXT[r.kind] : r.why}) — open to allow`;
}

/** Starts every refusal the agent gets for an action that was not approved, so the tools can tell it apart from a failure. */
export const APPROVAL_REFUSAL_PREFIX = "Not done: the user did not approve this action.";

/** The error text for an action that was not approved. */
export function approvalRefusalText(outcome: Exclude<ApprovalOutcome, "allow_once" | "allow_task">, action: string): string {
  if (outcome === "interrupted") {
    return `${APPROVAL_REFUSAL_PREFIX} The user sent you a message before answering (${action}). Read their message first and do what it says; do this action again only if they ask for it.`;
  }
  if (outcome === "paused") {
    return `${APPROVAL_REFUSAL_PREFIX} Nobody is there to approve it now (${action}), so the task pauses until the user allows it. Stop here: don't retry it or do it another way.`;
  }
  const what =
    outcome === "deny"
      ? `The user denied it (${action}).`
      : outcome === "timeout"
        ? `No answer in time (${action}).`
        : `The task ended before the user answered (${action}).`;
  return `${APPROVAL_REFUSAL_PREFIX} ${what} Don't retry it or do it another way; ask the user what to do instead (task_pause).`;
}

/** Whether an error text is an approval refusal (see approvalRefusalText). */
export function isApprovalRefusal(text: string): boolean {
  return text.includes(APPROVAL_REFUSAL_PREFIX);
}

/** The level a run is held to: chat runs by automationLevel, scheduled ones by scheduledAutomation (unless full). */
export type EffectiveLevel = AutomationLevel | "full_within_task";

/**
 * Full autonomy never asks, in chats and scheduled jobs alike (the user chose it for everything). Otherwise a
 * scheduled run follows scheduledAutomation, and a run of a task the agent wrote (Task.agentAuthored) is held like
 * ask_consequential: its instructions are not the user's words, so they do not stand for the user's OK.
 */
export function effectiveLevel(
  s: { automationLevel: AutomationLevel; scheduledAutomation: ScheduledAutomation },
  run: { scheduled: boolean; agentAuthored?: boolean },
): EffectiveLevel {
  if (!run.scheduled || s.automationLevel === "full") return s.automationLevel;
  return run.agentAuthored ? "ask_consequential" : s.scheduledAutomation;
}

/** Said with every level that asks: the card is the question, so the agent does not ask first in words. */
const APPROVAL_CARD_NOTE =
  " The user answers on an approval card that shows the step and its text: do not ask for permission in your own words first, just do the step. If a result says the user did not approve, do not retry or work around it: ask what to do instead (task_pause).";

/** The sentence the agent's prompt carries about the level (so it plans for the approvals it will need, or knows none will come). */
export function automationPromptLine(level: EffectiveLevel): string {
  const line = levelLine(level);
  return level === "full" ? line : line + APPROVAL_CARD_NOTE;
}

function levelLine(level: EffectiveLevel): string {
  switch (level) {
    case "ask_all":
      return "Approvals: the user asked to approve every action that changes something (clicks, typing, keys, uploads, opening pages). Each such step waits for their OK, so plan few steps, and fill a form in one act call.";
    case "ask_consequential":
      return "Approvals: actions that publish, send, pay, delete, submit a binding form or change account settings wait for the user's OK. Prepare everything first (write the whole text), then do the one final step, so the user approves once.";
    case "full_within_task":
      return "Approvals: this task runs on its own, but an action that publishes, sends, pays or deletes and that the task does not ask for waits for the user's OK. Do only what the task asks.";
    case "full":
      return "Approvals: the user chose full autonomy: nothing you do waits for their OK. When the request is clear, carry it out now; never stop to propose a plan or to ask them to confirm one.";
  }
}
