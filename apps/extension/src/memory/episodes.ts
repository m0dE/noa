/**
 * The background memory writer: once a conversation is over for now, a small model (memory-writer.ts in shared,
 * on the conversation's own brain: summarizers.ts) reads it and writes
 *
 * - its episode: a dated summary (what was asked, what was done, where, how it ended), one per conversation,
 *   rewritten when a later turn of the same chat is summarized again. Not noted in the chat.
 * - at most a few durable facts the agent did not save itself (preferences, accounts, people, site playbooks),
 *   each noted in the chat as a `memory` event with auto: true, whose Undo (MemoryService.undo) puts it back.
 *
 * When: a task run is written soon after it ends (EPISODE_TASK_DELAY_MS); a chat once it has been idle for
 * EPISODE_IDLE_MS after a turn (the next turn's end pushes it back). The MV3 service worker sleeps, so the queue
 * ({sessionId, dueAt}) is kept in chrome.storage.local and a chrome.alarms alarm (EPISODE_ALARM) set to the earliest
 * due time wakes the worker for it; background.ts calls onAlarm() from its top-level listener and resume() at every
 * worker start (alarms may not survive a browser restart). The writer never blocks a chat: it runs on the alarm,
 * failures are logged and retried at most MAX_EPISODE_ATTEMPTS times, then dropped.
 *
 * Backfill: conversations from before the writer existed (or while it was off) have no episode. At a worker start
 * (resume), once per BACKFILL_VERSION, the ended conversations of the last BACKFILL_DAYS that have none are
 * listed, newest first, at most MAX_BACKFILL_SESSIONS, and kept in the same stored state; they are written one at a
 * time, BACKFILL_GAP_MS apart, only when nothing in the queue is due and no run is going on (deps.busy), by the same
 * pass as any other (the same checks, the conversation's own brain's writer, metered the same way). The list
 * survives worker restarts; turning memory or Episodes off drops it, and a later worker start lists again.
 * backfillProgress() is what Settings > Memory shows ("Summarising past chats: 12/40").
 *
 * Nothing is written while memory is paused, when the conversation's memory is off, when the user turned Episodes
 * off (Settings > Memory: that stops the whole pass), for a brain without a writer, for a conversation too short to
 * matter (MIN_EPISODE_TRANSCRIPT_CHARS), or when nothing happened since it was last summarized. Facts obey their
 * own kinds' switches, and the same rules as remember: a playbook names its site, a secret is refused (the store).
 */
import {
  bareToolName,
  buildMemoryWriterPrompt,
  errorMessage,
  isMemoryRecord,
  MAX_MEMORY_SUBJECT_CHARS,
  MAX_WRITER_EXISTING_ENTRIES,
  MEMORY_WRITER_SYSTEM_PROMPT,
  memoryDomain,
  memoryKeyOfTask,
  MIN_EPISODE_TRANSCRIPT_CHARS,
  parseMemoryWriterAnswer,
  transcriptChars,
  WriterFactKind,
  writerFactKinds,
  type ExtensionSettings,
  type MemoryEntry,
  type MemorySource,
  type MemoryTaskRef,
  type SessionInfo,
  type StampedAgentEvent,
  type TranscriptLine,
  type WriterFact,
} from "@noa/shared";
import type { StorageLike } from "../engine/kv.js";
import type { Job } from "../engine/run/jobs.js";
import { MAX_SESSIONS, type SessionStore } from "../engine/sessions.js";
import { toolArgsSummary } from "../text.js";
import { MemoryRefusal, sameSlot, sameText, type MemoryStore, type NewMemory } from "./store.js";
import type { Summarize } from "./summarizers.js";

/** The chrome.alarms alarm that wakes the worker for the writer. */
export const EPISODE_ALARM = "memory-episodes";
/** Where the writer's queue is kept (chrome.storage.local). */
export const EPISODE_QUEUE_KEY = "memoryEpisodes";
/** A chat is summarized once it has been idle this long after a turn (a new turn pushes it back). */
export const EPISODE_IDLE_MS = 10 * 60_000;
/** A task run is summarized this soon after it ends (Chrome's shortest alarm delay). */
export const EPISODE_TASK_DELAY_MS = 30_000;
/** A failed summary is tried again after this, times the attempts so far. */
export const EPISODE_RETRY_MS = 5 * 60_000;
/** Tries per summary before it is dropped. */
export const MAX_EPISODE_ATTEMPTS = 3;
/** Bump to list the past conversations without an episode again (a new writer worth running over them). */
export const BACKFILL_VERSION = 1;
/** How far back the backfill looks. */
export const BACKFILL_DAYS = 30;
/** Most past conversations one backfill writes (the newest). */
export const MAX_BACKFILL_SESSIONS = 40;
/** Between two backfill summaries, and from a worker start to the first (Chrome's shortest alarm delay). */
export const BACKFILL_GAP_MS = 30_000;
/** How long a tool call's arguments read in the transcript. */
const ACTION_ARGS_CHARS = 160;

/** When and how a conversation's turn ended, for its summary. */
export interface EpisodeTrigger {
  /** A task run ended: summarize soon. Otherwise a chat turn: once it has been idle. */
  soon: boolean;
  /** The conversation's task (a TODO or cloud task): its episode names it (taskKey, taskTitle). */
  task?: MemoryTaskRef;
}

/** How a run's end triggers the writer (lifecycle.ts): a task's first run soon, every chat turn once idle. */
export function episodeTrigger(job: Job): EpisodeTrigger {
  switch (job.source) {
    case "local":
      return { soon: true, task: { instructions: job.task.instructions, account: job.task.account, seriesId: job.task.seriesId ?? job.task.id } };
    case "cloud":
      return { soon: true, task: { instructions: job.claim.task.instructions, account: job.claim.task.account, seriesId: job.claim.task.seriesId } };
    case "adhoc":
      return { soon: false };
    case "turn":
      return { soon: false, ...(job.from.source === "adhoc" ? {} : { task: job.first }) };
  }
}

interface EpisodeJob {
  sessionId: string;
  dueAt: number;
  attempts: number;
  task?: MemoryTaskRef;
}

/** Past conversations still to summarize (newest first), and how many were listed. */
interface Backfill {
  pending: { sessionId: string; attempts: number }[];
  total: number;
  /** When the next one may be written (epoch ms). */
  nextAt: number;
}

interface WriterState {
  queue: EpisodeJob[];
  /** Each conversation's last event already summarized (its time), oldest first; at most MAX_SESSIONS. */
  written: Record<string, string>;
  /** The backfill under way, if any. */
  backfill?: Backfill;
  /** The BACKFILL_VERSION whose backfill was listed (done, or under way). */
  backfilled?: number;
}

/** How far the backfill is: conversations settled (written, skipped or given up) of all it listed. */
export interface BackfillProgress {
  done: number;
  total: number;
}

export interface EpisodeWriterDeps {
  store: Pick<MemoryStore, "list" | "put" | "putEpisode">;
  sessions: Pick<SessionStore, "get" | "eventsOf" | "note" | "list">;
  settings(): Promise<Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">>;
  /** The writer's call for a conversation on this brain (null: that brain has none). */
  summarizer(brain: SessionInfo["brain"]): Summarize | null;
  /** The EPISODE_ALARM alarm: set to fire at `when` (epoch ms), or cleared. */
  alarms: { set(when: number): Promise<void>; clear(): Promise<void> };
  /** A run is going on: the backfill waits (absent: never). */
  busy?(): boolean;
  /** The backfill's progress changed (Settings > Memory shows it). */
  onBackfillProgress?(): void;
  /** Default chrome.storage.local (looked up lazily). */
  storage?: StorageLike;
  now?(): number;
  newChangeId?(): string;
  log(message: string): void;
}

/** What one pass over a conversation came to: written, nothing to write (dropped), not yet (the chat runs), or failed. */
type Outcome = { kind: "done" | "skip"; why: string } | { kind: "wait" } | { kind: "fail"; why: string };

/** The events that are the conversation itself (not status lines, memory notes or voice). */
const CONTENT = new Set<StampedAgentEvent["type"]>(["user_message", "assistant_text", "tool_call", "tool_result", "task_end"]);

export class EpisodeWriter {
  private lock: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;

  constructor(private readonly deps: EpisodeWriterDeps) {}

  /** A conversation's turn ended: queue its summary (soon for a task run, after idle for a chat). Never throws. */
  async ended(sessionId: string, trigger: EpisodeTrigger): Promise<void> {
    try {
      await this.mutate((s) => {
        const was = s.queue.find((j) => j.sessionId === sessionId);
        const task = trigger.task ?? was?.task;
        const job: EpisodeJob = { sessionId, dueAt: this.now() + (trigger.soon ? EPISODE_TASK_DELAY_MS : EPISODE_IDLE_MS), attempts: 0, ...(task ? { task } : {}) };
        s.queue = [...s.queue.filter((j) => j.sessionId !== sessionId), job];
      });
      await this.schedule();
    } catch (err) {
      this.deps.log(`episode for ${sessionId} not queued: ${errorMessage(err)}`);
    }
  }

  /** chrome.alarms.onAlarm: true when the alarm was the writer's (it then writes what is due). */
  onAlarm(name: string): boolean {
    if (name !== EPISODE_ALARM) return false;
    void this.runDue();
    return true;
  }

  /**
   * A worker start: the past conversations without an episode are listed for the backfill (once per
   * BACKFILL_VERSION), and the alarm is set again for what is queued (alarms may not survive a browser restart).
   */
  async resume(): Promise<void> {
    await this.planBackfill().catch((err: unknown) => this.deps.log(`episode backfill not listed: ${errorMessage(err)}`));
    await this.reschedule();
  }

  /** The backfill's progress while it runs; null when there is none. */
  async backfillProgress(): Promise<BackfillProgress | null> {
    const b = (await this.state()).backfill;
    return b ? { done: b.total - b.pending.length, total: b.total } : null;
  }

  private async reschedule(): Promise<void> {
    await this.schedule().catch((err: unknown) => this.deps.log(`episode alarm not set: ${errorMessage(err)}`));
  }

  /**
   * Lists the ended conversations of the last BACKFILL_DAYS with no episode (none written, none in memory, none
   * queued; a brain with a writer; memory on in them), newest first, at most MAX_BACKFILL_SESSIONS. Not while
   * memory or Episodes are off: a later worker start tries again.
   */
  private async planBackfill(): Promise<void> {
    const st = await this.state();
    if (st.backfill || st.backfilled === BACKFILL_VERSION) return;
    if (offIn(await this.deps.settings())) return;
    const since = this.now() - BACKFILL_DAYS * 86_400_000;
    const summarized = new Set((await this.deps.store.list()).flatMap((e) => (e.kind === "episode" && e.source.sessionId ? [e.source.sessionId] : [])));
    const ids = (await this.deps.sessions.list(MAX_SESSIONS))
      .filter((s) => s.endedAt && !s.memoryOff && Date.parse(s.firstStartedAt ?? s.startedAt) >= since && this.deps.summarizer(s.brain))
      .filter((s) => !summarized.has(s.sessionId) && !st.written[s.sessionId] && !st.queue.some((j) => j.sessionId === s.sessionId))
      .slice(0, MAX_BACKFILL_SESSIONS)
      .map((s) => s.sessionId);
    await this.mutate((s) => {
      if (s.backfill || s.backfilled === BACKFILL_VERSION) return;
      s.backfilled = BACKFILL_VERSION;
      if (ids.length) s.backfill = { pending: ids.map((sessionId) => ({ sessionId, attempts: 0 })), total: ids.length, nextAt: this.now() + BACKFILL_GAP_MS };
    });
    if (ids.length) this.deps.log(`episode backfill: ${ids.length} past conversation(s) to summarize`);
    this.progressed();
  }

  /** Writes every summary that is due, one at a time, then sets the alarm for the next. One pass at a time. */
  runDue(): Promise<void> {
    this.running ??= this.drain().finally(() => (this.running = null));
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const job = (await this.state()).queue.filter((j) => j.dueAt <= this.now()).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!job) break;
        await this.settle(job, await this.attempt(job));
      }
      // The backfill's next conversation: only once nothing else is due, one per BACKFILL_GAP_MS.
      await this.backfillNext();
    } catch (err) {
      this.deps.log(`episodes: ${errorMessage(err)}`);
    }
    await this.reschedule();
  }

  private async attempt(job: EpisodeJob): Promise<Outcome> {
    try {
      return await this.write(job);
    } catch (err) {
      return { kind: "fail", why: errorMessage(err) };
    }
  }

  /** Writes the backfill's next conversation when it is due and no run is going on; drops the backfill when memory is off. */
  private async backfillNext(): Promise<void> {
    const b = (await this.state()).backfill;
    if (!b || b.nextAt > this.now()) return;
    if (offIn(await this.deps.settings())) {
      await this.mutate((s) => {
        delete s.backfill;
        delete s.backfilled;
      });
      this.deps.log("episode backfill dropped: memory or Episodes are off (listed again at a later start)");
      return this.progressed();
    }
    if (this.deps.busy?.()) {
      await this.mutate((s) => void (s.backfill && (s.backfill.nextAt = this.now() + BACKFILL_GAP_MS)));
      return;
    }
    const item = b.pending[0]!;
    const outcome = await this.attempt({ sessionId: item.sessionId, dueAt: this.now(), attempts: item.attempts });
    const retry = outcome.kind === "fail" && item.attempts + 1 < MAX_EPISODE_ATTEMPTS;
    const said =
      outcome.kind === "done" ? outcome.why : outcome.kind === "wait" ? "running again (its own turn queues it)" : outcome.kind === "skip" ? `skipped, ${outcome.why}` : `failed${retry ? "" : ", dropped"}: ${outcome.why}`;
    this.deps.log(`episode backfill ${item.sessionId}: ${said}`);
    await this.mutate((s) => {
      if (!s.backfill) return;
      const rest = s.backfill.pending.filter((p) => p.sessionId !== item.sessionId);
      s.backfill.pending = retry ? [...rest, { sessionId: item.sessionId, attempts: item.attempts + 1 }] : rest;
      s.backfill.nextAt = this.now() + BACKFILL_GAP_MS;
      if (!s.backfill.pending.length) delete s.backfill;
    });
    this.progressed();
  }

  private progressed(): void {
    try {
      this.deps.onBackfillProgress?.();
    } catch {
      /* the UI's push is not the writer's problem */
    }
  }

  /** The job's queue entry after a pass (unless a later turn queued it again meanwhile). */
  private async settle(job: EpisodeJob, outcome: Outcome): Promise<void> {
    const id = job.sessionId;
    if (outcome.kind === "done" || outcome.kind === "skip") this.deps.log(`episode for ${id}: ${outcome.kind === "done" ? "" : "skipped, "}${outcome.why}`);
    const retry = outcome.kind === "fail" && job.attempts + 1 < MAX_EPISODE_ATTEMPTS;
    if (outcome.kind === "fail") this.deps.log(`episode for ${id} failed (attempt ${job.attempts + 1} of ${MAX_EPISODE_ATTEMPTS}${retry ? "" : ", dropped"}): ${outcome.why}`);
    await this.mutate((s) => {
      const now = s.queue.find((j) => j.sessionId === id);
      // A later turn queued it again while this pass ran: that entry stands.
      if (!now || now.dueAt !== job.dueAt) return;
      const rest = s.queue.filter((j) => j.sessionId !== id);
      if (outcome.kind === "wait") s.queue = [...rest, { ...now, dueAt: this.now() + EPISODE_IDLE_MS }];
      else if (retry) s.queue = [...rest, { ...now, attempts: job.attempts + 1, dueAt: this.now() + EPISODE_RETRY_MS * (job.attempts + 1) }];
      else s.queue = rest;
    });
  }

  /** One conversation's pass: the checks, the model call, and what it saves. */
  private async write(job: EpisodeJob): Promise<Outcome> {
    const id = job.sessionId;
    const off = await this.offReason(id);
    if (off) return { kind: "skip", why: off };
    const session = (await this.deps.sessions.get(id))!;
    if (!session.endedAt) return { kind: "wait" };
    const summarize = this.deps.summarizer(session.brain);
    if (!summarize) return { kind: "skip", why: `no memory writer for the ${session.brain} brain` };
    const events = await this.deps.sessions.eventsOf(id);
    const lastAt = events.filter((e) => CONTENT.has(e.type)).at(-1)?.ts ?? session.endedAt;
    const written = (await this.state()).written[id];
    if (written && written >= lastAt) return { kind: "skip", why: "nothing new since its last summary" };
    const lines = transcriptLines(session, events, job.task);
    if (transcriptChars(lines) < MIN_EPISODE_TRANSCRIPT_CHARS) return { kind: "skip", why: "too short to summarize" };

    const entries = await this.deps.store.list();
    const prompt = buildMemoryWriterPrompt({
      kind: session.source === "adhoc" ? "chat" : "task",
      title: session.title,
      startedAt: session.firstStartedAt ?? session.startedAt,
      endedAt: session.endedAt,
      lines,
      existing: entriesToShow(entries, id, lines),
    });
    const reply = await summarize({ system: MEMORY_WRITER_SYSTEM_PROMPT, prompt, sessionId: id });
    const answer = parseMemoryWriterAnswer(reply.text);
    const cost = reply.costUsd === undefined ? "" : ` ($${reply.costUsd.toFixed(4)})`;

    // Settings may have changed while the model wrote.
    const offNow = await this.offReason(id);
    if (offNow) return { kind: "skip", why: offNow };
    const source: MemorySource = { kind: session.source === "adhoc" ? "chat" : "task", sessionId: id, title: session.title };
    let episode = "no episode";
    if (answer.episode) {
      const task = job.task ? { taskKey: memoryKeyOfTask(job.task), taskTitle: firstLine(job.task.instructions) } : {};
      try {
        const change = await this.deps.store.putEpisode({ ...answer.episode, at: session.firstStartedAt ?? session.startedAt, ...task }, source);
        episode = `episode [${change.after!.id}] ${change.before ? "rewritten" : "written"}`;
      } catch (err) {
        if (!(err instanceof MemoryRefusal)) throw err;
        episode = `episode refused (${err.message})`;
      }
    }
    const saved = await this.saveFacts(id, answer.facts, entries, source);
    await this.mutate((s) => {
      delete s.written[id];
      s.written[id] = lastAt;
      const ids = Object.keys(s.written);
      for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete s.written[old];
    });
    return { kind: "done", why: `${episode}, ${saved} fact(s) saved${cost}` };
  }

  /** Saves the facts whose kinds are on, each noted in the chat (auto) for Undo; returns how many were saved. */
  private async saveFacts(sessionId: string, facts: readonly WriterFact[], entries: readonly MemoryEntry[], source: MemorySource): Promise<number> {
    const kinds = writerFactKinds((await this.deps.settings()).memoryKindsOff);
    let saved = 0;
    for (const f of facts) {
      if (!kinds.includes(f.kind)) continue;
      const m = settleFact(f);
      if (!m || entries.some((e) => sameSlot(e, m) && sameText(e.text, m.text))) continue;
      const replaces = f.replaces && replaceable(entries, f.replaces.replace(/^\[|\]$/g, ""), m);
      try {
        const change = await this.deps.store.put(m, source, replaces ? { replaces } : {});
        const changeId = this.deps.newChangeId?.() ?? crypto.randomUUID();
        await this.deps.sessions.note(sessionId, { type: "memory", changeId, before: change.before, after: change.after, ...(change.replaced ? { replaced: change.replaced } : {}), auto: true });
        saved++;
      } catch (err) {
        if (!(err instanceof MemoryRefusal)) throw err;
        this.deps.log(`fact "${m.subject}" from ${sessionId} refused: ${err.message}`);
      }
    }
    return saved;
  }

  /** Why nothing may be written for this conversation now, or null. */
  private async offReason(sessionId: string): Promise<string | null> {
    const off = offIn(await this.deps.settings());
    if (off) return off;
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return "the conversation is gone";
    return session.memoryOff ? "memory is off in this chat" : null;
  }

  private async schedule(): Promise<void> {
    const st = await this.state();
    const due = [...st.queue.map((j) => j.dueAt), ...(st.backfill ? [st.backfill.nextAt] : [])];
    if (due.length) await this.deps.alarms.set(Math.min(...due));
    else await this.deps.alarms.clear();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private storage(): StorageLike {
    return this.deps.storage ?? chrome.storage.local;
  }

  private async state(): Promise<WriterState> {
    const got = (await this.storage().get(EPISODE_QUEUE_KEY))[EPISODE_QUEUE_KEY] as Partial<WriterState> | undefined;
    const b = got?.backfill;
    const pending = Array.isArray(b?.pending) ? b.pending.filter((p) => typeof p?.sessionId === "string" && typeof p.attempts === "number") : [];
    return {
      queue: Array.isArray(got?.queue) ? got.queue.filter((j) => typeof j?.sessionId === "string" && typeof j.dueAt === "number") : [],
      written: got?.written && typeof got.written === "object" ? { ...got.written } : {},
      ...(pending.length ? { backfill: { pending, total: Math.max(pending.length, Number(b!.total) || 0), nextAt: Number(b!.nextAt) || 0 } } : {}),
      ...(typeof got?.backfilled === "number" ? { backfilled: got.backfilled } : {}),
    };
  }

  /** Serialized read-modify-write of the queue. */
  private async mutate(fn: (s: WriterState) => void): Promise<void> {
    const run = this.lock.then(async () => {
      const s = await this.state();
      fn(s);
      await this.storage().set({ [EPISODE_QUEUE_KEY]: s });
    });
    this.lock = run.catch(() => {});
    await run;
  }
}

/**
 * The conversation as the writer reads it: its first request, the user's messages, the agent's replies, its tool
 * calls in brief (errors marked), and how each turn ended. The task's own end calls are left out (the outcome says it).
 */
export function transcriptLines(session: SessionInfo, events: readonly StampedAgentEvent[], task?: { instructions: string }): TranscriptLine[] {
  const errors = new Map<string, string>();
  for (const e of events) if (e.type === "tool_result" && e.isError) errors.set(e.id, (e.text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "failed");
  const lines: TranscriptLine[] = [{ who: "user", text: task?.instructions ?? session.instructions ?? session.title }];
  for (const e of events) {
    if (e.type === "user_message") lines.push({ who: "user", text: e.text });
    else if (e.type === "assistant_text") lines.push({ who: "agent", text: e.text });
    else if (e.type === "tool_call") {
      const name = bareToolName(e.name);
      if (name.startsWith("task_")) continue;
      const args = toolArgsSummary(name, e.args, ACTION_ARGS_CHARS);
      const error = errors.get(e.id);
      lines.push({ who: "action", text: `${name}${args ? ` ${args}` : ""}${error ? ` (error: ${error})` : ""}` });
    } else if (e.type === "task_end") {
      const parts = [e.outcome, e.summary ? `: ${e.summary}` : "", e.reason ? ` (${e.reason})` : "", e.url ? ` ${e.url}` : ""];
      lines.push({ who: "outcome", text: parts.join("") });
    }
  }
  return lines;
}

/** The fact as memory keeps it (remember's rules: a site's host for a domain, a playbook needs one), or null. */
function settleFact(f: WriterFact): NewMemory | null {
  const domain = f.domain === undefined ? undefined : (memoryDomain(f.domain) ?? undefined);
  if (f.kind === "playbook" && !domain) return null;
  return { kind: f.kind, subject: f.subject, text: f.text, ...(domain ? { scope: "domain" as const, domain } : { scope: "global" as const }) };
}

/**
 * `id` when it names a fact the writer may replace, else undefined: a fact of the same kind in the same place (the
 * same site, or both everywhere), not the fact's own slot. A site's rule is narrower than one for everywhere, so it
 * stands beside it and never replaces it (a small model names `replaces` too eagerly).
 */
function replaceable(entries: readonly MemoryEntry[], id: string, m: NewMemory): string | undefined {
  const e = entries.find((x) => x.id === id);
  return e && !isMemoryRecord(e) && e.kind === m.kind && e.scope === m.scope && e.domain === m.domain && !sameSlot(e, m) ? id : undefined;
}

/**
 * The entries the writer is shown so it does not repeat them: facts of the kinds it writes, those saved in this
 * conversation first, then those the conversation mentions (subject or site), then the most recently changed.
 */
function entriesToShow(entries: readonly MemoryEntry[], sessionId: string, lines: readonly TranscriptLine[]): MemoryEntry[] {
  const text = lines.map((l) => l.text).join("\n").toLowerCase();
  const kinds: readonly string[] = WriterFactKind.options;
  const score = (e: MemoryEntry) => (e.source.sessionId === sessionId ? 2 : 0) + (text.includes(e.subject.toLowerCase()) || (e.domain && text.includes(e.domain)) ? 1 : 0);
  return entries
    .filter((e) => !isMemoryRecord(e) && kinds.includes(e.kind))
    .map((e) => ({ e, s: score(e) }))
    .sort((a, b) => b.s - a.s || b.e.updatedAt.localeCompare(a.e.updatedAt))
    .slice(0, MAX_WRITER_EXISTING_ENTRIES)
    .map((x) => x.e);
}

/** Why no episode may be written at all now (memory paused, Episodes off), or null. */
function offIn(settings: Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">): string | null {
  if (settings.memoryPaused) return "memory is paused";
  return settings.memoryKindsOff.includes("episode") ? "episodes are off in Settings" : null;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, MAX_MEMORY_SUBJECT_CHARS);
}
