/**
 * The files in the user's Noa folder (Downloads/Noa), read from disk for the agent's list_files: the extension knows
 * where the folder is but cannot list a folder, so it asks the helper (files.list). Subfolders are walked a few levels
 * deep; hidden files, the folder's own README and Chrome's unfinished downloads are left out. save_file reads a file
 * the same way (files.read), a piece at a time: a native message carries at most 1 MB.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FILE_READ_CHUNK_BYTES, matchesFileSearch, MAX_LISTED_FILES, type NoaFileList } from "@noa/shared";

/** Subfolder levels walked below the folder itself. */
const MAX_DEPTH = 4;

/** Not the user's files: the README the extension writes, hidden files, Chrome's partial downloads. */
function skipped(name: string, top: boolean): boolean {
  return name.startsWith(".") || (top && name === "README.txt") || /\.crdownload$/i.test(name) || /^desktop\.ini$/i.test(name);
}

/**
 * The files under `folder` (absolute paths), newest first, at most `max`; with `search`, only those whose name (with
 * its subfolders) contains it. A missing folder lists nothing.
 */
export function listFolder(folder: string, opts: { search?: string; max?: number } = {}): NoaFileList {
  const max = Math.min(opts.max ?? MAX_LISTED_FILES, MAX_LISTED_FILES);
  const files: NoaFileList["files"] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skipped(e.name, depth === 0)) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(path, depth + 1);
        continue;
      }
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        const name = relative(folder, path).replace(/\\/g, "/");
        if (matchesFileSearch(name, opts.search)) files.push({ path, name, size: st.size, modified: st.mtime.toISOString() });
      } catch {
        // Gone or unreadable since it was listed.
      }
    }
  };
  walk(folder, 0);
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  return { folder, files: files.slice(0, max), total: files.length };
}

/** A piece of a file (at most FILE_READ_CHUNK_BYTES from `offset`), base64, and the whole file's size. */
export function readChunk(path: string, offset: number, length: number): { dataBase64: string; size: number } {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a file`);
  const want = Math.max(0, Math.min(length, FILE_READ_CHUNK_BYTES, st.size - offset));
  const buf = Buffer.alloc(want);
  const fd = openSync(path, "r");
  try {
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, offset + got);
      if (!n) break;
      got += n;
    }
    return { dataBase64: buf.subarray(0, got).toString("base64"), size: st.size };
  } finally {
    closeSync(fd);
  }
}
