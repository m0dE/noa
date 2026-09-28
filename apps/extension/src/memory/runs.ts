/**
 * A repeating task's runs in memory (each run's note and output: TASK_RUN_SUBJECT entries), pure and deterministic:
 *
 * - earlierRunsText(): past MAX_TASK_RUNS the oldest runs are folded into one summary (EARLIER_RUNS_SUBJECT): how
 *   many, from when to when, and the words most of them used, so a later run still knows what was covered;
 * - textSimilarity() / similarAnswer(): check_similar, a draft against what earlier runs put out. Words are compared as
 *   memory search matches them (termsOf: lower case, stemmed, common words dropped), one by one and in pairs, so a
 *   reworded copy scores high while another text on the same theme scores low.
 */
import { clipLine, memoryDate, MAX_MEMORY_TEXT_CHARS, type MemoryEntry } from "@noa/shared";
import { termsOf } from "./search.js";

/**
 * A draft scoring this or more against an earlier output is too similar (check_similar). Measured in
 * memory-runs.test.ts: reworded copies score 0.76-0.88, other posts on the same theme 0.00-0.06.
 */
export const SIMILAR_OUTPUT_THRESHOLD = 0.4;
/** Earlier outputs check_similar lists: the closest by words, then the closest by meaning not already listed. */
export const SIMILAR_SHOWN_BY_WORDS = 5;
export const SIMILAR_SHOWN_BY_MEANING = 2;
/** How much of each listed output check_similar shows. */
export const SIMILAR_SHOWN_CHARS = 200;

// ---------------------------------------------------------------- similarity

/** Word pairs of a text's terms, in order ("keep lists" "lists short"). */
function pairsOf(terms: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < terms.length; i++) out.add(`${terms[i - 1]} ${terms[i]}`);
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/**
 * How alike two texts are, 0..1: the mean of the overlap (Jaccard) of their terms and of their word pairs. The same
 * text is 1, a copy with a few words changed about 0.5-0.9, a different text on the same theme under 0.2.
 */
export function textSimilarity(a: string, b: string): number {
  const ta = termsOf(a);
  const tb = termsOf(b);
  if (!ta.length || !tb.length) return 0;
  const words = jaccard(new Set(ta), new Set(tb));
  // A text of one term has no pairs: its words decide alone.
  if (ta.length < 2 || tb.length < 2) return words;
  return (words + jaccard(pairsOf(ta), pairsOf(tb))) / 2;
}

/** An earlier run compared with a draft. */
export interface SimilarRun {
  entry: MemoryEntry;
  /** textSimilarity of the draft and the run's output (its note when it kept none). */
  words: number;
  /** The account's semantic similarity (cosine) of the draft and the run, when memory syncs. */
  meaning?: number;
}

/** What check_similar compares a draft with in a run: its output, else its note. */
export const comparedText = (e: MemoryEntry): string => e.output ?? e.text;

/**
 * The runs most like `draft`: the closest by words (SIMILAR_SHOWN_BY_WORDS), then the closest by meaning not already
 * listed (SIMILAR_SHOWN_BY_MEANING). Ties go to the newer run.
 */
export function similarRuns(draft: string, runs: readonly MemoryEntry[], semantic?: ReadonlyMap<string, number>): SimilarRun[] {
  const scored = runs.map((entry): SimilarRun => {
    const meaning = semantic?.get(entry.id);
    return { entry, words: round(textSimilarity(draft, comparedText(entry))), ...(meaning === undefined ? {} : { meaning: round(meaning) }) };
  });
  const newer = (a: SimilarRun, b: SimilarRun) => memoryDate(b.entry).localeCompare(memoryDate(a.entry));
  const byWords = [...scored].sort((a, b) => b.words - a.words || newer(a, b)).slice(0, SIMILAR_SHOWN_BY_WORDS);
  const shown = new Set(byWords);
  const byMeaning = scored
    .filter((s) => s.meaning !== undefined && !shown.has(s))
    .sort((a, b) => b.meaning! - a.meaning! || newer(a, b))
    .slice(0, SIMILAR_SHOWN_BY_MEANING);
  return [...byWords, ...byMeaning];
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * check_similar's answer: whether the draft is too similar (a run at SIMILAR_OUTPUT_THRESHOLD or more by words), and
 * the closest earlier outputs with their dates and scores. `taskKey`: the run's own task (other tasks' outputs are
 * named as such).
 */
export function similarAnswer(draft: string, runs: readonly MemoryEntry[], opts: { taskKey?: string | null; semantic?: ReadonlyMap<string, number> } = {}): string {
  const closest = similarRuns(draft, runs, opts.semantic);
  const own = runs.filter((e) => e.taskKey === opts.taskKey).length;
  const compared = `Compared with ${runs.length} earlier output${runs.length === 1 ? "" : "s"} (${own} of this task${runs.length > own ? `, ${runs.length - own} of the user's other repeating tasks` : ""}).`;
  const top = closest[0];
  const verdict =
    top && top.words >= SIMILAR_OUTPUT_THRESHOLD
      ? `TOO SIMILAR: ${top.words.toFixed(2)} to the output of ${memoryDate(top.entry).slice(0, 10)} (the limit is ${SIMILAR_OUTPUT_THRESHOLD}). Do not publish it: write a different draft (another topic, angle and wording) and check again.`
      : `Not too similar by words: the closest scores ${(top?.words ?? 0).toFixed(2)} (the limit is ${SIMILAR_OUTPUT_THRESHOLD}). If one below says the same thing in other words, write a different draft; else go ahead.`;
  const lines = closest.map(({ entry, words, meaning }) => {
    const whose = entry.taskKey === opts.taskKey ? "" : ` · another task${entry.taskTitle ? ` ("${clipLine(entry.taskTitle, 40)}")` : ""}`;
    const what = entry.output ? "" : "note: ";
    const score = `words ${words.toFixed(2)}${meaning === undefined ? "" : ` · meaning ${meaning.toFixed(2)}`}`;
    return `- ${memoryDate(entry).slice(0, 10)} · ${score}${whose} · ${what}"${clipLine(comparedText(entry), SIMILAR_SHOWN_CHARS)}"`;
  });
  return [compared, verdict, "Closest earlier outputs:", ...lines].join("\n");
}

// ---------------------------------------------------------------- the summary of earlier runs

/** What an earlier-runs summary says: how many runs, their first and last day, and in how many of them each word came. */
interface EarlierRuns {
  count: number;
  from: string;
  to: string;
  words: Map<string, number>;
}

const SUMMARY_RE = /(\d+) earlier runs?, (\d{4}-\d\d-\d\d) to (\d{4}-\d\d-\d\d)\./;
const WORDS_LABEL = " Frequent words (runs):";
const WORD_RE = /([^\s,:()]+) \((\d+)\)/g;

/**
 * A summary's text read back: what it counted, and any text before that (the user's words, kept). Not a summary
 * (e.g. the user rewrote it): all of it is `before`.
 */
function readEarlierRuns(text: string): { before: string; runs: EarlierRuns | null } {
  const m = SUMMARY_RE.exec(text);
  if (!m) return { before: text, runs: null };
  const words = new Map<string, number>();
  const at = text.indexOf(WORDS_LABEL, m.index);
  if (at >= 0) for (const w of text.slice(at + WORDS_LABEL.length).matchAll(WORD_RE)) words.set(w[1]!, Number(w[2]));
  return { before: text.slice(0, m.index), runs: { count: Number(m[1]), from: m[2]!, to: m[3]!, words } };
}

/**
 * The summary after folding `runs` into it (`summary`: its text so far, null: none yet), deterministically: "57 earlier
 * runs, 2026-06-01 to 2026-07-20. Frequent words (runs): pricing (12), token (9), …", at most MAX_MEMORY_TEXT_CHARS.
 * A word counts once per run (its stem, as check_similar compares). Text before the counts (a summary the user
 * rewrote) is kept in front, cut.
 */
export function earlierRunsText(summary: string | null, runs: readonly MemoryEntry[]): string {
  const read = summary === null ? null : readEarlierRuns(summary);
  const was = read?.runs ?? null;
  const days = runs.map((e) => memoryDate(e).slice(0, 10)).sort();
  const words = new Map(was?.words ?? []);
  for (const e of runs) for (const w of new Set(termsOf(comparedText(e)))) if (/^\p{L}{3,}$/u.test(w)) words.set(w, (words.get(w) ?? 0) + 1);
  const count = (was?.count ?? 0) + runs.length;
  const from = [was?.from, days[0]].filter((d): d is string => !!d).sort()[0] ?? "";
  const to = [was?.to, days.at(-1)].filter((d): d is string => !!d).sort().at(-1) ?? "";
  const before = read?.before.trim() ?? "";
  const kept = before ? `${clipLine(before, 120)} ` : "";
  let text = `${kept}${count} earlier run${count === 1 ? "" : "s"}, ${from} to ${to}.`;
  const ranked = [...words].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length) {
    let list = WORDS_LABEL;
    for (const [w, n] of ranked) {
      const next = `${list}${list.endsWith(":") ? "" : ","} ${w} (${n})`;
      if (text.length + next.length > MAX_MEMORY_TEXT_CHARS) break;
      list = next;
    }
    if (!list.endsWith(":")) text += list;
  }
  return text;
}
