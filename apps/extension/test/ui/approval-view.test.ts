import { describe, expect, it } from "vitest";
import type { AgentEvent, ApprovalRequest } from "@noa/shared";
import { APPROVAL_ALLOW_ALL_NOTE, APPROVAL_BUTTONS, approvalEnding, approvalView, PAUSED_BUTTONS } from "../../src/sidepanel/approval-view.js";

const request: ApprovalRequest = { id: "a1", action: 'Click "Post" as @acme', site: "x.com", why: "publishes", kind: "publish", text: "Shipped", expiresAt: "2026-09-28T09:00:00.000Z" };
const ask: Extract<AgentEvent, { type: "approval_request" }> = { type: "approval_request", request };

describe("approval card view", () => {
  it("how a request ended: its last answer (a card its run paused at is decided after its turn)", () => {
    const paused: AgentEvent[] = [ask, { type: "approval_resolved", id: "a1", outcome: "paused" }, { type: "task_end", outcome: "paused", reason: "x" }];
    expect(approvalEnding(paused, "a1")).toEqual({ outcome: "paused" });
    expect(approvalEnding([...paused, { type: "approval_resolved", id: "a1", outcome: "allow_once", by: "keyboard" }], "a1")).toEqual({ outcome: "allow_once", by: "keyboard" });
    expect(approvalEnding([ask, { type: "task_end", outcome: "failed", reason: "x" }], "a1")).toEqual({ outcome: "ended" });
    expect(approvalEnding([ask], "a1")).toBeUndefined();
  });

  it("a paused card that can still be decided says so (its buttons: Allow & continue, Don't); decided, it says how", () => {
    expect(approvalView(ask, { outcome: "paused" }, true)).toMatchObject({ state: "paused", decidable: true });
    expect(approvalView(ask, { outcome: "paused" }, false)).not.toHaveProperty("decidable");
    expect(approvalView(ask, { outcome: "deny", by: "card" }, true)).toMatchObject({ state: "deny", outcome: "Denied" });
    expect(approvalView(ask, { outcome: "deny", by: "card" }, true)).not.toHaveProperty("decidable");
    expect(PAUSED_BUTTONS.map((b) => [b.answer, b.label])).toEqual([
      ["allow_once", "Allow & continue"],
      ["deny", "Don't"],
    ]);
  });

  it("the buttons say in plain words what each one allows", () => {
    expect(APPROVAL_BUTTONS.map((b) => [b.answer, b.label])).toEqual([
      ["allow_once", "Allow"],
      ["allow_task", "Allow all until done"],
      ["deny", "Deny"],
    ]);
    expect(APPROVAL_BUTTONS.every((b) => b.hint)).toBe(true);
    expect(APPROVAL_ALLOW_ALL_NOTE).toMatch(/won't ask again until it finishes/);
    expect(approvalView(ask, { outcome: "allow_task" })).toMatchObject({ outcome: "Allowed all until done" });
    expect(approvalView(ask, { outcome: "allow_once" })).toMatchObject({ outcome: "Allowed" });
  });
});
