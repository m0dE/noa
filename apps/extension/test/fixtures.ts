import type { ClaimResponse, Task } from "@noa/shared";

/** A task row as the API returns it (pending, never run); extra overrides fields. */
export function taskFixture(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    instructions: `task ${id}`,
    account: null,
    mediaIds: [],
    notBefore: null,
    priority: 0,
    status: "pending",
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryAfter: null,
    resultSummary: null,
    resultUrl: null,
    resultScreenshotId: null,
    pauseReason: null,
    failReason: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    schedule: null,
    ownerId: "u1",
    ...extra,
  };
}

/** A claim of task `id` by runner-1 (its first attempt, leased for 15 minutes). */
export function claimFixture(id: string, extra: Partial<Task> = {}): ClaimResponse {
  const now = "2026-09-23T00:00:00.000Z";
  const leaseExpiresAt = "2026-09-23T00:15:00.000Z";
  return {
    task: taskFixture(id, {
      instructions: `Post: hello from ${id}`,
      account: "@me",
      status: "running",
      attempts: 1,
      leaseOwner: "runner-1",
      leaseExpiresAt,
      createdAt: now,
      updatedAt: now,
      ...extra,
    }),
    media: [],
    leaseExpiresAt,
  };
}
