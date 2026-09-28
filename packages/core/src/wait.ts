/**
 * wait_for, for every brain (the tool executor runs it): the browser watches
 * the tab in slices (browser.waitFor, WAIT_SLICE_MS each: a MutationObserver
 * in the page, polling as a fallback) until a condition holds. Between slices
 * nothing happens but the next browser call, so the model is not called at
 * all while it waits. The wait ends at once when the user sends a message
 * (like navigate's wait for a page, see interjections.ts), when the tab is
 * closed, when its time is up, after WAIT_CALL_LIMIT_MS for one call ("still
 * waiting": the agent calls again), or shortly before the turn's time limit.
 */
import {
  DEFAULT_WAIT_MINUTES,
  errorMessage,
  WAIT_CALL_LIMIT_MS,
  WAIT_SLICE_MS,
  WAIT_TURN_MARGIN_MS,
  waitConditionText,
  waitDurationText,
  type BrowserMethod,
  type BrowserMethods,
  type Sleep,
  type ToolResult,
  type TraceValue,
  type WaitCheck,
  type WaitCheckParams,
  type WaitForArgs,
} from "@noa/shared";
import type { Interjections } from "./interjections.js";

/** Why a wait ended (the trace's `end`). */
export type WaitEnd = "met" | "timeout" | "call_limit" | "turn_limit" | "user_message" | "closed" | "error";

export interface WaitDeps {
  browser: <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
  sleep: Sleep;
  now: () => number;
  /** A message from the user the model has not read ends the wait (one already waiting too). */
  interjections?: Interjections;
  /** When the turn's time limit ends it (epoch ms); undefined: no limit known. */
  turnEndsAt?: () => number | undefined;
}

export interface WaitOutcome {
  result: ToolResult;
  /** For the tool's trace span: why it ended, how long it waited, how many slices the browser watched. */
  trace: Record<string, TraceValue>;
}

/** After a slice that answered early without the condition (the page was navigating): the first pause before asking again, and the longest. */
export const WAIT_RETRY_BACKOFF = { firstMs: 250, maxMs: 4000 };

const HEARD = Symbol("the user spoke");

export async function runWaitFor(args: WaitForArgs, deps: WaitDeps): Promise<WaitOutcome> {
  const start = deps.now();
  const requested = (args.minutes ?? DEFAULT_WAIT_MINUTES) * 60_000;
  const endsAt = deps.turnEndsAt?.();
  const turnLeft = endsAt === undefined ? Infinity : Math.max(0, endsAt - start - WAIT_TURN_MARGIN_MS);
  const limit = Math.min(requested, WAIT_CALL_LIMIT_MS, turnLeft);
  const cutBy: WaitEnd = limit === requested ? "timeout" : limit === turnLeft ? "turn_limit" : "call_limit";

  const heard = deps.interjections?.spoken();
  const userSpoke: Promise<typeof HEARD> = heard ? heard.when.then(() => HEARD) : new Promise(() => {});
  let baseline: string | undefined;
  let last: WaitCheck | null = null;
  let checks = 0;
  let backoff = WAIT_RETRY_BACKOFF.firstMs;
  let end: WaitEnd;
  let failure = "";
  try {
    for (;;) {
      const left = start + limit - deps.now();
      if (left <= 0) {
        end = cutBy;
        break;
      }
      const slice = Math.min(WAIT_SLICE_MS, left);
      const params: WaitCheckParams = { until: args.until, timeoutMs: slice };
      if (args.tab !== undefined) params.tab = args.tab;
      if (baseline !== undefined) params.baseline = baseline;
      const asked = deps.now();
      const check = deps.browser("browser.waitFor", params);
      const r = await Promise.race([check, userSpoke]);
      if (r === HEARD) {
        // The slice ends by itself in the browser; its answer is not needed any more.
        check.catch(() => undefined);
        end = "user_message";
        break;
      }
      checks++;
      last = r;
      baseline ??= r.fingerprint;
      if (r.closed) {
        end = "closed";
        break;
      }
      if (r.met !== null) {
        end = "met";
        break;
      }
      if (deps.now() - asked >= slice / 2) {
        backoff = WAIT_RETRY_BACKOFF.firstMs;
        continue;
      }
      const paused = await Promise.race([deps.sleep(backoff), userSpoke]);
      if (paused === HEARD) {
        end = "user_message";
        break;
      }
      backoff = Math.min(backoff * 2, WAIT_RETRY_BACKOFF.maxMs);
    }
  } catch (e) {
    end = "error";
    failure = errorMessage(e);
  } finally {
    heard?.cancel();
  }

  const waited = deps.now() - start;
  const trace: Record<string, TraceValue> = { end, waitedMs: Math.round(waited), checks, minutes: requested / 60_000 };
  if (last?.met != null) trace.met = waitConditionText(args.until[last.met]!);
  return { result: waitResult(end, { args, waited, requested, last, failure }), trace };
}

/** What the agent reads when the wait ends. */
function waitResult(end: WaitEnd, w: { args: WaitForArgs; waited: number; requested: number; last: WaitCheck | null; failure: string }): ToolResult {
  const tab = w.args.tab ?? "the current tab";
  const after = waitDurationText(w.waited);
  const where = w.last ? `${tab}: ${w.last.url}${w.last.title ? ` "${w.last.title}"` : ""}` : tab;
  const wanted = w.args.until.map(waitConditionText).join("; or ");
  switch (end) {
    case "met":
      return { text: `Condition met after ${after}: ${waitConditionText(w.args.until[w.last!.met!]!)} (${where}). Read the page (read_page) to see it.` };
    case "timeout":
      return { text: `Not met after ${after}, the time you gave: ${wanted} (${where}). Check the page (read_page), wait again, or tell the user.` };
    case "call_limit": {
      const minutesLeft = Math.max(1, Math.ceil((w.requested - w.waited) / 60_000));
      return {
        text: `Still waiting after ${after} (one call waits at most ${WAIT_CALL_LIMIT_MS / 60_000} minutes); not met yet: ${wanted} (${where}). To keep waiting, call wait_for again with the same until and minutes: ${minutesLeft}.`,
      };
    }
    case "turn_limit":
      return {
        text: `Stopped waiting after ${after}: this turn's time limit is near. Not met yet: ${wanted} (${where}). Tell the user what you are waiting for and end the turn with task_pause, so they can continue later.`,
      };
    case "user_message":
      return { text: `Stopped waiting after ${after}: the user sent you a message (it follows). Not met yet: ${wanted}.` };
    case "closed":
      return { text: `Stopped waiting after ${after}: ${tab} was closed.`, isError: true };
    case "error":
      return { text: `Stopped waiting after ${after}: ${w.failure}`, isError: true };
  }
}
