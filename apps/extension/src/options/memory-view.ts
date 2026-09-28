/**
 * Settings > Memory, as data: memory on or paused, one group per kind (its
 * switch, its entries newest first, each with where it applies and where it
 * came from), and the "Forget everything" confirmation. Task history is
 * grouped by repeating task: its run notes and its records (filed by key),
 * with a count and "delete this task's memory". Episodes (a dated summary of
 * each chat and run) are listed by when they happened, with the sites and
 * things they involve; they are deleted, not edited. The user's own records
 * (filed by key in chats) are their own group, shown like a task's records;
 * both long groups show a page at a time. Facts can be pinned
 * (given at every turn) and show what they said before they changed. A
 * search narrows every group to the entries that match. The page
 * (memory-section.ts) only renders this. Pure.
 */
import { isMemoryRecord, MEMORY_KIND_TEXT, MEMORY_KINDS, memoryDate, plansWithText, type ExtensionSettings, type MemoryEntry, type MemoryKind } from "@noa/shared";
import type { MemorySyncStatus } from "../memory/sync.js";
import { memoryQuestionText } from "../ui/memory-question.js";

/** Records a task group shows at first, and how many more each "Show more" adds. */
export const RECORDS_PAGE = 50;
/** Episodes the Episodes group shows at first, and how many more each "Show more" adds. */
export const EPISODES_PAGE = 20;

/** The groups listed a page at a time (their entries can run into the hundreds), and the page of each. */
const KIND_PAGE: Partial<Record<MemoryKind, number>> = { episode: EPISODES_PAGE, record: RECORDS_PAGE };

/** What a kind's switch says while it is off, when "not given, not saved" does not say it right. */
const KIND_OFF_HINT: Partial<Record<MemoryKind, string>> = {
  episode: "Off: no episodes are written after chats and runs, and none are given to the agent",
  record: "Off: records are neither filed nor given to the agent",
};
const DEFAULT_OFF_HINT = "Off: not given to the agent, not saved";

/** The kinds of fact the user can pin (given at every turn); task history and episodes are not facts to pin. */
export const PINNABLE_KINDS: readonly MemoryKind[] = ["preference", "account", "person", "playbook"];

/** The pin control's two choices, and what each means (its tooltip). */
export const PIN_TEXT = {
  pinned: { label: "Always give", hint: "Given to the agent at the start of every turn" },
  relevant: { label: "Only when relevant", hint: "Given to the agent when a turn is about it; it can also search for it" },
} as const;

export interface MemoryEntryView {
  id: string;
  subject: string;
  text: string;
  /** Where it applies: "mail.google.com", "Task: Post a daily tip", or "" (everywhere, or its task's group says). */
  where: string;
  /** `where` is a site (shown as an address). */
  site: boolean;
  /** "Learned Sep 24 · used Sep 26 · from “Check my inbox”". */
  meta: string;
  /** A task's record: its dated notes, oldest first ("Sep 24", the note). */
  notes?: { when: string; text: string }[];
  /** It can be edited (an episode is a summary: it is deleted instead). */
  editable: boolean;
  /** A fact the user can pin: whether it is given at every turn. Absent: not pinnable. */
  pinned?: boolean;
  /** What it said before it changed, newest first: "Before: <text> (until Sep 20)". */
  history?: string[];
  /** An episode: when it happened ("Sep 24, 3:05 PM"). */
  when?: string;
  /** The sites and things it involves (an episode's chips). */
  entities?: string[];
}

/** One repeating task's memory: its run notes and its records. */
export interface MemoryTaskView {
  taskKey: string;
  /** The task's first line. */
  title: string;
  /** Run notes, newest first. */
  notes: MemoryEntryView[];
  /** Records, most recently changed first. */
  records: MemoryEntryView[];
  /** "2 run notes · 1,000 records". */
  countText: string;
  /** Everything the task keeps, searched for or not (what "delete this task's memory" deletes). */
  total: number;
}

export interface MemoryKindView {
  kind: MemoryKind;
  label: string;
  hint: string;
  /** What its switch says while it is off. */
  offHint: string;
  /** The kind is used and saved (its switch). */
  on: boolean;
  /** Its entries, when they are not grouped by task. */
  entries: MemoryEntryView[];
  /** Its entries are shown this many at a time ("Show more"); absent: all at once. */
  page?: number;
  /** Task history: one group per repeating task, most recently changed first. */
  tasks: MemoryTaskView[];
  /** Entries shown in all (entries, or the tasks' notes and records). */
  count: number;
}

export interface MemoryPanel {
  /** Memory is on (not paused). */
  on: boolean;
  /** Shown under the switch while memory is paused. */
  pausedNote: string;
  kinds: MemoryKindView[];
  total: number;
  /** No entry at all: what the page says instead of the groups. */
  empty: boolean;
  /** The search: what is looked for ("" none), and what it found. */
  search: { query: string; found: number };
}

/** "Sep 24, 3:05 PM" (the year too when it is not `now`'s): when an episode happened. */
export function dayTimeText(iso: string, now: Date): string {
  const day = dayText(iso, now);
  return day && `${day}, ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** "Sep 24", or "Sep 24, 2025" in another year than `now`'s. */
export function dayText(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Task history is listed under its task (the group names it), not with "Task: ..." on each entry. */
const grouped = (e: MemoryEntry) => e.kind === "task" && !!e.taskKey;

function entryView(e: MemoryEntry, now: Date): MemoryEntryView {
  const where = e.scope === "domain" && e.domain ? e.domain : e.scope === "task" && !grouped(e) ? `Task: ${e.taskTitle ?? "a repeating task"}` : "";
  // A task's own notes and records come from that task, which the group already names.
  const ownTask = e.scope === "task" && e.source.title === e.taskTitle;
  const from = ownTask ? "" : e.source.kind === "user" ? "added by you" : e.source.title ? `from “${e.source.title}”` : e.source.kind === "task" ? "from a task" : "from a chat";
  const learned = dayText(e.learnedAt, now);
  const parts = [`Learned ${learned}`];
  if (e.updatedAt !== e.learnedAt && dayText(e.updatedAt, now) !== learned) parts.push(`updated ${dayText(e.updatedAt, now)}`);
  parts.push(e.lastUsedAt ? `used ${dayText(e.lastUsedAt, now)}` : "not used yet");
  if (from) parts.push(from);
  const v: MemoryEntryView = { id: e.id, subject: e.subject, text: e.text, where, site: e.scope === "domain" && !!e.domain, meta: parts.join(" · "), editable: true };
  if (e.notes?.length) v.notes = e.notes.map((n) => ({ when: dayText(n.at, now), text: n.text }));
  if (PINNABLE_KINDS.includes(e.kind) && !isMemoryRecord(e)) v.pinned = e.pinned === true;
  if (e.history?.length) v.history = e.history.map((h) => historyLine(h, e.subject, now));
  if (e.entities?.length) v.entities = [...e.entities];
  return v;
}

/** "Before: <text> (until Sep 20)", with the subject it had when that was another one. */
export function historyLine(h: NonNullable<MemoryEntry["history"]>[number], subject: string, now: Date): string {
  const was = h.subject.trim().toLowerCase() === subject.trim().toLowerCase() ? "" : `${h.subject}: `;
  return `Before: ${was}${h.text} (until ${dayText(h.until, now)})`;
}

/** An episode: when it happened, what it was, the sites and things in it, and the task it came from. */
function episodeView(e: MemoryEntry, now: Date): MemoryEntryView {
  const parts = [e.taskTitle ? `from “${e.taskTitle}”` : "", e.lastUsedAt ? `used ${dayText(e.lastUsedAt, now)}` : ""].filter(Boolean);
  const v: MemoryEntryView = { id: e.id, subject: e.subject, text: e.text, where: "", site: false, meta: parts.join(" · "), editable: false, when: dayTimeText(memoryDate(e), now) };
  if (e.entities?.length) v.entities = [...e.entities];
  return v;
}

const newestFirst = (a: MemoryEntry, b: MemoryEntry) => b.updatedAt.localeCompare(a.updatedAt);
/** Episodes by when they happened, newest first. */
const newestHappenedFirst = (a: MemoryEntry, b: MemoryEntry) => memoryDate(b).localeCompare(memoryDate(a));
/** Pinned facts first (the few always given), then newest first. */
const pinnedThenNewest = (a: MemoryEntry, b: MemoryEntry) => Number(b.pinned === true) - Number(a.pinned === true) || newestFirst(a, b);

/** The entry has every word of the search in what Settings shows of it (case aside). */
export function matchesSearch(e: MemoryEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [e.subject, e.text, e.key, e.domain, e.taskTitle, ...(e.notes ?? []).map((n) => n.text), ...(e.entities ?? []), ...(e.history ?? []).flatMap((h) => [h.subject, h.text])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Task history grouped by task, most recently changed task first; `totals`: all each task keeps. */
function taskGroups(entries: readonly MemoryEntry[], now: Date, totals: ReadonlyMap<string, number>): MemoryTaskView[] {
  const byTask = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const of = byTask.get(e.taskKey!);
    if (of) of.push(e);
    else byTask.set(e.taskKey!, [e]);
  }
  return [...byTask.entries()]
    .map(([taskKey, of]) => {
      const sorted = of.slice().sort(newestFirst);
      const notes = sorted.filter((e) => !isMemoryRecord(e));
      const records = sorted.filter(isMemoryRecord);
      const parts = [...(notes.length ? [count(notes.length, "run note")] : []), ...(records.length ? [count(records.length, "record")] : [])];
      return {
        view: {
          taskKey,
          title: sorted.find((e) => e.taskTitle)?.taskTitle ?? "A repeating task",
          notes: notes.map((e) => entryView(e, now)),
          records: records.map((e) => entryView(e, now)),
          countText: parts.join(" · "),
          total: totals.get(taskKey) ?? of.length,
        },
        at: sorted[0]!.updatedAt,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((x) => x.view);
}

export function memoryPanel(
  entries: readonly MemoryEntry[],
  settings: Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">,
  now = new Date(),
  query = "",
): MemoryPanel {
  const q = query.trim();
  const shown = q ? entries.filter((e) => matchesSearch(e, q)) : entries;
  const totals = new Map<string, number>();
  for (const e of entries) if (grouped(e)) totals.set(e.taskKey!, (totals.get(e.taskKey!) ?? 0) + 1);
  const kinds = MEMORY_KINDS.map((kind): MemoryKindView => {
    const of = shown.filter((e) => e.kind === kind);
    const page = KIND_PAGE[kind];
    return {
      kind,
      label: MEMORY_KIND_TEXT[kind].label,
      hint: MEMORY_KIND_TEXT[kind].hint,
      offHint: KIND_OFF_HINT[kind] ?? DEFAULT_OFF_HINT,
      on: !settings.memoryKindsOff.includes(kind),
      entries:
        kind === "episode"
          ? of.sort(newestHappenedFirst).map((e) => episodeView(e, now))
          : of
              .filter((e) => !grouped(e))
              .sort(pinnedThenNewest)
              .map((e) => entryView(e, now)),
      ...(page ? { page } : {}),
      tasks: taskGroups(of.filter(grouped), now, totals),
      count: of.length,
    };
  });
  return {
    on: !settings.memoryPaused,
    pausedNote: settings.memoryPaused ? "Paused: the agent is given nothing from memory and saves nothing. What is kept stays until you delete it." : "",
    kinds,
    total: entries.length,
    empty: entries.length === 0,
    search: { query: q, found: shown.length },
  };
}

/** The kinds that are off after the switch of `kind` is set to `on` (in the order of MEMORY_KINDS). */
export function kindsOffAfter(current: readonly MemoryKind[], kind: MemoryKind, on: boolean): MemoryKind[] {
  const off = new Set(current);
  if (on) off.delete(kind);
  else off.add(kind);
  return MEMORY_KINDS.filter((k) => off.has(k));
}

/**
 * Where memory is kept, under "Use memory": synced with the account, or on this computer only (and how to sync it).
 * `action`: the buttons that go with it (ask: Add / Keep separate; add: Add to the account).
 */
export function syncText(s: MemorySyncStatus | undefined, now = new Date()): { text: string; tone: "ok" | "bad" | ""; action?: "ask" | "add"; account?: string } {
  if (!s) return { text: "", tone: "" };
  if (s.state === "signed-out") return { text: `Kept on this computer only. Log in with ${plansWithText("todo")} to have it in your other browsers too.`, tone: "" };
  if (s.state === "no-plan") return { text: `Kept on this computer only. With ${plansWithText("todo")} it syncs to your account, for your other browsers.`, tone: "" };
  if (s.state === "ask") return { text: `${memoryQuestionText(s.account).question} Nothing is sent until you choose.`, tone: "", action: "ask", account: s.account };
  if (s.state === "separate") return { text: `Kept on this computer only: you chose not to add it to ${s.account}.`, tone: "", action: "add", account: s.account };
  if (s.error) return { text: `Not synced with your account just now: ${s.error}. It tries again with the next change.`, tone: "bad" };
  const when = s.lastSyncAt ? `, last ${dayText(s.lastSyncAt, now)} ${new Date(s.lastSyncAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "";
  return { text: `Synced with your account${when}.`, tone: "ok" };
}

/** "Forget everything": the question while confirming, and the button's label for each step. */
export function forgetAllText(total: number, confirming: boolean): { button: string; question: string } {
  if (!confirming) return { button: "Forget everything", question: "" };
  return {
    button: total ? `Yes, forget ${total} ${total === 1 ? "memory" : "memories"}` : "Nothing to forget",
    question: total ? `Forget all ${total} ${total === 1 ? "memory" : "memories"}? This can't be undone.` : "There is nothing in memory.",
  };
}

/** "Delete this task's memory": the question while confirming, and the button's label for each step. */
export function forgetTaskText(total: number, confirming: boolean): { button: string; question: string } {
  if (!confirming) return { button: "Delete this task's memory", question: "" };
  return {
    button: `Yes, delete ${count(total, "entry", "entries")}`,
    question: `Delete everything this task keeps (${count(total, "entry", "entries")})? This can't be undone.`,
  };
}

/** The quiet line while past chats are summarized into episodes in the background. */
export function backfillText(p: { done: number; total: number }): string {
  return `Summarising past chats: ${p.done}/${p.total}`;
}
