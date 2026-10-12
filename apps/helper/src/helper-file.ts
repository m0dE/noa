/**
 * %LOCALAPPDATA%\noa\helper.json: where the running helper's pipe is,
 * so `mcp-server.js --attach` (the user's own Claude Code) can reach it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HelperFile {
  pipe: string;
  /** What every call on the pipe carries (PipeMethods): the file is the user's alone (their app data folder; 0600 elsewhere). */
  token: string;
  pid: number;
  startedAt: string;
}

export function writeHelperFile(path: string, info: HelperFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 });
  // A file kept from an earlier helper keeps its old mode otherwise.
  chmodSync(path, 0o600);
}

/** Removes the file only when it still belongs to this pid (another helper may have replaced it). */
export function removeHelperFile(path: string, pid: number): void {
  try {
    const cur = readHelperFile(path);
    if (!cur || cur.pid === pid) rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

export function readHelperFile(path: string): HelperFile | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<HelperFile>;
    if (typeof j.pipe !== "string" || typeof j.pid !== "number") return null;
    return { pipe: j.pipe, token: typeof j.token === "string" ? j.token : "", pid: j.pid, startedAt: String(j.startedAt ?? "") };
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
