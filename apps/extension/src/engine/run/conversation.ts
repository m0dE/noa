/**
 * Conversations: a session's next turn after it ended. It continues in the
 * conversation's own agent session when that is still open (Claude Code kept
 * alive, or the Claude API history in memory), otherwise in a fresh one that
 * is told what was done so far. Either way its events append to the same
 * session, so the Activity view shows one thread.
 */
import { localTimeZone, type AgentTask, type ExtensionSettings, type SessionInfo, type StampedAgentEvent, type TaskRunResult, type UserTab } from "@noa/shared";
import { buildFollowUpMessage } from "@noa/core";
import { buildFollowUpInstructions, isContinuableOutcome } from "../../continue.js";
import { isContinuable, SessionEndedError, type Brain } from "../brains.js";
import type { LocalStore } from "../local-store.js";
import { mediaSources, withContext, type TurnJob } from "./jobs.js";
import { asksAboutThePage, isRestrictedUrl } from "../../restricted.js";
import type { MemoryRun } from "../../memory/service.js";
import type { JobReview } from "../task-review.js";
import { approvalsLine, runConfig, userTabOf, type ActiveSession, type Cleanup, type TurnRunner } from "./turn.js";

/** The message "Continue" sends when the user adds no note. */
export const CONTINUE_TEXT = "Continue from where you stopped.";
export const FRESH_SESSION_STATUS = "The earlier agent session has ended; starting a fresh one with a summary of the conversation";

/** What the brain's continue path is called in the Activity view. */
const SAME_SESSION: Record<string, string> = {
  "claude-code": "Continuing the same Claude Code session",
  "claude-api": "Continuing the same Claude API conversation",
};

/** Why "Continue" cannot apply to this session, or null when it can. */
export function continueRefusal(from: SessionInfo | null, sessionId: string, running: boolean): string | null {
  if (!from) return `No session ${sessionId}`;
  if (!from.endedAt) return running ? "That run is already running" : "That run has not ended yet";
  if (!isContinuableOutcome(from.outcome)) {
    return from.outcome === "done" ? "That run already finished; send a message to go on, or start a new task" : "That run cannot be continued";
  }
  if (from.source === "cloud") return "Cloud tasks continue from the queue; use Retry on the server";
  return null;
}

/**
 * Runs the turn's brain in the conversation's tab (the browser tab it belongs
 * to, else the tab it used): the same agent session when it is open, else a
 * fresh one (also when the brain finds the session gone).
 */
export async function runNextTurn(
  turns: TurnRunner,
  localStore: LocalStore,
  active: ActiveSession,
  job: TurnJob,
  brain: Brain,
  events: readonly StampedAgentEvent[],
  settings: ExtensionSettings,
  cleanups: Cleanup[],
): Promise<TaskRunResult> {
  const { from } = job;
  const sessionId = from.sessionId;
  const tab = await turns.tabOf(sessionId);
  // What the conversation's tab shows now. It may be a page Chrome keeps extensions out of: the turn goes on in a tab next to it.
  const page = tab === null ? null : await turns.pageOf(tab);
  // A chat about a scheduled job: the job as it is now (a fresh agent session is told it again; memory is the job's).
  const reviewReady = from.about ? turns.reviewOf(active, from.about) : null;
  // The conversation's own task (a TODO or cloud task) keeps its run notes in memory; a chat has none.
  const memoryRunOf = (review: JobReview | null): MemoryRun => ({
    ...(from.source === "adhoc" ? (review?.task ? { task: review.task, review: true } : {}) : { task: job.first }),
    title: from.title,
    request: job.text,
    ...(page ? { tabUrl: page.url, tabTitle: page.title } : {}),
  });
  const memoryWith = (r: JobReview | null, continued: boolean) => turns.memoryFor(active, continued ? { ...memoryRunOf(r), continued: true } : memoryRunOf(r));
  // Started at once (with the tab made ready), or once the job is read.
  const memoryFor = (continued: boolean) => (reviewReady ? reviewReady.then((r) => memoryWith(r, continued)) : memoryWith(null, continued));
  const sameSession = from.brain === brain.kind && isContinuable(brain) && brain.isOpen?.(sessionId) !== false;
  // Picked while the tab is made ready. The same agent session already has what earlier turns were given: only what
  // is new comes with this message.
  const memoryReady = memoryFor(sameSession);
  // A fresh agent session starts meanwhile: its process is ready when the task (with its memory) is.
  if (!sameSession) brain.prewarm?.(runConfig(settings, from.outcome !== "done"));
  let userTab: UserTab | undefined;
  if (tab === null) await turns.prepareTab(active, { mode: "own-tab" });
  else {
    const picked = await turns.prepareTab(active, { mode: "current-tab", tabId: tab });
    const restricted = !!page && isRestrictedUrl(page.url);
    await turns.follow(active, tab, picked, restricted, restricted && asksAboutThePage(job.text, !!job.screen));
    if (page) userTab = userTabOf(page, picked);
  }
  const attachments = await turns.attachmentsFor(active, brain, cleanups);
  if (active.forced) throw new Error(active.forced.reason);
  // What the agent gets: what the user's tab shows, then the message with its context (for an empty one: look at the page again).
  const message = { text: withContext(job.text, job.context), ...(job.screen ? { screenHelp: true } : {}) };
  // What waits for the user's approval this turn (the level may have changed since the last one).
  const approvals = approvalsLine(settings, active);
  const memory = sameSession ? await turns.timed(active, "memory.wait", () => memoryReady) : undefined;
  const text = buildFollowUpMessage({
    ...message,
    timeZone: localTimeZone(),
    ...(userTab ? { userTab } : {}),
    ...(approvals ? { approvals } : {}),
    ...(memory ? { memory } : {}),
  });
  // Scheduled runs hold what the task does not ask for: the task is the first turn's instructions plus this message.
  active.instructions = `${job.first.instructions}\n${job.text}`;
  // The brain echoes the message it got; the chat already shows the user's own words.
  active.said.push(text);
  if (sameSession && isContinuable(brain)) {
    turns.emit(active, { type: "status", text: SAME_SESSION[brain.kind] ?? "Continuing the same agent session" });
    try {
      const run = turns.continue(active, brain, { text, attachments, config: runConfig(settings, false), settings });
      return await turns.drive(active, run, settings, cleanups, true);
    } catch (err) {
      if (!(err instanceof SessionEndedError)) throw err;
    }
  }
  turns.emit(active, { type: "status", text: FRESH_SESSION_STATUS });
  // Nothing echoes the message in a fresh session.
  active.said = [];
  // The tab goes with the task (buildTaskPrompt), not inside the summary's quoted message; a job's chat tells the job again.
  const review = reviewReady ? await reviewReady : null;
  const told = review ? { ...message, text: `${message.text}\n\n${review.text}` } : message;
  const instructions = buildFollowUpInstructions({ instructions: job.first.instructions, account: job.first.account, session: from, events, text: buildFollowUpMessage(told) });
  const sources = job.task ? await mediaSources({ source: "local", task: job.task }, localStore) : [];
  const mediaPaths = await turns.materialize(active, sources, cleanups);
  // A fresh session is given what applies anew (when the open session turned out gone, picked again as a fresh one).
  const fresh = sameSession ? await memoryFor(false) : await turns.timed(active, "memory.wait", () => memoryReady);
  const task: AgentTask = { id: job.task?.id ?? sessionId, instructions, account: job.first.account, ...(userTab ? { userTab } : {}), ...(fresh ? { memory: fresh } : {}) };
  // After a stop, the agent first checks whether the work was already done.
  const seen = await turns.forFreshSession(brain, attachments);
  const run = turns.start(active, brain, { task, mediaPaths, attachments: seen, config: runConfig(settings, from.outcome !== "done"), settings });
  return turns.drive(active, run, settings, cleanups);
}
