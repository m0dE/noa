/**
 * search_history: the agent's look into the user's past chats and task runs, as the side panel's jobs keep them (the
 * SessionStore), for "what did you tell me yesterday" when no episode was written for it (or memory's episode is too
 * short to answer). Deterministic, no model:
 *
 * - a search: the conversations whose words match the query's (stemmed, stop words and chat words left out), in the
 *   time it names (when.ts: "yesterday", "last week", ...), on the site asked for; best match first, then newest.
 *   A time with no matching words lists what happened then. Each result is one compact block: its local date, kind,
 *   title and outcome, the first request, and the result (the agent's last answer, else the turn's summary).
 * - session_id: that conversation's transcript, shortened (episodeTranscript: the request and the newest lines).
 *
 * Never listed: the conversation asking, and a chat whose memory the user turned off. Every text goes out redacted.
 */
import {
  bareToolName,
  episodeTranscript,
  MAX_HISTORY_LINE_CHARS,
  MAX_HISTORY_RESULTS,
  MAX_HISTORY_TRANSCRIPT_CHARS,
  memoryDomain,
  onDomain,
  redactSecrets,
  SearchHistoryArgs,
  type SessionInfo,
  type StampedAgentEvent,
} from "@noa/shared";
import { MAX_SESSIONS, type SessionStore } from "../engine/sessions.js";
import { transcriptLines } from "./episodes.js";
import { termsOf } from "./search.js";
import { hostsIn } from "./select.js";
import { namesTime, parseTime } from "./when.js";

/** Longest result (the agent's last answer) shown per conversation in a search's list. */
export const MAX_HISTORY_RESULT_CHARS = 600;

/** Words that only say the user is asking about a conversation ("what did you tell me"), not what it was about. */
const CHAT_WORDS = new Set(termsOf("remember remembered recall told tell telling said say saying talk talked talking chat chats chatted conversation mention mentioned last earlier previous before like ago"));

export interface HistoryDeps {
  sessions: Pick<SessionStore, "list" | "get" | "eventsOf">;
  now: Date;
  /** The user's time zone, minutes east of UTC (dates are theirs). */
  offsetMinutes: number;
}

/** search_history for the conversation `askingId`: the tool's answer (throws on bad arguments). */
export async function searchHistory(askingId: string, rawArgs: unknown, deps: HistoryDeps): Promise<{ text: string; isError?: true }> {
  const parsed = SearchHistoryArgs.safeParse(rawArgs);
  if (!parsed.success) return { text: `search_history arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`, isError: true };
  const args = parsed.data;
  if (args.session_id) return { text: await transcriptOf(args.session_id.replace(/^\[|\]$/g, ""), askingId, deps) };
  if (!args.query && !args.site) return { text: "search_history needs a query (words, time words like 'yesterday'), a site, or a session_id", isError: true };
  const site = args.site === undefined ? undefined : memoryDomain(args.site);
  if (site === null) return { text: `site "${args.site}" is not a site's host (e.g. mail.google.com)`, isError: true };
  return { text: await search(askingId, args.query ?? "", site, deps) };
}

interface Conversation {
  session: SessionInfo;
  events: StampedAgentEvent[];
  /** Its words (termsOf) as a set. */
  terms: Set<string>;
  /** The query's words it has. */
  matched: number;
}

async function search(askingId: string, query: string, site: string | undefined, deps: HistoryDeps): Promise<string> {
  const time = parseTime(query, deps.now, deps.offsetMinutes);
  const timed = namesTime(time);
  const from = time.from ? Date.parse(time.from) : -Infinity;
  const to = time.to ? Date.parse(time.to) : Infinity;
  const wanted = [...new Set(termsOf(time.rest))].filter((t) => !CHAT_WORDS.has(t));
  const candidates = (await deps.sessions.list(MAX_SESSIONS)).filter((s) => s.sessionId !== askingId && !s.memoryOff && overlaps(s, from, to, deps.now));

  const found: Conversation[] = [];
  for (const session of candidates) {
    const events = await deps.sessions.eventsOf(session.sessionId);
    const text = conversationText(session, events);
    if (site && !hostsIn(text).some((h) => onDomain(h, site))) continue;
    const terms = new Set(termsOf(text));
    found.push({ session, events, terms, matched: wanted.filter((t) => terms.has(t)).length });
  }
  const matching = found.filter((c) => c.matched > 0);
  // Time words alone, or words nothing then has: what happened then (newest first).
  const byWords = wanted.length > 0 && matching.length > 0;
  const shown = (byWords ? matching : wanted.length && !timed && !site ? [] : found)
    .sort((a, b) => (byWords ? b.matched - a.matched : 0) || lastActive(b.session).localeCompare(lastActive(a.session)))
    .slice(0, MAX_HISTORY_RESULTS);

  const asked = [query && `"${query}"`, site && `on ${site}`].filter(Boolean).join(" ");
  const when = periodText(time.from, time.to, deps.offsetMinutes);
  if (!shown.length) return `No past chat or run in History matches ${asked}${when}.`;
  const note = wanted.length && !byWords ? ` None has those words; here is everything${timed ? " from then" : ""}${site ? ` on ${site}` : ""}.` : "";
  const head = `${shown.length} past conversation(s) for ${asked}${when}, ${byWords ? "best match first" : "newest first"}.${note}`;
  return [head, ...shown.map((c) => block(c.session, c.events, deps.offsetMinutes)), "Give search_history a session_id to read that conversation."].join("\n");
}

/** One conversation's transcript: its heading, then its request and newest lines within MAX_HISTORY_TRANSCRIPT_CHARS. */
async function transcriptOf(sessionId: string, askingId: string, deps: HistoryDeps): Promise<string> {
  const session = sessionId === askingId ? null : await deps.sessions.get(sessionId);
  if (!session || session.memoryOff) return `No conversation ${sessionId} in History${sessionId === askingId ? " (that is this conversation)" : ""}.`;
  const events = await deps.sessions.eventsOf(sessionId);
  return [heading(session, deps.offsetMinutes), episodeTranscript(transcriptLines(session, events), MAX_HISTORY_TRANSCRIPT_CHARS)].join("\n");
}

function block(session: SessionInfo, events: readonly StampedAgentEvent[], offsetMinutes: number): string {
  const first = events.find((e) => e.type === "user_message")?.text ?? session.instructions ?? session.title;
  const answer = [...events].reverse().find((e) => e.type === "assistant_text")?.text;
  const result = answer ?? session.summary ?? session.reason;
  return [
    `- ${heading(session, offsetMinutes)}`,
    `  First request: ${clip(first, MAX_HISTORY_LINE_CHARS)}`,
    ...(result ? [`  Result: ${clip(result, MAX_HISTORY_RESULT_CHARS)}`] : []),
  ].join("\n");
}

/** "[session id] 2026-09-26 14:05 chat "Title" (done, 3 turns)", in the user's time. */
function heading(s: SessionInfo, offsetMinutes: number): string {
  const kind = s.source === "adhoc" ? "chat" : "task run";
  const state = [s.outcome ?? (s.endedAt ? "ended" : "running"), (s.turns ?? 1) > 1 ? `${s.turns} turns` : ""].filter(Boolean).join(", ");
  return `[${s.sessionId}] ${localStamp(s.firstStartedAt ?? s.startedAt, offsetMinutes)} ${kind} "${clip(s.title, MAX_HISTORY_LINE_CHARS)}" (${state})`;
}

/** What a conversation says, for matching: its title, request, messages, answers, results and where it went. */
function conversationText(s: SessionInfo, events: readonly StampedAgentEvent[]): string {
  const parts = [s.title, s.instructions ?? "", s.summary ?? "", s.url ?? ""];
  for (const e of events) {
    if (e.type === "user_message" || e.type === "assistant_text") parts.push(e.text);
    else if (e.type === "task_end") parts.push(e.summary ?? "", e.url ?? "");
    else if (e.type === "tool_call" && !bareToolName(e.name).startsWith("task_")) parts.push(JSON.stringify(e.args ?? ""));
  }
  return parts.join("\n");
}

/** When the conversation was last active (its latest turn's end, else start). */
const lastActive = (s: SessionInfo): string => s.endedAt ?? s.startedAt;

/** The conversation was going on some time in [from, to): from its first turn's start to its last turn's end. */
function overlaps(s: SessionInfo, from: number, to: number, now: Date): boolean {
  const start = Date.parse(s.firstStartedAt ?? s.startedAt);
  const end = s.endedAt ? Date.parse(s.endedAt) : now.getTime();
  return start < to && end >= from;
}

/** The period a search asked about, in the user's days: " (2026-09-26)", " (2026-09-21 to 2026-09-27)", " (until ...)", or "". */
function periodText(from: string | undefined, to: string | undefined, offsetMinutes: number): string {
  const first = from && localStamp(from, offsetMinutes).slice(0, 10);
  // The period ends just before `to`.
  const last = to && localStamp(new Date(Date.parse(to) - 1).toISOString(), offsetMinutes).slice(0, 10);
  if (!first && !last) return "";
  if (first === last) return ` (${first})`;
  if (first && last) return ` (${first} to ${last})`;
  return first ? ` (from ${first})` : ` (until ${last})`;
}

/** "YYYY-MM-DD HH:MM" in the user's time zone. */
function localStamp(iso: string, offsetMinutes: number): string {
  return new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

function clip(text: string, max: number): string {
  const t = redactSecrets(text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
