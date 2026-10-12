/**
 * Contract between the UI pages (side panel, options) and the background
 * service worker. Requests go through chrome.runtime.sendMessage and always
 * resolve to UiResponse. Live updates go over a long-lived port named
 * UI_PORT_NAME that the side panel opens; the background pushes UiPush
 * messages on it. The options page opens OPTIONS_PORT_NAME and gets only
 * the state pushes (e.g. the credit after a run).
 */
import type {
  ApprovalAnswer,
  ApprovalAnsweredBy,
  BrainKind,
  ExtensionSettings,
  HelperInfo,
  LocalTask,
  MemoryEntry,
  RepeatSchedule,
  SessionInfo,
  StampedAgentEvent,
  TaskAbout,
  TraceEvent,
} from "@noa/shared";
import type { TraceBook } from "./trace/trace-book.js";
import type { MemorySyncStatus } from "./memory/sync.js";
import type { RealtimeTicketResult, VoiceEnginesResult } from "./voice/realtime-access.js";
import type { VoiceSpeakResult } from "./voice/deepgram-speaker.js";
import type { VoiceClipRequest, VoiceTranscribeResult } from "./voice/transcribe.js";
import type { VoiceSessionView } from "./voice-session.js";
import type { CreditInfo, PlanId, PlanInfo } from "./account/types.js";

export type { CreditInfo, PlanId, PlanInfo };

export const UI_PORT_NAME = "noa-ui";
/** The options page's port: state pushes only (it is not a side panel). */
export const OPTIONS_PORT_NAME = "noa-options";

/** A file the user attached to a local task, sent from the UI as base64. */
export interface UiMediaUpload {
  name: string;
  type: string;
  dataBase64: string;
}

/**
 * A file attached to a chat message, prepared in the side panel (attachments/prepare.ts): an image already brought
 * to the model's size (width, height, thumb), a document's text read out (text: what the model reads; note: e.g.
 * that secrets in it were replaced).
 */
export interface UiAttachmentUpload {
  name: string;
  type: string;
  dataBase64: string;
  width?: number;
  height?: number;
  /** A small JPEG data URL of an image, for the chat's bubble. */
  thumb?: string;
  text?: string;
  note?: string;
}

/**
 * An edit of a task that is not running: only the fields given change (null
 * clears). A new repeat rule goes with its first time (notBefore; none: its
 * next time); notBefore alone moves only the time.
 */
export interface TaskPatch {
  instructions?: string;
  account?: string | null;
  notBefore?: string | null;
  repeat?: RepeatSchedule | null;
  /**
   * Who wrote the instructions (Task.agentAuthored): true from the agent's TODO tools, false from Trust on the row.
   * Absent: kept, unless the instructions change (then they are the user's).
   */
  agentAuthored?: boolean;
}

export interface LocalMediaInfo {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface BrainStatus {
  /** What "auto" (or the chosen mode) resolves to right now; null = nothing usable. */
  effective: BrainKind | null;
  /** Human-readable reason when effective is null or differs from the choice. */
  note?: string;
  helper: HelperInfo | null;
  helperError?: string;
  hasApiKey: boolean;
  /** Jev is on and the effective brain has a Jev (jevSource). */
  jevActive: boolean;
  /** Where the effective brain's Jev comes from (jevSourceFor), Jev on or off; absent: it has none. */
  jevSource?: JevSource;
}

/** A Jev key in Settings, the helper's own key, or Noa's cloud Jev (billed to usage credit). */
export type JevSource = "key" | "helper" | "cloud";

/** The Noa account (Google sign-in) as the UI shows it. */
export interface AccountView {
  signedIn: boolean;
  /** This build has a Google client ID (else Log In explains that sign-in is not set up). */
  signInConfigured: boolean;
  /** The account server (setting accountApiBase). */
  apiBase: string;
  /** The dashboard's home (usage), at the account server's origin (account/dashboard.ts). */
  dashboardUrl: string;
  /** The dashboard's Billing page: plans, top-ups and invoices. Every upgrade button opens it (ui/billing.ts). */
  billingUrl: string;
  /** The dashboard's Files page: the account's cloud files (the folder button opens it when the plan has them). */
  filesUrl: string;
  user?: { email: string; name: string | null; pictureUrl: string | null };
  /** Missing while the server has no billing (or it could not be loaded). */
  plan?: PlanInfo;
  credit?: CreditInfo;
  /** false: the server has no Stripe (billing buttons say so instead). undefined: not known yet. */
  stripeConfigured?: boolean;
  /** Loading the account failed (offline, server error). */
  error?: string;
  fetchedAt?: string;
  /** The hosted AI refused a request for lack of credit (or the credit is 0). */
  outOfCredit?: true;
  /** Pending or paused local tasks that can be moved into the account (the offer after sign-in). */
  localTasks?: number;
}

/**
 * A job the user cleared from the list (sidepanel/jobs.ts): `needs` is the need they dismissed (it moves to Recent;
 * a new one shows again), `archivedAt` the job's last activity when they put it away (it leaves the list until it
 * does something again).
 */
export interface JobDismissal {
  /** When the user did it (ISO). */
  at: string;
  needs?: string;
  archivedAt?: string;
}

export interface UiState {
  /**
   * When the background read this state (increasing, a clock in ms): a UI keeps the state with the highest rev,
   * since pushes and request answers can reach it out of order. Absent in states made up by tests.
   */
  rev?: number;
  /** Secrets redacted to "set" / "" (see redactSettings). */
  settings: ExtensionSettings;
  brain: BrainStatus;
  /** The session started last among those running (null when idle). */
  running: SessionInfo | null;
  /** Every running session, oldest first: several tasks can run at once, each in its own tab. */
  runningSessions: SessionInfo[];
  /**
   * The old pause of every scheduled run is not converted into paused jobs yet (engine/pause-migration.ts): the
   * account's jobs do not run until it is; why, in words. Absent: nothing waits.
   */
  pauseMigration?: string;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
  /**
   * Conversations whose agent session is still open (a kept-open Claude Code
   * session in the helper, or Claude API history in memory): their next
   * message continues in that session. Others continue in a fresh session
   * that gets a summary.
   */
  openConversations: string[];
  /** Absent from older backgrounds: treated as signed out. */
  account?: AccountView;
  /**
   * Which conversation belongs to which browser tab (tab id -> session id):
   * the side panel shows the conversation of the tab active in its window.
   */
  tabChats?: Record<string, string>;
  /** The tabs each running session acts in right now (session id -> tab ids, the one it acts on now first). */
  runningTabs?: Record<string, number[]>;
  /** The tabs each chat's agent opened and keeps open while no turn of it runs (session id -> tab ids). */
  chatTabs?: Record<string, number[]>;
  /** Conversations with an action waiting for the user's OK (an approval card): listed under Needs you. Absent: none. */
  awaitingApproval?: string[];
  /** What the user cleared from the jobs list (job key -> dismissal; job-dismissals.ts). Absent: nothing. */
  dismissals?: Record<string, JobDismissal>;
  /**
   * Signed in to another account than this computer's memory was synced with: nothing is sent until the user
   * answers "Add this computer's memory to <account>?" (memory.syncChoice). Absent: nothing to ask.
   */
  memoryQuestion?: { account: string };
  /** Past chats being summarized into episodes in the background (Settings > Memory shows it). Absent: none. */
  memoryBackfill?: { done: number; total: number };
}

export type UiRequest =
  | { type: "state.get" }
  /** Partial update. Secret fields: omit to keep, "" to clear, a value to set. */
  | { type: "settings.save"; settings: Partial<ExtensionSettings> }
  | { type: "settings.testClaude" }
  | { type: "settings.testJev" }
  | { type: "helper.connect" }
  /** Start a one-off task now ("Do this now"). tabId: the browser tab it is started from (it acts there, the chat belongs to it). */
  | {
      type: "run.adhoc";
      instructions: string;
      account?: string;
      /** Files attached to the message (the agent sees or reads them, and can upload them to pages). */
      attachments?: UiAttachmentUpload[];
      tabId?: number;
      /** An empty message in Chat: look at the tab's page and do what is needed (instructions may be empty). */
      screen?: boolean;
      /** Correlation id of this message in the conversation's trace (the panel's own timings of it carry the same). */
      cid?: string;
      /** The new chat was started with memory off (its SessionInfo.memoryOff). */
      memoryOff?: true;
      /** A chat about this scheduled job (Talk about this on its page; SessionInfo.about). */
      about?: TaskAbout;
    }
  /** Run everything that is due now (local, then cloud if enabled). */
  | { type: "run.due" }
  /** Stop one session (its current turn is paused), or everything running and the due run. */
  | { type: "run.stop"; sessionId?: string }
  /**
   * Continue a run that ended paused, failed or retry (e.g. stopped by the
   * user): the next turn of that conversation. text: an optional note.
   */
  | { type: "run.continue"; sessionId: string; text?: string; tabId?: number; attachments?: UiAttachmentUpload[] }
  /**
   * The user's message in a conversation: typed into its turn while one
   * runs, else its next turn (same session when still open, else a fresh one
   * with a summary). No sessionId: starts a new one-off conversation.
   * screen with an empty text: "look at the page and do what is needed"
   * (a new conversation, or the next turn: "look at the page now and continue").
   * tabId: the browser tab the message was sent from; the conversation
   * belongs to it (and a new one acts there). voice: the text was spoken.
   * context: what the agent is told with the message but the chat does not show as the user's words (hands-free:
   * the note on the tab the user looks at).
   */
  | {
      type: "run.message";
      sessionId?: string;
      text: string;
      tabId?: number;
      screen?: boolean;
      voice?: boolean;
      /** Spoken with Realtime: the user's words for the request (text), word for word, each part of their speech in order. */
      heard?: string[];
      cid?: string;
      memoryOff?: true;
      context?: string;
      /** Files attached to the message; refused while the conversation's turn runs (they go with a new turn). */
      attachments?: UiAttachmentUpload[];
    }
  /**
   * The conversation is over (a new job took its tab): close its kept-open agent session and tabs (a running turn
   * keeps running). tabId: that tab has no conversation any more.
   */
  | { type: "run.newChat"; sessionId?: string; tabId?: number }
  /** A job opened in the side panel: its conversation now belongs to this browser tab (it leaves any other tab). */
  | { type: "chat.bind"; sessionId: string; tabId: number }
  /** Dismissals of jobs, by job key (added to those kept). */
  | { type: "jobs.dismiss"; dismissals: Record<string, JobDismissal> }
  /** Undo on a scheduled card: the task the agent put in the TODO list (schedule_task) is deleted, and the card says so. */
  | { type: "chat.undoScheduled"; sessionId: string; taskId: string }
  /** Undo on a changed or cancelled card: the task the agent changed (update_scheduled_task, cancel_scheduled_task) goes back as it was. */
  | { type: "chat.undoTaskChange"; sessionId: string; changeId: string }
  /** Undo on a "Remembered" note: that memory change is undone (the entry is as it was before), and the note says so. */
  | { type: "memory.undo"; sessionId: string; changeId: string }
  /** Redo on an undone memory note: the change is made again (the entry is as it was after it), and the note says so. */
  | { type: "memory.redo"; sessionId: string; changeId: string }
  /** Memory on or off for one conversation (the composer's menu). */
  | { type: "chat.setMemory"; sessionId: string; on: boolean }
  /** Settings > Memory: every entry the agent keeps. */
  | { type: "memory.list" }
  /** The user's edit of an entry (refused when it holds a secret). */
  | { type: "memory.edit"; id: string; subject: string; text: string }
  | { type: "memory.delete"; id: string }
  /** Settings > Memory: give this entry at the start of every turn (pinned), or only when it is relevant. */
  | { type: "memory.pin"; id: string; pinned: boolean }
  /** Delete everything one repeating task keeps (its run notes and records). */
  | { type: "memory.deleteTask"; taskKey: string }
  /** A task's details: its previous runs (dates, notes, outputs) as its memory keeps them. */
  | { type: "memory.taskRuns"; task: { instructions: string; account: string | null; seriesId?: string | null } }
  /** Forget everything. */
  | { type: "memory.clear" }
  /** The answer to "Add this computer's memory to <account>?" (UiState.memoryQuestion): add it, or keep it separate. */
  | { type: "memory.syncChoice"; add: boolean }
  /**
   * The user's answer on an approval card (or by voice): the waiting action runs or is refused. On a card its run
   * paused for: allow goes on with that action allowed once, deny ends the run as not done (paused-decision.ts).
   */
  | { type: "approval.answer"; sessionId: string; id: string; answer: ApprovalAnswer; by?: ApprovalAnsweredBy }
  /** Switch to a browser tab (another tab's chat): activates it and focuses its window. */
  | { type: "tab.focus"; tabId: number }
  /** Bring the agent's tab to the front: the session's, or the first agent tab. */
  | { type: "agent.show"; sessionId?: string }
  /** Open the user's Noa folder (Downloads/Noa) in the system's file manager, creating it first. */
  | { type: "folder.open" }
  /** Type into a running agent session (default: the one started last). */
  | { type: "run.say"; text: string; sessionId?: string }
  /** Try again to pause the account's jobs for the old pause of every scheduled run (UiState.pauseMigration). */
  | { type: "pause.migrate" }
  | { type: "tasks.list" }
  | {
      type: "tasks.add";
      instructions: string;
      account?: string;
      notBefore?: string;
      repeat?: RepeatSchedule;
      media?: UiMediaUpload[];
    }
  | { type: "tasks.update"; id: string; patch: TaskPatch }
  /** Run on a TODO row: that task now, whatever its time (a stopped one starts over). */
  | { type: "tasks.run"; id: string }
  | { type: "tasks.delete"; id: string }
  | { type: "tasks.retry"; id: string }
  /** Account tasks only: pending or paused tasks stop without running. */
  | { type: "tasks.cancel"; id: string }
  /** Pause a waiting job: it does not run (nor its repeats) until resumed. */
  | { type: "tasks.pause"; id: string }
  /** A paused job waits for its time again (a repeating one whose time went by: its next time). */
  | { type: "tasks.resume"; id: string }
  /** A page of one series' rows (a repeating job's runs), newest first; cursor: the nextCursor of the page before. */
  | { type: "tasks.series"; seriesId: string; cursor?: string }
  /** Google sign-in (opens Google's window), then the account's state. */
  | { type: "account.signIn" }
  | { type: "account.signOut" }
  /** Refetch profile, plan and credit (force: even when fetched a moment ago). */
  | { type: "account.refresh"; force?: boolean }
  /** Move the pending and paused local tasks (with files) into the account. */
  | { type: "account.migrate" }
  /** "Not now" on the offer to move local tasks. */
  | { type: "account.dismissMigration" }
  /** Newest first; taskId: only that task's runs. Chats still titled with their request get a title in the background. */
  | { type: "sessions.list"; limit?: number; taskId?: string }
  /** The user's name for a chat (the job's Rename): kept, never replaced by the title model. */
  | { type: "session.rename"; sessionId: string; title: string }
  /** Delete a conversation that is not running (the job's Delete): its events, trace and files; no tab keeps it. */
  | { type: "session.delete"; sessionId: string }
  | { type: "sessions.events"; sessionId: string }
  /** Site logins for get_credential (never used for X). Encrypted; unlocked per browser session. */
  | { type: "vault.list" }
  | { type: "vault.unlock"; passphrase: string }
  | { type: "vault.lock" }
  | { type: "vault.set"; site: string; username: string; password: string }
  | { type: "vault.delete"; site: string }
  /** Erase every saved login and the passphrase (the only way out of a forgotten passphrase). */
  | { type: "vault.reset" }
  /** Standard hands-free voice: one clip of the live transcription to text, with the signed-in account (see voice/transcribe.ts). */
  | ({ type: "voice.transcribe" } & VoiceClipRequest)
  /** Hands-free voice: the engines and what a minute of each costs (the account server's list). */
  | { type: "voice.engines" }
  /** Realtime voice: where to connect and the token to offer (sessionId: the chat, recorded with the usage). */
  /** tier "mini": the realtime-mini engine (the server's smaller model). */
  | { type: "voice.realtime"; sessionId?: string; tier?: "mini" }
  /** A sample notification, heard as Settings say (notify.ts). */
  | { type: "notify.test" }
  /** Deepgram's voice: `text` said in `voice` (MP3, base64), with the signed-in account. */
  | { type: "voice.speak"; text: string; voice: string; sessionId?: string }
  /** Hands-free voice said a line in this conversation: kept in its thread (a "spoken" event). */
  | { type: "voice.spoken"; sessionId: string; text: string }
  /** What the user said in Realtime hands-free voice that led to no request, word for word: kept for the record (a "heard" event). */
  | { type: "voice.heard"; sessionId: string; text: string }
  /** The side panel's timings of a conversation (voice, sending), for its trace. */
  | { type: "trace.add"; sessionId: string; events: TraceEvent[] }
  /** The Raw view: the whole conversation, its timing trace, and what it ran on. */
  | { type: "trace.get"; sessionId: string };

export type UiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** How run.message delivered the user's text. */
export type MessageMode =
  /** Typed into the turn that is running. */
  | "inject"
  /** A new turn of an ended conversation (in its own agent session when it is still open, else a fresh one with a summary). */
  | "turn"
  /** No conversation given: a new one-off conversation. */
  | "new";

/** Result data per request type. */
export interface UiResults {
  "state.get": UiState;
  "settings.save": UiState;
  "settings.testClaude": { ok: boolean; detail: string };
  "settings.testJev": { ok: boolean; detail: string };
  "helper.connect": UiState;
  "run.adhoc": { sessionId: string };
  "run.due": { started: boolean; detail?: string };
  "run.stop": { ok: boolean };
  /** The conversation's session id (the same one). */
  "run.continue": { sessionId: string };
  "run.message": { sessionId: string; mode: MessageMode };
  "run.newChat": { ok: boolean };
  "chat.bind": UiState;
  "jobs.dismiss": UiState;
  "chat.undoScheduled": { ok: boolean };
  "chat.undoTaskChange": { ok: boolean };
  "memory.undo": { ok: boolean };
  "memory.redo": { ok: boolean };
  "chat.setMemory": { session: SessionInfo };
  /** sync: whether memory syncs with the account (absent: this build has no sync). */
  "memory.list": { entries: MemoryEntry[]; sync?: MemorySyncStatus };
  "memory.edit": { entry: MemoryEntry };
  "memory.delete": { ok: boolean };
  "memory.pin": { entry: MemoryEntry };
  /** How many entries went. */
  "memory.deleteTask": { removed: number };
  /** Newest first; the task's earlier-runs summary (folded runs) last. */
  "memory.taskRuns": { runs: MemoryEntry[] };
  /** How many entries were forgotten. */
  "memory.clear": { removed: number };
  /** Whether memory syncs now. */
  "memory.syncChoice": { sync: MemorySyncStatus };
  /** ok false: the request no longer waits (answered, timed out, its turn ended, or its paused run was decided or went on). */
  "approval.answer": { ok: boolean };
  "tab.focus": { ok: boolean };
  "agent.show": { ok: boolean };
  /** path: the folder's absolute path. */
  "folder.open": { path: string };
  "run.say": { ok: boolean };
  "pause.migrate": UiState;
  /** source: the signed-in account's tasks, or this browser's (signed out). */
  /** locked: the account's plan does not include the TODO list; the tasks are read-only until the user subscribes. */
  "tasks.list": { tasks: (LocalTask & { media: LocalMediaInfo[] })[]; locked: boolean; source?: "local" | "account" };
  "tasks.add": { task: LocalTask };
  "tasks.update": { task: LocalTask };
  "tasks.run": { sessionId: string };
  "tasks.delete": { ok: boolean };
  "tasks.retry": { task: LocalTask };
  "tasks.cancel": { task: LocalTask };
  "tasks.pause": { task: LocalTask };
  "tasks.resume": { task: LocalTask };
  /** nextCursor null: the last page. */
  "tasks.series": { tasks: LocalTask[]; nextCursor: string | null };
  "account.signIn": UiState;
  "account.signOut": UiState;
  "account.refresh": UiState;
  "account.migrate": { moved: number; failed: number; errors: string[]; state: UiState };
  "account.dismissMigration": UiState;
  "sessions.list": { sessions: SessionInfo[] };
  "session.rename": { session: SessionInfo };
  "session.delete": { ok: boolean };
  "sessions.events": { session: SessionInfo; events: StampedAgentEvent[] };
  /** exists: a passphrase has been set; false: the next unlock chooses one. Site names are listed even while locked. */
  "vault.list": { exists: boolean; locked: boolean; sites: string[] };
  /** ok: false is a wrong passphrase (other failures are errors). */
  "vault.unlock": { ok: boolean };
  "vault.lock": { ok: boolean };
  "vault.set": { ok: boolean };
  "vault.delete": { ok: boolean };
  "vault.reset": { ok: boolean };
  /** Failures come back as data (plan, credit, ...), not as a failed request. */
  "voice.transcribe": VoiceTranscribeResult;
  "voice.engines": VoiceEnginesResult;
  "voice.realtime": RealtimeTicketResult;
  "voice.speak": VoiceSpeakResult;
  "notify.test": { ok: true };
  "voice.spoken": { ok: boolean };
  "voice.heard": { ok: boolean };
  "trace.add": { ok: boolean };
  "trace.get": RawTrace;
}

/** What the background knows about where a conversation ran (the panel adds its own: voice, display). */
export interface TraceEnv {
  extensionVersion: string;
  /** The browser as it names itself (navigator.userAgent) and the OS (chrome.runtime.getPlatformInfo). */
  userAgent: string;
  os?: string;
  arch?: string;
  helper: { version: string; brain: string; jev: boolean } | null;
}

/** trace.get: a conversation in full (events as stored), with its timing trace. */
export interface RawTrace {
  session: SessionInfo;
  events: StampedAgentEvent[];
  /** Null for conversations from before traces were kept. */
  trace: TraceBook | null;
  env: TraceEnv;
}

/** Pushed by the background on the UI port. */
export type UiPush =
  | { type: "state"; state: UiState }
  | { type: "event"; event: StampedAgentEvent }
  | { type: "session"; session: SessionInfo }
  | { type: "tasks.changed" }
  /**
   * A keyboard shortcut: put the cursor in the input (see panel-command.ts); `draft` and `job`: the text the box had
   * and the job the page showed before the shortcut recreated the panel.
   */
  | { type: "panel.focus"; draft?: string; job?: string }
  /** A window's side panel the shortcut recreated from another window: the text its box had and the job it showed, without the focus. */
  | { type: "panel.restore"; draft?: string; job?: string }
  /** The voice shortcut: hands-free voice on or off (as the mic button). */
  | { type: "panel.voice" }
  /** The hands-free session (null: none is on), and the tab the user looks at: when it changes, and when a panel connects. */
  | { type: "voice.session"; session: VoiceSessionView | null }
  /** To the panel running the hands-free session: end it (Stop, or Use voice here, in another panel). */
  | { type: "voice.stop" };

/** Typed helper for UI pages. */
export async function uiRequest<R extends UiRequest>(req: R): Promise<UiResults[R["type"]]> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResponse<UiResults[R["type"]]> | undefined;
  if (!res) throw new Error("No response from the extension background");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** `next` is older than the state the UI has (see UiState.rev). */
export function isStale(next: Pick<UiState, "rev">, current: Pick<UiState, "rev"> | null): boolean {
  return next.rev !== undefined && current?.rev !== undefined && next.rev < current.rev;
}
