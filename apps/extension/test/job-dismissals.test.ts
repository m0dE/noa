import { describe, expect, it } from "vitest";
import { memoryStorageArea } from "./chrome-fake.js";
import { JobDismissals, MAX_DISMISSALS } from "../src/job-dismissals.js";

describe("JobDismissals", () => {
  it("keeps dismissals by job key in the storage area, merged, and says when they change", async () => {
    const area = memoryStorageArea();
    const d = new JobDismissals(area);
    let changes = 0;
    d.onChange(() => changes++);
    expect(await d.all()).toEqual({});
    await d.set({ "chat:a": { at: "2026-09-27T10:00:00.000Z", needs: "a:2026-09-26T09:00:00.000Z" } });
    await d.set({ "task:t": { at: "2026-09-27T10:01:00.000Z", archivedAt: "2026-09-25T09:00:00.000Z" } });
    expect(changes).toBe(2);
    // A new panel (or a restarted worker) reads the same.
    expect(await new JobDismissals(area).all()).toEqual({
      "chat:a": { at: "2026-09-27T10:00:00.000Z", needs: "a:2026-09-26T09:00:00.000Z" },
      "task:t": { at: "2026-09-27T10:01:00.000Z", archivedAt: "2026-09-25T09:00:00.000Z" },
    });
  });

  it("keeps the newest MAX_DISMISSALS", async () => {
    const d = new JobDismissals(memoryStorageArea());
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    await d.set(Object.fromEntries(Array.from({ length: MAX_DISMISSALS + 3 }, (_, i) => [`chat:${i}`, { at: at(i) }])));
    const kept = await d.all();
    expect(Object.keys(kept)).toHaveLength(MAX_DISMISSALS);
    expect(kept["chat:0"]).toBeUndefined();
    expect(kept[`chat:${MAX_DISMISSALS + 2}`]).toBeDefined();
  });
});
