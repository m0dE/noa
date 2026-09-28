/**
 * Background side of ui-protocol.ts: answers every UiRequest. The pushes to
 * the side panel are in ui-hub.ts.
 */
import { ApprovalAnswer, type ApprovalAnsweredBy, cleanUserTitle, errorMessage, IssuableKeyRole, MAX_TRACE_TEXT, redactSettings, secretProblem, type ExtensionSettings, type HelperInfo, type HelperMethods, type LocalTask, type TraceCategory, type TraceEvent, type TraceValue } from "@noa/shared";
import type { AccountService } from "../account/account.js";
import { LocalTodo, type TodoSource } from "../account/todo-source.js";
import { HELPER_CALL_TIMEOUT_MS } from "../helper-link.js";
import type { BrainStatus, TraceEnv, UiRequest, UiResponse, UiResults, UiState } from "../ui-protocol.js";
import { realtimeTicketForPanel, voiceEnginesForPanel, type RealtimeAccount } from "../voice/realtime-access.js";
import { transcribeForPanel, type VoiceAccount } from "../voice/transcribe.js";
import type { LocalStore } from "./local-store.js";
import { TaskScheduler, type TodoAccess, type TodoApprovalAsk } from "./schedule-task.js";
import { todoAllowed } from "../account/types.js";
import { incomingAttachments } from "./attachment-store.js";
import type { AdhocInput } from "./run/jobs.js";
import type { Runner } from "./runner.js";
import type { SessionStore } from "./sessions.js";
import type { ChatTitler } from "./chat-titles.js";
import type { JobDismissals } from "../job-dismissals.js";
import type { TestResult } from "./settings-tests.js";
import { WrongPassphraseError, type Vault } from "../vault.js";
import { isMemoryRequest, type MemoryService } from "../memory/service.js";

/** The runner as the router uses it. */
export type RouterRunner = Pick<
  Runner,
  "running" | "runningSessions" | "state" | "runDue" | "runTask" | "runAdhoc" | "continueSession" | "message" | "newChat" | "stop" | "say"
>;

export type RouterVault = Pick<Vault, "unlock" | "lock" | "list" | "set" | "delete" | "reset">;

/** The account side the router uses, and voice (one WAV clip to text; the Realtime voice engines and session). */
export type RouterAccount = Pick<
  AccountService,
  "view" | "signIn" | "signOut" | "refresh" | "migrateLocalTasks" | "dismissMigration" | "listKeys" | "createKey" | "revokeKey"
> &
  VoiceAccount &
  Partial<RealtimeAccount>;

export interface UiRouterDeps {
  loadSettings(): Promise<ExtensionSettings>;
  /** settings.save semantics (secrets: omitted keep, "" clear). */
  saveSettingsPatch(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings>;
  runner: RouterRunner;
  /** Brings the session's agent tab (default: the first agent tab) to the front. */
  showAgent(sessionId?: string): Promise<boolean>;
  localStore: LocalStore;
  sessions: SessionStore;
  /** Conversations with an open agent session (both brains). */
  openConversations(): string[];
  helper: {
    readonly info: HelperInfo | null;
    readonly lastError: string | null;
    connect(timeoutMs?: number, opts?: { selfTest?: boolean }): Promise<HelperInfo>;
    call<M extends "helper.getLog">(method: M, params: HelperMethods[M]["params"], opts?: { timeoutMs?: number }): Promise<HelperMethods[M]["result"]>;
  };
  brainStatus(settings: ExtensionSettings): BrainStatus;
  nextRunAt(): Promise<string | undefined>;
  /** The old pause of every scheduled run, while it is not converted into paused jobs (pause-migration.ts). Absent: none. */
  pauseMigration?: { pending(): Promise<string | null>; retry(): Promise<void> };
  testClaude(settings: ExtensionSettings): Promise<TestResult>;
  /** Tests the Jev that `brain` (the settings resolved) would use. */
  testJev(settings: ExtensionSettings, brain: BrainStatus): Promise<TestResult>;
  testCloud(settings: ExtensionSettings): Promise<TestResult>;
  vault: RouterVault;
  /** The Noa account. Absent: no account features (always signed out). */
  account?: RouterAccount;
  /** The TODO list's tasks: the account's when signed in, else the local store. */
  todo?(): Promise<TodoSource>;
  /** Which conversation belongs to which browser tab. Absent: chats are not per tab. */
  tabChats?: {
    all(): Promise<Record<string, string>>;
    bind(tabId: number, sessionId: string): Promise<void>;
    unbind(tabId: number, sessionId?: string): Promise<string | null>;
  };
  /** What the user cleared from the jobs list (job-dismissals.ts). Absent: jobs cannot be dismissed. */
  dismissals?: Pick<JobDismissals, "all" | "set">;
  /** The tabs each running session acts in (session id -> tab ids). */
  runningTabs?(): Promise<Record<string, number[]>>;
  /** Activates a browser tab and focuses its window. */
  focusTab?(tabId: number): Promise<boolean>;
  /** Where conversations run (extension, browser, OS, helper), for the Raw view's export. */
  traceEnv?(): Promise<TraceEnv>;
  /** Approval requests waiting for the user (approval/broker.ts). Absent: nothing waits, and answers are refused. */
  approvals?: { answer(sessionId: string, id: string, answer: ApprovalAnswer, by?: ApprovalAnsweredBy): boolean; waitingSessions(): string[] };
  /** The answer on a card its run paused for (approval/paused-decision.ts); false when there is none to decide. */
  decidePaused?(sessionId: string, id: string, answer: ApprovalAnswer, by: ApprovalAnsweredBy): Promise<boolean>;
  /**
   * The user's OK for a TODO task the agent changes or cancels (engine/schedule-task.ts), at the session's
   * automation level (AgentSlots.confirm); throws the refusal. Absent: nothing waits.
   */
  approveTodoChange?(sessionId: string, ask: TodoApprovalAsk): Promise<void>;
  /** A TODO task the agent changed (update_scheduled_task): its memory follows it. */
  onTodoEdited?(before: LocalTask, after: LocalTask): Promise<void>;
  /** The agent's memory: Settings > Memory, Undo on the chat's notes, memory off for a chat. Absent: refused. */
  memory?: Pick<MemoryService, "handle">;
  /** "Add this computer's memory to <account>?" while it waits for the user (UiState.memoryQuestion); null: nothing to ask. */
  memoryQuestion?(): Promise<{ account: string } | null>;
  /** How far summarizing past chats is (UiState.memoryBackfill); null: none under way. */
  memoryBackfill?(): Promise<{ done: number; total: number } | null>;
  /** Chat titles: chats a list shows that are still titled with their request get one (absent: they keep it). */
  titles?: Pick<ChatTitler, "shown">;
}

/** The helper log's last lines for helper.getLog: by default, and at most. */
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2000;

/** A request outside ui-protocol.ts that the router also answers (the e2e suite reads the helper log with it). */
export type ExtraRequest = { type: "helper.getLog"; lines: number };

export class UiRouter {
  /**
   * The TODO tools: schedule, list, change and cancel tasks in the TODO list (the account's, on a plan with
   * the TODO list), and Undo on the chat's cards. The brains call it for their session (engine/schedule-task.ts).
   */
  readonly scheduler: TaskScheduler;

  constructor(private readonly deps: UiRouterDeps) {
    this.scheduler = new TaskScheduler({
      todo: () => this.todo(),
      access: () => this.todoAccess(),
      sessions: deps.sessions,
      ...(deps.approveTodoChange ? { approve: deps.approveTodoChange } : {}),
      ...(deps.onTodoEdited ? { onEdited: deps.onTodoEdited } : {}),
    });
  }

  /** Whether there is a TODO list to schedule into, as the jobs list judges it: signed in, on a plan with it. */
  private async todoAccess(): Promise<TodoAccess> {
    const view = await this.deps.account?.view();
    if (!view?.signedIn) return "signed-out";
    return todoAllowed(view.plan) ? "ok" : "no-plan";
  }

  async getState(): Promise<UiState> {
    const d = this.deps;
    // The account first: the brain status reads its cached credit.
    const account = d.account ? await d.account.view().catch(() => undefined) : undefined;
    const settings = await d.loadSettings();
    const rs = await d.runner.state();
    const next = await d.nextRunAt().catch(() => undefined);
    // What changes from moment to moment (the runs, which chat is in which tab) is read last, together, and the state
    // is stamped then: a panel keeps the newest state whichever order states reach it in (pushes and answers).
    const rev = (this.lastRev = Math.max(Date.now(), this.lastRev + 1));
    const state: UiState = {
      rev,
      settings: redactSettings(settings),
      brain: d.brainStatus(settings),
      running: d.runner.running,
      runningSessions: d.runner.runningSessions,
      openConversations: d.openConversations(),
    };
    if (account) state.account = account;
    if (d.tabChats) state.tabChats = await d.tabChats.all().catch(() => ({}));
    if (d.runningTabs) state.runningTabs = await d.runningTabs().catch(() => ({}));
    const awaiting = d.approvals?.waitingSessions() ?? [];
    if (awaiting.length) state.awaitingApproval = awaiting;
    const dismissals = d.dismissals ? await d.dismissals.all().catch(() => ({})) : {};
    if (Object.keys(dismissals).length) state.dismissals = dismissals;
    const memoryQuestion = d.memoryQuestion ? await d.memoryQuestion().catch(() => null) : null;
    if (memoryQuestion) state.memoryQuestion = memoryQuestion;
    const memoryBackfill = d.memoryBackfill ? await d.memoryBackfill().catch(() => null) : null;
    if (memoryBackfill) state.memoryBackfill = memoryBackfill;
    const pauseMigration = d.pauseMigration ? await d.pauseMigration.pending().catch(() => null) : null;
    if (pauseMigration) state.pauseMigration = pauseMigration;
    if (rs.lastRunAt) state.lastRunAt = rs.lastRunAt;
    if (rs.lastError) state.lastError = rs.lastError;
    if (next) state.nextRunAt = next;
    return state;
  }

  /** Where conversations run, for trace.get (a stand-in when the background did not say). */
  private async traceEnv(): Promise<TraceEnv> {
    if (this.deps.traceEnv) return this.deps.traceEnv();
    const h = this.deps.helper.info;
    return { extensionVersion: "", userAgent: "", helper: h ? { version: h.version, brain: h.brain ?? "claude", jev: h.jevAvailable } : null };
  }

  /** The last state's stamp (UiState.rev): a newer state always has a higher one, also after a restart (it is the clock). */
  private lastRev = 0;

  private account(): RouterAccount {
    if (!this.deps.account) throw new Error("Accounts are not available");
    return this.deps.account;
  }

  private async todo(): Promise<TodoSource> {
    if (this.deps.todo) return this.deps.todo();
    return new LocalTodo(this.deps.localStore);
  }

  /** Answers one request; errors become { ok: false, error }. */
  async handle(msg: UiRequest | ExtraRequest): Promise<UiResponse> {
    try {
      return { ok: true, data: await this.dispatch(msg) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  private async dispatch(msg: UiRequest | ExtraRequest): Promise<unknown> {
    const d = this.deps;
    if (isMemoryRequest(msg)) {
      if (!d.memory) throw new Error("Memory is not available");
      return d.memory.handle(msg);
    }
    switch (msg.type) {
      case "state.get":
        return this.getState();
      case "settings.save":
        await d.saveSettingsPatch(msg.settings ?? {});
        return this.getState();
      case "settings.testClaude":
        return d.testClaude(await d.loadSettings()) satisfies Promise<UiResults["settings.testClaude"]>;
      case "settings.testJev": {
        // The account first, as for state.get: the brain status reads its cached session.
        await d.account?.view().catch(() => undefined);
        const settings = await d.loadSettings();
        return d.testJev(settings, d.brainStatus(settings));
      }
      case "settings.testCloud":
        return d.testCloud(await d.loadSettings());
      case "helper.connect":
        // Connects (or reconnects) and re-runs the Claude Code self-test.
        // Failure is not an error: the state carries brain.helperError.
        await d.helper.connect(undefined, { selfTest: true }).catch(() => undefined);
        return this.getState();
      case "run.adhoc": {
        const input: AdhocInput = {
          instructions: typeof msg.instructions === "string" ? msg.instructions : "",
          account: msg.account ?? null,
        };
        const attachments = incomingAttachments(msg.attachments);
        if (attachments.length) input.attachments = attachments;
        const tab = optTab(msg.tabId);
        if (tab !== undefined) input.tabId = tab;
        if (msg.screen === true) input.screen = true;
        if (msg.memoryOff === true) input.memoryOff = true;
        return d.runner.runAdhoc(input, optCid(msg.cid)) satisfies Promise<UiResults["run.adhoc"]>;
      }
      case "run.continue": {
        if (typeof msg.sessionId !== "string" || !msg.sessionId) throw new Error("sessionId is required");
        const note = typeof msg.text === "string" ? msg.text.trim() : "";
        const tab = optTab(msg.tabId);
        const attachments = incomingAttachments(msg.attachments);
        // Continued from a tab: the conversation goes on there (the runner binds it once the turn is taken).
        return d.runner.continueSession(msg.sessionId, note || undefined, {
          ...(tab === undefined ? {} : { tabId: tab }),
          ...(attachments.length ? { attachments } : {}),
        }) satisfies Promise<UiResults["run.continue"]>;
      }
      case "run.message": {
        const text = typeof msg.text === "string" ? msg.text : "";
        const sessionId = optId(msg.sessionId);
        const tab = optTab(msg.tabId);
        const screen = msg.screen === true;
        const voice = msg.voice === true;
        const heard = voice ? heardWords(msg.heard) : [];
        const cid = optCid(msg.cid);
        const context = typeof msg.context === "string" ? msg.context.trim() : "";
        const attachments = incomingAttachments(msg.attachments);
        // Sent from a tab: the runner binds the conversation to it once the message is taken.
        return d.runner.message(sessionId, text, {
          ...(tab === undefined ? {} : { tabId: tab }),
          ...(screen ? { screen } : {}),
          ...(voice ? { voice } : {}),
          ...(heard.length ? { heard } : {}),
          ...(cid ? { cid } : {}),
          ...(msg.memoryOff === true ? { memoryOff: true } : {}),
          ...(context ? { context } : {}),
          ...(attachments.length ? { attachments } : {}),
        }) satisfies Promise<UiResults["run.message"]>;
      }
      case "run.newChat": {
        const tab = optTab(msg.tabId);
        if (tab !== undefined && d.tabChats) await d.tabChats.unbind(tab, optId(msg.sessionId));
        return d.runner.newChat(optId(msg.sessionId)) satisfies Promise<UiResults["run.newChat"]>;
      }
      case "tab.focus": {
        const tab = optTab(msg.tabId);
        if (tab === undefined) throw new Error("tabId is required");
        return { ok: d.focusTab ? await d.focusTab(tab) : false } satisfies UiResults["tab.focus"];
      }
      case "chat.bind": {
        const sessionId = optId(msg.sessionId);
        const tab = optTab(msg.tabId);
        if (!sessionId || tab === undefined) throw new Error("sessionId and tabId are required");
        if (!d.tabChats) throw new Error("Chats are not per tab here");
        const session = await d.sessions.get(sessionId);
        if (!session) throw new Error(`No session ${sessionId}`);
        await d.tabChats.bind(tab, sessionId);
        return this.getState() satisfies Promise<UiResults["chat.bind"]>;
      }
      case "jobs.dismiss": {
        if (!d.dismissals) throw new Error("Jobs cannot be dismissed here");
        const entries = Object.entries(msg.dismissals ?? {}).filter(([key, v]) => /^(chat|task):./.test(key) && typeof v?.at === "string");
        await d.dismissals.set(
          Object.fromEntries(entries.map(([key, v]) => [key, { at: v.at, ...(typeof v.needs === "string" ? { needs: v.needs } : {}), ...(typeof v.archivedAt === "string" ? { archivedAt: v.archivedAt } : {}) }])),
        );
        return this.getState() satisfies Promise<UiResults["jobs.dismiss"]>;
      }
      case "chat.undoScheduled": {
        const sessionId = optId(msg.sessionId);
        const taskId = optId(msg.taskId);
        if (!sessionId || !taskId) throw new Error("sessionId and taskId are required");
        await this.scheduler.undo(sessionId, taskId);
        return { ok: true } satisfies UiResults["chat.undoScheduled"];
      }
      case "chat.undoTaskChange": {
        const sessionId = optId(msg.sessionId);
        const changeId = optId(msg.changeId);
        if (!sessionId || !changeId) throw new Error("sessionId and changeId are required");
        await this.scheduler.undoChange(sessionId, changeId);
        return { ok: true } satisfies UiResults["chat.undoTaskChange"];
      }
      case "approval.answer": {
        const sessionId = optId(msg.sessionId);
        const id = optId(msg.id);
        const answer = ApprovalAnswer.safeParse(msg.answer);
        if (!sessionId || !id || !answer.success) throw new Error("sessionId, id and answer are required");
        const by = msg.by === "voice" || msg.by === "keyboard" ? msg.by : "card";
        // A card still waiting, else one its run paused for (decided afterwards: Allow & continue, Don't).
        const ok = (d.approvals?.answer(sessionId, id, answer.data, by) ?? false) || ((await d.decidePaused?.(sessionId, id, answer.data, by)) ?? false);
        return { ok } satisfies UiResults["approval.answer"];
      }
      case "run.due":
        return d.runner.runDue("manual");
      case "tasks.run": {
        const id = optId(msg.id);
        if (!id) throw new Error("id is required");
        return d.runner.runTask(id) satisfies Promise<UiResults["tasks.run"]>;
      }
      case "run.stop":
        return { ok: d.runner.stop(optId(msg.sessionId)) } satisfies UiResults["run.stop"];
      case "agent.show":
        return { ok: await d.showAgent(optId(msg.sessionId)) } satisfies UiResults["agent.show"];
      case "run.say":
        return { ok: await d.runner.say(String(msg.text ?? ""), optId(msg.sessionId)) } satisfies UiResults["run.say"];
      case "pause.migrate":
        await d.pauseMigration?.retry();
        return this.getState();
      case "tasks.list": {
        const todo = await this.todo();
        return { ...(await todo.list()), source: todo.kind } satisfies UiResults["tasks.list"];
      }
      case "tasks.add":
        return {
          task: await (await this.todo()).add({
            instructions: msg.instructions,
            account: msg.account ?? null,
            notBefore: msg.notBefore ?? null,
            repeat: msg.repeat ?? null,
            media: msg.media ?? [],
          }),
        } satisfies UiResults["tasks.add"];
      case "tasks.update":
        return { task: await (await this.todo()).update(msg.id, msg.patch ?? {}) } satisfies UiResults["tasks.update"];
      case "tasks.delete":
        return { ok: await (await this.todo()).delete(msg.id) } satisfies UiResults["tasks.delete"];
      case "tasks.retry":
        return { task: await (await this.todo()).retry(msg.id) } satisfies UiResults["tasks.retry"];
      case "tasks.cancel":
        return { task: await (await this.todo()).cancel(msg.id) } satisfies UiResults["tasks.cancel"];
      case "tasks.pause":
        return { task: await (await this.todo()).pause(msg.id) } satisfies UiResults["tasks.pause"];
      case "tasks.resume":
        return { task: await (await this.todo()).resume(msg.id) } satisfies UiResults["tasks.resume"];
      case "tasks.series":
        return (await (await this.todo()).seriesPage(msg.seriesId, msg.cursor)) satisfies UiResults["tasks.series"];
      case "account.signIn":
        await this.account().signIn();
        return this.getState();
      case "account.signOut":
        await this.account().signOut();
        return this.getState();
      case "account.refresh":
        await this.account().refresh(msg.force === true);
        return this.getState();
      case "account.migrate": {
        const r = await this.account().migrateLocalTasks();
        return { ...r, state: await this.getState() } satisfies UiResults["account.migrate"];
      }
      case "account.dismissMigration":
        await this.account().dismissMigration();
        return this.getState();
      case "account.keys.list":
        return { keys: await this.account().listKeys() } satisfies UiResults["account.keys.list"];
      case "account.keys.create": {
        const name = String(msg.name ?? "").trim();
        if (!name) throw new Error("Give the key a name");
        if (!IssuableKeyRole.safeParse(msg.role).success) throw new Error(`The role must be ${IssuableKeyRole.options.join(" or ")}`);
        return this.account().createKey(name, msg.role) satisfies Promise<UiResults["account.keys.create"]>;
      }
      case "account.keys.revoke":
        await this.account().revokeKey(String(msg.id ?? ""));
        return { ok: true } satisfies UiResults["account.keys.revoke"];
      case "sessions.list": {
        const sessions = await d.sessions.list(msg.limit ?? 50, msg.taskId);
        d.titles?.shown(sessions);
        return { sessions } satisfies UiResults["sessions.list"];
      }
      case "session.rename": {
        const session = await d.sessions.get(msg.sessionId);
        if (!session) throw new Error(`No session ${msg.sessionId}`);
        // An older TODO run's title is its task's instructions (a later turn reads them there); a run that keeps its
        // instructions names its series (sidepanel/jobs.ts), and may be renamed.
        if (session.source !== "adhoc" && !session.instructions) throw new Error("Only chats can be renamed: a TODO run is named by its task");
        const title = cleanUserTitle(String(msg.title ?? ""));
        if (!title) throw new Error("Give the chat a name");
        if (secretProblem(title)) throw new Error("A chat's name can't hold a password, code or key");
        const renamed = await d.sessions.retitle(msg.sessionId, title, "user");
        if (!renamed) throw new Error(`No session ${msg.sessionId}`);
        return { session: renamed } satisfies UiResults["session.rename"];
      }
      case "session.delete": {
        const sessionId = optId(msg.sessionId);
        if (!sessionId) throw new Error("sessionId is required");
        if (d.runner.runningSessions.some((s) => s.sessionId === sessionId)) throw new Error("It is running: stop it first");
        // No tab keeps it, and its kept-open agent session and tabs close.
        if (d.tabChats) for (const [tab, id] of Object.entries(await d.tabChats.all())) if (id === sessionId) await d.tabChats.unbind(Number(tab), sessionId);
        await d.runner.newChat(sessionId);
        return { ok: await d.sessions.delete(sessionId) } satisfies UiResults["session.delete"];
      }
      case "sessions.events": {
        const session = await d.sessions.get(msg.sessionId);
        if (!session) throw new Error(`No session ${msg.sessionId}`);
        return { session, events: await d.sessions.eventsOf(msg.sessionId) } satisfies UiResults["sessions.events"];
      }
      case "helper.getLog":
        if (!d.helper.info) return { text: "" };
        return d.helper.call("helper.getLog", { lines: Math.max(1, Math.min(MAX_LOG_LINES, Math.trunc(msg.lines) || DEFAULT_LOG_LINES)) }, { timeoutMs: HELPER_CALL_TIMEOUT_MS });
      case "vault.unlock":
        try {
          await d.vault.unlock(msg.passphrase);
        } catch (err) {
          if (err instanceof WrongPassphraseError) return { ok: false } satisfies UiResults["vault.unlock"];
          throw err;
        }
        return { ok: true } satisfies UiResults["vault.unlock"];
      case "vault.lock":
        await d.vault.lock();
        return { ok: true };
      case "vault.list":
        return d.vault.list();
      case "vault.set":
        await d.vault.set(msg.site, msg.username, msg.password);
        return { ok: true };
      case "vault.delete":
        await d.vault.delete(msg.site);
        return { ok: true };
      case "vault.reset":
        await d.vault.reset();
        return { ok: true } satisfies UiResults["vault.reset"];
      case "voice.transcribe":
        return transcribeForPanel(d.account, {
          wav: String(msg.wav ?? ""),
          speechMs: Number(msg.speechMs) || 0,
          ...(typeof msg.context === "string" ? { context: msg.context } : {}),
          ...(typeof msg.sessionId === "string" ? { sessionId: msg.sessionId } : {}),
        }) satisfies Promise<UiResults["voice.transcribe"]>;
      case "voice.engines":
        return voiceEnginesForPanel(realtimeAccount(d.account)) satisfies Promise<UiResults["voice.engines"]>;
      case "voice.realtime":
        return realtimeTicketForPanel(realtimeAccount(d.account), optId(msg.sessionId)) satisfies Promise<UiResults["voice.realtime"]>;
      case "voice.spoken": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        const sessionId = optId(msg.sessionId);
        if (!sessionId || !text) throw new Error("sessionId and text are required");
        return { ok: !!(await d.sessions.note(sessionId, { type: "spoken", text })) } satisfies UiResults["voice.spoken"];
      }
      case "voice.heard": {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        const sessionId = optId(msg.sessionId);
        if (!sessionId || !text) throw new Error("sessionId and text are required");
        return { ok: !!(await d.sessions.note(sessionId, { type: "heard", text })) } satisfies UiResults["voice.heard"];
      }
      case "trace.add": {
        const sessionId = optId(msg.sessionId);
        if (!sessionId) throw new Error("sessionId is required");
        const events = (Array.isArray(msg.events) ? msg.events : []).slice(0, MAX_PANEL_TRACE_EVENTS).map(panelTraceEvent).filter((e): e is TraceEvent => e !== null);
        return { ok: await d.sessions.addTrace(sessionId, events) } satisfies UiResults["trace.add"];
      }
      case "trace.get": {
        const session = await d.sessions.get(msg.sessionId);
        if (!session) throw new Error(`No session ${msg.sessionId}`);
        const [events, trace, env] = await Promise.all([d.sessions.eventsOf(msg.sessionId), d.sessions.traceOf(msg.sessionId), this.traceEnv()]);
        return { session, events, trace, env } satisfies UiResults["trace.get"];
      }
      default:
        throw new Error(`Unknown request type: ${String((msg as { type?: unknown }).type)}`);
    }
  }
}

/** Trace events one trace.add may carry. */
const MAX_PANEL_TRACE_EVENTS = 200;
const PANEL_CATEGORIES = new Set<TraceCategory>(["user", "voice", "error"]);

/** A trace event from the side panel, checked and bounded (null when it is not one); it is the panel's. */
function panelTraceEvent(v: unknown): TraceEvent | null {
  const e = (v && typeof v === "object" ? v : {}) as Partial<TraceEvent>;
  if (typeof e.t !== "number" || !Number.isFinite(e.t) || typeof e.name !== "string" || !PANEL_CATEGORIES.has(e.cat as TraceCategory)) return null;
  const out: TraceEvent = { t: e.t, cat: e.cat as TraceCategory, name: e.name.slice(0, 60), src: "panel" };
  if (typeof e.ms === "number" && Number.isFinite(e.ms) && e.ms >= 0) out.ms = e.ms;
  const cid = optCid(e.cid);
  if (cid) out.cid = cid;
  if (e.data && typeof e.data === "object") {
    const data: Record<string, TraceValue> = {};
    for (const [k, x] of Object.entries(e.data).slice(0, 24)) {
      if (typeof x === "string") data[k.slice(0, 40)] = x.slice(0, MAX_TRACE_TEXT);
      else if ((typeof x === "number" && Number.isFinite(x)) || typeof x === "boolean" || x === null) data[k.slice(0, 40)] = x;
    }
    out.data = data;
  }
  return out;
}

/** A correlation id from a UI message, or undefined. */
function optCid(v: unknown): string | undefined {
  return typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : undefined;
}

/** A spoken message's words, word for word (run.message heard): strings only, at most MAX_HEARD_PARTS of them. */
const MAX_HEARD_PARTS = 24;
function heardWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((w): w is string => typeof w === "string")
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(-MAX_HEARD_PARTS);
}

/** The account's Realtime voice side, when it has one. */
function realtimeAccount(a: RouterAccount | undefined): RealtimeAccount | undefined {
  return a?.voiceEngines && a.realtimeSession ? { voiceEngines: () => a.voiceEngines!(), realtimeSession: () => a.realtimeSession!() } : undefined;
}

/** A browser tab id from a UI message, or undefined. */
function optTab(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** A session id from a UI message, or undefined. */
function optId(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
