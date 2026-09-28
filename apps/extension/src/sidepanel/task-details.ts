/**
 * The task details sheet's view model (pure): everything the panel knows
 * about a task or a chat message, from its TODO entry and/or a run of it.
 * Fields the panel does not have are left out. See details-sheet.ts for the DOM.
 */
import {
  chipHint,
  clipLine,
  describeRepeat,
  formatBytes,
  isEarlierRuns,
  isTaskRun,
  localTimeZone,
  taskChip,
  type Chip,
  type LocalTask,
  type MemoryEntry,
  type RepeatSchedule,
  type SessionInfo,
  type TextOptions,
} from "@noa/shared";
import type { LocalMediaInfo } from "../ui-protocol.js";
import { accountLabel, outcomeChip, sessionHeadline, trimUrlEnd } from "./format.js";

/** A TODO entry as the jobs list has it (cloud tasks may lack repeat and media). */
export type DetailsTask = Omit<LocalTask, "repeat"> & { repeat?: RepeatSchedule | null; media?: LocalMediaInfo[] };

export interface DetailsInput {
  /** The task's TODO entry, when the TODO list has it. */
  task?: DetailsTask | null;
  /** Where the TODO list came from: the signed-in account, or this browser. */
  listSource?: "local" | "account";
  /** A run of it (the one shown, or the task's latest). */
  session?: SessionInfo | null;
  /** What its memory keeps of its earlier runs (memory.taskRuns): newest first, the earlier-runs summary last. */
  runs?: MemoryEntry[];
}

/** One earlier run of a task, as its details list it. */
export interface PreviousRun {
  /** When it ran, in the user's words ("Sep 25, 2026, 9:00 AM"). */
  when: string;
  /** Its first line: the start of what it produced, else its note. */
  line: string;
  /** Exactly what it published or sent (task_complete output), when it kept it. */
  output?: string;
  /** The run's note for the next runs (absent when it left only an output). */
  note?: string;
}

/** How long a previous run's first line is. */
export const RUN_LINE_CHARS = 90;

export type Origin = "account" | "local" | "adhoc";

export interface DetailsField {
  label: string;
  value: string;
  /** A link to open in a new tab. */
  href?: string;
  /** Monospace (ids). */
  mono?: boolean;
  tone?: "bad" | "warn";
}

export interface DetailsModel {
  heading: string;
  /** Label of the text block: "Instructions", or "Message" for a chat message. */
  textLabel: string;
  /** The copy button: "Copy instructions" / "Copy message". */
  copyLabel: string;
  /** Shown in place of the text when none was saved. */
  emptyText: string;
  /** The full instructions (line breaks kept); "" when nothing is known. */
  text: string;
  /** Set when only the run's one-line title is known, not the full text. */
  textNote?: string;
  chip?: Chip & { hint: string };
  origin?: Origin;
  fields: DetailsField[];
  files: { name: string; detail: string }[];
  /** Its earlier runs, newest first (dates, outputs and notes), when its memory keeps them. */
  previousRuns?: PreviousRun[];
  /** What its memory says of runs older than those (the earlier-runs summary). */
  earlierRuns?: string;
}

/** A task's earlier runs as its details list them (the note "(no note)" of an output-only run is left out). */
export function previousRuns(runs: readonly MemoryEntry[], when: WhenOptions = {}): { runs: PreviousRun[]; earlier?: string } {
  const out = runs.filter(isTaskRun).map((e): PreviousRun => {
    const note = e.text === "(no note)" ? undefined : e.text;
    return { when: formatWhen(e.learnedAt, when), line: clipLine(e.output ?? e.text, RUN_LINE_CHARS), ...(e.output ? { output: e.output } : {}), ...(note ? { note } : {}) };
  });
  const earlier = runs.find(isEarlierRuns)?.text;
  return { runs: out, ...(earlier ? { earlier } : {}) };
}

export const ORIGIN_LABELS: Record<Origin, string> = {
  account: "Scheduled in your account",
  local: "Scheduled in this browser",
  adhoc: "Chat message",
};

/** Where a task came from: its TODO list (a claimed run: the account's), or a message typed in Chat. */
export function originOf(input: DetailsInput): Origin | undefined {
  if (input.task) return input.listSource === "account" ? "account" : "local";
  switch (input.session?.source) {
    case "adhoc":
      return "adhoc";
    case "local":
      return "local";
    case "cloud":
      return "account";
    default:
      return undefined;
  }
}

export interface WhenOptions {
  locale?: string | string[];
  timeZone?: string;
}

/** A date and time in the user's locale, e.g. "Sep 24, 2026, 2:30 PM". */
export function formatWhen(iso: string | null | undefined, opts: WhenOptions = {}): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(opts.locale, { dateStyle: "medium", timeStyle: "short", ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
}

/** "Every weekday at 9:00 AM, until Dec 31", plus the rule's time zone when it is not this browser's. Never raw cron. */
export function repeatSentence(repeat: RepeatSchedule | null | undefined, opts: TextOptions & { localZone?: string } = {}): string {
  if (!repeat) return "";
  const zone = repeat.tz === (opts.localZone ?? localTimeZone()) ? "" : ` (${repeat.tz})`;
  return `${describeRepeat(repeat, opts)}${zone}`;
}

export function detailsModel(input: DetailsInput, now = Date.now(), when: WhenOptions = {}): DetailsModel {
  const { task, session } = input;
  const origin = originOf(input);
  const adhoc = origin === "adhoc";
  const fmt = (iso: string | null | undefined) => formatWhen(iso, when);
  const fields: DetailsField[] = [];
  const add = (label: string, value: string | null | undefined, extra: Omit<DetailsField, "label" | "value"> = {}) => {
    const v = value?.trim();
    if (v) fields.push({ label, value: v, ...extra });
  };

  // The text: the TODO entry's, the chat message, else the run's one-line title.
  let text = task?.instructions ?? session?.instructions ?? "";
  let textNote: string | undefined;
  if (!text.trim() && session?.title) {
    text = session.title;
    textNote = session.title.endsWith("…")
      ? "Only the start of the instructions was saved with this run."
      : "Only a one-line copy of the instructions was saved with this run.";
  }

  const chip = task ? taskChip(task, now) : session ? outcomeChip(session.endedAt ? session.outcome : undefined) : undefined;

  add("Account", accountLabel(task ? task.account : session?.account));
  if (origin) add("Source", ORIGIN_LABELS[origin]);

  if (task) {
    add(task.repeat ? "Next run" : "Scheduled at", fmt(task.notBefore));
    if (task.status === "pending" && task.retryAfter && Date.parse(task.retryAfter) > now) add("Tries again", fmt(task.retryAfter));
    const hour12 = when.locale ? new Intl.DateTimeFormat(when.locale, { hour: "numeric" }).resolvedOptions().hour12 : undefined;
    add("Repeats", repeatSentence(task.repeat, { now: new Date(now), ...(hour12 === undefined ? {} : { hour12 }), ...(when.timeZone ? { localZone: when.timeZone } : {}) }));
    fields.push({ label: "Attempts", value: String(task.attempts) });
  }

  // The TODO entry's own record wins; without one, the run's.
  const failure = task ? task.failReason : session?.outcome === "failed" ? session.reason : undefined;
  const pause = task ? task.pauseReason : session?.outcome === "paused" || session?.outcome === "retry" ? session.reason : undefined;
  add("Last failure", failure, { tone: "bad" });
  add("Last pause reason", pause, { tone: "warn" });

  const resultUrl = task ? task.resultUrl : session?.url;
  const summary = task ? task.resultSummary : session?.summary;
  if (resultUrl) add("Result", summary || resultUrl, { href: resultUrl });
  else add("Result", summary);

  if (session) add(task ? "Last run by" : "Run by", sessionHeadline(session));

  if (task) {
    add("Created", fmt(task.createdAt));
    add("Updated", fmt(task.updatedAt));
  } else if (session) {
    add("Started", fmt(session.firstStartedAt ?? session.startedAt));
    add("Ended", fmt(session.endedAt));
  }
  add("Task id", task?.id ?? session?.taskId, { mono: true });
  if (session) add("Run id", session.sessionId, { mono: true });

  const files = (task?.media ?? []).map((m) => ({ name: m.name, detail: [m.type, formatBytes(m.size)].filter(Boolean).join(" · ") }));
  // Cloud tasks list their files by id only.
  if (!files.length && task?.mediaIds.length) {
    for (const id of task.mediaIds) files.push({ name: id, detail: "" });
  }

  const model: DetailsModel = {
    heading: adhoc ? "Chat message" : "Task details",
    textLabel: adhoc ? "Message" : "Instructions",
    copyLabel: adhoc ? "Copy message" : "Copy instructions",
    emptyText: adhoc ? "No message was saved." : "No instructions were saved.",
    text,
    fields,
    files,
  };
  if (textNote) model.textNote = textNote;
  if (chip) model.chip = { ...chip, hint: chipHint(chip.label) };
  if (origin) model.origin = origin;
  if (input.runs?.length) {
    const kept = previousRuns(input.runs, when);
    if (kept.runs.length) model.previousRuns = kept.runs;
    if (kept.earlier) model.earlierRuns = kept.earlier;
  }
  return model;
}

export type TextPart = { text: string } | { url: string };

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** Splits text into plain runs and http(s) links (only those become clickable). */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrlEnd(m[0]);
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ url });
    last = m.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
