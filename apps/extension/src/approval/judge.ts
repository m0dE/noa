/**
 * The consequence classifier: the rules first (consequence.ts), Jev for what
 * they leave unsure (jev-judge.ts), and when still unsure the action counts
 * as consequential, so the gate asks.
 */
import type { ConsequenceKind } from "@noa/shared";
import { classifyByRules, type GateAction } from "./consequence.js";
import { judgeWithJev, type SystemOneLike } from "./jev-judge.js";
import { withinInstructions, type WithinRules } from "./within-task.js";

/** Jev's "nothing happens" counts only this sure; below it the user is asked. */
export const JUDGE_MIN_CONFIDENCE = 0.8;

export interface Judgement {
  consequential: boolean;
  /** What it does; absent when consequential only because nobody could tell. */
  kind?: ConsequenceKind;
  /** Why, for the approval card and the trace. */
  reason: string;
  /** Who decided: the rules, Jev, or neither (unsure, so it asks). */
  by: "rules" | "jev" | "unsure";
}

export async function judgeAction(action: GateAction, opts: { jev?: SystemOneLike | null; pageText?: string }): Promise<Judgement> {
  const rules = classifyByRules(action);
  if (rules.verdict === "benign") return { consequential: false, reason: rules.reason, by: "rules" };
  if (rules.verdict === "consequential") return { consequential: true, kind: rules.kind, reason: rules.reason, by: "rules" };
  const unsure: Judgement = { consequential: true, ...(rules.kind ? { kind: rules.kind } : {}), reason: rules.reason, by: "unsure" };
  // Jev judges elements; a key press depends on the site's shortcuts, which it does not know ("#" deletes in Gmail).
  if (!opts.jev || action.method === "pressKey") return unsure;
  try {
    const j = await judgeWithJev(opts.jev, action, opts.pageText ?? "");
    if (j.kind === null) return j.confidence >= JUDGE_MIN_CONFIDENCE ? { consequential: false, reason: `Jev: nothing is sent or published (${j.confidence.toFixed(2)})`, by: "jev" } : unsure;
    return { consequential: true, kind: j.kind, reason: `Jev: ${j.kind} (${j.confidence.toFixed(2)})`, by: "jev" };
  } catch {
    return { ...unsure, reason: `${rules.reason}; Jev could not judge it` };
  }
}

/** How the within-task question was answered: the verdict, the rules' answer, and Jev's ("yes 0.90"; absent: not asked). */
export interface WithinVerdict {
  within: boolean;
  /** Why, after what the action does, on the approval card: "the task does not ask for this". */
  reason: string;
  rules: WithinRules;
  jev?: string;
}

/**
 * Whether a scheduled task's instructions ask for a consequential action. The
 * word rules (within-task.ts) decide what they can tell: a yes (the task asks
 * for that verb on that site) runs, and Jev cannot veto it, since the task is
 * what the user wrote; a no waits. Only when the task asks for the action but
 * does not say where does Jev decide, and only a sure yes lets it run (no Jev:
 * it waits). The measured cases are in test/approval/consequence.test.ts and,
 * with real Jev, consequence-jev.eval.test.ts.
 */
export async function judgeWithinTask(
  kind: ConsequenceKind | undefined,
  action: GateAction,
  task: { instructions: string; account?: string | null },
  opts: { jev?: SystemOneLike | null; pageText?: string },
): Promise<WithinVerdict> {
  const rules: WithinRules = kind ? withinInstructions(kind, action, task) : "no";
  if (rules === "yes") return { within: true, reason: "the task asks for this", rules };
  const notAsked: WithinVerdict = { within: false, reason: rules === "no" ? "the task does not ask for this" : "the task does not say to do this on this site", rules };
  if (rules === "no" || !opts.jev) return notAsked;
  let jev = "error";
  try {
    const j = await judgeWithJev(opts.jev, action, opts.pageText ?? "", task.instructions);
    jev = j.within ? `${j.within.yes ? "yes" : "no"} ${j.within.confidence.toFixed(2)}` : "no answer";
    if (j.within?.yes && j.within.confidence >= JUDGE_MIN_CONFIDENCE) return { within: true, reason: `Jev: the task asks for this (${j.within.confidence.toFixed(2)})`, rules, jev };
  } catch {
    /* Jev could not judge it: it waits */
  }
  return { ...notAsked, jev };
}
