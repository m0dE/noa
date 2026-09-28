/**
 * Service worker entry. Every chrome event listener is registered
 * synchronously at the top level so Chrome can wake the worker for it.
 */
import { z } from "zod";
import * as core from "@noa/core";
import { errorMessage, type ExtensionSettings, type SessionInfo, type TodoToolName, type TodoToolResult } from "@noa/shared";
import { AccountService, browserTimeZone, type AccountServiceDeps } from "./account/account.js";
import type { AccountTaskList } from "./account/account-api.js";
import { AccountTodo, LocalTodo, type TodoSource } from "./account/todo-source.js";
import { PauseMigration } from "./engine/pause-migration.js";
import { AgentSlots } from "./agent-slots.js";
import { ApprovalBroker } from "./approval/broker.js";
import { approvalJev } from "./approval/jev-source.js";
import type { GateContext } from "./approval/gate.js";
import { Preapprovals } from "./approval/paused.js";
import { decidePaused } from "./approval/paused-decision.js";
import { ApiClient } from "./api-client.js";
import { Cdp } from "./cdp.js";
import { agentGroupIds, agentGroupOf, applyGroupLook, tabUrl } from "./chrome-tabs.js";
import { ControlIndicator } from "./control-indicator.js";
import { GOOGLE_CLIENT_ID } from "./build-config.js";
import { ApiBrain } from "./engine/api-brain.js";
import { hostedBackend } from "./engine/hosted-brain.js";
import { needsHelper, resolveBrain } from "./engine/brain-resolver.js";
import { registerBrowserHandlers } from "./engine/browser-caller.js";
import type { Brain } from "./engine/brains.js";
import { ClaudeCodeBrain } from "./engine/claude-code-brain.js";
import { runConfig } from "./engine/run/turn.js";
import { IdbKvDb } from "./engine/kv.js";
import { AttachmentStore } from "./engine/attachment-store.js";
import { LocalStore } from "./engine/local-store.js";
import { MediaFiles } from "./engine/media-files.js";
import { Runner, type ResolvedBrain } from "./engine/runner.js";
import { MAX_SESSIONS, SessionStore } from "./engine/sessions.js";
import { TraceStore } from "./engine/trace-store.js";
import { MEMORY_SEARCH_LIMIT, MemoryService, type MemoryTool } from "./memory/service.js";
import { MemoryStore } from "./memory/store.js";
import { MemorySync } from "./memory/sync.js";
import { EPISODE_ALARM, EpisodeWriter } from "./memory/episodes.js";
import { memorySummarizer } from "./memory/summarizers.js";
import { ChatTitler } from "./engine/chat-titles.js";
import { testClaude, testCloud, testJev } from "./engine/settings-tests.js";
import { UiHub } from "./engine/ui-hub.js";
import { UiRouter, type ExtraRequest } from "./engine/ui-router.js";
import { HelperLink } from "./helper-link.js";
import { logger } from "./log.js";
import { notify } from "./notify.js";
import { PanelCommands } from "./panel-command.js";
import { INDICATOR_MESSAGE, isIndicatorMessage, pageIndicators } from "./page-indicator.js";
import { ALARM_NAME, DUE_ALARM, ensureAlarm, getRunnerId, handleStorageChange, loadSettings, migrateStoredSettings, saveSettingsPatch } from "./settings-store.js";
import type { UiPush, UiRequest } from "./ui-protocol.js";
import { VOICE_BADGES, VoiceSessions } from "./voice-session.js";
import { TabBadges, type BadgeLook } from "./tab-badges.js";
import { TabChats } from "./tab-chats.js";
import { JobDismissals } from "./job-dismissals.js";
import { Vault } from "./vault.js";

// MV3 forbids eval; stop zod from probing for it.
z.config({ jitless: true });

/** Do not re-spawn the helper for every side panel open. */
const HELPER_AUTOCONNECT_MS = 60_000;
/** Due alarms this close count as the same; a new one is set at least this far ahead. */
const DUE_ALARM_SLACK_MS = 1000;

// Pushes to the side panel. Its state comes from the router below; nothing pushes before this module has run.
const hub = new UiHub(() => router.getState());

const cdp = new Cdp();
const vault = new Vault();
// Each browser tab has its own chat (tab -> conversation); the side panel shows the active tab's.
const tabChats = new TabChats();
const jobDismissals = new JobDismissals(chrome.storage.local);
// Each running session acts in its own agent tab (slot); slot 0 is the first agent tab.
// Scheduled runs never take over a tab that has a chat.
// Every browser call of a session is timed in its conversation's trace (the Raw view).
// Actions the automation level holds wait for the user's OK: a card in the conversation's chat (approval/broker.ts).
// The side panel may be closed (a scheduled run): a notification says so too.
/** Actions allowed ahead from a card a run paused for (approval/paused.ts). */
const preapprovals = new Preapprovals();
const approvals = new ApprovalBroker({
  note: async (sessionId, e) => {
    if (!(await sessions.note(sessionId, e))) throw new Error(`No conversation ${sessionId}`);
  },
  onRequest: (_sessionId, r) => void notify("needs your OK", `${r.action}${r.site ? ` on ${r.site}` : ""}: ${r.why}. Answer in the side panel.`),
  // How long each approval waited and what ended it (a card, a key, voice, Stop, a message, no answer), in the Raw view.
  trace: (sessionId, trace) => void sessions.append(sessionId, { type: "trace", trace }),
});
const slots: AgentSlots = new AgentSlots(
  cdp,
  vault,
  async (tabId) => (await tabChats.get(tabId)) !== null,
  (sessionId, call) => {
    sessions.append(sessionId, { type: "trace", trace: { t: call.t, ms: call.ms, cat: "browser", name: call.method, src: "engine", data: call.data } });
    // A browser call may have opened, switched or closed the run's tabs.
    controlIndicator.refresh();
  },
  {
    context: (sessionId): Promise<GateContext> => runner.gateContext(sessionId),
    request: (sessionId, ask, opts) => approvals.request(sessionId, ask, opts),
    trace: (sessionId, trace) => void sessions.append(sessionId, { type: "trace", trace }),
    jev: async (sessionId) =>
      approvalJev({ settings: await loadSettings(), brain: runner.runningSessions.find((s: SessionInfo) => s.sessionId === sessionId)?.brain, hosted: account.session(), sessionId }),
    end: (sessionId) => approvals.end(sessionId),
    // Allow & continue on a card a run paused for: that action, once, for the run that goes on (its session or task).
    preapproved: (sessionId, ask) => preapprovals.take([sessionId, runner.runningSessions.find((s: SessionInfo) => s.sessionId === sessionId)?.taskId], ask),
  },
);
const { tab: agentTab, driver, browser } = slots.get(0);
const db = new IdbKvDb();
const localStore = new LocalStore({ db });
// Each conversation's timing trace (Raw view) lives beside its events.
const attachments = new AttachmentStore(db);
const sessions = new SessionStore(db, { trace: new TraceStore(db, { log: logger("trace") }), attachments });
// The TODO tools (every brain): schedule, list, change and cancel tasks in the TODO list of that conversation's user (engine/schedule-task.ts).
const todoTool = (sessionId: string, tool: TodoToolName, args: unknown): Promise<TodoToolResult> => router.scheduler.tool(sessionId, tool, args);
// The agent's long-term memory (memory/): given at each turn's start, kept with remember / forget and run notes.
const memoryStore = new MemoryStore();
// On a plan with the TODO list, memory syncs with the signed-in account (memory/sync.ts); else it stays here.
const memorySync = new MemorySync({
  store: memoryStore,
  account: async () => {
    await account.load();
    const s = account.session();
    return s ? { userId: s.user.id, email: s.user.email, syncAllowed: account.todoAllowed(), api: await account.api() } : null;
  },
  log: logger("memory"),
  // "Add this computer's memory to <account>?" shows in the side panel and Settings.
  onQuestionChange: () => hub.pushState(),
});
// Signed in and syncing, the account's semantic search adds meaning to what each turn is given (memory/search.ts).
const memory = new MemoryService({
  store: memoryStore,
  sessions,
  settings: loadSettings,
  sync: memorySync,
  semantic: (query, taskKey) => memorySync.search(query, { taskKey, limit: MEMORY_SEARCH_LIMIT }),
  // A task series' rows (this browser's, and the account's when signed in): the instructions each run had.
  seriesTasks: async (seriesId) => {
    const here = (await localStore.list()).filter((t) => t.seriesId === seriesId);
    await account.load();
    return account.session() ? [...here, ...(await (await account.api()).listSeries(seriesId))] : here;
  },
});
// remember / recall / forget (every brain): answered by the memory of that conversation.
const memoryTool = (sessionId: string, tool: MemoryTool, args: unknown) => memory.tool(sessionId, tool, args);
// Claude Code's browser calls name their task session: they are served in that session's tab.
const helper = new HelperLink({
  registerHandlers: (peer) => {
    registerBrowserHandlers(peer, (sessionId) => slots.browserFor(sessionId));
    peer.handle("todo.call", ({ sessionId, tool, args }) => todoTool(sessionId, tool, args));
    peer.handle("memory.call", ({ sessionId, tool, args }) => memoryTool(sessionId, tool, args));
  },
});
const mediaFiles = new MediaFiles();
// Which conversations still have their agent session open shows in the side panel.
const claudeCodeBrain = new ClaudeCodeBrain(helper, {
  onSessionsChanged: () => hub.pushState(),
  // The model call that wrote task_complete, and Claude Code's turn summary, end after the turn: kept in its trace.
  onLateTrace: (sessionId, trace) => void sessions.addTrace(sessionId, [trace]),
});
const apiBrain = new ApiBrain({ core, browser, todoTool, memoryTool, onSessionsChanged: () => hub.pushState() });

type SignInIdentity = { clientId: string; identity: NonNullable<AccountServiceDeps["identity"]> };
/** Google sign-in: the built-in client and Chrome's auth flow (the e2e suite swaps in a fake Google, setIdentity). */
let signInIdentity: SignInIdentity = {
  clientId: GOOGLE_CLIENT_ID,
  identity: {
    redirectUri: () => chrome.identity.getRedirectURL(),
    launch: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
  },
};

// The Noa account: Google sign-in, the account's TODO list, billing and the hosted AI.
const account = new AccountService({
  loadSettings,
  get clientId() {
    return signInIdentity.clientId;
  },
  get identity() {
    return signInIdentity.identity;
  },
  localTasks: localStore,
  onChange: () => {
    hub.pushState();
    hub.push({ type: "tasks.changed" });
    // Signed in, out, or a new plan: memory syncs (or stops) accordingly.
    memorySync.schedule();
  },
  log: logger("account"),
});
void account.load().catch(() => {});
memorySync.schedule();
const hostedBrain = new ApiBrain({
  core,
  browser,
  todoTool,
  memoryTool,
  onSessionsChanged: () => hub.pushState(),
  backend: hostedBackend({
    core,
    session: () => account.session(),
    onOutOfCredit: () => void account.markOutOfCredit().catch(() => {}),
    afterTurn: () => void account.refresh(true).catch(() => {}),
  }),
});

function brainStatus(settings: ExtensionSettings) {
  return resolveBrain({ settings, helper: helper.info, helperError: helper.lastError, account: account.brainAccount() });
}

const brains = { "claude-code": claudeCodeBrain, "claude-api": apiBrain, noa: hostedBrain } as const;

/** The e2e suite's scripted brain (setBrainOverride); null: the real ones. */
let brainOverride: ((settings: ExtensionSettings) => Promise<ResolvedBrain>) | null = null;

async function resolveForRun(settings: ExtensionSettings): Promise<ResolvedBrain> {
  if (brainOverride) return brainOverride(settings);
  await account.load().catch(() => undefined);
  if (needsHelper(settings) && !helper.connected) await helper.connect().catch(() => undefined);
  const status = brainStatus(settings);
  const brain = status.effective && status.effective !== "scripted" ? brains[status.effective] : null;
  return { brain, status };
}

/** Next due time among the signed-in account's pending tasks (from the last list), for the due alarm. */
let accountNextDue: number | null = null;
function noteAccountTasks(listed?: AccountTaskList): void {
  if (listed) {
    // The server judges the plan: when it disagrees with the plan cached here, fetch the plan again (at most once a minute).
    if (listed.locked === account.todoAllowed()) void account.refresh().catch(() => {});
    // Paused tasks wait for the user (or their retryAfter, which the server turns back into pending).
    // A locked list does not run, so it sets no alarm.
    const times = listed.locked
      ? []
      : listed.tasks
          .filter((t) => t.status === "pending")
          .map((t) => Math.max(Date.parse(t.notBefore ?? "") || 0, Date.parse(t.retryAfter ?? "") || 0));
    accountNextDue = times.length ? Math.min(...times) : null;
  } else {
    // A task was added or changed: check soon.
    accountNextDue = Date.now();
  }
  void scheduleDueAlarm().catch(() => {});
}

async function todoSource(): Promise<TodoSource> {
  await account.load();
  if (!account.session()) return new LocalTodo(localStore);
  return new AccountTodo(await account.api(), browserTimeZone(), (listed) => {
    noteAccountTasks(listed);
    if (!listed) hub.push({ type: "tasks.changed" });
  });
}

const createApi = (s: ExtensionSettings) => new ApiClient({ apiBase: s.apiBase, runnerKey: s.runnerKey });

/** A tab's id, address and title (no tabId: the tab the user is looking at); chrome.tabs works on every page. */
async function pageOf(tabId?: number): Promise<{ tabId: number; url: string; title: string } | null> {
  const tab =
    tabId === undefined
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" }))[0]
      : await chrome.tabs.get(tabId).catch(() => undefined);
  return tab?.id === undefined ? null : { tabId: tab.id, url: tabUrl(tab), title: tab.title ?? "" };
}

// The hands-free session (which tab, which panel runs it, the tab the user looks at): every panel is told, and the
// toolbar badges show it (see voice-session.ts).
const DEFAULT_ACTION_TITLE = chrome.runtime.getManifest().action?.default_title ?? "Noa";
// The toolbar badge of each tab: voice's, else the agent's while it controls the tab (tab-badges.ts).
const tabBadges = new TabBadges({
  paint: (tabId, b: BadgeLook | null) =>
    void Promise.all(
      b
        ? [
            chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }),
            chrome.action.setBadgeTextColor({ tabId, color: b.textColor }),
            chrome.action.setBadgeText({ tabId, text: b.text }),
            chrome.action.setTitle({ tabId, title: b.title ?? DEFAULT_ACTION_TITLE }),
          ]
        : [chrome.action.setBadgeText({ tabId, text: "" }), chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE })],
    ).catch((err: unknown) => logger("badge")(`badge on tab ${tabId}: ${errorMessage(err)}`)),
  voiceOf: (tabId) => {
    const look = voiceSessions.badgeOf(tabId);
    return look ? VOICE_BADGES[look] : null;
  },
});
const voiceSessions = new VoiceSessions({
  broadcast: (session) => hub.push({ type: "voice.session", session }),
  badge: (tabId, look) => tabBadges.voice(tabId, look ? VOICE_BADGES[look] : null),
  storage: {
    load: async () => (await chrome.storage.session.get("voiceSession")).voiceSession,
    save: (value) => chrome.storage.session.set({ voiceSession: value }),
  },
  // After a worker restart: a panel page is still open in the window that ran it.
  alive: async (s) => {
    const pages = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL, chrome.runtime.ContextType.TAB] });
    return pages.some((c) => c.windowId === s.windowId && URL.canParse(c.documentUrl ?? "") && new URL(c.documentUrl!).pathname === "/sidepanel.html");
  },
  log: logger("voice"),
});
void Promise.all([
  chrome.tabs.query({ active: true, windowType: "normal" }),
  chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null),
])
  .then(([tabs, focused]) => voiceSessions.seed(tabs.flatMap((t) => (t.id === undefined ? [] : [{ tabId: t.id, windowId: t.windowId }])), focused?.id ?? null))
  .catch((err: unknown) => logger("voice")(`reading the active tabs failed: ${errorMessage(err)}`));
// Each window's side panel, and the keyboard shortcuts: open it with the cursor in the chat input (see panel-command.ts).
const panelCommands = new PanelCommands({
  open: (windowId) => chrome.sidePanel.open({ windowId }),
  // Disabling the panel closes it in every window at once (close() animates and keeps the page); both calls go out
  // before the open() calls that follow, in the same gesture.
  closeAllInstantly: async () => {
    await Promise.all([chrome.sidePanel.setOptions({ enabled: false }), chrome.sidePanel.setOptions({ enabled: true })]);
  },
  // Which panel runs hands-free voice: the background's one record of it.
  voice: (session) => voiceSessions.set(session),
  log: logger(),
});

// The background memory writer (memory/episodes.ts): each conversation's episode and new facts, on the brain it used,
// once a task run ends or a chat goes idle. Its queue lives in storage and an alarm wakes the worker for it.
const episodes = new EpisodeWriter({
  store: memoryStore,
  sessions,
  settings: loadSettings,
  summarizer: (brain) => memorySummarizer(brain, { settings: loadSettings, hosted: () => account.session(), helper }),
  alarms: {
    set: async (when) => void (await chrome.alarms.create(EPISODE_ALARM, { when })),
    clear: async () => void (await chrome.alarms.clear(EPISODE_ALARM)),
  },
  // Past chats without an episode are summarized in the background, never while a run is going on.
  busy: (): boolean => runner.runningSessions.length > 0,
  onBackfillProgress: () => hub.pushState(),
  log: logger("memory"),
});

// Chat titles (engine/chat-titles.ts): the same small model names each chat after its turn, on the brain it used.
const titles = new ChatTitler({
  sessions,
  summarizer: (brain) => memorySummarizer(brain, { settings: loadSettings, hosted: () => account.session(), helper }),
  // Past chats are titled in the background, never while a run is going on.
  busy: (): boolean => runner.runningSessions.length > 0,
  seriesTitled: async (seriesId) => (await sessions.list(MAX_SESSIONS)).some((s) => s.seriesId === seriesId && (s.titleBy === "model" || s.titleBy === "user")),
  log: logger("titles"),
});

/** The account's TODO list, or null when signed out. */
async function accountTodo(): Promise<AccountTodo | null> {
  const source = await todoSource();
  return source instanceof AccountTodo ? source : null;
}

// The old pause of every scheduled run becomes paused jobs (pause-migration.ts); nothing scheduled starts before it ran.
const pauseMigration = new PauseMigration({
  storage: () => chrome.storage.local,
  local: new LocalTodo(localStore),
  account: accountTodo,
  log: logger("pause-migration"),
  changed: () => hub.pushState(),
});
// After the stored settings' own migration (both rewrite them), at every service worker start.
const pauseMigrationStarted = migrateStoredSettings()
  .catch((err: unknown) => logger("settings")(`migration failed: ${errorMessage(err)}`))
  .then(() => pauseMigration.start())
  .catch((err: unknown) => logger("pause-migration")(`failed: ${errorMessage(err)}`));

const runner = new Runner({
  loadSettings,
  getRunnerId,
  createApi,
  accountApi: () => account.runnerApi(),
  accountQueueHold: async () => {
    await pauseMigrationStarted;
    if (await pauseMigration.pending()) await pauseMigration.retry();
    return pauseMigration.pending();
  },
  outOfCredit: () => account.brainAccount().outOfCredit,
  holdSeries: async (_source, seriesId, reason) => {
    const todo = await accountTodo();
    if (!todo) throw new Error("not signed in to the account these tasks belong to");
    return !!(await todo.holdSeries(seriesId, reason));
  },
  localStore,
  sessions,
  pageOf,
  memory,
  episodes,
  titles,
  media: mediaFiles,
  attachments,
  resolveBrain: resolveForRun,
  core,
  slots,
  tabChats,
  notify,
  // Its chat's tab is in front, in a window whose side panel is open: the panel shows that tab's job.
  watching: async (sessionId) => {
    const tabId = await tabChats.tabOf(sessionId);
    const tab = tabId === null ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
    return !!tab?.active && panelCommands.isOpen(tab.windowId);
  },
  keepAlive: () => chrome.runtime.getPlatformInfo(),
  onStateChange: () => {
    hub.pushState();
    controlIndicator.refresh();
  },
  log: logger(),
});
cdp.onUserCancel = () => runner.onDebuggerCanceled();

async function nextRunAt(): Promise<string | undefined> {
  const times = (await Promise.all([chrome.alarms.get(ALARM_NAME), chrome.alarms.get(DUE_ALARM)]))
    .map((a) => a?.scheduledTime)
    .filter((t): t is number => typeof t === "number");
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

async function scheduleDueAlarm(): Promise<void> {
  const local = await localStore.nextWakeAt();
  const accountDue = account.todoAllowed() && accountNextDue !== null ? new Date(accountNextDue) : null;
  const next = local && accountDue ? (local < accountDue ? local : accountDue) : (local ?? accountDue);
  if (!next) {
    await chrome.alarms.clear(DUE_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(DUE_ALARM);
  if (existing && Math.abs(existing.scheduledTime - next.getTime()) < DUE_ALARM_SLACK_MS) return;
  await chrome.alarms.create(DUE_ALARM, { when: Math.max(next.getTime(), Date.now() + DUE_ALARM_SLACK_MS) });
}

const router = new UiRouter({
  loadSettings,
  // A TODO task the agent changes or cancels waits for the user's OK like an action on a page (the session's gate).
  approveTodoChange: (sessionId, ask) => slots.confirm(sessionId, ask),
  saveSettingsPatch,
  runner,
  approvals,
  memory,
  memoryQuestion: () => memorySync.question(),
  memoryBackfill: () => episodes.backfillProgress(),
  titles,
  showAgent: (sessionId) => slots.show(sessionId ?? runner.running?.sessionId),
  localStore,
  sessions,
  openConversations: () => [...claudeCodeBrain.openSessions(), ...apiBrain.openSessions()],
  helper,
  brainStatus,
  nextRunAt,
  pauseMigration,
  testClaude: (s) => testClaude(s),
  testJev: (s, brain) => testJev(s, brain, { core, hosted: account.session() }),
  testCloud: (s) => testCloud(s, (x) => createApi(x).check()),
  vault,
  account,
  todo: todoSource,
  decidePaused: (sessionId, id, answer, by) =>
    decidePaused(
      {
        session: (i) => sessions.get(i),
        events: (i) => sessions.eventsOf(i),
        note: (i, e) => sessions.note(i, e),
        running: (i) => runner.runningSessions.some((s) => s.sessionId === i),
        preapprovals,
        continueSession: (i) => runner.continueSession(i),
        runTask: (taskId) => runner.runTask(taskId),
        todo: todoSource,
      },
      sessionId,
      id,
      answer,
      by,
    ),
  onTodoEdited: (before, after) => memory.taskEdited(before, after),
  tabChats,
  dismissals: jobDismissals,
  focusTab: async (tabId) => {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return true;
    } catch {
      return false;
    }
  },
  traceEnv: async () => {
    const platform = await chrome.runtime.getPlatformInfo().catch(() => null);
    const h = helper.info;
    return {
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      ...(platform ? { os: platform.os, arch: platform.arch } : {}),
      helper: h ? { version: h.version, brain: h.brain ?? "claude", jev: h.jevAvailable } : null,
    };
  },
  runningTabs: async () => {
    const out: Record<string, number[]> = {};
    for (const s of runner.runningSessions) {
      const tabs = await slots.tabsOf(s.sessionId);
      if (tabs.length) out[s.sessionId] = tabs;
    }
    return out;
  },
});
sessions.subscribe({
  onEvent: (e) => {
    hub.event(e);
    // An approval asked or answered: the jobs list moves the conversation in or out of Needs you (UiState.awaitingApproval).
    if (e.type === "approval_request" || e.type === "approval_resolved") hub.pushState();
  },
  onSession: (s) => hub.session(s),
});

// Which tabs the agent controls shows in its tab group, the toolbar badge and on the page (control-indicator.ts).
const controlIndicator = new ControlIndicator({
  running: () =>
    Promise.all(
      runner.runningSessions.map(async (s) => ({ sessionId: s.sessionId, tabs: await slots.tabsOf(s.sessionId), needsYou: approvals.waiting(s.sessionId).length > 0 })),
    ),
  tabsOf: (sessionId) => slots.tabsOf(sessionId),
  chatTabOf: (sessionId) => tabChats.tabOf(sessionId),
  showOverlay: async () => (await loadSettings()).showControlOverlay,
  groups: { of: agentGroupOf, all: agentGroupIds, apply: applyGroupLook },
  badges: tabBadges,
  pages: pageIndicators,
  storage: {
    load: async () => (await chrome.storage.session.get("controlIndicator")).controlIndicator,
    save: (value) => chrome.storage.session.set({ controlIndicator: value }),
  },
  log: logger("indicator"),
});
sessions.subscribe({ onEvent: (e) => controlIndicator.onEvent(e.sessionId, e) });
controlIndicator.refresh();
localStore.onChange(() => {
  hub.push({ type: "tasks.changed" });
  hub.pushState();
  void scheduleDueAlarm().catch(() => {});
});
helper.onInfo(() => hub.pushState());
tabChats.onChange(() => hub.pushState());
jobDismissals.onChange(() => hub.pushState());

let lastAutoConnect = 0;
function maybeConnectHelper(then?: () => void): void {
  if (helper.connected) return then?.();
  if (Date.now() - lastAutoConnect < HELPER_AUTOCONNECT_MS) return;
  lastAutoConnect = Date.now();
  void helper
    .connect()
    .catch(() => undefined)
    .finally(() => {
      hub.pushState();
      then?.();
    });
}

/** The side panel opened: a new chat's agent starts now, so its first answer comes sooner (the brain's prewarm). */
async function prewarmBrain(): Promise<void> {
  const settings = await loadSettings();
  const effective = brainStatus(settings).effective;
  const brain: Brain | null = effective && effective !== "scripted" ? brains[effective] : null;
  brain?.prewarm?.(runConfig(settings, false));
}

function onStart(): void {
  // The stored settings' migrations run once per worker start (pauseMigrationStarted), not here again.
  void ensureAlarm();
  // One side panel per window (the manifest's default path), on screen across tab switches; the toolbar button opens or
  // closes it. Enabled again here: the per-tab panels of earlier versions turned the default one off.
  void chrome.sidePanel?.setOptions({ enabled: true }).catch(() => {});
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void runner.recover().catch(() => {});
  void episodes.resume();
  void scheduleDueAlarm().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => onStart());
chrome.runtime.onStartup.addListener(() => onStart());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (episodes.onAlarm(alarm.name)) return;
  if (alarm.name === DUE_ALARM && accountNextDue !== null && accountNextDue <= Date.now()) accountNextDue = null;
  if (alarm.name === ALARM_NAME || alarm.name === DUE_ALARM) void pauseMigrationStarted.then(() => runner.runDue("alarm"));
});
chrome.storage.onChanged.addListener((changes, area) => {
  void handleStorageChange(changes, area);
  // A run's tabs (agent-tab.ts) or the overlay setting changed.
  if ((area === "session" && Object.keys(changes).some((k) => k.startsWith("agentTab"))) || (area === "local" && changes.settings)) controlIndicator.refresh();
  if (area === "local" && changes.settings) {
    // The account server URL may have changed: the session belongs to the old one.
    void account.load().then(() => hub.pushState(), () => hub.pushState());
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => void runner.onTabUpdated(tabId, changeInfo));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => changeInfo.status === "loading" && voiceSessions.tabLoading(tabId));
// A controlled tab's new page gets the badge and the overlay again; a tab that joined or left a group changes its look.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") tabBadges.tabLoading(tabId);
  if (changeInfo.status === "complete") controlIndicator.tabLoaded(tabId);
  if (changeInfo.groupId !== undefined) controlIndicator.refresh();
});
// What the user looks at, for hands-free voice (its badges, and the panels of other windows).
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => voiceSessions.tabActivated(tabId, windowId));
chrome.windows.onFocusChanged.addListener((windowId) => voiceSessions.windowFocused(windowId), { windowTypes: ["normal"] });
chrome.windows.onRemoved.addListener((windowId) => voiceSessions.windowRemoved(windowId));
// A tab a running agent's page opened (target=_blank, window.open) joins that run's tabs.
chrome.tabs.onCreated.addListener((tab) => void slots.adopt(tab).catch(() => {}));
// A closed tab loses its chat (the session stays in the jobs list); a turn running there stops.
chrome.tabs.onRemoved.addListener((tabId) => {
  voiceSessions.tabRemoved(tabId);
  tabBadges.tabRemoved(tabId);
  pageIndicators.tabRemoved(tabId);
  controlIndicator.tabRemoved(tabId);
  void tabChats
    .unbind(tabId)
    .then((sessionId) => {
      if (sessionId) runner.onChatTabClosed(sessionId);
    })
    .catch(() => {});
});
// Before anything is awaited: sidePanel.open() needs the key press as its user gesture.
chrome.commands?.onCommand.addListener((command, tab) => void panelCommands.onCommand(command, tab));
chrome.debugger.onDetach.addListener((source, reason) => cdp.handleDetach(source, String(reason)));
chrome.runtime.onMessage.addListener((msg: UiRequest | ExtraRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // The overlay's pill on a page the agent controls (page-indicator.ts).
  if (isIndicatorMessage(msg as unknown)) {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) onIndicatorButton(tabId, (msg as { type: string }).type);
    return false;
  }
  if (!msg || typeof (msg as { type?: unknown }).type !== "string") return false;
  void router.handle(msg).then(sendResponse);
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id && port.sender.id !== chrome.runtime.id) return;
  if (hub.attach(port)) {
    panelCommands.attach(port);
    // Where hands-free voice is on, before the panel's hello (a voice shortcut it gets then acts on it).
    port.postMessage({ type: "voice.session", session: voiceSessions.view() } satisfies UiPush);
    maybeConnectHelper(() => void prewarmBrain().catch(() => {}));
    // Credit and plan may have changed elsewhere (dashboard, another browser).
    void account.refresh().catch(() => {});
  }
});

/** Stop: that tab's run stops. Open: the side panel opens (now, within the click's user gesture) and the chat's tab comes to the front. */
function onIndicatorButton(tabId: number, type: string): void {
  if (type === INDICATOR_MESSAGE.stop) {
    const sessionId = controlIndicator.sessionOf(tabId);
    if (sessionId) runner.stop(sessionId);
    return;
  }
  const target = controlIndicator.open(tabId);
  // Synchronously, in the click's gesture: a tab without a panel of its own opens its window's panel.
  chrome.sidePanel.open({ tabId: target }).catch((err: unknown) => logger("indicator")(`opening the side panel for tab ${target} failed: ${errorMessage(err)}`));
  if (target !== tabId) {
    void chrome.tabs
      .update(target, { active: true })
      .then(async (t) => {
        if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
      })
      .catch(() => {});
  }
}

// Every worker start (not only install/startup): alarms, side panel behavior, crash recovery.
onStart();

// Test hook for the Playwright smoke and e2e suites (service worker scope only).
(globalThis as unknown as { __noa: unknown }).__noa = {
  driver,
  runner,
  localStore,
  sessions,
  helper,
  settings: { load: loadSettings, save: saveSettingsPatch },
  account,
  router,
  media: mediaFiles,
  vault,
  cdp,
  slots,
  agentTab,
  tabChats,
  memory,
  memorySync,
  episodes,
  titles,
  scheduleDueAlarm,
  panelCommands,
  voiceSessions,
  controlIndicator,
  pageIndicators,
  /** Runs use this brain instead of the real ones (null: back to the real ones). */
  setBrainOverride: (fn: typeof brainOverride) => void (brainOverride = fn),
  /** Google sign-in uses this client ID and auth flow (a fake Google). */
  setIdentity: (next: SignInIdentity) => void (signInIdentity = next),
};
