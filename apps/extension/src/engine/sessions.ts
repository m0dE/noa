/**
 * Session history: one SessionInfo per agent run plus its event stream, in
 * IndexedDB. New events and session changes are pushed live to listeners
 * (the UI ports). With a TraceStore, each conversation also has its timing
 * trace: `trace` events go there instead of the event stream, every other
 * event is counted there, and each turn's start is marked (create, reopen).
 */
import { MAX_ASSISTANT_TEXT, MAX_EVENT_TEXT, clipEventText, type AgentEvent, type SessionInfo, type StampedAgentEvent, type TitleBy, type TraceEvent } from "@noa/shared";
import { Listeners } from "../listeners.js";
import type { KvDb, KvStore } from "./kv.js";
import type { TraceBook } from "../trace/trace-book.js";
import type { TraceStore } from "./trace-store.js";
import type { AttachmentStore } from "./attachment-store.js";

export const MAX_SESSIONS = 200;
export const MAX_EVENTS_PER_SESSION = 2000;
/** Thumbnails bigger than this (base64 chars) are dropped from stored events. */
const MAX_THUMBNAIL_CHARS = 200_000;

export interface SessionListener {
  onEvent?(e: StampedAgentEvent): void;
  onSession?(s: SessionInfo): void;
}

function seqKey(sessionId: string, seq: number): string {
  return `${sessionId}:${String(seq).padStart(8, "0")}`;
}

/** Bounds the text fields of an event so storage stays small. */
function clipEvent(e: AgentEvent): AgentEvent {
  switch (e.type) {
    case "assistant_text":
      return { ...e, text: clipEventText(e.text, MAX_ASSISTANT_TEXT) };
    case "task_end":
      return e.summary && e.summary.length > MAX_ASSISTANT_TEXT ? { ...e, summary: clipEventText(e.summary, MAX_ASSISTANT_TEXT) } : e;
    case "user_message":
      return { ...e, text: clipEventText(e.text), ...(e.heard ? { heard: e.heard.map((w) => clipEventText(w)) } : {}) };
    case "status":
    case "spoken":
    case "error":
      return { ...e, text: clipEventText(e.text) };
    case "heard":
      return { ...e, text: clipEventText(e.text) };
    case "task_scheduled":
      return { ...e, instructions: clipEventText(e.instructions) };
    case "task_changed":
      return { ...e, instructions: clipEventText(e.instructions), ...(e.before ? { before: { ...e.before, instructions: clipEventText(e.before.instructions) } } : {}) };
    case "tool_result": {
      const out = { ...e };
      if (out.text !== undefined) out.text = clipEventText(out.text);
      if (out.thumbnail && out.thumbnail.length > MAX_THUMBNAIL_CHARS) delete out.thumbnail;
      return out;
    }
    case "tool_call": {
      const json = JSON.stringify(e.args ?? null);
      return json && json.length > MAX_EVENT_TEXT ? { ...e, args: clipEventText(json) } : e;
    }
    default:
      return e;
  }
}

export class SessionStore {
  private readonly sessions: KvStore<SessionInfo>;
  private readonly events: KvStore<StampedAgentEvent>;
  private readonly listeners = new Listeners<[{ event: StampedAgentEvent } | { session: SessionInfo }]>();
  /** Next sequence number per live session. */
  private readonly seq = new Map<string, number>();
  private readonly now: () => Date;
  /** Serializes writes so events keep their order. */
  private chain: Promise<unknown> = Promise.resolve();

  private readonly trace: TraceStore | null;
  /** The files sent in conversations: deleted with their conversation. */
  private readonly attachments: Pick<AttachmentStore, "deleteSession"> | null;

  constructor(db: KvDb, opts: { now?: () => Date; trace?: TraceStore; attachments?: Pick<AttachmentStore, "deleteSession"> } = {}) {
    this.sessions = db.store<SessionInfo>("sessions");
    this.events = db.store<StampedAgentEvent>("events");
    this.now = opts.now ?? (() => new Date());
    this.trace = opts.trace ?? null;
    this.attachments = opts.attachments ?? null;
  }

  subscribe(l: SessionListener): () => void {
    return this.listeners.add((change) => ("event" in change ? l.onEvent?.(change.event) : l.onSession?.(change.session)));
  }

  async create(info: SessionInfo): Promise<SessionInfo> {
    this.seq.set(info.sessionId, 0);
    this.trace?.start(info.sessionId, this.now().getTime(), turnData(info, info.instructions?.length));
    await this.enqueue(async () => {
      await this.sessions.put(info.sessionId, info);
      await this.prune();
    });
    this.emitSession(info);
    return info;
  }

  /**
   * Stamps, stores and pushes one event. Never throws. Live text deltas
   * (assistant_text_delta) are only pushed: the final assistant_text is
   * what is kept.
   */
  append(sessionId: string, event: AgentEvent): StampedAgentEvent {
    const now = this.now();
    if (event.type === "trace") {
      // Only for a session running now (a launch that never created its session leaves no trace behind).
      if (this.seq.has(sessionId)) this.trace?.record(sessionId, event.trace);
      return { ...event, ts: now.toISOString(), sessionId };
    }
    this.trace?.observe(sessionId, event, now.getTime());
    if (event.type === "assistant_text_delta") {
      const live = { ...event, ts: now.toISOString(), sessionId } as StampedAgentEvent;
      this.listeners.emit({ event: live });
      return live;
    }
    const stamped = { ...clipEvent(event), ts: now.toISOString(), sessionId } as StampedAgentEvent;
    const n = this.seq.get(sessionId) ?? 0;
    this.seq.set(sessionId, n + 1);
    void this.enqueue(async () => {
      await this.events.put(seqKey(sessionId, n), stamped);
      if (n >= MAX_EVENTS_PER_SESSION) await this.events.delete(seqKey(sessionId, n - MAX_EVENTS_PER_SESSION));
    }).catch(() => {});
    this.listeners.emit({ event: stamped });
    return stamped;
  }

  async update(sessionId: string, patch: Partial<SessionInfo>): Promise<SessionInfo | null> {
    const s = await this.enqueue(async () => {
      const cur = await this.sessions.get(sessionId);
      if (!cur) return null;
      const next: SessionInfo = { ...cur, ...patch, sessionId };
      await this.sessions.put(sessionId, next);
      return next;
    });
    if (s) this.emitSession(s);
    if (s?.endedAt) this.seq.delete(sessionId);
    return s;
  }

  /**
   * Sets the conversation's title, written by `by` (the title model after `turn`, or the user). A title the user
   * gave is only ever replaced by the user. Null when unknown or refused.
   */
  async retitle(sessionId: string, title: string, by: TitleBy, turn?: number): Promise<SessionInfo | null> {
    const s = await this.enqueue(async () => {
      const cur = await this.sessions.get(sessionId);
      if (!cur || (cur.titleBy === "user" && by !== "user")) return null;
      const { titledTurn: _t, ...rest } = cur;
      const next: SessionInfo = { ...rest, title, titleBy: by, ...(turn === undefined ? {} : { titledTurn: turn }) };
      await this.sessions.put(sessionId, next);
      return next;
    });
    if (s) this.emitSession(s);
    return s;
  }

  /**
   * Starts the next turn of an ended conversation: its events keep appending
   * after the stored ones, and the latest-turn fields (endedAt, outcome,
   * summary, url, reason, suggestion) are cleared, then `patch` applied. Null
   * when unknown.
   */
  async reopen(sessionId: string, patch: Partial<SessionInfo> = {}): Promise<SessionInfo | null> {
    const s = await this.enqueue(async () => {
      const cur = await this.sessions.get(sessionId);
      if (!cur) return null;
      const { endedAt: _e, outcome: _o, summary: _s, url: _u, reason: _r, suggestion: _g, ...rest } = cur;
      const next: SessionInfo = { ...rest, ...patch, sessionId };
      await this.sessions.put(sessionId, next);
      this.seq.set(sessionId, Math.max(await this.storedSeq(sessionId), this.seq.get(sessionId) ?? 0));
      return next;
    });
    if (s) {
      this.trace?.beginTurn(sessionId, s.turns ?? 1, this.now().getTime(), turnData(s));
      this.emitSession(s);
    }
    return s;
  }

  /**
   * Adds an event to a stored conversation from outside its turns (hands-free
   * voice's spoken lines): while it runs, or after it ended (also after the
   * service worker restarted). Null when there is no such session.
   */
  async note(sessionId: string, event: AgentEvent): Promise<StampedAgentEvent | null> {
    return (await this.known(sessionId)) ? this.append(sessionId, event) : null;
  }

  /**
   * Adds trace events to a stored conversation from outside its turns (the
   * side panel's voice timings), also after it ended. False when there is no
   * such session.
   */
  async addTrace(sessionId: string, events: readonly TraceEvent[]): Promise<boolean> {
    if (!(await this.known(sessionId))) return false;
    for (const trace of events) this.append(sessionId, { type: "trace", trace });
    return true;
  }

  /** The session exists (its next event number is then known). */
  private async known(sessionId: string): Promise<boolean> {
    return (
      this.seq.has(sessionId) ||
      this.enqueue(async () => {
        if (this.seq.has(sessionId)) return true;
        if (!(await this.sessions.get(sessionId))) return false;
        this.seq.set(sessionId, await this.storedSeq(sessionId));
        return true;
      })
    );
  }

  async get(sessionId: string): Promise<SessionInfo | null> {
    await this.chain.catch(() => {});
    return (await this.sessions.get(sessionId)) ?? null;
  }

  /** Newest first; with taskId, only that task's runs. */
  async list(limit = 50, taskId?: string): Promise<SessionInfo[]> {
    await this.chain.catch(() => {});
    const all = (await this.sessions.list()).map((e) => e.value).filter((s) => taskId === undefined || s.taskId === taskId);
    all.sort((a, b) => byStart(b, a));
    return all.slice(0, Math.max(1, Math.min(MAX_SESSIONS, limit)));
  }

  async eventsOf(sessionId: string): Promise<StampedAgentEvent[]> {
    await this.chain.catch(() => {});
    return (await this.events.list(`${sessionId}:`)).map((e) => e.value);
  }

  /** The conversation's timing trace (null: none, or no TraceStore). */
  async traceOf(sessionId: string): Promise<TraceBook | null> {
    return this.trace ? this.trace.get(sessionId) : null;
  }

  /** The user message with correlation id `cid` (the panel's, for its voice timings) went to the conversation's running turn. */
  linkTrace(sessionId: string, cid: string): void {
    this.trace?.link(sessionId, cid);
  }

  /** Waits for queued writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.chain.catch(() => {});
    await this.trace?.flush();
  }

  /** The sequence number after the session's last stored event. */
  private async storedSeq(sessionId: string): Promise<number> {
    const last = (await this.events.keys(`${sessionId}:`)).at(-1);
    return last ? Number(last.slice(sessionId.length + 1)) + 1 : 0;
  }

  /** Deletes a conversation with its events, trace and files (the user's Delete). False when there is none. */
  async delete(sessionId: string): Promise<boolean> {
    const deleted = await this.enqueue(async () => {
      if (!(await this.sessions.get(sessionId))) return false;
      await this.remove(sessionId);
      return true;
    });
    if (deleted) this.seq.delete(sessionId);
    return deleted;
  }

  private async prune(): Promise<void> {
    const all = (await this.sessions.list()).map((e) => e.value);
    if (all.length <= MAX_SESSIONS) return;
    all.sort(byStart);
    for (const s of all.slice(0, all.length - MAX_SESSIONS)) await this.remove(s.sessionId);
  }

  private async remove(sessionId: string): Promise<void> {
    await this.sessions.delete(sessionId);
    await this.events.deletePrefix(`${sessionId}:`);
    await this.trace?.delete(sessionId);
    await this.attachments?.deleteSession(sessionId);
  }

  private emitSession(s: SessionInfo): void {
    this.listeners.emit({ session: s });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

/** What a turn runs with, for its turn.start trace event. */
function turnData(s: SessionInfo, chars?: number): Record<string, string | number | boolean> {
  const d: Record<string, string | number | boolean> = { brain: s.brain, jev: s.jev, source: s.source };
  if (s.model) d.model = s.model;
  if (s.voice) d.voice = true;
  if (chars !== undefined) d.chars = chars;
  return d;
}

/** Oldest first (ISO timestamps compare as text). */
function byStart(a: SessionInfo, b: SessionInfo): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
}
