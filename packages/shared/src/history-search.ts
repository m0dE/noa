/**
 * search_history: the agent looks through the user's past chats and task runs (the side panel's jobs, kept in the
 * extension) by words, a time ("yesterday", "last week", "in March"), and a site; or reads one of them. What the
 * tool and its implementation (apps/extension/src/memory/history.ts) share: the arguments, the description, the
 * limits.
 */
import { z } from "zod";

/** Most conversations one search returns. */
export const MAX_HISTORY_RESULTS = 8;
/** Longest transcript excerpt of one conversation (session_id): its request and its newest lines that fit. */
export const MAX_HISTORY_TRANSCRIPT_CHARS = 4000;
/** Longest first request and result shown per conversation in a search's list. */
export const MAX_HISTORY_LINE_CHARS = 240;

export const SearchHistoryArgs = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Words to look for in past chats and runs (a topic, a person, a site), and time words for when they happened ('yesterday', 'last week', '3 days ago', 'in March'). Time words alone list what happened then",
    ),
  site: z.string().trim().min(1).max(253).optional().describe("Only conversations that worked on this site (its host, e.g. mail.google.com)"),
  session_id: z.string().trim().min(1).max(100).optional().describe("A session id from an earlier search_history result: returns that conversation's transcript (redacted, shortened)"),
});
export type SearchHistoryArgs = z.infer<typeof SearchHistoryArgs>;

export const SEARCH_HISTORY_DESCRIPTION =
  "Search the user's past chats and task runs with you (their jobs list): what was asked, what you did and what you answered. Give query (words and time words like 'yesterday'), site, or both; each result has its date, title, first request, result and session id. Give session_id to read one conversation's transcript. Use it when the user refers to an earlier conversation ('what did you tell me yesterday', 'the emails from last time').";
