import { describe, expect, it, vi } from "vitest";
import { AccountApi } from "../../src/account/account-api.js";
import { AccountTodo, accountRow } from "../../src/account/todo-source.js";
import type { RepeatSchedule } from "@noa/shared";
import { taskFixture as task } from "../fixtures.js";
import { fakeApi } from "./fake-api.js";

function setup() {
  const api = fakeApi();
  const onChange = vi.fn();
  const todo = new AccountTodo(new AccountApi({ apiBase: api.base, token: "bt_s_tok", fetch: api.fetch }), "Europe/Berlin", onChange);
  return { api, todo, onChange };
}

describe("AccountTodo (the signed-in TODO list)", () => {
  it("lists every page of the account's tasks in the TODO row shape", async () => {
    const t = setup();
    t.api.on("GET /v1/tasks", (c) =>
      c.path.includes("cursor=")
        ? { body: { tasks: [task("t3", { status: "done" })], nextCursor: null } }
        : { body: { tasks: [task("t1", { mediaIds: ["m1", "m2"], notBefore: "2026-09-25T07:00:00.000Z", schedule: { at: "2026-09-25T07:00:00.000Z", repeat: { cron: "0 9 * * *", tz: "Europe/Berlin" } } }), task("t2")], nextCursor: "c2" } },
    );
    const { tasks: rows, locked } = await t.todo.list();
    expect(locked).toBe(false);
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
    expect(rows[0]).toMatchObject({ notBefore: "2026-09-25T07:00:00.000Z", repeat: { cron: "0 9 * * *", tz: "Europe/Berlin" }, media: [{ id: "m1", name: "file 1" }, { id: "m2", name: "file 2" }] });
    expect(rows[0]).not.toHaveProperty("schedule");
    expect(rows[1]!.repeat).toBeNull();
    expect(t.api.calls.map((c) => c.path)).toEqual(["/v1/tasks?limit=200", "/v1/tasks?limit=200&cursor=c2"]);
    expect(t.api.calls[0]!.headers.authorization).toBe("Bearer bt_s_tok");
    // The background learns the next due time from the list.
    expect(t.onChange).toHaveBeenCalledWith({ tasks: expect.arrayContaining([expect.objectContaining({ id: "t1" })]), locked: false });
  });

  it("a plan without the TODO list: the kept tasks come back locked", async () => {
    const t = setup();
    t.api.on("GET /v1/tasks", { body: { tasks: [task("t1"), task("t2", { status: "done" })], nextCursor: null, locked: true } });
    const list = await t.todo.list();
    expect(list.locked).toBe(true);
    expect(list.tasks.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(t.onChange).toHaveBeenCalledWith(expect.objectContaining({ locked: true }));
  });

  it("adds a task: uploads its files to /v1/media first, sends its schedule (the rule carries its zone)", async () => {
    const t = setup();
    t.api.on("POST /v1/media", { status: 201, body: { id: "M1", filename: "a.png", contentType: "image/png", size: 3 } });
    const rule = { cron: "0 9 * * 1-5\n30 18 * * 1-5", tz: "Asia/Seoul", end: "2026-12-31" };
    t.api.on("POST /v1/tasks", (c) => {
      const { schedule, ...rest } = c.body as { schedule: { at: string; repeat: RepeatSchedule } };
      return { status: 201, body: task("n1", { ...rest, notBefore: schedule.at, schedule }) };
    });
    const created = await t.todo.add({
      instructions: "Post the weekly recap",
      account: " alpha ",
      notBefore: "2026-09-25T07:00:00.000Z",
      repeat: rule,
      media: [{ name: "a.png", type: "image/png", dataBase64: "AQID" }],
    });
    expect(created).toMatchObject({ id: "n1", notBefore: "2026-09-25T07:00:00.000Z", repeat: rule });
    expect(t.api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/media", "POST /v1/tasks"]);
    expect(t.api.calls[1]!.body).toEqual({
      instructions: "Post the weekly recap",
      account: "alpha",
      mediaIds: ["M1"],
      schedule: { at: "2026-09-25T07:00:00.000Z", repeat: rule },
    });
    expect(t.onChange).toHaveBeenCalledWith();
  });

  it("an old { dailyAt } rule goes as cron in the browser's zone; a task without a schedule sends none", async () => {
    const t = setup();
    t.api.on("POST /v1/tasks", (c) => ({ status: 201, body: task("n2", { ...(c.body as object), schedule: null }) }));
    await t.todo.add({ instructions: "once" });
    expect(t.api.calls[0]!.body).toEqual({ instructions: "once" });
    await t.todo.add({ instructions: "daily", repeat: { dailyAt: ["09:00", "18:30"] } });
    expect(t.api.calls[1]!.body).toEqual({ instructions: "daily", schedule: { repeat: { cron: "0 9 * * *\n30 18 * * *", tz: "Europe/Berlin" } } });
  });

  it("pause and resume call their routes; holdSeries pauses the series' waiting row with the reason", async () => {
    const t = setup();
    t.api.on("POST /v1/tasks/t1/pause", (c) => ({ body: task("t1", { status: "paused", pauseReason: (c.body as { reason?: string }).reason ?? "Paused by you" }) }));
    t.api.on("POST /v1/tasks/t1/resume", { body: task("t1") });
    t.api.on("GET /v1/tasks", {
      body: { tasks: [task("t2", { status: "paused", pauseReason: "Paused by you" }), task("t1", { status: "pending" }), task("t0", { status: "failed" })], nextCursor: null },
    });
    expect(await t.todo.pause("t1")).toMatchObject({ status: "paused", pauseReason: "Paused by you" });
    expect(await t.todo.resume("t1")).toMatchObject({ status: "pending" });
    expect(await t.todo.holdSeries("s1", "Paused after 3 failed runs in a row. Last: boom")).toMatchObject({ id: "t1", pauseReason: "Paused after 3 failed runs in a row. Last: boom" });
    expect(t.api.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/v1/tasks/t1/pause", {}],
      ["POST", "/v1/tasks/t1/resume", undefined],
      ["GET", "/v1/tasks?limit=200&series=s1", undefined],
      ["POST", "/v1/tasks/t1/pause", { reason: "Paused after 3 failed runs in a row. Last: boom" }],
    ]);
  });

  it("releaseHold resumes the series' rows held after failures only: not ones the user paused, paused for a while, or `except`", async () => {
    const t = setup();
    const HOLD = "Paused after 3 failed runs in a row. Last: Task time limit of 10 minutes reached";
    t.api.on("GET /v1/tasks", {
      body: {
        tasks: [
          task("next", { status: "paused", pauseReason: HOLD, seriesId: "s1" }),
          task("mine", { status: "paused", pauseReason: HOLD, seriesId: "s1" }),
          task("user", { status: "paused", pauseReason: "Paused by you", seriesId: "s1" }),
          task("login", { status: "paused", pauseReason: "Please sign in", retryAfter: "2026-09-28T21:00:00.000Z", seriesId: "s1" }),
          task("old", { status: "failed", seriesId: "s1" }),
        ],
        nextCursor: null,
      },
    });
    t.api.on("POST /v1/tasks/next/resume", { body: task("next", { seriesId: "s1" }) });
    expect(await t.todo.releaseHold("s1", "mine")).toEqual(["next"]);
    expect(t.api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/tasks?limit=200&series=s1", "POST /v1/tasks/next/resume"]);
  });

  it("seriesPage lists one series a page at a time (the cursor of the page before), rows in the row shape", async () => {
    const t = setup();
    t.api.on("GET /v1/tasks", (c) =>
      c.path.includes("cursor=t2")
        ? { body: { tasks: [task("t1", { status: "done", seriesId: "s1" })], nextCursor: null } }
        : { body: { tasks: [task("t3", { status: "pending", seriesId: "s1", schedule: { at: null, repeat: { cron: "0 9 * * *", tz: "UTC" } } }), task("t2", { status: "failed", seriesId: "s1" })], nextCursor: "t2" } },
    );
    const first = await t.todo.seriesPage("s1");
    expect(first.tasks.map((x) => x.id)).toEqual(["t3", "t2"]);
    expect(first.tasks[0]).toMatchObject({ repeat: { cron: "0 9 * * *", tz: "UTC" } });
    expect(first.tasks[0]).not.toHaveProperty("schedule");
    expect(first.nextCursor).toBe("t2");
    expect(await t.todo.seriesPage("s1", "t2")).toMatchObject({ tasks: [{ id: "t1" }], nextCursor: null });
    expect(t.api.calls.map((c) => c.path)).toEqual(["/v1/tasks?limit=200&series=s1", "/v1/tasks?limit=200&series=s1&cursor=t2"]);
  });

  it("update, retry, cancel and delete call the task routes", async () => {
    const t = setup();
    t.api.on("PATCH /v1/tasks/t1", (c) => ({ body: task("t1", c.body as object) }));
    t.api.on("POST /v1/tasks/t1/retry", { body: task("t1") });
    t.api.on("POST /v1/tasks/t1/cancel", { body: task("t1", { status: "cancelled" }) });
    t.api.on("DELETE /v1/tasks/t1", { status: 204 });
    await t.todo.update("t1", { repeat: { cron: "15 7 * * *", tz: "UTC" }, notBefore: "2026-09-25T07:15:00.000Z", account: null });
    await t.todo.update("t1", { repeat: null });
    await t.todo.update("t1", { notBefore: null });
    await t.todo.retry("t1");
    expect((await t.todo.cancel("t1")).status).toBe("cancelled");
    expect(await t.todo.delete("t1")).toBe(true);
    expect(t.api.calls.map((c) => [`${c.method} ${c.path}`, c.body])).toEqual([
      ["PATCH /v1/tasks/t1", { account: null, schedule: { at: "2026-09-25T07:15:00.000Z", repeat: { cron: "15 7 * * *", tz: "UTC" } } }],
      ["PATCH /v1/tasks/t1", { schedule: { at: null, repeat: null } }],
      ["PATCH /v1/tasks/t1", { notBefore: null }],
      ["POST /v1/tasks/t1/retry", undefined],
      ["POST /v1/tasks/t1/cancel", undefined],
      ["DELETE /v1/tasks/t1", undefined],
    ]);
  });

  it("server errors come through with the server's message", async () => {
    const t = setup();
    t.api.on("DELETE /v1/tasks/t9", { status: 409, body: { error: "task is running" } });
    await expect(t.todo.delete("t9")).rejects.toMatchObject({ status: 409, message: "task is running" });
  });

  it("accountRow keeps the cloud fields", () => {
    expect(accountRow(task("x", { status: "paused", pauseReason: "Out of usage credit" }))).toMatchObject({ status: "paused", pauseReason: "Out of usage credit", media: [] });
  });
});
