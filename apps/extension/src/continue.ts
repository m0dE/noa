/**
 * Continuing a conversation: which runs "Continue" applies to, and the
 * instructions for a fresh agent session that picks up a conversation whose
 * own session is gone (what was done so far, how it ended, the new message).
 * Pure; shared by the background runner and the side panel.
 */
import { bareToolName, normalizeHandle, type SessionInfo, type StampedAgentEvent, type TaskOutcome } from "@noa/shared";
import { clip, toolArgsSummary } from "./text.js";

/** How many earlier steps the continuation instructions list. */
const CONTINUE_STEPS = 15;

const CONTINUABLE: readonly TaskOutcome[] = ["paused", "failed", "retry"];

/** An outcome a run can be continued from. */
export function isContinuableOutcome(outcome: TaskOutcome | undefined): boolean {
  return !!outcome && CONTINUABLE.includes(outcome);
}

function argsOf(name: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  // Typed text matters most for not typing it twice: keep more of it.
  if ((name === "type" || name === "paste") && typeof a.text === "string") {
    const where = a.index !== undefined ? `#${String(a.index)} ` : "";
    return `${where}"${clip(a.text, 600)}"`;
  }
  return toolArgsSummary(name, args, 160);
}

/**
 * A compact list of what a run did: tool calls with short arguments and the
 * first line of their results, plus what the user typed. Oldest first, the
 * last `max` entries. `skipped` counts the older ones left out.
 */
export function doneSoFar(events: readonly StampedAgentEvent[], max = CONTINUE_STEPS): { steps: string[]; skipped: number } {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const e of events) {
    if (e.type === "tool_result") {
      const line = (e.text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? (e.thumbnail ? "(screenshot)" : "");
      results.set(e.id, { text: clip(line, 140), isError: !!e.isError });
    }
  }
  const all: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call") {
      const name = bareToolName(e.name);
      const args = argsOf(name, e.args);
      const r = results.get(e.id);
      const out = r ? ` → ${r.isError ? "error: " : ""}${r.text || "ok"}` : " → (no result)";
      all.push(`${name}${args ? ` ${args}` : ""}${out}`);
    } else if (e.type === "user_message") {
      all.push(`the user said: "${clip(e.text, 300)}"`);
    }
  }
  const steps = all.slice(-max);
  return { steps, skipped: all.length - steps.length };
}

/** The last thing the agent wrote in the run, if anything. */
export function lastAssistantText(events: readonly StampedAgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant_text" && e.text.trim()) return clip(e.text, 600);
  }
  return null;
}

/** Why the run stopped, in words. */
export function stopReason(s: Pick<SessionInfo, "outcome" | "reason">): string {
  if (s.reason?.trim()) return s.reason.trim();
  switch (s.outcome) {
    case "paused":
      return "it paused for the user";
    case "retry":
      return "a temporary problem";
    case "failed":
      return "it failed";
    default:
      return "unknown";
  }
}

/** The events of the conversation's last turn: after the task_end that closed the turn before it. */
export function lastTurnEvents(events: readonly StampedAgentEvent[]): StampedAgentEvent[] {
  const ends: number[] = [];
  events.forEach((e, i) => e.type === "task_end" && ends.push(i));
  const from = ends.length >= 2 ? ends[ends.length - 2]! + 1 : 0;
  return events.slice(from);
}

export interface FollowUpInput {
  /** The conversation's first request. */
  instructions: string;
  /** The conversation so far (latest turn fields: how it ended). */
  session: Pick<SessionInfo, "outcome" | "reason" | "summary" | "url">;
  events: readonly StampedAgentEvent[];
  /** The user's new message. */
  text: string;
  /** The account the conversation acts as (the task's), when it has one. */
  account?: string | null;
}

/** The X account the conversation acts as: its task's, else the one it last switched X to. */
function xAccountOf(input: FollowUpInput): string | null {
  if (input.account?.startsWith("@")) return input.account;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const e = input.events[i]!;
    if (e.type !== "tool_call" || bareToolName(e.name) !== "switch_x_account") continue;
    const handle = (e.args as { handle?: unknown } | undefined)?.handle;
    if (typeof handle === "string" && handle.trim()) return normalizeHandle(handle);
  }
  return null;
}

/**
 * Instructions for a fresh agent session that continues a conversation whose
 * own session is gone (the Claude Code session closed, or the extension
 * restarted): the first request, what was done so far, how the last turn
 * ended, then the user's new message as the request to act on now.
 */
export function buildFollowUpInstructions(input: FollowUpInput): string {
  const { steps, skipped } = doneSoFar(input.events);
  const last = lastAssistantText(input.events);
  const s = input.session;
  const lines = [
    "--- Continuing a conversation ---",
    "You are continuing an earlier conversation with the user in this browser (the earlier agent session is gone).",
    "The conversation started with this request:",
    "<<<",
    input.instructions.trim(),
    ">>>",
  ];
  if (steps.length) {
    lines.push(
      skipped
        ? `What was done so far (the last ${steps.length} steps, oldest first; ${skipped} earlier step(s) not shown):`
        : "What was done so far (oldest first):",
      ...steps.map((x) => `- ${x}`),
    );
  }
  if (s.outcome === "done") {
    lines.push(`The last request finished${s.summary ? `: ${s.summary}` : "."}${s.url ? ` (${s.url})` : ""}`);
  } else if (s.outcome) {
    lines.push(
      `The last request stopped before it finished (reason: ${stopReason(s)}).`,
      "Text it already typed into a composer is still there: do not type it again. If the post (or message) was already published, do not publish it again; use its URL.",
    );
  }
  if (last) lines.push(`The agent's last message: "${last}"`);
  const account = xAccountOf(input);
  // An earlier switch failure is not final: X may switch now, and nothing is done on X as another account.
  if (account) lines.push(`The X account: ${account}. Whatever an earlier switch_x_account said, call switch_x_account with ${account} again first, before anything else on X.`);
  lines.push(
    "",
    "The user's new message, which is what to do now:",
    "<<<",
    input.text.trim(),
    ">>>",
    "",
    "The browser tab is as the conversation left it (if it was closed, you are in a fresh tab). " +
      "Look at the current page first. Do not redo work that is already done, and never post the same thing twice.",
  );
  return lines.join("\n");
}
