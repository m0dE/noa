/**
 * A repeating job's runs as its page lists them (pure), built to stay small however many times the job ran:
 *
 * - runItems(): every run, newest first: each conversation this browser keeps of it, and each of its task rows that
 *   ran without one here (another browser, or one whose conversation this browser no longer keeps);
 * - runPage(): one page of them (RUNS_PAGE at a time), filtered (failed, needs you, done), runs in a row that ended
 *   the same way for the same reason folded into one row, the rows grouped by the day of their newest run;
 * - needsMoreRows(): whether a page needs task rows older than those loaded (the account lists a series a page at a
 *   time).
 */
import type { SessionInfo } from "@noa/shared";
import { firstLine } from "./format.js";
import { sessionState, type JobState, type JobTask } from "./jobs.js";

/** Runs a page lists at first, and "Show more" adds. */
export const RUNS_PAGE = 50;

/** How a run went (a job's state, for its icon). */
export type RunState = Extract<JobState, "done" | "failed" | "needs" | "stopped" | "cancelled" | "running">;

/** The runs a list shows: all of them, or those that failed, need the user, or were done. */
export type RunFilter = "all" | "failed" | "needs" | "done";
export const RUN_FILTERS: readonly RunFilter[] = ["all", "failed", "needs", "done"];

export interface RunItem {
  /** Its conversation's session id, or "task:<row id>" for a run known only by its task row. */
  key: string;
  /** When it started (a task row: when it ended). */
  at: string;
  state: RunState;
  /** How it ended, in one line: its result, or why it failed or needs the user ("" when nothing was said). */
  line: string;
  /** Its conversation in this browser (null: none here). */
  session: SessionInfo | null;
  /** Its task row, for a run known only by it. */
  task: JobTask | null;
}

/** How long a run's line may be (the row cuts it to its width). */
const LINE_CHARS = 200;

function sessionRun(s: SessionInfo, running: boolean): RunItem {
  const { state, reason } = sessionState(s, running, false);
  const line = state === "done" ? (s.summary ?? "") : state === "stopped" ? "" : reason;
  return { key: s.sessionId, at: s.firstStartedAt ?? s.startedAt, state: state as RunState, line: firstLine(line, LINE_CHARS), session: s, task: null };
}

/** A task row as a run: one that ended (done, failed) or stopped after it started (needs you, cancelled); else null. */
function rowRun(t: JobTask): RunItem | null {
  const ran = t.attempts > 0;
  const as = (state: RunState, line: string | null): RunItem => ({ key: `task:${t.id}`, at: t.updatedAt, state, line: firstLine(line ?? "", LINE_CHARS), session: null, task: t });
  switch (t.status) {
    case "done":
      return as("done", t.resultSummary);
    case "failed":
      return as("failed", t.failReason);
    case "paused":
      return ran ? as("needs", t.pauseReason) : null;
    case "cancelled":
      return ran ? as("cancelled", "") : null;
    default:
      return null;
  }
}

/**
 * Every run of a job, newest first. `sessions`: its conversations in this browser; `rows`: its series' task rows known
 * so far (a row with a conversation here is that conversation); `running`: the sessions running now.
 */
export function runItems(input: { sessions: readonly SessionInfo[]; rows: readonly JobTask[]; running?: ReadonlySet<string> }): RunItem[] {
  const withConversation = new Set(input.sessions.map((s) => s.taskId).filter(Boolean));
  const items = [
    ...input.sessions.map((s) => sessionRun(s, input.running?.has(s.sessionId) ?? false)),
    ...input.rows.filter((t) => !withConversation.has(t.id)).flatMap((t) => rowRun(t) ?? []),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export const inFilter = (item: RunItem, filter: RunFilter): boolean => filter === "all" || item.state === filter;

/** How many runs each filter shows. */
export function runCounts(items: readonly RunItem[]): Record<RunFilter, number> {
  return Object.fromEntries(RUN_FILTERS.map((f) => [f, items.filter((i) => inFilter(i, f)).length])) as Record<RunFilter, number>;
}

/** One row of the list: a run, or runs in a row that ended the same way for the same reason (newest first). */
export interface RunRow {
  /** Its newest run's key. */
  key: string;
  state: RunState;
  line: string;
  runs: RunItem[];
}

export interface RunDay {
  /** YYYY-MM-DD, in the day the rows' newest runs started. */
  day: string;
  rows: RunRow[];
}

export interface RunPage {
  days: RunDay[];
  /** Runs in the page. */
  shown: number;
  /** Runs the filter shows in all. */
  total: number;
}

/** A time's day in this browser's zone: YYYY-MM-DD. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Runs in a row fold when they ended the same way for the same reason (a run still going stands alone). */
const folds = (row: RunRow, item: RunItem) => item.state !== "running" && item.state === row.state && item.line === row.line;

/** The newest `limit` runs the filter shows, folded, grouped by day. */
export function runPage(items: readonly RunItem[], filter: RunFilter, limit: number, dayOf: (iso: string) => string = localDay): RunPage {
  const shown = items.filter((i) => inFilter(i, filter));
  const page = shown.slice(0, limit);
  const rows: RunRow[] = [];
  for (const item of page) {
    const last = rows.at(-1);
    if (last && folds(last, item)) last.runs.push(item);
    else rows.push({ key: item.key, state: item.state, line: item.line, runs: [item] });
  }
  const days: RunDay[] = [];
  for (const row of rows) {
    const day = dayOf(row.runs[0]!.at);
    if (days.at(-1)?.day === day) days.at(-1)!.rows.push(row);
    else days.push({ day, rows: [row] });
  }
  return { days, shown: page.length, total: shown.length };
}

/**
 * Whether the page of `limit` runs needs older task rows: rows are loaded back to `loadedUntil` (the oldest loaded
 * row's run; null: every row is loaded), and fewer runs than the page shows are known from then on.
 */
export function needsMoreRows(items: readonly RunItem[], filter: RunFilter, limit: number, loadedUntil: string | null): boolean {
  if (loadedUntil === null) return false;
  return items.filter((i) => inFilter(i, filter) && i.at >= loadedUntil).length < limit;
}

/** A list's day heading: "Today", "Yesterday", else "Tue, Sep 22" (with the year when it is not this one). */
export function dayLabel(day: string, now = Date.now(), locale?: string): string {
  const today = localDay(new Date(now).toISOString());
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  if (day === today) return "Today";
  if (day === localDay(d.toISOString())) return "Yesterday";
  const [y, m, dd] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, dd);
  return date.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", ...(y === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
}
