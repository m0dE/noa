import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ApprovalRequest, LocalTask, SessionInfo } from "@noa/shared";
import type { TodoSource } from "../../src/account/todo-source.js";
import { decidePaused } from "../../src/approval/paused-decision.js";
import { pausedRequest, PREAPPROVAL_TTL_MS, Preapprovals } from "../../src/approval/paused.js";

const REQ: ApprovalRequest = { id: "a1", action: 'Click "Post" as @acme', site: "x.com", why: "publishes", kind: "publish", text: "Shipped: run history", expiresAt: "2026-09-28T09:00:00.000Z" };
/** A scheduled run that paused at REQ: the card, its "paused" ending, the pause line and the run's end. */
const PAUSED: AgentEvent[] = [
  { type: "tool_call", id: "1", name: "click", args: { index: 4 } },
  { type: "approval_request", request: REQ },
  { type: "approval_resolved", id: "a1", outcome: "paused" },
  { type: "status", text: 'Pausing: Needs your OK to: Click "Post" as @acme (publishes) — open to allow' },
  { type: "task_end", outcome: "paused", reason: 'Needs your OK to: Click "Post" as @acme (publishes) — open to allow' },
];

describe("pausedRequest: a card a run paused for can be decided until it is, or the run goes on", () => {
  it("the request while it is paused", () => {
    expect(pausedRequest(PAUSED, "a1")).toEqual(REQ);
    expect(pausedRequest(PAUSED, "nope")).toBeNull();
  });
  it("not once decided, nor answered in a live turn", () => {
    expect(pausedRequest([...PAUSED, { type: "approval_resolved", id: "a1", outcome: "deny", by: "card" }], "a1")).toBeNull();
    expect(pausedRequest([PAUSED[1]!, { type: "approval_resolved", id: "a1", outcome: "allow_once", by: "card" }, PAUSED[4]!], "a1")).toBeNull();
  });
  it("not once the conversation went on (a message, another turn)", () => {
    expect(pausedRequest([...PAUSED, { type: "user_message", text: "go on" }], "a1")).toBeNull();
    expect(pausedRequest([...PAUSED, { type: "status", text: "noted" }], "a1")).toEqual(REQ);
    // The run's end has not come yet: it is still pausing.
    expect(pausedRequest(PAUSED.slice(0, 4), "a1")).toBeNull();
  });
});

describe("Preapprovals: the exact action, once, for the run that goes on", () => {
  it("matches the same words, site, kind and text; is used up; other actions and other runs do not match", () => {
    const p = new Preapprovals();
    p.grant(["s1", "t1"], REQ);
    expect(p.take(["s9"], REQ)).toBe(false);
    expect(p.take(["s2", "t1"], { ...REQ, text: "Another post" })).toBe(false);
    expect(p.take(["s2", "t1"], { ...REQ, action: 'Click "Post" as @other' })).toBe(false);
    expect(p.take(["s2", "t1"], { ...REQ, site: "example.com" })).toBe(false);
    expect(p.take(["s2", "t1"], { ...REQ, text: "  Shipped: run history " })).toBe(true);
    expect(p.take(["s1"], REQ)).toBe(false);
  });
  it("a conversation that goes on clicks without typing again: no text now matches the text typed before", () => {
    const p = new Preapprovals();
    p.grant(["s1"], REQ);
    const { text: _typed, ...click } = REQ;
    expect(p.take(["s1"], click)).toBe(true);
  });
  it("expires", () => {
    let now = 0;
    const p = new Preapprovals(() => now);
    p.grant(["s1"], REQ);
    now = PREAPPROVAL_TTL_MS;
    expect(p.take(["s1"], REQ)).toBe(false);
  });
});

function setup(session: Partial<SessionInfo>, rows: Partial<LocalTask>[] = [], kind: "account" | "local" = "account") {
  const s: SessionInfo = { sessionId: "s1", source: "cloud", taskId: "t1", seriesId: "t0", title: "Post", brain: "claude-api", jev: false, startedAt: "2026-09-28T08:59:00.000Z", endedAt: "2026-09-28T09:00:00.000Z", outcome: "paused", ...session };
  const events: AgentEvent[] = [...PAUSED];
  const todo = {
    kind,
    seriesPage: vi.fn(async () => ({ tasks: rows.map((r) => ({ id: "t1", status: "paused", repeat: null, ...r }) as LocalTask), nextCursor: null })),
    resume: vi.fn(async () => ({}) as LocalTask),
    cancel: vi.fn(async () => ({}) as LocalTask),
    pause: vi.fn(async () => ({}) as LocalTask),
  };
  const deps = {
    session: vi.fn(async () => s),
    events: vi.fn(async () => events),
    note: vi.fn(async (_id: string, e: AgentEvent) => void events.push(e)),
    running: vi.fn(() => false),
    preapprovals: new Preapprovals(),
    continueSession: vi.fn(async () => ({})),
    runTask: vi.fn(async () => ({})),
    todo: vi.fn(async () => todo as unknown as TodoSource),
  };
  return { deps, todo, events };
}

describe("decidePaused", () => {
  it("Allow & continue on an account run: the answer in the thread, the action allowed ahead for its task, the task runs again", async () => {
    const t = setup({});
    expect(await decidePaused(t.deps, "s1", "a1", "allow_once", "card")).toBe(true);
    expect(t.events.at(-1)).toEqual({ type: "approval_resolved", id: "a1", outcome: "allow_once", by: "card" });
    expect(t.deps.runTask).toHaveBeenCalledWith("t1");
    expect(t.deps.continueSession).not.toHaveBeenCalled();
    // The new run (another session, the same task) reaches the same action: it runs without a card, once.
    expect(t.deps.preapprovals.take(["s-new", "t1"], REQ)).toBe(true);
    // Decided: a second click does nothing.
    expect(await decidePaused(t.deps, "s1", "a1", "allow_once", "card")).toBe(false);
  });

  it("Allow & continue on this browser's run: its conversation goes on", async () => {
    const t = setup({ source: "local" });
    expect(await decidePaused(t.deps, "s1", "a1", "allow_once", "keyboard")).toBe(true);
    expect(t.deps.continueSession).toHaveBeenCalledWith("s1");
    expect(t.deps.runTask).not.toHaveBeenCalled();
    expect(t.deps.preapprovals.take(["s1"], REQ)).toBe(true);
  });

  it("Don't: not done; a repeating task waits for its next time, a one-off one of the account is cancelled, of this browser kept paused", async () => {
    const repeating = setup({}, [{ repeat: { cron: "0 9 * * *", tz: "UTC" } }]);
    expect(await decidePaused(repeating.deps, "s1", "a1", "deny", "card")).toBe(true);
    expect(repeating.events.at(-1)).toEqual({ type: "approval_resolved", id: "a1", outcome: "deny", by: "card" });
    expect(repeating.todo.seriesPage).toHaveBeenCalledWith("t0");
    expect(repeating.todo.resume).toHaveBeenCalledWith("t1");
    expect(repeating.deps.runTask).not.toHaveBeenCalled();
    expect(repeating.deps.preapprovals.take(["s1", "t1"], REQ)).toBe(false);

    const once = setup({}, [{}]);
    await decidePaused(once.deps, "s1", "a1", "deny", "card");
    expect(once.todo.cancel).toHaveBeenCalledWith("t1");

    const local = setup({ source: "local" }, [{}], "local");
    await decidePaused(local.deps, "s1", "a1", "deny", "card");
    expect(local.todo.pause).toHaveBeenCalledWith("t1");

    // Its row moved on already (retried): left alone.
    const moved = setup({}, [{ status: "pending" }]);
    await decidePaused(moved.deps, "s1", "a1", "deny", "card");
    expect([moved.todo.resume, moved.todo.cancel, moved.todo.pause].some((f) => f.mock.calls.length)).toBe(false);
  });

  it("nothing to decide: a running run, another card, or one decided", async () => {
    const t = setup({});
    t.deps.running.mockReturnValue(true);
    expect(await decidePaused(t.deps, "s1", "a1", "allow_once", "card")).toBe(false);
    t.deps.running.mockReturnValue(false);
    expect(await decidePaused(t.deps, "s1", "a2", "allow_once", "card")).toBe(false);
    expect(t.deps.note).not.toHaveBeenCalled();
  });
});
