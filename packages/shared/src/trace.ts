/**
 * The timing trace of a conversation: what happened and how long it took, for
 * the side panel's Raw view (and its export for the developer). Three places
 * record it on one clock (Date.now for when, performance.now deltas for how
 * long; they run on one machine): the background engine (turns, brain choice,
 * browser calls, the conversation's events), the helper (Claude Code's
 * process, each model call, its usage) and the side panel (voice).
 *
 * Brains send their trace as `trace` AgentEvents on the event stream they
 * already have; the extension keeps it apart from the conversation's events
 * (engine/sessions.ts, trace/trace-book.ts). Nothing per token is recorded:
 * streams are counted (deltas, first and last) on the event that covers them.
 */

/** Who recorded it. */
export type TraceSource = "engine" | "helper" | "panel";

/**
 * What it is about. Model, tool, jev and voice time are summed separately in
 * the Raw view's summary (act and browser are inside tool time).
 */
export type TraceCategory = "turn" | "user" | "brain" | "model" | "tool" | "act" | "jev" | "browser" | "approval" | "stream" | "voice" | "error";

export type TraceValue = string | number | boolean | null;

export interface TraceEvent {
  /** When it happened, or when it started: epoch ms (Date.now). */
  t: number;
  /** How long it took, in ms (performance.now); absent for a moment. */
  ms?: number;
  cat: TraceCategory;
  /** What it is, e.g. "model.call", "tool", "act.step", "voice.transcript". */
  name: string;
  src: TraceSource;
  /** The conversation's turn (1-based) it belongs to; the engine fills it in. */
  turn?: number;
  /** Correlation id of the user message it leads to (the panel's send or voice utterance, passed with run.message). */
  cid?: string;
  /** Small details: model, tokens, sizes, arguments (redacted and clipped by whoever records them). */
  data?: Record<string, TraceValue>;
}

/** Longest string in a trace event's data (arguments, goals, errors). */
export const MAX_TRACE_TEXT = 300;

/** `value` as one line of text (JSON for anything but a string), at most `max` characters. */
export function traceText(value: unknown, max = MAX_TRACE_TEXT): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value) ?? "";
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Milliseconds since it was made, from the monotonic clock (performance.now), to a tenth of a ms. */
export function stopwatch(): () => number {
  const start = performance.now();
  return () => Math.round((performance.now() - start) * 10) / 10;
}

/** A trace event starting now: the time, and a function that gives its duration when it ends. */
export function traceStart(): { t: number; elapsed: () => number } {
  return { t: Date.now(), elapsed: stopwatch() };
}

/** A trace event as brains and the core record it; the receiver stamps who recorded it (`src`). */
export type TraceDraft = Omit<TraceEvent, "src">;
