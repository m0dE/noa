/**
 * Running one turn of a session in its agent slot: the first turn of a new
 * session (tab, media, brain), the brain's run with its safety timer, the
 * brain's events into the session, and the checks on the result (X post
 * verification, failure classification). Next turns: conversation.ts.
 */
import { automationPromptLine, bareToolName, effectiveLevel, errorMessage, isXStatusUrl, localTimeZone, traceStart, TURN_WALL_MINUTES, type AgentEvent, type AgentTask, type AttachmentRef, type ExtensionSettings, type RunConfig, type SessionInfo, type Sleep, type TaskAbout, type TaskRunResult, type TraceCategory, type TraceValue, type UserTab } from "@noa/shared";
import type { AgentSlot } from "../../agent-slots.js";
import { bytesToBase64 } from "../../base64.js";
import type { AttachmentStore } from "../attachment-store.js";
import { SessionEndedError, type Brain, type BrainRun, type ContinuableBrain, type CoreApi, type TurnAttachment } from "../brains.js";
import type { LocalStore } from "../local-store.js";
import type { MaterializedMedia, MediaSource } from "../media-files.js";
import type { SessionStore } from "../sessions.js";
import type { TabChatsLike } from "../../tab-chats.js";
import { asksAboutThePage, isRestrictedUrl, RESTRICTED_STATUS } from "../../restricted.js";
import type { ForcedStop } from "./active.js";
import { timeLimitReached, verifySnippet } from "@noa/core";
import { ABORT_GRACE_MS, ActiveClock, safetyTimeoutMinutes } from "./deadline.js";
import { mediaSources, type FirstJob } from "./jobs.js";
import type { MemoryRun, MemoryService } from "../../memory/service.js";
import type { JobReview } from "../task-review.js";

/** Said in the thread when a conversation's tab could not be used and it moved to a new one. */
export const MOVED_TAB_STATUS = "That tab cannot be controlled (a browser page) or another run is using it: working in a new tab next to it";

/** A session running right now. */
export interface ActiveSession {
  session: SessionInfo;
  /** The agent slot (tab) the session acts in. */
  slot: AgentSlot;
  run: BrainRun | null;
  /** Set when the runner stopped the session (Stop, a pause URL, ...): the outcome it ends with. */
  forced: ForcedStop | null;
  /** Texts the user typed, to drop the brain's echo of them. */
  said: string[];
  /** Messages the user sent before the brain's run started: the run gets them the moment it does (drive). */
  waiting: string[];
  /** The brain's run of this turn is over (the session is closing): messages now open the next turn. */
  runOver: boolean;
  /** Messages the user sent once the run was over: they open the next turn when the session has ended. */
  nextTurn: QueuedMessage[];
  /** Texts the agent typed or pasted into the page; the longest is the post body to verify. */
  typed: string[];
  /** The X post this turn's check found with the text the agent typed (its URL): the evidence that the task's post is out. */
  verifiedPost?: string;
  /** It acts as an X account: it holds the X turn while it runs. */
  x: boolean;
  /** A due task run by the loop (counts toward maxParallelTasks). */
  scheduled: boolean;
  /** Local task id, while its run is on. */
  localTaskId: string | null;
  /** The instructions the agent got this turn (scheduled runs: approvals hold what they do not ask for). */
  instructions?: string;
  /** The account the task acts as (scheduled runs: an X handle names X as the task's site). */
  account?: string | null;
  /** A due task whose instructions the agent wrote (Task.agentAuthored): its run is held like ask_consequential. */
  agentAuthored?: boolean;
  /** Files sent with this turn's message (stored in the conversation's attachments). */
  attachments?: AttachmentRef[];
  /** When the turn's wall-time ceiling ends it (epoch ms, TURN_WALL_MINUTES): an approval waits at most until shortly before. */
  turnEndsAt?: number;
  /**
   * Ends the approvals waiting now (approval/gate.ts GateContext.interrupt): aborted with "stop" when the session
   * is stopped, with "message" when the user writes to the agent (then replaced, for the approvals after it).
   */
  approvals: AbortController;
}

/** A message waiting for the next turn; voice: it was spoken; context: told to the agent with it (see withContext). */
export interface QueuedMessage {
  text: string;
  voice: boolean;
  /** Spoken: the user's words for it, word for word (the user_message event's heard). */
  heard?: string[];
  context?: string;
}

/** The automation level's line for the agent's prompt this turn (automation.ts). */
export function approvalsLine(settings: ExtensionSettings, run: Pick<ActiveSession, "scheduled" | "agentAuthored">): string {
  return automationPromptLine(effectiveLevel(settings, run));
}

export type Cleanup = () => void | Promise<void>;

/** Runs every cleanup; each is best effort. */
export async function runCleanups(cleanups: Cleanup[]): Promise<void> {
  for (const fn of cleanups) {
    try {
      await fn();
    } catch {
      /* cleanup is best effort */
    }
  }
}

/** Collects text the agent entered from a tool_call event (type, paste, act steps). */
export function typedTextsOf(e: AgentEvent): string[] {
  if (e.type !== "tool_call") return [];
  const args = (e.args ?? {}) as { text?: unknown; steps?: { text?: unknown }[] };
  const name = bareToolName(e.name);
  if ((name === "type" || name === "paste") && typeof args.text === "string") return [args.text];
  if (name === "act" && Array.isArray(args.steps)) {
    return args.steps.map((s) => s?.text).filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  }
  return [];
}

/** The model setting, when one is set (both brains use it). */
export function modelOf(settings: ExtensionSettings): string | undefined {
  return settings.anthropicModel.trim() || undefined;
}

export function runConfig(settings: ExtensionSettings, isRetry: boolean): RunConfig {
  const config: RunConfig = {
    maxToolCalls: settings.maxToolCalls,
    // The brains' own timer is the wall ceiling; the user's limit counts active time, enforced by drive() (turn-time.ts).
    maxTaskMinutes: TURN_WALL_MINUTES,
    jevEnabled: settings.jevEnabled,
    jevThreshold: settings.jevThreshold,
    reasoning: settings.reasoning,
    reasoningAutoRaise: settings.reasoningAutoRaise,
    isRetry,
  };
  if (settings.jevApiKey) config.jevApiKey = settings.jevApiKey;
  // One model setting for both brains (the API brain also reads it from settings).
  const model = modelOf(settings);
  if (model) config.model = model;
  return config;
}

/** A browser tab as chrome.tabs reports it. */
export interface TabPage {
  tabId: number;
  url: string;
  title: string;
}

export interface TurnDeps {
  sessions: SessionStore;
  /** Which browser tab each conversation belongs to (absent: conversations have no tab). */
  tabChats?: TabChatsLike;
  localStore: LocalStore;
  media: { materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> };
  core: Pick<CoreApi, "verifyXPost" | "classifyFailure">;
  /**
   * The id, address and title of a browser tab (no tabId: the tab the user is
   * looking at), from chrome.tabs, which works on every page. Absent: not known.
   */
  pageOf?(tabId?: number): Promise<TabPage | null>;
  /** The agent's long-term memory: what each turn is given at its start (absent: none). */
  memory?: Pick<MemoryService, "begin">;
  /** The files sent in chats (absent: none). */
  attachments?: Pick<AttachmentStore, "list">;
  /** A chat about a scheduled job: the job as it is now, for the agent and for memory (task-review.ts; absent: not told). */
  review?(about: TaskAbout): Promise<JobReview>;
  /** The post check's waits for X to show the post (tests skip real time). */
  sleep?: Sleep;
  log(message: string): void;
}

export class TurnRunner {
  constructor(private readonly deps: TurnDeps) {}

  /** Appends an event to the session's thread. */
  emit(active: ActiveSession, e: AgentEvent): void {
    this.deps.sessions.append(active.session.sessionId, e);
  }

  /** Runs `work` and records how long it took in the conversation's trace (also when it throws). */
  async timed<T>(active: ActiveSession, name: string, work: () => Promise<T>, data: Record<string, TraceValue> = {}, cat: TraceCategory = "turn"): Promise<T> {
    const span = traceStart();
    try {
      return await work();
    } finally {
      this.emit(active, { type: "trace", trace: { t: span.t, ms: span.elapsed(), cat, name, src: "engine", data } });
    }
  }

  /** Picks the turn's tab and attaches the debugger (timed: engine.tab). */
  prepareTab(active: ActiveSession, opts: Parameters<ActiveSession["slot"]["prepare"]>[0]): Promise<number> {
    return this.timed(active, "engine.tab", () => active.slot.prepare(opts), { mode: opts.mode ?? "own-tab" });
  }

  /**
   * The first turn of a new session: picks its tab, writes its files, starts
   * the brain and waits for the result. One-off runs act on the tab they were
   * started from (or, without one, the tab the user is looking at); other
   * jobs on the slot's own tab.
   */
  async runFirst(
    active: ActiveSession,
    job: FirstJob,
    brain: Brain,
    opened: { task: AgentTask; seriesId?: string; isRetry: boolean },
    settings: ExtensionSettings,
    cleanups: Cleanup[],
  ): Promise<TaskRunResult> {
    const adhoc = job.source === "adhoc";
    const origin = adhoc ? job.input.tabId : undefined;
    // The tab the user sent it from (no origin: the one they are looking at). It may be a page Chrome keeps
    // extensions out of: the run still starts, in a tab next to it.
    const page = adhoc ? await this.pageOf(origin) : null;
    const restricted = !!page && isRestrictedUrl(page.url);
    // Said in the chat only when the request is about that page (the agent is told either way).
    const sayRestricted = restricted && asksAboutThePage(opened.task.instructions, adhoc && !!job.input.screen);
    // A chat about a scheduled job: the job as it is now (read while the tab is made ready).
    const reviewReady = adhoc && job.input.about ? this.reviewOf(active, job.input.about) : null;
    // What memory gives the turn is picked while its tab and files are made ready (it may wait on the account's search).
    // A TODO or cloud task keeps its run notes in memory; a one-off chat has none; a chat about a job is given the job's.
    const memoryRun = (review: JobReview | null): MemoryRun => ({
      ...(adhoc
        ? review?.task
          ? { task: review.task, review: true }
          : {}
        : { task: { instructions: opened.task.instructions, account: opened.task.account, seriesId: opened.seriesId } }),
      title: active.session.title,
      request: opened.task.instructions,
      ...(page ? { tabUrl: page.url, tabTitle: page.title } : {}),
    });
    const memoryReady = reviewReady ? reviewReady.then((r) => this.memoryFor(active, memoryRun(r))) : this.memoryFor(active, memoryRun(null));
    const config = runConfig(settings, opened.isRetry);
    // Meanwhile the agent starts too: its process is ready when the task (with its memory) is.
    brain.prewarm?.(config);
    let picked: number;
    if (origin === undefined) {
      picked = await this.prepareTab(active, { mode: adhoc ? "current-tab" : "own-tab" });
      if (sayRestricted) this.emit(active, { type: "status", text: RESTRICTED_STATUS });
    } else {
      // Not brought to the front: the user may have moved on to another tab already.
      picked = await this.prepareTab(active, { mode: "current-tab", tabId: origin });
      await this.follow(active, origin, picked, restricted, sayRestricted);
    }
    // The agent is told which page the user is looking at (buildTaskPrompt); scheduled and TODO tasks have none.
    const shown: AgentTask = page ? { ...opened.task, userTab: userTabOf(page, picked) } : opened.task;
    // A chat about a job: the request comes with the job and how to go over it (the chat shows the user's words alone).
    const review = reviewReady ? await reviewReady : null;
    const task: AgentTask = review ? { ...shown, instructions: `${shown.instructions}\n\n${review.text}` } : shown;
    const sources = await mediaSources(job, this.deps.localStore);
    if (sources.length) this.emit(active, { type: "status", text: `Preparing ${sources.length} file(s)` });
    const mediaPaths = await this.materialize(active, sources, cleanups);
    const attachments = await this.attachmentsFor(active, brain, cleanups);
    if (active.forced) throw new Error(active.forced.reason);
    const memory = await this.timed(active, "memory.wait", () => memoryReady);
    const run = this.start(active, brain, { task: memory ? { ...task, memory } : task, mediaPaths, attachments, config, settings });
    return this.drive(active, run, settings, cleanups);
  }

  /** The scheduled job a chat is about, as it is now (timed: review.read); null when nobody can read it here. */
  reviewOf(active: ActiveSession, about: TaskAbout): Promise<JobReview> | null {
    const read = this.deps.review;
    return read ? this.timed(active, "review.read", () => read(about)) : null;
  }

  /**
   * What the agent is given from memory this turn (undefined: memory is off, or nothing applies), recorded in the
   * trace (memory.inject: how long picking took; memory.given: how many entries and tokens). Memory never stops a
   * turn: a failure is logged. Callers start it early and await it just before the brain starts (memory.wait: how
   * long the turn's start still waited for it).
   */
  async memoryFor(active: ActiveSession, run: MemoryRun): Promise<string | undefined> {
    if (!this.deps.memory) return undefined;
    try {
      const picked = await this.timed(active, "memory.inject", () => this.deps.memory!.begin(active.session.sessionId, run));
      if (picked) {
        // The account's search: how long the turn waited for it, and whether it went on without it.
        const search = picked.search ? { searchMs: picked.search.ms, ...(picked.search.late ? { searchLate: true } : {}) } : {};
        const data = { entries: picked.entries.length, tokens: picked.tokens, continued: !!run.continued, ...search };
        this.emit(active, { type: "trace", trace: { t: Date.now(), cat: "turn", name: "memory.given", src: "engine", data } });
      }
      return picked?.text || undefined;
    } catch (err) {
      this.deps.log(`memory for ${active.session.sessionId} failed: ${errorMessage(err)}`);
      return undefined;
    }
  }

  /** The browser tab a conversation belongs to, or null. */
  async tabOf(sessionId: string): Promise<number | null> {
    return this.deps.tabChats ? this.deps.tabChats.tabOf(sessionId).catch(() => null) : null;
  }

  /** A browser tab's id, address and title (no tabId: the one the user is looking at), or null when not known. */
  async pageOf(tabId?: number): Promise<TabPage | null> {
    return (await this.deps.pageOf?.(tabId).catch(() => null)) ?? null;
  }

  /**
   * The conversation's run went to another tab than its own (e.g. its tab
   * shows a chrome:// page): it now belongs there. restricted: the reason was
   * a page Chrome keeps extensions out of; say: say so in a quiet line (the
   * request is about that page, asksAboutThePage).
   */
  async follow(active: ActiveSession, origin: number, picked: number, restricted = false, say = restricted): Promise<void> {
    if (picked === origin) return;
    if (restricted && say) this.emit(active, { type: "status", text: RESTRICTED_STATUS });
    if (!this.deps.tabChats) return;
    if (!restricted) this.emit(active, { type: "status", text: MOVED_TAB_STATUS });
    await this.bindChat(picked, active.session.sessionId);
  }

  /** The conversation now belongs to this browser tab (the side panel shows it there). A failure is logged, not thrown. */
  async bindChat(tabId: number, sessionId: string): Promise<void> {
    await this.deps.tabChats?.bind(tabId, sessionId).catch((err: unknown) => this.deps.log(`binding the chat to tab ${tabId} failed: ${errorMessage(err)}`));
  }

  /** Writes the files to disk for the brain; they are deleted with the cleanups. */
  async materialize(active: ActiveSession, sources: MediaSource[], cleanups: Cleanup[]): Promise<string[]> {
    const materialize = () => this.deps.media.materialize(active.session.sessionId, sources);
    const media = sources.length ? await this.timed(active, "engine.media", materialize, { files: sources.length }) : await materialize();
    cleanups.push(() => media.cleanup());
    return media.paths;
  }

  /**
   * The conversation's files for this turn's brain (fresh: sent with this turn's message). A brain that does not
   * keep them itself gets each written to Downloads for upload (deleted when the turn ends), and a fresh image's
   * or PDF's bytes to send to the model.
   */
  async attachmentsFor(active: ActiveSession, brain: Brain, cleanups: Cleanup[]): Promise<TurnAttachment[]> {
    const sessionId = active.session.sessionId;
    const records = (await this.deps.attachments?.list(sessionId)) ?? [];
    if (!records.length) return [];
    const fresh = new Set((active.attachments ?? []).map((r) => r.id));
    const list: TurnAttachment[] = records.map(({ ref: { thumb: _thumb, ...ref }, blob, text }) => ({
      ref,
      fresh: fresh.has(ref.id),
      blob,
      ...(text === undefined ? {} : { text }),
    }));
    if (brain.keepsAttachments) return list;
    const files = list.map((a) => ({ kind: "blob" as const, name: a.ref.name, blob: a.blob }));
    const media = await this.timed(active, "engine.attachments", () => this.deps.media.materialize(sessionId, files), { files: files.length });
    cleanups.push(() => media.cleanup());
    return withBytes(
      list.map((a, i) => ({ ...a, path: media.paths[i]! })),
      (a) => a.fresh,
    );
  }

  /**
   * A fresh agent session for a conversation that had files (its earlier session is gone): it has not seen the
   * earlier images and PDFs either, so they go along too (brains that keep files themselves read them anew).
   */
  async forFreshSession(brain: Brain, attachments: TurnAttachment[]): Promise<TurnAttachment[]> {
    return brain.keepsAttachments ? attachments : withBytes(attachments, () => true);
  }

  /** Starts the brain on a task in the session's tab. */
  start(
    active: ActiveSession,
    brain: Brain,
    opts: { task: AgentTask; mediaPaths: string[]; attachments?: TurnAttachment[]; config: RunConfig; settings: ExtensionSettings },
  ): BrainRun {
    this.mark(active, "brain.start", { brain: brain.kind, fresh: true, chars: opts.task.instructions.length });
    active.instructions = opts.task.instructions;
    active.account = opts.task.account;
    const approvals = opts.task.approvals ?? approvalsLine(opts.settings, active);
    return brain.start({
      sessionId: active.session.sessionId,
      ...opts,
      // The agent is told the user's date and time in their zone (schedule_task's relative times), and what waits for approval.
      task: { ...opts.task, timeZone: opts.task.timeZone ?? localTimeZone(), ...(approvals ? { approvals } : {}) },
      browser: active.slot.browser,
      onEvent: (e) => this.onBrainEvent(active, e),
    });
  }

  /** The next turn in the conversation's own agent session (the brain has continue()). */
  continue(active: ActiveSession, brain: ContinuableBrain, opts: { text: string; attachments?: TurnAttachment[]; config: RunConfig; settings: ExtensionSettings }): BrainRun {
    this.mark(active, "brain.start", { brain: brain.kind, fresh: false, chars: opts.text.length });
    return brain.continue({
      sessionId: active.session.sessionId,
      ...opts,
      browser: active.slot.browser,
      onEvent: (e) => this.onBrainEvent(active, e),
    });
  }

  /** A moment in the conversation's trace. */
  mark(active: ActiveSession, name: string, data: Record<string, TraceValue>): void {
    this.emit(active, { type: "trace", trace: { t: Date.now(), cat: "brain", name, src: "engine", data } });
  }

  /**
   * Waits for the brain's result (safety timer included). A stop or pause
   * URL that landed while the brain was starting is passed on. throwEnded:
   * let SessionEndedError through (continue path).
   */
  async drive(active: ActiveSession, run: BrainRun, settings: ExtensionSettings, cleanups: Cleanup[], throwEnded = false): Promise<TaskRunResult> {
    active.run = run;
    active.turnEndsAt = Date.now() + TURN_WALL_MINUTES * 60_000;
    const forced = active.forced;
    if (forced) run.abort(forced.reason, forced.outcome);
    // What the user said while the run was starting (already in the thread; the brain's echo is dropped).
    for (const text of active.waiting.splice(0)) {
      active.said.push(text);
      void run.sendUserMessage(text).then((ok) => ok || this.deps.log(`the agent did not take a message sent while it started (${active.session.sessionId})`));
    }
    try {
      return await withTimeLimits(run, active.slot, settings, cleanups, throwEnded);
    } finally {
      if (active.run === run) active.run = null;
    }
  }

  /** Verification and failure classification (pipeline steps 4-5). */
  async check(active: ActiveSession, result: TaskRunResult): Promise<TaskRunResult> {
    if (result.outcome === "done" && result.url && isXStatusUrl(result.url) && !active.forced) {
      this.emit(active, { type: "status", text: "Verifying the post" });
      let ok = false;
      let detail = "";
      // Compare against what the agent actually entered, not the whole instructions.
      const expected = active.typed.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), "");
      try {
        // The post must be the task's account's own (a follow-up turn in the same session knows it from the session).
        const account = active.account ?? active.session.account;
        const v = await this.deps.core.verifyXPost(active.slot.browser, result.url, expected, account, this.deps.sleep ? { sleep: this.deps.sleep } : {});
        ok = v.ok;
        detail = v.detail;
      } catch (err) {
        detail = errorMessage(err);
      }
      if (!ok) {
        this.emit(active, { type: "status", text: `Post not verified: ${detail}` });
        // The agent's follow-up and spoken line assumed the post went out: neither is offered.
        const { suggestion: _unverified, spoken: _unverifiedLine, ...unverified } = result;
        return { ...unverified, outcome: "retry", reason: `could not verify the post${detail ? `: ${detail}` : ""}` };
      }
      this.emit(active, { type: "status", text: "Post verified" });
      // Found with its text (not only opened: a check with nothing typed to compare proves no post of this task).
      if (verifySnippet(expected)) active.verifiedPost = result.url;
    }
    if (result.outcome === "failed" && result.reason && !active.forced) {
      let kind: string = "permanent";
      try {
        kind = this.deps.core.classifyFailure(result.reason);
      } catch (err) {
        this.deps.log(`classifyFailure failed: ${errorMessage(err)}`);
      }
      if (kind === "transient") return { ...result, outcome: "retry" };
    }
    return result;
  }

  private onBrainEvent(active: ActiveSession, e: AgentEvent): void {
    // The runner emits the one final task_end after verification and classification.
    if (e.type === "task_end") return;
    active.typed.push(...typedTextsOf(e));
    if (e.type === "user_message") {
      const i = active.said.indexOf(e.text.trim());
      if (i >= 0) {
        active.said.splice(i, 1);
        return;
      }
    }
    this.emit(active, e);
  }
}

/** The user's tab as the agent is told about it, once the run's tab was picked (`picked`: where the run works). */
export function userTabOf(page: TabPage, picked: number): UserTab {
  const access = isRestrictedUrl(page.url) ? "restricted" : picked === page.tabId ? "here" : "elsewhere";
  return { url: page.url, title: page.title, access };
}

/**
 * The brain's result, or the turn stopped by its limits: the user's time limit in active time (the slot's waits
 * left out, ActiveClock), and the safety timer on wall time. Either aborts the brain and waits ABORT_GRACE_MS for
 * its result.
 */
function withTimeLimits(run: BrainRun, slot: AgentSlot, settings: ExtensionSettings, cleanups: Cleanup[], throwEnded: boolean): Promise<TaskRunResult> {
  const minutes = safetyTimeoutMinutes();
  const safety = new Promise<TaskRunResult>((resolve) => {
    let stopped = false;
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = true;
      run.abort(reason, "failed");
      const t2 = setTimeout(() => resolve({ outcome: "failed", reason }), ABORT_GRACE_MS);
      cleanups.push(() => clearTimeout(t2));
    };
    const clock = new ActiveClock(settings.maxTaskMinutes * 60_000, () => stop(timeLimitReached(settings.maxTaskMinutes)));
    const unwatch = slot.onWait(() => clock.wait());
    const t1 = setTimeout(() => stop(`No result after ${minutes} minutes`), minutes * 60_000);
    cleanups.push(() => clearTimeout(t1), () => clock.stop(), unwatch);
  });
  const done = run.done.catch((err: unknown): TaskRunResult => {
    if (throwEnded && err instanceof SessionEndedError) throw err;
    return { outcome: "failed", reason: errorMessage(err) };
  });
  return Promise.race([done, safety]);
}

/** The attachments, with the bytes (base64) of each image or PDF that `send` picks, for the model to see. */
function withBytes(attachments: TurnAttachment[], send: (a: TurnAttachment) => boolean): Promise<TurnAttachment[]> {
  return Promise.all(
    attachments.map(async (a) =>
      a.base64 === undefined && send(a) && (a.ref.kind === "image" || a.ref.kind === "pdf") ? { ...a, base64: bytesToBase64(new Uint8Array(await a.blob.arrayBuffer())) } : a,
    ),
  );
}
