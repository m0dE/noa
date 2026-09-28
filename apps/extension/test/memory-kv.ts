import type { KvDb, KvStore, KvStoreName } from "../src/engine/kv.js";

/** In-memory KvDb stores with the same behavior as IdbKvDb (keys in order), for tests. */
export class MemoryKvDb implements KvDb {
  readonly data = new Map<KvStoreName, Map<string, unknown>>();

  store<T>(name: KvStoreName): KvStore<T> {
    let m = this.data.get(name);
    if (!m) this.data.set(name, (m = new Map()));
    const map = m;
    const sorted = (prefix?: string) =>
      [...map.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
    return {
      get: async (key) => map.get(key) as T | undefined,
      put: async (key, value) => {
        map.set(key, value);
      },
      delete: async (key) => {
        map.delete(key);
      },
      list: async (prefix) => sorted(prefix).map((key) => ({ key, value: map.get(key) as T })),
      keys: async (prefix) => sorted(prefix),
      deletePrefix: async (prefix) => {
        for (const k of sorted(prefix)) map.delete(k);
      },
    };
  }
}
