/**
 * Which conversation belongs to which browser tab: the side panel shows the
 * conversation of the tab that is active in its window, and a conversation's
 * turns act in its tab. One conversation per tab and one tab per
 * conversation. Kept in chrome.storage.session (tabId -> sessionId), so a
 * restarted service worker finds it again; it is gone when the browser
 * restarts, like the tabs themselves. A closed tab loses its binding, while
 * the session stays in History.
 */
import { Listeners } from "./listeners.js";
import { tabExists } from "./chrome-tabs.js";

const KEY = "tabChats";

/** What the runner and the UI router need of the bindings. */
export interface TabChatsLike {
  bind(tabId: number, sessionId: string): Promise<void>;
  tabOf(sessionId: string): Promise<number | null>;
}

export class TabChats implements TabChatsLike {
  private cache: Map<number, string> | null = null;
  private loading: Promise<Map<number, string>> | null = null;
  private readonly changes = new Listeners();

  constructor(private readonly opts: { exists?(tabId: number): Promise<boolean> } = {}) {}

  /** Every binding, tab id (as a string key) -> session id. */
  async all(): Promise<Record<string, string>> {
    return Object.fromEntries([...(await this.map())].map(([t, s]) => [String(t), s]));
  }

  /** The conversation of a tab, or null. */
  async get(tabId: number): Promise<string | null> {
    return (await this.map()).get(tabId) ?? null;
  }

  /** The tab a conversation belongs to, or null. */
  async tabOf(sessionId: string): Promise<number | null> {
    for (const [t, s] of await this.map()) if (s === sessionId) return t;
    return null;
  }

  /** The conversation now belongs to this tab (it leaves any other tab; the tab's earlier one is unbound). */
  async bind(tabId: number, sessionId: string): Promise<void> {
    const m = await this.map();
    if (m.get(tabId) === sessionId && [...m.values()].filter((s) => s === sessionId).length === 1) return;
    for (const [t, s] of [...m]) if (s === sessionId) m.delete(t);
    m.set(tabId, sessionId);
    await this.save(m);
  }

  /**
   * The tab has no conversation any more (New Chat, or the tab was closed).
   * sessionId: only when it is that one. Returns the session it had, or null.
   */
  async unbind(tabId: number, sessionId?: string): Promise<string | null> {
    const m = await this.map();
    const had = m.get(tabId);
    if (had === undefined || (sessionId !== undefined && had !== sessionId)) return null;
    m.delete(tabId);
    await this.save(m);
    return had;
  }

  /** Called after every change. */
  onChange(fn: () => void): () => void {
    return this.changes.add(fn);
  }

  private async map(): Promise<Map<number, string>> {
    if (this.cache) return this.cache;
    this.loading ??= this.load().then((m) => (this.cache = m));
    return this.loading;
  }

  private async load(): Promise<Map<number, string>> {
    const got = await chrome.storage.session.get(KEY);
    const raw = (got[KEY] ?? {}) as Record<string, unknown>;
    const m = new Map<number, string>();
    for (const [k, v] of Object.entries(raw)) {
      const tabId = Number(k);
      if (Number.isInteger(tabId) && typeof v === "string" && v) m.set(tabId, v);
    }
    // Tabs closed while the worker was not listening.
    const exists = this.opts.exists ?? tabExists;
    let pruned = false;
    for (const t of [...m.keys()]) {
      if (!(await exists(t))) {
        m.delete(t);
        pruned = true;
      }
    }
    if (pruned) await chrome.storage.session.set({ [KEY]: Object.fromEntries(m) });
    return m;
  }

  private async save(m: Map<number, string>): Promise<void> {
    await chrome.storage.session.set({ [KEY]: Object.fromEntries(m) });
    this.changes.emit();
  }
}
