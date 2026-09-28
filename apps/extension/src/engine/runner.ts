/**
 * The run pipeline (spec "Run pipeline"): pick due tasks (local first, then
 * cloud claims), resolve the brain, materialize media, run, verify, record,
 * pace. Also runs one-off "do this now" sessions and the follow-up turns of a
 * conversation (message()).
 *
 * Several sessions can run at once, each in its own agent slot (tab): up to
 * maxParallelTasks due tasks, plus one-off runs and conversation turns beside
 * them. X tasks take turns (see run/scheduling.ts).
 *
 * The Runner is the public API; the work lives in run/: due-loop.ts (the
 * due loop), failure-policy.ts (failures in a row, pausing), lifecycle.ts
 * (a session from open to finish), jobs.ts (where work comes from),
 * scheduling.ts (slots, X turn, pacing), active.ts (the running sessions,
 * what they hold, stopping them), turn.ts (a session's first turn, the brain
 * run and its checks), conversation.ts (next turns), record.ts (results),
 * state.ts (persisted state, keep-alive), deadline.ts (how long a run may take).
 */
import { effectiveLevel, errorMessage, FILES_WHILE_RUNNING, pauseReasonForUrl, SCREEN_HELP_TEXT, traceStart, type ExtensionSettings, type SessionInfo, type Sleep, type TraceValue } from "@noa/shared";
import type { SlotPool } from "../agent-slots.js";
import { callSafely } from "../listeners.js";
import type { TabChatsLike } from "../tab-chats.js";
import type { BrainStatus, MessageMode } from "../ui-protocol.js";
import { autoSwitchRefusal, NO_AI } from "./brain-resolver.js";
import type { Brain, CoreApi } from "./brains.js";
import type { StorageLike } from "./kv.js";
import type { LocalStore } from "./local-store.js";
import type { MaterializedMedia, MediaSource } from "./media-files.js";
import type { AttachmentStore, IncomingAttachment } from "./attachment-store.js";
import type { SessionStore } from "./sessions.js";
import { ActiveSessions, approvalStop, pauseUrlStop, stopOf } from "./run/active.js";
import { CONTINUE_TEXT, continueRefusal } from "./run/conversation.js";
import { DueLoop } from "./run/due-loop.js";
import { FailurePolicy } from "./run/failure-policy.js";
import { turnJob, withContext, type AdhocInput, type FirstJob, type RunnerApi, type TurnJob } from "./run/jobs.js";
import { Lifecycle, type RunBrain } from "./run/lifecycle.js";
import { ResultRecorder } from "./run/record.js";
import { KeepAlive, RunnerStateStore, type RunnerState } from "./run/state.js";
import { TurnRunner, type ActiveSession, type TabPage } from "./run/turn.js";
import type { GateContext } from "../approval/gate.js";
import type { MemoryService } from "../memory/service.js";
import type { EpisodeWriter } from "../memory/episodes.js";
import type { ChatTitler } from "./chat-titles.js";

export interface ResolvedBrain {
  brain: Brain | null;
  status: BrainStatus;
}

export interface RunnerDeps {
  loadSettings(): Promise<ExtensionSettings>;
  getRunnerId(): Promise<string>;
  /**
   * The signed-in account's task queue (claim/heartbeat/result with the
   * session token), or null when signed out.
   */
  accountApi?(): Promise<RunnerApi | null>;
  /**
   * Why the due loop does not claim the account's tasks now, or null: the old pause of every scheduled run is not
   * converted into paused jobs yet (pause-migration.ts). Local tasks still run.
   */
  accountQueueHold?(): Promise<string | null>;
  /** The hosted AI has no usage credit left (the due loop starts nothing on it; the side panel says so with Top up). */
  outOfCredit?(): boolean;
  /** Pauses a job's waiting run after its runs kept failing (TodoSource.holdSeries of this browser's or the account's list). */
  holdSeries?(source: "local" | "cloud", seriesId: string, reason: string): Promise<boolean>;
  /** Resumes a job's rows paused after its runs kept failing, except `except` (TodoSource.releaseHold of the account's list). */
  releaseHold?(source: "local" | "cloud", seriesId: string, except?: string): Promise<string[]>;
  localStore: LocalStore;
  sessions: SessionStore;
  /** A browser tab's id, address and title (no tabId: the tab the user is looking at); see TurnDeps.pageOf. */
  pageOf?(tabId?: number): Promise<TabPage | null>;
  /** The agent's long-term memory: given at each turn's start, and a repeating task's run note at its end. */
  memory?: Pick<MemoryService, "begin" | "runNote">;
  /** The background memory writer: a conversation's episode and new facts, after it ends or goes idle. */
  episodes?: Pick<EpisodeWriter, "ended">;
  /** Chat titles: the model names a chat after its turns (chat-titles.ts). */
  titles?: Pick<ChatTitler, "ended">;
  media: { materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> };
  /** Where the files sent in chats are kept (absent: messages with files are refused). */
  attachments?: Pick<AttachmentStore, "add" | "list">;
  /** Resolves the brain for these settings; may (re)connect the helper. */
  resolveBrain(settings: ExtensionSettings): Promise<ResolvedBrain>;
  core: Pick<CoreApi, "verifyXPost" | "classifyFailure">;
  /** Agent slots: each running session gets its own tab. */
  slots: SlotPool;
  /**
   * Which browser tab each conversation belongs to (TabChats). A one-off run
   * started from a tab is bound to it, and a conversation's next turns act there.
   */
  tabChats?: TabChatsLike;
  notify(title: string, message: string): void | Promise<void>;
  /** Whether the user has this conversation open in a side panel now (a scheduled run's approvals can then be answered). */
  watching?(sessionId: string): Promise<boolean>;
  /** Called every KEEP_ALIVE_MS while busy (chrome.runtime.getPlatformInfo). */
  keepAlive(): unknown;
  /** Something the UI shows changed (running sessions, pause, errors). */
  onStateChange?(): void;
  storage?: StorageLike;
  sleep?: Sleep;
  now?(): Date;
  newId?(): string;
  log?(message: string): void;
}

export class Runner {
  /** Sessions running right now, and the slots, X turn and local tasks they hold. */
  private readonly live: ActiveSessions;
  /** Every job in flight (the due loop's and one-off ones). */
  private readonly jobs = new Set<Promise<unknown>>();
  /** Conversations whose next turn is starting, until its session exists (a message for it then goes into it). */
  private readonly startingTurns = new Map<string, Promise<unknown>>();
  private reservations = 0;
  private readonly keepAlive: KeepAlive;
  private readonly runnerState: RunnerStateStore;
  private readonly turns: TurnRunner;
  private readonly lifecycle: Lifecycle;
  private readonly policy: FailurePolicy;
  private readonly dueLoop: DueLoop;

  constructor(private readonly deps: RunnerDeps) {
    const log = (m: string) => this.log(m);
    const now = () => this.now();
    const changed = () => this.changed();
    this.live = new ActiveSessions(deps.slots);
    this.keepAlive = new KeepAlive(() => deps.keepAlive());
    this.runnerState = new RunnerStateStore(() => deps.storage ?? chrome.storage.local);
    this.turns = new TurnRunner({
      sessions: deps.sessions,
      localStore: deps.localStore,
      media: deps.media,
      core: deps.core,
      log,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.tabChats ? { tabChats: deps.tabChats } : {}),
      ...(deps.pageOf ? { pageOf: deps.pageOf } : {}),
      ...(deps.memory ? { memory: deps.memory } : {}),
      ...(deps.attachments ? { attachments: deps.attachments } : {}),
    });
    const recorder = new ResultRecorder({
      ...(deps.memory ? { memory: deps.memory } : {}),
      localStore: deps.localStore,
      sessions: deps.sessions,
      patchState: (p) => this.runnerState.patch(p),
      cloudQueue: async () => {
        const api = (await deps.accountApi?.().catch(() => null)) ?? null;
        return api ? { api, runnerId: await deps.getRunnerId() } : null;
      },
      now,
      log,
    });
    this.lifecycle = new Lifecycle({
      live: this.live,
      turns: this.turns,
      recorder,
      sessions: deps.sessions,
      localStore: deps.localStore,
      now,
      log,
      changed,
      ...(deps.episodes ? { episodes: deps.episodes } : {}),
      ...(deps.titles ? { titles: deps.titles } : {}),
      ...(deps.attachments ? { attachments: deps.attachments } : {}),
      nextTurn: (sessionId, messages) => {
        const text = messages.map((m) => m.text).join("\n\n");
        // The latest context holds (where the user looks now).
        const context = [...messages].reverse().find((m) => m.context)?.context;
        const heard = messages.flatMap((m) => m.heard ?? []);
        this.message(sessionId, text, { ...(messages.some((m) => m.voice) ? { voice: true } : {}), ...(heard.length ? { heard } : {}), ...(context ? { context } : {}) }).catch((err: unknown) =>
          this.log(`the next turn of ${sessionId} (messages sent while it closed) did not start: ${errorMessage(err)}`),
        );
      },
    });
    this.policy = new FailurePolicy({
      state: this.runnerState,
      notify: deps.notify,
      stopping: () => this.dueLoop.stopping,
      holdSeries: async (source, seriesId, reason) => {
        if (source === "local") return !!(await deps.localStore.holdSeries(seriesId, reason));
        if (!deps.holdSeries) throw new Error("this queue's jobs cannot be paused from here");
        return deps.holdSeries(source, seriesId, reason);
      },
      releaseHold: async (source, seriesId, except) => {
        if (source === "local") return deps.localStore.releaseHold(seriesId, except);
        if (!deps.releaseHold) throw new Error("this queue's jobs cannot be resumed from here");
        return deps.releaseHold(source, seriesId, except);
      },
      log,
    });
    this.dueLoop = new DueLoop({
      live: this.live,
      lifecycle: this.lifecycle,
      policy: this.policy,
      state: this.runnerState,
      localStore: deps.localStore,
      loadSettings: deps.loadSettings,
      getRunnerId: deps.getRunnerId,
      ...(deps.accountApi ? { accountApi: deps.accountApi } : {}),
      ...(deps.accountQueueHold ? { accountQueueHold: deps.accountQueueHold } : {}),
      ...(deps.outOfCredit ? { outOfCredit: deps.outOfCredit } : {}),
      resolveBrain: deps.resolveBrain,
      notify: deps.notify,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      now,
      newId: () => this.newId(),
      log,
      changed,
      hold: () => this.hold(),
      drop: () => this.drop(),
      track: (job) => this.track(job),
    });
  }

  get busy(): boolean {
    return this.dueLoop.current !== null || this.jobs.size > 0 || this.keepAlive.held;
  }

  /** The session started last among those running, if any. */
  get running(): SessionInfo | null {
    return this.live.last()?.session ?? null;
  }

  /** Every session running right now, oldest first. */
  get runningSessions(): SessionInfo[] {
    return this.live.all().map((a) => a.session);
  }

  /**
   * What the approval gate needs of a running session (approval/gate.ts): its
   * automation level (scheduled runs have their own), the task's instructions,
   * when its turn's time limit ends, whether anyone can answer a card now, and
   * what ends its waiting approvals (Stop, a message from the user) or pauses
   * it for the user's OK when nobody can.
   */
  async gateContext(sessionId: string): Promise<GateContext> {
    const settings = await this.deps.loadSettings();
    const a = this.live.get(sessionId);
    const base: GateContext = {
      level: effectiveLevel(settings, a ?? { scheduled: false }),
      instructions: a?.instructions ?? a?.session.instructions ?? a?.session.title ?? "",
      account: a?.account ?? a?.session.account ?? null,
      ...(a?.scheduled && a.agentAuthored ? { agentAuthored: true } : {}),
      ...(a?.turnEndsAt ? { endsAt: a.turnEndsAt } : {}),
    };
    if (!a) return base;
    // A scheduled run is attended when the user wrote to it this turn or its conversation is open in a side panel.
    const attended = !a.scheduled || a.said.length > 0 || !!(await this.deps.watching?.(sessionId).catch(() => false));
    return {
      ...base,
      attended,
      interrupt: a.approvals.signal,
      stopped: () => a.forced !== null,
      pause: (reason) => {
        if (a.forced || this.live.get(sessionId) !== a) return;
        this.turns.emit(a, { type: "status", text: `Pausing: ${reason}` });
        this.live.force(a, approvalStop(reason));
      },
    };
  }

  /** Resolves when the due loop and every job have finished. */
  async idle(): Promise<void> {
    while (this.dueLoop.current || this.jobs.size) {
      await Promise.allSettled([this.dueLoop.current, ...this.jobs]);
    }
  }

  state(): Promise<RunnerState> {
    return this.runnerState.get();
  }

  /** Runs everything due now: local tasks, then cloud claims, several at once. Returns at once. */
  runDue(trigger: "alarm" | "manual"): Promise<{ started: boolean; detail?: string }> {
    return this.dueLoop.start(trigger);
  }

  /**
   * Starts a one-off task now: a new conversation. Resolves once its session exists.
   * cid: the side panel's correlation id for the message (its voice timings join the turn by it).
   */
  async runAdhoc(input: AdhocInput, cid?: string): Promise<{ sessionId: string }> {
    if (!input.instructions?.trim() && !input.screen) throw new Error("Instructions are empty");
    return this.startOne(null, async () => ({ source: "adhoc", input }), cid);
  }

  /**
   * "Run" on a TODO row: that task now, whatever its time, the way the due
   * loop runs it (same lifecycle, results and repeat), in a free slot. A
   * local task that stopped (failed, paused) starts over; an account task is
   * claimed from the queue by id (the server starts a failed one over).
   * Resolves once its session exists.
   */
  async runTask(taskId: string): Promise<{ sessionId: string }> {
    const local = await this.deps.localStore.get(taskId);
    if (!local) {
      const api = (await this.deps.accountApi?.().catch(() => null)) ?? null;
      if (!api) throw new Error("Log in with a plan that includes the TODO list to run this task");
      const runnerId = await this.deps.getRunnerId();
      return this.startOne(null, async () => {
        const claim = await api.claim(runnerId, taskId);
        if (!claim) throw new Error("That task cannot run now");
        return { source: "cloud", claim, api, runnerId };
      });
    }
    if (local.status === "running" || this.live.localRunning.has(taskId)) throw new Error("That task is already running");
    // Held from now, so the due loop does not start it too; once its session is up, the session holds it.
    this.live.localRunning.add(taskId);
    try {
      const task = local.status === "pending" ? local : await this.deps.localStore.retry(taskId);
      return await this.startOne(null, async () => ({ source: "local", task }));
    } finally {
      if (!this.live.all().some((a) => a.localTaskId === taskId)) this.live.localRunning.delete(taskId);
    }
  }

  /**
   * The user's message in a conversation (the side panel's box).
   * - The conversation's turn is running: typed into it ("inject").
   * - It ended: the next turn ("turn"; see run/conversation.ts).
   * - No conversation: a new one-off conversation ("new"), in tabId when given.
   * tabId: the browser tab the message was sent from; once it is taken, the conversation belongs to that tab.
   * screen: an empty message in Chat, "look at the page and do what is
   * needed" (SCREEN_HELP_TEXT): a new conversation starts with it, an ended
   * one goes on with "look at the page now and continue". A running turn is
   * already looking: it takes typed messages only.
   * cid: the side panel's correlation id for the message (its timings join the turn it went to).
   * context: told to the agent with the message, never shown as the user's words (see withContext).
   * attachments: files sent with it, for a new conversation or the next turn; a running turn refuses them (its
   * agent cannot be given files mid-turn), so they wait in the box until it ends.
   */
  async message(
    sessionId: string | null | undefined,
    text: string,
    opts: { tabId?: number; screen?: boolean; voice?: boolean; heard?: string[]; cid?: string; memoryOff?: boolean; context?: string; attachments?: IncomingAttachment[] } = {},
  ): Promise<{ sessionId: string; mode: MessageMode }> {
    const screen = !!opts.screen && !text.trim();
    const t = screen ? SCREEN_HELP_TEXT : text.trim();
    if (!t) throw new Error("The message is empty");
    const tab = opts.tabId === undefined ? {} : { tabId: opts.tabId };
    const voice = !screen && !!opts.voice;
    // A spoken message's words, word for word (shown folded under it).
    const heard = voice && opts.heard?.length ? { heard: opts.heard } : {};
    const context = screen ? undefined : opts.context?.trim() || undefined;
    const attachments = !screen && opts.attachments?.length ? { attachments: opts.attachments } : {};
    if (!sessionId) {
      const input: AdhocInput = {
        instructions: t,
        ...tab,
        ...(screen ? { screen } : {}),
        ...(voice ? { voice } : {}),
        ...heard,
        ...(context ? { context } : {}),
        ...(opts.memoryOff ? { memoryOff: true } : {}),
        ...attachments,
      };
      return { ...(await this.runAdhoc(input, opts.cid)), mode: "new" };
    }
    if (this.live.has(sessionId)) {
      if (screen) throw new Error("The agent is working on this page already; type a message, or Stop it first");
      if (attachments.attachments) throw new Error(FILES_WHILE_RUNNING);
      if (opts.cid) this.deps.sessions.linkTrace(sessionId, opts.cid);
      const mode = await this.deliver(t, sessionId, { voice, ...heard, ...(context ? { context } : {}) });
      if (!mode) throw new Error("The agent did not take the message");
      if (opts.tabId !== undefined && mode === "inject") await this.turns.bindChat(opts.tabId, sessionId);
      return { sessionId, mode };
    }
    // Its next turn is starting: once its session exists, the message goes into that turn.
    const starting = this.startingTurns.get(sessionId);
    if (starting) {
      await starting.catch(() => undefined);
      return this.message(sessionId, text, opts);
    }
    const started = this.startOne(sessionId, () => turnJob(this.deps, sessionId, t, { screen, voice, ...heard, ...(context ? { context } : {}), ...tab, ...attachments }), opts.cid);
    this.startingTurns.set(sessionId, started);
    try {
      await started;
    } finally {
      this.startingTurns.delete(sessionId);
    }
    return { sessionId, mode: "turn" };
  }

  /**
   * "Continue" for a run that ended paused, failed or retry (e.g. stopped by
   * the user): the next turn of that conversation, with the note as the
   * user's message (or CONTINUE_TEXT). Cloud runs continue from the server's
   * queue instead. tabId: continued from that browser tab (see message()).
   */
  async continueSession(sessionId: string, note?: string, opts: { tabId?: number; attachments?: IncomingAttachment[] } = {}): Promise<{ sessionId: string }> {
    const from = await this.deps.sessions.get(sessionId);
    const refusal = continueRefusal(from, sessionId, this.live.has(sessionId));
    if (refusal) throw new Error(refusal);
    const { sessionId: id } = await this.message(sessionId, note?.trim() || CONTINUE_TEXT, opts);
    return { sessionId: id };
  }

  /**
   * The conversation is over (a new job took its tab, or it is deleted). Its kept-open agent session and the
   * tabs its agent opened are closed (a running turn is left alone; the UI
   * just stops targeting it).
   */
  async newChat(sessionId?: string | null): Promise<{ ok: boolean }> {
    if (!sessionId || this.live.has(sessionId)) return { ok: true };
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false };
    this.live.slots.forget(sessionId);
    await this.live.endChat(sessionId).catch((err: unknown) => this.log(`closing the tabs of ${sessionId} failed: ${errorMessage(err)}`));
    try {
      const { brain } = await this.deps.resolveBrain(await this.deps.loadSettings());
      if (brain?.kind === session.brain) await brain.end?.(sessionId);
    } catch (err) {
      this.log(`ending the agent session of ${sessionId} failed: ${errorMessage(err)}`);
    }
    return { ok: true };
  }

  /** Stops a session (it ends paused): the one given, or every running session and the due loop. */
  stop(sessionId?: string): boolean {
    if (sessionId) {
      const a = this.live.get(sessionId);
      if (!a) return false;
      this.live.force(a, stopOf("user-stop"));
      return true;
    }
    if (!this.busy) return false;
    this.dueLoop.stop();
    this.live.forceAll(stopOf("user-stop"));
    this.live.ended.notify();
    this.live.xTurn.wake();
    return true;
  }

  /** Types into a running session (default: the one started last). voice: the text was spoken. */
  async say(text: string, sessionId?: string, opts: { voice?: boolean } = {}): Promise<boolean> {
    return (await this.deliver(text, sessionId, opts)) !== null;
  }

  /**
   * A message for a running session, whatever it is doing: into its brain's run ("inject"; held for the run
   * while it starts), or, once the run is over and the session is closing, into its next turn ("turn", which
   * starts when the session has ended). Null: no such session, or the run refused it.
   */
  private async deliver(text: string, sessionId: string | undefined, opts: { voice?: boolean; heard?: string[]; context?: string }): Promise<"inject" | "turn" | null> {
    const a = sessionId ? this.live.get(sessionId) : this.live.last();
    const t = text.trim();
    if (!a || !t) return null;
    const voice = !!opts.voice;
    if (!a.run && a.runOver) {
      // The next turn shows it as its own message.
      a.nextTurn.push({ text: t, voice, ...(opts.heard ? { heard: opts.heard } : {}), ...(opts.context ? { context: opts.context } : {}) });
      return "turn";
    }
    // The chat shows the user's words; the agent gets them with their context.
    this.turns.emit(a, { type: "user_message", text: t, ...(voice ? { voice: true as const } : {}), ...(voice && opts.heard ? { heard: opts.heard } : {}) });
    const told = withContext(t, opts.context);
    if (!a.run) {
      a.waiting.push(told);
      this.interruptApprovals(a);
      return "inject";
    }
    a.said.push(told);
    // The message is in the run before the waiting approval ends, so the agent has it when the refusal comes back.
    const taken = await a.run.sendUserMessage(told);
    this.interruptApprovals(a);
    return taken ? "inject" : null;
  }

  /** The user wrote to the agent: an approval waiting now ends as not done, so the agent reads the message first (it may change the plan). */
  private interruptApprovals(a: ActiveSession): void {
    const waiting = a.approvals;
    a.approvals = new AbortController();
    waiting.abort("message");
  }

  /** Startup crash recovery for local tasks. */
  async recover(): Promise<number> {
    const settings = await this.deps.loadSettings();
    const n = await this.deps.localStore.recoverCrashed(settings.maxTaskMinutes, this.live.localRunning);
    if (n) this.log(`recovered ${n} interrupted local task(s)`);
    return n;
  }

  /** chrome.tabs.onUpdated: pause the session whose agent tab hit a pause URL. */
  async onTabUpdated(tabId: number, changeInfo: { url?: string }): Promise<void> {
    if (!changeInfo.url) return;
    const reason = pauseReasonForUrl(changeInfo.url);
    if (!reason) return;
    for (const a of this.live.all()) {
      if (a.forced || !(await a.slot.isAgentTab(tabId))) continue;
      // It may have ended or been stopped while the tab was checked.
      if (a.forced || this.live.get(a.session.sessionId) !== a) continue;
      this.turns.emit(a, { type: "status", text: `Pausing: ${reason}` });
      this.live.force(a, pauseUrlStop(reason));
    }
  }

  /** The browser tab of a conversation was closed: its running turn stops (paused), the session stays in History. */
  onChatTabClosed(sessionId: string): boolean {
    const a = this.live.get(sessionId);
    if (!a || a.forced) return false;
    this.turns.emit(a, { type: "status", text: "Stopping: the tab was closed" });
    this.live.force(a, stopOf("tab-closed"));
    return true;
  }

  /** The user closed the debugger infobar (it ends debugging of every tab): stop every session. */
  onDebuggerCanceled(): void {
    this.live.forceAll(stopOf("debugger-canceled"));
  }

  /**
   * Runs one job now, beside whatever else runs (not the due loop). Resolves
   * once its session exists (or is reopened). conversation: the session whose
   * next turn this is (it prefers the slot it used).
   */
  private async startOne(conversation: string | null, makeJob: () => Promise<FirstJob | TurnJob>, cid?: string): Promise<{ sessionId: string }> {
    const { slots } = this.live;
    // Reserved before anything async, so two quick starts never share a slot.
    const reservation = `starting:${++this.reservations}`;
    const slotIndex = slots.reserve(reservation, conversation === null ? undefined : slots.lastOf(conversation));
    if (slotIndex === null) {
      throw new Error(slots.count === 1 ? "A task is already running. Stop it or wait for it to finish." : `${this.live.size} tasks are running. Stop one or wait for one to finish.`);
    }
    this.hold();
    let settings: ExtensionSettings;
    let run: RunBrain;
    let job: FirstJob | TurnJob;
    // How long picking the brain took (it may connect the helper first), for the trace.
    const resolving = traceStart();
    let resolveMs = 0;
    let resolved: Record<string, TraceValue> = {};
    try {
      job = await makeJob();
      settings = await this.deps.loadSettings();
      const { brain, status } = await this.deps.resolveBrain(settings);
      resolveMs = resolving.elapsed();
      resolved = { brain: brain?.kind ?? null, mode: settings.brain, model: settings.anthropicModel, jev: status.jevActive };
      if (!brain) throw new Error(status.note ?? NO_AI);
      const refusal = job.source === "turn" ? autoSwitchRefusal(settings.brain, job.from.brain, brain.kind) : null;
      if (refusal) throw new Error(refusal);
      run = { brain, status };
    } catch (err) {
      slots.unassign(slotIndex);
      this.drop();
      throw err;
    }
    const sessionId = job.source === "turn" ? job.from.sessionId : this.newId();
    slots.assign(slotIndex, sessionId);
    let created!: () => void;
    const sessionReady = new Promise<void>((r) => (created = r));
    const opts = { slotIndex, scheduled: false, onSessionCreated: created };
    const ended =
      job.source === "turn"
        ? this.lifecycle.runTurn(job, run, settings, opts).then(async (e) => {
            // A scheduled run's conversation that got the work done: its job's failures in a row start over.
            const { source, taskId } = job.from;
            if (source === "local" || source === "cloud") {
              await this.policy.afterTurn(e, { source, seriesId: job.first.seriesId ?? job.from.seriesId, ...(taskId ? { taskId } : {}) });
            }
            return e;
          })
        : this.lifecycle.runFirst(job, run, settings, sessionId, opts);
    const source = job.source;
    void this.track(ended.catch((err) => this.log(`${source} run failed: ${errorMessage(err)}`))).finally(created);
    await sessionReady;
    this.deps.sessions.append(sessionId, { type: "trace", trace: { t: resolving.t, ms: resolveMs, cat: "brain", name: "brain.resolve", src: "engine", data: resolved } });
    if (cid) this.deps.sessions.linkTrace(sessionId, cid);
    return { sessionId };
  }

  /** A job in flight: idle() waits for it; when it settles it gives back the hold taken for it. */
  private track<T>(job: Promise<T>): Promise<T | void> {
    const tracked: Promise<T | void> = job.finally(() => {
      this.jobs.delete(tracked);
      this.drop();
    });
    this.jobs.add(tracked);
    return tracked;
  }

  /** Something runs: keep the service worker alive. */
  private hold(): void {
    this.keepAlive.hold();
    this.changed();
  }

  private drop(): void {
    this.keepAlive.release();
    this.changed();
  }

  private changed(): void {
    callSafely(this.deps.onStateChange);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private newId(): string {
    return this.deps.newId?.() ?? crypto.randomUUID();
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}
