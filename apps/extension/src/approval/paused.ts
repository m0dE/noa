/**
 * An approval a run paused for (an unattended scheduled run: nobody was there to answer its card), decided afterwards
 * in one click on that card (pure; paused-decision.ts acts on it):
 *
 * - pausedRequest(): whether a card can still be decided: its request ended "paused", nothing decided it since, and
 *   its run has not gone on (no later turn);
 * - Preapprovals: "Allow & continue" allows that exact action once for the run that goes on (the same words, which
 *   name the element and the X account it publishes as, the same site and kind, and the same text it posts). The gate
 *   still judges every action as it comes (Stop, the account guard and every other check stay): only a match skips
 *   the card, once; any other action asks as before.
 */
import { approvalPauseReason, isApprovalRefusal, type AgentEvent, type ApprovalRequest } from "@noa/shared";

/** How long an Allow & continue waits for its run to reach the action. */
export const PREAPPROVAL_TTL_MS = 30 * 60_000;

/** What an allowed action must be again. */
export type ApprovedAction = Pick<ApprovalRequest, "action" | "site" | "kind" | "text">;

/**
 * The request `id` when it can be decided now: it ended "paused" (and nothing decided it since), and the conversation
 * did not go on after the turn it paused (no message, no other turn). Null otherwise.
 */
export function pausedRequest(events: readonly AgentEvent[], id: string): ApprovalRequest | null {
  const at = events.findIndex((e) => e.type === "approval_request" && e.request.id === id);
  if (at < 0) return null;
  const ask = events[at] as Extract<AgentEvent, { type: "approval_request" }>;
  const endings = events.slice(at + 1).filter((e): e is Extract<AgentEvent, { type: "approval_resolved" }> => e.type === "approval_resolved" && e.id === id);
  if (endings.at(-1)?.outcome !== "paused") return null;
  const end = events.findIndex((e, i) => i > at && e.type === "task_end");
  if (end < 0) return null;
  const goesOn = events.slice(end + 1).some((e) => e.type === "user_message" || e.type === "task_end" || e.type === "tool_call" || e.type === "approval_request");
  return goesOn ? null : ask.request;
}

/** How the runner's line before a pause starts (engine/runner.ts). */
const PAUSING = "Pausing: ";

/**
 * Whether events[index] only repeats what the card its run paused at says: the run's "Pausing: <reason>" line, or its
 * end ("needs you" with that reason), when the reason is that card's (approvalPauseReason); or the refusal the agent
 * got for the action (its tool's error) in a turn that paused at a card.
 */
export function repeatsPausedCard(events: readonly AgentEvent[], index: number): boolean {
  const e = events[index];
  const turn = turnAround(events, index);
  if (e?.type === "tool_result") return !!e.isError && isApprovalRefusal(e.text ?? "") && turn.some((x) => x.type === "approval_resolved" && x.outcome === "paused");
  const reason = e?.type === "status" && e.text.startsWith(PAUSING) ? e.text.slice(PAUSING.length) : e?.type === "task_end" && e.outcome === "paused" ? e.reason : undefined;
  return !!reason && turn.some((x) => x.type === "approval_request" && approvalPauseReason(x.request) === reason);
}

/** The events of the turn events[index] is in: after the previous task_end, up to its own (included). */
function turnAround(events: readonly AgentEvent[], index: number): readonly AgentEvent[] {
  let start = index;
  while (start > 0 && events[start - 1]!.type !== "task_end") start--;
  let end = index;
  while (end < events.length - 1 && events[end]!.type !== "task_end") end++;
  return events.slice(start, end + 1);
}

/**
 * The action allowed, again: the same words, site and kind, and the same text when this run typed one (a conversation
 * that goes on finds the text it typed before still in the composer: it clicks without typing again).
 */
const same = (allowed: ApprovedAction, now: ApprovedAction) =>
  allowed.action === now.action && allowed.site === now.site && (allowed.kind ?? null) === (now.kind ?? null) && (now.text === undefined || (allowed.text ?? "").trim() === now.text.trim());

/** Actions allowed ahead, once each, under the keys of the run that goes on (its session, its task). */
export class Preapprovals {
  private readonly granted: { keys: Set<string>; action: ApprovedAction; until: number }[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PREAPPROVAL_TTL_MS,
  ) {}

  /** Allows `action` once for whichever run of these keys reaches it first (before PREAPPROVAL_TTL_MS). */
  grant(keys: readonly (string | null | undefined)[], action: ApprovedAction): void {
    const known = keys.filter((k): k is string => !!k);
    if (!known.length) return;
    this.drop();
    this.granted.push({ keys: new Set(known), action: { action: action.action, site: action.site, ...(action.kind ? { kind: action.kind } : {}), ...(action.text ? { text: action.text } : {}) }, until: this.now() + this.ttlMs });
  }

  /** Whether `ask` was allowed ahead for a run of these keys; the allowance is used up. */
  take(keys: readonly (string | null | undefined)[], ask: ApprovedAction): boolean {
    this.drop();
    const i = this.granted.findIndex((g) => keys.some((k) => !!k && g.keys.has(k)) && same(g.action, ask));
    if (i < 0) return false;
    this.granted.splice(i, 1);
    return true;
  }

  private drop(): void {
    const now = this.now();
    for (let i = this.granted.length - 1; i >= 0; i--) if (this.granted[i]!.until <= now) this.granted.splice(i, 1);
  }
}
