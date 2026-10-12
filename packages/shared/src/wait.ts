/**
 * wait_for: the agent waits for something to happen in a tab (a build to
 * finish, a reply to arrive, a status to change) without any model call. The
 * extension watches the page (a MutationObserver, with polling as a fallback)
 * and answers when a condition holds; the core's wait loop (core/src/wait.ts)
 * asks it in slices, so a message from the user, a closed tab or the turn's
 * time limit ends the wait within moments. What the tool, the loop and the
 * extension share: the conditions, the limits and how they read.
 */
import { z } from "zod";

/** The longest wait the agent may ask for, in minutes. */
export const MAX_WAIT_MINUTES = 30;
/** The wait when the agent gives no `minutes`. */
export const DEFAULT_WAIT_MINUTES = 5;
/**
 * The most one wait_for call waits; a longer wait answers "still waiting" and the agent calls again. It stays
 * well inside the brains' limits on one tool call (the helper's TOOL_CALL_TIMEOUT_MS; Claude Code was measured to
 * wait out a 16-minute MCP call), and costs one short model call per WAIT_CALL_LIMIT_MS at most.
 */
export const WAIT_CALL_LIMIT_MS = 10 * 60_000;
/**
 * How long one browser.waitFor watches the page before it answers (not met yet): the loop then asks again. Short,
 * so a wait ends soon after the user writes or the turn ends, and inside the helper's per-browser-call timeout.
 */
export const WAIT_SLICE_MS = 15_000;
/** A wait stops this long before the turn's time limit, so the agent can still say what it was waiting for. */
export const WAIT_TURN_MARGIN_MS = 60_000;
/** page_changed: the page counts as settled once nothing in it changed for this long. */
export const PAGE_SETTLE_MS = 2000;
/** Most conditions in one wait_for (any one of them ends the wait). */
export const MAX_WAIT_CONDITIONS = 5;

export const WaitConditionKind = z.enum(["text_appears", "text_gone", "url_matches", "element", "page_changed"]);
export type WaitConditionKind = z.infer<typeof WaitConditionKind>;

export const ElementWaitState = z.enum(["visible", "hidden", "enabled", "disabled"]);
export type ElementWaitState = z.infer<typeof ElementWaitState>;

export const WaitCondition = z
  .object({
    kind: WaitConditionKind.describe(
      "text_appears / text_gone: `text` shows on the page (or no longer does). url_matches: the tab's URL contains `text`, or matches it as a regular expression written /like this/. element: the element named by `text` (its visible label) or `selector` reaches `state`. page_changed: the page's text or URL changes from how it is now and then stops changing",
    ),
    text: z.string().trim().min(1).max(300).optional().describe("The text to look for (case and spacing do not matter), the URL part or /regex/, or an element's visible label"),
    selector: z.string().trim().min(1).max(300).optional().describe("A CSS selector: for text_appears / text_gone, only text inside it counts; for element, the element itself"),
    state: ElementWaitState.optional().describe("element only: visible (default), hidden, enabled or disabled"),
  })
  .superRefine((c, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: "custom", message });
    if (c.kind === "text_appears" || c.kind === "text_gone" || c.kind === "url_matches") need(!!c.text, `${c.kind} needs text`);
    if (c.kind === "element") need(!!c.text || !!c.selector, "element needs text (its label) or selector");
    if (c.kind !== "element") need(c.state === undefined, "state is only for element");
    if (c.kind === "url_matches" && c.text && isRegexText(c.text)) need(regexOf(c.text) !== null, `"${c.text}" is not a valid regular expression`);
  });
export type WaitCondition = z.infer<typeof WaitCondition>;

export const WaitForArgs = z.object({
  until: z.array(WaitCondition).min(1).max(MAX_WAIT_CONDITIONS).describe("What to wait for; the wait ends as soon as any one of them holds"),
  tab: z.string().optional().describe("Tab id to watch (from open_tabs or list_tabs), e.g. t3. Default: the current tab. It is watched in the background: the current tab does not change"),
  minutes: z
    .number()
    .positive()
    .max(MAX_WAIT_MINUTES)
    .optional()
    .describe(`How long to wait at most, in minutes (default ${DEFAULT_WAIT_MINUTES}, at most ${MAX_WAIT_MINUTES})`),
});
export type WaitForArgs = z.infer<typeof WaitForArgs>;

export const WAIT_FOR_DESCRIPTION = `Wait, without reading the page again and again, until something happens in a tab: text appears or goes away, the URL matches, an element becomes visible, hidden, enabled or disabled, or the page changes and settles. The browser watches the page (no model calls) and answers as soon as any condition holds, when the time is up, when the user sends a message, or when the tab is closed. For waits of minutes (a build or deploy, a reply, a status change). One call waits at most ${WAIT_CALL_LIMIT_MS / 60_000} minutes: a longer wait answers "still waiting" and you call it again.`;

/** browser.waitFor: one slice of a wait, watched in the page (see WAIT_SLICE_MS). */
export interface WaitCheckParams {
  /** Short tab id; default the current tab. */
  tab?: string;
  until: WaitCondition[];
  /** How long this slice watches before it answers (at most WAIT_SLICE_MS). */
  timeoutMs: number;
  /** page_changed: the page as it was when the wait began (the first slice's `fingerprint`). */
  baseline?: string;
}

export interface WaitCheck {
  /** The index in `until` of the condition that holds, or null (not yet). */
  met: number | null;
  /** The tab was closed. */
  closed?: boolean;
  url: string;
  title: string;
  /** The page as the slice first saw it (page_changed compares later pages with it); absent when it could not be read. */
  fingerprint?: string;
}

/** A url_matches text written as a regular expression: /.../ with optional flags. */
function isRegexText(text: string): boolean {
  return /^\/.+\/[a-z]*$/.test(text);
}

function regexOf(text: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(text);
  try {
    return m ? new RegExp(m[1]!, m[2]) : null;
  } catch {
    return null;
  }
}

/** Whether a URL matches a url_matches text: /regex/, or a part of the URL (case-insensitive). */
export function urlMatches(pattern: string, url: string): boolean {
  if (isRegexText(pattern)) return regexOf(pattern)?.test(url) ?? false;
  return url.toLowerCase().includes(pattern.toLowerCase());
}

/** A condition in plain words, for the agent and the chat: `text "Deployed" appears`. */
export function waitConditionText(c: WaitCondition): string {
  const inside = c.selector ? ` in ${c.selector}` : "";
  switch (c.kind) {
    case "text_appears":
      return `text "${c.text}" appears${inside}`;
    case "text_gone":
      return `text "${c.text}" is gone${inside}`;
    case "url_matches":
      return `the URL matches "${c.text}"`;
    case "element":
      return `the element ${c.text ? `"${c.text}"` : c.selector} is ${c.state ?? "visible"}`;
    case "page_changed":
      return "the page changes and settles";
  }
}

/** A wait's length as the agent reads it: "45 s", "3 min 05 s". */
export function waitDurationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
