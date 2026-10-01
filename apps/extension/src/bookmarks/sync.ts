/**
 * Noa Browser's bookmarks in the signed-in Noa account (POST /v1/bookmarks/sync, packages/shared/src/bookmark-sync.ts),
 * so the user's other computers get them: Chromium's own sync needs Google's keys, which other browsers don't get.
 * Only where chrome.bookmarks exists (Noa Browser's copy of Noa has the permission; the extension in Chrome has not)
 * and the user switched it on (settings.bookmarkSync).
 *
 * Every bookmark and folder gets a random guid (local id -> guid, kept in chrome.storage.local); the three root
 * folders have fixed guids. A sync compares the whole local tree with what it last knew was in sync (`known`): what
 * differs is sent (a node missing locally is sent as a deletion), and the account's changes since the last sync are
 * applied here, the node's newest version winning. Applying updates `known` from the tree afterwards, so the
 * browser's own bookmark events for those changes are never sent back. chrome.bookmarks events only schedule a sync
 * (a few seconds later: changes come in bursts); the alarm pulls the account's changes every few minutes.
 *
 * The first sync with an account merges: a local node matching one of the account's under the same folder (same
 * title and URL) takes its guid, so a second computer with the same bookmarks gets no duplicates.
 * Order within a folder is kept per node (its index), approximately when two computers reorder the same folder at once.
 */
import {
  BOOKMARK_ROOTS,
  errorMessage,
  MAX_BOOKMARK_SYNC_BATCH,
  MAX_BOOKMARK_TITLE_CHARS,
  MAX_BOOKMARK_URL_CHARS,
  type BookmarkNode,
  type BookmarkSyncInput,
  type BookmarkSyncResponse,
} from "@noa/shared";
import type { StorageLike } from "../engine/kv.js";

export const BOOKMARK_SYNC_KEY = "bookmarkSync";
export const BOOKMARK_SYNC_ALARM = "bookmark-sync";
/** How often the alarm pulls the account's changes (another computer's). */
export const BOOKMARK_PULL_MINUTES = 10;
/** A change is sent this long after the last one. */
export const BOOKMARK_SYNC_DEBOUNCE_MS = 3000;
/** A local change with nothing to send skips the request when the account was asked this recently. */
const RECENT_PULL_MS = 30_000;

/** The chrome.bookmarks tree node fields used. */
export interface LocalNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: LocalNode[];
  /** Chrome 134+: which root folder ("bookmarks-bar", "other", "mobile", "managed"). */
  folderType?: string;
  /** "managed": set by policy, never changed here. */
  unmodifiable?: string;
}

interface BookmarkEvent {
  addListener(fn: () => void): void;
}

/** The chrome.bookmarks members used (a fake in tests). */
export interface BookmarksApi {
  getTree(): Promise<LocalNode[]>;
  create(b: { parentId: string; index?: number; title?: string; url?: string }): Promise<LocalNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<LocalNode>;
  move(id: string, to: { parentId: string; index?: number }): Promise<LocalNode>;
  removeTree(id: string): Promise<void>;
  onCreated: BookmarkEvent;
  onRemoved: BookmarkEvent;
  onChanged: BookmarkEvent;
  onMoved: BookmarkEvent;
  onChildrenReordered: BookmarkEvent;
  onImportEnded: BookmarkEvent;
}

/** Where a node is and what it is: what is compared, sent and stored. */
interface Placement {
  parentGuid: string;
  index: number;
  title: string;
  url: string | null;
}

interface SyncState {
  /** The account these bookmarks sync with. */
  userId: string | null;
  /** The account's revision this computer has. */
  rev: number;
  /** The first sync with this account (the merge) is done. */
  merged: boolean;
  /** Local bookmark id -> guid. */
  ids: Record<string, string>;
  /** guid -> the node as last in sync (sent or applied). */
  known: Record<string, Placement>;
  /** Changes not sent yet, by guid. */
  pending: Record<string, BookmarkNode>;
  lastSyncAt?: string;
  lastError?: string;
}

const fresh = (userId: string | null): SyncState => ({ userId, rev: 0, merged: false, ids: {}, known: {}, pending: {} });

export type BookmarkSyncStatus = { state: "on"; lastSyncAt?: string; error?: string } | { state: "off" } | { state: "signed-out" } | { state: "unavailable" };

export interface BookmarkSyncDeps {
  bookmarks: BookmarksApi;
  /** The signed-in account (null: signed out). */
  account(): Promise<{ userId: string; api: { bookmarkSync(input: BookmarkSyncInput): Promise<BookmarkSyncResponse>; bookmarkChanges(since: number): Promise<BookmarkSyncResponse> } } | null>;
  /** The user switched bookmark sync on. */
  enabled(): Promise<boolean>;
  storage?: StorageLike;
  now?(): Date;
  log?(message: string): void;
  newGuid?(): string;
}

type SyncAccount = NonNullable<Awaited<ReturnType<BookmarkSyncDeps["account"]>>>;

/** A local node as the tree has it, with its parent's local id. */
interface Scanned {
  node: LocalNode;
  parentId: string;
  index: number;
}

const ROOT_BY_TYPE: Record<string, string> = { "bookmarks-bar": BOOKMARK_ROOTS.bar, other: BOOKMARK_ROOTS.other, mobile: BOOKMARK_ROOTS.mobile };
const ROOT_BY_POSITION = [BOOKMARK_ROOTS.bar, BOOKMARK_ROOTS.other, BOOKMARK_ROOTS.mobile];

/** The local tree: root folder local id -> guid, and every syncable node (managed bookmarks are left out). */
export function scanTree(tree: LocalNode[]): { roots: Map<string, string>; nodes: Map<string, Scanned> } {
  const roots = new Map<string, string>();
  const nodes = new Map<string, Scanned>();
  const top = tree[0]?.children ?? [];
  top.forEach((folder, i) => {
    const guid = folder.folderType ? ROOT_BY_TYPE[folder.folderType] : folder.unmodifiable ? undefined : ROOT_BY_POSITION[i];
    if (!guid) return;
    roots.set(folder.id, guid);
    const walk = (parent: LocalNode) =>
      (parent.children ?? []).forEach((child, index) => {
        if (child.unmodifiable) return;
        nodes.set(child.id, { node: child, parentId: parent.id, index });
        walk(child);
      });
    walk(folder);
  });
  return { roots, nodes };
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const samePlacement = (a: Placement, b: Placement) => a.parentGuid === b.parentGuid && a.index === b.index && a.title === b.title && a.url === b.url;
/** What a node is, for matching at the merge: same title and URL (folders: no URL). */
const matchKey = (title: string, url: string | null) => `${url ?? ""}\n${title}`;

export class BookmarkSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<BookmarkSyncStatus> | null = null;
  private again = false;
  private lastPull = 0;
  private listening = false;

  constructor(private readonly deps: BookmarkSyncDeps) {}

  /** chrome.bookmarks events schedule a sync (registered once). */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    const b = this.deps.bookmarks;
    for (const ev of [b.onCreated, b.onRemoved, b.onChanged, b.onMoved, b.onChildrenReordered, b.onImportEnded]) ev.addListener(() => this.schedule());
  }

  /** Syncs in BOOKMARK_SYNC_DEBOUNCE_MS (later calls push it back). */
  schedule(ms = BOOKMARK_SYNC_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, ms);
  }

  /** The alarm: pulls the account's changes. True when the alarm was this one's. */
  onAlarm(name: string): boolean {
    if (name !== BOOKMARK_SYNC_ALARM) return false;
    void this.sync({ pull: true });
    return true;
  }

  /** Sends what changed here and applies the account's changes; one sync at a time (a call meanwhile runs one more). */
  sync(opts: { pull?: boolean } = {}): Promise<BookmarkSyncStatus> {
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

  async status(): Promise<BookmarkSyncStatus> {
    if (!(await this.deps.enabled())) return { state: "off" };
    if (!(await this.deps.account().catch(() => null))) return { state: "signed-out" };
    const s = await this.read();
    return { state: "on", ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}), ...(s.lastError ? { error: s.lastError } : {}) };
  }

  private async run(pull: boolean): Promise<BookmarkSyncStatus> {
    if (!(await this.deps.enabled())) return { state: "off" };
    const account = await this.deps.account().catch(() => null);
    if (!account) return { state: "signed-out" };
    let state = await this.read();
    try {
      // Another account: its bookmarks are merged with these, from scratch.
      if (state.userId !== account.userId) state = fresh(account.userId);
      if (!state.merged) await this.merge(account, state);
      for (;;) {
        this.diff(state, await this.deps.bookmarks.getTree());
        const batch = Object.values(state.pending).slice(0, MAX_BOOKMARK_SYNC_BATCH);
        if (!batch.length && !pull && this.now().getTime() - this.lastPull < RECENT_PULL_MS) break;
        const res = await account.api.bookmarkSync({ since: state.rev, changes: batch });
        this.lastPull = this.now().getTime();
        for (const n of batch) if (state.pending[n.guid]?.updatedAt === n.updatedAt) delete state.pending[n.guid];
        await this.apply(state, res.nodes);
        state.rev = res.rev;
        state.lastSyncAt = this.now().toISOString();
        delete state.lastError;
        await this.write(state);
        pull = false;
        if (!Object.keys(state.pending).length || !batch.length) break;
      }
      await this.write(state);
      return this.status();
    } catch (err) {
      const message = errorMessage(err);
      this.deps.log?.(`bookmark sync failed: ${message}`);
      state.lastError = message;
      await this.write(state);
      return { state: "on", error: message };
    }
  }

  /**
   * The first sync with an account: a local node that matches one of the account's (same folder, title and URL)
   * takes its guid and counts as in sync; the rest of this computer's bookmarks are sent, and the account's
   * others are created here (by the sync that follows, which reads everything since revision 0).
   */
  private async merge(account: SyncAccount, state: SyncState): Promise<void> {
    const all = await account.api.bookmarkChanges(0);
    const byParent = new Map<string, Map<string, string[]>>();
    for (const n of all.nodes) {
      if (n.deleted) continue;
      const keys = byParent.get(n.parentGuid) ?? new Map<string, string[]>();
      const key = matchKey(n.title, n.url);
      keys.set(key, [...(keys.get(key) ?? []), n.guid]);
      byParent.set(n.parentGuid, keys);
    }
    const { roots, nodes } = scanTree(await this.deps.bookmarks.getTree());
    const guidOf = (localId: string) => roots.get(localId) ?? state.ids[localId];
    // Parents come before their children in the scan (depth first), so each child's folder has its guid already.
    for (const [id, s] of nodes) {
      const parentGuid = guidOf(s.parentId);
      if (!parentGuid) continue;
      const url = s.node.url ?? null;
      const candidates = byParent.get(parentGuid)?.get(matchKey(s.node.title, url));
      const match = candidates?.shift();
      if (!match) continue;
      state.ids[id] = match;
      state.known[match] = { parentGuid, index: s.index, title: s.node.title, url };
    }
    state.rev = 0;
    state.merged = true;
    await this.write(state);
  }

  /** Compares the local tree with `known`: changed and new nodes, and deletions, become pending. */
  private diff(state: SyncState, tree: LocalNode[]): void {
    const { roots, nodes } = scanTree(tree);
    const at = this.now().toISOString();
    const seen = new Set<string>();
    for (const id of Object.keys(state.ids)) if (!nodes.has(id)) delete state.ids[id];
    for (const [id, s] of nodes) {
      const guid = (state.ids[id] ??= this.newGuid());
      const parentGuid = roots.get(s.parentId) ?? state.ids[s.parentId];
      if (!parentGuid) continue;
      seen.add(guid);
      const now: Placement = {
        parentGuid,
        index: s.index,
        title: clip(s.node.title, MAX_BOOKMARK_TITLE_CHARS),
        url: s.node.url ? clip(s.node.url, MAX_BOOKMARK_URL_CHARS) : null,
      };
      const was = state.known[guid];
      if (was && samePlacement(was, now)) continue;
      state.known[guid] = now;
      state.pending[guid] = { guid, ...now, updatedAt: at, deleted: false };
    }
    for (const [guid, was] of Object.entries(state.known)) {
      if (seen.has(guid)) continue;
      delete state.known[guid];
      state.pending[guid] = { guid, parentGuid: was.parentGuid, index: 0, title: "", url: null, updatedAt: at, deleted: true };
    }
  }

  /**
   * Applies the account's nodes here. A node with a newer change pending here is left (that change goes to the
   * account next). A node whose folder is not here (deleted meanwhile) goes to Other bookmarks. Then `known` takes
   * the applied nodes as the tree has them now, so their events are never sent back.
   */
  private async apply(state: SyncState, remote: BookmarkNode[]): Promise<void> {
    if (!remote.length) return;
    const b = this.deps.bookmarks;
    let scan = scanTree(await b.getTree());
    const local = new Map<string, string>();
    const refresh = () => {
      local.clear();
      for (const [id, guid] of scan.roots) local.set(guid, id);
      for (const [id, guid] of Object.entries(state.ids)) if (scan.nodes.has(id)) local.set(guid, id);
    };
    refresh();
    const wins = (n: BookmarkNode) => !state.pending[n.guid] || state.pending[n.guid]!.updatedAt <= n.updatedAt;
    const applied = new Set<string>();

    for (const n of remote.filter((x) => x.deleted && wins(x))) {
      delete state.pending[n.guid];
      delete state.known[n.guid];
      const id = local.get(n.guid);
      if (!id) continue;
      // The folder's contents go with it here: they are no longer anything to send.
      const gone: string[] = [];
      const collect = (node: LocalNode) => {
        gone.push(node.id);
        node.children?.forEach(collect);
      };
      const s = scan.nodes.get(id);
      if (s) collect(s.node);
      try {
        await b.removeTree(id);
      } catch (err) {
        this.deps.log?.(`bookmark ${n.guid} not removed: ${errorMessage(err)}`);
      }
      for (const gid of gone) {
        const guid = state.ids[gid];
        if (guid) {
          delete state.known[guid];
          delete state.pending[guid];
        }
        delete state.ids[gid];
      }
      scan = scanTree(await b.getTree());
      refresh();
    }

    let todo = remote.filter((x) => !x.deleted && wins(x));
    const place = async (n: BookmarkNode, parentId: string) => {
      const id = local.get(n.guid);
      // The folder's other children: an index past them puts it last.
      const others = [...scan.nodes].filter(([cid, s]) => s.parentId === parentId && cid !== id).length;
      const index = Math.min(n.index, others);
      if (id === undefined) {
        const made = await b.create({ parentId, index, title: n.title, ...(n.url ? { url: n.url } : {}) });
        state.ids[made.id] = n.guid;
      } else {
        const s = scan.nodes.get(id)!;
        const isFolder = !s.node.url;
        if (s.node.title !== n.title || (!isFolder && n.url && s.node.url !== n.url)) await b.update(id, { title: n.title, ...(isFolder || !n.url ? {} : { url: n.url }) });
        if (s.parentId !== parentId || s.index !== index) await b.move(id, { parentId, index });
      }
    };
    // Folders before what is in them: rounds until nothing more can be placed.
    for (let progress = true; todo.length && progress; ) {
      progress = false;
      const later: BookmarkNode[] = [];
      for (const n of todo) {
        const parentId = local.get(n.parentGuid);
        if (parentId === undefined) {
          later.push(n);
          continue;
        }
        try {
          await place(n, parentId);
          applied.add(n.guid);
          delete state.pending[n.guid];
        } catch (err) {
          this.deps.log?.(`bookmark ${n.guid} not applied: ${errorMessage(err)}`);
        }
        progress = true;
        scan = scanTree(await b.getTree());
        refresh();
      }
      todo = later;
    }
    // Their folder is gone: kept in Other bookmarks (the next diff sends where they are now).
    for (const n of todo) {
      const other = local.get(BOOKMARK_ROOTS.other);
      if (other === undefined) break;
      try {
        await place({ ...n, index: Number.MAX_SAFE_INTEGER }, other);
      } catch (err) {
        this.deps.log?.(`bookmark ${n.guid} not applied: ${errorMessage(err)}`);
      }
      scan = scanTree(await b.getTree());
      refresh();
    }

    // What was applied is in sync as the tree has it now.
    for (const [id, s] of scan.nodes) {
      const guid = state.ids[id];
      if (!guid || !applied.has(guid)) continue;
      const parentGuid = scan.roots.get(s.parentId) ?? state.ids[s.parentId];
      if (parentGuid) state.known[guid] = { parentGuid, index: s.index, title: s.node.title, url: s.node.url ?? null };
    }
  }

  private newGuid(): string {
    return this.deps.newGuid?.() ?? crypto.randomUUID().replace(/-/g, "");
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private storage(): StorageLike {
    return this.deps.storage ?? chrome.storage.local;
  }

  private async read(): Promise<SyncState> {
    const v = (await this.storage().get(BOOKMARK_SYNC_KEY))[BOOKMARK_SYNC_KEY] as Partial<SyncState> | undefined;
    return { ...fresh(null), ...(v && typeof v === "object" ? v : {}) };
  }

  private async write(state: SyncState): Promise<void> {
    await this.storage().set({ [BOOKMARK_SYNC_KEY]: state });
  }
}
