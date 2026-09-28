/**
 * The pure rules of local tasks: checking what the user entered, the repeat
 * schedule (packages/shared schedule.ts, the same rules as the API's), and
 * how the end of a run changes a task.
 */
import {
  LegacyRepeatRule,
  legacyToRepeat,
  localTimeZone,
  MAX_ACCOUNT_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  nextOccurrence,
  RepeatSchedule,
  type LocalTask,
  type TaskRunResult,
} from "@noa/shared";

/** A local task fails for good after this many attempts. */
export const MAX_LOCAL_ATTEMPTS = 5;

/** A stored local task plus bookkeeping the UI may ignore. */
export type StoredLocalTask = LocalTask & {
  /** Set when a previous attempt was interrupted while running (crash, restart). */
  crashed?: boolean;
  /** Id of the next occurrence this (repeating) task already spawned. */
  nextId?: string | null;
};

export function cleanInstructions(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new Error("Instructions are empty");
  if (t.length > MAX_INSTRUCTIONS_CHARS) throw new Error(`Instructions are longer than ${MAX_INSTRUCTIONS_CHARS} characters`);
  return t;
}

export function cleanAccount(a: unknown): string | null {
  if (typeof a !== "string") return null;
  const t = a.trim();
  if (t.length > MAX_ACCOUNT_CHARS) throw new Error(`Account is longer than ${MAX_ACCOUNT_CHARS} characters`);
  return t || null;
}

export function cleanTime(t: unknown): string | null {
  if (t === null || t === undefined || t === "") return null;
  const d = new Date(String(t));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid time: ${String(t)}`);
  return d.toISOString();
}

/** A repeat rule as given: the current shape, or the old { dailyAt } (in this browser's zone). */
export function cleanRepeat(r: unknown): RepeatSchedule | null {
  if (r === null || r === undefined) return null;
  const legacy = LegacyRepeatRule.safeParse(r);
  if (legacy.success) return legacyToRepeat(legacy.data, localTimeZone());
  const parsed = RepeatSchedule.safeParse(r);
  if (!parsed.success) throw new Error(`Repeat rule: ${parsed.error.issues[0]?.message ?? "not valid"}`);
  return parsed.data;
}

/**
 * A task as stored before repeat rules became cron ({ dailyAt }, in the
 * browser's zone) in the current shape; others as they are. The store reads
 * every task through this, so the next write saves them migrated.
 */
export function migrateStoredTask(t: StoredLocalTask): StoredLocalTask {
  const legacy = LegacyRepeatRule.safeParse(t.repeat);
  return legacy.success ? { ...t, repeat: legacyToRepeat(legacy.data, localTimeZone()) } : t;
}

/**
 * The tasks with their series (Task.seriesId): one stored before tasks had a series gets the first row of its
 * repeat chain (a row's nextId is its repeat), else its own id. The store reads every task through this, so the next
 * write saves them with it.
 */
export function withSeries(tasks: StoredLocalTask[]): StoredLocalTask[] {
  if (tasks.every((t) => t.seriesId)) return tasks;
  const parentOf = new Map<string, StoredLocalTask>();
  for (const t of tasks) if (t.nextId) parentOf.set(t.nextId, t);
  const seriesOf = (t: StoredLocalTask): string => {
    let first = t;
    const seen = new Set([t.id]);
    for (let p = parentOf.get(first.id); !first.seriesId && p && !seen.has(p.id); p = parentOf.get(first.id)) {
      seen.add(p.id);
      first = p;
    }
    return first.seriesId ?? first.id;
  };
  return tasks.map((t) => (t.seriesId ? t : { ...t, seriesId: seriesOf(t) }));
}

export const byCreated = (a: StoredLocalTask, b: StoredLocalTask) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/**
 * The task after a run ended. retry: back to pending after retryAfterMinutes
 * (the reason is kept in failReason), or failed once MAX_LOCAL_ATTEMPTS is
 * reached. paused: waits for the user (tasks.retry).
 */
export function afterRun(t: StoredLocalTask, result: TaskRunResult, now: Date, retryAfterMinutes: number): StoredLocalTask {
  const base: StoredLocalTask = { ...t, updatedAt: now.toISOString(), crashed: false, retryAfter: null };
  switch (result.outcome) {
    case "done":
      return { ...base, status: "done", resultSummary: result.summary ?? null, resultUrl: result.url ?? null, failReason: null, pauseReason: null };
    case "failed":
      return { ...base, status: "failed", failReason: result.reason ?? "failed", pauseReason: null };
    case "paused":
      return { ...base, status: "paused", pauseReason: result.reason ?? "needs your attention" };
    default: {
      const reason = result.reason ?? "temporary problem";
      if (t.attempts >= MAX_LOCAL_ATTEMPTS) {
        return { ...base, status: "failed", failReason: `${reason} (gave up after ${t.attempts} attempts)`, pauseReason: null };
      }
      const retryAfter = new Date(now.getTime() + retryAfterMinutes * 60_000).toISOString();
      return { ...base, status: "pending", failReason: reason, retryAfter };
    }
  }
}

/**
 * The next occurrence of a repeating task that just ended done or failed:
 * pending at its rule's next time (one run fewer when counted), or null when
 * the rule is over (end date, run count).
 */
export function nextOccurrenceTask(t: StoredLocalTask & { repeat: RepeatSchedule }, id: string, now: Date): StoredLocalTask | null {
  const next = nextOccurrence(t.repeat, now);
  if (!next) return null;
  const nowIso = now.toISOString();
  return {
    ...t,
    id,
    seriesId: t.seriesId ?? t.id,
    status: "pending",
    attempts: 0,
    notBefore: next.at.toISOString(),
    repeat: next.repeat,
    retryAfter: null,
    resultSummary: null,
    resultUrl: null,
    pauseReason: null,
    failReason: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    crashed: false,
    nextId: null,
  };
}

/**
 * A task left running by a crash: back to pending with the crash marker, or
 * failed when out of attempts.
 */
export function afterCrash(t: StoredLocalTask, now: Date): StoredLocalTask {
  const reason = "interrupted (browser or extension stopped during the run)";
  if (t.attempts >= MAX_LOCAL_ATTEMPTS) {
    return { ...t, status: "failed", failReason: `${reason} (gave up after ${t.attempts} attempts)`, updatedAt: now.toISOString() };
  }
  return { ...t, status: "pending", crashed: true, failReason: reason, retryAfter: null, updatedAt: now.toISOString() };
}
