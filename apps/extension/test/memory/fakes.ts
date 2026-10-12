import type { StorageLike } from "../../src/engine/kv.js";

/** chrome.storage.local in memory: values are copied in and out, as the real one does. */
export function memoryStorage(): StorageLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
  };
}
