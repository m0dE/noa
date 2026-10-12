/**
 * A chat about a scheduled job (Talk about this on the job's page, SessionInfo.about): the job as the TODO list has
 * it now, for the agent's brief (core buildTaskReview) and for memory (the job's series, where what its runs did and
 * what the user wants of it are kept).
 *
 * The job is its series' waiting row (a repeat's next row has a new id); once none waits, its newest row (it is over:
 * the brief says so). Its latest runs are the series' finished rows, newest first.
 */
import { buildTaskReview, type TaskReview } from "@noa/core";
import {
  describeSchedule,
  errorMessage,
  localTimeZone,
  momentText,
  prefersHour12,
  WAITING_TASK_STATUSES,
  type LocalTask,
  type MemoryTaskRef,
  type TaskAbout,
} from "@noa/shared";
import type { TodoSource } from "../account/todo-source.js";

/** How many of its latest runs the agent is told of. */
const REVIEW_RUNS = 5;
/** What each run's line keeps of what it said. */
const RUN_SAID_CHARS = 200;

export interface TaskReviewDeps {
  todo(): Promise<TodoSource>;
  timeZone?(): string;
  now?(): Date;
  hour12?: boolean;
  log?(message: string): void;
}

/** What a turn of a chat about a job is given: the agent's brief, and the job for memory (null: it could not be read). */
export interface JobReview {
  text: string;
  task: MemoryTaskRef | null;
}

const waiting = (t: LocalTask) => (WAITING_TASK_STATUSES as readonly string[]).includes(t.status);
const seriesOf = (t: Pick<LocalTask, "id" | "seriesId">) => t.seriesId ?? t.id;
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The job `about` is, as the agent is told it. Never throws: a job that cannot be read gets the rules alone. */
export async function reviewJob(about: TaskAbout, deps: TaskReviewDeps): Promise<JobReview> {
  try {
    const job = await readJob(about, deps);
    if (!job) return { text: buildTaskReview(null), task: null };
    return { text: buildTaskReview(job.review), task: { instructions: job.row.instructions, account: job.row.account, seriesId: about.seriesId } };
  } catch (err) {
    deps.log?.(`reading the job ${about.seriesId} for its chat failed: ${errorMessage(err)}`);
    return { text: buildTaskReview(null), task: null };
  }
}

async function readJob(about: TaskAbout, deps: TaskReviewDeps): Promise<{ row: LocalTask; review: TaskReview } | null> {
  const todo = await deps.todo();
  const [list, page] = await Promise.all([todo.list(), todo.seriesPage(about.seriesId).catch(() => null)]);
  const rows = page?.tasks ?? [];
  const inSeries = (t: LocalTask) => t.id === about.taskId || seriesOf(t) === about.seriesId;
  const row = list.tasks.find((t) => inSeries(t) && waiting(t)) ?? rows.find(waiting) ?? rows[0] ?? list.tasks.find(inSeries);
  if (!row) return null;
  const now = deps.now?.() ?? new Date();
  const timeZone = deps.timeZone?.() ?? localTimeZone();
  const hour12 = deps.hour12 ?? prefersHour12();
  const over = !waiting(row);
  // A repeat: its rule, then its next run; once: when it runs.
  const schedule = describeSchedule(row.repeat ? { repeat: row.repeat } : row.notBefore ? { at: row.notBefore } : {}, { now, timeZone, hour12 });
  const next = row.repeat && !over && row.notBefore ? `; next run ${momentText(row.notBefore, now, timeZone, hour12)}` : "";
  const runs = rows
    .filter((t) => !waiting(t) && t.status !== "cancelled")
    .slice(0, REVIEW_RUNS)
    .map((t) => {
      const said = t.status === "done" ? t.resultSummary : t.status === "paused" ? t.pauseReason : t.failReason;
      return [momentText(t.updatedAt, now, timeZone, hour12), t.status, ...(said?.trim() ? [oneLine(said, RUN_SAID_CHARS)] : []), ...(t.resultUrl ? [t.resultUrl] : [])].join(" · ");
    });
  const review: TaskReview = {
    taskId: row.id,
    instructions: row.instructions,
    account: row.account,
    when: `${schedule}${next}`,
    runs,
    ...(row.status === "paused" && row.pauseReason ? { paused: row.pauseReason } : {}),
    ...(over ? { over: true } : {}),
  };
  return { row, review };
}
