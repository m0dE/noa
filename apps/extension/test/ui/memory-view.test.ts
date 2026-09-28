import { describe, expect, it } from "vitest";
import type { AgentEvent, MemoryEntry } from "@noa/shared";
import { backfillText, dayTimeText, EPISODES_PAGE, forgetAllText, forgetTaskText, kindsOffAfter, memoryPanel, PINNABLE_KINDS, RECORDS_PAGE, syncText } from "../../src/options/memory-view.js";
import { memoryNoteView, undoneText } from "../../src/sidepanel/memory-note.js";
import { chatMemoryView } from "../../src/sidepanel/chat-memory.js";
import { describeEvent } from "../../src/sidepanel/event-format.js";
import { SECTIONS, sectionFromHash } from "../../src/options/settings-view.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const entry = (e: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "kind" | "subject" | "text">): MemoryEntry => ({
  scope: "global",
  source: { kind: "chat", sessionId: "s1", title: "Check my inbox" },
  learnedAt: "2026-09-24T09:00:00.000Z",
  updatedAt: "2026-09-24T09:00:00.000Z",
  ...e,
});

describe("memoryPanel (Settings > Memory)", () => {
  const entries = [
    entry({ id: "m1", kind: "account", subject: "Work email", text: "admin@runhq.io, Google /u/2", lastUsedAt: "2026-09-26T08:00:00.000Z" }),
    entry({ id: "m2", kind: "playbook", subject: "Compose", text: "C opens it", scope: "domain", domain: "mail.google.com", updatedAt: "2026-09-25T09:00:00.000Z" }),
    entry({ id: "m3", kind: "task", subject: "Run note", text: "Posted topic A", scope: "task", taskKey: "t1", taskTitle: "Post a daily tip", source: { kind: "task", title: "Post a daily tip" } }),
    entry({ id: "m4", kind: "account", subject: "Game account", text: "@mecharoyalecom", updatedAt: "2026-09-25T10:00:00.000Z" }),
  ];

  it("groups entries by kind in the order Settings lists them, newest first", () => {
    const v = memoryPanel(entries, { memoryPaused: false, memoryKindsOff: [] }, NOW);
    expect(v.kinds.map((k) => k.kind)).toEqual(["preference", "account", "person", "playbook", "task", "episode", "record"]);
    expect(v.kinds.find((k) => k.kind === "account")!.entries.map((e) => e.id)).toEqual(["m4", "m1"]);
    expect(v.total).toBe(4);
    expect(v.empty).toBe(false);
  });

  it("says where each entry applies, when it was learned, used and changed, and where it came from", () => {
    const v = memoryPanel(entries, { memoryPaused: false, memoryKindsOff: [] }, NOW);
    const all = v.kinds.flatMap((k) => k.entries);
    expect(all.find((e) => e.id === "m1")).toMatchObject({ where: "", meta: "Learned Sep 24 · used Sep 26 · from “Check my inbox”" });
    expect(all.find((e) => e.id === "m2")).toMatchObject({ where: "mail.google.com", meta: "Learned Sep 24 · updated Sep 25 · not used yet · from “Check my inbox”" });
    // Task history is listed under its task, which names it.
    expect(all.find((e) => e.id === "m3")).toBeUndefined();
    expect(v.kinds.find((k) => k.kind === "task")!.tasks).toEqual([expect.objectContaining({ taskKey: "t1", title: "Post a daily tip", countText: "1 run note", total: 1 })]);
  });

  // Examples only: a task's records under two keys.
  const records = [
    entry({ id: "r1", kind: "task", subject: "Ada.Lee@example.com", key: "ada.lee@example.com", text: "Prefers email.", scope: "task", taskKey: "t1", taskTitle: "Post a daily tip", notes: [{ at: "2026-09-25T09:00:00.000Z", text: "Invoice resent." }], updatedAt: "2026-09-25T09:00:00.000Z" }),
    entry({ id: "r2", kind: "task", subject: "#48213", key: "48213", text: "Refund sent.", scope: "task", taskKey: "t1", taskTitle: "Post a daily tip" }),
  ];

  it("groups a task's run notes and records, with counts and the records' dated notes", () => {
    const [t] = memoryPanel([...entries, ...records], { memoryPaused: false, memoryKindsOff: [] }, NOW).kinds.find((k) => k.kind === "task")!.tasks;
    expect(t).toMatchObject({ countText: "1 run note · 2 records", total: 3 });
    expect(t!.notes.map((e) => e.id)).toEqual(["m3"]);
    expect(t!.records.map((e) => e.id)).toEqual(["r1", "r2"]);
    expect(t!.records[0]!.notes).toEqual([{ when: "Sep 25", text: "Invoice resent." }]);
  });

  it("search narrows every group to what matches (every word, case aside); a task's total stays whole", () => {
    const v = memoryPanel([...entries, ...records], { memoryPaused: false, memoryKindsOff: [] }, NOW, "  INVOICE resent ");
    expect(v.search).toEqual({ query: "INVOICE resent", found: 1 });
    expect(v.kinds.map((k) => k.count)).toEqual([0, 0, 0, 0, 1, 0, 0]);
    expect(v.kinds.find((k) => k.kind === "task")!.tasks[0]).toMatchObject({ countText: "1 record", total: 3 });
    expect(memoryPanel(records, { memoryPaused: false, memoryKindsOff: [] }, NOW, "48213").search.found).toBe(1);
  });

  it("lists episodes by when they happened, newest first, with their date, chips and task; no Edit", () => {
    const episodes = [
      entry({ id: "e1", kind: "episode", subject: "Refund for #48213", text: "Sent the refund.", at: "2026-09-20T15:05:00.000Z", entities: ["shop.example", "48213"], taskTitle: "Work the queue", updatedAt: "2026-09-25T09:00:00.000Z" }),
      entry({ id: "e2", kind: "episode", subject: "Checked the inbox", text: "Two replies needed.", at: "2026-09-23T08:00:00.000Z" }),
      entry({ id: "e3", kind: "episode", subject: "Last year", text: "Old run.", at: "2025-12-01T12:00:00.000Z", lastUsedAt: "2026-09-26T08:00:00.000Z" }),
    ];
    const k = memoryPanel([...entries, ...episodes], { memoryPaused: false, memoryKindsOff: [] }, NOW).kinds.find((x) => x.kind === "episode")!;
    expect(k.label).toBe("Episodes");
    expect(k.entries.map((e) => e.id)).toEqual(["e2", "e1", "e3"]);
    const e1 = k.entries[1]!;
    expect(e1).toMatchObject({ editable: false, entities: ["shop.example", "48213"], meta: "from “Work the queue”", where: "" });
    expect(e1.when).toBe(dayTimeText("2026-09-20T15:05:00.000Z", NOW));
    expect(e1.when).toMatch(/^Sep 20, \d{1,2}:\d{2} [AP]M$/);
    expect(e1.pinned).toBeUndefined();
    expect(k.entries[2]).toMatchObject({ meta: "used Sep 26", when: expect.stringMatching(/^Dec 1, 2025, /) });
    // Not listed as task history.
    const task = memoryPanel([...entries, ...episodes], { memoryPaused: false, memoryKindsOff: [] }, NOW).kinds.find((x) => x.kind === "task")!;
    expect(task.count).toBe(1);
  });

  it("the user's own records (filed by key in chats) are their own group, shown like a task's records, a page at a time", () => {
    const rec = entry({
      id: "u1", kind: "record", subject: "Ticket #7731", key: "ticket 7731", text: "Printer on floor 3 jams.", notes: [{ at: "2026-09-25T12:00:00.000Z", text: "Technician booked." }],
      updatedAt: "2026-09-25T12:00:00.000Z",
    });
    const v = memoryPanel([...entries, ...records, rec], { memoryPaused: false, memoryKindsOff: [] }, NOW);
    const k = v.kinds.find((x) => x.kind === "record")!;
    expect(k).toMatchObject({ label: "Records (by key)", count: 1, page: RECORDS_PAGE, tasks: [] });
    expect(k.entries).toEqual([expect.objectContaining({ id: "u1", subject: "Ticket #7731", text: "Printer on floor 3 jams.", where: "", editable: true, notes: [{ when: "Sep 25", text: "Technician booked." }] })]);
    expect(k.entries[0]!.pinned).toBeUndefined();
    // A task's records stay under their task.
    expect(v.kinds.find((x) => x.kind === "task")!.tasks[0]!.records.map((e) => e.id)).toEqual(["r1", "r2"]);
    expect(memoryPanel([rec], { memoryPaused: false, memoryKindsOff: [] }, NOW, "technician").search.found).toBe(1);
    expect(memoryPanel([rec], { memoryPaused: false, memoryKindsOff: ["record"] }, NOW).kinds.find((x) => x.kind === "record")).toMatchObject({ on: false, offHint: "Off: records are neither filed nor given to the agent" });
    expect(v.kinds.find((x) => x.kind === "episode")!.page).toBe(EPISODES_PAGE);
    expect(v.kinds.find((x) => x.kind === "account")!.page).toBeUndefined();
  });

  it("an episode's switch says that off, none are written nor given", () => {
    const v = memoryPanel(entries, { memoryPaused: false, memoryKindsOff: ["episode"] }, NOW);
    expect(v.kinds.find((k) => k.kind === "episode")).toMatchObject({ on: false, offHint: "Off: no episodes are written after chats and runs, and none are given to the agent" });
    expect(v.kinds.find((k) => k.kind === "person")!.offHint).toBe("Off: not given to the agent, not saved");
  });

  it("facts can be pinned (listed first); task history and records cannot", () => {
    const pinned = entry({ id: "m5", kind: "account", subject: "Old account", text: "x", pinned: true, updatedAt: "2026-09-01T00:00:00.000Z" });
    const v = memoryPanel([...entries, pinned], { memoryPaused: false, memoryKindsOff: [] }, NOW);
    expect(v.kinds.find((k) => k.kind === "account")!.entries.map((e) => [e.id, e.pinned])).toEqual([["m5", true], ["m4", false], ["m1", false]]);
    expect(v.kinds.find((k) => k.kind === "task")!.tasks[0]!.notes[0]!.pinned).toBeUndefined();
    expect(PINNABLE_KINDS).toEqual(["preference", "account", "person", "playbook"]);
  });

  it("shows what a fact said before, with the old subject when it was another", () => {
    const e = entry({
      id: "m6", kind: "person", subject: "Accountant", text: "Paul Lee",
      history: [
        { subject: "Accountant", text: "Tom Kim", since: "2025-01-01T00:00:00.000Z", until: "2026-09-20T12:00:00.000Z" },
        { subject: "Tax helper", text: "Ann Roe", since: "2024-01-01T00:00:00.000Z", until: "2025-01-01T12:00:00.000Z" },
      ],
    });
    const [row] = memoryPanel([e], { memoryPaused: false, memoryKindsOff: [] }, NOW).kinds.find((k) => k.kind === "person")!.entries;
    expect(row!.history).toEqual(["Before: Tom Kim (until Sep 20)", "Before: Tax helper: Ann Roe (until Jan 1, 2025)"]);
    expect(memoryPanel([e], { memoryPaused: false, memoryKindsOff: [] }, NOW, "ann roe").search.found).toBe(1);
  });

  it("asks before deleting a task's memory", () => {
    expect(forgetTaskText(3, false)).toEqual({ button: "Delete this task's memory", question: "" });
    expect(forgetTaskText(1, true)).toEqual({ button: "Yes, delete 1 entry", question: "Delete everything this task keeps (1 entry)? This can't be undone." });
    expect(forgetTaskText(1200, true).button).toBe("Yes, delete 1,200 entries");
  });

  it("says when it waits for the user about another account, or was kept separate", () => {
    expect(syncText({ state: "ask", account: "bob@example.com" })).toEqual({ text: "Add this computer's memory to bob@example.com? Nothing is sent until you choose.", tone: "", action: "ask", account: "bob@example.com" });
    expect(syncText({ state: "separate", account: "bob@example.com" })).toMatchObject({ text: "Kept on this computer only: you chose not to add it to bob@example.com.", action: "add" });
  });

  it("shows paused memory and kinds that are off", () => {
    const v = memoryPanel(entries, { memoryPaused: true, memoryKindsOff: ["person"] }, NOW);
    expect(v.on).toBe(false);
    expect(v.pausedNote).toMatch(/^Paused/);
    expect(v.kinds.find((k) => k.kind === "person")!.on).toBe(false);
    expect(memoryPanel([], { memoryPaused: false, memoryKindsOff: [] }, NOW)).toMatchObject({ empty: true, pausedNote: "" });
  });

  it("switching a kind keeps the others and the catalog order", () => {
    expect(kindsOffAfter(["task"], "person", false)).toEqual(["person", "task"]);
    expect(kindsOffAfter(["person", "task"], "person", true)).toEqual(["task"]);
  });

  it("asks before forgetting everything", () => {
    expect(forgetAllText(3, false)).toEqual({ button: "Forget everything", question: "" });
    expect(forgetAllText(3, true)).toEqual({ button: "Yes, forget 3 memories", question: "Forget all 3 memories? This can't be undone." });
    expect(forgetAllText(1, true).button).toBe("Yes, forget 1 memory");
  });

  it("the section exists and links reach it", () => {
    expect(SECTIONS.map((t) => t.id)).toContain("memory");
    expect(sectionFromHash("#memory")).toBe("memory");
    expect(sectionFromHash("#memories")).toBe("memory");
  });
});

describe("the chat's memory note", () => {
  const e = entry({ id: "m1", kind: "playbook", subject: "Compose", text: "left rail", scope: "domain", domain: "x.com" });
  const ev = (before: MemoryEntry | null, after: MemoryEntry | null): Extract<AgentEvent, { type: "memory" }> => ({ type: "memory", changeId: "c1", before, after });

  it("says what changed: remembered, updated or forgotten", () => {
    expect(memoryNoteView(ev(null, e), false)).toMatchObject({ kind: "memory", label: "Remembered", subject: "Compose", text: "left rail", title: "Site playbooks · x.com\nCompose: left rail" });
    expect(memoryNoteView(ev({ ...e, text: "top" }, e), false)).toMatchObject({ label: "Updated memory", title: expect.stringMatching(/Was: top$/) });
    expect(memoryNoteView(ev(e, null), false).label).toBe("Forgot");
  });

  it("a note added to a task's record shows that note", () => {
    const r = entry({ id: "r1", kind: "task", subject: "#48213", key: "48213", text: "Refund asked.", scope: "task", taskKey: "t1", taskTitle: "Work the queue" });
    const after = { ...r, notes: [{ at: "2026-09-25T09:00:00.000Z", text: "Refund sent." }] };
    expect(memoryNoteView(ev(r, after), false)).toMatchObject({ label: "Updated memory", subject: "#48213", text: "Refund sent.", title: "Task record · Work the queue\n#48213: Refund asked.\n2026-09-25: Refund sent." });
    expect(memoryNoteView(ev(null, r), false)).toMatchObject({ label: "Remembered", text: "Refund asked." });
  });

  it("saved by the background writer after the chat, it says so (still with Undo)", () => {
    const auto = { ...ev(null, e), auto: true as const };
    expect(memoryNoteView(auto, false)).toMatchObject({ change: "added", label: "Remembered after this chat", subject: "Compose" });
    expect(memoryNoteView({ ...ev({ ...e, text: "top" }, e), auto: true }, false).label).toBe("Updated after this chat");
    expect(undoneText(memoryNoteView(auto, true))).toBe("Not kept.");
  });

  it("one that replaced an entry of another subject names it; undone, that one is back", () => {
    const old = entry({ id: "m9", kind: "person", subject: "Tom Kim", text: "The user's accountant." });
    const now = entry({ id: "m10", kind: "person", subject: "Paul Lee", text: "The user's accountant since September." });
    const v = memoryNoteView({ ...ev(null, now), replaced: old }, false);
    expect(v).toMatchObject({ label: "Remembered", subject: "Paul Lee", replaced: { subject: "Tom Kim", text: "replaced “Tom Kim”" } });
    expect(v.title.endsWith("\n\nReplaced Tom Kim: The user's accountant.")).toBe(true);
    expect(undoneText(v)).toBe("Not kept. “Tom Kim” is back.");
    expect(memoryNoteView(ev(null, now), false).replaced).toBeUndefined();
  });

  it("once undone, says so", () => {
    const v = memoryNoteView(ev(null, e), true);
    expect(v.undone).toBe(true);
    expect(undoneText(v)).toBe("Not kept.");
    expect(undoneText({ change: "forgot" })).toBe("Kept after all.");
    expect(describeEvent({ type: "memory", changeId: "c1", before: null, after: e }, { memoryUndone: true })).toMatchObject({ kind: "memory", undone: true });
    expect(describeEvent({ type: "memory_undone", changeId: "c1" })).toEqual({ kind: "status", text: "" });
  });
});

describe("chatMemoryView (the composer's Memory switch)", () => {
  it("on, off in a chat or a new chat, and paused in settings", () => {
    expect(chatMemoryView({ paused: false, off: false, conversation: true })).toEqual({ on: true, disabled: false, hint: "Uses and saves what it learns", offBadge: false });
    expect(chatMemoryView({ paused: false, off: true, conversation: true })).toMatchObject({ on: false, hint: "Off in this chat", offBadge: true });
    expect(chatMemoryView({ paused: false, off: true, conversation: false }).hint).toBe("Off for this new chat");
    expect(chatMemoryView({ paused: true, off: true, conversation: true })).toEqual({ on: false, disabled: true, hint: "Paused in settings", offBadge: false });
  });
});

describe("Settings > Memory: summarizing past chats", () => {
  it("is one quiet line with how far it is", () => {
    expect(backfillText({ done: 12, total: 40 })).toBe("Summarising past chats: 12/40");
  });
});
