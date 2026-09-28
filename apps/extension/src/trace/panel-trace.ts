/**
 * The side panel's part of a conversation's trace: when a message was sent
 * and how long the background took to take it, and voice (utterances,
 * transcription, the sending window, speech, the Realtime narrator). Events go
 * to the background (UI request "trace.add") in small batches.
 *
 * Which conversation an event belongs to: an event with a correlation id
 * (`cid`: a typed message, or a voice utterance and everything it led to) goes
 * where that message went, once bind() says so. While its utterance is open
 * (being heard or sent) it waits for that; an utterance that ended without a
 * message (a "stop", a Realtime turn that sent nothing), and an event without
 * a cid, go to the chat the panel is talking to (`target`), else to the next
 * message's.
 */
import type { TraceDraft, TraceEvent } from "@noa/shared";

/** What voice engines record through (a PanelTrace, or nothing). */
export interface VoiceTracer {
  record(e: TraceDraft): void;
  /** The correlation id of the utterance being heard (made on first use, kept until endUtterance()). */
  utterance(): string;
  /** The utterance being heard is `cid` (Realtime: the user's input item whose turn sends a request). */
  useUtterance(cid: string): void;
  /** Utterance `cid` (default: the current one) is over; see PanelTrace.endUtterance. */
  endUtterance(cid?: string): void;
}

/** Events are sent at most this often. */
export const PANEL_TRACE_FLUSH_MS = 500;
/** Events waiting for their conversation: at most this many (the oldest go). */
export const MAX_WAITING = 300;
/** Correlation ids whose conversation is remembered. */
const MAX_BOUND = 50;

interface Waiting {
  e: TraceEvent;
  sessionId: string | null;
}

export class PanelTrace implements VoiceTracer {
  private waiting: Waiting[] = [];
  private readonly bound = new Map<string, string>();
  /** Utterances whose message is still to go out: their events wait for bind(). */
  private readonly open = new Set<string>();
  private current: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The chat events without a conversation of their own go to (hands-free voice's chat, when it has one). */
  target: () => string | null = () => null;

  constructor(
    private readonly send: (sessionId: string, events: TraceEvent[]) => Promise<unknown>,
    private readonly opts: { flushMs?: number; newId?: () => string } = {},
  ) {}

  /** A new correlation id (for a message about to be sent). */
  newCid(): string {
    return this.opts.newId?.() ?? crypto.randomUUID();
  }

  utterance(): string {
    if (this.current === null) this.useUtterance(this.newCid());
    return this.current!;
  }

  useUtterance(cid: string): void {
    this.current = cid;
    if (!this.bound.has(cid)) this.open.add(cid);
  }

  /**
   * Utterance `cid` is over. Without `cid`: the current one, whose message was sent (bind() came first) or went
   * nowhere (nothing heard, a "stop"); the next speech starts a new one. With `cid` (a Realtime turn done): unless it
   * is the current one, whose message may still be going out. Its events that went nowhere stay with the chat the
   * panel talks to.
   */
  endUtterance(cid?: string): void {
    const id = cid ?? this.current;
    if (id === null || (cid !== undefined && cid === this.current)) return;
    if (id === this.current) this.current = null;
    this.open.delete(id);
    if (this.bound.has(id)) return;
    const home = this.target();
    for (const w of this.waiting) if (w.sessionId === null && w.e.cid === id) w.sessionId = home;
    this.schedule();
  }

  record(draft: TraceDraft): void {
    const e: TraceEvent = { ...draft, src: "panel" };
    const cid = e.cid;
    const sessionId = cid === undefined ? this.target() : (this.bound.get(cid) ?? (this.open.has(cid) ? null : this.target()));
    this.waiting.push({ e, sessionId });
    if (this.waiting.length > MAX_WAITING) this.waiting.splice(0, this.waiting.length - MAX_WAITING);
    this.schedule();
  }

  /** The message with correlation id `cid` went to conversation `sessionId`: its events (and ones with no home yet) go there. */
  bind(cid: string, sessionId: string): void {
    this.bound.set(cid, sessionId);
    this.open.delete(cid);
    if (this.bound.size > MAX_BOUND) this.bound.delete(this.bound.keys().next().value!);
    for (const w of this.waiting) {
      if (w.sessionId === null && (w.e.cid === cid || w.e.cid === undefined || !this.open.has(w.e.cid))) w.sessionId = sessionId;
    }
    this.schedule();
  }

  /** Sends what has a conversation now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const by = new Map<string, TraceEvent[]>();
    const rest: Waiting[] = [];
    for (const w of this.waiting) {
      if (w.sessionId === null) rest.push(w);
      else by.set(w.sessionId, [...(by.get(w.sessionId) ?? []), w.e]);
    }
    this.waiting = rest;
    for (const [sessionId, events] of by) {
      void this.send(sessionId, events).catch((err: unknown) => console.warn(`[noa] sending trace events failed: ${String(err)}`));
    }
  }

  private schedule(): void {
    if (this.timer || !this.waiting.some((w) => w.sessionId !== null)) return;
    this.timer = setTimeout(() => this.flush(), this.opts.flushMs ?? PANEL_TRACE_FLUSH_MS);
  }
}
