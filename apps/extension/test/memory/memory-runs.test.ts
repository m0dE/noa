import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@noa/shared";
import { earlierRunsText, SIMILAR_OUTPUT_THRESHOLD, similarAnswer, similarRuns, textSimilarity } from "../../src/memory/runs.js";

let n = 0;
const run = (output: string | undefined, extra: Partial<MemoryEntry> = {}): MemoryEntry => {
  n++;
  return {
    id: `r${n}`,
    kind: "task",
    subject: "Run note",
    text: `Posted run ${n}`,
    scope: "task",
    taskKey: "sA",
    source: { kind: "task" },
    learnedAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
    ...(output ? { output } : {}),
    ...extra,
  };
};

const POST = "Three ways to keep your to-do list short: batch small tasks, drop what nobody asked for, and schedule the rest for tomorrow morning.";
/** Reworded copies of POST: what must be caught. */
const NEAR = [
  "Three ways to keep your to-do list short: batch the small tasks, drop what nobody asked for, and schedule everything else for tomorrow.",
  "3 ways to keep a to-do list short: batch small tasks, drop things nobody asked for, schedule the rest for tomorrow morning!",
  "Keep your to-do list short with three ways: drop what nobody asked for, batch small tasks, and schedule the rest for tomorrow morning.",
];
/** Other posts on the same theme: what must pass. */
const OTHER = [
  "Your calendar is a to-do list with deadlines. Block two hours on Friday afternoon for deep work and protect it like a meeting.",
  "We shipped recurring tasks today: set a task to repeat every weekday and Noa runs it in your own browser.",
  "Stop re-reading your inbox. Archive anything older than a week that needs no reply; search finds it if you ever need it.",
  "Short lists get done. Long lists get rewritten. Pick the one task that would make today a good day and start there.",
];

describe("textSimilarity", () => {
  it("scores reworded copies at the limit or above, and other texts on the same theme well below it", () => {
    const near = NEAR.map((t) => textSimilarity(POST, t));
    const other = OTHER.map((t) => textSimilarity(POST, t));
    // The measured scores (the limit's margin on both sides).
    expect(near.map((s) => s.toFixed(2))).toEqual(["0.76", "0.88", "0.79"]);
    expect(other.map((s) => s.toFixed(2))).toEqual(["0.05", "0.02", "0.00", "0.06"]);
    for (const s of near) expect(s).toBeGreaterThanOrEqual(SIMILAR_OUTPUT_THRESHOLD);
    for (const s of other) expect(s).toBeLessThan(SIMILAR_OUTPUT_THRESHOLD / 2);
  });

  it("is 1 for the same text (spacing, case and punctuation aside) and 0 with nothing in common", () => {
    expect(textSimilarity(POST, POST.toUpperCase().replace(/ /g, "  "))).toBe(1);
    expect(textSimilarity("ship the release", "banana bread recipe")).toBe(0);
    expect(textSimilarity("", POST)).toBe(0);
  });
});

describe("similarRuns / similarAnswer", () => {
  it("flags a near-duplicate draft and lists the closest earlier outputs with dates and scores", () => {
    const runs = [run(POST), run(OTHER[0]), run(OTHER[1]), run(undefined, { text: "Posted about inbox zero" })];
    const answer = similarAnswer(NEAR[0]!, runs, { taskKey: "sA" });
    expect(answer).toMatch(/^Compared with 4 earlier outputs \(4 of this task\)\.\nTOO SIMILAR: 0\.76 to the output of 2026-09-\d\d/);
    expect(answer).toContain(`words 0.76 · "${POST}"`);
    expect(answer).toContain('note: "Posted about inbox zero"');
  });

  it("passes a new draft, and names other tasks' outputs and the account's meaning scores", () => {
    const mine = run(POST);
    const theirs = run("Friday deep work: block two hours and protect them", { taskKey: "sB", taskTitle: "Post a productivity tip" });
    const answer = similarAnswer(OTHER[2]!, [mine, theirs], { taskKey: "sA", semantic: new Map([[theirs.id, 0.61]]) });
    expect(answer).toMatch(/Compared with 2 earlier outputs \(1 of this task, 1 of the user's other repeating tasks\)\./);
    expect(answer).toMatch(/Not too similar by words: the closest scores 0\.0\d/);
    expect(answer).toMatch(/meaning 0\.61 · another task \("Post a productivity tip"\)/);
  });

  it("lists the closest by words, then by meaning, the newer first on ties", () => {
    const runs = Array.from({ length: 8 }, (_, i) => run(`keep a list of garden post ${i}`));
    const paraphrase = run("Totally different words entirely", {});
    const hits = similarRuns("keep a short list", runs.concat(paraphrase), new Map([[paraphrase.id, 0.93]]));
    expect(hits).toHaveLength(6);
    expect(hits.at(-1)).toMatchObject({ entry: paraphrase, meaning: 0.93 });
  });
});

describe("earlierRunsText", () => {
  it("counts runs and the words most of them used, keeps its own text when rewritten, and stays within the limit", () => {
    const first = earlierRunsText(null, [run("pricing pricing roadmap"), run("roadmap launch")]);
    expect(first).toMatch(/^2 earlier runs, (2026-09-\d\d) to (2026-09-\d\d)\. Frequent words \(runs\): roadmap \(2\), launch \(1\), price \(1\)$/);
    const next = earlierRunsText(first, [run("launch day")]);
    expect(next).toMatch(/^3 earlier runs, .* Frequent words \(runs\): launch \(2\), roadmap \(2\), dai \(1\), price \(1\)$/);
    expect(earlierRunsText("The user's own summary", [run("launch")])).toMatch(/^The user's own summary 1 earlier run, /);
    const long = earlierRunsText(null, Array.from({ length: 50 }, (_, i) => run(`word${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"xyz"[i % 3]}lengthy others ${i}`)));
    expect(long.length).toBeLessThanOrEqual(400);
  });
});
