/** The chat's memory note: Undo while the change stands, Redo once it is undone. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent, MemoryEntry } from "@noa/shared";
import { memoryNoteView } from "../../src/sidepanel/memory-note.js";
import { renderMemoryNote, type MemoryNoteActions } from "../../src/sidepanel/event-render.js";
import { installMiniDom, type MiniElement } from "./mini-dom.js";

const ENTRY = { id: "m1", kind: "preference", subject: "Tone", text: "calm", learnedAt: "2026-09-26T19:45:00Z" } as MemoryEntry;
const EVENT = { type: "memory", changeId: "c1", before: null, after: ENTRY, auto: true } satisfies AgentEvent;
const actions = (over: Partial<MemoryNoteActions> = {}): MemoryNoteActions => ({ undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), ...over });
const note = (undone: boolean, a?: MemoryNoteActions) => renderMemoryNote(memoryNoteView(EVENT, undone), a) as unknown as MiniElement;
const byClass = (el: MiniElement, c: string) => el.all().find((e) => e.classList.contains(c));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("memory note", () => {
  beforeAll(installMiniDom);

  it("standing, Undo undoes it", async () => {
    const a = actions();
    const el = note(false, a);
    expect(el.all("button").map((b) => b.textContent)).toEqual(["Undo"]);
    byClass(el, "mem-undo")!.click();
    await settle();
    expect(a.undo).toHaveBeenCalledWith("c1");
    expect(a.redo).not.toHaveBeenCalled();
  });

  it("undone, it says so and Redo makes it again", async () => {
    const a = actions();
    const el = note(true, a);
    expect(el.classList.contains("undone")).toBe(true);
    expect(byClass(el, "mem-label")!.textContent).toBe("Undone:");
    expect(el.all("button").map((b) => b.textContent)).toEqual(["Redo"]);
    byClass(el, "mem-redo")!.click();
    await settle();
    expect(a.redo).toHaveBeenCalledWith("c1");
    expect(a.undo).not.toHaveBeenCalled();
  });

  it("a failed redo says why and keeps Redo", async () => {
    const el = note(true, actions({ redo: vi.fn(async () => Promise.reject(new Error("offline"))) }));
    byClass(el, "mem-redo")!.click();
    await settle();
    const bad = el.all().find((e) => e.classList.contains("bad"))!;
    expect(bad.hidden).toBe(false);
    expect(bad.textContent).toBe("Couldn't redo: offline");
    expect(byClass(el, "mem-redo")).toBeDefined();
  });

  it("without actions, no button", () => {
    expect(note(true).all("button")).toEqual([]);
  });
});
