/**
 * The agent's memory, as runs and the UI use it (the store is store.ts, the
 * choice of what to give the agent select.ts):
 *
 * - begin(): at the start of every turn, the memory block for the prompt
 *   (nothing when memory is paused, off in this chat, or nothing is relevant),
 *   and what the turn is (its repeating task, if any) for the tools.
 * - tool(): remember / recall / forget / search_history, for every brain (the API
 *   brains call it directly, Claude Code through the helper's memory.call);
 *   search_history reads the user's past conversations (history.ts). remember with a
 *   key files the fact in the record for that key (a repeating task's own, or
 *   from a chat the user's); recall with a key returns it (in a task its own
 *   first). Turn start and recall add the account's semantic scores when
 *   memory syncs (deps.semantic, at most MEMORY_SEARCH_TIMEOUT_MS).
 * - runNote(): a repeating task's run for its next runs (task_complete `memory_note` and `output`).
 * - check_similar (a tool): a draft against what earlier runs put out (runs.ts).
 *
 * A task's memory is kept under its series (memoryKeyOfTask), the same through every repeat and edit. What was kept
 * under the key it had before it had a series (its instructions' hash, memoryTaskKey) is adopted by the series at its
 * first turn: the hashes of every row of the series (deps.seriesTasks: their instructions as they were at each run)
 * move to the series' key, once. An edit of a task's instructions moves the old hash too (taskEdited).
 * - handle(): Settings > Memory and the chat (list, edit, delete, delete a
 *   task's memory, forget everything, Undo on a "Remembered" note, memory off
 *   for one chat, and whether this computer's memory goes to a newly signed-in
 *   account).
 *
 * Every change made from a conversation is written to it as a `memory` event:
 * the chat's "Remembered: ..." note, whose Undo puts the entry back as it was.
 */
import {
  CheckSimilarArgs,

  errorMessage,
  ForgetArgs,
  isEarlierRuns,
  isTaskRun,
  MAX_MEMORY_NOTE_CHARS,
  MAX_RUN_OUTPUT_CHARS,
  MEMORY_KIND_TEXT,
  memoryDomain,
  memoryKeyOfTask,
  memoryLine,
  memoryRecordKey,
  memoryTaskKey,
  MAX_MEMORY_SUBJECT_CHARS,
  RecallArgs,
  RememberArgs,
  secretProblem,
  seriesTaskKey,
  TASK_RUN_SUBJECT,
  type ExtensionSettings,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemorySource,
  type MemoryTaskRef,
  type MemoryToolName,
  type SessionInfo,
} from "@noa/shared";
import type { SessionStore } from "../engine/sessions.js";
import type { UiRequest, UiResults } from "../ui-protocol.js";
import { searchHistory } from "./history.js";
import { similarAnswer } from "./runs.js";
import { recallMemory, recordFor, selectMemory, hostsIn, type MemorySelection } from "./select.js";
import { MemoryRefusal, type MemoryChange, type MemoryStore, type NewMemory, type NewRecord } from "./store.js";
import type { MemorySync } from "./sync.js";

export type MemoryTool = MemoryToolName;

/** What a turn is, for its memory. */
export interface MemoryRun {
  /** A TODO-list or cloud task: its runs are kept under its series (memoryKeyOfTask). Absent: a chat. */
  task?: MemoryTaskRef;
  /** The run's title (the source Settings shows for what it saved). */
  title: string;
  /** The request this turn: the instructions, or the user's message. */
  request: string;
  /** The page the user's tab shows (its site's playbook is given, and the task's records its address names). */
  tabUrl?: string;
  /** That page's title (the task's records it names are given). */
  tabTitle?: string;
  /** The next turn in the same agent session: it already has what earlier turns were given, so only new entries come. */
  continued?: boolean;
  /**
   * A chat about `task` (Talk about this), not one of its runs: it is given the task's memory and remember may add to
   * it, but it leaves no run note (the task history is its runs').
   */
  review?: boolean;
}

/** The answer a memory tool gives the model. */
export interface MemoryToolResult {
  text: string;
  isError?: true;
}

/** The requests of Settings > Memory and of the chat that memory answers (ui-protocol.ts). */
export type MemoryRequest = Extract<
  UiRequest,
  {
    type: "memory.list" | "memory.edit" | "memory.delete" | "memory.pin" | "memory.deleteTask" | "memory.taskRuns" | "memory.clear" | "memory.undo" | "memory.syncChoice" | "chat.setMemory";
  }
>;
export const MEMORY_REQUESTS: readonly MemoryRequest["type"][] = [
  "memory.list",
  "memory.taskRuns",
  "memory.edit",
  "memory.delete",
  "memory.pin",
  "memory.deleteTask",
  "memory.clear",
  "memory.undo",
  "memory.syncChoice",
  "chat.setMemory",
];

export function isMemoryRequest(msg: { type: string }): msg is MemoryRequest {
  return (MEMORY_REQUESTS as readonly string[]).includes(msg.type);
}

export interface MemoryServiceDeps {
  store: MemoryStore;
  sessions: Pick<SessionStore, "note" | "eventsOf" | "get" | "update" | "list">;
  settings(): Promise<Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">>;
  /** Sync with the signed-in account (sync.ts). Absent: memory stays on this computer. */
  sync?: Pick<MemorySync, "pullSoon" | "sync" | "status" | "forgetAll" | "choose">;
  /**
   * The account's semantic search (entry id -> cosine similarity to `query`), when memory syncs with it; null or a
   * failure: the turn goes on with words, entities and time alone. Given at most MEMORY_SEARCH_TIMEOUT_MS.
   */
  semantic?(query: string, taskKey: string | null): Promise<ReadonlyMap<string, number> | null>;
  /**
   * Every row of a task series (a repeating task's runs and its waiting one), for adopting what was kept under their
   * instructions before tasks had a series. Absent or failing: only the task's own instructions are adopted, and the
   * series is tried again at its next turn.
   */
  seriesTasks?(seriesId: string): Promise<MemoryTaskRef[]>;
  newChangeId?(): string;
  now?(): Date;
}

/** What a turn is given from memory, and how long it waited for the account's search (late: it went on without it). */
export type TurnMemory = MemorySelection & { search?: { ms: number; late?: true } };

/** How long a turn waits for the account's semantic search before going on without it. */
export const MEMORY_SEARCH_TIMEOUT_MS = 1500;
/**
 * The same for the next turn of an agent session that is still open: it already has what earlier turns were given
 * (and recall, which searches by meaning too), so its message goes out without waiting for the round trip (measured
 * in the user's traces: memory.wait 270-490 ms per follow-up); a search that answers within this still counts.
 */
export const MEMORY_SEARCH_FOLLOW_UP_TIMEOUT_MS = 150;
/** Hits asked of the account's semantic search (the entries a turn could be given are far fewer). */
export const MEMORY_SEARCH_LIMIT = 50;

/** Turns remembered for the tools: the newest ones (a conversation's next turn calls begin() again). */
const MAX_RUNS = 50;

/** What the tools say when memory is off, by why. */
const OFF_TEXT = {
  paused: "Memory is paused by the user (Settings > Memory)",
  chat: "Memory is off in this chat (the user's choice)",
} as const;

/** What a memory tool would have done, for its answer when memory is off. */
const OFF_DONE: Record<MemoryTool, string> = { remember: "saved", recall: "recalled", forget: "forgotten", search_history: "searched", check_similar: "checked" };

/** A run's note when it left only an output. */
const NO_NOTE = "(no note)";

export class MemoryService {
  private readonly runs = new Map<string, { taskKey?: string; taskTitle?: string; review?: true; source: MemorySource }>();
  /** The entries each agent session was given (a continued turn is not given them again). */
  private readonly given = new Map<string, Set<string>>();

  constructor(private readonly deps: MemoryServiceDeps) {}

  /**
   * The start of a turn: what the agent is given from memory (undefined: nothing, memory is off or nothing is
   * relevant), with how much of the budget it took. The turn is remembered for the tools.
   */
  async begin(sessionId: string, run: MemoryRun): Promise<TurnMemory | undefined> {
    const taskKey = run.task ? memoryKeyOfTask(run.task) : undefined;
    this.runs.delete(sessionId);
    const given = (run.continued && this.given.get(sessionId)) || new Set<string>();
    this.given.delete(sessionId);
    this.given.set(sessionId, given);
    this.runs.set(sessionId, {
      ...(taskKey ? { taskKey, taskTitle: firstLine(run.task!.instructions) } : {}),
      ...(run.review ? { review: true as const } : {}),
      source: { kind: run.task && !run.review ? "task" : "chat", sessionId, title: firstLine(run.title) },
    });
    while (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
    while (this.given.size > MAX_RUNS) this.given.delete(this.given.keys().next().value!);
    const settings = await this.deps.settings();
    if (await this.offReason(sessionId, settings)) return undefined;
    // Another browser's new entries come in the background (this turn uses what is here).
    this.deps.sync?.pullSoon();
    const hosts = [...(run.tabUrl ? hostsIn(run.tabUrl) : []), ...hostsIn(run.request)];
    // The account's search (a network call, the slow part) runs while the entries are read (after the task's older
    // memory moved to its series, the first time).
    const searchTimeoutMs = run.continued ? MEMORY_SEARCH_FOLLOW_UP_TIMEOUT_MS : MEMORY_SEARCH_TIMEOUT_MS;
    const entries = (run.task ? this.adopt(run.task) : Promise.resolve()).then(() => this.deps.store.list());
    const [all, search] = await Promise.all([entries, this.semantic(run.request, taskKey ?? null, searchTimeoutMs)]);
    const semantic = search?.hits;
    const unseen = all.filter((e) => !given.has(e.id));
    const pageText = [run.tabUrl, run.tabTitle].filter(Boolean).join("\n");
    const ctx = { taskKey: taskKey ?? null, hosts, text: run.request, ...this.clock(), ...(pageText ? { pageText } : {}), ...(semantic ? { semantic } : {}) };
    const picked = selectMemory(unseen, ctx, { kindsOff: settings.memoryKindsOff });
    if (!picked.entries.length) return undefined;
    for (const e of picked.entries) given.add(e.id);
    // When entries were last used only orders what goes first once memory is full: the turn does not wait for it.
    void this.deps.store.touch(picked.entries.map((e) => e.id)).catch(() => {});
    return search ? { ...picked, search: { ms: search.ms, ...(search.hits ? {} : { late: true as const }) } } : picked;
  }

  /** remember / recall / forget for the turn of `sessionId`. knownSecret: a secret the agent was handed this run is in the text. */
  async tool(sessionId: string, name: MemoryTool, rawArgs: unknown, opts: { knownSecret?(text: string): boolean } = {}): Promise<MemoryToolResult> {
    try {
      const settings = await this.deps.settings();
      const off = await this.offReason(sessionId, settings);
      if (off) return fail(`${OFF_TEXT[off]}: nothing was ${OFF_DONE[name]}. Go on without it; do not try again.`);
      if (name === "search_history") return await searchHistory(sessionId, rawArgs, { sessions: this.deps.sessions, ...this.clock() });
      if (name === "remember") return await this.remember(sessionId, rawArgs, settings.memoryKindsOff, opts.knownSecret);
      if (name === "recall") return await this.recall(sessionId, rawArgs, settings.memoryKindsOff);
      if (name === "check_similar") return await this.checkSimilar(sessionId, rawArgs, settings.memoryKindsOff);
      return await this.forget(sessionId, rawArgs);
    } catch (err) {
      return fail(err instanceof MemoryRefusal ? err.message : `${name} failed: ${errorMessage(err)}`);
    }
  }

  /**
   * What a repeating task's run leaves for its next runs: its note (what it posted, what is pending) and its output
   * (exactly what it published or sent; at most MAX_RUN_OUTPUT_CHARS, a longer one is cut). Nothing when the run is
   * not a task (a chat about one included), memory is off, or task history is turned off; a note that looks like a secret is refused, an output
   * that does is left out, and the chat says so.
   */
  async runNote(sessionId: string, note: string | undefined, opts: { output?: string | undefined; knownSecret?(text: string): boolean } = {}): Promise<void> {
    const run = this.runs.get(sessionId);
    let output = opts.output?.trim().slice(0, MAX_RUN_OUTPUT_CHARS).trim() || undefined;
    const text = note?.trim().slice(0, MAX_MEMORY_NOTE_CHARS) || (output ? NO_NOTE : "");
    if (!run?.taskKey || run.review || !text) return;
    const settings = await this.deps.settings();
    if ((await this.offReason(sessionId, settings)) || settings.memoryKindsOff.includes("task")) return;
    if (opts.knownSecret?.(text)) return void (await this.deps.sessions.note(sessionId, { type: "status", text: "Run note not saved: it held a password the agent was given" }));
    if (output && (opts.knownSecret?.(output) || secretProblem(output))) {
      output = undefined;
      await this.deps.sessions.note(sessionId, { type: "status", text: "The run's output was not kept: it looked like it held a password, code or key" });
      if (text === NO_NOTE) return;
    }
    try {
      const change = await this.deps.store.put(
        {
          kind: "task",
          subject: TASK_RUN_SUBJECT,
          text,
          scope: "task",
          taskKey: run.taskKey,
          ...(run.taskTitle ? { taskTitle: run.taskTitle } : {}),
          ...(output ? { output } : {}),
        },
        run.source,
        { note: true },
      );
      await this.noteChange(sessionId, change);
    } catch (err) {
      await this.deps.sessions.note(sessionId, { type: "status", text: `Run note not saved: ${errorMessage(err)}` });
    }
  }

  /**
   * A task was edited (update_scheduled_task): what was kept under its old instructions' hash (before tasks had a
   * series) moves to its series, so the edit does not cut it off from its history.
   */
  async taskEdited(before: MemoryTaskRef, after: MemoryTaskRef): Promise<void> {
    if (!after.seriesId) return;
    await this.deps.store.rekeyTask([memoryTaskKey(before.instructions, before.account)], seriesTaskKey(after.seriesId));
  }

  /**
   * The first turn of a task series here: what was kept under the older keys of its rows (their instructions' hash)
   * moves to the series' key. Marked done only when the series' rows were read (else tried again next turn).
   */
  private async adopt(task: MemoryTaskRef): Promise<void> {
    if (!task.seriesId) return;
    const to = seriesTaskKey(task.seriesId);
    try {
      if (await this.deps.store.adopted(to)) return;
      let rows: MemoryTaskRef[] = [];
      let complete = true;
      try {
        rows = (await this.deps.seriesTasks?.(task.seriesId)) ?? [];
      } catch {
        complete = false;
      }
      const from = [...new Set([task, ...rows].map((r) => memoryTaskKey(r.instructions, r.account)))];
      await this.deps.store.rekeyTask(from, to);
      if (complete) await this.deps.store.markAdopted(to);
    } catch {
      /* the turn goes on with what is kept under the series already */
    }
  }

  /** Settings > Memory and the chat's memory requests. */
  async handle<R extends MemoryRequest>(msg: R): Promise<UiResults[R["type"]]> {
    return (await this.dispatch(msg)) as UiResults[R["type"]];
  }

  private async dispatch(msg: MemoryRequest): Promise<UiResults[MemoryRequest["type"]]> {
    const store = this.deps.store;
    switch (msg.type) {
      case "memory.list": {
        // Settings opened: the account's changes first when it syncs (a failed sync still lists what is here).
        const sync = this.deps.sync ? await this.deps.sync.sync().catch(() => undefined) : undefined;
        return { entries: await store.list(), ...(sync ? { sync } : {}) };
      }
      case "memory.edit": {
        const id = requireText(msg.id, "id");
        const change = await store.edit(id, { subject: String(msg.subject ?? ""), text: String(msg.text ?? "") });
        return { entry: change.after! };
      }
      case "memory.delete":
        return { ok: !!(await store.forget(requireText(msg.id, "id"))) };
      case "memory.pin":
        return { entry: (await store.setPinned(requireText(msg.id, "id"), msg.pinned === true)).after! };
      case "memory.deleteTask":
        return { removed: await store.forgetTask(requireText(msg.taskKey, "taskKey")) };
      case "memory.taskRuns":
        return { runs: await this.taskRuns(msg.task) };
      case "memory.syncChoice": {
        if (!this.deps.sync) throw new Error("Memory does not sync in this build");
        return { sync: await this.deps.sync.choose(msg.add === true) };
      }
      case "memory.clear": {
        const removed = await store.clear();
        // The account forgets too; if it cannot now, the entries' deletions are still sent with the next sync.
        await this.deps.sync?.forgetAll().catch(() => undefined);
        return { removed };
      }
      case "memory.undo":
        return { ok: await this.undo(requireText(msg.sessionId, "sessionId"), requireText(msg.changeId, "changeId")) };
      case "chat.setMemory":
        return { session: await this.setChatMemory(requireText(msg.sessionId, "sessionId"), msg.on === true) };
    }
  }

  /** Undo on a "Remembered" note: the entry goes back to how it was before that change. Undoing twice is harmless. */
  async undo(sessionId: string, changeId: string): Promise<boolean> {
    const events = await this.deps.sessions.eventsOf(sessionId);
    const change = events.find((e) => e.type === "memory" && e.changeId === changeId);
    if (change?.type !== "memory") throw new Error("That memory change was not made in this chat");
    if (events.some((e) => e.type === "memory_undone" && e.changeId === changeId)) return true;
    const id = (change.after ?? change.before)!.id;
    await this.deps.store.restore(id, change.before);
    if (change.replaced) await this.deps.store.restore(change.replaced.id, change.replaced);
    await this.deps.sessions.note(sessionId, { type: "memory_undone", changeId });
    return true;
  }

  /** Memory on or off for one conversation (from its next turn; its tools at once). */
  async setChatMemory(sessionId: string, on: boolean): Promise<SessionInfo> {
    const s = await this.deps.sessions.update(sessionId, { memoryOff: on ? undefined : true });
    if (!s) throw new Error(`No session ${sessionId}`);
    return s;
  }

  /** Why memory is off for this conversation, or null when it is on. */
  private async offReason(sessionId: string, settings: Pick<ExtensionSettings, "memoryPaused">): Promise<keyof typeof OFF_TEXT | null> {
    if (settings.memoryPaused) return "paused";
    return (await this.deps.sessions.get(sessionId))?.memoryOff ? "chat" : null;
  }

  private async remember(sessionId: string, rawArgs: unknown, kindsOff: readonly MemoryKind[], knownSecret?: (text: string) => boolean): Promise<MemoryToolResult> {
    const parsed = RememberArgs.safeParse(rawArgs);
    if (!parsed.success) return fail(`remember arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`);
    const args = parsed.data;
    const run = this.runs.get(sessionId) ?? { source: { kind: "chat" as const, sessionId } };
    const settled = args.key === undefined ? settle(args, run) : settleRecord(args, run);
    if (typeof settled === "string") return fail(settled);
    const kind: MemoryKind = "key" in settled ? (settled.taskKey ? "task" : "record") : settled.kind;
    if (kindsOff.includes(kind)) return fail(`Not saved: the user turned off ${MEMORY_KIND_TEXT[kind].label} in memory. Do not try again.`);
    if (knownSecret?.(`${args.key ?? ""}\n${args.subject ?? ""}\n${args.text}`)) return fail("Not saved: it contains a password you were given. Memory never keeps passwords.");
    if ("key" in settled && args.replaces) return fail("replaces is for facts, not records (drop key or replaces). Nothing was saved.");
    const change =
      "key" in settled ? await this.deps.store.putRecord(settled, run.source) : await this.deps.store.put(settled, run.source, args.replaces ? { replaces: args.replaces } : {});
    await this.noteChange(sessionId, change);
    const e = change.after!;
    if (e.key !== undefined) {
      const space = e.taskKey ? "this task's record" : "the record";
      const what = !change.before ? `Started ${space}` : e.notes?.length !== change.before.notes?.length || e.text !== change.before.text ? `Added a note to ${space}` : `Already in ${space}`;
      return { text: `${what} [${e.id}] for key ${e.subject}. The user sees it in the chat with Undo.` };
    }
    const replaced = change.replaced ? ` It replaces [${change.replaced.id}] ${change.replaced.subject}, whose value is kept as history.` : "";
    return { text: `${change.before ? "Updated" : "Remembered"} [${e.id}] ${e.subject}.${replaced} The user sees it in the chat with Undo.` };
  }

  /**
   * A task's runs as its details show them (Previous runs): newest first, with its earlier-runs summary last. Also
   * what is still kept under its instructions' hash (not adopted by its series yet).
   */
  private async taskRuns(task: MemoryTaskRef): Promise<MemoryEntry[]> {
    const keys = new Set([memoryKeyOfTask(task), memoryTaskKey(task.instructions, task.account)]);
    const mine = (await this.deps.store.list()).filter((e) => !!e.taskKey && keys.has(e.taskKey));
    const runs = mine.filter(isTaskRun).sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));
    return [...runs, ...mine.filter(isEarlierRuns)];
  }

  /**
   * check_similar: the draft against what earlier runs put out, this task's (their outputs, else their notes) and the
   * user's other repeating tasks' (their outputs), with the account's meaning scores when memory syncs.
   */
  private async checkSimilar(sessionId: string, rawArgs: unknown, kindsOff: readonly MemoryKind[]): Promise<MemoryToolResult> {
    const parsed = CheckSimilarArgs.safeParse(rawArgs);
    if (!parsed.success) return fail(`check_similar needs draft: the exact text you are about to publish or send (${parsed.error.issues[0]?.message ?? "missing"})`);
    if (kindsOff.includes("task")) return fail("The user turned off Task history in memory, so there are no earlier outputs to compare with. Go on without it; do not try again.");
    const taskKey = this.runs.get(sessionId)?.taskKey ?? null;
    const runs = (await this.deps.store.list()).filter((e) => isTaskRun(e) && (e.taskKey === taskKey || !!e.output));
    if (!runs.length) {
      const where = taskKey ? "This task has no earlier outputs kept yet" : "No repeating task has kept an output yet";
      return { text: `${where}: nothing to compare with. Go ahead, and put the exact text that goes out in task_complete's output.` };
    }
    const semantic = (await this.semantic(parsed.data.draft, taskKey, MEMORY_SEARCH_TIMEOUT_MS))?.hits ?? undefined;
    return { text: similarAnswer(parsed.data.draft, runs, { taskKey, ...(semantic ? { semantic } : {}) }) };
  }

  private async recall(sessionId: string, rawArgs: unknown, kindsOff: readonly MemoryKind[]): Promise<MemoryToolResult> {
    const parsed = RecallArgs.safeParse(rawArgs);
    const { query, key } = parsed.success ? parsed.data : {};
    if (!query && !key) return fail("recall needs a query (words to look for) or a key (a record's identifier)");
    const taskKey = this.runs.get(sessionId)?.taskKey;
    const entries = await this.deps.store.list();
    if (key) {
      // The task's own record first, then the user's (each only while its kind is on).
      const usable = entries.filter((e) => !kindsOff.includes(e.kind));
      const record = recordFor(usable, taskKey ?? null, key);
      if (!record) return { text: `There is no record for key ${key} yet.` };
      await this.deps.store.touch([record.id]);
      return { text: `- ${memoryLine(record)}` };
    }
    const semantic = (await this.semantic(query!, taskKey ?? null, MEMORY_SEARCH_TIMEOUT_MS))?.hits;
    const found = recallMemory(entries, query!, { kindsOff, taskKey: taskKey ?? null, ...this.clock(), ...(semantic ? { semantic } : {}) });
    if (!found.length) return { text: `Nothing in memory matches "${query}".` };
    await this.deps.store.touch(found.map((e) => e.id));
    // Recall is asked for: a fact's earlier values come with it.
    return { text: found.map((e) => `- ${memoryLine(e, { history: true })}`).join("\n") };
  }

  private async forget(sessionId: string, rawArgs: unknown): Promise<MemoryToolResult> {
    const parsed = ForgetArgs.safeParse(rawArgs);
    if (!parsed.success) return fail("forget needs the entry's id");
    const id = parsed.data.id.replace(/^\[|\]$/g, "");
    const change = await this.deps.store.forget(id);
    if (!change) return fail(`No memory entry ${id}.`);
    await this.noteChange(sessionId, change);
    return { text: `Forgot [${id}] ${change.before!.subject}. The user sees it in the chat with Undo.` };
  }

  /** Now and the user's time zone, for time words ("yesterday", "last spring"). */
  private clock(): { now: Date; offsetMinutes: number } {
    const now = this.deps.now?.() ?? new Date();
    return { now, offsetMinutes: -now.getTimezoneOffset() };
  }

  /** The account's semantic scores for `query`, or null (none, failed, or later than MEMORY_SEARCH_TIMEOUT_MS). */
  /**
   * The account's semantic search for a turn, given at most timeoutMs: its hits (null when it failed or came too
   * late) and how long the turn waited for it. Null when memory does not sync.
   */
  private async semantic(query: string, taskKey: string | null, timeoutMs: number): Promise<{ hits: ReadonlyMap<string, number> | null; ms: number } | null> {
    if (!this.deps.semantic) return null;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)));
    try {
      const hits = await Promise.race([this.deps.semantic(query, taskKey).catch(() => null), late]);
      return { hits, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The chat's note of a change, with its Undo. */
  private async noteChange(sessionId: string, change: MemoryChange): Promise<void> {
    const changeId = this.deps.newChangeId?.() ?? crypto.randomUUID();
    await this.deps.sessions.note(sessionId, { type: "memory", changeId, before: change.before, after: change.after, ...(change.replaced ? { replaced: change.replaced } : {}) });
  }
}

const fail = (text: string): MemoryToolResult => ({ text, isError: true });

function requireText(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
  return v;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 80);
}

/**
 * The record remember with a key files the fact in, under the normalized key: in a repeating task its own records
 * (unless kind record asks for the user's), in a chat the user's; or why it cannot.
 */
function settleRecord(args: RememberArgs, run: { taskKey?: string; taskTitle?: string }): NewRecord | string {
  if (args.scope === "domain" || args.domain) return "key files the fact in a record, which belongs to no site: drop domain, or drop key to save a site's playbook. Nothing was saved.";
  const key = memoryRecordKey(args.key!);
  if (!key) return `key "${args.key}" has no letters or digits: give the identifier itself (an address, an ID, a name). Nothing was saved.`;
  const keyAsWritten = args.key!.trim().slice(0, MAX_MEMORY_SUBJECT_CHARS);
  const space = run.taskKey && args.kind !== "record" ? { taskKey: run.taskKey, ...(run.taskTitle ? { taskTitle: run.taskTitle } : {}) } : {};
  return { ...space, key, keyAsWritten, ...(args.subject ? { subject: args.subject } : {}), text: args.text };
}

/** The entry remember keeps: its scope and place settled from the arguments and the turn, or why it cannot be kept. */
function settle(args: RememberArgs, run: { taskKey?: string; taskTitle?: string }): NewMemory | string {
  if (args.kind === "record") return "kind record files a fact under an identifier: give key (the ticket, order, email or name it is about). Nothing was saved.";
  if (!args.subject) return "subject is required (a short name for what it is about). Nothing was saved.";
  const domain = args.domain === undefined ? undefined : memoryDomain(args.domain);
  if (domain === null) return `domain "${args.domain}" is not a site's host (e.g. mail.google.com). Nothing was saved.`;
  if (args.kind === "playbook" && !domain) return "A playbook is for one site: give its domain (e.g. mail.google.com). Nothing was saved.";
  const scope: MemoryScope = args.scope ?? (args.kind === "task" ? "task" : domain ? "domain" : "global");
  if (scope === "domain" && !domain) return "scope domain needs domain (the site's host). Nothing was saved.";
  if ((scope === "task" || args.kind === "task") && !run.taskKey) {
    return "There is no repeating task here (this is a chat), so there is no task history to add to: use another kind, or leave it. Nothing was saved.";
  }
  const m: NewMemory = { kind: args.kind, subject: args.subject, text: args.text, scope: args.kind === "task" ? "task" : scope };
  if (domain && m.scope === "domain") m.domain = domain;
  if (domain && m.scope === "global") return `domain is only for scope domain; drop it or use scope domain. Nothing was saved.`;
  if (m.scope === "task") {
    m.taskKey = run.taskKey!;
    if (run.taskTitle) m.taskTitle = run.taskTitle;
  }
  return m;
}
