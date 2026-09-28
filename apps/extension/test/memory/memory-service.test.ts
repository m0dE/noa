import { beforeEach, describe, expect, it } from "vitest";
import { memoryTaskKey, type ExtensionSettings, type MemoryKind, type SessionInfo } from "@noa/shared";
import { SessionStore } from "../../src/engine/sessions.js";
import { MEMORY_SEARCH_FOLLOW_UP_TIMEOUT_MS, MemoryService, isMemoryRequest } from "../../src/memory/service.js";
import { RECORDS_LABEL } from "../../src/memory/select.js";
import { MemoryStore } from "../../src/memory/store.js";
import { MemoryKvDb } from "../memory-kv.js";
import { memoryStorage } from "./fakes.js";

const NOW = "2026-09-26T10:00:00.000Z";
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: id, source: "adhoc", title: "Chat", brain: "claude-api", jev: false, startedAt: NOW, ...extra });
const DAILY = { instructions: "Post one tip about Mecha Royale on X", account: "@mecharoyalecom" };

let settings: Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">;
let sessions: SessionStore;
let store: MemoryStore;
let memory: MemoryService;
let changes: number;

beforeEach(async () => {
  settings = { memoryPaused: false, memoryKindsOff: [] as MemoryKind[] };
  sessions = new SessionStore(new MemoryKvDb(), { now: () => new Date(NOW) });
  let ids = 0;
  store = new MemoryStore({ storage: memoryStorage(), now: () => new Date(NOW), newId: () => `m${++ids}` });
  changes = 0;
  memory = new MemoryService({ store, sessions, settings: async () => settings, newChangeId: () => `c${++changes}` });
  await sessions.create(session("chat"));
  await sessions.create(session("run1", { source: "local", title: DAILY.instructions }));
});

const events = async (id: string) => {
  await sessions.flush();
  return sessions.eventsOf(id);
};

describe("remember", () => {
  it("keeps a fact from a chat and notes it in the chat for Undo", async () => {
    await memory.begin("chat", { title: "Check my inbox", request: "check my work inbox" });
    const r = await memory.tool("chat", "remember", { kind: "account", subject: "Work email", text: "admin@runhq.io is the work Gmail, Google /u/2" });
    expect(r).toEqual({ text: "Remembered [m1] Work email. The user sees it in the chat with Undo." });
    const [entry] = await store.list();
    expect(entry).toMatchObject({ scope: "global", source: { kind: "chat", sessionId: "chat", title: "Check my inbox" } });
    expect(await events("chat")).toEqual([expect.objectContaining({ type: "memory", changeId: "c1", before: null, after: entry })]);
  });

  it("refuses secrets and says how to phrase it instead", async () => {
    const r = await memory.tool("chat", "remember", { kind: "account", subject: "Bank", text: "password: hunter22" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not saved: .*Site logins/);
    expect(await store.list()).toEqual([]);
    expect(await events("chat")).toEqual([]);
  });

  it("refuses a password the agent was handed this run, even in plain words", async () => {
    const r = await memory.tool("chat", "remember", { kind: "account", subject: "Shop", text: "signs in with correcthorse" }, { knownSecret: (t) => t.includes("correcthorse") });
    expect(r).toEqual({ text: expect.stringMatching(/password you were given/), isError: true });
    expect(await store.list()).toEqual([]);
  });

  it("settles the scope: a playbook needs its site, task history needs a repeating task", async () => {
    expect((await memory.tool("chat", "remember", { kind: "playbook", subject: "Compose", text: "C opens it" })).text).toMatch(/give its domain/);
    expect((await memory.tool("chat", "remember", { kind: "playbook", subject: "Compose", text: "C opens it", domain: "gmail" })).text).toMatch(/not a site's host/);
    expect((await memory.tool("chat", "remember", { kind: "task", subject: "Posted", text: "topic A" })).text).toMatch(/no repeating task here/);
    await memory.tool("chat", "remember", { kind: "playbook", subject: "Compose", text: "C opens it", domain: "https://www.Mail.Google.com/mail/u/0" });
    expect(await store.list()).toEqual([expect.objectContaining({ scope: "domain", domain: "mail.google.com" })]);
  });

  it("an update replaces the entry and the note keeps what it was", async () => {
    await memory.tool("chat", "remember", { kind: "playbook", subject: "Compose", text: "top left", domain: "x.com" });
    const r = await memory.tool("chat", "remember", { kind: "playbook", subject: "Compose", text: "moved to the left rail", domain: "x.com" });
    expect(r.text).toMatch(/^Updated \[m1\]/);
    const last = (await events("chat")).at(-1);
    expect(last).toMatchObject({ type: "memory", before: { text: "top left" }, after: { text: "moved to the left rail" } });
  });

  it("does nothing while memory is paused, off in this chat, or the kind is off", async () => {
    settings.memoryPaused = true;
    expect(await memory.tool("chat", "remember", { kind: "preference", subject: "Tone", text: "calm" })).toEqual({ text: expect.stringMatching(/paused by the user/), isError: true });
    settings.memoryPaused = false;
    await memory.handle({ type: "chat.setMemory", sessionId: "chat", on: false });
    expect((await memory.tool("chat", "remember", { kind: "preference", subject: "Tone", text: "calm" })).text).toMatch(/off in this chat/);
    expect((await memory.tool("chat", "recall", { query: "tone" })).text).toMatch(/off in this chat/);
    await memory.handle({ type: "chat.setMemory", sessionId: "chat", on: true });
    settings.memoryKindsOff = ["preference"];
    expect((await memory.tool("chat", "remember", { kind: "preference", subject: "Tone", text: "calm" })).text).toMatch(/turned off Preferences/);
    expect(await store.list()).toEqual([]);
  });
});

describe("recall and forget", () => {
  it("recall lists matches with their ids and marks them used", async () => {
    await memory.tool("chat", "remember", { kind: "person", subject: "Paul Lee", text: "The user's accountant" });
    expect((await memory.tool("chat", "recall", { query: "who is Paul" })).text).toBe("- [m1] Paul Lee: The user's accountant");
    expect((await store.get("m1"))?.lastUsedAt).toBe(NOW);
    expect((await memory.tool("chat", "recall", { query: "zebra" })).text).toMatch(/Nothing in memory matches/);
  });

  it("forget removes an entry (named with or without brackets) and notes it", async () => {
    await memory.tool("chat", "remember", { kind: "person", subject: "Paul Lee", text: "accountant" });
    expect((await memory.tool("chat", "forget", { id: "[m1]" })).text).toMatch(/^Forgot \[m1\] Paul Lee/);
    expect(await store.list()).toEqual([]);
    expect((await memory.tool("chat", "forget", { id: "m1" })).isError).toBe(true);
    expect((await events("chat")).at(-1)).toMatchObject({ type: "memory", after: null, before: { id: "m1" } });
  });
});

describe("Undo on the chat's note", () => {
  it("puts the entry back as it was before the change, once", async () => {
    await memory.tool("chat", "remember", { kind: "preference", subject: "Tone", text: "calm" }); // c1
    await memory.tool("chat", "remember", { kind: "preference", subject: "Tone", text: "cheerful" }); // c2
    await memory.tool("chat", "forget", { id: "m1" }); // c3
    await memory.handle({ type: "memory.undo", sessionId: "chat", changeId: "c3" });
    expect((await store.get("m1"))?.text).toBe("cheerful");
    await memory.handle({ type: "memory.undo", sessionId: "chat", changeId: "c2" });
    expect((await store.get("m1"))?.text).toBe("calm");
    await memory.handle({ type: "memory.undo", sessionId: "chat", changeId: "c1" });
    expect(await store.list()).toEqual([]);
    // Twice is harmless; another chat's change is refused.
    expect(await memory.handle({ type: "memory.undo", sessionId: "chat", changeId: "c1" })).toEqual({ ok: true });
    expect(await store.list()).toEqual([]);
    await expect(memory.handle({ type: "memory.undo", sessionId: "run1", changeId: "c1" })).rejects.toThrow(/not made in this chat/);
    expect((await events("chat")).filter((e) => e.type === "memory_undone")).toHaveLength(3);
  });
});

describe("a repeating task's memory", () => {
  it("the first run's note is given to the second run (a new task row with the same instructions)", async () => {
    await memory.begin("run1", { task: DAILY, title: DAILY.instructions, request: DAILY.instructions });
    await memory.runNote("run1", "Posted the tip about the new arena map. Next: the ranked season.");
    const [note] = await store.list();
    expect(note).toMatchObject({ kind: "task", scope: "task", subject: "Run note", taskKey: memoryTaskKey(DAILY.instructions, DAILY.account), taskTitle: DAILY.instructions });
    expect((await events("run1")).at(-1)).toMatchObject({ type: "memory", after: { id: note!.id } });

    await sessions.create(session("run2", { source: "local", title: DAILY.instructions }));
    const given = await memory.begin("run2", { task: DAILY, title: DAILY.instructions, request: DAILY.instructions });
    expect(given?.text).toMatch(/Task history:\n- \[m1\] 2026-09-26 Run note: Posted the tip about the new arena map/);
    // A chat is not that task: it gets no run notes.
    expect(await memory.begin("chat", { title: "hi", request: DAILY.instructions })).toBeUndefined();
  });

  it("no note for a chat, while memory is off, or with task history off; a secret-looking note is refused in the chat", async () => {
    await memory.begin("chat", { title: "hi", request: "hi" });
    await memory.runNote("chat", "did things");
    await memory.begin("run1", { task: DAILY, title: DAILY.instructions, request: DAILY.instructions });
    settings.memoryKindsOff = ["task"];
    await memory.runNote("run1", "did things");
    expect(await store.list()).toEqual([]);
    settings.memoryKindsOff = [];
    await memory.runNote("run1", "Signed in with the code 482913");
    expect(await store.list()).toEqual([]);
    expect((await events("run1")).at(-1)).toMatchObject({ type: "status", text: expect.stringMatching(/^Run note not saved: .*one-time code/) });
  });
});

describe("a chat about a task (Talk about this)", () => {
  it("is given the task's history and may remember for the task, but leaves no run note", async () => {
    await memory.begin("run1", { task: DAILY, title: DAILY.instructions, request: DAILY.instructions });
    await memory.runNote("run1", "Posted the tip about the new arena map.");
    const given = await memory.begin("chat", { task: DAILY, review: true, title: "Talk", request: "Let's talk about my scheduled job" });
    expect(given?.text).toMatch(/Run note: Posted the tip about the new arena map/);
    const r = await memory.tool("chat", "remember", { kind: "task", subject: "Tone", text: "Casual, no hashtags, under 200 characters" });
    expect(r.isError).toBeUndefined();
    await memory.runNote("chat", "Tried a post about agents");
    const kept = await store.list();
    expect(kept.map((e) => e.subject).sort()).toEqual(["Run note", "Tone"]);
    expect(kept.find((e) => e.subject === "Tone")).toMatchObject({ scope: "task", taskKey: memoryTaskKey(DAILY.instructions, DAILY.account), source: { kind: "chat", sessionId: "chat" } });
  });
});

describe("a task series' memory (seriesId)", () => {
  const EDITED = { instructions: "Post one grounded tip about Mecha Royale on X. No price talk.", account: "@mecharoyalecom" };
  const run = async (id: string, task: { instructions: string; account: string | null; seriesId?: string }) => {
    await sessions.create(session(id, { source: "local", title: task.instructions }));
    return memory.begin(id, { task, title: task.instructions, request: task.instructions });
  };

  it("keeps runs (note and output) under the series: an edited task still gets them; outputs are cut, secrets left out", async () => {
    await run("r1", { ...DAILY, seriesId: "S1" });
    await memory.runNote("r1", "Posted about the arena map.", { output: "The new arena map is live: three lanes, one boss. " + "More lanes soon. ".repeat(120) });
    const [kept] = await store.list();
    expect(kept).toMatchObject({ taskKey: "sS1", subject: "Run note", text: "Posted about the arena map." });
    expect(kept!.output).toHaveLength(1000);
    // The task was edited (new instructions, same series): its history comes with it.
    const given = await run("r2", { ...EDITED, seriesId: "S1" });
    expect(given?.text).toMatch(/Run note: Posted about the arena map\. · output: "The new arena map is live: three lanes, one boss\./);
    // An output only (no note) is kept; one holding a secret is left out and the chat says so.
    await memory.runNote("r2", undefined, { output: "Ranked season starts Friday." });
    await memory.runNote("r2", "Posted.", { output: "use the code 482913 to log in" });
    const runs = (await store.list()).filter((e) => e.subject === "Run note");
    expect(runs.map((e) => [e.text, e.output])).toEqual([
      ["Posted about the arena map.", expect.any(String)],
      ["(no note)", "Ranked season starts Friday."],
      ["Posted.", undefined],
    ]);
    expect((await events("r2")).some((e) => e.type === "status" && /output was not kept/.test(e.text))).toBe(true);
  });

  it("adopts what was kept under the instructions of every row of the series (before series existed), once", async () => {
    // Before the update: two instruction texts (the task was edited once), each with its own hash key.
    await run("old1", DAILY);
    await memory.runNote("old1", "Old run under the first instructions.");
    await memory.tool("old1", "remember", { kind: "task", key: "#48213", text: "Asked for a refund." });
    await run("old2", EDITED);
    await memory.runNote("old2", "Old run under the edited instructions.");
    let asked = 0;
    memory = new MemoryService({
      store,
      sessions,
      settings: async () => settings,
      seriesTasks: async (seriesId) => {
        asked++;
        expect(seriesId).toBe("S9");
        return [DAILY, EDITED];
      },
    });
    const given = await run("new1", { ...EDITED, seriesId: "S9" });
    expect(given?.text).toContain("Old run under the first instructions.");
    expect(given?.text).toContain("Old run under the edited instructions.");
    expect((await store.list()).every((e) => e.taskKey === "sS9")).toBe(true);
    await run("new2", { ...EDITED, seriesId: "S9" });
    expect(asked).toBe(1);
    // Records follow: recall by key finds the adopted record.
    expect((await memory.tool("new2", "recall", { key: "48213" })).text).toMatch(/Asked for a refund\./);
  });

  it("when the series' rows cannot be read, adopts the current instructions and tries again next turn", async () => {
    await run("old", DAILY);
    await memory.runNote("old", "Old run.");
    let calls = 0;
    memory = new MemoryService({ store, sessions, settings: async () => settings, seriesTasks: async () => { calls++; throw new Error("offline"); } });
    expect((await run("n1", { ...DAILY, seriesId: "S2" }))?.text).toContain("Old run.");
    await run("n2", { ...DAILY, seriesId: "S2" });
    expect(calls).toBe(2);
  });

  it("an edit (update_scheduled_task) moves the old instructions' memory to the series", async () => {
    await run("old", DAILY);
    await memory.runNote("old", "Posted under the old text.");
    await memory.taskEdited({ ...DAILY, seriesId: "S3" }, { ...EDITED, seriesId: "S3" });
    expect((await store.list())[0]).toMatchObject({ taskKey: "sS3" });
  });

  it("check_similar flags a near-duplicate of an earlier output and passes a new draft", async () => {
    await run("c1", { ...DAILY, seriesId: "S4" });
    const none = await memory.tool("c1", "check_similar", { draft: "Anything" });
    expect(none.text).toMatch(/^This task has no earlier outputs kept yet/);
    await memory.runNote("c1", "Posted the arena tip.", { output: "Arena tip: rotate through the middle lane early and take the boss before the second wave." });
    await run("c2", { ...DAILY, seriesId: "S4" });
    const dup = await memory.tool("c2", "check_similar", { draft: "Arena tip: rotate through the middle lane early, then take the boss before the second wave!" });
    expect(dup.text).toMatch(/TOO SIMILAR: [01]\.\d\d to the output of 2026-09-26/);
    const fresh = await memory.tool("c2", "check_similar", { draft: "Patch 1.4 is out: ranked matchmaking now weighs recent games more." });
    expect(fresh.text).toMatch(/Not too similar by words/);
    expect((await memory.tool("c2", "check_similar", {})).isError).toBe(true);
  });

  it("memory.taskRuns: a task's runs for its details, newest first, also those not adopted yet", async () => {
    await run("t1", DAILY);
    await memory.runNote("t1", "Old.");
    await run("t2", { ...DAILY, seriesId: "S5" });
    await memory.runNote("t2", "New.", { output: "New post" });
    // t2's begin adopted "Old." already; a task not run since the update shows its hash's runs too.
    const { runs } = await memory.handle({ type: "memory.taskRuns", task: { ...DAILY, seriesId: "S5" } });
    expect(runs.map((e) => e.text).sort()).toEqual(["New.", "Old."]);
    expect(isMemoryRequest({ type: "memory.taskRuns" })).toBe(true);
  });
});

describe("begin", () => {
  it("gives what applies to the turn and marks it used; nothing when paused or off in the chat", async () => {
    await memory.tool("chat", "remember", { kind: "playbook", subject: "Work inbox", text: "Open /mail/u/2/ directly", domain: "mail.google.com" });
    const got = await memory.begin("chat", { title: "Check", request: "any new mail?", tabUrl: "https://mail.google.com/mail/u/0/#inbox" });
    expect(got?.entries.map((e) => e.id)).toEqual(["m1"]);
    expect(got?.text).toMatch(/Site playbooks:\n- \[m1\] Work inbox \(mail.google.com\): Open/);
    settings.memoryPaused = true;
    expect(await memory.begin("chat", { title: "Check", request: "any new mail?", tabUrl: "https://mail.google.com/" })).toBeUndefined();
  });
});

describe("Settings requests", () => {
  it("list, edit (with the secret check), delete and forget everything", async () => {
    await memory.tool("chat", "remember", { kind: "person", subject: "Paul Lee", text: "accountant" });
    await memory.tool("chat", "remember", { kind: "preference", subject: "Tone", text: "calm" });
    expect(isMemoryRequest({ type: "memory.list" })).toBe(true);
    expect(isMemoryRequest({ type: "vault.list" })).toBe(false);
    expect((await memory.handle({ type: "memory.list" })).entries).toHaveLength(2);
    expect(await memory.handle({ type: "memory.edit", id: "m1", subject: "Paul Lee", text: "accountant since 2020" })).toMatchObject({ entry: { text: "accountant since 2020" } });
    await expect(memory.handle({ type: "memory.edit", id: "m1", subject: "Paul Lee", text: "PIN: 4821" })).rejects.toThrow(/Not saved/);
    expect(await memory.handle({ type: "memory.delete", id: "m1" })).toEqual({ ok: true });
    expect(await memory.handle({ type: "memory.clear" })).toEqual({ removed: 1 });
  });
});

// Examples only: a task that works through many separate things, each known by an identifier.
describe("a task's records (remember and recall with a key)", () => {
  const QUEUE = { instructions: "Work through the queue at https://queue.example and answer each item", account: null };
  const begin = (id: string, extra: { request?: string; tabUrl?: string; tabTitle?: string } = {}) =>
    memory.begin(id, { task: QUEUE, title: QUEUE.instructions, request: extra.request ?? QUEUE.instructions, ...extra });

  beforeEach(async () => {
    await sessions.create(session("q1", { source: "local", title: QUEUE.instructions }));
    await sessions.create(session("q2", { source: "local", title: QUEUE.instructions }));
  });

  it("files facts under a key, and the next run gets them by key or when the page names it", async () => {
    await begin("q1");
    expect((await memory.tool("q1", "remember", { kind: "task", key: "Ada.Lee@example.com", text: "Prefers email; wrote about the March invoice." })).text).toBe(
      "Started this task's record [m1] for key Ada.Lee@example.com. The user sees it in the chat with Undo.",
    );
    expect((await memory.tool("q1", "remember", { kind: "person", key: "ada.lee@example.com", text: "Invoice resent." })).text).toMatch(/^Added a note to this task's record \[m1\]/);
    expect((await memory.tool("q1", "remember", { kind: "task", key: "ada.lee@example.com", text: "Invoice resent." })).text).toMatch(/^Already in this task's record/);
    expect(await store.list()).toEqual([expect.objectContaining({ kind: "task", key: "ada.lee@example.com", notes: [expect.objectContaining({ text: "Invoice resent." })] })]);

    // The next run (a new task row, same instructions): recall by key, however it is written.
    await begin("q2");
    expect((await memory.tool("q2", "recall", { key: "ADA.LEE@EXAMPLE.COM" })).text).toBe(
      "- [m1] key Ada.Lee@example.com: Prefers email; wrote about the March invoice. · 2026-09-26: Invoice resent.",
    );
    expect((await memory.tool("q2", "recall", { key: "someone@example.com" })).text).toBe("There is no record for key someone@example.com yet.");
    expect((await memory.tool("q2", "recall", { query: "march invoice" })).text).toMatch(/^- \[m1\] key Ada/);
    // Given at a turn's start when the user's tab names the key.
    const given = await begin("q2", { tabUrl: "https://queue.example/items/77", tabTitle: "Reply to ada.lee@example.com" });
    expect(given?.entries.map((e) => e.id)).toEqual(["m1"]);
    expect(given?.text).toContain(`${RECORDS_LABEL}:\n- [m1] key Ada.Lee@example.com`);
  });

  it("in a chat, a key files the fact in the user's records; the next chat gets it by key or when the page names it", async () => {
    await memory.begin("chat", { title: "hi", request: "hi" });
    expect((await memory.tool("chat", "remember", { kind: "task", key: "Ticket #4812", text: "Customer wants a refund." })).text).toMatch(/^Started the record \[m\w+\] for key Ticket #4812/);
    await memory.tool("chat", "remember", { kind: "record", key: "ticket 4812", text: "Refund approved." });
    const [record] = await store.list();
    expect(record).toMatchObject({ kind: "record", scope: "global", key: "ticket 4812", text: "Customer wants a refund.", notes: [{ text: "Refund approved." }] });
    expect(record!.taskKey).toBeUndefined();
    expect((await memory.tool("chat", "recall", { key: "TICKET 4812" })).text).toContain("Refund approved.");
    const next = await memory.begin("chat2", { title: "support", request: "Any news on ticket 4812?" });
    expect(next?.text).toContain(`${RECORDS_LABEL}:\n- [${record!.id}] key Ticket #4812: Customer wants a refund.`);
    const byTab = await memory.begin("chat3", { title: "support", request: "Reply to this one", tabUrl: "https://help.example/tickets/4812", tabTitle: "Ticket 4812 - Help desk" });
    expect(byTab?.entries.map((e) => e.id)).toContain(record!.id);
    // A repeating task finds the user's record too, when it has none of its own; its own comes first once it does.
    await begin("q1");
    expect((await memory.tool("q1", "recall", { key: "ticket 4812" })).text).toContain("Refund approved.");
    await memory.tool("q1", "remember", { kind: "task", key: "ticket 4812", text: "Task's own note." });
    expect((await memory.tool("q1", "recall", { key: "ticket 4812" })).text).toContain("Task's own note.");
    // Turning Records off keeps them out of chats.
    settings.memoryKindsOff = ["record"];
    expect((await memory.tool("chat", "recall", { key: "ticket 4812" })).text).toMatch(/no record/);
    expect((await memory.tool("chat", "remember", { kind: "record", key: "ticket 9", text: "x" })).text).toMatch(/turned off Records/);
    settings.memoryKindsOff = [];
  });

  it("a record's key must be an identifier, and a record belongs to no site", async () => {
    await begin("q1");
    expect((await memory.tool("q1", "remember", { kind: "task", key: "48213", text: "Refund sent.", domain: "x.com" })).text).toMatch(/belongs to no site/);
    expect((await memory.tool("q1", "remember", { kind: "record", text: "no key" })).text).toMatch(/give key/);
    expect((await memory.tool("q1", "remember", { kind: "task", key: "--", text: "Refund sent." })).text).toMatch(/no letters or digits/);
    expect((await memory.tool("q1", "remember", { kind: "person", text: "no subject" })).text).toMatch(/subject is required/);
    expect((await memory.tool("q1", "recall", {})).text).toMatch(/needs a query .* or a key/);
    settings.memoryKindsOff = ["task"];
    expect((await memory.tool("q1", "remember", { kind: "task", key: "48213", text: "Refund sent." })).text).toMatch(/turned off Task history/);
    expect(await store.list()).toEqual([]);
  });

  it("another task never sees these records", async () => {
    await begin("q1");
    await memory.tool("q1", "remember", { kind: "task", key: "48213", text: "Refund sent." });
    await memory.begin("run1", { task: DAILY, title: DAILY.instructions, request: "about 48213" });
    expect((await memory.tool("run1", "recall", { key: "48213" })).text).toMatch(/no record/);
    expect((await memory.tool("run1", "recall", { query: "48213 refund" })).text).toMatch(/Nothing in memory matches/);
    expect(await memory.begin("run1", { task: DAILY, title: DAILY.instructions, request: "about 48213" })).toBeUndefined();
  });

  it("Settings deletes one task's memory, and answers the account question", async () => {
    await begin("q1");
    await memory.tool("q1", "remember", { kind: "task", key: "48213", text: "Refund sent." });
    await memory.runNote("q1", "Answered 3 items.");
    await memory.tool("chat", "remember", { kind: "preference", subject: "Tone", text: "calm" });
    const taskKey = (await store.list())[0]!.taskKey!;
    expect(await memory.handle({ type: "memory.deleteTask", taskKey })).toEqual({ removed: 2 });
    expect((await store.list()).map((e) => e.subject)).toEqual(["Tone"]);
    await expect(memory.handle({ type: "memory.syncChoice", add: true })).rejects.toThrow(/does not sync/);
  });
});

describe("the account's semantic search", () => {
  const paulFact = { kind: "person" as const, subject: "Paul Lee", text: "Paul Lee files the yearly return.", scope: "global" as const };

  it("adds meaning to what a turn is given and to recall, with the turn's task and the clock's time zone", async () => {
    const asked: { query: string; taskKey: string | null }[] = [];
    const semantic = new MemoryService({
      store,
      sessions,
      settings: async () => settings,
      now: () => new Date(NOW),
      semantic: async (query, taskKey) => {
        asked.push({ query, taskKey });
        const [paul] = await store.list();
        return new Map([[paul!.id, 0.8]]);
      },
    });
    await store.put(paulFact, { kind: "user" });
    // "my tax guy" shares no word with the entry: only meaning finds it.
    expect((await semantic.begin("chat", { title: "tax", request: "Who is my tax guy?" }))?.text).toContain("Paul Lee");
    expect((await semantic.tool("chat", "recall", { query: "tax guy" })).text).toContain("Paul Lee");
    expect(asked).toEqual([
      { query: "Who is my tax guy?", taskKey: null },
      { query: "tax guy", taskKey: null },
    ]);
    await semantic.begin("run1", { task: DAILY, title: DAILY.instructions, request: DAILY.instructions });
    expect(asked.at(-1)!.taskKey).toBe(memoryTaskKey(DAILY.instructions, DAILY.account));
  });

  it("the next turn of an open session waits at most MEMORY_SEARCH_FOLLOW_UP_TIMEOUT_MS for the search (it has earlier memory and recall); a first turn waits for it", async () => {
    const slowMs = MEMORY_SEARCH_FOLLOW_UP_TIMEOUT_MS + 250;
    const slow = new MemoryService({
      store,
      sessions,
      settings: async () => settings,
      semantic: async () => {
        await new Promise((r) => setTimeout(r, slowMs));
        const [paul] = await store.list();
        return new Map([[paul!.id, 0.8]]);
      },
    });
    await store.put(paulFact, { kind: "user" });
    const first = await slow.begin("chat", { title: "tax", request: "Who is my tax guy?" });
    expect(first?.text).toContain("Paul Lee");
    expect(first?.search?.ms).toBeGreaterThanOrEqual(slowMs - 20);
    expect(first?.search?.late).toBeUndefined();
    // A later turn of another open session: the search is too slow, so it goes on with words, entities and time.
    const started = Date.now();
    expect(await slow.begin("chat2", { title: "tax", request: "Who is my tax guy?", continued: true })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(slowMs);
    // A fast search still counts on a follow-up.
    const fast = new MemoryService({ store, sessions, settings: async () => settings, semantic: async () => new Map([[(await store.list())[0]!.id, 0.8]]) });
    const follow = await fast.begin("chat3", { title: "tax", request: "Who is my tax guy?", continued: true });
    expect(follow?.text).toContain("Paul Lee");
    expect(follow?.search?.late).toBeUndefined();
  });

  it("a failed search never stops a turn: words, entities and time go on alone", async () => {
    const failing = new MemoryService({ store, sessions, settings: async () => settings, semantic: async () => Promise.reject(new Error("offline")) });
    await store.put(paulFact, { kind: "user" });
    expect(await failing.begin("chat", { title: "tax", request: "Who is my tax guy?" })).toBeUndefined();
    expect((await failing.begin("chat", { title: "Paul", request: "Email Paul Lee" }))?.text).toContain("Paul Lee");
  });
});
