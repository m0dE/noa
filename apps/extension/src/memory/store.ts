/**
 * The agent's long-term memory on this computer: MemoryEntry records in
 * chrome.storage.local (like the local task list), one serialized
 * read-modify-write at a time. Every write goes through the same checks: the
 * entry's shape and limits, and no secret (memoryWriteProblem). Remembering
 * the same kind, subject and place again replaces the entry, so a correction
 * ("that button moved") updates it instead of adding a contradicting one.
 * Records (putRecord) are filed by a key in a space, a repeating task's or
 * (from a chat) the user's: saving the same key again adds a dated note to
 * the record. Records are capped per space (MAX_TASK_RECORDS), apart from the rest of memory
 * (MAX_MEMORY_ENTRIES), so neither pushes the other out; so are episodes (MAX_EPISODES), one per conversation, and task
 * history (MAX_TASK_HISTORY_ENTRIES). A task keeps its newest MAX_TASK_RUNS runs (note and output) one by one; older
 * ones are folded into its earlier-runs summary (runs.ts). A task's memory moves to its series' key (rekeyTask).
 * A fact replaced (the same slot again, or an entry named by `replaces`) keeps its earlier value as history, so
 * "what was it before" can still be answered while the newest value is what the agent is given.
 * Each change is returned as before / after (and the entry it replaced), which is what Undo puts back.
 */
import {
  condenseRecord,
  EARLIER_RUNS_SUBJECT,
  isEarlierRuns,
  isMemoryRecord,
  isTaskRun,
  MAX_EPISODES,
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_ENTITIES,
  MAX_MEMORY_HISTORY,
  MAX_TASK_HISTORY_ENTRIES,
  MAX_TASK_RECORDS,
  MAX_TASK_RUNS,
  MemoryEntrySchema,
  memoryDate,
  memoryWriteProblem,
  type MemoryDeletion,
  type MemoryEntry,
  type MemoryKind,
  type MemoryPastValue,
  type MemoryScope,
  type MemorySource,
} from "@noa/shared";
import { Listeners } from "../listeners.js";
import type { StorageLike } from "../engine/kv.js";
import { earlierRunsText } from "./runs.js";

export const MEMORY_STORAGE_KEY = "memory";
/** The task series whose older memory keys were already moved to theirs (MemoryService adopts them once). */
export const MEMORY_ADOPTED_KEY = "memoryAdoptedSeries";
/** Series remembered as adopted (past it the oldest are forgotten: adopting again is harmless). */
const MAX_ADOPTED = 2000;

/** A fact to keep, as the service settled it (scope and its place checked). */
export interface NewMemory {
  kind: MemoryKind;
  subject: string;
  text: string;
  scope: MemoryScope;
  domain?: string;
  taskKey?: string;
  taskTitle?: string;
  /** A task run (with the note option): what it produced (task_complete `output`). */
  output?: string;
}

/** A dated summary of one conversation (a chat or a task run), as the background writer settled it. */
export interface NewEpisode {
  subject: string;
  text: string;
  /** When the conversation started. */
  at: string;
  entities?: string[];
  /** A task run: its task (the episode stays global: it answers "what did we do" from anywhere). */
  taskKey?: string;
  taskTitle?: string;
  /** The user stopped the conversation before it finished (MemoryEntry.stopped). */
  stopped?: boolean;
}

/** A fact about one thing, filed under its key (normalized: memoryRecordKey) in a repeating task's records or the user's. */
export interface NewRecord {
  /** The repeating task whose records it goes in; absent: the user's records (from a chat). */
  taskKey?: string;
  taskTitle?: string;
  key: string;
  /** How the record is named (in Settings, to the agent): given, else kept, else the key as first written. */
  subject?: string;
  /** The key as the agent wrote it. */
  keyAsWritten: string;
  text: string;
}

/** One change to memory: the entry before and after (null: it did not exist / it was removed). */
export interface MemoryChange {
  before: MemoryEntry | null;
  after: MemoryEntry | null;
  /** An entry of another subject this one replaced (remember's `replaces`): removed; Undo puts it back. */
  replaced?: MemoryEntry;
}

/** A write memory refuses (a secret, a limit): the message says why, for the agent or the user. */
export class MemoryRefusal extends Error {}

/** What a write on this computer changed (sync sends it to the account): entries added or changed, entries removed. */
export interface LocalWrite {
  upserted: string[];
  removed: MemoryDeletion[];
}

export interface MemoryStoreOptions {
  /** Default chrome.storage.local (looked up lazily). */
  storage?: StorageLike;
  now?: () => Date;
  /** A new entry id; default a short random one ("m3k9x"), short so the agent can name it. */
  newId?: () => string;
}

/** The same text, spacing and case aside. */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** Entries that are the same fact's slot: same kind, subject and place. A task's run notes are never merged, records are not slots. */
export function sameSlot(e: MemoryEntry, m: NewMemory): boolean {
  if (isMemoryRecord(e) || e.kind !== m.kind || e.scope !== m.scope || !sameText(e.subject, m.subject)) return false;
  if (m.scope === "domain") return e.domain === m.domain;
  if (m.scope === "task") return e.taskKey === m.taskKey;
  return true;
}

/** A fact: a preference, an account, a person or a playbook (not a record, a run note nor an episode). */
const isFact = (e: MemoryEntry): boolean => !isMemoryRecord(e) && e.kind !== "task" && e.kind !== "episode" && e.kind !== "record";

/** The groups episodes and task history are capped in (capped). */
const EPISODES = "episodes";
const TASK_HISTORY = "task history";

/** When an entry last mattered: used, else changed. */
const lastTouched = (e: MemoryEntry) => e.lastUsedAt ?? e.updatedAt;

export class MemoryStore {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private lock: Promise<unknown> = Promise.resolve();
  /**
   * What is stored, as last read or written here: this store (the background's) is the only writer of
   * MEMORY_STORAGE_KEY, so it is read and checked once, not at every turn (thousands of task records).
   */
  private cached: MemoryEntry[] | null = null;
  private readonly changes = new Listeners();
  private readonly writes = new Listeners<[LocalWrite]>();

  constructor(private readonly opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => `m${Math.random().toString(36).slice(2, 7)}`);
  }

  /** Called after every change. */
  onChange(fn: () => void): () => void {
    return this.changes.add(fn);
  }

  /** Called after each change made on this computer (not for changes from the account, nor lastUsedAt), with what it changed. */
  onLocalWrite(fn: (w: LocalWrite) => void): () => void {
    return this.writes.add(fn);
  }

  /**
   * Changes from the account (another browser): an entry newer than the one here (or not here) replaces it, a deletion
   * newer than the entry here removes it. Entries that fail the checks here are skipped. Not a local write.
   */
  async applyRemote(entries: readonly MemoryEntry[], deleted: readonly MemoryDeletion[]): Promise<void> {
    if (!entries.length && !deleted.length) return;
    await this.mutate(
      (current) => {
        const byId = new Map(current.map((e) => [e.id, e]));
        for (const e of entries) {
          const here = byId.get(e.id);
          // The same version (its own write coming back) stays as this computer has it: a server on an older schema
          // sends it back without the fields it does not know (e.g. an episode's stopped).
          if (here && here.updatedAt >= e.updatedAt) continue;
          try {
            byId.set(e.id, this.checked({ ...e, ...(here?.lastUsedAt ? { lastUsedAt: here.lastUsedAt } : {}) }));
          } catch {
            /* an entry this computer refuses is left out */
          }
        }
        for (const d of deleted) {
          const here = byId.get(d.id);
          if (here && here.updatedAt <= d.at) byId.delete(d.id);
        }
        return { entries: capped([...byId.values()]), result: undefined };
      },
      { remote: true },
    );
  }

  async list(): Promise<MemoryEntry[]> {
    return [...(await this.read())];
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return (await this.read()).find((e) => e.id === id) ?? null;
  }

  /**
   * Keeps a fact: replaces the entry in the same slot (sameSlot), else adds one. `note`: a task's run (its note and
   * output), always added (past MAX_TASK_RUNS the task's oldest runs are folded into its earlier-runs summary). Throws
   * MemoryRefusal when it must not be kept.
   */
  async put(m: NewMemory, source: MemorySource, opts: { note?: boolean; replaces?: string } = {}): Promise<MemoryChange> {
    return this.mutate((entries) => {
      const at = this.now().toISOString();
      const before = opts.note ? null : (entries.find((e) => sameSlot(e, m)) ?? null);
      const replaced = opts.replaces && !opts.note ? this.replaceable(entries, opts.replaces, before) : undefined;
      const history = pastValues([before, replaced], m, at);
      const { history: _h, ...kept } = before ?? { id: this.uniqueId(entries), learnedAt: at };
      const after = this.checked({
        ...kept,
        kind: m.kind,
        subject: m.subject.trim(),
        text: m.text.trim(),
        scope: m.scope,
        ...(m.domain ? { domain: m.domain } : {}),
        ...(m.taskKey ? { taskKey: m.taskKey } : {}),
        ...(m.taskTitle ? { taskTitle: m.taskTitle } : {}),
        ...(m.output ? { output: m.output } : {}),
        ...(history.length ? { history } : {}),
        source,
        updatedAt: at,
      });
      let next = before ? entries.map((e) => (e.id === before.id ? after : e)) : [...entries, after];
      if (replaced) next = next.filter((e) => e.id !== replaced.id);
      if (opts.note && m.taskKey) next = this.foldOldRuns(next, m.taskKey, at);
      return { entries: capped(next), result: { before, after, ...(replaced ? { replaced } : {}) } };
    });
  }

  /**
   * Keeps the episode of one conversation (source.sessionId): a later summary of the same conversation replaces
   * its episode. Past MAX_EPISODES the oldest episodes go. Throws MemoryRefusal when it must not be kept.
   */
  async putEpisode(ep: NewEpisode, source: MemorySource): Promise<MemoryChange> {
    return this.mutate((entries) => {
      const now = this.now().toISOString();
      const before = (source.sessionId && entries.find((e) => e.kind === "episode" && e.source.sessionId === source.sessionId)) || null;
      const entities = [...new Set((ep.entities ?? []).map((x) => x.trim()).filter(Boolean))].slice(0, MAX_MEMORY_ENTITIES);
      const after = this.checked({
        ...(before ? { id: before.id, learnedAt: before.learnedAt } : { id: this.uniqueId(entries), learnedAt: now }),
        kind: "episode",
        scope: "global",
        subject: ep.subject.trim(),
        text: ep.text.trim(),
        at: ep.at,
        ...(entities.length ? { entities } : {}),
        ...(ep.taskKey ? { taskKey: ep.taskKey } : {}),
        ...(ep.taskTitle ? { taskTitle: ep.taskTitle } : {}),
        ...(ep.stopped ? { stopped: true as const } : {}),
        source,
        updatedAt: now,
      });
      const next = before ? entries.map((e) => (e.id === before.id ? after : e)) : [...entries, after];
      return { entries: capped(next), result: { before, after } };
    });
  }

  /** The user marks an entry to be given at every turn (pinned), or unmarks it. */
  async setPinned(id: string, pinned: boolean): Promise<MemoryChange> {
    return this.mutate((entries) => {
      const before = entries.find((e) => e.id === id);
      if (!before) throw new MemoryRefusal("That memory entry no longer exists");
      if (pinned && !isFact(before)) throw new MemoryRefusal("Only facts (preferences, accounts, people, playbooks) can be given at every turn");
      const { pinned: _p, ...rest } = before;
      const after = this.checked({ ...rest, ...(pinned ? { pinned: true as const } : {}), updatedAt: this.now().toISOString() });
      return { entries: entries.map((e) => (e.id === id ? after : e)), result: { before, after } };
    });
  }

  /** Marks the episodes `ids` as of conversations the user stopped (MemoryEntry.stopped); other entries are left as they are. */
  async markStopped(ids: readonly string[]): Promise<number> {
    const marked = new Set(ids);
    return this.mutate((entries) => {
      let n = 0;
      const next = entries.map((e) => {
        if (!marked.has(e.id) || e.kind !== "episode" || e.stopped) return e;
        n++;
        return this.checked({ ...e, stopped: true as const, updatedAt: this.now().toISOString() });
      });
      return { entries: next, result: n };
    });
  }

  /** The entry `id` names for remember's `replaces`: a fact (not a record, an episode, a run note, nor the slot itself). */
  private replaceable(entries: readonly MemoryEntry[], id: string, slot: MemoryEntry | null): MemoryEntry | undefined {
    const clean = id.replace(/^\[|\]$/g, "");
    if (slot?.id === clean) return undefined;
    const e = entries.find((x) => x.id === clean);
    if (!e) throw new MemoryRefusal(`Not saved: there is no memory entry ${clean} to replace. Remember it without replaces, or recall to find the entry's id.`);
    if (!isFact(e)) throw new MemoryRefusal(`Not saved: ${clean} is not a fact that can be replaced (only preferences, accounts, people and playbooks are).`);
    return e;
  }

  /**
   * Files a fact in the record for `r.key` in its space (the task's, or the user's): a new record takes it as its
   * summary; an existing one gets it as a dated note (the same text again adds nothing), then condenseRecord keeps it
   * within its limits. Past MAX_TASK_RECORDS the space's least recently used record goes. Throws MemoryRefusal when
   * it must not be kept.
   */
  async putRecord(r: NewRecord, source: MemorySource): Promise<MemoryChange> {
    return this.mutate((entries) => {
      const at = this.now().toISOString();
      const before = entries.find((e) => isMemoryRecord(e) && e.taskKey === r.taskKey && e.key === r.key) ?? null;
      const text = r.text.trim();
      let body: { text: string; notes: MemoryEntry["notes"] };
      if (!before) body = { text, notes: [] };
      else if ([before.text, ...(before.notes ?? []).map((n) => n.text)].some((t) => sameText(t, text))) body = { text: before.text, notes: before.notes ?? [] };
      else body = condenseRecord(before.text, [...(before.notes ?? []), { at, text }]);
      const { notes: _old, ...rest } = before ?? { id: this.uniqueId(entries), learnedAt: at };
      const after = this.checked({
        ...rest,
        ...(r.taskKey ? { kind: "task", scope: "task", taskKey: r.taskKey, ...(r.taskTitle ? { taskTitle: r.taskTitle } : {}) } : { kind: "record", scope: "global" }),
        key: r.key,
        subject: (r.subject ?? before?.subject ?? r.keyAsWritten).trim(),
        text: body.text,
        ...(body.notes?.length ? { notes: body.notes } : {}),
        source,
        updatedAt: at,
      } as MemoryEntry);
      const next = before ? entries.map((e) => (e.id === before.id ? after : e)) : [...entries, after];
      return { entries: capped(next), result: { before, after } };
    });
  }

  /**
   * Moves what was kept under the `from` keys (runs, notes, records, episodes) to `to`: MemoryService adopts the keys a
   * task had before it had a series (its instructions' hash). A record whose key `to` already has is folded into that
   * record (its text and notes as dated notes). Returns how many entries moved.
   */
  async rekeyTask(from: readonly string[], to: string): Promise<number> {
    const moving = new Set(from.filter((k) => k !== to));
    if (!moving.size) return 0;
    return this.mutate((entries) => {
      const at = this.now().toISOString();
      const records = new Map(entries.filter((e) => isMemoryRecord(e) && e.taskKey === to).map((e) => [e.key!, e]));
      const merged = new Map<string, MemoryEntry>();
      let next: MemoryEntry[] = [];
      let moved = 0;
      for (const e of entries) {
        if (!e.taskKey || !moving.has(e.taskKey)) {
          next.push(e);
          continue;
        }
        moved++;
        const same = isMemoryRecord(e) ? records.get(e.key!) : undefined;
        if (!same) {
          next.push(this.checked({ ...e, taskKey: to, updatedAt: at }));
          continue;
        }
        const { notes: had, ...base } = merged.get(same.id) ?? same;
        const notes = [...(had ?? []), { at: e.learnedAt, text: e.text }, ...(e.notes ?? [])].sort((a, b) => a.at.localeCompare(b.at));
        const body = condenseRecord(base.text, notes);
        merged.set(same.id, this.checked({ ...base, text: body.text, ...(body.notes.length ? { notes: body.notes } : {}), updatedAt: at }));
      }
      if (merged.size) next = next.map((e) => merged.get(e.id) ?? e);
      next = this.foldOldRuns(next, to, at);
      return { entries: capped(next), result: moved };
    });
  }

  /** Whether the older keys of the series whose key is `taskKey` were adopted already (rekeyTask). */
  async adopted(taskKey: string): Promise<boolean> {
    const got = (await this.storage().get(MEMORY_ADOPTED_KEY))[MEMORY_ADOPTED_KEY];
    return Array.isArray(got) && got.includes(taskKey);
  }

  async markAdopted(taskKey: string): Promise<void> {
    const got = (await this.storage().get(MEMORY_ADOPTED_KEY))[MEMORY_ADOPTED_KEY];
    const keys = Array.isArray(got) ? got.filter((k): k is string => typeof k === "string" && k !== taskKey) : [];
    await this.storage().set({ [MEMORY_ADOPTED_KEY]: [...keys, taskKey].slice(-MAX_ADOPTED) });
  }

  /**
   * A task's runs past MAX_TASK_RUNS, the oldest first, folded into its earlier-runs summary (made when it has none):
   * the summary is dated from the oldest run it tells.
   */
  private foldOldRuns(entries: MemoryEntry[], taskKey: string, at: string): MemoryEntry[] {
    const runs = entries.filter((e) => e.taskKey === taskKey && isTaskRun(e)).sort((a, b) => a.learnedAt.localeCompare(b.learnedAt));
    const folded = runs.slice(0, Math.max(0, runs.length - MAX_TASK_RUNS));
    if (!folded.length) return entries;
    const gone = new Set(folded.map((e) => e.id));
    const before = entries.find((e) => e.taskKey === taskKey && isEarlierRuns(e)) ?? null;
    const oldest = folded[0]!;
    const summary = this.checked({
      ...(before ?? { id: this.uniqueId(entries), source: oldest.source, ...(oldest.taskTitle ? { taskTitle: oldest.taskTitle } : {}) }),
      kind: "task",
      scope: "task",
      taskKey,
      subject: EARLIER_RUNS_SUBJECT,
      text: earlierRunsText(before?.text ?? null, folded),
      learnedAt: before && before.learnedAt < oldest.learnedAt ? before.learnedAt : oldest.learnedAt,
      updatedAt: at,
    });
    const rest = entries.filter((e) => !gone.has(e.id));
    return before ? rest.map((e) => (e.id === before.id ? summary : e)) : [...rest, summary];
  }

  /** Forgets everything one repeating task keeps (its run notes and records); returns how many entries went. */
  async forgetTask(taskKey: string): Promise<number> {
    return this.mutate((entries) => {
      const rest = entries.filter((e) => e.taskKey !== taskKey);
      return { entries: rest, result: entries.length - rest.length };
    });
  }

  /** The user's edit in Settings: new subject and text (the same checks as the agent's writes). */
  async edit(id: string, patch: { subject: string; text: string }): Promise<MemoryChange> {
    return this.mutate((entries) => {
      const before = entries.find((e) => e.id === id);
      if (!before) throw new MemoryRefusal("That memory entry no longer exists");
      const after = this.checked({ ...before, subject: patch.subject.trim(), text: patch.text.trim(), updatedAt: this.now().toISOString() });
      return { entries: entries.map((e) => (e.id === id ? after : e)), result: { before, after } };
    });
  }

  /** Removes one entry; null when there was none. */
  async forget(id: string): Promise<MemoryChange | null> {
    return this.mutate((entries) => {
      const before = entries.find((e) => e.id === id) ?? null;
      return { entries: entries.filter((e) => e.id !== id), result: before ? { before, after: null } : null };
    });
  }

  /** Undo of a change: the entry `id` becomes `entry` again (null: it goes). */
  async restore(id: string, entry: MemoryEntry | null): Promise<void> {
    await this.mutate((entries) => {
      const rest = entries.filter((e) => e.id !== id);
      return { entries: entry ? capped([...rest, this.checked(entry)]) : rest, result: undefined };
    });
  }

  /** Forget everything; returns how many entries went. */
  async clear(): Promise<number> {
    return this.mutate((entries) => ({ entries: [], result: entries.length }));
  }

  /** The entries were given to the agent or recalled now (staleness: lastUsedAt). */
  async touch(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const at = this.now().toISOString();
    const set = new Set(ids);
    await this.mutate((entries) => ({ entries: entries.map((e) => (set.has(e.id) ? { ...e, lastUsedAt: at } : e)), result: undefined }), { quiet: true });
  }

  /** The entry as it is kept, or MemoryRefusal: its shape and limits, and no secret in it. */
  private checked(e: MemoryEntry): MemoryEntry {
    const problem = memoryWriteProblem(e);
    if (problem) throw new MemoryRefusal(problem);
    const parsed = MemoryEntrySchema.safeParse(e);
    if (!parsed.success) throw new MemoryRefusal(`Not saved: ${parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; ")}`);
    return parsed.data as MemoryEntry;
  }

  private uniqueId(entries: readonly MemoryEntry[]): string {
    const taken = new Set(entries.map((e) => e.id));
    for (;;) {
      const id = this.newId();
      if (!taken.has(id)) return id;
    }
  }

  private storage(): StorageLike {
    return this.opts.storage ?? chrome.storage.local;
  }

  /** What is stored; entries that no longer pass the schema are left out. */
  private async read(): Promise<readonly MemoryEntry[]> {
    if (this.cached) return this.cached;
    const got = (await this.storage().get(MEMORY_STORAGE_KEY))[MEMORY_STORAGE_KEY];
    const entries = Array.isArray(got)
      ? got.flatMap((v) => {
          const p = MemoryEntrySchema.safeParse(v);
          return p.success ? [p.data as MemoryEntry] : [];
        })
      : [];
    return (this.cached ??= entries);
  }

  /**
   * Serialized read-modify-write; listeners hear of the change (not of `quiet` ones: lastUsedAt only), and local-write
   * listeners of what changed (not for `remote` changes, which came from the account).
   */
  private async mutate<T>(fn: (entries: MemoryEntry[]) => { entries: MemoryEntry[]; result: T }, opts: { quiet?: boolean; remote?: boolean } = {}): Promise<T> {
    let write: LocalWrite | null = null;
    const run = this.lock.then(async () => {
      const before = await this.read();
      const { entries, result } = fn([...before]);
      await this.storage().set({ [MEMORY_STORAGE_KEY]: entries });
      this.cached = entries;
      if (!opts.quiet && !opts.remote) write = diff(before, entries, this.now().toISOString());
      return result;
    });
    this.lock = run.catch(() => {});
    const result = await run;
    if (!opts.quiet) this.changes.emit();
    const w = write as LocalWrite | null;
    if (w && (w.upserted.length || w.removed.length)) this.writes.emit(w);
    return result;
  }
}

/** What a write changed: entries new or different (lastUsedAt aside), and entries gone (at `at`). An entry left as it was is the same object. */
function diff(before: readonly MemoryEntry[], after: readonly MemoryEntry[], at: string): LocalWrite {
  const key = ({ lastUsedAt: _used, ...e }: MemoryEntry) => JSON.stringify(e);
  const old = new Map(before.map((e) => [e.id, e]));
  const now = new Set(after.map((e) => e.id));
  const changed = (e: MemoryEntry) => {
    const was = old.get(e.id);
    return was !== e && (!was || key(was) !== key(e));
  };
  return {
    upserted: after.filter(changed).map((e) => e.id),
    removed: before.filter((e) => !now.has(e.id)).map((e) => ({ id: e.id, at })),
  };
}

/**
 * The earlier values an entry keeps: those of the entries it replaces (the slot's old value when it changed, an
 * entry named by `replaces`) and their own history, newest first, at most MAX_MEMORY_HISTORY.
 */
function pastValues(olds: readonly (MemoryEntry | null | undefined)[], next: { subject: string; text: string }, at: string): MemoryPastValue[] {
  const out: MemoryPastValue[] = [];
  for (const old of olds) {
    if (!old) continue;
    if (!sameText(old.text, next.text) || !sameText(old.subject, next.subject)) out.push({ subject: old.subject, text: old.text, since: old.updatedAt, until: at });
    out.push(...(old.history ?? []));
  }
  return out.sort((a, b) => b.until.localeCompare(a.until)).slice(0, MAX_MEMORY_HISTORY);
}

/**
 * Memory within its limits, each counted apart: past MAX_MEMORY_ENTRIES entries that are neither records, episodes nor
 * task history, past MAX_TASK_HISTORY_ENTRIES task history (every task's runs and notes), and past MAX_TASK_RECORDS
 * records of one space (a task's, the user's), the ones used longest ago go; past MAX_EPISODES episodes, the oldest.
 */
function capped(entries: MemoryEntry[]): MemoryEntry[] {
  const groups = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const group = isMemoryRecord(e) ? `r:${e.taskKey ?? ""}` : e.kind === "episode" ? EPISODES : e.kind === "task" ? TASK_HISTORY : "";
    const of = groups.get(group);
    if (of) of.push(e);
    else groups.set(group, [e]);
  }
  const drop = new Set<string>();
  for (const [group, of] of groups) {
    const max = group === EPISODES ? MAX_EPISODES : group === TASK_HISTORY ? MAX_TASK_HISTORY_ENTRIES : group ? MAX_TASK_RECORDS : MAX_MEMORY_ENTRIES;
    if (of.length <= max) continue;
    const newestFirst = group === EPISODES ? (a: MemoryEntry, b: MemoryEntry) => memoryDate(b).localeCompare(memoryDate(a)) : (a: MemoryEntry, b: MemoryEntry) => lastTouched(b).localeCompare(lastTouched(a));
    for (const e of of.sort(newestFirst).slice(max)) drop.add(e.id);
  }
  return drop.size ? entries.filter((e) => !drop.has(e.id)) : entries;
}
