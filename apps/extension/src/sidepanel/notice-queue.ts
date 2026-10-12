/**
 * The notices above the input box (notices.ts draws them): one at a time,
 * the most important first (an error, then info), the
 * others waiting their turn in the order they came. A notice has a key (who
 * shows it, e.g. "voice"): showing another with the same key replaces it
 * where it stands, and clearing the key takes it away. Pure.
 */

/** error: something failed; info: everything else. */
export type NoticeLevel = "error" | "info";

const RANK: Record<NoticeLevel, number> = { error: 0, info: 1 };

/** Notices that hide by themselves stay this long (longer while the pointer or focus is on them). */
export const NOTICE_HIDE_MS = 6_000;

export interface QueuedNotice {
  key: string;
  level: NoticeLevel;
  /** A button that does something about it: the notice waits for the user. */
  actions?: readonly unknown[];
  /** Stays until its key is cleared or it is dismissed (e.g. "Sending…" while a request is out). */
  sticky?: boolean;
}

/** How long `n` stays before hiding by itself; null: until dismissed or cleared (errors, and notices with a button). */
export function autoHideMs(n: QueuedNotice): number | null {
  return n.level === "error" || n.actions?.length || n.sticky ? null : NOTICE_HIDE_MS;
}

export class NoticeQueue<N extends QueuedNotice> {
  /** In the order they came (a replacement keeps its place). */
  private items: N[] = [];

  /** Shows `n`, or queues it behind more important (or earlier, equally important) notices. */
  put(n: N): void {
    const i = this.items.findIndex((x) => x.key === n.key);
    if (i >= 0) this.items[i] = n;
    else this.items.push(n);
  }

  /** Takes away the notice with `key` (shown or waiting). */
  clear(key: string): void {
    this.items = this.items.filter((x) => x.key !== key);
  }

  /** The notice shown: the most important, the earliest of equals; null when there is none. */
  get current(): N | null {
    let best: N | null = null;
    for (const n of this.items) if (!best || RANK[n.level] < RANK[best.level]) best = n;
    return best;
  }

  /** Notices shown or waiting. */
  get size(): number {
    return this.items.length;
  }
}
