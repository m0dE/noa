/**
 * list_files with a search: the user's files (the Noa folder's and the cloud's) ranked for a query, as memory is
 * (memory/search.ts): several independent ways of finding a file, each with its own bar, fused by Reciprocal Rank
 * Fusion, so a file found two ways ranks above one found one way.
 *
 * - name: the whole query in the file's name or folder ("INV-2207", "logo"): what list_files' search always did.
 * - words: Okapi BM25 over the stemmed words of fileSearchText (name, folder, note, page title, site); the name and
 *   the note count double. A file is found when it holds LEXICAL_MIN_SHARE of the weight of the query's words that
 *   any file has (a word no file has says nothing about which one fits).
 * - meaning: the account's embedding search (FileSearchResponse) at least SEMANTIC_MIN_SCORE: "a coffee cup" finds a
 *   file noted "stoneware mug". Cloud files only; absent signed out or offline.
 * - time: a time the query names (when.ts): "last week", "in March" keep the files of that period (modified or
 *   stored then); "the latest", "the first" order what was found by date.
 *
 * Recency: within a channel, files whose scores are close (WORDS_TIE, MEANING_TIE) share a rank, so they fuse to the
 * same score, and among equal scores the newer file goes first (the older when the query asks for the first). It
 * never lifts a clearly weaker match over a better one. Pure.
 */
import { fileSearchText, type NoaFile } from "@noa/shared";
import { CHANNEL_WEIGHTS, LEXICAL_MIN_SHARE, RRF_K, SEMANTIC_MIN_SCORE, termsOf } from "../memory/search.js";
import { namesTime, parseTime } from "../memory/when.js";

/** BM25 scores within this share of each other are a tie (the newer file goes first). */
export const WORDS_TIE = 0.05;
/** Cosine similarities within this of each other are a tie. */
export const MEANING_TIE = 0.01;
/** BM25's term-frequency saturation and length normalization (the usual values). */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** The name and the note count this many times: they say what the file is. */
const NAME_WEIGHT = 2;

export interface FileSearchOptions {
  now: Date;
  /** The user's time zone, minutes east of UTC (for "yesterday", "last week"). */
  offsetMinutes?: number;
  /** Cosine similarity per file (the account's search), for the meaning channel. */
  semantic?: ReadonlyMap<NoaFile, number>;
}

type Channel = "name" | "words" | "meaning" | "time";

/** A channel's files with their ranks, best first; a file whose score is close to the one ranked before it shares its rank. */
type Ranked = { f: NoaFile; rank: number }[];

function ranked(items: { f: NoaFile; s: number }[], close: (best: number, s: number) => boolean): Ranked {
  const sorted = [...items].sort((a, b) => b.s - a.s);
  const out: Ranked = [];
  let leader = Number.NaN;
  let rank = 0;
  sorted.forEach((x, i) => {
    if (i === 0 || !close(leader, x.s)) {
      leader = x.s;
      rank = i;
    }
    out.push({ f: x.f, rank });
  });
  return out;
}

/** A list in its own order, each in its own rank. */
const inOrder = (files: NoaFile[]): Ranked => files.map((f, rank) => ({ f, rank }));

export interface FileHit {
  file: NoaFile;
  score: number;
  /** The channels that found it, with its rank in each. */
  via: Partial<Record<Channel, number>>;
}

interface Doc {
  tf: Map<string, number>;
  length: number;
}

function docOf(f: NoaFile): Doc {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number) => {
    for (const t of termsOf(text)) {
      tf.set(t, (tf.get(t) ?? 0) + weight);
      length += weight;
    }
  };
  const base = f.name.split("/").pop() ?? f.name;
  add(fileSearchText({ name: base }), NAME_WEIGHT);
  add(f.meta?.about ?? "", NAME_WEIGHT);
  add(fileSearchText({ name: "", folder: f.name.includes("/") ? f.name.slice(0, f.name.lastIndexOf("/")) : "", meta: { ...f.meta, about: undefined } }), 1);
  return { tf, length };
}

/** The files that fit `query`, best first (empty when none does). */
export function searchFiles(files: readonly NoaFile[], query: string, opts: FileSearchOptions): FileHit[] {
  const time = parseTime(query, opts.now, opts.offsetMinutes ?? 0);
  const lists: Partial<Record<Channel, Ranked>> = {};

  // name: the query as written, in the file's place in the folder.
  const whole = query.trim().toLowerCase();
  if (whole.length >= 2) {
    // The shorter the name around it, the more of the name the query is.
    lists.name = ranked(
      files.filter((f) => f.name.toLowerCase().includes(whole)).map((f) => ({ f, s: -f.name.length })),
      (a, b) => a === b,
    );
  }

  // words: BM25 over each file's words.
  const terms = [...new Set(termsOf(time.rest))];
  if (terms.length) {
    const docs = files.map(docOf);
    const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length) || 1;
    const df = new Map(terms.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]));
    const idf = (t: string) => Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
    // Words no file has say nothing about which one fits.
    const known = terms.filter((t) => df.get(t)! > 0);
    const knownWeight = known.reduce((n, t) => n + idf(t), 0);
    const words = files
      .map((f, i) => {
        const d = docs[i]!;
        let score = 0;
        let held = 0;
        for (const t of known) {
          const tf = d.tf.get(t);
          if (!tf) continue;
          held += idf(t);
          score += (idf(t) * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / avg));
        }
        return { f, s: score, share: knownWeight ? held / knownWeight : 0 };
      })
      .filter((x) => x.s > 0 && x.share >= LEXICAL_MIN_SHARE);
    lists.words = ranked(words, (best, s) => s >= best * (1 - WORDS_TIE));
  }

  // meaning
  if (opts.semantic?.size) {
    lists.meaning = ranked(
      files.map((f) => ({ f, s: opts.semantic!.get(f) ?? -1 })).filter((x) => x.s >= SEMANTIC_MIN_SCORE),
      (best, s) => best - s <= MEANING_TIE,
    );
  }

  // time: a period keeps its files (of those found by what the query is about, when it says what); an order sorts.
  if (namesTime(time)) {
    const found = new Set(Object.values(lists).flatMap((l) => l.map((x) => x.f)));
    // What the other channels found; when they found nothing ("the latest file", "files from last week"), all.
    const about = found.size ? files.filter((f) => found.has(f)) : [...files];
    const inPeriod = about.filter((f) => (!time.from || f.modified >= time.from) && (!time.to || f.modified < time.to));
    lists.time = inOrder(inPeriod.sort((a, b) => (time.order === "first" ? a.modified.localeCompare(b.modified) : b.modified.localeCompare(a.modified))));
    // A named period is a filter: what lies outside it is not what was asked for.
    if (time.from || time.to) {
      const keep = new Set(inPeriod);
      for (const k of Object.keys(lists) as Channel[]) if (k !== "time") lists[k] = lists[k]!.filter((x) => keep.has(x.f));
    }
  }

  const fused = new Map<NoaFile, FileHit>();
  for (const [channel, list] of Object.entries(lists) as [Channel, Ranked][]) {
    const weight = channel === "name" ? CHANNEL_WEIGHTS.entities : CHANNEL_WEIGHTS[channel];
    list.forEach(({ f, rank }) => {
      const hit = fused.get(f) ?? { file: f, score: 0, via: {} };
      hit.score += weight / (RRF_K + rank + 1);
      hit.via[channel] = rank;
      fused.set(f, hit);
    });
  }
  // Equal scores: the newer file first, or the older when the query asks for the first.
  const older = time.order === "first" ? -1 : 1;
  return [...fused.values()].sort((a, b) => b.score - a.score || older * b.file.modified.localeCompare(a.file.modified));
}
