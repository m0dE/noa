/**
 * The approval card's view model: an action that waits for the user's OK
 * (approval_request), and, once it ended (approval_resolved, or the turn
 * ended without one), how; a card its run paused at can still be decided
 * (approval/paused.ts). Plus the card's keyboard shortcuts. Pure.
 */
import { APPROVAL_OUTCOME_TEXT, type AgentEvent, type ApprovalAnswer, type ApprovalAnsweredBy, type ApprovalOutcome } from "@noa/shared";

export interface ApprovalView {
  kind: "approval";
  id: string;
  /** `Click "Post"` */
  action: string;
  /** "x.com" ("" when unknown). */
  site: string;
  /** "publishes" */
  why: string;
  /** The exact text it posts or sends. */
  text?: string;
  expiresAt: string;
  /** Still waiting, or how it ended. */
  state: "pending" | ApprovalOutcome;
  /** How it ended, in words ("Allowed"). */
  outcome?: string;
  /** Answered by voice. */
  byVoice?: true;
  /** Its run paused here (nobody was there to answer) and it can still be decided: Allow & continue, Don't. */
  decidable?: true;
}

export function approvalView(ev: Extract<AgentEvent, { type: "approval_request" }>, ended?: { outcome: ApprovalOutcome; by?: ApprovalAnsweredBy }, decidable = false): ApprovalView {
  const r = ev.request;
  const v: ApprovalView = { kind: "approval", id: r.id, action: r.action, site: r.site, why: r.why, expiresAt: r.expiresAt, state: ended?.outcome ?? "pending" };
  if (r.text) v.text = r.text;
  if (ended) v.outcome = APPROVAL_OUTCOME_TEXT[ended.outcome];
  if (ended?.by === "voice") v.byVoice = true;
  if (decidable && ended?.outcome === "paused") v.decidable = true;
  return v;
}

/**
 * How the approval request `id` ended: its last approval_resolved (a card its run paused at may be decided after its
 * turn), else "ended" when its turn ended without one (the extension restarted while it waited); undefined while it
 * still waits.
 */
export function approvalEnding(events: readonly AgentEvent[], id: string): { outcome: ApprovalOutcome; by?: ApprovalAnsweredBy } | undefined {
  const at = events.findIndex((e) => e.type === "approval_request" && e.request.id === id);
  if (at < 0) return undefined;
  const after = events.slice(at + 1);
  const last = after.filter((e): e is Extract<AgentEvent, { type: "approval_resolved" }> => e.type === "approval_resolved" && e.id === id).at(-1);
  if (last) return last.by ? { outcome: last.outcome, by: last.by } : { outcome: last.outcome };
  return after.some((e) => e.type === "task_end") ? { outcome: "ended" } : undefined;
}

/** The card's answers and their keys: Alt+Y allow, Alt+T allow all until done, Alt+N deny. */
export const APPROVAL_KEYS: Readonly<Record<ApprovalAnswer, { code: string; label: string }>> = {
  allow_once: { code: "KeyY", label: "Alt+Y" },
  allow_task: { code: "KeyT", label: "Alt+T" },
  deny: { code: "KeyN", label: "Alt+N" },
};

/** The answer a key press gives (by the key's position, so Alt on a Mac, which types "¥", works too); null for other keys. */
export function approvalKeyOf(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ApprovalAnswer | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  for (const [answer, k] of Object.entries(APPROVAL_KEYS)) if (k.code === e.code) return answer as ApprovalAnswer;
  return null;
}

/** The answers as buttons show them, in order. */
export const APPROVAL_BUTTONS: readonly { answer: ApprovalAnswer; label: string; hint?: string }[] = [
  { answer: "allow_once", label: "Allow", hint: "Allow just this action. It asks again next time." },
  { answer: "allow_task", label: "Allow all until done", hint: "Allow this and everything else it does until it finishes what it's doing now, without asking again." },
  { answer: "deny", label: "Deny", hint: "Don't do it. The agent is told you said no." },
];

/** The line under the buttons that says what "Allow all until done" means. */
export const APPROVAL_ALLOW_ALL_NOTE = "Allow all until done: it won't ask again until it finishes what it's doing now.";

/** On a card its run paused at: go on with this action allowed once, or end the run as not done. */
export const PAUSED_BUTTONS: readonly { answer: ApprovalAnswer; label: string; hint?: string }[] = [
  { answer: "allow_once", label: "Allow & continue" },
  { answer: "deny", label: "Don't" },
];
