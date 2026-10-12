import { describe, expect, it } from "vitest";
import { forgetOldTabs, JobNav, storedView, storeView, viewAnnouncement, type PanelView } from "../../src/sidepanel/job-nav.js";

describe("JobNav: the list and a job's page", () => {
  it("opens on the list; a job's page; back gives the list as it was left", () => {
    const nav = new JobNav();
    const seen: [PanelView, PanelView][] = [];
    nav.onChange((v, before) => seen.push([v, before]));
    expect(nav.view).toEqual({ kind: "list" });
    expect(nav.jobKey).toBeNull();
    nav.open("chat:s1", { view: "scheduled", query: "lisbon", scrollTop: 420, focusKey: "chat:s1" });
    expect(nav.view).toEqual({ kind: "job", key: "chat:s1" });
    expect(nav.jobKey).toBe("chat:s1");
    expect(nav.back()).toEqual({ view: "scheduled", query: "lisbon", scrollTop: 420, focusKey: "chat:s1" });
    expect(nav.view).toEqual({ kind: "list" });
    expect(seen).toEqual([
      [{ kind: "job", key: "chat:s1" }, { kind: "list" }],
      [{ kind: "list" }, { kind: "job", key: "chat:s1" }],
    ]);
  });

  it("a job opened from another job's page keeps the list's place; the same view twice is no change", () => {
    const nav = new JobNav();
    let changes = 0;
    nav.onChange(() => changes++);
    nav.open("task:a", { view: "home", query: "x", scrollTop: 10, focusKey: "task:a" });
    nav.open("task:a", { view: "scheduled", query: "ignored", scrollTop: 0, focusKey: null });
    nav.open("chat:b", { view: "scheduled", query: "ignored", scrollTop: 0, focusKey: null });
    expect(changes).toBe(2);
    expect(nav.back()).toEqual({ view: "home", query: "x", scrollTop: 10, focusKey: "task:a" });
    nav.back();
    expect(changes).toBe(3);
  });

  it("opened without the list's place (a new job started from the list's box): the last place stays", () => {
    const nav = new JobNav();
    nav.open("chat:new");
    expect(nav.back()).toEqual({ view: "home", query: "", scrollTop: 0, focusKey: null });
  });

  it("says the view to screen readers", () => {
    expect(viewAnnouncement({ kind: "list" }, null)).toBe("Jobs");
    expect(viewAnnouncement({ kind: "job", key: "chat:s" }, "Flights to Lisbon")).toBe("Job: Flights to Lisbon");
  });

  it("forgets the tab older panels saved (Chat | TODO | History)", () => {
    const removed: string[] = [];
    forgetOldTabs({ removeItem: (k) => void removed.push(k) });
    expect(removed).toEqual(["noa.panel.tab", "tab"]);
    expect(() => forgetOldTabs({ removeItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });

  it("starts the list on the view the panel showed last (Home when none, or storage is blocked)", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    expect(storedView(storage)).toBe("home");
    storeView(storage, "scheduled");
    expect(storedView(storage)).toBe("scheduled");
    expect(new JobNav(storedView(storage)).listPlace()).toEqual({ view: "scheduled", query: "", scrollTop: 0, focusKey: null });
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(storedView(blocked)).toBe("home");
    expect(() => storeView(blocked, "home")).not.toThrow();
  });
});
