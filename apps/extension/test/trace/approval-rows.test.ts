/**
 * The Raw report's approval rows: an approval asked, how the gate judged it (both within-task verdicts), how long
 * it held the run and what ended it (card, key, voice, Stop, a message, no answer, nobody watching), so an
 * incident like a Post click held 8 minutes and then allowed after Stop is plain from the trace alone.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, SessionInfo, StampedAgentEvent, TraceEvent } from "@noa/shared";
import { addEvent, beginTurn, newBook, observe } from "../../src/trace/trace-book.js";
import { buildReport, reportText, type ReportEnv } from "../../src/trace/trace-report.js";

const T0 = Date.parse("2026-09-26T13:00:00Z");
const session: SessionInfo = { sessionId: "s1", source: "local", title: "Post one new original post on X", brain: "claude-code", jev: false, startedAt: new Date(T0).toISOString(), turns: 1 };
const env: ReportEnv = { extensionVersion: "0.4.0", userAgent: "test", helper: null };
const REQUEST = { id: "ap1", action: 'Click "Post"', site: "x.com", why: "publishes; the task does not ask for this", kind: "publish" as const, text: "Sunday 1pm on the rooftop", expiresAt: new Date(T0 + 600_000).toISOString() };

function incident(by: string, outcome: string, resolvedBy?: "card" | "keyboard" | "voice") {
  const book = newBook("s1");
  const events: StampedAgentEvent[] = [];
  const say = (t: number, e: AgentEvent) => {
    events.push({ ...e, ts: new Date(t).toISOString(), sessionId: "s1" } as StampedAgentEvent);
    observe(book, e, t);
  };
  const tr = (e: Omit<TraceEvent, "src">) => addEvent(book, { src: "engine", ...e });
  beginTurn(book, 1, T0, { brain: "claude-code" });
  tr({
    t: T0 + 38_000,
    ms: 900,
    cat: "approval",
    name: "approval.judge",
    data: { action: 'Click "Post"', level: "full_within_task", kind: "publish", by: "rules", reason: "Post button", withinRules: true, withinJev: "no 0.90", within: false, waits: true },
  });
  say(T0 + 38_900, { type: "approval_request", request: REQUEST });
  tr({ t: T0 + 38_900, ms: 494_000, cat: "approval", name: "approval.wait", data: { id: "ap1", action: 'Click "Post"', site: "x.com", outcome, by } });
  say(T0 + 532_900, { type: "approval_resolved", id: "ap1", outcome: outcome as never, ...(resolvedBy ? { by: resolvedBy } : {}) });
  say(T0 + 537_000, { type: "task_end", outcome: "paused", reason: "Stopped by the user" });
  return { book, events };
}

describe("Raw report: approval rows", () => {
  it("the request, the gate's verdicts, how long it held the run, and that Stop ended it", () => {
    const { book, events } = incident("stop", "ended");
    const report = buildReport({ session, events, trace: book, now: T0 + 600_000 });
    const rows = report.turns.flatMap((t) => t.rows);
    expect(rows.find((r) => r.name === "approval_request")).toMatchObject({ label: 'Approval asked: Click "Post" on x.com', text: "Sunday 1pm on the rooftop" });
    expect(rows.find((r) => r.name === "approval.judge")).toMatchObject({ label: 'Approval check: Click "Post" · waits for the user' });
    expect(rows.find((r) => r.name === "approval.judge")!.detail).toContain("task words: ask for it · Jev: no 0.90");
    expect(rows.find((r) => r.name === "approval.wait")).toMatchObject({ label: "Approval ended · by Stop", ms: 494_000 });
    expect(rows.find((r) => r.name === "approval_resolved")!.label).toBe("Approval: The task ended before an answer: not done");
    // The held click is among the slowest items of the summary.
    expect(report.summary.slowest).toContainEqual(expect.objectContaining({ label: "Approval ended · by Stop", ms: 494_000 }));
    const text = reportText(report, session, env);
    expect(text).toContain('Approval asked: Click "Post" on x.com');
    expect(text).toContain("Approval ended · by Stop");
  });

  it("names every way an approval ends", () => {
    const cases: [string, string, ("card" | "keyboard" | "voice")?][] = [
      ["card", "allow_once", "card"],
      ["keyboard", "deny", "keyboard"],
      ["voice", "allow_once", "voice"],
      ["message", "interrupted"],
      ["timeout", "timeout"],
      ["unattended", "paused"],
    ];
    const labels = cases.map(([by, outcome, resolvedBy]) => {
      const { book, events } = incident(by, outcome, resolvedBy);
      const rows = buildReport({ session, events, trace: book, now: T0 + 600_000 }).turns.flatMap((t) => t.rows);
      return [rows.find((r) => r.name === "approval.wait")!.label, rows.find((r) => r.name === "approval_resolved")!.label];
    });
    expect(labels).toEqual([
      ["Approval allow_once · by the card", "Approval: Allowed (the card)"],
      ["Approval deny · by the card's key", "Approval: Denied (the card's key)"],
      ["Approval allow_once · by voice", "Approval: Allowed (voice)"],
      ["Approval interrupted · by a message from the user", "Approval: You wrote to the agent first: not done"],
      ["Approval timeout · by no answer in time", "Approval: No answer in time: not done"],
      ["Approval paused · by nobody watching (the run paused)", "Approval: Paused for your OK: not done yet. Continue the task to do it"],
    ]);
  });
});
