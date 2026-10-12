/**
 * Tiny key-value layer over IndexedDB. The engine only needs get/put/delete
 * and prefix listing, so the rest of the code (and the tests, which use an
 * in-memory KvDb) never touches the IndexedDB API directly.
 */

/** traces: each conversation's timing trace (trace-store.ts), added in version 2; attachments: files sent in chats (attachment-store.ts), version 3. */
const KV_STORES = ["media", "sessions", "events", "traces", "attachments"] as const;
export type KvStoreName = (typeof KV_STORES)[number];

export interface KvStore<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Entries whose key starts with prefix (all when omitted), in key order. */
  list(prefix?: string): Promise<{ key: string; value: T }[]>;
  /** Keys only; cheaper than list for large values. */
  keys(prefix?: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
}

/** A chrome.storage area (chrome.storage.local), or a fake of one in tests. */
export interface StorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface KvDb {
  store<T>(name: KvStoreName): KvStore<T>;
}

const DB_NAME = "noa";
const DB_VERSION = 3;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function range(prefix?: string): IDBKeyRange | undefined {
  return prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
}

/** IndexedDB-backed stores (out-of-line string keys). */
export class IdbKvDb implements KvDb {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          for (const name of KV_STORES) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error("Cannot open IndexedDB"));
      });
      this.db.catch(() => {
        this.db = null;
      });
    }
    return this.db;
  }

  store<T>(name: KvStoreName): KvStore<T> {
    const tx = async (mode: IDBTransactionMode) => (await this.open()).transaction(name, mode).objectStore(name);
    return {
      get: async (key) => (await req((await tx("readonly")).get(key))) as T | undefined,
      put: async (key, value) => {
        await req((await tx("readwrite")).put(value, key));
      },
      delete: async (key) => {
        await req((await tx("readwrite")).delete(key));
      },
      list: async (prefix) => {
        const s = await tx("readonly");
        const [keys, values] = await Promise.all([req(s.getAllKeys(range(prefix))), req(s.getAll(range(prefix)))]);
        return keys.map((k, i) => ({ key: String(k), value: values[i] as T }));
      },
      keys: async (prefix) => (await req((await tx("readonly")).getAllKeys(range(prefix)))).map(String),
      deletePrefix: async (prefix) => {
        const r = range(prefix);
        if (r) await req((await tx("readwrite")).delete(r));
      },
    };
  }
}
