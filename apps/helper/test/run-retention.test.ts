import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRuns, RUN_RETENTION } from "../src/run-log.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-26T12:00:00Z");
let runs: string;
beforeEach(() => {
  runs = join(mkdtempSync(join(tmpdir(), "bt-prune-")), "runs");
  mkdirSync(runs);
});
afterEach(() => rmSync(join(runs, ".."), { recursive: true, force: true }));

/** A run folder of `kb` KB whose files were last written `ageMs` before NOW. */
function run(name: string, ageMs: number, kb = 1): string {
  const dir = join(runs, name);
  mkdirSync(dir);
  const t = new Date(NOW - ageMs);
  for (const f of ["log.jsonl", "screenshot-001.jpg"]) {
    writeFileSync(join(dir, f), Buffer.alloc((kb * 1024) / 2));
    utimesSync(join(dir, f), t, t);
  }
  utimesSync(dir, t, t);
  return dir;
}

describe("run folder retention", () => {
  it("keeps runs for 30 days and 200 MB at most", () => {
    expect(RUN_RETENTION.maxAgeMs).toBe(30 * DAY);
    expect(RUN_RETENTION.maxBytes).toBe(200 * 1024 * 1024);
  });

  it("removes runs older than maxAgeMs and keeps newer ones", async () => {
    run("old", 31 * DAY);
    run("older", 60 * DAY);
    run("recent", 2 * DAY);
    const r = await pruneRuns(runs, RUN_RETENTION, NOW);
    expect(readdirSync(runs)).toEqual(["recent"]);
    expect(r).toMatchObject({ removed: 2, freedBytes: 2048, keptBytes: 1024 });
  });

  it("over the size cap, removes the oldest runs first until the rest fit, judging age by the newest file", async () => {
    run("a", 5 * DAY, 40);
    const b = run("b", 10 * DAY, 40);
    // b's log was written yesterday: b is newer than a.
    utimesSync(join(b, "log.jsonl"), new Date(NOW - DAY), new Date(NOW - DAY));
    run("c", 3 * DAY, 40);
    const r = await pruneRuns(runs, { ...RUN_RETENTION, maxBytes: 90 * 1024 }, NOW);
    expect(readdirSync(runs).sort()).toEqual(["b", "c"]);
    expect(r.keptBytes).toBe(80 * 1024);
  });

  it("never removes a run written within minAgeMs (another helper may be writing it), even over the cap", async () => {
    run("busy", 5 * 60_000, 100);
    await pruneRuns(runs, { ...RUN_RETENTION, maxBytes: 1024 }, NOW);
    expect(existsSync(join(runs, "busy"))).toBe(true);
  });

  it("is fine without a runs folder", async () => {
    expect(await pruneRuns(join(runs, "missing"), RUN_RETENTION, NOW)).toEqual({ removed: 0, freedBytes: 0, keptBytes: 0 });
  });
});
