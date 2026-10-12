/**
 * Which memory the agent is given at the start of a turn, and what recall
 * finds. Deterministic and cheap (no model call; the only outside input is
 * the account's semantic scores, when there are any).
 *
 * A repeating task's own history comes first, within its own
 * MEMORY_TASK_HISTORY_TOKEN_BUDGET: its profile, the notes remembered for it,
 * its newest runs in full (note and output), its earlier-runs summary, then
 * one short line (date and output) per earlier run, up to
 * MAX_INJECTED_TASK_RUNS. Then, within MEMORY_TOKEN_BUDGET: this task's
 * records whose key the turn names (the request, the user's tab), within their
 * own MEMORY_RECORD_TOKEN_BUDGET, the entries the user pinned, entries for the
 * sites the turn involves (the user's tab, sites named in the request), then
 * what the hybrid search finds for the request (search.ts: words, entities,
 * meaning, time). Nothing else: a turn memory has nothing relevant for gets no
 * memory at all. Pure.
 */
import {
  isEarlierRuns,
  isMemoryRecord,
  isTaskProfile,
  isTaskRun,
  keyTokens,
  MAX_INJECTED_TASK_NOTES,
  MAX_INJECTED_TASK_RUNS,
  MAX_RECALL_RESULTS,
  MEMORY_CHARS_PER_TOKEN,
  MEMORY_KIND_TEXT,
  MEMORY_RECORD_TOKEN_BUDGET,
  MEMORY_TASK_HISTORY_TOKEN_BUDGET,
  MEMORY_TOKEN_BUDGET,
  memoryDomain,
  memoryLine,
  memoryRecordKey,
  onDomain,
  taskRunBrief,
  type MemoryEntry,
  type MemoryKind,
} from "@noa/shared";
import { searchMemory } from "./search.js";

export interface MemoryContext {
  /** The repeating task the run belongs to: its run notes come first. */
  taskKey?: string | null;
  /** Sites the turn involves (hosts): the user's tab, and those named in the request (hostsIn). */
  hosts: readonly string[];
  /** The request (instructions or message), for matching words. */
  text: string;
  /** The user's tab (its address and title): the task's records whose key it names are given too. */
  pageText?: string;
  /** Now, for time words in the request ("last spring"); default the clock. */
  now?: Date;
  /** The user's time zone, minutes east of UTC; default UTC. */
  offsetMinutes?: number;
  /** Entry id -> cosine similarity to the request (the account's semantic search); absent: none. */
  semantic?: ReadonlyMap<string, number>;
}

export interface MemorySelection {
  /** In the order the agent reads them. */
  entries: MemoryEntry[];
  /** Of those, the task's earlier runs given as one short line each (taskRunBrief). */
  brief?: ReadonlySet<string>;
  /** The block for the prompt; "" when nothing was picked. */
  text: string;
  /** Its estimated cost. */
  tokens: number;
}

/** The heading of records in the block (a repeating task's and the user's: what was learned about one thing, by its key). */
export const RECORDS_LABEL = MEMORY_KIND_TEXT.record.label;

/** The block's first line: what these are, and that they may be out of date. */
export const MEMORY_HEADER =
  "Memory from earlier chats and runs (ids in brackets). Use it before exploring; it may be out of date: when an entry proves wrong, remember the corrected fact with the same kind and subject, or forget it by id.";

/** Estimated tokens of a prompt text. */
export const tokensOf = (text: string): number => Math.ceil(text.length / MEMORY_CHARS_PER_TOKEN);

/** Hosts named in a text: URLs and bare domains ("x.com", "mail.google.com/mail/u/2"). */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  // Full addresses first: they name hosts without a dot too (http://localhost:4777/...).
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)"'<>]+/gi)) {
    const host = memoryDomain(m[0]);
    if (host) out.add(host);
  }
  for (const m of text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[\/:?#\s)"',]|$)/gi)) {
    // An email address names a mailbox, not a site.
    if (m.index !== undefined && text[m.index - 1] === "@") continue;
    const host = memoryDomain(m[1]!);
    if (host) out.add(host);
  }
  return [...out];
}

const newestUse = (a: MemoryEntry, b: MemoryEntry) => (b.lastUsedAt ?? b.updatedAt).localeCompare(a.lastUsedAt ?? a.updatedAt);

/**
 * The task's records whose key `text` names, in the order the text names them: the key's words (keyTokens) appear
 * together, whole and in order ("48213" in "no. #48213", not in "148213"; "ada@x.io" whole, not "x.io").
 */
export function recordsNamedIn(records: readonly MemoryEntry[], text: string): MemoryEntry[] {
  const words = keyTokens(text);
  if (!words.length) return [];
  const at = new Map<string, number[]>();
  words.forEach((w, i) => {
    const of = at.get(w);
    if (of) of.push(i);
    else at.set(w, [i]);
  });
  const found: { e: MemoryEntry; i: number }[] = [];
  for (const e of records) {
    if (!e.key) continue;
    const key = e.key.split(" ");
    const i = at.get(key[0]!)?.find((start) => key.every((k, j) => words[start + j] === k));
    if (i !== undefined) found.push({ e, i });
  }
  return found.sort((a, b) => a.i - b.i).map((x) => x.e);
}

/** Entries that may be given in this context: not turned off, not a stopped conversation's episode, and not another task's notes or records (the user's records are). */
function candidates(entries: readonly MemoryEntry[], ctx: MemoryContext, kindsOff: ReadonlySet<MemoryKind>): MemoryEntry[] {
  // A stopped conversation's episode tells where it looked, not what is there: given, the next turn goes back there.
  return entries.filter((e) => !kindsOff.has(e.kind) && !e.stopped && (e.scope !== "task" || (!!ctx.taskKey && e.taskKey === ctx.taskKey)));
}

/** The block's line under the task's history when some of its runs are left out. */
const olderRunsLine = (n: number) => `- (${n} older runs are kept: check_similar compares a draft with all of them; recall finds them)`;

/** This task's own history (not its records): its runs, their summary, and what was remembered for it (its profile first). */
const isTaskHistory = (e: MemoryEntry) => e.kind === "task" && e.scope === "task" && !isMemoryRecord(e);

/**
 * The task's history the agent is given, in the order it reads it, within MEMORY_TASK_HISTORY_TOKEN_BUDGET: its
 * profile and remembered notes, its newest MAX_INJECTED_TASK_NOTES runs in full, its earlier-runs summary, then one
 * short line per earlier run (brief), up to MAX_INJECTED_TASK_RUNS runs in all. `older`: its runs kept but not given.
 */
function taskHistory(pool: readonly MemoryEntry[], lineOpts: { history?: boolean }): { entries: MemoryEntry[]; brief: Set<string>; older: number; tokens: number } {
  const history = pool.filter(isTaskHistory);
  const newestFirst = (a: MemoryEntry, b: MemoryEntry) => b.learnedAt.localeCompare(a.learnedAt);
  const runs = history.filter(isTaskRun).sort(newestFirst);
  const noted = history.filter((e) => !isTaskRun(e) && !isEarlierRuns(e)).sort((a, b) => Number(isTaskProfile(b)) - Number(isTaskProfile(a)) || newestFirst(a, b));
  const full = runs.slice(0, MAX_INJECTED_TASK_NOTES);
  const brief = runs.slice(MAX_INJECTED_TASK_NOTES, MAX_INJECTED_TASK_RUNS);
  const order = [...noted, ...full, ...history.filter(isEarlierRuns), ...brief];
  const briefIds = new Set(brief.map((e) => e.id));
  const out: MemoryEntry[] = [];
  // The heading, and the line that says how many older runs are kept (when some are left out).
  let tokens = history.length ? tokensOf(MEMORY_KIND_TEXT.task.label) + 1 : 0;
  if (runs.length) tokens += tokensOf(olderRunsLine(runs.length)) + 1;
  for (const e of order) {
    const cost = tokensOf(briefIds.has(e.id) ? taskRunBrief(e) : memoryLine(e, lineOpts)) + 1;
    // The runs are newest first: once one does not fit, the older ones are left to recall and check_similar.
    if (tokens + cost > MEMORY_TASK_HISTORY_TOKEN_BUDGET) {
      if (isTaskRun(e)) break;
      continue;
    }
    tokens += cost;
    out.push(e);
  }
  const givenRuns = out.filter(isTaskRun).length;
  const kept = new Set(out.map((e) => e.id));
  return { entries: out, brief: new Set([...briefIds].filter((id) => kept.has(id))), older: runs.length - givenRuns, tokens };
}

/** The entries to give the agent, most relevant first, within `budget` tokens, and the block that says them. */
export function selectMemory(
  entries: readonly MemoryEntry[],
  ctx: MemoryContext,
  opts: { kindsOff?: readonly MemoryKind[]; budget?: number } = {},
): MemorySelection {
  const pool = candidates(entries, ctx, new Set(opts.kindsOff ?? []));
  const hosts = ctx.hosts.map((h) => memoryDomain(h)).filter((h): h is string => !!h);

  const named = recordsNamedIn(pool.filter(isMemoryRecord).sort(taskRecordsFirst), `${ctx.text}\n${ctx.pageText ?? ""}`);
  const pinned = pool.filter((e) => e.pinned).sort(newestUse);
  const onSite = pool.filter((e) => e.scope === "domain" && hosts.some((h) => onDomain(h, e.domain!))).sort(newestUse);
  const found = searchMemory(pool, ctx.text, searchOptions(ctx));
  const matched = found.hits.map((h) => h.entry);
  // Asked what something was before: the facts' earlier values are part of the answer.
  const lineOpts = { history: found.time.past };
  // The task's own history has its own budget; the rest of memory is not spent on it.
  const history = taskHistory(pool, lineOpts);

  const budget = opts.budget ?? MEMORY_TOKEN_BUDGET;
  let spent = tokensOf(MEMORY_HEADER);
  let spentOnRecords = 0;
  const picked = new Map<string, MemoryEntry>(history.entries.map((e) => [e.id, e]));
  const groups = new Set<string>();
  for (const e of [...named, ...pinned, ...onSite, ...matched]) {
    if (picked.has(e.id) || isTaskHistory(e)) continue;
    const group = groupOf(e);
    const cost = tokensOf(memoryLine(e, lineOpts)) + 1 + (groups.has(group) ? 0 : tokensOf(group) + 1);
    if (spent + cost > budget) continue;
    if (isMemoryRecord(e) && spentOnRecords + cost > MEMORY_RECORD_TOKEN_BUDGET) continue;
    spent += cost;
    if (isMemoryRecord(e)) spentOnRecords += cost;
    picked.set(e.id, e);
    groups.add(group);
  }
  if (!picked.size) return { entries: [], text: "", tokens: 0 };
  const chosen = [...picked.values()];
  const text = memoryBlock(chosen, { ...lineOpts, brief: history.brief, olderRuns: history.older });
  return { entries: chosen, text, tokens: tokensOf(text), ...(history.brief.size ? { brief: history.brief } : {}) };
}

const searchOptions = (ctx: Pick<MemoryContext, "now" | "offsetMinutes" | "taskKey" | "semantic">) => ({
  now: ctx.now ?? new Date(),
  ...(ctx.offsetMinutes !== undefined ? { offsetMinutes: ctx.offsetMinutes } : {}),
  ...(ctx.taskKey ? { taskKey: ctx.taskKey } : {}),
  ...(ctx.semantic ? { semantic: ctx.semantic } : {}),
});

/** The heading an entry goes under in the block: its kind's label, or RECORDS_LABEL for a record. */
const groupOf = (e: MemoryEntry): string => (isMemoryRecord(e) ? RECORDS_LABEL : MEMORY_KIND_TEXT[e.kind].label);

/**
 * The block the agent reads: the header, then the entries under their heading (task records, task history,
 * episodes, playbooks, accounts, people, preferences). history: facts say their earlier values too. brief: the task's
 * runs said in one short line each (taskRunBrief); olderRuns: how many of its runs are kept but not given.
 */
export function memoryBlock(entries: readonly MemoryEntry[], opts: { history?: boolean; brief?: ReadonlySet<string>; olderRuns?: number } = {}): string {
  const lines = [MEMORY_HEADER];
  const order = [RECORDS_LABEL, ...(Object.keys(MEMORY_KIND_TEXT) as MemoryKind[]).map((k) => MEMORY_KIND_TEXT[k].label)];
  for (const group of order) {
    const of = entries.filter((e) => groupOf(e) === group);
    if (!of.length) continue;
    lines.push(`${group}:`, ...of.map((e) => `- ${opts.brief?.has(e.id) ? taskRunBrief(e) : memoryLine(e, opts)}`));
    if (group === MEMORY_KIND_TEXT.task.label && opts.olderRuns) lines.push(olderRunsLine(opts.olderRuns));
  }
  return lines.join("\n");
}

/** A repeating task's own records before the user's (the task's record for a key wins). */
const taskRecordsFirst = (a: MemoryEntry, b: MemoryEntry) => Number(a.taskKey === undefined) - Number(b.taskKey === undefined);

/**
 * The record for `key` (as the agent wrote it: memoryRecordKey normalizes it): in a repeating task (`taskKey`) its
 * own record, else the user's; in a chat (null) the user's. Null when there is none.
 */
export function recordFor(entries: readonly MemoryEntry[], taskKey: string | null, key: string): MemoryEntry | null {
  const k = memoryRecordKey(key);
  if (!k) return null;
  const of = (space: string | undefined) => entries.find((e) => isMemoryRecord(e) && e.taskKey === space && e.key === k);
  return (taskKey ? of(taskKey) : undefined) ?? of(undefined) ?? null;
}

/**
 * recall: the entries that best match `query` (search.ts: words, entities, sites, meaning, time), whichever task
 * or site they belong to; of records, the user's and those of `taskKey` (the turn's task; never another task's),
 * the one whose key is the query itself first (the task's before the user's). Nothing matches: [].
 */
export function recallMemory(
  entries: readonly MemoryEntry[],
  query: string,
  opts: { kindsOff?: readonly MemoryKind[]; max?: number; taskKey?: string | null; now?: Date; offsetMinutes?: number; semantic?: ReadonlyMap<string, number> } = {},
): MemoryEntry[] {
  const off = new Set(opts.kindsOff ?? []);
  const pool = entries.filter((e) => !off.has(e.kind) && (!isMemoryRecord(e) || e.taskKey === undefined || (!!opts.taskKey && e.taskKey === opts.taskKey)));
  const exact = memoryRecordKey(query);
  const byKey = pool.filter((e) => isMemoryRecord(e) && e.key === exact).sort(taskRecordsFirst);
  const found = searchMemory(pool, query, { ...searchOptions(opts), recordWords: true }).hits.map((h) => h.entry);
  return [...new Set([...byKey, ...found])].slice(0, opts.max ?? MAX_RECALL_RESULTS);
}
