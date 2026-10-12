# Runner protocol

The Noa extension runs a signed-in account's scheduled tasks by claiming them
from the account server with the runner endpoints below. The hosted service
implements them, and a self-hosted account server must too. The zod schemas
in `packages/shared/src/task.ts` are the source of truth for every body shown
here.

All requests send `Authorization: Bearer <session token>` (the signed-in
account's) and use JSON unless stated otherwise. Times are ISO 8601 strings
in UTC. Errors return a non-2xx status with `{ "error": "message" }`.

## Claim the next task

`POST /v1/runner/claim`

```json
{ "runnerId": "3f2c9a4e-..." }
```

`runnerId` is a stable random ID the extension stores for itself.

**204** with an empty body when nothing is due.

**200** when a task was claimed. The server must make sure two runners never
receive the same task, and must hold a lease on it until `leaseExpiresAt`.

```json
{
  "task": {
    "id": "01J9Z...",
    "instructions": "Post this on X: Good morning!",
    "account": "@myhandle",
    "mediaIds": ["01J9Y..."],
    "notBefore": "2026-09-24T09:00:00.000Z",
    "priority": 0,
    "status": "running",
    "attempts": 1,
    "leaseOwner": "3f2c9a4e-...",
    "leaseExpiresAt": "2026-09-24T09:15:00.000Z",
    "retryAfter": null,
    "resultSummary": null,
    "resultUrl": null,
    "resultScreenshotId": null,
    "pauseReason": null,
    "failReason": null,
    "createdAt": "2026-09-23T20:00:00.000Z",
    "updatedAt": "2026-09-24T09:00:00.000Z"
  },
  "media": [
    { "id": "01J9Y...", "filename": "sunrise.jpg", "contentType": "image/jpeg", "size": 183422 }
  ],
  "leaseExpiresAt": "2026-09-24T09:15:00.000Z"
}
```

A task is due when:

- it is `pending`, `notBefore` is empty or in the past, and `retryAfter` is
  empty or in the past, or
- it is `paused` and `retryAfter` is in the past, or
- it is `running` and its lease has expired.

The hosted service fails a `running` task with an expired lease instead of
handing it out again once it has been attempted 5 times.

The extension claims again while earlier claims are still running: it can
run several tasks at once (the "Tasks at once" setting), so a runner may hold
several leases. It does not claim while a task that acts as an X account is
running, and it runs X tasks one at a time.

## Keep the lease alive

`POST /v1/runner/tasks/:id/heartbeat`

```json
{ "runnerId": "3f2c9a4e-..." }
```

**200** `{ "leaseExpiresAt": "..." }`. **409** when the task is not running or
the lease belongs to another runner. The extension sends this every 2 minutes
while a task runs.

## Report the result

`POST /v1/runner/tasks/:id/result`

```json
{
  "runnerId": "3f2c9a4e-...",
  "outcome": "done",
  "summary": "Posted the good-morning message on @myhandle.",
  "url": "https://x.com/myhandle/status/1839...",
  "reason": "...",
  "screenshotId": "01J9Z...",
  "retryAfterMinutes": 15
}
```

- `outcome` is one of:
  - `done`: finished.
  - `failed`: will not be retried.
  - `paused`: needs a human, like a login or CAPTCHA. It becomes due again
    after `retryAfterMinutes`.
  - `retry`: a temporary problem, like a usage limit, network error or
    crash. It goes back to pending after `retryAfterMinutes`, and the server
    fails it once it has been attempted too many times (5 on the hosted
    service).
- `reason` explains a `failed`, `paused` or `retry` outcome.
- `retryAfterMinutes` defaults to 15 on the hosted service. The extension
  sends its "Retry temporary failures after" setting (10 by default) with
  `retry`, and its "Retry tasks that needed you after" setting (15 by
  default) with the other outcomes.
- The extension marks a `done` result as `retry` itself when the post URL
  cannot be verified, and reports temporary errors (rate limits, network
  errors, a crashed agent) as `retry` rather than `failed`.
- **200** with the updated task. **409** when the task is not running or the
  lease belongs to another runner.

## Media

`GET /v1/media/:id` returns the file bytes with its `Content-Type`.

`POST /v1/media` takes `multipart/form-data` with one field named `file` and
returns `{ "id", "filename", "contentType", "size" }` with status 201. The
extension uses it to upload the final screenshot of each task.

## Creating tasks

Task creation is not part of the runner protocol, so a compatible server can
fill its queue any way it likes. The hosted service accepts
`POST /v1/tasks` and `POST /v1/tasks/batch` with bodies matching
`CreateTaskInput` and `BatchCreateInput`.
