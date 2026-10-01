import { z } from "zod";

// ---------------------------------------------------------------- bookmark sync with the account (Noa Browser)

/**
 * Noa Browser's bookmarks, kept in the signed-in account so the user's other computers get them (Chromium's own
 * sync needs Google's keys, which other browsers don't get). Each bookmark and folder is one node with a random
 * guid; the three root folders have fixed guids (BOOKMARK_ROOTS) and are never nodes themselves. A change wins
 * over another of the same node when it is at least as new (updatedAt); a deletion is a node with `deleted`, so
 * other computers learn of it. GET BOOKMARKS_PATH?since=rev reads the changes after `rev`; POST
 * BOOKMARKS_SYNC_PATH sends this computer's changes and answers the changes since `since`.
 * Any signed-in plan: bookmarks are small (MAX_BOOKMARK_NODES live nodes per account).
 */
export const BOOKMARKS_PATH = "/v1/bookmarks";
export const BOOKMARKS_SYNC_PATH = "/v1/bookmarks/sync";

/** The fixed guids of the browser's root folders. */
export const BOOKMARK_ROOTS = { bar: "root_bar", other: "root_other", mobile: "root_mobile" } as const;
export const BOOKMARK_ROOT_GUIDS: readonly string[] = Object.values(BOOKMARK_ROOTS);

/** Live (not deleted) nodes an account keeps at most. */
export const MAX_BOOKMARK_NODES = 20_000;
/** Most changes in one sync request (a computer with more sends them over several). */
export const MAX_BOOKMARK_SYNC_BATCH = 1000;
export const MAX_BOOKMARK_TITLE_CHARS = 1024;
export const MAX_BOOKMARK_URL_CHARS = 8192;
/** A folder holds at most this many children (an index past it is refused). */
export const MAX_BOOKMARK_INDEX = 100_000;

const Guid = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "a guid is letters, digits, _ and -");

export const BookmarkNode = z
  .object({
    guid: Guid,
    /** A folder's guid, or a root's (BOOKMARK_ROOTS). */
    parentGuid: Guid,
    index: z.number().int().min(0).max(MAX_BOOKMARK_INDEX),
    title: z.string().max(MAX_BOOKMARK_TITLE_CHARS),
    /** null: a folder. */
    url: z.string().min(1).max(MAX_BOOKMARK_URL_CHARS).nullable(),
    updatedAt: z.string().min(1).max(40),
    deleted: z.boolean(),
  })
  .refine((n) => !BOOKMARK_ROOT_GUIDS.includes(n.guid), { message: "a root folder is not a node", path: ["guid"] })
  .refine((n) => n.guid !== n.parentGuid, { message: "a node cannot be its own parent", path: ["parentGuid"] });
export type BookmarkNode = z.infer<typeof BookmarkNode>;

export const BookmarkSyncInput = z.object({
  /** The server revision this computer has (0: none yet). */
  since: z.number().int().min(0),
  changes: z.array(BookmarkNode).max(MAX_BOOKMARK_SYNC_BATCH),
});
export type BookmarkSyncInput = z.infer<typeof BookmarkSyncInput>;

export const BookmarkSyncResponse = z.object({
  /** The server's revision now: send it as `since` next time. */
  rev: z.number().int().min(0),
  /** Nodes changed after `since` (the stored version of each, deletions included). */
  nodes: z.array(BookmarkNode),
});
export type BookmarkSyncResponse = z.infer<typeof BookmarkSyncResponse>;
