/**
 * The one-click answer on a card a run paused for (paused.ts): the card's own buttons (Allow & continue, Don't) and
 * keys (Alt+Y, Alt+N), in place of "Continue, then Allow on a new card".
 *
 * - Allow & continue: the answer goes in the thread (the card says so), the action is allowed ahead once for the run
 *   that goes on (Preapprovals), and the run goes on: this browser's conversation continues where it paused; a run of
 *   the account's queue runs its task again now (the queue does not continue a conversation).
 * - Don't: the answer goes in the thread and the run ends as not done: a repeating task waits for its next time, a
 *   one-off task of the account is cancelled, one of this browser is kept paused until the user resumes it.
 */
import type { AgentEvent, ApprovalAnswer, ApprovalAnsweredBy, LocalTask, SessionInfo } from "@noa/shared";
import type { TodoSource } from "../account/todo-source.js";
import { pausedRequest, type Preapprovals } from "./paused.js";

export interface PausedDecisionDeps {
  session(sessionId: string): Promise<SessionInfo | null>;
  events(sessionId: string): Promise<readonly AgentEvent[]>;
  /** Adds the answer to the conversation (the card follows it). */
  note(sessionId: string, event: AgentEvent): Promise<unknown>;
  running(sessionId: string): boolean;
  preapprovals: Preapprovals;
  /** This browser's conversation goes on (Continue). */
  continueSession(sessionId: string): Promise<unknown>;
  /** The task runs again now (the account's queue claims it by id). */
  runTask(taskId: string): Promise<unknown>;
  todo(): Promise<TodoSource>;
}

/** Decides the card `id` of a paused run; false when it cannot be decided (not paused, decided, or the run went on). */
export async function decidePaused(deps: PausedDecisionDeps, sessionId: string, id: string, answer: ApprovalAnswer, by: ApprovalAnsweredBy): Promise<boolean> {
  if (deps.running(sessionId)) return false;
  const session = await deps.session(sessionId);
  const request = session ? pausedRequest(await deps.events(sessionId), id) : null;
  if (!session || !request) return false;
  const allow = answer !== "deny";
  await deps.note(sessionId, { type: "approval_resolved", id, outcome: allow ? "allow_once" : "deny", by });
  if (allow) {
    deps.preapprovals.grant([sessionId, session.taskId], request);
    if (session.source === "cloud" && session.taskId) await deps.runTask(session.taskId);
    else await deps.continueSession(sessionId);
    return true;
  }
  if (session.taskId) await notDone(await deps.todo(), session);
  return true;
}

/** Its task's paused row is not done: a repeating one waits for its next time, a one-off one does not run again by itself. */
async function notDone(todo: TodoSource, session: SessionInfo): Promise<void> {
  const rows: LocalTask[] = (await todo.seriesPage(session.seriesId ?? session.taskId!)).tasks;
  const row = rows.find((t) => t.id === session.taskId);
  if (row?.status !== "paused") return;
  if (row.repeat) await todo.resume(row.id);
  else if (todo.kind === "account") await todo.cancel(row.id);
  else await todo.pause(row.id);
}
