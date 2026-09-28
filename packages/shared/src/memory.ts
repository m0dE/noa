/**
 * The agent's long-term memory: durable facts it keeps between chats and
 * runs (the user's preferences, which account is which, people, how a site
 * works, and what earlier runs of a repeating task did). What the tools, the
 * extension's store (apps/extension/src/memory/) and the settings share: the
 * kinds, the entry, the limits, the tools' arguments, and the rule that no
 * secret is ever kept (secretProblem).
 */
import { z } from "zod";
import { secretProblem } from "./secret-text.js";
import { siteHost } from "./urls.js";
import type { MemoryToolName } from "./tools.js";

/**
 * preference: how the user wants things done (tone, sign-offs, language, "never post before 8am").
 * account: which account is which ("admin@runhq.io is the work email, Google /u/2"). Never a password.
 * person: facts about people the user deals with ("Paul Lee is my accountant"), not what they wrote.
 * playbook: how to get something done on one site (direct URLs, where a button is, pitfalls).
 * task: what earlier runs of a repeating task did (topics posted, replies sent, what is pending).
 * episode: a dated summary of one chat or one task run (what was asked, what was done, the sites and things
 *   involved, how it ended), written in the background after the chat goes idle or the run ends (never by the
 *   agent's remember). One per conversation: a later turn of the same chat rewrites it.
 * record: what the user's chats learned about one thing, filed under its identifier (a ticket, an order, a customer's
 *   email): remember with `key` outside a repeating task (a repeating task files its own records, kind task).
 */
export const MemoryKind = z.enum(["preference", "account", "person", "playbook", "task", "episode", "record"]);
export type MemoryKind = z.infer<typeof MemoryKind>;
export const MEMORY_KINDS: readonly MemoryKind[] = MemoryKind.options;
/** The kinds the agent's remember writes (episodes come from the background writer only). */
export const RememberKind = z.enum(["preference", "account", "person", "playbook", "task", "record"]);
export type RememberKind = z.infer<typeof RememberKind>;

/** Where an entry applies: everywhere, on one site (and its subdomains), or to one repeating task. */
export const MemoryScope = z.enum(["global", "domain", "task"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/** How each kind reads in Settings and in the agent's prompt, in the order both list them. */
export const MEMORY_KIND_TEXT: Record<MemoryKind, { label: string; hint: string }> = {
  task: { label: "Task history", hint: "What earlier runs of a repeating task did, so the next run goes on from there" },
  record: { label: "Records (by key)", hint: "What chats learned about one thing, filed under its identifier: a ticket, an order, a customer's email" },
  episode: { label: "Episodes", hint: "A dated summary of each chat and task run: what was asked, what was done, where, and how it ended" },
  playbook: { label: "Site playbooks", hint: "How to get things done on a site the agent worked on: addresses, buttons, pitfalls" },
  account: { label: "Accounts", hint: "Which account is which (never passwords)" },
  person: { label: "People", hint: "Who people are to you (not what they wrote)" },
  preference: { label: "Preferences", hint: "Tone, sign-offs, language, summaries, rules like “never post before 8am”" },
};

export const MAX_MEMORY_SUBJECT_CHARS = 80;
export const MAX_MEMORY_TEXT_CHARS = 400;
/** Entries kept in all; past it the least recently used go first. */
export const MAX_MEMORY_ENTRIES = 500;
/**
 * Runs a repeating task's history keeps one by one (each run's note and output, TASK_RUN_SUBJECT): at 3 runs a day
 * about two months. Past it the oldest are folded into the task's EARLIER_RUNS_SUBJECT summary.
 */
export const MAX_TASK_RUNS = 200;
/** Task history entries kept in all (every task's runs, summaries and notes), apart from the rest of memory (MAX_MEMORY_ENTRIES). */
export const MAX_TASK_HISTORY_ENTRIES = 2000;
/** Longest run note the agent leaves at the end of a task (task_complete `memory_note`). */
export const MAX_MEMORY_NOTE_CHARS = 300;
/** Longest output of one run kept (task_complete `output`: the exact text it posted or sent); a longer one is cut. */
export const MAX_RUN_OUTPUT_CHARS = 1000;
/** The subject of a run's entry in its task's history (task_complete's memory_note and output). */
export const TASK_RUN_SUBJECT = "Run note";
/** The subject of a task's summary of its runs older than MAX_TASK_RUNS. */
export const EARLIER_RUNS_SUBJECT = "Earlier runs";
/**
 * The subject of a repeating task's profile (remember, kind task): what the account or product it works for is, its
 * voice, topics and the user's rules for it. Given at every run of the task, first.
 */
export const TASK_PROFILE_SUBJECT = "Profile";

/** What the memory given to the agent at the start of a turn may cost, at most (tokens, estimated from characters). */
export const MEMORY_TOKEN_BUDGET = 600;
/** Characters per token, for estimating what an entry costs in the prompt. */
export const MEMORY_CHARS_PER_TOKEN = 4;
/**
 * What a repeating task's own history may cost in a turn's prompt (tokens), apart from MEMORY_TOKEN_BUDGET (a chat
 * never spends it): its profile, its earlier-runs summary, its newest runs in full, then one short line per earlier
 * run. Measured (memory-select.test.ts): 20 runs with 300-character notes and 280-character outputs, a profile and a
 * summary cost 773.
 */
export const MEMORY_TASK_HISTORY_TOKEN_BUDGET = 800;
/** The newest runs of the task given in full: their note and the start of their output. */
export const MAX_INJECTED_TASK_NOTES = 2;
/** Runs of the task given in all, newest first (past the full ones, one short line each: date and output); the rest: recall, check_similar. */
export const MAX_INJECTED_TASK_RUNS = 20;
/** How much of a run's output its full line shows. */
export const RUN_OUTPUT_FULL_CHARS = 160;
/** How much of a run's output (or note) its short line shows. */
export const RUN_OUTPUT_BRIEF_CHARS = 80;
/** Most entries recall returns. */
export const MAX_RECALL_RESULTS = 8;
/** Episodes kept in all, apart from the rest of memory (MAX_MEMORY_ENTRIES); past it the oldest go. */
export const MAX_EPISODES = 1000;
/** Most sites and things (people, IDs, accounts) an entry names in `entities`. */
export const MAX_MEMORY_ENTITIES = 12;
/** Longest entity. */
export const MAX_MEMORY_ENTITY_CHARS = 80;
/** Earlier values an entry keeps once replaced (newest first). */
export const MAX_MEMORY_HISTORY = 3;

// ---------------------------------------------------------------- records, by key

/*
 * Work that deals with many separate things (tickets, orders, customers, leads) keeps what it learns about each in a
 * record filed under the thing's identifier, its key (remember with `key`): a summary and a few dated notes. A
 * record lives in a space: a repeating task's own (kind and scope "task", its taskKey), or, from a chat, the user's
 * (kind "record", scope "global", no taskKey). Each space has its own limit (MAX_TASK_RECORDS), apart from the
 * rest of memory (MAX_MEMORY_ENTRIES), so records never push out other memory and one space never another's. In a
 * repeating task, a key is looked up in the task's records first, then in the user's.
 */
/** Records one space (a repeating task's, or the user's) keeps; past it its least recently used record goes. */
export const MAX_TASK_RECORDS = 1000;
/** Longest key (an identifier, as given). */
export const MAX_RECORD_KEY_CHARS = 120;
/** Dated notes a record keeps beside its summary (the newest); older ones are folded into the summary. */
export const MAX_RECORD_NOTES = 5;
/** A record's summary and notes together, at most (characters); past it the oldest notes are folded into the summary. */
export const MAX_RECORD_CHARS = 800;
/** What records named in a turn may cost in the prompt (tokens), within MEMORY_TOKEN_BUDGET: one whole record fits. */
export const MEMORY_RECORD_TOKEN_BUDGET = 300;
/** How much of a summary's beginning folding keeps when the summary grows too long (what the record first said). */
export const RECORD_SUMMARY_HEAD_CHARS = 120;

/** Where an entry came from: an agent run (a task or a chat), or the user in Settings. */
export interface MemorySource {
  kind: "task" | "chat" | "user";
  sessionId?: string;
  /** The run's title, for Settings ("from 'Post the daily tip'"). */
  title?: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** What it is about, short: "Work email", "Paul Lee", "Sign-off", "Compose button". Entries are updated by kind + subject + scope. */
  subject: string;
  text: string;
  scope: MemoryScope;
  /** scope "domain": the site's host without www ("mail.google.com", "x.com"). */
  domain?: string;
  /** scope "task": the repeating task it belongs to (memoryTaskKey). */
  taskKey?: string;
  /** scope "task": the task's first line, for Settings. */
  taskTitle?: string;
  source: MemorySource;
  learnedAt: string;
  updatedAt: string;
  /** Last time it was given to the agent or recalled. */
  lastUsedAt?: string;
  /** A task's record: the identifier it is filed under, normalized (memoryRecordKey). Absent: not a record. */
  key?: string;
  /** A record's dated notes, oldest first (at most MAX_RECORD_NOTES; condenseRecord folds older ones into `text`). */
  notes?: RecordNote[];
  /** An episode: when what it tells happened (its conversation's start). Other entries: absent (learnedAt). */
  at?: string;
  /** The sites and things it involves, as written ("app.channex.io", "Paul Lee", "HM4K2ZQ9"): matched whole. */
  entities?: string[];
  /** Values it had before it was replaced (the same slot, or the entry remember's `replaces` named), newest first. */
  history?: MemoryPastValue[];
  /** The user marked it to be given at the start of every turn (a tiny always-on core). */
  pinned?: true;
  /** A task run (TASK_RUN_SUBJECT): what it produced, e.g. the exact text it posted or sent (task_complete `output`). */
  output?: string;
}

/** An earlier value of an entry: what it said, and from when until when. */
export interface MemoryPastValue {
  subject: string;
  text: string;
  since: string;
  until: string;
}

/** When an entry's content happened or was learned: an episode's `at`, else learnedAt. */
export const memoryDate = (e: Pick<MemoryEntry, "at" | "learnedAt">): string => e.at ?? e.learnedAt;

/** One dated note of a record. */
export interface RecordNote {
  at: string;
  text: string;
}

const RecordNoteSchema = z.object({ at: z.string().min(1).max(40), text: z.string().min(1).max(MAX_MEMORY_TEXT_CHARS) });
const PastValueSchema = z.object({
  subject: z.string().min(1).max(MAX_MEMORY_SUBJECT_CHARS),
  text: z.string().min(1).max(MAX_MEMORY_TEXT_CHARS),
  since: z.string().min(1).max(40),
  until: z.string().min(1).max(40),
});

/** A record (filed under a key: a repeating task's, or the user's), not a fact. */
export const isMemoryRecord = (e: { key?: string | undefined }): boolean => e.key !== undefined;

/** The characters a record holds: its summary and its notes (MAX_RECORD_CHARS). */
export const recordChars = (e: { text: string; notes?: readonly RecordNote[] | undefined }): number => e.text.length + (e.notes ?? []).reduce((n, x) => n + x.text.length, 0);

/** A stored entry as it is checked when read back or synced (unknown fields dropped). */
export const MemoryEntrySchema = z.object({
  id: z.string().min(1).max(64),
  kind: MemoryKind,
  subject: z.string().min(1).max(MAX_MEMORY_SUBJECT_CHARS),
  text: z.string().min(1).max(MAX_MEMORY_TEXT_CHARS),
  scope: MemoryScope,
  domain: z.string().min(1).max(253).optional(),
  taskKey: z.string().min(1).max(64).optional(),
  taskTitle: z.string().max(MAX_MEMORY_SUBJECT_CHARS).optional(),
  source: z.object({ kind: z.enum(["task", "chat", "user"]), sessionId: z.string().max(128).optional(), title: z.string().max(200).optional() }),
  learnedAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
  key: z.string().min(1).max(MAX_RECORD_KEY_CHARS).optional(),
  notes: z.array(RecordNoteSchema).max(MAX_RECORD_NOTES).optional(),
  at: z.string().min(1).max(40).optional(),
  entities: z.array(z.string().min(1).max(MAX_MEMORY_ENTITY_CHARS)).max(MAX_MEMORY_ENTITIES).optional(),
  history: z.array(PastValueSchema).max(MAX_MEMORY_HISTORY).optional(),
  pinned: z.literal(true).optional(),
  output: z.string().min(1).max(MAX_RUN_OUTPUT_CHARS).optional(),
}).superRefine((e, ctx) => {
  if (e.output !== undefined && !(e.kind === "task" && e.scope === "task" && !!e.taskKey && e.key === undefined)) {
    ctx.addIssue({ code: "custom", path: ["output"], message: "only a repeating task's run has an output" });
  }
  if (e.kind === "record" && e.key === undefined) ctx.addIssue({ code: "custom", path: ["key"], message: "a record has a key" });
  if (e.kind === "episode" && (e.key !== undefined || e.scope !== "global")) ctx.addIssue({ code: "custom", path: ["kind"], message: "an episode is global and has no key" });
  if (e.key === undefined && e.notes === undefined) return;
  const taskRecord = e.scope === "task" && e.kind === "task" && !!e.taskKey;
  const userRecord = e.scope === "global" && e.kind === "record" && !e.taskKey;
  if (!taskRecord && !userRecord) ctx.addIssue({ code: "custom", path: ["key"], message: "a record is a repeating task's (kind and scope task) or the user's (kind record, scope global)" });
  if (e.key === undefined) ctx.addIssue({ code: "custom", path: ["notes"], message: "only a record (with a key) has notes" });
  if (recordChars(e) > MAX_RECORD_CHARS) ctx.addIssue({ code: "custom", path: ["notes"], message: `a record holds at most ${MAX_RECORD_CHARS} characters` });
});

// ---------------------------------------------------------------- sync with the account (paid plans)

/**
 * Memory is kept in the signed-in account too, on a plan with the TODO list (the owner's rule for what keeps
 * accumulating in cloud storage, docs/BILLING-CONTRACT.md), so another browser gets it. GET MEMORY_PATH?since=rev
 * reads the changes after `rev` (also when the plan no longer includes it: read-only); POST MEMORY_SYNC_PATH sends
 * this browser's changes and answers the changes since `since`; DELETE MEMORY_PATH forgets everything on the server.
 * A change wins over another of the same entry when it is newer (updatedAt; a deletion's `at`).
 */
export const MEMORY_PATH = "/v1/memory";
export const MEMORY_SYNC_PATH = "/v1/memory/sync";
/** Most upserts and most deletions in one sync request. */
export const MAX_MEMORY_SYNC_BATCH = 500;

export const MemoryDeletion = z.object({ id: z.string().min(1).max(64), at: z.string().min(1).max(40) });
export type MemoryDeletion = z.infer<typeof MemoryDeletion>;

export const MemorySyncInput = z.object({
  /** The server revision this browser has (0: none yet). */
  since: z.number().int().min(0),
  upserts: z.array(MemoryEntrySchema).max(MAX_MEMORY_SYNC_BATCH),
  deletes: z.array(MemoryDeletion).max(MAX_MEMORY_SYNC_BATCH),
});
export type MemorySyncInput = z.infer<typeof MemorySyncInput>;

export const MemorySyncResponse = z.object({
  /** The server's revision now: send it as `since` next time. */
  rev: z.number().int().min(0),
  /** Entries changed after `since` (newest version of each). */
  entries: z.array(MemoryEntrySchema),
  /** Entries deleted after `since`. */
  deleted: z.array(MemoryDeletion),
  /** Upserts the server refused (a secret in them): never sent again. */
  refused: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
  /** The plan does not include sync (read-only: what was kept is still listed). */
  locked: z.boolean(),
});
export type MemorySyncResponse = z.infer<typeof MemorySyncResponse>;

// ---------------------------------------------------------------- semantic search (signed in)

/**
 * The account computes an embedding of each synced entry (memoryEmbeddingText) and answers POST
 * MEMORY_SEARCH_PATH with the entries nearest to a query (cosine similarity), so the extension can fuse meaning
 * with its own keyword, key, entity and date matching. Signed out or offline it goes on without it.
 */
export const MEMORY_SEARCH_PATH = "/v1/memory/search";
/** Longest query embedded (characters; a long request is cut). */
export const MAX_MEMORY_SEARCH_QUERY_CHARS = 1000;
/** Most hits one search answers. */
export const MAX_MEMORY_SEARCH_HITS = 100;

export const MemorySearchInput = z.object({
  query: z.string().trim().min(1).max(MAX_MEMORY_SEARCH_QUERY_CHARS),
  /** The turn's repeating task: its records are searched too (other tasks' records never are). */
  taskKey: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(MAX_MEMORY_SEARCH_HITS).optional(),
});
export type MemorySearchInput = z.infer<typeof MemorySearchInput>;

export const MemorySearchResponse = z.object({
  /** The embedding model the scores come from. */
  model: z.string(),
  /** Nearest first; `score` is the cosine similarity (-1..1). */
  hits: z.array(z.object({ id: z.string(), score: z.number() })),
  /** Entries not embedded yet (they are embedded in the background and found by later searches). */
  pending: z.number().int().min(0),
});
export type MemorySearchResponse = z.infer<typeof MemorySearchResponse>;

// ---------------------------------------------------------------- the agent's tools

export const RememberArgs = z.object({
  kind: RememberKind.describe(
    "preference: how the user wants things done. account: which account is which (an address, a /u/N index, a handle), never a password. person: who someone is to the user. playbook: how to get something done on one site (give domain). task: a note for the next run of this repeating task (subject Profile: the task's profile, what the account or product it works for is, its voice, topics and the user's rules; given at every run). record: a fact about one thing filed under its key (give key; with key the kind is settled for you)",
  ),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(MAX_MEMORY_SUBJECT_CHARS)
    .optional()
    .describe(
      "A short name for what it is about, e.g. 'Work email', 'Paul Lee', 'Sign-off', 'Compose button'. Remembering the same kind and subject again replaces the old entry. Required, except with key",
    ),
  text: z.string().trim().min(1).max(MAX_MEMORY_TEXT_CHARS).describe("The fact, in one or two plain sentences that will still make sense in a later run"),
  scope: MemoryScope.optional().describe("global (default), domain (only on that site: give domain), or task (only for this repeating task). Default: task for kind task, domain when domain is given"),
  domain: z.string().trim().min(1).max(253).optional().describe("The site's host, e.g. mail.google.com or x.com. Required for playbook"),
  key: z
    .string()
    .trim()
    .min(1)
    .max(MAX_RECORD_KEY_CHARS)
    .optional()
    .describe(
      "For work through many separate things (tickets, orders, customers, leads): the identifier of the one thing this fact is about (its email address, ID, number or name), never the task itself. Files it in the record for that key (a repeating task's own records, else the user's); the same key again adds a dated note to it. What a run did goes in task_complete's memory_note instead",
    ),
  replaces: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe("The id of an entry this fact replaces under another subject (e.g. a new accountant replacing the old one): that entry goes, and its value is kept as this one's history"),
});
export type RememberArgs = z.infer<typeof RememberArgs>;

export const RecallArgs = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Words to look for: a site, a person, an account, a topic. Time words narrow it to what happened then ('last spring', 'in March 2025', 'yesterday', 'before the price change')"),
  key: z.string().trim().min(1).max(MAX_RECORD_KEY_CHARS).optional().describe("An identifier a record was filed under (remember with key): returns that record (in a repeating task, its own record first)"),
});
export type RecallArgs = z.infer<typeof RecallArgs>;

export const ForgetArgs = z.object({
  id: z.string().trim().min(1).max(64).describe("The entry's id as memory lists it, e.g. m3k9"),
});
export type ForgetArgs = z.infer<typeof ForgetArgs>;

/** Longest draft check_similar compares (characters). */
export const MAX_SIMILAR_DRAFT_CHARS = 4000;

export const CheckSimilarArgs = z.object({
  draft: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SIMILAR_DRAFT_CHARS)
    .describe("The exact text you are about to publish or send: the whole post, message, reply or article, as it will go out"),
});
export type CheckSimilarArgs = z.infer<typeof CheckSimilarArgs>;

export const CHECK_SIMILAR_DESCRIPTION =
  "Compare a draft with what earlier runs of this repeating task (and the user's other repeating tasks) produced: answers the closest earlier outputs with their dates and similarity, and whether the draft is too similar. In a repeating task that publishes or sends content, call it with the exact text before it goes out; when it says too similar, or an earlier output says the same thing in other words, change the draft (another topic, angle or wording) and check again.";

export const REMEMBER_DESCRIPTION =
  "Save a durable fact for later chats and runs: a preference, which account is which, who someone is, how a site works (playbook), or a note for this repeating task. Only facts that stay true and save time later; never page content, passwords, codes or keys. The user sees each saved fact with Undo.";
export const RECALL_DESCRIPTION =
  "Search your memory for facts not given at the start of the turn (older task notes, dated episodes of past chats and runs, another site's playbook, a person, what a fact was before it changed), or get the record for an identifier (key). Give query or key.";
export const FORGET_DESCRIPTION = "Delete a memory entry that turned out wrong or out of date (by its id). To correct one, remember it again with the same kind and subject.";

/** RPC the helper calls on the extension for the memory tools (MEMORY_TOOLS: remember, recall, forget, search_history, check_similar; Claude Code brain), with the task session's id. */
export type MemoryMethods = {
  "memory.call": { params: { sessionId: string; tool: MemoryToolName; args: unknown }; result: { text: string; isError?: boolean } };
};

// ---------------------------------------------------------------- rules every write follows

/** Why an entry must not be kept (a credential in its subject, text, key or a record's notes), or null. */
export function memoryWriteProblem(e: {
  subject: string;
  text: string;
  key?: string | undefined;
  notes?: readonly RecordNote[] | undefined;
  entities?: readonly string[] | undefined;
  history?: readonly MemoryPastValue[] | undefined;
  output?: string | undefined;
}): string | null {
  let why: string | null = null;
  const parts = [
    e.subject,
    e.text,
    e.key ?? "",
    e.output ?? "",
    ...(e.notes ?? []).map((n) => n.text),
    ...(e.entities ?? []),
    ...(e.history ?? []).flatMap((h) => [h.subject, h.text]),
  ];
  for (const part of parts) if ((why = secretProblem(part))) break;
  return why ? `Not saved: ${why}. Memory never keeps passwords, codes, keys or card numbers; describe it without the value (e.g. "the login is in Site logins").` : null;
}

/**
 * A site's host as memory keys it ("https://www.X.com/home" -> "x.com", "http://localhost:4777/w" -> "localhost");
 * null when it is not a host (a bare word such as "gmail" is not: only localhost goes without a dot).
 */
export function memoryDomain(site: string): string | null {
  const host = siteHost(site);
  return host === "localhost" || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** `host` is `domain` or one of its subdomains ("mail.google.com" is on "google.com"). */
export function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** A task as its memory knows it: its series (Task.seriesId) when it has one, else its instructions and account. */
export interface MemoryTaskRef {
  instructions: string;
  account: string | null | undefined;
  seriesId?: string | null | undefined;
}

/**
 * The key a task's memory (its runs, records and episodes) is kept under: its series ("s" + Task.seriesId), the same
 * for every repeat and through edits of its instructions, schedule or account. A task without a series (from an
 * older server) is keyed by its instructions and account (memoryTaskKey).
 */
export function memoryKeyOfTask(t: MemoryTaskRef): string {
  return t.seriesId ? seriesTaskKey(t.seriesId) : memoryTaskKey(t.instructions, t.account);
}

/** The memory key of a task series. */
export const seriesTaskKey = (seriesId: string): string => `s${seriesId}`.slice(0, 64);

/**
 * The key a task's memory was kept under before tasks had a series (and still is for one without): the same for
 * every run with the same instructions and account, different when either changes. FNV-1a. Memory kept under it
 * moves to the series' key (MemoryService adopts it).
 */
export function memoryTaskKey(instructions: string, account: string | null | undefined): string {
  const text = `${instructions.replace(/\s+/g, " ").trim().toLowerCase()}\n${(account ?? "").trim().toLowerCase()}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `t${h1.toString(36)}${h2.toString(36)}`;
}

/**
 * An entry as the agent reads it: "[m3k9] Work email: admin@runhq.io is the work email (Google /u/2)". A record:
 * "[m7q2] key 48213: summary · 2026-09-24: newer note".
 */
export function memoryLine(
  e: Pick<MemoryEntry, "id" | "kind" | "subject" | "text" | "domain" | "learnedAt" | "key" | "notes" | "at" | "history"> & { output?: string | undefined },
  opts: { history?: boolean } = {},
): string {
  if (e.key !== undefined) {
    const label = memoryRecordKey(e.subject) === e.key ? e.subject : `${e.subject} (key ${e.key})`;
    const notes = (e.notes ?? []).map((n) => ` · ${n.at.slice(0, 10)}: ${n.text}`).join("");
    return `[${e.id}] key ${label}: ${e.text}${notes}`;
  }
  const where = e.domain ? ` (${e.domain})` : "";
  const when = e.kind === "task" || e.kind === "episode" ? `${memoryDate(e).slice(0, 10)} ` : "";
  const before = opts.history ? (e.history ?? []).map((h) => ` · until ${h.until.slice(0, 10)}: ${sameSubject(h.subject, e.subject) ? "" : `${h.subject}: `}${h.text}`).join("") : "";
  const output = e.output ? ` · output: "${clipLine(e.output, RUN_OUTPUT_FULL_CHARS)}"` : "";
  return `[${e.id}] ${when}${e.subject}${where}: ${e.text}${output}${before}`;
}

/** A task run in one short line: its date and the start of its output (else its note): 2026-09-25 "Three ways to …". */
export function taskRunBrief(e: Pick<MemoryEntry, "learnedAt" | "at" | "text" | "output">): string {
  return `${memoryDate(e).slice(0, 10)} "${clipLine(e.output ?? e.text, RUN_OUTPUT_BRIEF_CHARS)}"`;
}

/** A run of a repeating task (task_complete's memory_note and output): not its summary, nor a fact remembered for it. */
export const isTaskRun = (e: Pick<MemoryEntry, "kind" | "subject" | "key">): boolean => e.kind === "task" && e.key === undefined && e.subject === TASK_RUN_SUBJECT;
/** A repeating task's summary of its runs older than MAX_TASK_RUNS. */
export const isEarlierRuns = (e: Pick<MemoryEntry, "kind" | "subject" | "key">): boolean => e.kind === "task" && e.key === undefined && e.subject === EARLIER_RUNS_SUBJECT;
/** A repeating task's profile (TASK_PROFILE_SUBJECT). */
export const isTaskProfile = (e: Pick<MemoryEntry, "kind" | "subject" | "key">): boolean =>
  e.kind === "task" && e.key === undefined && e.subject.trim().toLowerCase() === TASK_PROFILE_SUBJECT.toLowerCase();

/** Text on one line, at most `max` characters (cut with …). */
export function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

const sameSubject = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What of an entry is embedded for semantic search (the server's vectors, routes/memory.ts): its kind, subject,
 * site, key, text, notes, entities and earlier values, in plain words.
 */
export function memoryEmbeddingText(e: Pick<MemoryEntry, "kind" | "subject" | "text" | "domain" | "key" | "notes" | "entities" | "history" | "taskTitle" | "output">): string {
  return [
    `${MEMORY_KIND_TEXT[e.kind].label}: ${e.subject}${e.domain ? ` (${e.domain})` : ""}${e.key ? ` [${e.key}]` : ""}`,
    e.taskTitle ? `Task: ${e.taskTitle}` : "",
    e.text,
    e.output ? `Output: ${e.output}` : "",
    ...(e.notes ?? []).map((n) => n.text),
    e.entities?.length ? `Involves: ${e.entities.join(", ")}` : "",
    ...(e.history ?? []).map((h) => `Before: ${h.subject}: ${h.text}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The words of an identifier or a text as keys are matched: lower case; letters and digits, with . _ - + ' @ inside
 * a word keeping it whole ("Ada.Lee@Example.com" is one word, "#48213." is "48213", "Paul  Lee" is "paul", "lee").
 */
export function keyTokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+(?:[@._+'-][\p{L}\p{N}]+)*/gu) ?? [];
}

/** A record's key as it is kept and compared: its words (keyTokens) joined by one space; "" when it has none. */
export function memoryRecordKey(raw: string): string {
  return keyTokens(raw).join(" ").slice(0, MAX_RECORD_KEY_CHARS).trim();
}

/**
 * A record within its limits, deterministically (no model): while it has more than MAX_RECORD_NOTES notes or more
 * than MAX_RECORD_CHARS characters, its oldest note is folded into the summary ("summary | 2026-09-20: note"). A
 * summary grown past MAX_MEMORY_TEXT_CHARS keeps its first RECORD_SUMMARY_HEAD_CHARS characters (what the record
 * first said) and its most recent end, with " … " between.
 */
export function condenseRecord(summary: string, notes: readonly RecordNote[]): { text: string; notes: RecordNote[] } {
  let text = summary;
  const kept = [...notes];
  while (kept.length && (kept.length > MAX_RECORD_NOTES || recordChars({ text, notes: kept }) > MAX_RECORD_CHARS)) {
    const oldest = kept.shift()!;
    text = fitSummary(`${text} | ${oldest.at.slice(0, 10)}: ${oldest.text}`);
  }
  return { text, notes: kept };
}

function fitSummary(text: string): string {
  if (text.length <= MAX_MEMORY_TEXT_CHARS) return text;
  const gap = " … ";
  const head = text.slice(0, RECORD_SUMMARY_HEAD_CHARS).trimEnd();
  let tail = text.slice(text.length - (MAX_MEMORY_TEXT_CHARS - head.length - gap.length));
  // Start the end part at a word when one starts soon.
  const space = tail.indexOf(" ");
  if (space >= 0 && space < 20) tail = tail.slice(space + 1);
  return `${head}${gap}${tail}`;
}
