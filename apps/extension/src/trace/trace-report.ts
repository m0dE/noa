/**
 * The Raw view's content, from a conversation's events and its timing trace
 * (trace-book.ts): per turn, one timeline of what happened with relative
 * times and durations (slow items flagged by SLOW_MS), a summary on top (total
 * time, time to first response, model / tool / Jev / voice time, the slowest
 * items, tokens), and the two ways out: plain text (Copy) and JSON (Download),
 * with secrets redacted and page content cut short. Pure.
 */
import { mapStrings, REDACTED } from "@noa/core";
import { APPROVAL_OUTCOME_TEXT, describeSchedule, localTimeZone, redactSecrets, SECRET_SETTING_KEYS, type AgentEvent, type ApprovalEndedBy, type AttachmentRef, formatBytes, type SessionInfo, type StampedAgentEvent, type TraceEvent, type TraceValue } from "@noa/shared";
import { TRACE_CAPS, type TokenTotals, type TraceBook, type TurnTotals } from "./trace-book.js";

/**
 * Durations at or over these are flagged slow (ms). Voice items are judged by
 * the time the user waited (their waitMs), not by how long a line was said.
 */
export const SLOW_MS = {
  /** One model call (request to its last token). */
  model: 8_000,
  /** One tool call. */
  tool: 3_000,
  /** One act step (reading the page, Jev, the action and its settle wait). */
  act: 2_000,
  /** One Jev pick. */
  jev: 1_500,
  /** One browser call (navigation, reading the page, a screenshot). */
  browser: 2_000,
  /** From the user's message to the first thing the agent showed. */
  firstResponse: 5_000,
  /** Waiting on voice: the transcript, the sending window, speech starting, the narrator's first audio. */
  voice: 1_500,
  /** Getting the brain going: picking it, Claude Code's start, the helper's setup, the tab. */
  brain: 3_000,
  /** A whole turn. */
  turn: 60_000,
} as const;

/** How many of the slowest items the summary lists. */
export const SLOWEST_COUNT = 5;

/** Longest text of each kind in the view and the export (page content is cut much shorter than what the user wrote). */
export const TEXT_LIMITS = { message: 1_000, answer: 1_500, result: 300, status: 300 } as const;

export interface TraceRow {
  /** Epoch ms. */
  t: number;
  /** Milliseconds since the turn's first event. */
  rel: number;
  /** A conversation event, or a timing from the trace. */
  kind: "event" | "trace";
  /** The trace category, or the event's type. */
  cat: string;
  /** The trace event's name, or the event's type. */
  name: string;
  label: string;
  /** One line of details (sizes, tokens, arguments). */
  detail?: string;
  /** What was said or shown (conversation events), cut short. */
  text?: string;
  ms?: number;
  /** The part of `ms` the user waited (voice). */
  wait?: number;
  slow: boolean;
  error?: true;
  src?: string;
  /** The user message it belongs to (trace events that carry one). */
  cid?: string;
  data?: Record<string, TraceValue>;
}

export interface TurnReport {
  turn: number;
  /** The turn's first event (epoch ms). */
  start: number;
  end?: number;
  /** First event to the turn's end (to now while it runs). */
  ms: number;
  running: boolean;
  outcome?: string;
  /** From the turn's first event to the first thing the agent showed. */
  firstResponseMs?: number;
  /** From the end of the user's speech (a voice message) to the agent's first event for it. */
  speechToResponseMs?: number;
  totals: TurnTotals | null;
  rows: TraceRow[];
}

export interface SlowItem {
  turn: number;
  rel: number;
  label: string;
  ms: number;
}

export interface TraceSummary {
  turns: number;
  /** The turns' time added up (each from its first event to its end). */
  totalMs: number;
  /** The first turn's time to its first response, and each turn's. */
  firstResponseMs: number | null;
  firstResponses: (number | null)[];
  /** Per turn: from the end of the user's speech to the agent's first event (voice messages only). */
  speechToResponses: (number | null)[];
  modelMs: number;
  toolMs: number;
  /** Inside tool time (act steps). */
  jevMs: number;
  voiceMs: number;
  /** Turn time outside model calls, tools and voice waits: the engine, the helper, messaging, idle. */
  otherMs: number;
  modelCalls: number;
  toolCalls: number;
  jevPicks: number;
  deltas: number;
  tokens: TokenTotals;
  costUsd: number;
  slowest: SlowItem[];
  /** Trace events dropped by the cap (the totals still count them). */
  dropped: number;
  /** False for conversations from before traces were kept: only the events' times are known. */
  traced: boolean;
  /** What the Realtime narrator said (null: it did not reply in this conversation). */
  narration: NarrationAudit | null;
}

/** The narrator's replies by kind (speech: its answers to the user; ack, milestone, result, question, error: lines it was asked for). */
export interface NarrationAudit {
  replies: number;
  byKind: Record<string, number>;
  /** Audio it sent, in ms (what was cut off here included). */
  spokenMs: number;
  /** Replies cancelled (the user talked over them, or noise's). */
  cancelled: number;
  /** User turns that were noise (an empty transcript of a short sound): nothing said. */
  noise: number;
}

export interface TraceReport {
  summary: TraceSummary;
  turns: TurnReport[];
}

// ---------------------------------------------------------------- building

export function buildReport(input: { session: SessionInfo; events: readonly StampedAgentEvent[]; trace: TraceBook | null; now?: number }): TraceReport {
  const now = input.now ?? Date.now();
  const book = input.trace;
  const eventRows = input.events.map((e) => ({ e, t: Date.parse(e.ts) })).filter((x) => Number.isFinite(x.t));
  const starts = turnStarts(book, eventRows, input.session);
  const turnAt = (t: number) => {
    let n = starts[0]?.turn ?? 1;
    for (const s of starts) if (t >= s.t) n = s.turn;
    return n;
  };
  const byTurn = new Map<number, { traces: TraceEvent[]; events: { e: StampedAgentEvent; t: number }[] }>();
  const bucket = (n: number) => {
    let b = byTurn.get(n);
    if (!b) byTurn.set(n, (b = { traces: [], events: [] }));
    return b;
  };
  for (const s of starts) bucket(s.turn);
  for (const x of eventRows) bucket(turnAt(x.t)).events.push(x);
  for (const ev of book?.events ?? []) bucket(ev.turn ?? turnAt(ev.t)).traces.push(ev);

  const turns: TurnReport[] = [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, b]) => turnReport(n, b.traces, b.events, book ? turnTotals(book, n) : null, now));
  return { summary: summarize(turns, book), turns };
}

/** Where each turn starts: the trace's turns, else (older conversations) each message after an ended turn. */
function turnStarts(book: TraceBook | null, events: { e: AgentEvent; t: number }[], session: SessionInfo): { turn: number; t: number }[] {
  if (book?.turns.length) return book.turns.map((x) => ({ turn: x.turn, t: x.start }));
  const first = Date.parse(session.firstStartedAt ?? session.startedAt);
  const out = [{ turn: 1, t: Number.isFinite(first) ? first : (events[0]?.t ?? 0) }];
  let ended = false;
  for (const { e, t } of events) {
    if (e.type === "task_end") ended = true;
    else if (e.type === "user_message" && ended) {
      out.push({ turn: out.length + 1, t });
      ended = false;
    }
  }
  return out;
}

function turnTotals(book: TraceBook, n: number): TurnTotals | null {
  return book.turns.find((x) => x.turn === n) ?? null;
}

function turnReport(n: number, traces: TraceEvent[], events: { e: StampedAgentEvent; t: number }[], totals: TurnTotals | null, now: number): TurnReport {
  // Tool spans are shown on their tool_call row (same id), not twice.
  const spans = new Map<string, TraceEvent>();
  for (const ev of traces) if (ev.cat === "tool" && typeof ev.data?.id === "string") spans.set(ev.data.id, ev);
  const merged = new Set<TraceEvent>();
  const rows: Omit<TraceRow, "rel">[] = [];
  for (const { e, t } of events) {
    const span = e.type === "tool_call" ? spans.get(e.id) : undefined;
    if (span) merged.add(span);
    const row = eventRow(e, t, span, events);
    if (row) rows.push(row);
  }
  for (const ev of traces) if (!merged.has(ev)) rows.push(traceRow(ev));
  const stream = streamRow(totals);
  if (stream) rows.push(stream);
  rows.sort((a, b) => a.t - b.t || order(a) - order(b));
  const first = Math.min(totals?.first ?? Infinity, ...rows.map((r) => r.t));
  const start = Number.isFinite(first) ? first : (totals?.start ?? now);
  const endEvent = [...events].reverse().find((x) => x.e.type === "task_end");
  const end = totals?.end ?? endEvent?.t;
  const report: TurnReport = {
    turn: n,
    start,
    ms: Math.max(0, (end ?? now) - start),
    running: end === undefined,
    totals,
    rows: rows.map((r) => ({ ...r, rel: r.t - start })),
  };
  if (end !== undefined) report.end = end;
  const outcome = totals?.outcome ?? (endEvent?.e.type === "task_end" ? endEvent.e.outcome : undefined);
  if (outcome) report.outcome = outcome;
  const firstShown = totals?.firstResponse ?? events.find((x) => ["assistant_text", "tool_call", "task_end"].includes(x.e.type))?.t;
  if (firstShown !== undefined) report.firstResponseMs = firstShown - start;
  const spoken = speechToResponse(report.rows);
  if (spoken !== undefined) report.speechToResponseMs = spoken;
  return report;
}

/** The turn's streamed text in one row (it is counted, not recorded per delta): how many deltas, the first, the final text. */
function streamRow(totals: TurnTotals | null): Omit<TraceRow, "rel"> | null {
  if (!totals || (!totals.deltas && !totals.texts)) return null;
  const from = totals.firstDelta ?? totals.lastText!;
  const row: Omit<TraceRow, "rel"> = { t: from, kind: "trace", cat: "stream", name: "stream", label: "Streamed text", slow: false };
  const end = totals.lastText ?? totals.lastDelta;
  if (end !== undefined && end >= from) row.ms = end - from;
  row.detail = join(`${totals.deltas} deltas`, `${totals.texts} final text${totals.texts === 1 ? "" : "s"}`, totals.lastDelta !== undefined && `last delta ${durationText(totals.lastDelta - from)} after the first`);
  row.data = { deltas: totals.deltas, texts: totals.texts, ...(totals.firstDelta !== undefined ? { firstDelta: totals.firstDelta } : {}), ...(totals.lastText !== undefined ? { lastText: totals.lastText } : {}) };
  return row;
}

/** Voice timings that start where the user stopped speaking (Standard's transcript, the Realtime narrator's reply, its request). */
const SPEECH_END_ROWS = new Set(["voice.transcript", "voice.narrator", "voice.forward", "voice.heard"]);

/**
 * The first voice message's wait: from the end of the user's speech to the agent's first event for that message
 * (its first.response row names the message). Also noted on that row.
 */
function speechToResponse(rows: TraceRow[]): number | undefined {
  for (const r of rows) {
    if (r.name !== "first.response" || !r.cid) continue;
    const from = Math.min(...rows.filter((x) => x.cid === r.cid && SPEECH_END_ROWS.has(x.name)).map((x) => x.t));
    if (!Number.isFinite(from)) continue;
    const shown = r.t + (r.ms ?? 0);
    const ms = shown - from;
    // Realtime: the narrator passed the request on (send_to_agent) some time after the user stopped.
    const forwarded = rows.find((x) => x.cid === r.cid && x.name === "voice.forward");
    r.detail = join(r.detail ?? "", `${durationText(ms)} from the end of speech`, forwarded && `${durationText(shown - forwarded.t)} after send_to_agent`);
    return ms;
  }
  return undefined;
}

/** Among rows at the same moment: the turn's start first, its end last. */
function order(r: { name: string }): number {
  return r.name === "turn.start" ? -1 : r.name === "turn.end" ? 1 : 0;
}

// ---------------------------------------------------------------- rows

const clip = (s: string, max: number) => {
  const one = s.trim();
  return one.length > max ? `${one.slice(0, max - 1)}… (${one.length} chars)` : one;
};


function eventRow(e: StampedAgentEvent, t: number, span: TraceEvent | undefined, all: { e: StampedAgentEvent }[]): Omit<TraceRow, "rel"> | null {
  const base = { t, kind: "event" as const, cat: e.type, name: e.type, slow: false };
  switch (e.type) {
    case "user_message":
      return {
        ...base,
        label: e.voice ? "You (voice)" : "You",
        text: clip(e.text, TEXT_LIMITS.message),
        ...(e.heard?.length || e.attachments?.length
          ? { detail: clip(join(e.heard?.length && `word for word: ${e.heard.join(" · ")}`, e.attachments?.length && attachmentsText(e.attachments)), 300) }
          : {}),
      };
    case "assistant_text":
      return { ...base, label: "Claude", text: clip(e.text, TEXT_LIMITS.answer) };
    case "tool_call": {
      const row: Omit<TraceRow, "rel"> = { ...base, label: `Tool ${e.name}`, detail: clip(argsText(e.args), 200) };
      if (span) {
        row.ms = span.ms ?? 0;
        row.slow = row.ms >= SLOW_MS.tool;
        row.src = span.src;
        row.data = span.data ?? {};
        if (span.data?.error === true) row.error = true;
        const size = resultSize(span.data ?? {});
        if (size) row.detail = `${row.detail} · ${size}`;
      } else {
        // No span (a conversation from before traces): the time until its result.
        const result = all.find((x) => x.e.type === "tool_result" && x.e.id === e.id);
        if (result) row.ms = Math.max(0, Date.parse(result.e.ts) - t);
      }
      return row;
    }
    case "tool_result": {
      const row: Omit<TraceRow, "rel"> = { ...base, label: `${e.name} result`, text: clip(e.text ?? (e.thumbnail ? "[image]" : "ok"), TEXT_LIMITS.result) };
      if (e.isError) row.error = true;
      return row;
    }
    case "jev": {
      const target = e.index === null ? "" : ` #${e.index}`;
      return {
        ...base,
        t: t - e.ms,
        label: e.executed
          ? `Jev: ${e.operation}${target} · ${e.confidence.toFixed(2)}`
          : e.notRun
            ? `Jev: ${e.operation}${target} · ${e.confidence.toFixed(2)} · ${e.notRun === "not_approved" ? "not approved" : e.notRun}`
            : `Jev unsure (${e.confidence.toFixed(2)})`,
        detail: clip(e.goal, 160),
        ms: e.ms,
        slow: e.ms >= SLOW_MS.jev,
      };
    }
    case "status":
      return { ...base, label: "Status", text: clip(e.text, TEXT_LIMITS.status) };
    case "spoken":
      return { ...base, label: "Said aloud", text: clip(e.text, TEXT_LIMITS.status) };
    case "heard":
      return { ...base, label: "Your words (voice, no request)", text: clip(e.text, TEXT_LIMITS.message) };
    case "error":
      return { ...base, label: "Error", text: clip(e.text, TEXT_LIMITS.status), error: true };
    case "task_scheduled":
      return {
        ...base,
        label: "Scheduled in TODO",
        text: clip(e.instructions, TEXT_LIMITS.status),
        detail: `${describeSchedule(e.schedule, { now: new Date(e.ts), timeZone: localTimeZone() })} · task ${e.taskId}`,
      };
    case "task_unscheduled":
      return { ...base, label: "Schedule undone", text: `task ${e.taskId}` };
    case "task_changed":
      return {
        ...base,
        label: e.change === "cancelled" ? "Cancelled in TODO" : "Changed in TODO",
        text: clip(e.instructions, TEXT_LIMITS.status),
        detail: `${describeSchedule(e.schedule, { now: new Date(e.ts), timeZone: localTimeZone() })} · task ${e.taskId} · change ${e.changeId}`,
      };
    case "task_change_undone":
      return { ...base, label: "TODO change undone", text: `change ${e.changeId}` };
    case "memory": {
      const entry = (e.after ?? e.before)!;
      const label = !e.before ? "Remembered" : e.after ? "Memory updated" : "Memory forgotten";
      return { ...base, label, text: clip(`${entry.subject}: ${entry.text}`, TEXT_LIMITS.status), detail: `${entry.kind} · ${entry.id}${entry.domain ? ` · ${entry.domain}` : ""}` };
    }
    case "memory_undone":
      return { ...base, label: "Memory change undone", text: `change ${e.changeId}` };
    case "approval_request": {
      const r = e.request;
      return { ...base, label: `Approval asked: ${r.action}${r.site ? ` on ${r.site}` : ""}`, detail: join(r.why, `id ${r.id}`, `until ${r.expiresAt}`), ...(r.text ? { text: clip(r.text, TEXT_LIMITS.status) } : {}) };
    }
    case "approval_resolved":
      return { ...base, label: `Approval: ${APPROVAL_OUTCOME_TEXT[e.outcome] ?? e.outcome}${e.by ? ` (${APPROVAL_BY_TEXT[e.by]})` : ""}`, detail: `id ${e.id}` };
    case "task_end": {
      const text = e.summary ?? e.reason ?? "";
      const row: Omit<TraceRow, "rel"> = { ...base, label: `Result: ${e.outcome}`, text: clip(text, TEXT_LIMITS.answer) };
      if (e.outcome === "failed") row.error = true;
      return row;
    }
    default:
      return null;
  }
}

function argsText(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

const num = (v: TraceValue | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const kilo = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

function resultSize(d: Record<string, TraceValue>): string {
  const parts: string[] = [];
  const chars = num(d.chars);
  if (chars) parts.push(`${kilo(chars)} chars`);
  const kb = num(d.imageKB);
  if (kb) parts.push(`image ${kb} KB`);
  if (d.error === true) parts.push("error");
  // wait_for: why it stopped waiting, after how long, and how many slices the browser watched (no model calls).
  const waited = num(d.waitedMs);
  if (typeof d.end === "string") parts.push(`wait ${d.end}${waited !== undefined ? ` after ${durationText(waited)}` : ""}${num(d.checks) !== undefined ? `, ${d.checks} checks` : ""}${d.met ? `: ${String(d.met)}` : ""}`);
  return parts.join(" · ");
}

function tokensText(d: Record<string, TraceValue>): string {
  const inT = num(d.inTokens);
  const out = num(d.outTokens);
  if (inT === undefined && out === undefined) return "";
  const read = num(d.cacheReadTokens);
  const write = num(d.cacheWriteTokens);
  const cache = [read ? `${kilo(read)} cached` : "", write ? `${kilo(write)} cache write` : ""].filter(Boolean).join(", ");
  return `tokens in ${kilo(inT ?? 0)}${cache ? ` (+${cache})` : ""} → out ${kilo(out ?? 0)}`;
}

const msPart = (label: string, v: TraceValue | undefined) => (num(v) === undefined ? "" : `${label} ${durationText(num(v)!)}`);
const join = (...parts: (string | number | false | null | undefined)[]) => parts.filter((p) => typeof p === "string" && p !== "").join(" · ");

/** A trace event as a row: its label, details, and whether it was slow. */
function traceRow(ev: TraceEvent): Omit<TraceRow, "rel"> {
  const d = ev.data ?? {};
  const ms = ev.ms;
  const row: Omit<TraceRow, "rel"> = { t: ev.t, kind: "trace", cat: ev.cat, name: ev.name, label: ev.name, slow: false, src: ev.src, data: d };
  if (ev.cid) row.cid = ev.cid;
  if (ms !== undefined) row.ms = ms;
  const s = (x: TraceValue | undefined) => (x === undefined || x === null ? "" : String(x));
  const over = (limit: number, v = ms) => v !== undefined && v >= limit;
  switch (ev.name) {
    case "turn.start":
      row.label = "Turn started";
      row.detail = join(s(d.brain), s(d.model), d.jev === true ? "Jev on" : d.jev === false ? "Jev off" : "", num(d.chars) !== undefined && `${d.chars} chars`, d.voice === true && "voice");
      break;
    case "turn.end":
      row.label = `Turn ended: ${s(d.outcome)}`;
      row.slow = over(SLOW_MS.turn);
      break;
    case "brain.resolve":
      row.label = `Brain chosen: ${s(d.brain) || "none"}`;
      row.detail = join(d.mode && `setting ${s(d.mode)}`, s(d.model), d.jev === true ? "Jev on" : "Jev off");
      row.slow = over(SLOW_MS.brain);
      break;
    case "brain.start":
      row.label = d.fresh === false ? "Brain continues its session" : "Brain started";
      row.detail = join(s(d.brain), num(d.chars) !== undefined && `${d.chars} chars`);
      break;
    case "engine.tab":
      row.label = "Tab ready (debugger attached)";
      row.detail = s(d.mode);
      row.slow = over(SLOW_MS.brain);
      break;
    case "engine.media":
      row.label = `Files written (${s(d.files)})`;
      break;
    case "engine.attachments":
      row.label = `Attachments written for upload (${s(d.files)})`;
      break;
    case "engine.x_wait":
      row.label = "Waited for another X task";
      break;
    case "helper.setup":
      row.label = "Helper set up the session";
      row.detail = join(d.jev === true && "Jev on", num(d.media) ? `${d.media} files` : "");
      row.slow = over(SLOW_MS.brain);
      break;
    case "claude.ready":
      row.label = "Claude Code process ready";
      row.detail = join(s(d.model), d.version && `Claude Code ${s(d.version)}`);
      row.slow = over(SLOW_MS.brain);
      break;
    case "claude.result":
      row.label = "Claude Code turn summary";
      row.detail = join(
        num(d.modelCalls) !== undefined && `${d.modelCalls} model calls`,
        msPart("API", d.apiMs),
        msPart("total", d.durationMs),
        num(d.costUsd) !== undefined && `$${num(d.costUsd)!.toFixed(4)}`,
        tokensText(d),
        d.error !== undefined && `error ${s(d.error)}`,
        d.interrupted !== undefined && `stopped: ${s(d.interrupted)}`,
      );
      break;
    case "model.call":
      row.label = `Model call${num(d.attempt) && num(d.attempt)! > 1 ? ` (attempt ${d.attempt})` : ""}`;
      row.detail = join(
        s(d.model),
        d.reasoning && d.reasoning !== "fast" && `reasoning ${s(d.reasoning)}`,
        msPart("after input", d.sinceInputMs),
        msPart("response", d.responseMs),
        msPart("first token", d.firstTokenMs),
        msPart("first text", d.firstTextMs),
        msPart("first tool", d.firstToolMs),
        num(d.deltas) ? `${d.deltas} deltas` : "",
        tokensText(d),
        d.stop && `stop ${s(d.stop)}`,
        d.result && d.result !== "ok" && `${s(d.result)}: ${s(d.reason)}`,
        d.interrupted !== undefined && `stopped: ${s(d.interrupted)}`,
      );
      row.slow = over(SLOW_MS.model);
      if (d.result && d.result !== "ok") row.error = true;
      break;
    case "reasoning.raise":
      row.label = `Reasoning raised: ${s(d.why)}`;
      break;
    case "reasoning.lower":
      row.label = `Reasoning back to fast: ${s(d.why)}`;
      break;
    case "reasoning.turn":
      row.label = `Reasoning ${d.thinking === true ? "thorough" : "fast"} for this turn`;
      break;
    case "model.wait":
      row.label = `Retry wait before attempt ${num(d.attempt)! + 1}`;
      row.detail = d.serverAsked === true ? "the server asked for it" : "backoff";
      row.slow = over(SLOW_MS.model);
      break;
    case "tool":
      row.label = `Tool ${s(d.tool)}`;
      row.detail = join(clip(s(d.args), 200), resultSize(d));
      row.slow = over(SLOW_MS.tool);
      break;
    case "approval.judge":
      // How the gate judged a consequential action; for a scheduled run, the task's words and Jev's own verdict.
      row.label = `Approval check: ${s(d.action)} · ${d.waits === true ? "waits for the user" : "runs"}`;
      row.detail = join(
        s(d.level),
        `${d.kind === null ? "unknown kind" : s(d.kind)} by ${s(d.by)} (${s(d.reason)})`,
        d.withinRules !== undefined && `task words: ${d.withinRules === true ? "ask for it" : "do not ask for it"}`,
        d.withinJev !== undefined && d.withinJev !== null && `Jev: ${s(d.withinJev)}`,
      );
      break;
    case "approval.wait":
      // How long an approval held the run, and what ended it.
      row.label = `Approval ${s(d.outcome)} · by ${APPROVAL_BY_TEXT[s(d.by) as ApprovalEndedBy] ?? s(d.by)}`;
      row.detail = join(s(d.action), d.site ? `on ${s(d.site)}` : "", `waited ${durationText(ms ?? 0)}`, `id ${s(d.id)}`);
      break;
    case "act.step":
      row.label = `act step ${s(d.step)}${d.picker === "jev" ? ` · Jev ${s(d.operation)} ${num(d.confidence)?.toFixed(2) ?? ""}` : d.picker === "claude" ? " · picked by Claude" : ""}${d.ran === false ? " · stopped" : ""}`;
      row.detail = join(clip(s(d.goal), 120), msPart("read page", d.readMs), msPart("Jev", d.jevMs), msPart("action + settle", d.performMs));
      row.slow = over(SLOW_MS.act);
      break;
    case "first.response":
      row.label = `First response (${s(d.via)})`;
      row.slow = over(SLOW_MS.firstResponse);
      break;
    case "user.send":
      row.label = "Sent from the panel";
      row.detail = join(num(d.chars) !== undefined && `${d.chars} chars`, s(d.via), s(d.mode), ms !== undefined && `taken by the background in ${durationText(ms)}`);
      break;
    default:
      if (ev.cat === "browser") {
        row.label = `Browser ${ev.name.replace(/^browser\./, "")}`;
        row.detail = join(
          s(d.driver),
          num(d.elements) !== undefined && `${d.elements} elements`,
          num(d.chars) !== undefined && `${kilo(num(d.chars)!)} chars`,
          num(d.kb) !== undefined && `${d.kb} KB`,
          s(d.host),
          num(d.tabs) !== undefined && `${d.tabs} tabs`,
          d.error && `error: ${s(d.error)}`,
        );
        row.slow = over(SLOW_MS.browser);
        if (d.error) row.error = true;
      } else if (ev.cat === "voice") voiceRow(row, ev.name, d);
      else if (ev.cat === "error") {
        row.label = ERROR_LABELS[ev.name] ?? `Error: ${ev.name}`;
        row.detail = join(s(d.engine), s(d.error));
        row.error = true;
      }
  }
  return row;
}

const ERROR_LABELS: Record<string, string> = {
  "voice.failed": "Voice stopped with an error",
  "voice.transcribe_failed": "Voice: transcription failed",
};

const VOICE_LABELS: Record<string, string> = {
  "voice.speech": "Voice: speech started",
  "voice.barge_in": "Voice: barge-in (cut the line off)",
  "voice.transcript": "Voice: end of speech → transcript",
  "voice.heard": "Voice: heard (sending window starts)",
  "voice.forward": "Voice: narrator forwarded the request",
  "voice.send_window": "Voice: sending window",
  "voice.deliver": "Voice: message delivered",
  "voice.cancelled": "Voice: cancelled",
  "voice.tts": "Voice: line said",
  "voice.ticket": "Voice: session token",
  "voice.connect": "Voice: Realtime connected",
  "voice.start": "Voice: session started",
  "voice.end": "Voice: session ended",
  "voice.reconnect": "Voice: reconnecting",
  "voice.refused_forward": "Voice: narrator's send refused",
  "voice.unclear": "Voice: your words unclear (not used)",
  "voice.not_addressed": "Voice: speech not for the assistant (ignored)",
  "voice.echo": "Voice: the assistant's own voice heard back (ignored)",
  "voice.narrator": "Voice: narrator reply",
  "voice.user_words": "Voice: your words transcribed",
};

function voiceRow(row: Omit<TraceRow, "rel">, name: string, d: Record<string, TraceValue>): void {
  const s = (x: TraceValue | undefined) => (x === undefined || x === null ? "" : String(x));
  row.label = VOICE_LABELS[name] ?? (name.startsWith("voice.tool.") ? `Voice: narrator called ${name.slice("voice.tool.".length)}` : name);
  const wait = num(d.waitMs);
  if (wait !== undefined) {
    row.wait = wait;
    row.slow = wait >= SLOW_MS.voice;
  }
  switch (name) {
    case "voice.transcript":
      row.detail = join(
        s(d.model),
        msPart("request sent after", d.requestAfterMs),
        msPart("round trip", d.lastRequestMs),
        num(d.requests) !== undefined && `${d.requests} requests`,
        num(d.lastKB) !== undefined && `${d.lastKB} KB`,
        num(d.chars) !== undefined && `${d.chars} chars`,
      );
      break;
    case "voice.user_words":
      row.detail = join(s(d.model), d.failed === true && "failed", d.noise === true && "noise (nothing said)", num(d.chars) !== undefined && `${d.chars} chars`, num(d.inTokens) !== undefined && `tokens in ${d.inTokens} → out ${s(d.outTokens)}`);
      break;
    case "voice.tts":
      row.detail = join(msPart("started after", d.startMs), d.started === false && "never started", num(d.chars) !== undefined && `${d.chars} chars`, d.cut === true && "cut off");
      break;
    case "voice.connect":
      row.detail = join(s(d.model), msPart("socket open", d.openMs), msPart("session ready", d.readyMs));
      break;
    case "voice.start":
    case "voice.end":
    case "voice.reconnect":
    case "voice.refused_forward":
    case "voice.unclear":
    case "voice.not_addressed":
    case "voice.echo":
      row.detail = join(s(d.engine), s(d.why), s(d.reason), num(d.attempt) !== undefined && `try ${d.attempt}`, msPart("after", d.delayMs), d.takeover === true && "taking over");
      break;
    case "voice.narrator":
      row.label = `Voice: narrator reply (${NARRATOR_KIND_LABELS[s(d.kind)] ?? (d.trigger === "speech" ? "to speech" : "to an update")})`;
      row.detail = join(
        msPart("spoke", d.spokenMs),
        msPart("committed", d.commitMs),
        msPart("started", d.createdMs),
        msPart("first audio", d.firstAudioMs),
        s(d.status),
        num(d.inTokens) !== undefined && `tokens in ${d.inTokens} (audio ${s(d.inAudioTokens)}, cached ${s(d.cachedTokens)}) → out ${s(d.outTokens)} (audio ${s(d.outAudioTokens)})`,
      );
      break;
    default:
      if (num(d.chars) !== undefined) row.detail = `${d.chars} chars`;
  }
}

/** What ended an approval (approval_resolved by, approval.wait data.by) as the Raw view names it. */
const APPROVAL_BY_TEXT: Record<ApprovalEndedBy, string> = {
  card: "the card",
  keyboard: "the card's key",
  voice: "voice",
  stop: "Stop",
  message: "a message from the user",
  timeout: "no answer in time",
  unattended: "nobody watching (the run paused)",
  turn_end: "the turn ending",
  not_shown: "the card could not be shown",
};

/** The narrator reply's kind (voice.narrator data.kind) as the Raw view names it. */
const NARRATOR_KIND_LABELS: Record<string, string> = {
  speech: "to speech",
  ack: "acknowledgement",
  milestone: "milestone",
  result: "result",
  question: "question",
  error: "problem",
};

// ---------------------------------------------------------------- summary

/** What the narrator said, from the voice.narrator and voice.user_words rows (null: no narrator reply). */
export function narrationAudit(rows: readonly TraceRow[]): NarrationAudit | null {
  const replies = rows.filter((r) => r.name === "voice.narrator");
  if (!replies.length) return null;
  const a: NarrationAudit = { replies: replies.length, byKind: {}, spokenMs: 0, cancelled: 0, noise: 0 };
  for (const r of replies) {
    const d = r.data ?? {};
    const kind = typeof d.kind === "string" ? d.kind : d.trigger === "speech" ? "speech" : "update";
    a.byKind[kind] = (a.byKind[kind] ?? 0) + 1;
    if (typeof d.spokenMs === "number") a.spokenMs += d.spokenMs;
    if (d.status === "cancelled") a.cancelled++;
  }
  a.noise = rows.filter((r) => r.name === "voice.user_words" && r.data?.noise === true).length;
  return a;
}

/** Rows that can be the bottleneck (containers like whole turns and sums are left out). */
function slowCandidate(r: TraceRow): number | null {
  if (r.cat === "voice") return r.wait ?? null;
  if (r.ms === undefined) return null;
  if (["turn.end", "claude.result", "user.send", "brain.start", "stream"].includes(r.name)) return null;
  return r.ms;
}

function summarize(turns: TurnReport[], book: TraceBook | null): TraceSummary {
  const tokens: TokenTotals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const s: TraceSummary = {
    turns: turns.length,
    totalMs: 0,
    firstResponseMs: turns[0]?.firstResponseMs ?? null,
    firstResponses: turns.map((t) => t.firstResponseMs ?? null),
    speechToResponses: turns.map((t) => t.speechToResponseMs ?? null),
    modelMs: 0,
    toolMs: 0,
    jevMs: 0,
    voiceMs: 0,
    otherMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    jevPicks: 0,
    deltas: 0,
    tokens,
    costUsd: 0,
    slowest: [],
    dropped: book?.dropped ?? 0,
    traced: !!book,
    narration: narrationAudit(turns.flatMap((t) => t.rows)),
  };
  for (const t of turns) {
    s.totalMs += t.ms;
    const x = t.totals;
    if (x) {
      s.modelMs += x.modelMs;
      s.toolMs += x.toolMs;
      s.jevMs += x.jevMs;
      s.voiceMs += x.voiceMs;
      s.modelCalls += x.modelCalls;
      s.toolCalls += x.toolCalls;
      s.jevPicks += x.jevPicks;
      s.deltas += x.deltas;
      tokens.in += x.tokens.in;
      tokens.out += x.tokens.out;
      tokens.cacheRead += x.tokens.cacheRead;
      tokens.cacheWrite += x.tokens.cacheWrite;
      s.costUsd += x.costUsd;
    } else {
      // No trace: tool time from the events.
      for (const r of t.rows) if (r.name === "tool_call" && r.ms !== undefined) (s.toolMs += r.ms), s.toolCalls++;
      for (const r of t.rows) if (r.name === "jev" && r.ms !== undefined) (s.jevMs += r.ms), s.jevPicks++;
    }
  }
  s.otherMs = Math.max(0, s.totalMs - s.modelMs - s.toolMs - s.voiceMs);
  s.costUsd = Math.round(s.costUsd * 1e6) / 1e6;
  s.slowest = turns
    .flatMap((t) => t.rows.map((r) => ({ r, turn: t.turn, ms: slowCandidate(r) })))
    .filter((x): x is { r: TraceRow; turn: number; ms: number } => x.ms !== null && x.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, SLOWEST_COUNT)
    .map(({ r, turn, ms }) => ({ turn, rel: r.rel, label: r.label, ms }));
  return s;
}

// ---------------------------------------------------------------- text and export

/** Where it ran: the background's part (TraceEnv) and the panel's (voice). */
export interface ReportEnv {
  extensionVersion: string;
  userAgent: string;
  os?: string;
  arch?: string;
  helper: { version: string; brain: string; jev: boolean } | null;
  voice?: { engine: string; model?: string; realtimeModel?: string; standardModel?: string; voice?: string; speed?: number };
}

/** "1m 02.3 s", "4.21 s", "380 ms". */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${((ms - m * 60_000) / 1000).toFixed(1).padStart(4, "0")} s`;
}

/** "+3.40 s" relative to the turn's start. */
export function relText(ms: number): string {
  return `${ms < 0 ? "-" : "+"}${(Math.abs(ms) / 1000).toFixed(2)} s`;
}

export function clockText(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** The summary's lines, as the view and the text show them: a short hint beside the value, what it means in `about`. */
export function summaryLines(s: TraceSummary): { label: string; value: string; hint: string; about: string }[] {
  const n = (x: number) => x.toLocaleString("en-US");
  const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  return [
    { label: "Total", value: durationText(s.totalMs), hint: plural(s.turns, "turn"), about: "Every turn from its first event (the message, or the voice before it) to its end, added up" },
    {
      label: "First response",
      value: s.firstResponseMs === null ? "–" : durationText(s.firstResponseMs),
      hint: s.turns > 1 ? `turn 1; later ${s.firstResponses.slice(1).map((x) => (x === null ? "–" : durationText(x))).join(", ")}` : "turn 1",
      about: "From the message (or the voice before it) to the first thing the agent showed: text, a tool call or the result",
    },
    ...speechLine(s),
    ...narrationLine(s),
    { label: "Model", value: durationText(s.modelMs), hint: plural(s.modelCalls, "call"), about: "Model calls, each from the request to its last token" },
    { label: "Tools", value: durationText(s.toolMs), hint: `${plural(s.toolCalls, "call")}, Jev ${durationText(s.jevMs)}`, about: `Tool calls in the browser; Jev's ${plural(s.jevPicks, "pick")} are part of them` },
    { label: "Voice", value: durationText(s.voiceMs), hint: "waited", about: "Time spent waiting on voice: transcription, the sending window, the message going out, speech starting, the narrator's first audio" },
    { label: "Other", value: durationText(s.otherMs), hint: "engine, helper, idle", about: "Turn time outside model calls, tools and voice: starting the brain and the tab, messaging between the parts, waiting" },
    {
      label: "Tokens",
      value: `${n(s.tokens.in)} → ${n(s.tokens.out)}`,
      hint: `+${n(s.tokens.cacheRead)} cached${s.costUsd ? ` · $${s.costUsd.toFixed(4)}` : ""}`,
      about: `Input → output tokens of the model calls; ${n(s.tokens.cacheRead)} more read from the cache, ${n(s.tokens.cacheWrite)} written to it${s.costUsd ? `; Claude Code's own cost figure $${s.costUsd.toFixed(4)}` : ""}`,
    },
  ];
}

/** "Narrator": what the Realtime narrator said, by kind, and for how long. */
function narrationLine(s: TraceSummary): { label: string; value: string; hint: string; about: string }[] {
  const a = s.narration;
  if (!a) return [];
  const kinds = Object.entries(a.byKind)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  const extra = [a.cancelled && `${a.cancelled} cancelled`, a.noise && `${a.noise} noise`].filter(Boolean).join(", ");
  return [
    {
      label: "Narrator",
      value: `${durationText(a.spokenMs)} spoken`,
      hint: `${a.replies} ${a.replies === 1 ? "reply" : "replies"}: ${kinds}${extra ? `; ${extra}` : ""}`,
      about: "The Realtime narrator's replies by kind (speech: answers to the user; ack, milestone, result, question, error: lines it was asked for) and the audio it sent",
    },
  ];
}

/** "Speech → agent", when a turn was started by voice. */
function speechLine(s: TraceSummary): { label: string; value: string; hint: string; about: string }[] {
  const all = s.speechToResponses;
  const first = all.findIndex((x) => x !== null);
  if (first < 0) return [];
  const others = all.filter((x, i) => x !== null && i !== first) as number[];
  return [
    {
      label: "Speech → agent",
      value: durationText(all[first]!),
      hint: `turn ${first + 1}${others.length ? `; later ${others.map(durationText).join(", ")}` : ""}`,
      about: "From the end of the user's speech to the agent's first event for that message: transcription, the sending window, sending, the brain",
    },
  ];
}

/** The whole report as plain text (Copy), redacted. */
export function reportText(report: TraceReport, session: SessionInfo, env: ReportEnv): string {
  const s = report.summary;
  const out: string[] = [];
  out.push(`Noa trace · ${session.title}`);
  out.push(join(`session ${session.sessionId}`, session.brain, session.model, session.jev ? "Jev on" : "Jev off", `${s.turns} turns`));
  out.push(envLine(env));
  if (!s.traced) out.push("(No timing trace: this conversation is from before traces were kept. Times come from its events.)");
  if (s.dropped) out.push(`(${s.dropped} older trace events were dropped by the cap of ${TRACE_CAPS.events}; the totals still count them.)`);
  out.push("", "SUMMARY");
  for (const l of summaryLines(s)) out.push(`${l.label.padEnd(15)}${l.value.padEnd(12)} ${l.hint}  - ${l.about}`);
  if (s.slowest.length) {
    out.push("Slowest:");
    s.slowest.forEach((x, i) => out.push(`  ${i + 1}. ${durationText(x.ms).padStart(9)}  ${x.label} (turn ${x.turn}, ${relText(x.rel)})`));
  }
  for (const t of report.turns) {
    out.push("", turnTitle(t));
    for (const r of t.rows) {
      const dur = r.ms === undefined ? "" : durationText(r.ms);
      const head = `${r.slow ? "!" : " "} ${relText(r.rel).padStart(9)} ${dur.padStart(10)}  ${r.label}`;
      out.push(head);
      if (r.detail) out.push(`${" ".repeat(24)}${r.detail}`);
      if (r.text) out.push(...r.text.split("\n").map((line) => `${" ".repeat(24)}| ${line}`));
    }
  }
  return redactSecrets(out.join("\n"));
}

export function turnTitle(t: TurnReport): string {
  return join(
    `TURN ${t.turn}`,
    clockText(t.start),
    durationText(t.ms) + (t.running ? " so far" : ""),
    t.running ? "running" : (t.outcome ?? ""),
    t.firstResponseMs !== undefined && `first response ${durationText(t.firstResponseMs)}`,
  );
}

function envLine(env: ReportEnv): string {
  return join(
    env.extensionVersion && `extension ${env.extensionVersion}`,
    env.helper ? `helper ${env.helper.version} (${env.helper.brain})` : "no helper",
    browserName(env.userAgent),
    env.os && `${env.os}${env.arch ? `/${env.arch}` : ""}`,
    env.voice && `voice ${env.voice.engine}${env.voice.model ? ` (${env.voice.model})` : ""}`,
  );
}

/** "Chrome 153.0.1234.5" from a user agent. */
function browserName(ua: string): string {
  const m = /(Chrome|Chromium|Edg)\/([\d.]+)/.exec(ua);
  return m ? `${m[1] === "Edg" ? "Edge" : m[1]} ${m[2]}` : "";
}

/** The export (Download .json): everything above, structured, redacted. */
export function exportJson(report: TraceReport, session: SessionInfo, env: ReportEnv, exportedAt = new Date()): unknown {
  const doc = {
    format: "noa.trace",
    version: 1,
    exportedAt: exportedAt.toISOString(),
    about:
      "Timing trace of one Noa conversation. t: epoch ms; rel: ms since the turn's first event; ms: duration; wait: the part the user waited. " +
      "Secrets are redacted and page content is cut short.",
    env: { ...env, caps: TRACE_CAPS, slowMs: SLOW_MS },
    session: {
      sessionId: session.sessionId,
      title: session.title,
      source: session.source,
      brain: session.brain,
      model: session.model ?? null,
      jev: session.jev,
      turns: session.turns ?? 1,
      startedAt: session.firstStartedAt ?? session.startedAt,
      endedAt: session.endedAt ?? null,
      outcome: session.outcome ?? null,
      voice: session.voice === true,
      // What the first message was sent with: metadata only (never the files or their thumbnails).
      ...(session.attachments?.length ? { attachments: session.attachments.map(attachmentMeta) } : {}),
    },
    summary: report.summary,
    turns: report.turns.map((t) => ({
      turn: t.turn,
      startedAt: new Date(t.start).toISOString(),
      ms: t.ms,
      running: t.running,
      outcome: t.outcome ?? null,
      firstResponseMs: t.firstResponseMs ?? null,
      totals: t.totals,
      rows: t.rows.map((r) => {
        const row: Record<string, unknown> = { t: r.t, rel: r.rel, kind: r.kind, cat: r.cat, name: r.name, label: r.label };
        for (const k of ["ms", "wait", "detail", "text", "src", "cid", "data"] as const) if (r[k] !== undefined) row[k] = r[k];
        if (r.slow) row.slow = true;
        if (r.error) row.error = true;
        return row;
      }),
    })),
  };
  return redactDeep(doc);
}

// ---------------------------------------------------------------- redaction
//
// Passwords the agent was given are redacted where they are recorded (the tool executor's SecretRedactor, like the
// chat's events); what is left to catch here are keys and tokens that reached a text some other way (a URL, a
// page, a message; the patterns are shared with memory, packages/shared secret-text.ts), and fields named after secrets.

export { redactSecrets };

/** Object keys whose values are secrets, whatever they hold (the settings' own secret keys among them). */
const SECRET_KEYS = new Set(
  ["password", "passwd", "passphrase", "secret", "token", "apikey", "api_key", "authorization", "cookie", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", ...SECRET_SETTING_KEYS].map((k) => k.toLowerCase()),
);

/** A copy of `value` with every string redacted and secret-named fields blanked. */
export function redactDeep<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.has(k.toLowerCase()) && x !== null && x !== undefined && x !== "" ? REDACTED : walk(x)]));
    return mapStrings(v, redactSecrets);
  };
  return walk(value) as T;
}

/** An attachment as the trace keeps it: what it was, not what it holds. */
function attachmentMeta(r: AttachmentRef): Record<string, string | number> {
  return { name: r.name, kind: r.kind, type: r.type, size: r.size, ...(r.width && r.height ? { width: r.width, height: r.height } : {}) };
}

/** "files: cat.png (image, 1.2 MB) · notes.docx (docx, 12 KB)". */
function attachmentsText(refs: readonly AttachmentRef[]): string {
  return `files: ${refs.map((r) => `${r.name} (${r.kind}, ${formatBytes(r.size)})`).join(" · ")}`;
}
