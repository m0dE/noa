/**
 * The files in the user's Noa folder (Downloads/Noa), read from disk for the agent's list_files: the extension knows
 * where the folder is but cannot list a folder, so it asks the helper (files.list). Subfolders are walked a few levels
 * deep; hidden files, the folder's own README and Chrome's unfinished downloads are left out. save_file reads a file
 * the same way (files.read), a piece at a time: a native message carries at most 1 MB.
 *
 * Each listed file comes with what is known about it (FileMeta): a picture's size in pixels, read from its header, and
 * the note save_file kept on it (files.note: where it came from, what it shows) in the folder's NOA_FILE_NOTES.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { cleanFileMeta, FILE_READ_CHUNK_BYTES, imageSize, LOCAL_SEARCH_MAX, matchesFileSearch, MAX_LISTED_FILES, NOA_FILE_NOTES, type FileMeta, type NoaFile, type NoaFileList } from "@noa/shared";

/** JSON characters one listing's files take at most: a native message carries at most 1 MB. */
const MAX_LIST_CHARS = 700_000;
/** Picture sizes remembered (by path, size and time changed): a folder listed again reads no header twice. */
const SIZE_CACHE_MAX = 10_000;
const sizes = new Map<string, { stamp: string; size: Partial<FileMeta> }>();

/** Notes the folder keeps at most (the oldest go first). */
const MAX_NOTES = 5000;

/** Files whose picture size is read from their header. */
const PICTURE = /\.(png|jpe?g|gif|webp|bmp)$/i;

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
  const max = Math.min(opts.max ?? MAX_LISTED_FILES, LOCAL_SEARCH_MAX);
  // Each file with its version (size and time changed), for the picture size cache.
  const files: { file: NoaFile; stamp: string }[] = [];
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
        if (matchesFileSearch(name, opts.search)) files.push({ file: { path, name, size: st.size, modified: st.mtime.toISOString() }, stamp: `${st.size}:${st.mtimeMs}` });
      } catch {
        // Gone or unreadable since it was listed.
      }
    }
  };
  walk(folder, 0);
  files.sort((a, b) => b.file.modified.localeCompare(a.file.modified));
  // Only the listed ones: their notes, and a picture's size (a few small reads of its header, once per version).
  const notes = readNotes(folder);
  const listed: NoaFile[] = [];
  let chars = 0;
  for (const { file, stamp } of files.slice(0, max)) {
    const meta: FileMeta = { ...(PICTURE.test(file.name) ? cachedSize(file.path, stamp) : {}), ...notes[file.name.toLowerCase()] };
    if (Object.keys(meta).length) file.meta = meta;
    chars += JSON.stringify(file).length + 1;
    if (chars > MAX_LIST_CHARS) break;
    listed.push(file);
  }
  return { folder, files: listed, total: files.length };
}

/** pictureSize, remembered while the file stays the same (its size and time changed). */
function cachedSize(path: string, stamp: string): Partial<FileMeta> {
  const hit = sizes.get(path);
  if (hit?.stamp === stamp) return hit.size;
  const size = pictureSize(path);
  if (sizes.size >= SIZE_CACHE_MAX) sizes.delete(sizes.keys().next().value!);
  sizes.set(path, { stamp, size });
  return size;
}

/** A picture's width and height from its header; {} when it cannot be read or is not understood. */
function pictureSize(path: string): Partial<FileMeta> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const file = fd;
    const size = imageSize((offset, length) => {
      const buf = Buffer.alloc(length);
      return buf.subarray(0, readSync(file, buf, 0, length, offset));
    });
    return size ?? {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The folder's notes, by each file's place in the folder in lower case; {} when there are none or they cannot be read. */
function readNotes(folder: string): Record<string, FileMeta> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(folder, NOA_FILE_NOTES), "utf8"));
  } catch {
    return {};
  }
  const out: Record<string, FileMeta> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const meta = cleanFileMeta(value);
    if (meta) {
      // The picture size comes from the file itself.
      delete meta.width;
      delete meta.height;
      if (Object.keys(meta).length) out[name.toLowerCase()] = meta;
    }
  }
  return out;
}

/**
 * Keeps `meta` (without a picture size) as the note on the file at `path` inside `folder`, replacing its old note;
 * at most MAX_NOTES are kept. Written to a temporary file first, so a note being written never leaves a broken file.
 */
export function noteFile(folder: string, path: string, meta: FileMeta): void {
  const name = relative(folder, path).replace(/\\/g, "/");
  if (!name || name.startsWith("../") || name === ".." || isAbsolute(name)) throw new Error(`${path} is not in the Noa folder`);
  const clean = cleanFileMeta(meta);
  const file = join(folder, NOA_FILE_NOTES);
  let notes: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) notes = raw as Record<string, unknown>;
  } catch {
    // None yet, or unreadable: start again.
  }
  const key = Object.keys(notes).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key) delete notes[key];
  if (clean) {
    delete clean.width;
    delete clean.height;
    if (Object.keys(clean).length) notes[name] = clean;
  }
  const keys = Object.keys(notes);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_NOTES))) delete notes[old];
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes));
  renameSync(tmp, file);
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
