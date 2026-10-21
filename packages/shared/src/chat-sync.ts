import { z } from "zod";

// ---------------------------------------------------------------- chat history in the account

/**
 * The conversations (SessionInfo and its event stream) of a signed-in user, kept in the account so signing in on
 * another computer, or on a new install, brings back the chat history (apps/api/src/routes/chats.ts,
 * apps/extension/src/chat-sync.ts). A browser keeps its own copy (IndexedDB) and sends each conversation when a turn
 * ends; the account answers what changed since the revision the browser has, deletions included (a tombstone), so a
 * chat deleted on one computer goes from the others too.
 *
 * - GET    CHATS_PATH?since=rev        the chats changed after `rev` (their SessionInfo; at most CHAT_PAGE), and the revision now.
 * - PUT    CHATS_PATH/{sessionId}      a chat: its SessionInfo and its events (ChatUpload). An older copy than the stored one is ignored.
 * - GET    CHATS_PATH/{sessionId}/events  the chat's events.
 * - DELETE CHATS_PATH/{sessionId}      deletes it (a tombstone stays, so other computers learn of it).
 *
 * Any signed-in plan. An account keeps its newest MAX_CLOUD_CHATS chats; an older one goes when a newer one comes.
 */
export const CHATS_PATH = "/v1/chats";

/** Chats an account keeps (the newest by start); the oldest go past it. */
export const MAX_CLOUD_CHATS = 2000;
/** Changed chats one GET answers at most (`more`: ask again with the revision given). */
export const CHAT_PAGE = 200;
/** A chat's SessionInfo as JSON, at most. */
export const MAX_CHAT_INFO_CHARS = 64 * 1024;
/** A chat's events as JSON, at most (pictures are left out when sent: they are the bulk). */
export const MAX_CHAT_EVENTS_CHARS = 4 * 1024 * 1024;
/** Events one chat sends at most (the browser keeps as many, sessions.ts MAX_EVENTS_PER_SESSION). */
export const MAX_CHAT_EVENTS = 2000;

/** A session id as the extension makes them (a UUID; letters, digits, _ and - only). */
export const ChatId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "a chat id is letters, digits, _ and -");

/** A SessionInfo as stored (the fields read here checked; the rest kept as sent). */
export const ChatInfo = z.looseObject({
  sessionId: ChatId,
  source: z.string().max(20),
  title: z.string().max(10_000),
  startedAt: z.string().min(1).max(40),
  endedAt: z.string().max(40).optional(),
});
export type ChatInfo = z.infer<typeof ChatInfo>;

export const ChatUpload = z.object({
  info: ChatInfo,
  /** When this copy was made (its turn's end, or a rename): a copy older than the stored one is ignored. */
  updatedAt: z.string().min(1).max(40),
  /** Its events (StampedAgentEvent), oldest first. */
  events: z.array(z.record(z.string(), z.unknown())).max(MAX_CHAT_EVENTS),
});
export type ChatUpload = z.infer<typeof ChatUpload>;

export const CloudChat = z.object({
  sessionId: ChatId,
  updatedAt: z.string(),
  deleted: z.boolean(),
  /** Null for a deleted one. */
  info: ChatInfo.nullable(),
});
export type CloudChat = z.infer<typeof CloudChat>;

export const ChatChanges = z.object({
  /** The revision of the last chat answered (all of them: the revision now): send it as `since` next time. */
  rev: z.number().int().min(0),
  chats: z.array(CloudChat),
  /** More changes wait after `rev`. */
  more: z.boolean(),
});
export type ChatChanges = z.infer<typeof ChatChanges>;

export const ChatEvents = z.object({ events: z.array(z.record(z.string(), z.unknown())) });
export type ChatEvents = z.infer<typeof ChatEvents>;

export const ChatWritten = z.object({ rev: z.number().int().min(0), stored: z.boolean() });
export type ChatWritten = z.infer<typeof ChatWritten>;
