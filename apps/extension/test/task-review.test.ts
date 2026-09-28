import { describe, expect, it } from "vitest";
import type { LocalTask } from "@noa/shared";
import type { TodoSource } from "../src/account/todo-source.js";
import { reviewJob } from "../src/engine/task-review.js";

const NY = "America/New_York";
/** Mon Sep 28 2026, 10:00 in New York. */
const NOW = new Date("2026-09-28T14:00:00Z");

const row = (t: Partial<LocalTask> & { id: string }): LocalTask =>
  ({ instructions: "Post one tip about AI on X as @m0de", account: "@m0de", mediaIds: [], notBefore: null, repeat: null, status: "done", seriesId: "s0", updatedAt: NOW.toISOString(), ...t }) as unknown as LocalTask;

function todo(listed: LocalTask[], series: LocalTask[], opts: { fail?: boolean } = {}): TodoSource {
  return {
    list: async () => {
      if (opts.fail) throw new Error("offline");
      return { tasks: listed.map((t) => ({ ...t, media: [] })), locked: false };
    },
    seriesPage: async () => ({ tasks: series, nextCursor: null }),
  } as unknown as TodoSource;
}

const deps = (source: TodoSource) => ({ todo: async () => source, timeZone: () => NY, now: () => NOW, hour12: true });

describe("a chat about a scheduled job: what the agent is told of it", () => {
  const waiting = row({ id: "t4", status: "pending", notBefore: "2026-09-28T17:40:00.000Z", repeat: { cron: "40 9,13,18 * * *", tz: NY } });
  const series = [
    waiting,
    row({ id: "t3", status: "failed", failReason: "X showed a login page", updatedAt: "2026-09-28T13:52:00.000Z" }),
    row({ id: "t2", status: "done", resultSummary: "Posted a tip about agents", resultUrl: "https://x.com/m0de/status/2", updatedAt: "2026-09-27T22:40:00.000Z" }),
  ];

  it("its waiting row (found by series after a repeat), schedule, next run and latest runs, then the review rules", async () => {
    const r = await reviewJob({ taskId: "t1", seriesId: "s0" }, deps(todo([waiting], series)));
    expect(r.task).toEqual({ instructions: waiting.instructions, account: "@m0de", seriesId: "s0" });
    const lines = r.text.split("\n");
    expect(lines.slice(0, 11)).toEqual([
      "The scheduled job this chat is about (task_id t4):",
      "- When: Daily at 9:40 AM, 1:40 PM and 6:40 PM; next run today at 1:40 PM",
      "- Account: @m0de",
      "- Its instructions now:",
      "<<<",
      "Post one tip about AI on X as @m0de",
      ">>>",
      "- Its latest runs, newest first:",
      "  - today at 9:52 AM · failed · X showed a login page",
      "  - Sun, Sep 27 at 6:40 PM · done · Posted a tip about agents · https://x.com/m0de/status/2",
      "",
    ]);
    expect(r.text).toMatch(/trial run of the job now/);
    expect(r.text).toMatch(/call update_scheduled_task/);
    expect(r.text).toMatch(/Do not write memory_note/);
  });

  it("a job no longer scheduled says so; one that cannot be read gets the rules alone", async () => {
    const over = await reviewJob({ taskId: "t2", seriesId: "s0" }, deps(todo([], [series[2]!])));
    expect(over.text).toMatch(/it is not scheduled any more/);
    const unread = await reviewJob({ taskId: "t1", seriesId: "s0" }, deps(todo([], [], { fail: true })));
    expect(unread.task).toBeNull();
    expect(unread.text).toMatch(/^The scheduled job this chat is about could not be read just now: call list_scheduled_tasks/);
  });
});
