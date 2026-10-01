import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import { approvalLine, spokenApprovalAnswer, WaitingApprovals } from "../../src/voice/approval-voice.js";
import { Narration } from "../../src/voice/narration.js";
import { NarratorFeed } from "../../src/voice/realtime-feed.js";
import { NARRATOR_TOOLS } from "../../src/voice/realtime-client.js";

const request = { id: "a1", action: 'Click "Post"', site: "x.com", why: "publishes", expiresAt: "2026-09-26T10:10:00Z" };
const ask: AgentEvent = { type: "approval_request", request };

describe("approvals in hands-free voice", () => {
  it("says what waits and how to answer", () => {
    expect(approvalLine(request)).toBe('Approval needed: Click "Post" on x.com; it publishes. Say yes to allow it, or no.');
    expect(new Narration().push(ask, 0)).toBe(approvalLine(request));
  });

  it("the Realtime narrator says the question word for word, and its status says to answer with its tool", () => {
    const out = new NarratorFeed().push(ask, 0);
    expect(out).toContainEqual({ say: { kind: "question", line: approvalLine(request) } });
    expect(out.flatMap((o) => ("status" in o ? [o.status] : [])).join(" ")).toMatch(/answer_approval/);
    expect(NARRATOR_TOOLS.map((t) => t.name)).toContain("answer_approval");
  });

  it("a short yes or no answers; anything longer is a message", () => {
    for (const t of ["Yes.", "yeah", "OK", "allow it", "Go ahead!", "yes please"]) expect(spokenApprovalAnswer(t)).toBe("allow_once");
    for (const t of ["No.", "nope", "deny", "don't", "Stop"]) expect(spokenApprovalAnswer(t)).toBe("deny");
    for (const t of ["yes and also reply to Maya", "post it tomorrow instead", ""]) expect(spokenApprovalAnswer(t)).toBeNull();
  });

  it("knows the approval each chat waits on until it ends", () => {
    const w = new WaitingApprovals();
    const at = (e: AgentEvent, sessionId = "s1") => ({ ...e, sessionId });
    w.push(at(ask));
    expect(w.of("s1")).toBe("a1");
    expect(w.of("s2")).toBeNull();
    w.push(at({ type: "approval_resolved", id: "a1", outcome: "deny" }));
    expect(w.of("s1")).toBeNull();
    w.push(at(ask));
    w.push(at({ type: "task_end", outcome: "paused" }));
    expect(w.of("s1")).toBeNull();
  });
});
