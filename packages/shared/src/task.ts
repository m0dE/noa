import { z } from "zod";
import { LegacyRepeatRule, legacyToRepeat, RepeatSchedule, ScheduleInput, TaskSchedule } from "./schedule.js";
import { TimeZone } from "./zoned-time.js";

/** Lifecycle of a task stored in the cloud API. */
export const TaskStatus = z.enum(["pending", "running", "done", "failed", "paused", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const MAX_INSTRUCTIONS_CHARS = 8000;
export const MAX_BATCH_TASKS = 100;
/** Files one task can carry (images, videos, documents the agent uses). */
export const MAX_MEDIA_PER_TASK = 10;
/** Length of a task's account label. */
export const MAX_ACCOUNT_CHARS = 100;
/** Lengths of a reported result's fields (ResultInput). */
export const MAX_RESULT_SUMMARY = 4000;
export const MAX_RESULT_URL = 2000;
export const MAX_RESULT_REASON = 4000;

/** An X-style handle or any account label the agent should switch to. */
const Account = z.string().trim().min(1).max(MAX_ACCOUNT_CHARS);

const NotBefore = z.iso.datetime({ offset: true });

const TaskFields = z.object({
  instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS_CHARS),
  account: Account.optional(),
  mediaIds: z.array(z.string().min(1)).max(MAX_MEDIA_PER_TASK).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  /** When it runs: once at `at` (default: as soon as possible), and again by `repeat`. See schedule.ts. */
  schedule: ScheduleInput.optional(),
  /** Legacy, still accepted: the same as schedule.at. */
  notBefore: NotBefore.optional(),
  /** Legacy, still accepted: { dailyAt: ["09:00"] }, converted to schedule.repeat. null = no repeat. */
  repeat: LegacyRepeatRule.nullable().optional(),
  /** Legacy, still accepted: the IANA time zone of `repeat` (default "UTC"). */
  tz: TimeZone.nullable().optional(),
  /** See Task.agentAuthored. Omitted on a create: false; on an update that changes the instructions: false. */
  agentAuthored: z.boolean().optional(),
});

const LEGACY_SCHEDULE_FIELDS = ["notBefore", "repeat", "tz"] as const;

/** `schedule` replaces notBefore, repeat and tz: a request uses one or the other. */
function oneScheduleShape(t: { schedule?: unknown } & Partial<Record<(typeof LEGACY_SCHEDULE_FIELDS)[number], unknown>>, ctx: z.RefinementCtx) {
  if (t.schedule === undefined) return;
  const legacy = LEGACY_SCHEDULE_FIELDS.filter((k) => t[k] !== undefined);
  if (legacy.length) ctx.addIssue({ code: "custom", path: ["schedule"], message: `use schedule or ${legacy.join(", ")}, not both` });
}

/** A runner: one browser's runnerId (ClaimInput.runnerId). */
const RunnerId = z.string().min(1).max(100);

/** Body of POST /v1/tasks and each item of POST /v1/tasks/batch. */
export const CreateTaskInput = TaskFields.extend({
  /** See Task.runnerId: the browser creating the task keeps its runs. Omitted: the first runner to claim it. */
  runnerId: RunnerId.optional(),
}).superRefine(oneScheduleShape);
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const BatchCreateInput = z.object({
  tasks: z.array(CreateTaskInput).min(1).max(MAX_BATCH_TASKS),
});
export type BatchCreateInput = z.infer<typeof BatchCreateInput>;

/**
 * Body of PATCH /v1/tasks/:id. Only allowed while pending or paused. Omit a
 * field to keep it; `account: null` clears it. `schedule` replaces the whole
 * schedule (null: once, as soon as possible); the legacy fields change one
 * part each (`notBefore: null` clears it; `tz` alone moves the repeat rule).
 */
export const UpdateTaskInput = TaskFields.extend({
  account: Account.nullable(),
  notBefore: NotBefore.nullable(),
  schedule: ScheduleInput.nullable(),
})
  .partial()
  .superRefine(oneScheduleShape);
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

/**
 * The schedule a create or update asks for: `at` and `repeat` as given
 * (undefined: not given, keep), legacy fields converted. `retz`: a legacy
 * update that sends only `tz` (the task's repeat rule moves to that zone).
 */
export function requestedSchedule(input: Pick<UpdateTaskInput, "schedule" | "notBefore" | "repeat" | "tz">): {
  at: string | null | undefined;
  repeat: RepeatSchedule | null | undefined;
  retz?: string | null;
} {
  if (input.schedule !== undefined) return { at: input.schedule?.at ?? null, repeat: input.schedule?.repeat ?? null };
  const at = input.notBefore;
  if (input.repeat === undefined) return input.tz === undefined ? { at, repeat: undefined } : { at, repeat: undefined, retz: input.tz };
  return { at, repeat: input.repeat === null ? null : legacyToRepeat(input.repeat, input.tz) };
}

/** Metadata for an uploaded media file. */
export const MediaInfo = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});
export type MediaInfo = z.infer<typeof MediaInfo>;

/** A task as returned by the API. Times are ISO 8601 strings in UTC. */
export const Task = z.object({
  id: z.string(),
  instructions: z.string(),
  account: z.string().nullable(),
  mediaIds: z.array(z.string()),
  notBefore: z.string().nullable(),
  priority: z.number().int(),
  status: TaskStatus,
  attempts: z.number().int(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  retryAfter: z.string().nullable(),
  resultSummary: z.string().nullable(),
  resultUrl: z.string().nullable(),
  resultScreenshotId: z.string().nullable(),
  pauseReason: z.string().nullable(),
  failReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When it runs: `at` (the same as notBefore) and the repeat rule. Optional so older producers still validate. */
  schedule: TaskSchedule.nullable().optional(),
  /** Owning user id; null for legacy (admin-owned) cloud tasks. */
  ownerId: z.string().nullable().optional(),
  /**
   * The series the task belongs to: the id of its first row. Every repeat of a repeating task carries it, and edits
   * keep it, so what earlier runs did (memory's task history) stays with the task. A task that does not repeat: its
   * own id. Optional so older producers still validate (memory then keys the task by its instructions).
   */
  seriesId: z.string().min(1).max(64).nullable().optional(),
  /**
   * The agent wrote the instructions (a chat's schedule_task or update_scheduled_task) and the user has not trusted
   * them since: a scheduled run holds them as the agent's words, not the user's, so what they ask for still waits for
   * the user's OK (a page could have made the agent write them). The user's own edit of the instructions, or Trust on
   * the task, clears it; every repeat carries it. Optional so older producers still validate (absent: the user's).
   */
  agentAuthored: z.boolean().optional(),
  /**
   * The runner (one browser's runnerId) the task's runs stay on, so two browsers signed in to the account never both
   * run a job: set by the browser that created it or by its first claim, moved by "Run" on another browser, carried by
   * every repeat. Another runner takes it only once this one has stopped asking for work for a day. Null: any runner.
   * Optional so older producers still validate.
   */
  runnerId: z.string().nullable().optional(),
});
export type Task = z.infer<typeof Task>;

/**
 * GET /v1/tasks: a page of tasks, newest first. `locked`: the plan of the user
 * the list belongs to does not include the TODO list, so the list is read-only
 * (writes, claims and uploads answer 403 plan_required) until they subscribe.
 */
export const TaskListResponse = z.object({ tasks: z.array(Task), nextCursor: z.string().nullable(), locked: z.boolean() });
export type TaskListResponse = z.infer<typeof TaskListResponse>;

export const TaskEvent = z.object({
  id: z.number().int(),
  taskId: z.string(),
  type: z.enum(["created", "updated", "claimed", "heartbeat", "done", "failed", "paused", "cancelled", "retried", "lease_expired"]),
  detail: z.string().nullable(),
  createdAt: z.string(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/** Body of POST /v1/runner/claim. */
export const ClaimInput = z.object({
  runnerId: RunnerId,
  /**
   * Claim this task now, whatever its time ("Run" on its row): pending, paused
   * or failed (it starts over). 404 when not in scope, 409 when it cannot run.
   * Without it: the next due task, or 204.
   */
  taskId: z.string().min(1).max(100).optional(),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/** 200 response of POST /v1/runner/claim. A 204 means nothing is due. */
export const ClaimResponse = z.object({
  task: Task,
  media: z.array(MediaInfo),
  leaseExpiresAt: z.string(),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

/** Body of POST /v1/runner/tasks/:id/heartbeat. */
export const HeartbeatInput = z.object({ runnerId: z.string().min(1) });
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/**
 * done: finished. failed: will not be retried. paused: needs a human; retried
 * after retryAfterMinutes. retry: temporary problem (usage limit, network,
 * crash); goes back to pending after retryAfterMinutes, and fails once the
 * attempt limit is reached.
 */
export const TaskOutcome = z.enum(["done", "failed", "paused", "retry"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** Body of POST /v1/runner/tasks/:id/result. */
/**
 * Body of POST /v1/tasks/:id/pause: the reason the task shows while it waits (default "Paused by you"). A paused task
 * runs only after POST /v1/tasks/:id/resume.
 */
export const PauseTaskInput = z.object({ reason: z.string().trim().min(1).max(MAX_RESULT_REASON).optional() });
export type PauseTaskInput = z.infer<typeof PauseTaskInput>;

export const ResultInput = z.object({
  runnerId: z.string().min(1),
  outcome: TaskOutcome,
  summary: z.string().max(MAX_RESULT_SUMMARY).optional(),
  url: z.string().max(MAX_RESULT_URL).optional(),
  reason: z.string().max(MAX_RESULT_REASON).optional(),
  screenshotId: z.string().optional(),
  /** Paused and retry tasks become claimable again after this many minutes. Default 15. */
  retryAfterMinutes: z.number().int().min(1).max(24 * 60).optional(),
});
export type ResultInput = z.infer<typeof ResultInput>;

export const ApiKeyRole = z.enum(["admin", "creator", "runner"]);
export type ApiKeyRole = z.infer<typeof ApiKeyRole>;

/** The roles a new key can have (admin is the ADMIN_KEY's alone). */
export const IssuableKeyRole = ApiKeyRole.exclude(["admin"]);
export type IssuableKeyRole = z.infer<typeof IssuableKeyRole>;

export const CreateKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  role: IssuableKeyRole,
});
export type CreateKeyInput = z.infer<typeof CreateKeyInput>;

/** Body of POST /v1/me/keys: a key scoped to the signed-in user's data (same shape as the admin's). */
export const CreateOwnKeyInput = CreateKeyInput;
export type CreateOwnKeyInput = CreateKeyInput;

/** A signed-in user (Google account). */
export const User = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  pictureUrl: z.string().nullable(),
});
export type User = z.infer<typeof User>;

/** Body of POST /v1/auth/google: a Google ID token (JWT) issued for this server's client id. */
export const AuthGoogleInput = z.object({
  idToken: z.string().min(1).max(8192),
  /** Dashboard (same origin): also set the HttpOnly `bt_session` cookie. */
  cookie: z.boolean().optional(),
});
export type AuthGoogleInput = z.infer<typeof AuthGoogleInput>;

/** 200 response of POST /v1/auth/google. `token` is a session bearer token (bt_s_...). */
export const AuthResponse = z.object({
  token: z.string(),
  user: User,
  expiresAt: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

/** A one-time dashboard sign-in code (POST /v1/auth/code): `bt_c_` + 64 hex characters. */
export const SIGN_IN_CODE_RE = /^bt_c_[0-9a-f]{64}$/;

/**
 * 200 response of POST /v1/auth/code: a code that signs the dashboard in to the calling session's account, once,
 * until `expiresAt` (a minute). Only a session token (the extension) may ask for one.
 */
export const SignInCodeResponse = z.object({ code: z.string().regex(SIGN_IN_CODE_RE), expiresAt: z.string() });
export type SignInCodeResponse = z.infer<typeof SignInCodeResponse>;

/** Body of POST /v1/auth/code/redeem (the dashboard; needs the CSRF header). */
export const RedeemSignInCodeInput = z.object({ code: z.string().regex(SIGN_IN_CODE_RE) });
export type RedeemSignInCodeInput = z.infer<typeof RedeemSignInCodeInput>;

/** 200 response of POST /v1/auth/code/redeem. The new session's token is only in the HttpOnly cookie. */
export const RedeemSignInCodeResponse = z.object({ user: User, expiresAt: z.string() });
export type RedeemSignInCodeResponse = z.infer<typeof RedeemSignInCodeResponse>;

/** Standard error body for every non-2xx API response. */
export const ApiError = z.object({ error: z.string(), details: z.unknown().optional() });
export type ApiError = z.infer<typeof ApiError>;

/**
 * A task stored in the extension (no cloud needed), as the jobs list has it:
 * a cloud Task with its repeat rule at the top (notBefore is its `at`).
 * mediaIds refer to files stored in the extension. When a repeating task
 * finishes, the extension creates the next occurrence as a new pending task
 * and keeps the finished one as history.
 */
export const LocalTask = Task.omit({ schedule: true }).extend({
  repeat: RepeatSchedule.nullable(),
});
export type LocalTask = z.infer<typeof LocalTask>;

/** Where a task came from. "adhoc" is a one-off "do this now" request. */
export const TaskSource = z.enum(["local", "cloud", "adhoc"]);
export type TaskSource = z.infer<typeof TaskSource>;

const X_HOST = /\b(?:x|twitter)\.com\b/i;
/** An @handle as X writes it (not the @ inside an email address). */
const X_HANDLE = /(?:^|[^\w.@])@[A-Za-z0-9_]{1,15}(?![\w@.]*\.[A-Za-z])\b/;

/**
 * True when a task acts as an X account: it names one (account, or an
 * @handle in the instructions) or works on x.com. Such tasks never run at the
 * same time: every X account shares one login session in the browser, so
 * switching accounts in one tab switches it in every tab.
 */
export function isXTask(task: { instructions: string; account?: string | null }): boolean {
  if (task.account?.trim()) return true;
  return X_HOST.test(task.instructions) || X_HANDLE.test(task.instructions);
}

/**
 * An empty message in Chat: "look at the page and do what's needed". It is
 * the request itself (AgentTask.instructions, with screenHelp set), so the
 * chat shows it as the user's turn and the session title; @noa/core
 * buildTaskPrompt tells the agent what it means.
 */
export const SCREEN_HELP_TEXT = "Figure out what to do based on the current screen";
