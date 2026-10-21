/**
 * A device's phone-link keys (docs/MOBILE.md, section 1a), on the desktop (the extension) and the phone (its page).
 * The post-quantum half has no WebCrypto key type in browsers yet, so the static keys are bytes; they are kept
 * wrapped (AES-GCM) by a non-extractable WebCrypto key in IndexedDB, so the stored copy is useless without that
 * CryptoKey, which no script can read out. Browser-only (IndexedDB).
 */
import { decodeStaticKeys, encodeStaticKeys, generateStaticKeys, type StaticKeys } from "./crypto.js";

export interface KeyVault {
  load(): Promise<StaticKeys | null>;
  save(keys: StaticKeys): Promise<void>;
  clear(): Promise<void>;
}

const DB = "noa-phone-link";
const STORE = "keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function op<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbKeyVault implements KeyVault {
  async load(): Promise<StaticKeys | null> {
    const db = await open();
    try {
      const wrap = await op<CryptoKey | undefined>(db, "readonly", (s) => s.get("wrap"));
      const sealed = await op<{ iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer } | undefined>(db, "readonly", (s) => s.get("static"));
      if (!wrap || !sealed) return null;
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, wrap, sealed.ct);
      return decodeStaticKeys(new TextDecoder().decode(pt));
    } finally {
      db.close();
    }
  }

  async save(keys: StaticKeys): Promise<void> {
    const wrap = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrap, new TextEncoder().encode(encodeStaticKeys(keys)));
    const db = await open();
    try {
      await op(db, "readwrite", (s) => s.put(wrap, "wrap"));
      await op(db, "readwrite", (s) => s.put({ iv, ct }, "static"));
    } finally {
      db.close();
    }
  }

  async clear(): Promise<void> {
    const db = await open();
    try {
      await op(db, "readwrite", (s) => s.clear());
    } finally {
      db.close();
    }
  }
}

export class MemoryKeyVault implements KeyVault {
  private keys: StaticKeys | null = null;
  async load(): Promise<StaticKeys | null> {
    return this.keys;
  }
  async save(keys: StaticKeys): Promise<void> {
    this.keys = keys;
  }
  async clear(): Promise<void> {
    this.keys = null;
  }
}

/** The stored keys, or new ones (saved) when there are none. */
export async function ensureKeys(vault: KeyVault): Promise<StaticKeys> {
  const existing = await vault.load();
  if (existing) return existing;
  const keys = generateStaticKeys();
  await vault.save(keys);
  return keys;
}
