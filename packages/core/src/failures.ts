/**
 * Sorts failure reasons into temporary (retry later) and permanent. Reasons
 * the agents produce themselves are known by identity; patterns are only for
 * text from elsewhere (HTTP and network errors, Claude Code, Chrome).
 */
import type { FailureKind } from "./types.js";

/** The agent's turn ended (it stopped, or went idle) without a task_* call. */
export const ENDED_WITHOUT_RESULT = "Agent ended its turn without reporting a result";
/** The agent process exited without a task_* call. */
export const EXITED_WITHOUT_RESULT = "Agent exited without reporting a result";
/** The model refused the task. */
export const CLAUDE_DECLINED = "Claude declined the task";
/** The agent crashed. */
export const agentError = (detail: string) => `Agent error: ${detail}`;

/** Our own reasons worth another attempt. Every other reason we produce is permanent. */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set([ENDED_WITHOUT_RESULT, EXITED_WITHOUT_RESULT]);

/** Foreign error text that means "try again later". */
const TRANSIENT_TEXT: RegExp[] = [
  // Usage and rate limits, overload.
  /\b429\b/,
  /\b529\b/,
  /rate[ _-]?limit/i,
  /usage[ _-]?limit/i,
  /overloaded/i,
  /too many requests/i,
  // Server-side errors reported as HTTP 5xx.
  /\bHTTP 5\d\d\b/i,
  /\b50[234]\b.*\b(bad gateway|unavailable|gateway)\b/i,
  // Network problems.
  /\bECONN[A-Z]*\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /fetch failed/i,
  /network ?error/i,
  /failed to fetch/i,
  /socket hang up/i,
  /\btimeout\b/i,
  /timed out/i,
];

const DEBUGGER_DETACHED = /debugger (was )?detached/i;
const BY_USER = /by (the )?user|canceled_by_user|cancelled by user/i;

export function classifyFailure(reason: string): FailureKind {
  const r = reason ?? "";
  if (TRANSIENT_REASONS.has(r)) return "transient";
  if (DEBUGGER_DETACHED.test(r)) return BY_USER.test(r) ? "permanent" : "transient";
  return TRANSIENT_TEXT.some((re) => re.test(r)) ? "transient" : "permanent";
}
