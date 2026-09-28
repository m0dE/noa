/**
 * A conversation's timing trace as the extension keeps it (one per session,
 * engine/trace-store.ts): the newest TRACE_CAPS.events trace events, and per
 * turn the totals the Raw view's summary needs, which stay right when old
 * events are dropped. Pure: the store, the tests and the Raw view share it.
 *
 * What goes in:
 * - trace events (TraceEvent) recorded by the engine, the helper and the side
 *   panel, each assigned to a turn: its own, the turn of its correlation id
 *   (the user message it led to), else the turn running;
 * - the conversation's own events (observe()), which are only counted: the
 *   stream's deltas, the first thing the agent showed after each user
 *   message ("first.response"), Jev's picks, errors and the turn's end.
 *   They are stored with the session already; nothing per token is kept.
 */
import type { AgentEvent, TraceEvent, TraceValue } from "@noa/shared";

export const TRACE_CAPS = {
  /** Newest trace events kept per conversation (older ones still count in their turn's totals). */
  events: 1000,
  /** Newest turns whose totals are kept per conversation. */
  turns: 100,
  /** Newest correlation ids (user message -> turn) remembered per conversation. */
  cids: 100,
} as const;

export interface TokenTotals {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One turn's totals. Times are epoch ms. */
export interface TurnTotals {
  turn: number;
  /** When the engine started the turn. */
  start: number;
  /** The turn's earliest event (the panel's send or voice before the engine started it): its clock starts here. */
  first: number;
  end?: number;
  outcome?: string;
  /** The first thing the agent showed in the turn (text, a tool call, or the result). */
  firstResponse?: number;
  /** Streamed text as the chat got it (batched deltas), the first and last. */
  deltas: number;
  firstDelta?: number;
  lastDelta?: number;
  /** Final text blocks, and when the last came. */
  texts: number;
  lastText?: number;
  modelCalls: number;
  modelMs: number;
  toolCalls: number;
  toolMs: number;
  jevPicks: number;
  jevMs: number;
  /** Time the user waited on voice (transcription, the sending window, speech starting): each voice event's waitMs. */
  voiceMs: number;
  userMessages: number;
  errors: number;
  tokens: TokenTotals;
  costUsd: number;
}

export interface TraceBook {
  v: 1;
  sessionId: string;
  /** The newest TRACE_CAPS.events events, in the order they were recorded. */
  events: TraceEvent[];
  /** Events dropped by the cap so far. */
  dropped: number;
  /** The newest TRACE_CAPS.turns turns, oldest first. */
  turns: TurnTotals[];
  /** The turn running, or the last one (0: none yet). */
  turn: number;
  /** Correlation id -> turn. */
  cids: Record<string, number>;
  /** A user message waiting for the agent's first response: when it was sent. */
  awaiting: number | null;
  /** The correlation id of the latest user message linked, until the agent's first response to it names it. */
  pendingCid?: string | null;
}

export function newBook(sessionId: string): TraceBook {
  return { v: 1, sessionId, events: [], dropped: 0, turns: [], turn: 0, cids: {}, awaiting: null };
}

const zeroTokens = (): TokenTotals => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

function newTurn(turn: number, t: number): TurnTotals {
  return { turn, start: t, first: t, deltas: 0, texts: 0, modelCalls: 0, modelMs: 0, toolCalls: 0, toolMs: 0, jevPicks: 0, jevMs: 0, voiceMs: 0, userMessages: 0, errors: 0, tokens: zeroTokens(), costUsd: 0 };
}

/** The totals of `turn` (null when it is older than the kept ones). */
export function turnOf(book: TraceBook, turn: number): TurnTotals | null {
  for (let i = book.turns.length - 1; i >= 0; i--) if (book.turns[i]!.turn === turn) return book.turns[i]!;
  return null;
}

/**
 * The engine started turn `turn` (1 for a new conversation). `data`: what it
 * runs with (brain, model, Jev, the message's length, voice).
 */
export function beginTurn(book: TraceBook, turn: number, t: number, data: Record<string, TraceValue> = {}): void {
  book.turn = turn;
  book.turns.push(newTurn(turn, t));
  if (book.turns.length > TRACE_CAPS.turns) book.turns.splice(0, book.turns.length - TRACE_CAPS.turns);
  // The turn's message waits for its first response.
  book.awaiting = t;
  addEvent(book, { t, cat: "turn", name: "turn.start", src: "engine", turn, data });
}

/** Remembers which turn the user message with correlation id `cid` went to (the running one). */
export function linkCid(book: TraceBook, cid: string): void {
  if (!cid || !book.turn) return;
  book.cids[cid] = book.turn;
  book.pendingCid = cid;
  const keys = Object.keys(book.cids);
  for (const k of keys.slice(0, Math.max(0, keys.length - TRACE_CAPS.cids))) delete book.cids[k];
}

/** Adds a trace event: assigns its turn, counts it in the turn's totals, keeps the newest TRACE_CAPS.events. */
export function addEvent(book: TraceBook, ev: TraceEvent): TraceEvent {
  const turn = ev.turn ?? (ev.cid !== undefined ? book.cids[ev.cid] : undefined) ?? book.turn;
  const e: TraceEvent = { ...ev, turn };
  const totals = turnOf(book, turn);
  if (totals) tally(totals, e);
  book.events.push(e);
  const over = book.events.length - TRACE_CAPS.events;
  if (over > 0) {
    book.events.splice(0, over);
    book.dropped += over;
  }
  return e;
}

const num = (v: TraceValue | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Counts a trace event in its turn's totals. */
function tally(turn: TurnTotals, e: TraceEvent): void {
  turn.first = Math.min(turn.first, e.t);
  const d = e.data ?? {};
  const ms = e.ms ?? 0;
  switch (e.cat) {
    case "model":
      if (e.name !== "model.call") break;
      turn.modelCalls++;
      turn.modelMs += ms;
      turn.tokens.in += num(d.inTokens);
      turn.tokens.out += num(d.outTokens);
      turn.tokens.cacheRead += num(d.cacheReadTokens);
      turn.tokens.cacheWrite += num(d.cacheWriteTokens);
      break;
    case "brain":
      turn.costUsd += num(d.costUsd);
      break;
    case "tool":
      turn.toolCalls++;
      turn.toolMs += ms;
      break;
    case "voice":
      turn.voiceMs += num(d.waitMs);
      break;
    case "error":
      turn.errors++;
      break;
  }
}

/** Counts one of the conversation's own events (see the file comment); `t`: when the engine got it. */
export function observe(book: TraceBook, ev: AgentEvent, t: number): void {
  const turn = turnOf(book, book.turn);
  switch (ev.type) {
    case "user_message":
      if (turn) turn.userMessages++;
      book.awaiting = t;
      return;
    case "assistant_text_delta":
      if (turn) {
        turn.deltas++;
        turn.firstDelta ??= t;
        turn.lastDelta = t;
      }
      responded(book, turn, t, "text");
      return;
    case "assistant_text":
      if (turn) {
        turn.texts++;
        turn.lastText = t;
      }
      responded(book, turn, t, "text");
      return;
    case "tool_call":
      responded(book, turn, t, "tool");
      return;
    case "jev":
      if (turn) {
        turn.jevPicks++;
        turn.jevMs += ev.ms;
      }
      return;
    case "error":
      if (turn) turn.errors++;
      return;
    case "task_end":
      responded(book, turn, t, "result");
      if (turn && turn.end === undefined) {
        turn.end = t;
        turn.outcome = ev.outcome;
        addEvent(book, { t, ms: t - turn.first, cat: "turn", name: "turn.end", src: "engine", turn: turn.turn, data: { outcome: ev.outcome } });
      }
      return;
    default:
      return;
  }
}

/** The agent showed something: the first time after a user message, that wait is recorded. */
function responded(book: TraceBook, turn: TurnTotals | null, t: number, via: string): void {
  if (turn) turn.firstResponse ??= t;
  const since = book.awaiting;
  if (since === null) return;
  book.awaiting = null;
  const cid = book.pendingCid;
  book.pendingCid = null;
  addEvent(book, { t: since, ms: t - since, cat: "stream", name: "first.response", src: "engine", ...(cid ? { cid } : {}), data: { via } });
}
