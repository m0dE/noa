/**
 * Side panel entry. Everything is a job (jobs.ts): the panel opens on the jobs list (job-list.ts), and a job opens
 * on its own page (job-page.ts: its conversation, chat.ts); "‹" goes back to the list as it was left (job-nav.ts).
 * The composer at the bottom starts a new job from the list and goes on with the job shown on its page. Wires the
 * header (header.ts), the push port to the background (port.ts) and hands-free voice.
 *
 * One panel per window (the manifest's side panel; also the page opened as a tab): it stays on screen across tab
 * switches, and what it shows follows the window's active tab. Each browser tab has its own chat (tab-chat.ts):
 * opening a job binds it to the active tab, a new job started from the composer is bound to it, and the panel shows
 * the job its tab's chat became.
 *
 * Switching tabs: a tab with a job (its own chat, or a run working there) shows that job. A tab without one shows
 * the list when the job on screen was the tab's that was left (it belongs there, and the box would go on with it);
 * a job the user opened that belongs to no tab stays (the "Working in … · View" row says where it runs).
 */
import { errorMessage, FILES_WHILE_RUNNING, type SessionInfo, type VoiceEngineId, type VoiceEnginesResponse } from "@noa/shared";
import { SIGN_IN_NOT_SET_UP } from "../account/google-auth.js";
import { isStale, uiRequest, type UiAttachmentUpload, type UiPush, type UiState } from "../ui-protocol.js";
import { initChat } from "./chat.js";
import { initComposer } from "./composer.js";
import { showDetails } from "./details-sheet.js";
import { $, closeMenusOnOutsideClick } from "../ui/dom.js";
import { setErrorFixes, type ErrorFixes } from "./error-view.js";
import { todoGate } from "./format.js";
import { initHeader } from "./header.js";
import { JobData } from "./job-data.js";
import { Dismisser, dismissalOf, undoText } from "./job-dismiss.js";
import { initJobList } from "./job-list.js";
import { forgetOldTabs, JobNav, storedView, storeView, viewAnnouncement } from "./job-nav.js";
import { initJobPage } from "./job-page.js";
import { chatKey, seriesOf, taskKey, type Job } from "./jobs.js";
import { initMemoryAsk } from "./memory-ask.js";
import { initMigrateOffer } from "./migrate-offer.js";
import { openSettings } from "./open-settings.js";
import { initAutonomyWarning } from "./autonomy-warning.js";
import { connectBackground } from "./port.js";
import type { PanelMessage } from "../panel-command.js";
import { agentTabToView, chatInTab, isBound, ownChatOfTab, tabOfSession } from "./tab-chat.js";
import { openScheduleSheet } from "./schedule-sheet.js";
import { OPEN_CHAT_COMMAND, openShortcutSettings, readShortcut, VOICE_COMMAND } from "../shortcut.js";
import { voiceAllowed } from "../account/types.js";
import { openBilling, refreshOnReturn } from "../ui/billing.js";
import { browserMicAccessDeps, watchMicPermission } from "../voice/mic-access.js";
import { MicSource } from "../voice/recorder.js";
import { REALTIME_SAMPLE_RATE } from "../voice/realtime-client.js";
import { RealtimeEngine } from "../voice/realtime-engine.js";
import { voiceLanguages } from "../voice/voice-language.js";
import { Speaker } from "../voice/speaker.js";
import { StandardEngine } from "../voice/standard-engine.js";
import { panelTranscriber, VoiceError } from "../voice/transcribe.js";
import { initHandsFree, type SendExtra } from "./hands-free.js";
import { initVoiceInput, VOICE_NOTICE } from "./voice-input.js";
import { PanelTrace } from "../trace/panel-trace.js";

/** Relative times (the list's, the job's subtitle) are redrawn this often. */
const CLOCK_TICK_MS = 60_000;
/** Sign-in's progress and problems, above the box. */
const ACCOUNT_NOTICE = "account";

// Older panels kept their last tab (and a #todo or #history hash may still point at one): every panel opens on the list.
forgetOldTabs(localStorage);
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

let state: UiState | null = null;
/** This page's own id: the background names the panel running a hands-free session by it. */
const panelId = crypto.randomUUID();
/** The browser window this panel is in, and the tab it acts in: the active tab of the window. */
let windowId: number | null = null;
let activeTab: number | null = null;
/** A conversation just started from a tab, until the state shows it bound there. */
let pending: { tab: number; sessionId: string } | null = null;
/** The active tab's own chat as last seen (undefined: no state yet); when it becomes another one, its job shows. */
let ownSeen: string | null | undefined;

const nav = new JobNav(storedView(sessionStorage));
const data = new JobData(uiRequest, (err) => console.warn(`[noa] jobs not loaded: ${errorMessage(err)}`));
const listView = $("view-list");
const jobView = $("view-job");

/** The job a conversation belongs to (a chat just started is its own). */
function keyOfSession(sessionId: string): string {
  const s = data.session(sessionId);
  return s ? data.keyOfSession(s) : chatKey(sessionId);
}

/** Shows a job's page; opened from the list, the list's place is kept for back. */
function showJob(key: string): void {
  nav.open(key, nav.view.kind === "list" ? list.place(null) : undefined);
}

/** Back to the list, as it was left; `focus`: the search box gets the cursor unless a row does (the user went back). */
function back(focus = true): void {
  const place = nav.back();
  list.show(place);
  if (focus && !place.focusKey) $<HTMLInputElement>("job-search").focus({ preventScroll: true });
}

/** A row was picked: its page. Its conversation is bound to this tab, unless it is running in another one. */
function openJob(job: Job): void {
  nav.open(job.key, list.place(job.key));
  composer.focus();
  const s = job.session;
  if (!s || activeTab === null) return;
  const where = state ? tabOfSession(s.sessionId, state) : null;
  if (job.running && where !== null && where !== activeTab) return;
  const tab = activeTab;
  pending = { tab, sessionId: s.sessionId };
  ownSeen = s.sessionId;
  uiRequest({ type: "chat.bind", sessionId: s.sessionId, tabId: tab }).then(applyState, (err: unknown) => composer.showError(err));
}

/**
 * A message, a new job or a continue went out from this tab: its job shows at once. A new job takes the tab's place
 * of the chat it had, which is over then (its kept-open agent session and tabs close, as the tab has a new chat).
 */
function startedHere(sessionId: string): void {
  const isNew = !data.session(sessionId);
  if (activeTab !== null) {
    const before = ownChatOfTab(activeTab, state ?? {}, { pending });
    if (isNew && before && before !== sessionId && !state?.runningSessions.some((r) => r.sessionId === before)) {
      void uiRequest({ type: "run.newChat", sessionId: before }).catch((err: unknown) => console.warn(`[noa] closing chat ${before} failed: ${errorMessage(err)}`));
    }
    pending = { tab: activeTab, sessionId };
  }
  ownSeen = sessionId;
  showJob(keyOfSession(sessionId));
}

/**
 * The window's active tab is `tab` now (the user switched tabs): the panel acts there. A tab with a job shows it; a
 * tab without one shows the list if the job on screen was the tab's that was left, else what the user opened stays
 * (see the top of this file). `quiet`: the first look at the tabs, when the panel opens (on the list).
 */
function setActive(tab: number | null, quiet = false): void {
  if (tab === activeTab) return;
  const left = activeTab;
  activeTab = tab;
  const s = state ?? {};
  if (state) ownSeen = ownChatOfTab(tab, state, { pending });
  const shown = chatInTab(tab, s, { pending });
  if (!quiet) {
    const onJob = nav.view.kind === "job" ? page.sessionId() : null;
    if (shown) showJob(keyOfSession(shown));
    else if (onJob && onJob === chatInTab(left, s, { pending })) back(false);
  }
  handsFree.refresh();
}

/** Shows another browser tab, and its window (the panel there shows that tab's job). */
async function goToTab(tabId: number): Promise<boolean> {
  return (await uiRequest({ type: "tab.focus", tabId })).ok;
}

/** Get a plan, Top up, Plan & billing: the dashboard's Billing page. */
function billing(): void {
  void openBilling(state?.account);
}

/** This panel's part of each conversation's timing trace (sending, voice), for the Raw view. */
const panelTrace = new PanelTrace((sessionId, events) => uiRequest({ type: "trace.add", sessionId, events }));
/** The voice engines' models as the server last listed them (for the trace). */
const voiceModels: Partial<Record<VoiceEngineId, string>> = {};
/** The server's voice engines (null: could not be loaded); remembers their models. */
async function loadVoiceModels(): Promise<VoiceEnginesResponse | null> {
  const r = await uiRequest({ type: "voice.engines" }).catch(() => null);
  if (!r || "error" in r) return null;
  for (const e of r.engines) voiceModels[e.id] = e.model;
  return r;
}
const composer = initComposer({
  onStarted: startedHere,
  onState: (s) => applyState(s),
  onTopup: billing,
  tabId: () => activeTab,
  trace: panelTrace,
});
// Voice: the mic left of Send and the voice shortcut start hands-free voice; Standard's clips are transcribed by the
// background with the account.
const micAccess = browserMicAccessDeps();
const transcribe = panelTranscriber(
  (clip) => uiRequest({ type: "voice.transcribe", ...clip }),
  () => composer.target()?.sessionId,
);
/**
 * A hands-free session is on (in tab `tabId`, on `engine`): the voice shortcut then reaches this panel, wherever the
 * focus is, the other panels say where voice is on, and the toolbar badges show it (see voice-session.ts).
 */
let listeningReport: Extract<PanelMessage, { type: "panel.listening" }> = { type: "panel.listening", listening: false };
function reportListening(listening: boolean, tabId: number | null, engine: VoiceEngineId | null, muted: boolean): void {
  listeningReport = { type: "panel.listening", listening, ...(tabId === null ? {} : { tabId }), ...(engine === null ? {} : { engine }), ...(muted ? { muted } : {}) };
  port.send(listeningReport);
}
const voice = initVoiceInput({
  composer,
  mic: { ...micAccess, watch: (onChange) => watchMicPermission(onChange) },
  openBilling: billing,
  host: document.body,
});
/**
 * Hands-free voice's chat for a tab: in the panel's tab, the job shown (the list: a new job, as the box would
 * start); in another tab, that tab's own chat only, never a scheduled or other run that merely acts in that tab (its
 * results were once read out in a session that had asked nothing).
 */
const voiceChatOfTab = (tab: number | null): string | null =>
  tab === null || tab === activeTab ? (nav.view.kind === "job" ? page.sessionId() : null) : ownChatOfTab(tab, state ?? {}, { pending });

/**
 * Hands-free voice sends what was said to its chat, whichever tab is shown: the chat by its id (it stays in the tab
 * it lives in), or a new chat in the session's tab.
 */
async function sendSpoken(text: string, target: { tabId: number | null; sessionId: string | null }, { cid, context, heard }: SendExtra = {}): Promise<string> {
  const { tabId: tab, sessionId } = target;
  // A new chat carries the choice of memory made for its tab (the composer's menu).
  const where = sessionId ? { sessionId } : { ...(tab === null ? {} : { tabId: tab }), ...composer.memory.forNewChat(tab) };
  // Files in the box go with a request that starts a turn; a running turn's agent cannot take them (they wait).
  const running = !!sessionId && !!state?.runningSessions.some((s) => s.sessionId === sessionId);
  const batch = composer.attachments.count && !running ? await composer.attachments.batch() : null;
  const attachments = batch?.uploads ?? [];
  const request = (files: UiAttachmentUpload[]) =>
    uiRequest({
      type: "run.message",
      ...where,
      text,
      voice: true,
      ...(heard?.length ? { heard: [...heard] } : {}),
      ...(cid ? { cid } : {}),
      ...(context ? { context } : {}),
      ...(files.length ? { attachments: files } : {}),
    });
  // The turn may have started since the panel last heard: then the words go now and the files keep waiting.
  const r = await request(attachments).catch((err: unknown) => {
    if (!attachments.length || errorMessage(err) !== FILES_WHILE_RUNNING) throw err;
    attachments.length = 0;
    return request([]);
  });
  if (attachments.length) batch?.sent();
  if (sessionId) return r.sessionId;
  if (tab === null || tab === activeTab) startedHere(r.sessionId);
  else {
    // Started from a tab not shown: it is that tab's chat once the state says so.
    pending = { tab, sessionId: r.sessionId };
  }
  return r.sessionId;
}

// Hands-free voice (the voice shortcut): Realtime or Standard, bound to the tab it started in; see hands-free.ts.
const handsFree = initHandsFree({
  voice,
  composer,
  notify: ({ key, ...tip }) => composer.notices.show({ key: key ?? VOICE_NOTICE, ...tip }),
  activeTab: () => activeTab,
  panel: panelId,
  chatOf: voiceChatOfTab,
  tabsOf: (sessionId) => {
    const home = state ? tabOfSession(sessionId, state) : null;
    return [...(home === null ? [] : [home]), ...(state?.runningTabs?.[sessionId] ?? [])];
  },
  send: sendSpoken,
  tabPage: async (tabId) => {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    return t ? { title: t.title ?? null, url: t.url ?? t.pendingUrl ?? null } : null;
  },
  goToTab: (tabId) => void goToTab(tabId).catch((err: unknown) => composer.showError(err)),
  onSpeaking: (line) => chat.setSpeaking(line),
  keepSpoken: (sessionId, text) =>
    void uiRequest({ type: "voice.spoken", sessionId, text }).catch((err: unknown) => console.warn(`[noa] keeping a spoken line failed: ${errorMessage(err)}`)),
  keepHeard: (sessionId, text) =>
    void uiRequest({ type: "voice.heard", sessionId, text }).catch((err: unknown) =>
      console.warn(`[noa] keeping what was said failed: ${errorMessage(err)}`),
    ),
  settings: () => state?.settings ?? null,
  account: () => state?.account,
  engines: loadVoiceModels,
  saveSettings: async (patch) => applyState(await uiRequest({ type: "settings.save", settings: patch })),
  openVoiceSettings: () => void openSettings("ai"),
  createEngine: (id, events, opts) => {
    // Standard chosen in Settings skips the engine list: its model (for the trace) is asked for here.
    if (id === "standard" && !voiceModels.standard && state?.account?.signedIn) void loadVoiceModels();
    return id === "realtime"
      ? new RealtimeEngine({
          ticket: async () => {
            const sessionId = handsFree.chat();
            const r = await uiRequest({ type: "voice.realtime", ...(sessionId ? { sessionId } : {}) });
            if ("error" in r) throw new VoiceError(r.error);
            return r;
          },
          createSource: () => new MicSource(undefined, REALTIME_SAMPLE_RATE),
          events,
          ...(state ? { voice: { voice: state.settings.realtimeVoice, speed: state.settings.realtimeSpeed } } : {}),
          // The browser's languages (Chrome's settings): the transcription's hint, and what counts as the user's.
          languages: voiceLanguages(navigator.languages),
          log: (m) => console.info(`[noa] ${m}`),
          trace: panelTrace,
          ...(opts?.takeover ? { takeover: true } : {}),
        })
      : new StandardEngine({
          createSource: () => new MicSource(),
          transcribe,
          speaker: new Speaker(() => ({ voice: state?.settings.speechVoice ?? "", rate: state?.settings.speechRate ?? 1 })),
          events,
          trace: panelTrace,
          model: () => voiceModels.standard,
        });
  },
  answerApproval: async (sessionId, id, answer) => (await uiRequest({ type: "approval.answer", sessionId, id, answer, by: "voice" })).ok,
  stopTask: async (sessionId) => {
    if (!sessionId || !state?.runningSessions.some((s) => s.sessionId === sessionId)) return "No task is running.";
    await uiRequest({ type: "run.stop", sessionId });
    return "Stopped the task.";
  },
  openBilling: billing,
  signIn: () => void signIn(),
  onActive: reportListening,
  stopRemote: () => port.send({ type: "panel.voiceStop" }),
  bar: $("voice-bar"),
  trace: panelTrace,
  log: (m) => console.info(`[noa] ${m}`),
});

/** The details sheet of a conversation's first message. */
const runDetails = (s: SessionInfo, trigger: HTMLElement) => void showDetails({ session: s }, trigger);

/** View on a scheduled card: that task's job (the list is loaded again first: the task may be new). */
async function openTask(taskId: string): Promise<void> {
  await data.loadTasks();
  const job = data.jobs().find((j) => j.tasks.some((t) => t.id === taskId));
  showJob(job?.key ?? taskKey(taskId));
}

const chat = initChat({
  // Continue in an end card: go on now (with the note typed in the box, if any).
  onContinue: (sessionId) => void composer.continueNow(sessionId),
  onFocus: (s) => {
    composer.setConversation(s);
    handsFree.refresh();
    // A chat just started is known once its conversation loads: its page's title and menu follow.
    if (nav.view.kind === "job") page.render();
  },
  onDetails: runDetails,
  onOpenTask: (taskId) => void openTask(taskId),
  onRaw: () => page.render(),
  voiceEnv: () => {
    const settings = state?.settings;
    if (!settings) return undefined;
    // Not listed yet (voice not used in this panel): ask now, for the next export.
    if (!voiceModels.realtime && !voiceModels.standard && state?.account?.signedIn) void loadVoiceModels();
    const engine = settings.voiceEngine;
    const model = voiceModels[engine];
    return {
      engine,
      ...(model ? { model } : {}),
      ...(voiceModels.realtime ? { realtimeModel: voiceModels.realtime } : {}),
      ...(voiceModels.standard ? { standardModel: voiceModels.standard } : {}),
      ...(engine === "realtime" ? { voice: settings.realtimeVoice, speed: settings.realtimeSpeed } : { voice: settings.speechVoice || "browser default", speed: settings.speechRate }),
    };
  },
});

/** Dismissing jobs from the list, with Undo above the box for a few seconds (job-dismiss.ts). */
const DISMISS_NOTICE = "dismiss";
const dismisser = new Dismisser({
  commit: async (batch) => {
    try {
      applyState(await uiRequest({ type: "jobs.dismiss", dismissals: Object.fromEntries(batch.map((d) => [d.key, d.entry])) }));
    } catch (err) {
      composer.showError(err);
    }
    let cancelled = false;
    for (const { action } of batch) {
      try {
        if (action?.type === "stop") await uiRequest({ type: "run.stop", sessionId: action.sessionId });
        if (action?.type === "cancel") {
          await uiRequest({ type: "tasks.cancel", id: action.taskId });
          cancelled = true;
        }
      } catch (err) {
        composer.showError(err);
      }
    }
    if (cancelled) await data.loadTasks();
  },
  onPending: (pending) => data.setPendingDismissals(pending),
  offerUndo: (batch) =>
    batch
      ? composer.notices.show({ key: DISMISS_NOTICE, level: "info", text: undoText(batch), actions: [{ label: "Undo", run: () => dismisser.undo() }] })
      : composer.notices.clear(DISMISS_NOTICE),
});
// A panel going away does what was dismissed in it (Undo is gone with it).
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void dismisser.flush());
window.addEventListener("pagehide", () => void dismisser.flush());

const list = initJobList(listView, {
  data,
  onOpen: openJob,
  canDismiss: (job) => dismissalOf(job, data.source) !== null,
  onDismiss: (jobs) => dismisser.dismiss(jobs.map((j) => dismissalOf(j, data.source)).filter((d) => d !== null)),
  onToggle: async (job, to) => {
    if (!job.task) return;
    try {
      await uiRequest({ type: to === "pause" ? "tasks.pause" : "tasks.resume", id: job.task.id });
      await data.loadTasks();
    } catch (err) {
      composer.showError(err);
    }
  },
  onView: (view) => storeView(sessionStorage, view),
  onShortcuts: () => void openShortcutSettings(),
});
const page = initJobPage({
  data,
  chat,
  agentTab: (sessionId) => (state ? agentTabToView(sessionId, activeTab, state) : null),
  tabInfo: async (tabId) => {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    return t ? { title: t.title ?? "", url: t.url || t.pendingUrl || "", ...(t.favIconUrl ? { favIconUrl: t.favIconUrl } : {}) } : null;
  },
  goToTab: (tabId) => void goToTab(tabId).catch((err: unknown) => composer.showError(err)),
  continueNow: (sessionId) => void composer.continueNow(sessionId),
  openSchedule: (job, trigger) =>
    void openScheduleSheet(job, trigger, {
      gate: todoGate(state?.account ?? null, data.source === "account" ? data.locked : null),
      onSignIn: () => void signIn(),
      onBilling: billing,
      onSaved: (task, created) => {
        void data.loadTasks();
        if (created) showJob(taskKey(seriesOf(task)));
      },
    }),
  onTaskDetails: (job, trigger) => job.task && void showDetails({ task: job.task, listSource: data.source }, trigger),
  onBack: back,
  onDeleted: back,
  showError: (err) => composer.showError(err),
});

// Screen readers hear where the panel went; the two views and their headers swap.
const announce = $("view-announce");
nav.onChange((view) => {
  const onList = view.kind === "list";
  listView.hidden = !onList;
  $("list-head").hidden = !onList;
  jobView.hidden = onList;
  $("job-head").hidden = onList;
  if (onList) {
    chat.setRaw(false);
    chat.show(null);
    chat.setBefore(null);
    // The list may have missed pushes of other panels (a job deleted there).
    void data.loadSessions();
  } else page.show(view.key);
  announce.textContent = viewAnnouncement(view, onList ? null : page.title() || null);
  handsFree.refresh();
  // A panel the shortcut recreates comes back on this view.
  reportDocumentFocus();
});
// Esc on a job's page (not in a box, a menu or a sheet) goes back to the list.
for (const el of [jobView, $("job-head")]) {
  el.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape" && !e.defaultPrevented && !t.closest("input, textarea, details[open], dialog")) back();
  });
}

data.onChange(() => {
  header.setList({ lockedWaiting: data.lockedWaiting });
  // A chat shown before its session was listed may turn out to be a task's run: its job is the task's.
  const key = nav.jobKey;
  if (key?.startsWith("chat:") && !data.job(key)) {
    const s = data.session(key.slice("chat:".length));
    const real = s ? data.keyOfSession(s) : key;
    if (real !== key) return showJob(real);
  }
  if (nav.view.kind === "job") page.render();
});

/** The voice shortcut arrived before the first state (a panel it just opened): run it once voice knows the plan. */
let voicePending = false;

/** Log in with Google: progress and problems show above the box. */
async function signIn(): Promise<void> {
  if (state?.account && !state.account.signInConfigured) return composer.notices.show({ key: ACCOUNT_NOTICE, level: "error", text: SIGN_IN_NOT_SET_UP });
  composer.notices.show({ key: ACCOUNT_NOTICE, level: "info", text: "Continue in the Google window…", sticky: true });
  try {
    applyState(await uiRequest({ type: "account.signIn" }));
    composer.notices.clear(ACCOUNT_NOTICE);
  } catch (err) {
    composer.notices.show({ key: ACCOUNT_NOTICE, level: "error", text: errorMessage(err) });
  }
}

const header = initHeader({ onState: (s) => applyState(s), onBilling: billing, onSignIn: () => void signIn() });
// While the agent may act without asking, the panel says so (Settings > Permission).
const autonomyWarning = initAutonomyWarning((patch) => uiRequest({ type: "settings.save", settings: patch }).then(applyState, () => undefined));
const say = (text: string) => composer.notices.show({ key: ACCOUNT_NOTICE, level: "info", text });
const migrate = initMigrateOffer({ onState: (s) => applyState(s), onMoved: say });
const memoryAsk = initMemoryAsk({ onState: (s) => applyState(s), onAnswered: say });

/** What the fix buttons of error cards and the problem strip do (error-help.ts names them). Billing ones need an account. */
function errorFixes(s: UiState): ErrorFixes {
  const aiSettings = () => void openSettings("ai");
  const useHosted = () =>
    void uiRequest({ type: "settings.save", settings: { brain: "noa" } }).then(applyState, (err: unknown) => composer.showError(err));
  return {
    "own-claude": aiSettings,
    "claude-code": aiSettings,
    "api-key": aiSettings,
    "set-up-ai": aiSettings,
    "new-tab": () => void chrome.tabs.create({}),
    login: () => void signIn(),
    ...(s.account?.signedIn ? { topup: billing, plans: billing, "use-hosted": useHosted } : {}),
  };
}
closeMenusOnOutsideClick("details.menu");

/**
 * The panel page opened as a tab, not the side panel (the shortcut recreates side panels only). Null until known:
 * chrome.tabs.getCurrent() names a tab only in a tab.
 */
let asTab: boolean | null = null;

/** Follows the active tab of the panel's window. */
async function trackTabs(): Promise<void> {
  // The job page's row of the agent's tab follows the page the agent is on; the voice strip names its tab as it is now.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.title !== undefined || change.url !== undefined || change.favIconUrl !== undefined) page.tabUpdated(tabId);
    if (change.title !== undefined || change.url !== undefined) handsFree.tabUpdated(tabId);
  });
  let first = true;
  const refresh = async () => {
    try {
      const [t] = await chrome.tabs.query(windowId === null ? { active: true, currentWindow: true } : { active: true, windowId });
      setActive(t?.id ?? null, first);
      first = false;
    } catch {
      // The window is closing.
    }
  };
  try {
    const [current, tab] = await Promise.all([chrome.windows.getCurrent(), chrome.tabs.getCurrent()]);
    windowId = current.id ?? null;
    asTab = tab !== undefined;
  } catch {
    windowId = null;
  }
  hello();
  chrome.tabs.onActivated.addListener((info) => {
    if (windowId === null || info.windowId === windowId) setActive(info.tabId);
  });
  // A tab moved between windows, or the window regained focus: look again.
  chrome.tabs.onRemoved.addListener((tabId) => handsFree.tabClosed(tabId));
  chrome.tabs.onAttached.addListener(() => void refresh());
  chrome.tabs.onDetached.addListener(() => void refresh());
  chrome.windows.onFocusChanged.addListener(() => void refresh());
  await refresh();
}

function applyState(s: UiState): void {
  // An older state that arrived late (a slow answer after a newer push) would undo what the newer one says.
  if (isStale(s, state)) return;
  const was = state;
  state = s;
  setErrorFixes(errorFixes(s));
  header.render(s);
  autonomyWarning.render(s.settings);
  migrate.render(s.account);
  memoryAsk.render(s);
  voice.setAllowed(!!s.account?.signedIn && voiceAllowed(s.account.plan));
  if (voicePending) {
    voicePending = false;
    voice.shortcut();
  }
  chat.setRunning(s.runningSessions);
  composer.setRunning(s.runningSessions);
  handsFree.setRunning(s.runningSessions.map((r) => r.sessionId));
  composer.setState(s);
  data.setState(s);
  // Signed in or out, or another plan: the TODO list comes from elsewhere, or is (un)locked now.
  const a = was?.account;
  const b = s.account;
  if (was && (a?.signedIn !== b?.signedIn || a?.user?.email !== b?.user?.email || a?.plan?.id !== b?.plan?.id)) void data.loadTasks();
  if (pending && isBound(pending.sessionId, s)) pending = null;
  // The tab's own chat became another one (voice, the API, the agent): its job shows. When the panel opens it shows
  // the list, unless the tab's own chat is working right now (then that job).
  const own = ownChatOfTab(activeTab, s, { pending });
  if (own !== ownSeen) {
    const first = ownSeen === undefined;
    ownSeen = own;
    if (own && (!first || s.runningSessions.some((r) => r.sessionId === own))) showJob(keyOfSession(own));
  }
  if (nav.view.kind === "job") page.render();
}

function onPush(msg: UiPush): void {
  switch (msg.type) {
    case "state":
      applyState(msg.state);
      break;
    case "event":
      chat.onEvent(msg.event);
      handsFree.onEvent(msg.event);
      break;
    case "session":
      chat.onSession(msg.session);
      data.onSession(msg.session);
      if (page.sessionId() === msg.session.sessionId && nav.view.kind === "job") composer.setConversation(chat.shown() ?? msg.session);
      // A task's run ended: its task moved on (done, repeats, paused).
      if (msg.session.endedAt && msg.session.source !== "adhoc") void data.loadTasks();
      break;
    case "tasks.changed":
      void data.loadTasks();
      break;
    case "panel.focus":
    case "panel.restore":
      // The keyboard shortcut: the cursor in the box, in the view shown (a panel it recreated gets the text its box
      // had, and the job it showed; one it recreated in another window only those).
      if (msg.draft && !composer.draft()) composer.setDraft(msg.draft);
      if (msg.job && nav.view.kind === "list") showJob(msg.job);
      if (msg.type === "panel.restore") break;
      window.focus();
      composer.focus();
      break;
    case "panel.voice":
      // The voice shortcut (after panel.focus): hands-free on or off, as the mic button (see voice-input.ts shortcut()).
      if (state) voice.shortcut();
      else voicePending = true;
      break;
    case "voice.session":
      // Where hands-free voice is on (this panel, or another window's), and the tab the user looks at.
      handsFree.setSession(msg.session);
      break;
    case "voice.stop":
      handsFree.stopHere();
      break;
  }
}

/** Tells the background which window this panel is in (the keyboard shortcut acts on the window's panel), and which page it is. */
function hello(): void {
  if (windowId === null) return;
  port.send({ type: "panel.hello", windowId, panel: panelId, ...(asTab ? { asTab: true as const } : {}) });
  reportDocumentFocus();
  // A background that restarted meanwhile learns it again (the voice shortcut stops a listening panel).
  if (handsFree.active && listeningReport.listening) port.send(listeningReport);
}

/** Whether this page has the keyboard focus, for the shortcut (see panel-command.ts), with the text in the box and the job shown. */
function reportDocumentFocus(): void {
  const job = nav.jobKey;
  port.send({ type: "panel.document", focused: document.hasFocus(), draft: composer.draft(), ...(job ? { job } : {}) });
}
window.addEventListener("focus", reportDocumentFocus);
window.addEventListener("blur", reportDocumentFocus);

/** The keyboard shortcuts as Chrome assigned them (null: none is set), for the list's hint and the mic's tooltip. */
async function loadShortcuts(): Promise<void> {
  const [open, talk] = await Promise.all([readShortcut(OPEN_CHAT_COMMAND), readShortcut(VOICE_COMMAND)]);
  list.setShortcuts({ open, voice: talk });
  voice.setShortcut(talk);
}

async function loadState(): Promise<void> {
  try {
    applyState(await uiRequest({ type: "state.get" }));
    // Plan and credit may have changed elsewhere; the fresh state arrives as a push.
    void uiRequest({ type: "account.refresh" }).then(applyState, () => {});
  } catch (err) {
    header.unreachable(errorMessage(err));
  }
}

void data.load();
void trackTabs();
// Every (re)connect: say which window this is, and fetch the state.
const port = connectBackground(onPush, () => {
  hello();
  void loadState();
});
void loadShortcuts();
// Back from the dashboard's Billing page: a new plan or credit shows without Refresh (the push brings it).
refreshOnReturn(() => void uiRequest({ type: "account.refresh", force: true }).then(applyState, () => {}));
// The shortcut may have been changed on chrome://extensions/shortcuts meanwhile.
window.addEventListener("focus", () => void loadShortcuts());
// Opened (by the shortcut or the toolbar button): the list, with the cursor in the box.
list.show(nav.listPlace());
composer.focus();
setInterval(() => {
  data.tick();
  if (state) header.render(state);
}, CLOCK_TICK_MS);
