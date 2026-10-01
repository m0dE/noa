import { z } from "zod";

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

/** Files an account keeps at most. */
export const MAX_CLOUD_FILES = 5000;
/** The default storage quota per account (the server's CLOUD_FILES_QUOTA_BYTES overrides it). */
export const DEFAULT_CLOUD_FILES_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CLOUD_FILE_NAME_CHARS = 255;

/** Where a file sits, as in the Noa folder: "" its top, "images" the pictures generate_image made. */
export const CloudFolder = z.enum(["", "images"]);
export type CloudFolder = z.infer<typeof CloudFolder>;

export const CloudFile = z.object({
  id: z.string(),
  name: z.string(),
  folder: CloudFolder,
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
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

