/**
 * The chat history in the signed-in Noa account (packages/shared/src/chat-sync.ts), so signing in on another computer,
 * or on a new install, brings back the conversations: this browser keeps its own copy (engine/sessions.ts), sends a
 * conversation when its turn ends or it is renamed, and takes the account's chats into it. Any signed-in plan.
 *
 * A sync: the deletions noted are sent, then the account's changes since the revision this browser has are applied
 * (a chat new or changed there is stored here with its events, one deleted there is deleted here), then every ended
 * conversation that changed since it was last in sync is sent. What was in sync is kept per account as each chat's
 * fingerprint (its end, title and turns), so what the account sent back is not sent again.
 *
 * Whose chats: a conversation goes to the first account it syncs with. One made while signed out, or before chats
 * synced, goes to the account signed in next; one already in another account's history (made while it was signed
 * in, or taken from it) is never sent to this one.
 *
 * Only what fits here is taken: the account keeps more chats than a browser (MAX_SESSIONS), so the newest come.
 * Pictures in tool results are left out of what is sent (they are most of the size).
 */
import { errorMessage, MAX_CHAT_EVENTS_CHARS, type ChatChanges, type ChatUpload, type ChatWritten, type SessionInfo, type StampedAgentEvent } from "@noa/shared";
import type { StorageLike } from "./engine/kv.js";
import { ApiRequestError } from "./http-client.js";
import { MAX_SESSIONS } from "./engine/sessions.js";

export const CHAT_SYNC_KEY = "chatSync";
export const CHAT_SYNC_ALARM = "chat-sync";
/** How often the alarm pulls the account's changes (another computer's chats). */
export const CHAT_PULL_MINUTES = 10;
/** A change is sent this long after the last one (a turn's end and its title come close together). */
export const CHAT_SYNC_DEBOUNCE_MS = 3000;
/** A local change skips asking the account for its changes when it was asked this recently. */
const RECENT_PULL_MS = 30_000;
/** Deletions noted while they cannot be sent, at most per account. */
const MAX_PENDING_DELETIONS = 1000;

/** The SessionStore members used (a fake in tests). */
export interface ChatStore {
  list(limit: number): Promise<SessionInfo[]>;
  eventsOf(sessionId: string): Promise<StampedAgentEvent[]>;
  import(info: SessionInfo, events: readonly StampedAgentEvent[]): Promise<boolean>;
  delete(sessionId: string): Promise<boolean>;
}

export interface ChatSyncApi {
  chatChanges(since: number): Promise<ChatChanges>;
  putChat(chat: ChatUpload): Promise<ChatWritten>;
  chatEvents(sessionId: string): Promise<Record<string, unknown>[]>;
  deleteChat(sessionId: string): Promise<void>;
}

export interface ChatSyncDeps {
  sessions: ChatStore;
  /** The signed-in account (null: signed out). */
  account(): Promise<{ userId: string; api: ChatSyncApi } | null>;
  /** Conversations running now (never sent or replaced mid-turn). */
  running(): string[];
  /** Conversations came or went here (the panel reads the list again). */
  onChanged?(): void;
  storage?: StorageLike;
  now?(): Date;
  log?(message: string): void;
}

interface AccountState {
  /** The account's revision this browser has. */
  rev: number;
  /** Session id -> the chat's fingerprint as last in sync with this account. */
  known: Record<string, string>;
  /** Chats deleted here, to delete from the account. */
  deletions: string[];
}

interface SyncState {
  accounts: Record<string, AccountState>;
  lastSyncAt?: string;
  lastError?: string;
}

const freshAccount = (): AccountState => ({ rev: 0, known: {}, deletions: [] });

/** What tells one copy of a chat from another: its turn's end, its title and how many turns it has. */
export function chatFingerprint(s: Pick<SessionInfo, "endedAt" | "title" | "titleBy" | "turns" | "outcome">): string {
  return JSON.stringify([s.endedAt ?? "", s.title, s.titleBy ?? "", s.turns ?? 1, s.outcome ?? ""]);
}

/** The events as sent: no pictures; past MAX_CHAT_EVENTS_CHARS, no tool output either (null: still too long). */
export function eventsToSend(events: readonly StampedAgentEvent[]): Record<string, unknown>[] | null {
  const light = events.map((e) => {
    if (e.type !== "tool_result" || !("thumbnail" in e)) return e as unknown as Record<string, unknown>;
    const { thumbnail: _t, ...rest } = e;
    return rest as Record<string, unknown>;
  });
  if (JSON.stringify(light).length <= MAX_CHAT_EVENTS_CHARS) return light;
  const lighter = light.map((e) => {
    if (e.type !== "tool_result" || !("text" in e)) return e;
    const { text: _x, ...rest } = e;
    return rest;
  });
  return JSON.stringify(lighter).length <= MAX_CHAT_EVENTS_CHARS ? lighter : null;
}

export class ChatSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private lastPull = 0;

  constructor(private readonly deps: ChatSyncDeps) {}

  /** Syncs in CHAT_SYNC_DEBOUNCE_MS (later calls push it back). */
  schedule(ms = CHAT_SYNC_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, ms);
  }

  /** A conversation changed: once it ended, it is sent. */
  onSession(s: SessionInfo): void {
    if (s.endedAt) this.schedule();
  }

  /** The alarm: pulls the account's changes. True when the alarm was this one's. */
  onAlarm(name: string): boolean {
    if (name !== CHAT_SYNC_ALARM) return false;
    void this.sync({ pull: true });
    return true;
  }

  /** The user deleted a conversation here: the account it is in deletes it too. */
  async deleted(sessionId: string): Promise<void> {
    const state = await this.read();
    let noted = false;
    for (const acct of Object.values(state.accounts)) {
      if (!(sessionId in acct.known)) continue;
      delete acct.known[sessionId];
      acct.deletions = [...acct.deletions.filter((id) => id !== sessionId), sessionId].slice(-MAX_PENDING_DELETIONS);
      noted = true;
    }
    if (!noted) return;
    await this.write(state);
    this.schedule(0);
  }

  /** Sends and takes what changed; one sync at a time (a call meanwhile runs one more). */
  sync(opts: { pull?: boolean } = {}): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run(!!opts.pull).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    return this.running;
  }

  private async run(pull: boolean): Promise<void> {
    const account = await this.deps.account().catch(() => null);
    if (!account) return;
    const state = await this.read();
    const mine = (state.accounts[account.userId] ??= freshAccount());
    try {
      while (mine.deletions.length) {
        const id = mine.deletions[0]!;
        await account.api.deleteChat(id);
        mine.deletions.shift();
        await this.write(state);
      }
      const local = await this.deps.sessions.list(MAX_SESSIONS);
      if (pull || mine.rev === 0 || this.now() - this.lastPull >= RECENT_PULL_MS) await this.pull(account.api, state, mine, local);
      await this.send(account.api, state, account.userId, await this.deps.sessions.list(MAX_SESSIONS));
      state.lastSyncAt = new Date(this.now()).toISOString();
      delete state.lastError;
      await this.write(state);
    } catch (err) {
      const message = errorMessage(err);
      this.deps.log?.(`chat sync failed: ${message}`);
      state.lastError = message;
      await this.write(state);
    }
  }

  /** The account's changes since `mine.rev`, applied here. */
  private async pull(api: ChatSyncApi, state: SyncState, mine: AccountState, local: SessionInfo[]): Promise<void> {
    const here = new Map(local.map((s) => [s.sessionId, s]));
    const running = new Set(this.deps.running());
    let changed = false;
    for (let more = true; more; ) {
      const page = await api.chatChanges(mine.rev);
      more = page.more;
      // Newest first: what fits here (MAX_SESSIONS) is the newest of the account's and this browser's together.
      const wanted = page.chats
        .filter((c) => !c.deleted && c.info)
        .map((c) => c.info as unknown as SessionInfo)
        .filter((info) => {
          const have = here.get(info.sessionId);
          if (running.has(info.sessionId)) return false;
          if (!have) return true;
          const fp = chatFingerprint(have);
          // Changed here and not sent yet: this browser's copy goes to the account next, and wins there.
          if (mine.known[info.sessionId] !== undefined && mine.known[info.sessionId] !== fp) return false;
          return fp !== chatFingerprint(info);
        })
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
      const starts = [...here.values()].map((s) => s.startedAt).sort().reverse();
      const cutoff = starts.length >= MAX_SESSIONS ? starts[MAX_SESSIONS - 1]! : "";
      for (const info of wanted) {
        if (info.startedAt < cutoff && !here.has(info.sessionId)) continue;
        const events = (await api.chatEvents(info.sessionId)) as unknown as StampedAgentEvent[];
        if (!(await this.deps.sessions.import(info, events))) continue;
        here.set(info.sessionId, info);
        mine.known[info.sessionId] = chatFingerprint(info);
        // It is this account's: never sent to another.
        for (const acct of Object.values(state.accounts)) if (acct !== mine) delete acct.known[info.sessionId];
        changed = true;
      }
      for (const c of page.chats) {
        if (c.deleted) {
          if (here.has(c.sessionId) && !running.has(c.sessionId) && mine.known[c.sessionId] !== undefined) {
            await this.deps.sessions.delete(c.sessionId);
            here.delete(c.sessionId);
            changed = true;
          }
          delete mine.known[c.sessionId];
        } else if (c.info && here.has(c.sessionId) && mine.known[c.sessionId] === undefined && chatFingerprint(here.get(c.sessionId)!) === chatFingerprint(c.info as unknown as SessionInfo)) {
          mine.known[c.sessionId] = chatFingerprint(c.info as unknown as SessionInfo);
        }
      }
      mine.rev = page.rev;
      await this.write(state);
    }
    this.lastPull = this.now();
    // Kept only for the chats this browser has.
    const present = new Set((await this.deps.sessions.list(MAX_SESSIONS)).map((s) => s.sessionId));
    for (const acct of Object.values(state.accounts)) for (const id of Object.keys(acct.known)) if (!present.has(id)) delete acct.known[id];
    if (changed) this.deps.onChanged?.();
  }

  /** Every ended conversation of this account (or of none yet) that changed since it was last in sync. */
  private async send(api: ChatSyncApi, state: SyncState, userId: string, local: SessionInfo[]): Promise<void> {
    const mine = state.accounts[userId]!;
    const others = Object.entries(state.accounts).filter(([id]) => id !== userId);
    const running = new Set(this.deps.running());
    // Oldest first: an account past its cap keeps the newest.
    for (const s of [...local].reverse()) {
      if (!s.endedAt || running.has(s.sessionId)) continue;
      if (others.some(([, acct]) => s.sessionId in acct.known)) continue;
      const fp = chatFingerprint(s);
      if (mine.known[s.sessionId] === fp) continue;
      const events = eventsToSend(await this.deps.sessions.eventsOf(s.sessionId));
      if (!events) {
        this.deps.log?.(`chat ${s.sessionId} is too long to keep in the account`);
        continue;
      }
      try {
        await api.putChat({ info: s as unknown as ChatUpload["info"], updatedAt: new Date(this.now()).toISOString(), events });
      } catch (err) {
        // Refused for what it is (too long, malformed): it stays here only; anything else is tried again next sync.
        if (!(err instanceof ApiRequestError && (err.status === 400 || err.status === 413))) throw err;
        this.deps.log?.(`chat ${s.sessionId} not kept in the account: ${errorMessage(err)}`);
      }
      mine.known[s.sessionId] = fp;
      await this.write(state);
    }
  }

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  private storage(): StorageLike {
    return this.deps.storage ?? chrome.storage.local;
  }

  private async read(): Promise<SyncState> {
    const v = (await this.storage().get(CHAT_SYNC_KEY))[CHAT_SYNC_KEY] as Partial<SyncState> | undefined;
    return { accounts: {}, ...(v && typeof v === "object" ? v : {}) };
  }

  private async write(state: SyncState): Promise<void> {
    await this.storage().set({ [CHAT_SYNC_KEY]: state });
  }
}
