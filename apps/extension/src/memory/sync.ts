/**
 * Memory in the signed-in account (POST /v1/memory/sync, packages/shared/src/memory.ts), so another browser gets
 * it: on a plan with the TODO list. Each change made on this computer is noted (the entries to send, the
 * deletions) and sent a few seconds later; the answer brings the account's changes since the last sync, which
 * the store applies (the newer version of an entry wins). What is noted survives a restart
 * (chrome.storage.local, MEMORY_SYNC_KEY). Signed out, or on a plan without it, memory stays on this computer.
 *
 * Signing in to another account than the one this computer's memory was last synced with (or, the first time, to an
 * account that already keeps memory) sends nothing until the user answers "Add this computer's memory to
 * <account>?" (choose): Add sends it all to that account and syncs from then on; Keep separate keeps it on this
 * computer, unsynced while that account is signed in. The first sign-in to an account with no memory, the same
 * account again, or a computer with no memory yet sync at once.
 */
import {
  errorMessage,
  MAX_MEMORY_SEARCH_QUERY_CHARS,
  MAX_MEMORY_SYNC_BATCH,
  type MemoryDeletion,
  type MemorySearchInput,
  type MemorySearchResponse,
  type MemorySyncInput,
  type MemorySyncResponse,
} from "@noa/shared";
import type { StorageLike } from "../engine/kv.js";
import type { LocalWrite, MemoryStore } from "./store.js";

export const MEMORY_SYNC_KEY = "memorySync";
/** A change is sent this long after the last one (changes come in bursts: a run's notes, an Undo). */
export const SYNC_DEBOUNCE_MS = 3000;
/** Turns pull the account's changes at most this often (another browser's new entries). */
export const PULL_EVERY_MS = 5 * 60_000;
/** Deletions noted while nothing can be sent, at most (a few tasks deleted with their records; past it the oldest go). */
const MAX_PENDING_DELETIONS = 5000;

/** Whether memory syncs with the account, for Settings > Memory. `account`: the signed-in account's address. */
export type MemorySyncStatus =
  | { state: "on"; lastSyncAt?: string; error?: string }
  | { state: "signed-out" }
  | { state: "no-plan" }
  /** Waiting for the user: add this computer's memory to `account`, or keep it separate (choose). */
  | { state: "ask"; account: string }
  /** The user chose to keep this computer's memory out of `account`: nothing syncs while it is signed in. */
  | { state: "separate"; account: string };

interface SyncState {
  /** The account this computer's memory was synced with. */
  userId: string | null;
  /** An account the user is being asked about (its user id): nothing is sent to it until they answer. */
  asked?: string;
  /** An account the user chose to keep this computer's memory out of. */
  separate?: string;
  /** The account's revision this computer has. */
  rev: number;
  /** Entries changed here and not sent yet. */
  dirty: string[];
  /** Entries deleted here and not sent yet. */
  deleted: MemoryDeletion[];
  lastSyncAt?: string;
  lastError?: string;
}

const EMPTY: SyncState = { userId: null, rev: 0, dirty: [], deleted: [] };

export interface MemorySyncDeps {
  store: MemoryStore;
  /** The signed-in account (null: signed out): its user and address, whether its plan syncs memory, and its API. */
  account(): Promise<{
    userId: string;
    email: string;
    syncAllowed: boolean;
    api: { memorySync(input: MemorySyncInput): Promise<MemorySyncResponse>; forgetMemory(): Promise<void>; memorySearch?(input: MemorySearchInput): Promise<MemorySearchResponse> };
  } | null>;
  storage?: StorageLike;
  now?(): Date;
  log?(message: string): void;
  /** The question to the user (UiState.memoryQuestion) came up or was answered. */
  onQuestionChange?(): void;
}

type SyncAccount = NonNullable<Awaited<ReturnType<MemorySyncDeps["account"]>>>;

export class MemorySync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<MemorySyncStatus> | null = null;
  private again = false;
  private lastPull = 0;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MemorySyncDeps) {
    deps.store.onLocalWrite((w) => void this.note(w).then(() => this.schedule()));
  }

  /** Syncs in SYNC_DEBOUNCE_MS (again later calls push it back). */
  schedule(ms = SYNC_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, ms);
  }

  /** A turn is starting: the account's changes are pulled now and then (not awaited; the turn uses what is here). */
  pullSoon(): void {
    const now = this.now().getTime();
    if (now - this.lastPull < PULL_EVERY_MS) return;
    this.lastPull = now;
    void this.sync();
  }

  /** Sends what changed here and applies the account's changes; one sync at a time (a call meanwhile runs one more). */
  sync(): Promise<MemorySyncStatus> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    return this.running;
  }

  /** Whether memory syncs, and how it went last time. */
  async status(): Promise<MemorySyncStatus> {
    const account = await this.deps.account().catch(() => null);
    if (!account) return { state: "signed-out" };
    if (!account.syncAllowed) return { state: "no-plan" };
    const s = await this.read();
    if (s.userId !== account.userId) {
      if (s.separate === account.userId) return { state: "separate", account: account.email };
      if (s.asked === account.userId) return { state: "ask", account: account.email };
    }
    return { state: "on", ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}), ...(s.lastError ? { error: s.lastError } : {}) };
  }

  /** "Add this computer's memory to <account>?" while it waits for the user's answer, else null. */
  async question(): Promise<{ account: string } | null> {
    const s = await this.status();
    return s.state === "ask" ? { account: s.account } : null;
  }

  /**
   * The user's answer about the signed-in account: add (everything here goes to it, and memory syncs with it from
   * now on) or keep separate (nothing goes to it; memory stays on this computer while it is signed in).
   */
  async choose(add: boolean): Promise<MemorySyncStatus> {
    const account = await this.deps.account().catch(() => null);
    if (!account) return { state: "signed-out" };
    if (add) {
      const ids = (await this.deps.store.list()).map((e) => e.id);
      await this.update(({ asked: _a, separate: _s, ...s }) => ({ ...s, userId: account.userId, rev: 0, dirty: ids, deleted: [] }));
    } else {
      await this.update(({ asked: _a, ...s }) => ({ ...s, separate: account.userId }));
    }
    this.deps.onQuestionChange?.();
    return add ? this.sync() : this.status();
  }

  /**
   * The account's semantic search over its copy of this memory (entry id -> cosine similarity to `query`), or null
   * when memory does not sync with the signed-in account (signed out, no plan, not added to it yet). Entries not
   * synced yet are simply not among the hits.
   */
  async search(query: string, opts: { taskKey?: string | null; limit: number }): Promise<ReadonlyMap<string, number> | null> {
    const account = await this.deps.account().catch(() => null);
    if (!account?.syncAllowed || !account.api.memorySearch) return null;
    if ((await this.read()).userId !== account.userId) return null;
    const res = await account.api.memorySearch({ query: query.slice(0, MAX_MEMORY_SEARCH_QUERY_CHARS), ...(opts.taskKey ? { taskKey: opts.taskKey } : {}), limit: opts.limit });
    return new Map(res.hits.map((h) => [h.id, h.score]));
  }

  /** Forget everything: the account forgets too (on any plan, when signed in), and nothing noted is sent. */
  async forgetAll(): Promise<void> {
    await this.update((s) => ({ ...s, dirty: [], deleted: [] }));
    const account = await this.deps.account().catch(() => null);
    if (account) await account.api.forgetMemory();
  }

  private async run(): Promise<MemorySyncStatus> {
    const account = await this.deps.account().catch(() => null);
    if (!account) return { state: "signed-out" };
    if (!account.syncAllowed) return { state: "no-plan" };
    try {
      for (;;) {
        let state = await this.read();
        if (state.userId !== account.userId) {
          const waiting = await this.meet(account, state);
          if (waiting) return waiting;
          state = await this.read();
        }
        const dirty = new Set(state.dirty);
        const upserts = (await this.deps.store.list()).filter((e) => dirty.has(e.id)).slice(0, MAX_MEMORY_SYNC_BATCH);
        const deletes = state.deleted.slice(0, MAX_MEMORY_SYNC_BATCH);
        const res = await account.api.memorySync({ since: state.rev, upserts, deletes });
        await this.deps.store.applyRemote(res.entries, res.deleted);
        const sent = new Map(upserts.map((e) => [e.id, e.updatedAt]));
        const refused = new Set(res.refused.map((r) => r.id));
        const current = new Map((await this.deps.store.list()).map((e) => [e.id, e.updatedAt]));
        const sentDeletions = new Set(deletes.map((d) => `${d.id}@${d.at}`));
        const next = await this.update((s) => ({
          ...s,
          rev: res.rev,
          // Still to send: not sent, or changed again while this request was out (a refused one never goes).
          dirty: s.dirty.filter((id) => !refused.has(id) && current.has(id) && !(sent.has(id) && sent.get(id) === current.get(id))),
          deleted: s.deleted.filter((d) => !sentDeletions.has(`${d.id}@${d.at}`)),
          lastSyncAt: this.now().toISOString(),
          lastError: undefined,
        }));
        for (const r of res.refused) this.deps.log?.(`memory entry ${r.id} not synced: ${r.reason}`);
        this.lastPull = this.now().getTime();
        if (!next.dirty.length && !next.deleted.length) return this.status();
        // More than one request's worth: go on only when this one moved something.
        if (!upserts.length && !deletes.length) return this.status();
      }
    } catch (err) {
      const message = errorMessage(err);
      this.deps.log?.(`memory sync failed: ${message}`);
      await this.update((s) => ({ ...s, lastError: message }));
      return { state: "on", error: message };
    }
  }

  /**
   * The first sync with an account other than the one this computer's memory was synced with: it starts syncing
   * (everything here goes to it) when there is nothing here to send, or on the first sign-in when the account keeps
   * no memory yet; otherwise the user is asked first. Answers the status to stop at (ask, separate), or null.
   */
  private async meet(account: SyncAccount, state: SyncState): Promise<MemorySyncStatus | null> {
    if (state.separate === account.userId) return { state: "separate", account: account.email };
    if (state.asked === account.userId) return { state: "ask", account: account.email };
    const ids = (await this.deps.store.list()).map((e) => e.id);
    const ask = ids.length > 0 && (state.userId !== null || !(await this.keepsNothing(account)));
    if (ask) {
      await this.update((s) => ({ ...s, asked: account.userId }));
      this.deps.onQuestionChange?.();
      return { state: "ask", account: account.email };
    }
    await this.update(({ asked: _a, separate: _s, lastSyncAt: _t, ...s }) => ({ ...s, userId: account.userId, rev: 0, dirty: ids, deleted: [] }));
    return null;
  }

  /** The account keeps no memory yet (a sync that sends nothing and reads everything). */
  private async keepsNothing(account: SyncAccount): Promise<boolean> {
    const res = await account.api.memorySync({ since: 0, upserts: [], deletes: [] });
    return res.entries.length === 0;
  }

  /** Notes a change made here, for the next sync. */
  private async note(w: LocalWrite): Promise<void> {
    await this.update((s) => {
      const gone = new Set(w.removed.map((d) => d.id));
      const dirty = new Set(s.dirty.filter((id) => !gone.has(id)));
      for (const id of w.upserted) dirty.add(id);
      const deleted = [...s.deleted.filter((d) => !w.upserted.includes(d.id)), ...w.removed].slice(-MAX_PENDING_DELETIONS);
      return { ...s, dirty: [...dirty], deleted };
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private storage(): StorageLike {
    return this.deps.storage ?? chrome.storage.local;
  }

  private async read(): Promise<SyncState> {
    const v = (await this.storage().get(MEMORY_SYNC_KEY))[MEMORY_SYNC_KEY] as Partial<SyncState> | undefined;
    return { ...EMPTY, ...(v && typeof v === "object" ? v : {}) };
  }

  /** Serialized read-modify-write of the sync state. */
  private update(fn: (s: SyncState) => SyncState): Promise<SyncState> {
    const run = this.lock.then(async () => {
      const next = fn(await this.read());
      const { lastError, ...rest } = next;
      await this.storage().set({ [MEMORY_SYNC_KEY]: lastError ? next : rest });
      return next;
    });
    this.lock = run.catch(() => {});
    return run;
  }
}
