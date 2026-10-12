/**
 * The background memory writer: after a chat goes idle or a task run ends, a small model reads the conversation
 * and writes its episode (a dated summary: what was asked, what was done, where, how it ended) and at most a few
 * durable facts the agent did not save itself (apps/extension/src/memory/episodes.ts). What every backend shares:
 * the models it runs on, its system prompt, the prompt (the conversation as a transcript, cut to a limit, with the
 * memory entries it must not repeat), and the reader of its answer, which forgives the usual ways a model wraps
 * JSON (code fences, a sentence before it) and keeps what is valid of what it wrote.
 */
import { z } from "zod";
import {
  MAX_MEMORY_ENTITIES,
  MAX_MEMORY_ENTITY_CHARS,
  MAX_MEMORY_SUBJECT_CHARS,
  MAX_MEMORY_TEXT_CHARS,
  memoryDomain,
  type MemoryEntry,
  type MemoryKind,
} from "./memory.js";
import { CLAUDE_MODELS, type ClaudeModelId } from "./models.js";
import { redactSecrets } from "./secret-text.js";

/** The writer's model with the hosted AI or the user's own API key: the cheapest Claude Noa offers (Haiku). */
export const MEMORY_WRITER_MODEL: ClaudeModelId = CLAUDE_MODELS.find((m) => m.id.startsWith("claude-haiku"))!.id;
/** The writer's model with Claude Code: its alias for the same model. */
export const MEMORY_WRITER_CLAUDE_CODE_MODEL = "haiku";
/** Longest answer the writer may give (tokens): one episode and a few facts, as JSON. */
export const MEMORY_WRITER_MAX_TOKENS = 1024;
/** How long one summary may take, at most (the helper kills Claude Code past it). */
export const MEMORY_SUMMARIZE_TIMEOUT_MS = 90_000;

/** Most characters of the conversation the writer reads: the first request and the newest lines that fit. */
export const MAX_EPISODE_TRANSCRIPT_CHARS = 12_000;
/** Longest single line of the transcript (a long answer is cut). */
export const MAX_TRANSCRIPT_LINE_CHARS = 1_200;
/** A conversation shorter than this (characters of transcript) is not worth an episode ("hi" / "Hello!"). */
export const MIN_EPISODE_TRANSCRIPT_CHARS = 200;
/** Most facts the writer saves from one conversation. */
export const MAX_WRITER_FACTS = 3;
/** Most existing entries shown to the writer so it does not repeat them. */
export const MAX_WRITER_EXISTING_ENTRIES = 40;

/** The kinds of fact the writer may save (never task notes, records or episodes: those have their own writers). */
export const WriterFactKind = z.enum(["preference", "account", "person", "playbook"]);
export type WriterFactKind = z.infer<typeof WriterFactKind>;

/** One line of a conversation as the writer reads it. */
export interface TranscriptLine {
  who: "user" | "agent" | "action" | "outcome";
  text: string;
}

export interface MemoryWriterInput {
  /** A chat, or a task run (a TODO or cloud task). */
  kind: "chat" | "task";
  title: string;
  /** When the conversation started and last ended (ISO). */
  startedAt: string;
  endedAt?: string;
  lines: readonly TranscriptLine[];
  /** Memory entries the writer must not repeat (and may name in `replaces`). */
  existing: readonly Pick<MemoryEntry, "id" | "kind" | "subject" | "text" | "domain">[];
}

export const MEMORY_WRITER_SYSTEM_PROMPT = [
  "You keep the long-term memory of a browser agent that works for one user. You read one finished conversation between the user and the agent, and answer with JSON only:",
  '{"episode": {"subject": "...", "text": "...", "entities": ["..."]} or null, "facts": [{"kind": "preference|account|person|playbook", "subject": "...", "text": "...", "domain": "...", "replaces": "..."}]}',
  "",
  `episode: a dated summary of this conversation for later ("what did we do about X last month"). subject: a short title (at most ${MAX_MEMORY_SUBJECT_CHARS} characters). text: at most ${MAX_MEMORY_TEXT_CHARS} characters, plain sentences: what the user asked, what the agent did, and how it ended (done, stopped, failed, and why). entities: at most ${MAX_MEMORY_ENTITIES} sites (as hosts, e.g. app.channex.io), people, order or booking IDs and accounts it involved, written as they appeared. Null only when nothing happened worth remembering (a greeting, a question answered from general knowledge).`,
  "",
  `facts: at most ${MAX_WRITER_FACTS}, usually none. Only durable facts about the user that will still be true and save time in later conversations, and that are not already in memory (the list you are given) or saved by the agent during the conversation. preference: how the user wants things done. account: which account is which (an address, a /u/N index, a handle). person: who someone is to the user. playbook: how to get something done on one site (give domain, the site's host). When the conversation makes an entry of the list untrue (the user changed it: a new accountant, a new address), name that entry's id in replaces. Never replace an entry that stays true: a narrower rule (support replies, beside all emails), another account or another person is a new fact next to it. Never page content, what someone wrote, one-off details of this task, or guesses.`,
  "",
  "Rules: the conversation's dates are given; never invent a date, a name or an outcome that is not in it. Never write passwords, one-time codes, PINs, API keys, tokens or card numbers, even if they appear. Answer with the JSON object and nothing else.",
].join("\n");

const WHO: Record<TranscriptLine["who"], string> = { user: "User", agent: "Agent", action: "Did", outcome: "Outcome" };

function clipLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The conversation as the writer reads it: its lines ("User: ...", "Agent: ...", "Did: navigate x.com", "Outcome:
 * done ..."), each clipped and with secrets redacted, cut to `maxChars`: the first line (the request) always, then
 * the newest lines that fit, with how many were left out between.
 */
export function episodeTranscript(lines: readonly TranscriptLine[], maxChars = MAX_EPISODE_TRANSCRIPT_CHARS): string {
  const rendered = lines.filter((l) => l.text.trim()).map((l) => `${WHO[l.who]}: ${redactSecrets(clipLine(l.text, MAX_TRANSCRIPT_LINE_CHARS))}`);
  if (!rendered.length) return "";
  const [first, ...rest] = rendered;
  let used = first!.length;
  const tail: string[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const line = rest[i]!;
    if (used + line.length + 1 > maxChars) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const skipped = rest.length - tail.length;
  return [first, ...(skipped ? [`[… ${skipped} earlier line(s) left out …]`] : []), ...tail].join("\n");
}

/** The writer's prompt: the conversation's dates and kind, its transcript, and the memory entries it must not repeat. */
export function buildMemoryWriterPrompt(input: MemoryWriterInput, maxChars = MAX_EPISODE_TRANSCRIPT_CHARS): string {
  const existing = input.existing.slice(0, MAX_WRITER_EXISTING_ENTRIES).map((e) => `[${e.id}] ${e.kind} ${e.subject}${e.domain ? ` (${e.domain})` : ""}: ${e.text}`);
  return [
    `A ${input.kind === "task" ? "task run" : "chat"}: "${input.title}"`,
    `Started: ${input.startedAt}${input.endedAt ? `. Last ended: ${input.endedAt}` : ""}`,
    "",
    "<conversation>",
    episodeTranscript(input.lines, maxChars),
    "</conversation>",
    "",
    "Already in memory (do not repeat these; name an id in replaces only when the new fact makes it untrue):",
    ...(existing.length ? existing : ["(nothing)"]),
    "",
    "Answer with the JSON object only.",
  ].join("\n");
}

/** How long the transcript of these lines is (for MIN_EPISODE_TRANSCRIPT_CHARS). */
export const transcriptChars = (lines: readonly TranscriptLine[]): number => lines.reduce((n, l) => n + l.text.trim().length, 0);

const Subject = z.string().trim().min(1).max(MAX_MEMORY_SUBJECT_CHARS);
const Text = z.string().trim().min(1).max(MAX_MEMORY_TEXT_CHARS);

export const WriterEpisode = z.object({
  subject: Subject,
  text: Text,
  entities: z.array(z.string().trim().min(1).max(MAX_MEMORY_ENTITY_CHARS)).max(MAX_MEMORY_ENTITIES).default([]),
});
export type WriterEpisode = z.infer<typeof WriterEpisode>;

export const WriterFact = z.object({
  kind: WriterFactKind,
  subject: Subject,
  text: Text,
  domain: z.string().trim().min(1).max(253).optional(),
  replaces: z.string().trim().min(1).max(64).optional(),
});
export type WriterFact = z.infer<typeof WriterFact>;

export const MemoryWriterAnswer = z.object({
  episode: WriterEpisode.nullable(),
  facts: z.array(WriterFact).max(MAX_WRITER_FACTS),
});
export type MemoryWriterAnswer = z.infer<typeof MemoryWriterAnswer>;

/** The first JSON object in a model's reply: inside code fences or after a sentence, up to its matching brace. */
function jsonObjectIn(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("the writer's answer holds no JSON object");
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("the writer's answer is cut off (its JSON object never closes)");
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A string cut to `max` characters (at a word when one ends near the limit), or the value as it was. */
function fit(v: unknown, max: number): unknown {
  if (typeof v !== "string") return v;
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.8 ? cut.slice(0, space) : cut}…`;
}

/** An entity as memory keeps it: a URL or a host becomes the site's host, anything else stays as written. */
function entityOf(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const raw = v.trim();
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(raw) ? memoryDomain(raw) : null;
  return (host ?? raw).slice(0, MAX_MEMORY_ENTITY_CHARS);
}

/**
 * The writer's answer, forgiving: the JSON object is found wherever it is, over-long text is cut to its limit, a
 * malformed episode is null, and each malformed fact is left out (the valid ones are kept, at most MAX_WRITER_FACTS).
 * Throws when there is no JSON object at all (worth another try).
 */
export function parseMemoryWriterAnswer(text: string): MemoryWriterAnswer {
  const raw = obj(jsonObjectIn(text));
  const ep = raw.episode === null || raw.episode === undefined ? null : obj(raw.episode);
  const entities = Array.isArray(ep?.entities) ? [...new Set(ep.entities.map(entityOf).filter((e): e is string => !!e))].slice(0, MAX_MEMORY_ENTITIES) : [];
  const episode = ep ? WriterEpisode.safeParse({ subject: fit(ep.subject, MAX_MEMORY_SUBJECT_CHARS), text: fit(ep.text, MAX_MEMORY_TEXT_CHARS), entities }) : null;
  const facts = (Array.isArray(raw.facts) ? raw.facts : []).flatMap((f) => {
    const o = obj(f);
    const parsed = WriterFact.safeParse({
      ...o,
      subject: fit(o.subject, MAX_MEMORY_SUBJECT_CHARS),
      text: fit(o.text, MAX_MEMORY_TEXT_CHARS),
      ...(o.domain === null || o.domain === "" ? { domain: undefined } : {}),
      ...(o.replaces === null || o.replaces === "" ? { replaces: undefined } : {}),
    });
    return parsed.success ? [parsed.data] : [];
  });
  return { episode: episode?.success ? episode.data : null, facts: facts.slice(0, MAX_WRITER_FACTS) };
}

/** The kinds the writer saves, less those the user turned off. */
export function writerFactKinds(kindsOff: readonly MemoryKind[]): WriterFactKind[] {
  return WriterFactKind.options.filter((k) => !kindsOff.includes(k));
}
