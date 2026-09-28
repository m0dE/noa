/**
 * Hybrid search over memory: several independent ways of finding an entry, each with its own bar for "this is
 * relevant", fused by Reciprocal Rank Fusion (Cormack, Clarke and Buettcher, SIGIR 2009: score = sum over the
 * channels that found it of weight / (RRF_K + rank)), ties going to the newer entry.
 *
 * - words: Okapi BM25 over stemmed words (stem.ts), the subject, site, key and entities counting double. Words
 *   weigh by how rare they are (idf; a word memory has never seen weighs the most). A query whose weight is mostly
 *   in words memory has never seen (LEXICAL_MAX_UNKNOWN_SHARE) is about something memory does not hold, so
 *   "How do I post on Instagram?" finds nothing although many entries say "post". Otherwise an entry is found when
 *   it holds LEXICAL_MIN_SHARE of the weight of the query's known words: one of the facts a request combines ("email
 *   my accountant from my work email") is enough. Whatever else a query says, it finds an entry whose whole subject
 *   it names ("Work email" in a long request that also names people memory does not know). A site's entry (a playbook) is found only by its name or site:
 *   x.com's playbook is not for "post a tip on LinkedIn" because its text says "Post".
 * - entities: identifiers and names the query writes (emails, @handles, sites, IDs and codes, capitalized
 *   names, quoted titles) found whole in an entry.
 * - meaning: cosine similarity of embeddings (the account's semantic search, MemorySearchResponse) at least
 *   SEMANTIC_MIN_SCORE. Absent signed out or offline: the other channels carry on.
 * - time: when the query names a time (when.ts), the dated entries (episodes, run notes, records) in it that are
 *   about the query's subject, in date order when it asks for the first or the latest; "before / after <event>"
 *   finds the event among dated entries first. Asked what something was before, the facts with earlier values.
 * - recency: asked for the value now ("now", "currently"), newer entries first.
 *
 * Nothing passes any bar: nothing is found (the turn gets no memory, recall says so). Pure; each entry's words
 * are computed once (entries are immutable: a change is a new object).
 */
import { isMemoryRecord, keyTokens, memoryDate, onDomain, type MemoryEntry } from "@noa/shared";
import { stem } from "./stem.js";
import { namesTime, parseTime, type TimeQuery } from "./when.js";

/** RRF's rank constant (the paper's 60): a lower rank still counts, a top rank does not swamp the rest. */
export const RRF_K = 60;
/** Past this share of its word weight in words memory has never seen, a query finds nothing by words. */
export const LEXICAL_MAX_UNKNOWN_SHARE = 0.5;
/** Share of the weight of the query's known words an entry must hold to be found by words. */
export const LEXICAL_MIN_SHARE = 1 / 3;
/** Least cosine similarity for the meaning channel (bge-m3 CLS vectors: unrelated text scores about 0.3-0.45). */
export const SEMANTIC_MIN_SCORE = 0.5;
/** A dated entry is about the query's subject when it holds at least this share of the best one's word weight. */
export const TOPICAL_MIN_SHARE = 0.5;
/** An event named by "before / after <event>" is the dated entry holding at least this share of its words. */
export const ANCHOR_MIN_COVERAGE = 0.5;
/** Channel weights: a named time is the query's precise intent, so it counts double. */
export const CHANNEL_WEIGHTS = { words: 1, entities: 1, meaning: 1, time: 2, recency: 1 } as const;
export type Channel = keyof typeof CHANNEL_WEIGHTS;
/** BM25's term-frequency saturation and length normalization (the usual values). */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** How many times a word of an entry's subject, site, key or entities counts (they say what the entry is about). */
const NAME_WEIGHT = 2;

/** Words too common to tell entries apart, and question words. */
const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing done down during each else ever few for from further get gets got had has have having he her here hers him his how however i if in into is it its itself just let lets me might mine more most must my myself no nor not now of off on once only or other ought our ours ourselves out over own please same shall she should so some such than thanks that the their theirs them themselves then there these they this those through to too under until up upon us very via was we were what whats when where which while who whom whose why will with would yes yet you your yours yourself remind tell know need want thing things something anything ever way happen happened happens run runs ran time`.split(
    /\s+/,
  ),
);

/** Lower case, and compatibility-normalized (NFKC) when it is not plain ASCII (normalizing costs; most text is ASCII). */
const folded = (text: string): string => (/[^\x00-\x7f]/.test(text) ? text.normalize("NFKC") : text).toLowerCase();

/** The words of a text as they are matched: lower case, stemmed; identifiers whole and by their parts. */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of folded(text).match(/@?[\p{L}\p{N}]+(?:[@._+'’-][\p{L}\p{N}]+)*/gu) ?? []) {
    const quoted = raw.includes("'") || raw.includes("’");
    const word = quoted ? raw.replace(/['’]s$/, "") : raw;
    if (/[@._+-]/.test(word)) {
      out.push(word);
      for (const part of word.split(/[@._+'’-]+/)) if (part && !STOPWORDS.has(part)) out.push(stem(part));
    } else if (!STOPWORDS.has(word)) out.push(stem(quoted ? word.replace(/['’]/g, "") : word));
  }
  return out;
}

interface Doc {
  /** Term -> weighted count. */
  tf: Map<string, number>;
  length: number;
  /** The terms of its subject, site, key and entities (what it is about by name). */
  named: Set<string>;
  /** The terms of its subject alone. */
  subject: Set<string>;
}

const docs = new WeakMap<MemoryEntry, Doc>();

/** Terms of task titles (the same title heads every entry of a task: its thousand records read it once). */
const titleTerms = new Map<string, string[]>();
/** Titles remembered (past it the memo starts over). */
const MAX_TITLES = 500;

function termsOfTitle(title: string): string[] {
  let t = titleTerms.get(title);
  if (!t) {
    if (titleTerms.size >= MAX_TITLES) titleTerms.clear();
    titleTerms.set(title, (t = termsOf(title)));
  }
  return t;
}

function docOf(e: MemoryEntry): Doc {
  let d = docs.get(e);
  if (d) return d;
  const subject = termsOf(e.subject);
  const place = [e.domain ?? "", e.key ?? "", ...(e.entities ?? [])].join(" ");
  const named = [...subject, ...termsOf(place)];
  const body = [e.text, ...(e.notes ?? []).map((n) => n.text), ...(e.history ?? []).map((h) => `${h.subject} ${h.text}`)].join(" ");
  const tf = new Map<string, number>();
  let length = 0;
  const count = (terms: readonly string[], weight: number) => {
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + weight);
    length += terms.length * weight;
  };
  count(named, NAME_WEIGHT);
  count(e.taskTitle ? termsOfTitle(e.taskTitle) : [], 1);
  count(termsOf(body), 1);
  d = { tf, length, named: new Set(named), subject: new Set(subject) };
  docs.set(e, d);
  return d;
}

/**
 * The query names the entry: every word of its subject is in the query ("Work email" in "email John Smith from my
 * work email"), however many other words the query has (a long request is mostly about other things).
 */
function namedIn(e: MemoryEntry, asked: ReadonlySet<string>): boolean {
  const subject = docOf(e).subject;
  if (!subject.size) return false;
  for (const t of subject) if (!asked.has(t)) return false;
  return true;
}

const hays = new WeakMap<MemoryEntry, string>();

/** Lower-case text of everything the entry says (records too: cheap, no words), for whole-word entity matching. */
function hayOf(e: MemoryEntry): string {
  let hay = hays.get(e);
  if (hay === undefined) {
    const parts = [e.subject, e.domain, e.key, ...(e.entities ?? []), e.taskTitle, e.text, ...(e.notes ?? []).map((n) => n.text), ...(e.history ?? []).map((h) => `${h.subject} ${h.text}`)];
    hay = ` ${folded(parts.filter(Boolean).join(" ")).replace(/\s+/g, " ")} `;
    hays.set(e, hay);
  }
  return hay;
}

/** Word statistics of the entries searched. */
class Corpus {
  /** Entries holding each word asked about (counted when first asked: a search asks about a few words). */
  private readonly counted = new Map<string, number>();
  readonly avgLength: number;
  constructor(readonly entries: readonly MemoryEntry[]) {
    let total = 0;
    for (const e of entries) total += docOf(e).length;
    this.avgLength = entries.length ? total / entries.length : 1;
  }
  /** How many entries hold `t`. */
  private df(t: string): number {
    let n = this.counted.get(t);
    if (n === undefined) {
      n = 0;
      for (const e of this.entries) if (docOf(e).tf.has(t)) n++;
      this.counted.set(t, n);
    }
    return n;
  }
  /** Some entry holds `t`. */
  has(t: string): boolean {
    return this.df(t) > 0;
  }
  /** BM25's idf; a word no entry has weighs as much as one only one entry has (rare, not rarer). */
  idf(t: string): number {
    const n = this.entries.length;
    const df = Math.max(1, this.df(t));
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }
  /** The share of the query's word weight in words no entry has. */
  unknownShare(terms: readonly string[]): number {
    let unknown = 0;
    let total = 0;
    for (const t of terms) {
      total += this.idf(t);
      if (!this.has(t)) unknown += this.idf(t);
    }
    return total ? unknown / total : 1;
  }
  /** BM25 score, the share of the query's word weight the entry holds, and the share of its known words' weight. */
  match(e: MemoryEntry, terms: readonly string[]): { score: number; coverage: number; knownShare: number } {
    const d = docOf(e);
    let score = 0;
    let held = 0;
    let total = 0;
    let known = 0;
    for (const t of terms) {
      const idf = this.idf(t);
      total += idf;
      if (this.has(t)) known += idf;
      const f = d.tf.get(t);
      if (!f) continue;
      held += idf;
      score += (idf * f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / this.avgLength));
    }
    return { score, coverage: total ? held / total : 0, knownShare: known ? held / known : 0 };
  }
}

// ---------------------------------------------------------------- entities

const MONTH_OR_DAY = /^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
const YEAR = /^(19|20)\d{2}$/;

/** Identifiers and names `text` writes, lower case: emails, @handles, sites, IDs and codes, capitalized names, quoted titles. */
export function entitiesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(["'‘“])([^"'’”]{3,80})["'’”]/g)) out.add(m[2]!.trim().toLowerCase());
  for (const w of text.normalize("NFKC").match(/@?[\p{L}\p{N}]+(?:[@._+-][\p{L}\p{N}]+)*/gu) ?? []) {
    if (/[@.]/.test(w) && /\p{L}/u.test(w)) out.add(w.toLowerCase().replace(/^www\./, ""));
    else if (/\d/.test(w) && w.length >= 4 && !YEAR.test(w)) out.add(w.toLowerCase());
  }
  // Capitalized words other than a sentence's first: names ("Paul Lee", "Channex", "Aeron").
  for (const sentence of text.split(/[.!?\n]+/)) {
    const words = sentence.trim().match(/[\p{L}][\p{L}\p{N}'’-]*/gu) ?? [];
    words.forEach((w, i) => {
      if (i === 0 || !/^\p{Lu}/u.test(w) || MONTH_OR_DAY.test(w)) return;
      const lower = w.toLowerCase().replace(/['’]s$/, "");
      if (lower.length >= 2 && !STOPWORDS.has(lower)) out.add(lower);
    });
  }
  return [...out];
}

/** The entry writes `entity` whole (not inside a longer word or identifier). */
function holds(e: MemoryEntry, entity: string): boolean {
  if (e.domain && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entity) && (onDomain(e.domain, entity) || onDomain(entity, e.domain))) return true;
  const hay = hayOf(e);
  let at = hay.indexOf(entity);
  while (at >= 0) {
    const before = hay[at - 1] ?? " ";
    const after = hay[at + entity.length] ?? " ";
    if (!/[\p{L}\p{N}@]/u.test(before) && !/[\p{L}\p{N}]/u.test(after) && !/[@.][\p{L}\p{N}]/u.test(hay.slice(at + entity.length, at + entity.length + 2))) return true;
    at = hay.indexOf(entity, at + 1);
  }
  return false;
}

// ---------------------------------------------------------------- the search

export interface SearchOptions {
  /** Now, for time words ("last spring"). */
  now: Date;
  /** The user's time zone, minutes east of UTC (calendar days of "yesterday"). */
  offsetMinutes?: number;
  /** The turn's repeating task: its entries count as about the query in a time search. */
  taskKey?: string | null;
  /** Entry id -> cosine similarity to the query (the account's semantic search); absent: no meaning channel. */
  semantic?: ReadonlyMap<string, number>;
  /**
   * Records are searched by their words too (recall: asked for, once). Absent (the start of every turn): records are
   * found by their key, entities and meaning only, since indexing a space's thousand records' words would cost a
   * turn more than they add.
   */
  recordWords?: boolean;
}

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
  /** The channels that found it, with its rank (0-based) in each. */
  via: Partial<Record<Channel, number>>;
}

export interface SearchResult {
  hits: SearchHit[];
  /** The time the query names (when.ts). */
  time: TimeQuery;
}

/** The dated entries a time search looks at: episodes, run notes and records (any of their notes). */
const isDated = (e: MemoryEntry) => e.kind === "episode" || e.kind === "task";
/** The instants an entry's content is dated by. */
const datesOf = (e: MemoryEntry): string[] => [memoryDate(e), ...(e.notes ?? []).map((n) => n.at)];

/** The entries that match `query`, best first (see the file's comment). */
export function searchMemory(entries: readonly MemoryEntry[], query: string, opts: SearchOptions): SearchResult {
  const time = parseTime(query, opts.now, opts.offsetMinutes);
  const worded = opts.recordWords ? entries : entries.filter((e) => !isMemoryRecord(e));
  const corpus = new Corpus(worded);
  const lists: Partial<Record<Channel, MemoryEntry[]>> = {};

  // words
  const terms = [...new Set(termsOf(time.rest))];
  const asked = new Set(terms);
  const aboutKnown = corpus.unknownShare(terms) <= LEXICAL_MAX_UNKNOWN_SHARE;
  lists.words = worded
    .map((e) => ({ e, ...corpus.match(e, terms) }))
    .filter((x) => x.score > 0 && (namedIn(x.e, asked) || (aboutKnown && x.knownShare >= LEXICAL_MIN_SHARE && (x.e.scope !== "domain" || terms.some((t) => docOf(x.e).named.has(t))))))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);

  // entities
  const wanted = entitiesOf(query).filter((x) => !/^(19|20)\d{2}$/.test(x));
  if (wanted.length) {
    const found = entries.map((e) => ({ e, of: wanted.filter((w) => holds(e, w)) })).filter((x) => x.of.length);
    const df = new Map(wanted.map((w) => [w, found.filter((x) => x.of.includes(w)).length]));
    const weight = (w: string) => Math.log(1 + entries.length / (1 + df.get(w)!));
    lists.entities = found.map((x) => ({ e: x.e, s: x.of.reduce((n, w) => n + weight(w), 0) })).sort((a, b) => b.s - a.s).map((x) => x.e);
  }

  // meaning
  if (opts.semantic?.size) {
    lists.meaning = entries
      .map((e) => ({ e, s: opts.semantic!.get(e.id) ?? -1 }))
      .filter((x) => x.s >= SEMANTIC_MIN_SCORE)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e);
  }

  // time
  if (namesTime(time) || time.past) lists.time = timeList(entries, corpus, time, terms, opts, new Set([...(lists.entities ?? []), ...(lists.meaning ?? [])]));

  // recency: asked for the value now, the newer of what the other channels found first.
  const found = new Set(Object.values(lists).flat());
  if (time.current && found.size) lists.recency = [...found].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const fused = new Map<MemoryEntry, SearchHit>();
  for (const [channel, list] of Object.entries(lists) as [Channel, MemoryEntry[]][]) {
    list.forEach((e, rank) => {
      const hit = fused.get(e) ?? { entry: e, score: 0, via: {} };
      hit.score += CHANNEL_WEIGHTS[channel] / (RRF_K + rank + 1);
      hit.via[channel] = rank;
      fused.set(e, hit);
    });
  }
  const newer = (a: MemoryEntry, b: MemoryEntry) => memoryDate(b).localeCompare(memoryDate(a));
  const hits = [...fused.values()].sort((a, b) => b.score - a.score || (time.past ? -newer(a.entry, b.entry) : newer(a.entry, b.entry)));
  const ranked = time.past ? hits : supersededLast(hits);
  return { hits: namesTime(time) ? ranked : fewRunsPerTask(ranked), time };
}

/** Dated entries (episodes, run notes) of one repeating task kept when the query names no time. */
export const MAX_RUNS_PER_TASK = 3;

/**
 * A repeating task's runs read much alike: without a time to tell them apart, its best MAX_RUNS_PER_TASK stand for
 * the rest, so they do not crowd out everything else (a playbook, a person) the query is about.
 */
function fewRunsPerTask(hits: SearchHit[]): SearchHit[] {
  const seen = new Map<string, number>();
  return hits.filter((h) => {
    const task = isDated(h.entry) && !isMemoryRecord(h.entry) ? h.entry.taskKey : undefined;
    if (!task) return true;
    const n = (seen.get(task) ?? 0) + 1;
    seen.set(task, n);
    return n <= MAX_RUNS_PER_TASK;
  });
}

/** Facts: the kinds a later fact of another subject can replace (remember's `replaces`). */
const FACT_KINDS: ReadonlySet<MemoryEntry["kind"]> = new Set(["preference", "account", "person", "playbook"]);
/** Hits looked at for replacements not recorded as such (the top of the list is what is given). */
const SUPERSEDE_WINDOW = 30;

/**
 * A replacement the writer did not record (no `replaces`): a newer fact of the same kind that names an older one's
 * subject ("Hannah Brooks is my accountant since Paul Lee retired") most likely replaced it, so the older one
 * goes right after it. Both stay in the list (the agent sees both, and which is newer).
 */
function supersededLast(hits: SearchHit[]): SearchHit[] {
  const top = hits.slice(0, SUPERSEDE_WINDOW);
  const out = [...hits];
  for (const old of top) {
    if (!FACT_KINDS.has(old.entry.kind)) continue;
    const subject = old.entry.subject.trim().toLowerCase();
    const by = top.find((h) => h !== old && h.entry.kind === old.entry.kind && h.entry.learnedAt > old.entry.learnedAt && holds(h.entry, subject));
    if (!by) continue;
    const from = out.indexOf(old);
    const to = out.indexOf(by);
    if (from > to) continue;
    out.splice(from, 1);
    out.splice(out.indexOf(by) + 1, 0, old);
  }
  return out;
}

/**
 * The time channel: the event a "before / after" names first, then the entries of the period that are about the
 * query's subject (in date order when the query asks for the first or the latest, else by how well they match);
 * asked what something was before, the facts with earlier values that match.
 */
function timeList(entries: readonly MemoryEntry[], corpus: Corpus, time: TimeQuery, terms: readonly string[], opts: SearchOptions, alsoAbout: ReadonlySet<MemoryEntry>): MemoryEntry[] {
  let from = time.from ?? "";
  let to = time.to ?? "￿";
  const out: MemoryEntry[] = [];
  let anchor: MemoryEntry | undefined;
  if (time.anchor) {
    const words = [...new Set(termsOf(time.anchor.words))];
    anchor = entries
      .filter((e) => !isMemoryRecord(e))
      .map((e) => ({ e, ...corpus.match(e, words) }))
      .filter((x) => x.coverage >= ANCHOR_MIN_COVERAGE)
      .sort((a, b) => Number(isDated(b.e)) - Number(isDated(a.e)) || b.score - a.score)[0]?.e;
    if (anchor) {
      out.push(anchor);
      const at = anchorDate(anchor);
      if (time.anchor.side === "before") to = at;
      else from = at;
    }
  }
  const bounded = time.from !== undefined || time.to !== undefined || !!anchor;
  const scored = entries
    .filter((e) => e !== anchor)
    .map((e) => ({ e, ...(isMemoryRecord(e) && !opts.recordWords ? NO_MATCH : corpus.match(e, terms)), sem: opts.semantic?.get(e.id) ?? 0 }))
    .map((x) => ({ ...x, about: x.coverage + (alsoAbout.has(x.e) ? 1 : 0) + (opts.taskKey && x.e.taskKey === opts.taskKey ? 1 : 0) + Math.max(0, x.sem - SEMANTIC_MIN_SCORE) }));
  const inPeriod = (e: MemoryEntry) => {
    if (isDated(e)) return datesOf(e).some((d) => d >= from && d < to);
    // A fact: learned in the period (for "before / after <event>"), or one with earlier values when asked what it was.
    if (time.past && e.history?.length) return true;
    return !!anchor && e.learnedAt >= from && e.learnedAt < to;
  };
  // A period: what is in it. Only an order ("the first run"): every dated entry. Neither ("what was it before"): facts with earlier values.
  const inScope = (e: MemoryEntry) => (bounded ? inPeriod(e) : time.order ? isDated(e) : time.past && !!e.history?.length);
  const candidates = scored.filter((x) => x.about > 0 && inScope(x.e));
  const best = Math.max(0, ...candidates.map((x) => x.about));
  const about = candidates.filter((x) => x.about >= best * TOPICAL_MIN_SHARE);
  const byDate = (a: { e: MemoryEntry }, b: { e: MemoryEntry }) => memoryDate(a.e).localeCompare(memoryDate(b.e));
  if (time.order === "first") about.sort(byDate);
  else if (time.order === "last") about.sort((a, b) => -byDate(a, b));
  else about.sort((a, b) => b.about - a.about || b.score - a.score);
  out.push(...about.map((x) => x.e));
  return out;
}

/** A record whose words are not searched (SearchOptions.recordWords): it is about the query by entities or meaning only. */
const NO_MATCH = { score: 0, coverage: 0, knownShare: 0 } as const;

/** When an event happened: an episode's date; a changed fact's last change; else when it was learned. */
function anchorDate(e: MemoryEntry): string {
  if (isDated(e)) return memoryDate(e);
  return e.history?.[0]?.until ?? e.learnedAt;
}

/** Whether a record's key is `query` itself (recall by an identifier). */
export const isKeyQuery = (e: MemoryEntry, query: string): boolean => isMemoryRecord(e) && keyTokens(query).join(" ") === e.key;
