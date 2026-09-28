/**
 * The conversations' timing traces (trace/trace-book.ts), in IndexedDB
 * ("traces", one record per session). SessionStore feeds it: the trace
 * events brains, the engine and the side panel record, and the conversation's
 * own events to count. Changes apply at once in memory and are written a
 * moment later (SAVE_DELAY_MS), so recording costs next to nothing; a book is
 * written right away when its turn ends, and then leaves memory until it is
 * needed again (the next turn, a said line, the Raw view).
 */
import type { AgentEvent, TraceEvent, TraceValue } from "@noa/shared";
import { addEvent, beginTurn, linkCid, newBook, observe, turnOf, type TraceBook } from "../trace/trace-book.js";
import type { KvDb, KvStore } from "./kv.js";

/** Changes are written at most this often per conversation. */
export const SAVE_DELAY_MS = 2000;

export class TraceStore {
  private readonly kv: KvStore<TraceBook>;
  /** Books in memory (being recorded, or read lately). */
  private readonly books = new Map<string, TraceBook>();
  /** Changes waiting for their book to load. */
  private readonly waiting = new Map<string, ((b: TraceBook) => void)[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    db: KvDb,
    private readonly opts: { saveDelayMs?: number; log?: (message: string) => void } = {},
  ) {
    this.kv = db.store<TraceBook>("traces");
  }

  /** A new conversation (nothing stored yet): its first turn begins. */
  start(sessionId: string, t: number, data: Record<string, TraceValue> = {}): void {
    this.books.set(sessionId, newBook(sessionId));
    this.change(sessionId, (b) => beginTurn(b, 1, t, data));
  }

  /** The conversation's next turn (1-based `turn`) begins. */
  beginTurn(sessionId: string, turn: number, t: number, data: Record<string, TraceValue> = {}): void {
    this.change(sessionId, (b) => beginTurn(b, turn, t, data));
  }

  /** A trace event of the conversation. */
  record(sessionId: string, ev: TraceEvent): void {
    this.change(sessionId, (b) => addEvent(b, ev));
  }

  /** One of the conversation's own events, counted (see trace-book.ts). Live text deltas count only while a turn runs. */
  observe(sessionId: string, ev: AgentEvent, t: number): void {
    if (ev.type === "assistant_text_delta" && !this.books.has(sessionId)) return;
    this.change(sessionId, (b) => observe(b, ev, t));
  }

  /** The user message with correlation id `cid` went to the conversation's running turn. */
  link(sessionId: string, cid: string): void {
    this.change(sessionId, (b) => linkCid(b, cid));
  }

  /** The conversation's trace (null when it has none). */
  async get(sessionId: string): Promise<TraceBook | null> {
    const b = this.books.get(sessionId) ?? (await this.load(sessionId, false));
    return b ? structuredClone(b) : null;
  }

  async delete(sessionId: string): Promise<void> {
    this.clearTimer(sessionId);
    this.books.delete(sessionId);
    this.waiting.delete(sessionId);
    await this.enqueue(() => this.kv.delete(sessionId));
  }

  /** Writes every pending change (tests, shutdown). */
  async flush(): Promise<void> {
    for (const id of [...this.timers.keys()]) this.save(id);
    await this.chain.catch(() => {});
  }

  /** Applies a change now when the book is in memory, else once it is loaded; then saves it soon. */
  private change(sessionId: string, fn: (b: TraceBook) => void): void {
    const book = this.books.get(sessionId);
    if (!book) {
      const queue = this.waiting.get(sessionId);
      if (queue) queue.push(fn);
      else {
        this.waiting.set(sessionId, [fn]);
        void this.load(sessionId, true);
      }
      return;
    }
    try {
      fn(book);
    } catch (err) {
      this.opts.log?.(`trace: ${String(err)}`);
    }
    this.scheduleSave(sessionId, book);
  }

  /** Reads a book into memory; `create`: a new one when none is stored. Applies the changes waiting for it. */
  private async load(sessionId: string, create: boolean): Promise<TraceBook | null> {
    const stored = await this.enqueue(() => this.kv.get(sessionId)).catch(() => undefined);
    // Recorded meanwhile (start(), or another load): that one is current.
    let book = this.books.get(sessionId) ?? (stored && stored.v === 1 ? stored : null);
    const queue = this.waiting.get(sessionId) ?? [];
    this.waiting.delete(sessionId);
    if (!book && (create || queue.length)) book = newBook(sessionId);
    if (!book) return null;
    this.books.set(sessionId, book);
    for (const fn of queue) {
      try {
        fn(book);
      } catch (err) {
        this.opts.log?.(`trace: ${String(err)}`);
      }
    }
    if (queue.length) this.scheduleSave(sessionId, book);
    return book;
  }

  private scheduleSave(sessionId: string, book: TraceBook): void {
    // A turn that just ended is written now; otherwise changes are gathered for a moment.
    const ended = turnOf(book, book.turn)?.end !== undefined;
    if (ended) return this.save(sessionId);
    if (this.timers.has(sessionId)) return;
    this.timers.set(
      sessionId,
      setTimeout(() => this.save(sessionId), this.opts.saveDelayMs ?? SAVE_DELAY_MS),
    );
  }

  /** Writes the book; one whose turn has ended leaves memory once written. */
  private save(sessionId: string): void {
    this.clearTimer(sessionId);
    const book = this.books.get(sessionId);
    if (!book) return;
    const idle = turnOf(book, book.turn)?.end !== undefined;
    void this.enqueue(async () => {
      await this.kv.put(sessionId, book);
      // Changed again after this write was queued: it stays until the next write.
      if (idle && this.books.get(sessionId) === book && !this.timers.has(sessionId)) this.books.delete(sessionId);
    }).catch((err: unknown) => this.opts.log?.(`trace: saving ${sessionId} failed: ${String(err)}`));
  }

  private clearTimer(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    this.timers.delete(sessionId);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }
}
