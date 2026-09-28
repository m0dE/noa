/** The chat's TODO cards: a task the agent scheduled, changed or cancelled; its line, View (its job), Undo, and undone. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@noa/shared";
import { describeEvent, scheduledView } from "../../src/sidepanel/event-format.js";
import { renderEvent, type ScheduledCardActions } from "../../src/sidepanel/event-render.js";
import { installMiniDom, type MiniElement } from "./mini-dom.js";

const EVENT = { type: "task_scheduled", taskId: "t9", instructions: "Check the order status\nat https://shop.example.com/orders/42", schedule: { at: "2026-09-26T22:45:00Z" } } satisfies AgentEvent;
/** Moved to Fri Oct 2, 3:00 PM New York. */
const UPDATED = {
  type: "task_changed",
  changeId: "c1",
  taskId: "t4",
  change: "updated",
  instructions: "Open the Vendor call meeting link",
  schedule: { at: "2026-10-02T19:00:00.000Z" },
  before: { instructions: "Open the Vendor call meeting link", account: null, schedule: { at: "2026-10-01T20:50:00.000Z" } },
} satisfies AgentEvent;
const CANCELLED = { type: "task_changed", changeId: "c2", taskId: "t5", change: "cancelled", instructions: "Dentist: leave at 2:30", schedule: { at: "2026-10-01T18:30:00.000Z" } } satisfies AgentEvent;
/** Seen at 15:45 in New York, the same day. */
const SEEN = { now: new Date("2026-09-26T19:45:00Z"), timeZone: "America/New_York", hour12: true };
const actions = (over: Partial<ScheduledCardActions> = {}): ScheduledCardActions => ({ view: vi.fn(), undo: vi.fn(async () => {}), undoChange: vi.fn(async () => {}), ...over });
const cardOf = (ev: Extract<AgentEvent, { type: "task_scheduled" | "task_changed" }>, undone: boolean, a?: ScheduledCardActions) =>
  renderEvent(scheduledView(ev, undone, SEEN), undefined, a) as unknown as MiniElement;
const card = (undone: boolean, a?: ScheduledCardActions) => cardOf(EVENT, undone, a);
const byClass = (el: MiniElement, c: string) => el.all().find((e) => e.classList.contains(c));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("scheduled card", () => {
  beforeAll(installMiniDom);

  it("one line: Scheduled, the task's first line, its schedule; the whole task in the tooltip", () => {
    const el = card(false, actions());
    expect(el.classList.contains("ev-scheduled")).toBe(true);
    expect(el.getAttribute("data-task-id")).toBe("t9");
    expect(byClass(el, "sched-line")!.textContent).toBe("Scheduled:Check the order status· Once, today at 6:45 PM");
    expect(byClass(el, "sched-line")!.title).toContain("https://shop.example.com/orders/42");
    expect(el.all("button").map((b) => b.textContent)).toEqual(["View", "Undo"]);
  });

  it("View and Undo name the task", async () => {
    const a = actions();
    const el = card(false, a);
    byClass(el, "sched-view")!.click();
    expect(a.view).toHaveBeenCalledWith("t9");
    byClass(el, "sched-undo")!.click();
    await settle();
    expect(a.undo).toHaveBeenCalledWith("t9");
    expect(a.undoChange).not.toHaveBeenCalled();
  });

  it("a failed undo says why under the line and keeps Undo", async () => {
    const el = card(false, actions({ undo: vi.fn(async () => Promise.reject(new Error("the task is running"))) }));
    byClass(el, "sched-undo")!.click();
    await settle();
    const note = byClass(el, "sched-note")!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Couldn't undo: the task is running");
    expect(byClass(el, "sched-undo")).toBeDefined();
  });

  it("undone: says so, no buttons", () => {
    const el = card(true, actions());
    expect(el.classList.contains("undone")).toBe(true);
    expect(byClass(el, "sched-label")!.textContent).toBe("Undone:");
    expect(el.all("button")).toEqual([]);
    expect(el.textContent).toContain("Removed from your jobs.");
  });
});

describe("changed and cancelled cards", () => {
  beforeAll(installMiniDom);

  it("Changed: the task with its new time; Undo names the change, View the task", async () => {
    const a = actions();
    const el = cardOf(UPDATED, false, a);
    expect(el.getAttribute("data-change-id")).toBe("c1");
    expect(el.getAttribute("data-change")).toBe("updated");
    expect(byClass(el, "sched-line")!.textContent).toBe("Changed:Open the Vendor call meeting link· Once, Fri, Oct 2 at 3:00 PM");
    expect(byClass(el, "sched-undo")!.title).toBe("Put this task back as it was");
    byClass(el, "sched-view")!.click();
    expect(a.view).toHaveBeenCalledWith("t4");
    byClass(el, "sched-undo")!.click();
    await settle();
    expect(a.undoChange).toHaveBeenCalledWith("c1");
    expect(a.undo).not.toHaveBeenCalled();
  });

  it("Cancelled: the task as it was; undone it is back in the list", () => {
    const el = cardOf(CANCELLED, false, actions());
    expect(byClass(el, "sched-line")!.textContent).toBe("Cancelled:Dentist: leave at 2:30· Once, Thu, Oct 1 at 2:30 PM");
    expect(byClass(el, "sched-undo")!.title).toBe("Schedule this job again");
    const undone = cardOf(CANCELLED, true, actions());
    expect(byClass(undone, "sched-label")!.textContent).toBe("Undone:");
    expect(undone.textContent).toContain("Scheduled again.");
    expect(undone.all("button")).toEqual([]);
    expect(cardOf(UPDATED, true, actions()).textContent).toContain("Put back as it was.");
  });

  it("the events read as cards; their undos show nothing of their own", () => {
    expect(describeEvent(UPDATED, { undone: true })).toMatchObject({ kind: "scheduled", change: "updated", changeId: "c1", undone: true });
    expect(describeEvent({ type: "task_change_undone", changeId: "c1" })).toEqual({ kind: "status", text: "" });
  });
});
