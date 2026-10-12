/**
 * What the jobs list and a job's page are made of, kept up to date: the sessions this browser has (newest first,
 * as many as it keeps), the TODO list (the signed-in account's, or this browser's), what runs now and which runs
 * wait for an approval. Jobs are made from it on demand (jobs.ts).
 *
 * A plan without the TODO list shows none of the account's tasks (the list is locked): its jobs are simply not
 * there; Schedule says what the plan lacks (schedule-sheet.ts).
 */
import { localTimeZone, readStoredRepeat, type SessionInfo } from "@noa/shared";
import { MAX_SESSIONS } from "../engine/sessions.js";
import type { JobDismissal, UiRequest, UiResults, UiState } from "../ui-protocol.js";
import { buildJobs, jobKeyOf, seriesOf, type Job, type JobTask } from "./jobs.js";

type Request = <R extends Extract<UiRequest, { type: "sessions.list" | "tasks.list" }>>(req: R) => Promise<UiResults[R["type"]]>;

export class JobData {
  private sessions = new Map<string, SessionInfo>();
  private tasks: JobTask[] = [];
  private running: readonly SessionInfo[] = [];
  private awaiting: readonly string[] = [];
  private dismissals: Readonly<Record<string, JobDismissal>> = {};
  /** Dismissals Undo can still take back (job-dismiss.ts): shown as done already. */
  private pendingDismissals: Readonly<Record<string, JobDismissal>> = {};
  private cache: Job[] | null = null;
  private readonly listeners = new Set<() => void>();
  private sessionTicket = 0;
  private taskTicket = 0;
  /** Where the TODO list comes from: the signed-in account, or this browser. */
  source: "local" | "account" = "local";
  /** The account's plan does not include the TODO list (its tasks are not shown). */
  locked = false;
  /** Locked: how many of its kept tasks wait to run (and cannot until the user subscribes); the header says so. */
  lockedWaiting = 0;
  /** Both lists were loaded once. */
  loaded = false;
  private sessionsLoaded = false;
  private tasksLoaded = false;

  constructor(
    private readonly request: Request,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Every job (see groupJobs for the list's order). */
  jobs(now = Date.now()): Job[] {
    this.cache ??= buildJobs(
      {
        sessions: [...this.sessions.values()],
        running: this.running,
        tasks: this.tasks,
        awaitingApproval: this.awaiting,
        dismissals: { ...this.dismissals, ...this.pendingDismissals },
      },
      now,
    );
    return this.cache;
  }

  job(key: string): Job | null {
    return this.jobs().find((j) => j.key === key) ?? null;
  }

  /** The job a session belongs to (it may not be listed yet: a chat just started is its own job). */
  keyOfSession(s: Pick<SessionInfo, "sessionId" | "source" | "taskId" | "seriesId">): string {
    return jobKeyOf(s, new Map(this.tasks.map((t) => [t.id, seriesOf(t)])));
  }

  session(sessionId: string): SessionInfo | null {
    return this.running.find((s) => s.sessionId === sessionId) ?? this.sessions.get(sessionId) ?? null;
  }

  async load(): Promise<void> {
    await Promise.all([this.loadSessions(), this.loadTasks()]);
  }

  async loadSessions(): Promise<void> {
    const ticket = ++this.sessionTicket;
    try {
      const { sessions } = await this.request({ type: "sessions.list", limit: MAX_SESSIONS });
      if (ticket !== this.sessionTicket) return;
      this.sessions = new Map(sessions.map((s) => [s.sessionId, s]));
      this.sessionsLoaded = true;
      this.changed();
    } catch (err) {
      this.onError(err);
    }
  }

  async loadTasks(): Promise<void> {
    const ticket = ++this.taskTicket;
    try {
      const res = await this.request({ type: "tasks.list" });
      if (ticket !== this.taskTicket) return;
      this.source = res.source ?? "local";
      this.locked = res.locked;
      this.lockedWaiting = res.locked ? res.tasks.filter((t) => t.status === "pending" || t.status === "paused").length : 0;
      // A rule stored before rules became cron ({ dailyAt }) reads as the same rule.
      this.tasks = res.locked ? [] : res.tasks.map((t) => ({ ...t, repeat: readStoredRepeat(t.repeat, localTimeZone()) }));
      this.tasksLoaded = true;
      this.changed();
    } catch (err) {
      this.onError(err);
    }
  }

  /** A session changed (a turn ended, a title was written): kept, or the list is loaded again when it is new. */
  onSession(s: SessionInfo): void {
    if (!this.sessions.has(s.sessionId) && this.sessionsLoaded) void this.loadSessions();
    this.sessions.set(s.sessionId, s);
    this.changed();
  }

  /** A session the user deleted. */
  forget(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.changed();
  }

  setState(state: Pick<UiState, "runningSessions" | "awaitingApproval" | "dismissals">): void {
    const sig = () => this.running.map((r) => `${r.sessionId}:${r.title}`).join() + `|${this.awaiting.join()}|${JSON.stringify(this.dismissals)}`;
    const before = sig();
    this.running = state.runningSessions;
    this.awaiting = state.awaitingApproval ?? [];
    this.dismissals = state.dismissals ?? {};
    // A run that just started may be one the list has not loaded yet.
    if (this.sessionsLoaded && this.running.some((r) => !this.sessions.has(r.sessionId))) void this.loadSessions();
    if (before !== sig()) this.changed();
  }

  /** Dismissals not committed yet (Undo can take them back): the list shows them done already. */
  setPendingDismissals(pending: Readonly<Record<string, JobDismissal>>): void {
    this.pendingDismissals = pending;
    this.changed();
  }

  /** The clock moved on: a waiting task's time may have come. */
  tick(): void {
    this.changed();
  }

  private changed(): void {
    this.cache = null;
    this.loaded = this.sessionsLoaded && this.tasksLoaded;
    for (const fn of this.listeners) fn();
  }
}
