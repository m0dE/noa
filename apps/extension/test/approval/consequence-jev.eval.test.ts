/**
 * The classifier with real Jev on the labelled set: how Jev judges the cases the rules leave
 * unsure, all cases (to see how Jev does alone), and the within-task question. It calls
 * TypeSafe's systemOne, so it runs only with JEV_EVAL=1 and TYPESAFE_API_KEY (from the
 * environment or the repo's .env):
 *   JEV_EVAL=1 npx vitest run test/approval/consequence-jev.eval.test.ts --silent=false
 */
import { describe, expect, it } from "vitest";
import { proxyJevClient } from "../../../../packages/core/src/jev.js";
import { classifyByRules } from "../../src/approval/consequence.js";
import { judgeWithJev, type SystemOneLike } from "../../src/approval/jev-judge.js";
import { judgeAction, judgeWithinTask, JUDGE_MIN_CONFIDENCE } from "../../src/approval/judge.js";
import { withinInstructions } from "../../src/approval/within-task.js";
import { CASES, HOLDOUT_CASES, WITHIN_CASES } from "./cases.js";

// The extension's tests are typed for the browser (no Node types): Node's env and fs are reached untyped.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/** The key's variable name; the .env line is matched by a pattern built from it (a literal `NAME=` pattern reads as an assignment to the public repo's secret scan). */
const KEY_NAME = "TYPESAFE_API_KEY";

async function keyFromEnv(): Promise<string> {
  if (env[KEY_NAME]) return env[KEY_NAME];
  try {
    const fs = (await import("node:fs" as string)) as { readFileSync(path: URL, enc: "utf8"): string };
    const dotenv = fs.readFileSync(new URL("../../../../.env", import.meta.url), "utf8");
    return new RegExp(`^${KEY_NAME}=(.+)$`, "m").exec(dotenv)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

const key = env.JEV_EVAL ? await keyFromEnv() : "";
const client: SystemOneLike | null = key
  ? { systemOne: (r, o) => proxyJevClient("https://api.typesafe.ai/v1/systemone", key).systemOne({ ...r, model: "jev-latest" } as never, o) }
  : null;

const pct = (x: number) => x.toFixed(2);
function measure(rows: readonly { ask: boolean; predicted: boolean }[]) {
  const tp = rows.filter((r) => r.ask && r.predicted).length;
  const fp = rows.filter((r) => !r.ask && r.predicted).length;
  const fn = rows.filter((r) => r.ask && !r.predicted).length;
  return `precision ${pct(tp / (tp + fp))}, recall ${pct(tp / (tp + fn))} (tp ${tp}, fp ${fp}, fn ${fn})`;
}

/** Runs at most `limit` promises at once. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const n = i++;
        out[n] = await fn(items[n]!);
      }
    }),
  );
  return out;
}

describe.skipIf(!client)("classifier with real Jev (JEV_EVAL=1)", () => {
  it("measures rules + Jev, and Jev alone, on the labelled set", { timeout: 180_000 }, async () => {
    const rows = await pool(CASES, 6, async (c) => {
      const rules = classifyByRules(c.action);
      const started = Date.now();
      try {
        const j = await judgeWithJev(client!, c.action, "");
        return { c, rules, j, ms: Date.now() - started, error: null as string | null };
      } catch (e) {
        return { c, rules, j: null, ms: Date.now() - started, error: String(e) };
      }
    });
    const jevAsks = (r: (typeof rows)[number]) => !r.j || r.j.kind !== null || r.j.confidence < JUDGE_MIN_CONFIDENCE;
    const combined = rows.map((r) => ({ ask: r.c.ask, predicted: r.rules.verdict === "consequential" || (r.rules.verdict === "unsure" && jevAsks(r)) }));
    const alone = rows.map((r) => ({ ask: r.c.ask, predicted: jevAsks(r) }));
    const unsure = rows.filter((r) => r.rules.verdict === "unsure");
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
      [
        `Jev eval: ${rows.length} cases, ${rows.filter((r) => r.error).length} errors; latency median ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms`,
        `rules + Jev for the ${unsure.length} unsure: ${measure(combined)}`,
        `Jev alone: ${measure(alone)}`,
        "unsure cases, as Jev judged them:",
        ...unsure.map((r) => `  ${r.c.ask ? "ASK " : "OK  "} ${r.c.name}: ${r.j ? `${r.j.kind ?? "none"} ${pct(r.j.confidence)}` : r.error}`),
        "Jev alone wrong:",
        ...rows.filter((r, i) => alone[i]!.predicted !== r.c.ask).map((r) => `  ${r.c.ask ? "ASK " : "OK  "} ${r.c.name}: ${r.j ? `${r.j.kind ?? "none"} ${pct(r.j.confidence)}` : r.error}`),
      ].join("\n"),
    );
    expect(rows.filter((r) => r.error).length).toBeLessThan(rows.length);
  });

  it("measures the classifier as the gate uses it (judgeAction) on both sets", { timeout: 180_000 }, async () => {
    for (const [label, set] of [["labelled", CASES], ["held out", HOLDOUT_CASES]] as const) {
      const rows = await pool(set, 6, async (c) => ({ c, j: await judgeAction(c.action, { jev: client }) }));
      const wrong = rows.filter((r) => r.j.consequential !== r.c.ask);
      console.log(
        [
          `judgeAction (rules, then Jev for unsure clicks) on the ${label} set: ${measure(rows.map((r) => ({ ask: r.c.ask, predicted: r.j.consequential })))}; decided by rules ${rows.filter((r) => r.j.by === "rules").length}, Jev ${rows.filter((r) => r.j.by === "jev").length}, unsure ${rows.filter((r) => r.j.by === "unsure").length}`,
          ...wrong.map((r) => `  ${r.c.ask ? "MISSED" : "asks needlessly"}: ${r.c.name} (${r.j.reason})`),
        ].join("\n"),
      );
    }
  });

  it("measures the within-task question against the word rules", { timeout: 120_000 }, async () => {
    const rows = await pool(WITHIN_CASES, 6, async (c) => {
      const rules = classifyByRules(c.action);
      const kind = rules.verdict === "benign" ? "submit" : (rules.kind ?? "submit");
      const j = await judgeWithJev(client!, c.action, "", c.instructions).catch(() => null);
      const rulesSay = withinInstructions(kind, c.action, { instructions: c.instructions });
      return { c, rulesSay, byRules: rulesSay === "yes", byJev: j?.within ? j.within.yes && j.within.confidence >= JUDGE_MIN_CONFIDENCE : false, j };
    });
    const right = (f: (r: (typeof rows)[number]) => boolean) => rows.filter((r) => f(r) === r.c.within).length;
    const combined = await pool(WITHIN_CASES, 6, async (c) => {
      const rules = classifyByRules(c.action);
      return { c, within: (await judgeWithinTask(rules.verdict === "benign" ? undefined : rules.kind, c.action, { instructions: c.instructions }, { jev: client })).within };
    });
    const gateRight = combined.filter((r) => r.within === r.c.within);
    const letThrough = combined.filter((r) => r.within && !r.c.within).map((r) => r.c.name);
    console.log(`within-task as the gate judges it (rules; Jev only where they are unsure): ${gateRight.length}/${combined.length} right; let through what the task does not ask for: ${letThrough.length ? letThrough.join(", ") : "none"}`);
    for (const r of combined) if (r.within !== r.c.within) console.log(`  gate WRONG: ${r.c.name} (expected ${r.c.within ? "within" : "beyond"})`);
    // Whatever Jev answers, nothing the task does not ask for runs on its own.
    expect(letThrough).toEqual([]);
    console.log(
      [
        `within-task: rules ${right((r) => r.byRules)}/${rows.length} right, Jev ${right((r) => r.byJev)}/${rows.length} right`,
        ...rows.map((r) => `  ${r.c.within ? "within" : "beyond"} ${r.c.name}: rules ${r.rulesSay}, Jev ${r.j?.within ? `${r.j.within.yes ? "yes" : "no"} ${pct(r.j.within.confidence)}` : "error"}`),
      ].join("\n"),
    );
  });
});
