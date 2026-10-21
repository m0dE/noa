import { z } from "zod";
import type { PlanFeature } from "./billing.js";

// ---------------------------------------------------------------- cloud files (the account's file storage)

/**
 * The account's files: the cloud side of the user's Noa folder. The Noa folder (Downloads/Noa) stays where the
 * agent works with files (upload needs a path on this computer, and it works signed out); cloud files keep copies
 * in the account, so the user's other computers and the dashboard have them. Files are stored in R2 under their
 * owner and listed from D1 (apps/api/src/routes/files.ts).
 *
 * - GET    FILES_PATH          the account's files, newest first, and how much of the quota they use.
 * - POST   FILES_PATH          a multipart upload: `file`, and optionally `folder` (CloudFolder).
 * - GET    FILES_PATH/{id}     the file's bytes.
 * - DELETE FILES_PATH/{id}     deletes it.
 *
 * Signed-in users (session token) only. Storing needs a plan with the TODO list (the catalog's `todo` flag: data
 * that keeps accumulating in cloud storage); files kept from a paid plan stay listed, downloadable and deletable on
 * any plan (`locked` says new ones can't be added).
 */
export const FILES_PATH = "/v1/files";

/**
 * The plan feature that includes cloud files. The catalog has no storage feature of its own: cloud files come with
 * the TODO list's flag (data that keeps accumulating in cloud storage, docs/BILLING-CONTRACT.md). Everything that
 * decides whether a plan has cloud files (the account server's routes, the extension's Storage settings and files
 * button) asks for this one, so giving files a feature of their own is a change here.
 */
export const CLOUD_FILES_FEATURE = "todo" satisfies PlanFeature;

/**
 * Where Noa keeps the files it saves (save_file) and the pictures it makes (Settings > Storage): cloud: the
 * account's cloud files only (a file is downloaded to the Noa folder when Noa puts it on a page); local: the Noa
 * folder on this computer only; both.
 */
export const FileStorage = z.enum(["cloud", "local", "both"]);
export type FileStorage = z.infer<typeof FileStorage>;

/**
 * Where files go: the user's choice, else the cloud when they can keep files there (signed in on a plan with cloud
 * files); without that, this computer whatever was chosen (a file is never lost to a cloud it cannot reach).
 */
export function fileStorageFor(chosen: FileStorage | null | undefined, cloudAllowed: boolean): FileStorage {
  return cloudAllowed ? (chosen ?? "cloud") : "local";
}

/** Files an account keeps at most. */
export const MAX_CLOUD_FILES = 5000;
/** The default storage quota per account (the server's CLOUD_FILES_QUOTA_BYTES overrides it). */
export const DEFAULT_CLOUD_FILES_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CLOUD_FILE_NAME_CHARS = 255;

export const MAX_CLOUD_FOLDER_CHARS = 60;
/** A folder name: letters, digits, spaces, - and _, not starting or ending with a space. */
const FOLDER_NAME = /^(?:[\p{L}\p{N}_-](?:[\p{L}\p{N} _-]*[\p{L}\p{N}_-])?)?$/u;

/**
 * Where a file sits, as in the Noa folder (one level, no subfolders): "" its top, "images" the pictures generate_image
 * made, any other name a folder the user or the agent's save_file chose (e.g. "invoices", "documents").
 */
export const CloudFolder = z.string().max(MAX_CLOUD_FOLDER_CHARS).regex(FOLDER_NAME, "a folder name is letters, digits, spaces, - and _");
export type CloudFolder = z.infer<typeof CloudFolder>;

/** A folder name CloudFolder accepts, from anything ("Invoices/2026" -> "Invoices 2026"); "" for none. */
export function cloudFolderName(raw: string | undefined): CloudFolder {
  return (raw ?? "")
    .replace(/[^\p{L}\p{N} _-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLOUD_FOLDER_CHARS)
    .trim();
}

/** Characters a file's note (FileMeta.about) keeps at most. */
export const MAX_FILE_ABOUT_CHARS = 300;
/** Characters a source or page address keeps at most. */
export const MAX_FILE_META_URL_CHARS = 2000;

/**
 * What is known about a file besides its name, size and date: what list_files shows the agent so that it can tell
 * which file fits a task without opening each one. All optional (a file the user put in the folder themselves has
 * only what its bytes say).
 * - width, height: a picture's size in pixels, read from its header (image-size.ts).
 * - source: the web address its bytes came from (http(s) only).
 * - page, pageTitle: the page that was open when it was kept (where the user saw it).
 * - about: a short note on what it is or shows, written by the agent that kept it.
 */
export const FileMeta = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  source: z.string().max(MAX_FILE_META_URL_CHARS).optional(),
  page: z.string().max(MAX_FILE_META_URL_CHARS).optional(),
  pageTitle: z.string().max(200).optional(),
  about: z.string().max(MAX_FILE_ABOUT_CHARS).optional(),
});
export type FileMeta = z.infer<typeof FileMeta>;

/** FileMeta from anything (a stored row, a client's form field): only its valid fields, cut to their limits; undefined when none is left. */
export function cleanFileMeta(raw: unknown): FileMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: FileMeta = {};
  const size = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : undefined);
  const text = (v: unknown, max: number) => (typeof v === "string" && v.replace(/\s+/g, " ").trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);
  const web = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) && v.trim().length <= MAX_FILE_META_URL_CHARS ? v.trim() : undefined);
  const width = size(r.width);
  const height = size(r.height);
  if (width && height) Object.assign(out, { width, height });
  const source = web(r.source);
  if (source) out.source = source;
  const page = web(r.page);
  if (page) out.page = page;
  const pageTitle = text(r.pageTitle, 200);
  if (pageTitle) out.pageTitle = pageTitle;
  const about = text(r.about, MAX_FILE_ABOUT_CHARS);
  if (about) out.about = about;
  return Object.keys(out).length ? out : undefined;
}

export const CloudFile = z.object({
  id: z.string(),
  name: z.string(),
  folder: CloudFolder,
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** Absent from an account server before file notes, and for a file nothing is known about. */
  meta: FileMeta.optional(),
});
export type CloudFile = z.infer<typeof CloudFile>;

/** GET FILES_PATH. */
export const CloudFileList = z.object({
  files: z.array(CloudFile),
  /** Bytes the account's files take. */
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
  /** The plan does not include cloud files: kept ones can be read and deleted, new ones not added. */
  locked: z.boolean(),
});
export type CloudFileList = z.infer<typeof CloudFileList>;

/**
 * A file name safe to store and to save on any OS: no folders, no control or reserved characters, at most
 * MAX_CLOUD_FILE_NAME_CHARS; "file" when nothing is left.
 */
export function cloudFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_CLOUD_FILE_NAME_CHARS);
  return clean || "file";
}


// ---------------------------------------------------------------- search

/**
 * POST FILES_SEARCH_PATH: the account's files nearest in meaning to a query. Each file has an embedding of
 * fileSearchText (made when it is stored, again when its text changes); the extension fuses these scores with its
 * own word, name and date matching over the cloud and the Noa folder's files (list_files with a search).
 */
export const FILES_SEARCH_PATH = "/v1/files/search";
/** Longest query embedded (characters). */
export const MAX_FILE_SEARCH_QUERY_CHARS = 500;
/** Most hits one search answers. */
export const MAX_FILE_SEARCH_HITS = 100;

export const FileSearchInput = z.object({
  query: z.string().trim().min(1).max(MAX_FILE_SEARCH_QUERY_CHARS),
  limit: z.number().int().min(1).max(MAX_FILE_SEARCH_HITS).optional(),
});
export type FileSearchInput = z.infer<typeof FileSearchInput>;

export const FileSearchResponse = z.object({
  /** The embedding model the scores come from. */
  model: z.string(),
  /** Nearest first; `score` is the cosine similarity (-1..1). */
  hits: z.array(z.object({ id: z.string(), score: z.number() })),
  /** Files not embedded yet (embedded in the background, found by later searches). */
  pending: z.number().int().min(0),
});
export type FileSearchResponse = z.infer<typeof FileSearchResponse>;

/** A file's name as words: "IMG_3302.png" -> "IMG 3302 png", "walnut-desk-lamp" -> "walnut desk lamp". */
export function fileNameWords(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.+/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The site of a web address without "www." ("" for none). */
export function siteOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * What a file is searched by, in meaning and in words: its name as words, its folder, its note, the page and site it
 * came from, and its kind and shape. Short (~20-80 tokens): what makes one file stand out from the others.
 */
export function fileSearchText(f: { name: string; folder?: string; contentType?: string; meta?: FileMeta }): string {
  const m = f.meta ?? {};
  const kind = f.contentType?.startsWith("image/") ? "picture" : f.contentType === "application/pdf" ? "PDF document" : "";
  const shape = m.width && m.height ? (m.width > m.height * 1.2 ? "landscape" : m.height > m.width * 1.2 ? "portrait" : "square") : "";
  return [
    fileNameWords(f.name),
    f.folder ? `in ${f.folder}` : "",
    [shape, kind].filter(Boolean).join(" "),
    m.about ?? "",
    m.pageTitle ? `from the page "${m.pageTitle}"` : "",
    siteOf(m.page ?? m.source) ? `on ${siteOf(m.page ?? m.source)}` : "",
  ]
    .filter(Boolean)
    .join(". ");
}
