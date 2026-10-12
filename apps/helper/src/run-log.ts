/**
 * The run log of a task session (runs/<session>-<stamp>/log.jsonl), for the
 * side panel's "Raw log" link. Only files inside the runs folder are served.
 * Also: pruning old run folders (RUN_RETENTION).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Default and largest tail sent to the extension (native messages are capped at 1 MB). */
export const RUN_LOG_MAX_BYTES = 256 * 1024;

export function readRunLog(runsDir: string, path: string, maxBytes = RUN_LOG_MAX_BYTES): { text: string; truncated: boolean } {
  const full = resolve(path);
  const rel = relative(resolve(runsDir), full);
  if (!path || rel.startsWith("..") || isAbsolute(rel)) throw new Error("not a Noa run log");
  const limit = Math.max(1, Math.min(RUN_LOG_MAX_BYTES, Math.trunc(maxBytes) || RUN_LOG_MAX_BYTES));
  const fd = openSync(full, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // Start at a whole line when the head was cut.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/** How long run folders are kept, and how much disk they may use together. Pruned on helper start, oldest first. */
export const RUN_RETENTION = {
  maxAgeMs: 30 * 24 * 60 * 60_000,
  maxBytes: 200 * 1024 * 1024,
  /** Runs this recent are never removed: another helper (another Chrome profile) may still be writing them. */
  minAgeMs: 60 * 60_000,
} as const;

interface RunFolder {
  path: string;
  /** Newest modification time of the folder or anything in it. */
  lastWrite: number;
  bytes: number;
}

async function measure(path: string): Promise<{ lastWrite: number; bytes: number }> {
  const st = await stat(path);
  if (!st.isDirectory()) return { lastWrite: st.mtimeMs, bytes: st.size };
  let lastWrite = st.mtimeMs;
  let bytes = 0;
  for (const name of await readdir(path)) {
    const m = await measure(join(path, name));
    lastWrite = Math.max(lastWrite, m.lastWrite);
    bytes += m.bytes;
  }
  return { lastWrite, bytes };
}

/**
 * Removes run folders older than maxAgeMs, then the oldest ones until the
 * rest fit in maxBytes; folders newer than minAgeMs always stay. Returns what
 * was removed. A missing runs folder is fine.
 */
export async function pruneRuns(
  runsDir: string,
  limits: { maxAgeMs: number; maxBytes: number; minAgeMs: number } = RUN_RETENTION,
  now = Date.now(),
): Promise<{ removed: number; freedBytes: number; keptBytes: number }> {
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return { removed: 0, freedBytes: 0, keptBytes: 0 };
  }
  const runs: RunFolder[] = [];
  for (const name of names) {
    const path = join(runsDir, name);
    try {
      if ((await stat(path)).isDirectory()) runs.push({ path, ...(await measure(path)) });
    } catch {
      /* vanished meanwhile */
    }
  }
  runs.sort((a, b) => a.lastWrite - b.lastWrite);
  let keptBytes = runs.reduce((n, r) => n + r.bytes, 0);
  let removed = 0;
  let freedBytes = 0;
  for (const run of runs) {
    const age = now - run.lastWrite;
    if (age < limits.minAgeMs) break; // sorted oldest first: the rest are newer still
    if (age <= limits.maxAgeMs && keptBytes <= limits.maxBytes) break;
    try {
      await rm(run.path, { recursive: true, force: true });
      removed++;
      freedBytes += run.bytes;
      keptBytes -= run.bytes;
    } catch {
      /* in use (Windows): try again next start */
    }
  }
  return { removed, freedBytes, keptBytes };
}
