import type { AgentAttachment } from "./attachments.js";
import type { AgentEvent } from "./events.js";
import type { TaskOutcome } from "./task.js";
import type { ReasoningLevel } from "./reasoning.js";

/** Native messaging host name registered with Chrome. */
export const NATIVE_HOST_NAME = "com.noa.helper";

/** Limits and options for one task run, sent by the extension with runTask. */
export interface RunConfig {
  maxToolCalls: number;
  /**
   * The brain's own limit on a turn's wall time: the extension sends TURN_WALL_MINUTES (turn-time.ts) and enforces
   * the user's limit (active time, waits left out) itself.
   */
  maxTaskMinutes: number;
  jevEnabled: boolean;
  jevThreshold: number;
  /** Jev key from the extension settings. The helper falls back to TYPESAFE_API_KEY. */
  jevApiKey?: string;
  /**
   * Claude model from the extension settings (e.g. "claude-sonnet-5"), so both
   * brains run the same model. The helper falls back to NOA_MODEL, then Claude Code's "sonnet" alias.
   */
  model?: string;
  /** The Reasoning setting (absent: the helper's NOA_THINKING, else DEFAULT_REASONING). */
  reasoning?: ReasoningLevel;
  /** Fast: raise reasoning when the run gets stuck (absent: true). */
  reasoningAutoRaise?: boolean;
  /**
   * True when an earlier attempt of this task may have crashed after acting.
   * The agent must first check whether the work was already done (for posts:
   * look for it on the profile) instead of repeating it.
   */
  isRetry: boolean;
}

/** The task as the agent sees it. */
export interface AgentTask {
  id: string;
  instructions: string;
  account: string | null;
  /**
   * The user sent an empty message in Chat (instructions: SCREEN_HELP_TEXT):
   * look at the page they are on and do what is needed next.
   */
  screenHelp?: boolean;
  /**
   * The browser tab the user's chat belongs to (the one they are looking at),
   * for a run started from it. Absent for runs without one (scheduled and
   * TODO tasks): the agent works in its own tab.
   */
  userTab?: UserTab;
  /**
   * The user's IANA time zone (the browser's): every turn's prompt states the
   * user's date and time in it (userTimeLine), for "after 3 hours" or
   * "tomorrow morning" in schedule_task.
   */
  timeZone?: string;
  /**
   * What the automation level asks of the agent (automationPromptLine, e.g.
   * "Approvals: actions that publish, send, pay ... wait for the user's OK").
   * Absent: nothing waits (full autonomy).
   */
  approvals?: string;
  /**
   * What the agent is given from memory this turn (the block of relevant entries the extension picked,
   * apps/extension/src/memory/select.ts). Absent: memory is off, or nothing applies.
   */
  memory?: string;
}

/** The tab a chat belongs to, as chrome.tabs reports it, and whether the run can work in it. */
export interface UserTab {
  url: string;
  title: string;
  /**
   * here: the run works in this tab. restricted: Chrome keeps extensions out
   * of the page (chrome://, the Web Store, ...), so the run works in a new tab
   * next to it. elsewhere: the run works in a new tab next to it for another
   * reason (another run is using it, or it cannot be controlled yet).
   */
  access: "here" | "restricted" | "elsewhere";
}

/** How a task run ended, as reported by either brain. */
export interface TaskRunResult {
  outcome: TaskOutcome;
  summary?: string;
  url?: string;
  reason?: string;
  /** The agent's proposed next request for the user (task_* `suggestion`), offered faded in the chat's input box. */
  suggestion?: string;
  /** The outcome in one or two spoken sentences (task_* `spoken`), read aloud in hands-free voice. */
  spoken?: string;
  /** A repeating task's note for its next run (task_complete `memory_note`), kept in memory as task history. */
  memoryNote?: string;
  /** What a repeating task's run published or sent (task_complete `output`), kept in its task history. */
  output?: string;
  logPath?: string;
}

/** What runs a helper's tasks: Claude Code, or the deterministic scripted brain (tests, NOA_BRAIN=scripted). */
export type HelperBrain = "claude" | "scripted";

export interface HelperInfo {
  version: string;
  jevAvailable: boolean;
  /** The helper's brain. Absent means "claude". */
  brain?: HelperBrain;
  /** Absolute path of claude.exe, or null when not found (always null with the scripted brain). */
  claudePath: string | null;
  logDir: string;
  /**
   * Claude Code task sessions whose agent is alive (running a turn, or idle
   * and kept open for follow-ups), so a reconnecting extension knows which
   * conversations can continue in their own session. Updates arrive as
   * helper.sessions notifications.
   */
  openSessions?: string[];
  /** Result of the startup self-test (one tiny headless Claude Code call), once it has run. */
  selfTest?: { ok: boolean; error?: string; ms: number; at: string };
}

/** error.code (see RpcError) of the helper's refusals that the extension acts on. */
export const HelperErrorCode = {
  /** continueSession: the session's agent is gone; start a fresh runTask. */
  sessionEnded: "session_ended",
  /** The session is already running a turn. */
  busy: "busy",
  /** continueSession with a blank message. */
  emptyMessage: "empty_message",
} as const;

/** RPC methods the extension calls on the helper. */
export type HelperMethods = {
  /** selfTest: run (or re-run) the Claude Code self-test before answering. */
  "helper.hello": { params: { selfTest?: boolean }; result: HelperInfo };
  /**
   * Run one task with Claude Code (headless, stream-json in and out; stdin
   * stays open so the session can take follow-up turns). Resolves when the
   * turn ends (up to maxTaskMinutes plus shutdown). Progress arrives as
   * helper.event notifications. mediaPaths are absolute local files the
   * extension prepared. attachments: files the user attached to the
   * conversation, sent ahead with helper.putAttachment (their `path` is left
   * out: the helper puts them in the session's attachments folder).
   */
  "helper.runTask": {
    params: { sessionId: string; task: AgentTask; mediaPaths: string[]; config: RunConfig; attachments?: AgentAttachment[] };
    result: TaskRunResult;
  };
  /**
   * The next user message in a session kept open after its turn (Claude Code
   * stays alive, idle, after each task_* call). Typed in as a follow-up, as a
   * new turn with this config's limits; resolves like runTask when the next
   * task_* call arrives. Rejects with code HelperErrorCode.sessionEnded when
   * the session's agent is gone (idle timeout, ended, crashed, or never kept
   * open): start a fresh runTask instead. Rejects with HelperErrorCode.busy
   * while another turn runs.
   */
  "helper.continueSession": { params: { sessionId: string; text: string; config: RunConfig; attachments?: AgentAttachment[] }; result: TaskRunResult };
  /**
   * One piece of a file the user attached, for a session's next runTask or continueSession (which name it in
   * `attachments`). Pieces come in order: offset is the bytes already sent (0 starts the file over); each is at
   * most ATTACHMENT_CHUNK_BYTES. size: the bytes the helper holds of it now.
   */
  "helper.putAttachment": { params: { sessionId: string; id: string; offset: number; dataBase64: string }; result: { size: number } };
  /**
   * Start the next new session's agent ahead (the side panel opened), with
   * this config's model, Reasoning and Jev: the next runTask then skips
   * starting Claude Code (~0.65 s). It uses no tokens while it waits and
   * stops after 10 minutes unused. ok: false when the brain starts nothing
   * ahead (scripted, or Claude Code missing).
   */
  "helper.prewarm": { params: { config: RunConfig }; result: { ok: boolean } };
  /**
   * Close a kept-open session (Claude Code exits). Sessions also close after
   * 30 idle minutes, on helper shutdown, and when a 4th would open (the
   * oldest idle one closes).
   * ok: false when there was no such session.
   */
  "helper.endSession": { params: { sessionId: string }; result: { ok: boolean } };
  /** Type a message into the running task's Claude Code session. */
  "helper.sendUserMessage": { params: { sessionId: string; text: string }; result: { ok: boolean } };
  /** Stop the running task now and report it as paused with this reason. */
  "helper.forcePause": { params: { sessionId: string; reason: string }; result: { ok: true } };
  /** Stop the running task now and report it as failed. */
  "helper.abortTask": { params: { sessionId: string; reason: string }; result: { ok: true } };
  "helper.getLog": { params: { lines: number }; result: { text: string } };
  /**
   * The tail of a task session's run log (TaskRunResult.logPath, JSONL of
   * every Claude Code stream event, tool call and result). Only paths inside
   * the helper's runs folder. maxBytes: at most 256 KB (the default).
   */
  "helper.runLog": { params: { path: string; maxBytes?: number }; result: { text: string; truncated: boolean } };
  /**
   * The background memory writer on Claude Code (memory-writer.ts): one headless `claude -p` call on the cheapest
   * model with this system prompt and prompt, on the user's own Claude Code login. text: the model's answer;
   * costUsd: what Claude Code reports it cost. Rejects when Claude Code fails or takes longer than
   * MEMORY_SUMMARIZE_TIMEOUT_MS.
   */
  "memory.summarize": { params: { system: string; prompt: string }; result: { text: string; costUsd?: number } };
};

/** Notifications the helper sends to the extension (no reply). */
export type HelperNotifications = {
  "helper.event": { sessionId: string; event: AgentEvent };
  /** The open task sessions changed (one started, or one closed: ended, idle timeout, crash, abort). */
  "helper.sessions": { open: string[] };
};
