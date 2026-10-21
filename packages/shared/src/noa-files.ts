/**
 * The files in the user's Noa folder (Downloads/Noa), as the agent's list_files gets them: the folder where the user
 * keeps files for Noa to work with (attach to pages, read). The extension knows where the folder is; the helper reads
 * it from disk (files.list). Signed in, the account's cloud files (cloud-files.ts) are listed too: the ones not on
 * this computer are downloaded into the folder when the agent uploads them.
 */

import type { FileMeta } from "./cloud-files.js";

/** Files one listing gives at most (the newest). */
export const MAX_LISTED_FILES = 200;
/** list_files without a search shows the newest this many (with how many there are in all): search finds the rest. */
export const LIST_NEWEST_FILES = 30;
/** list_files with a search shows the best this many matches. */
export const FILE_SEARCH_SHOWN = 20;
/** Files of the Noa folder a search ranks at most (the newest): the helper's answer stays under a native message's 1 MB. */
export const LOCAL_SEARCH_MAX = 2000;

/** The largest file save_file keeps (the local copy is written from memory). */
export const SAVE_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** A piece of a local file the helper reads for save_file (raw bytes; base64 makes it ~683 KB, under a native message's 1 MB). */
export const FILE_READ_CHUNK_BYTES = 512 * 1024;

/** Where save_file's bytes come from: exactly one. */
export interface SaveFileSource {
  /** A web address (the browser's own sign-ins apply) or a data: URL. */
  url?: string;
  /** Text the agent wrote. */
  text?: string;
  /** A picture of the current tab. */
  screenshot?: boolean;
  /** A file on this computer that the agent may use (list_files, the task's media and attachments, generate_image). */
  path?: string;
  /** The file the browser downloaded last (in the last 15 minutes), e.g. after a page's Download button. */
  download?: boolean;
}

/** save_file's arguments, as the extension gets them (files.save). */
export interface SaveFileParams extends SaveFileSource {
  /** File name with its extension; default: from the source. */
  name?: string;
  /** One folder (e.g. "invoices"); default "" (the top), "images" for a screenshot. */
  folder?: string;
  /** A short note on what the file is or shows, kept with it (FileMeta.about). */
  about?: string;
}

/** What save_file did: the copy on this computer, and the cloud copy or why there is none. */
export interface SavedFile {
  /**
   * Absolute, in the Noa folder: what upload takes. With `local` false the file is only in the cloud files, and this is
   * where it is downloaded when it is uploaded.
   */
  path: string;
  /** A copy is in the Noa folder on this computer (false: the user keeps files in the cloud only). */
  local: boolean;
  name: string;
  /** The folder it is in ("" the top). */
  folder: string;
  size: number;
  contentType: string;
  /**
   * saved: a copy is in the account's cloud files. signed-out / no-plan: none (not signed in; the plan has no cloud
   * files). off: the user keeps files on this computer only (Settings > Storage). failed: storing it failed
   * (cloudError says why: full, offline).
   */
  cloud: "saved" | "signed-out" | "no-plan" | "off" | "failed";
  cloudError?: string;
  /** The cloud copy went to the top folder: the account server does not take this folder name yet. */
  cloudFolder?: string;
  /** What is kept about it (its size in pixels, where it came from, the note). */
  meta?: FileMeta;
}

export interface NoaFile {
  /** Absolute path: what upload takes. */
  path: string;
  /** Its place in the folder, with / between subfolders, e.g. "images/store-icon.png". */
  name: string;
  size: number;
  /** ISO time it last changed (a cloud file: when it was stored). */
  modified: string;
  /**
   * Only in the account's cloud files, not on this computer yet: path is where it is saved in the Noa folder when it
   * is uploaded (the extension downloads it first).
   */
  cloud?: true;
  /** What is known about it besides its name, size and date. */
  meta?: FileMeta;
}

export interface NoaFileList {
  /** The Noa folder, absolute. */
  folder: string;
  /** Newest first. */
  files: NoaFile[];
  /** How many files there are, or with a search how many matched (more than files.length when the listing was cut). */
  total: number;
  /** A search's ranking: whether meaning (the account's embedding search) took part; files not embedded yet. */
  searched?: { meaning: boolean; pending?: number };
  /**
   * Only the files Chrome itself saved there (downloads, generated pictures) are listed: the helper, which reads the
   * folder from disk, is not connected.
   */
  partial?: boolean;
}

/**
 * The Noa folder's notes on its files (FileMeta without the picture size, which is read from the file itself), kept by
 * the helper in this hidden file at the folder's top, keyed by each file's place in the folder ("invoices/march.pdf").
 * A file renamed or moved outside Noa loses its note; one deleted leaves a note nothing lists.
 */
export const NOA_FILE_NOTES = ".noa-files.json";

/** Whether a listed name matches list_files' search (any case). */
export function matchesFileSearch(name: string, search: string | undefined): boolean {
  return !search || name.toLowerCase().includes(search.trim().toLowerCase());
}
