import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_TITLE_MAX_TOKENS, CHAT_TITLE_SYSTEM_PROMPT, RETITLE_AT_TURN, type SessionInfo } from "@noa/shared";
import { ChatTitler, MAX_TITLE_BACKFILL, titleDue } from "../src/engine/chat-titles.js";
import { SessionStore } from "../src/engine/sessions.js";
import type { Summarize } from "../src/memory/summarizers.js";
import { MemoryKvDb } from "./memory-kv.js";

const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:02:00.000Z";

let sessions: SessionStore;
let calls: Parameters<Summarize>[0][];
let answers: (string | Error)[];
let busy: boolean;
let logs: string[];
let titler: ChatTitler;
let withWriter: SessionInfo["brain"][];

function chat(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: "Yo sup how you doin", instructions: "yo sup how you doin. can you check my chrome web store emails", brain: "claude-api", jev: false, startedAt: T0, endedAt: T1, outcome: "done", ...extra };
}

async function seed(s: SessionInfo): Promise<void> {
  await sessions.create(s);
  sessions.append(s.sessionId, { type: "assistant_text", text: "Opening the Chrome Web Store developer inbox." });
  sessions.append(s.sessionId, { type: "task_end", outcome: "done", summary: "2 new emails from the review team" });
  await sessions.flush();
}

beforeEach(() => {
  sessions = new SessionStore(new MemoryKvDb());
  calls = [];
  answers = [];
  busy = false;
  logs = [];
  withWriter = ["claude-api", "noa", "claude-code"];
  const summarize: Summarize = async (req) => {
    calls.push(req);
    const next = answers.shift() ?? "Check Chrome Web Store emails";
    if (next instanceof Error) throw next;
    return { text: next };
  };
  titler = new ChatTitler({ sessions, summarizer: (brain) => (withWriter.includes(brain) ? summarize : null), busy: () => busy, log: (m) => logs.push(m) });
});

describe("titleDue", () => {
  it("a chat between turns still titled with its request", () => {
    expect(titleDue(chat("a"))).toBe(true);
    expect(titleDue(chat("a", { endedAt: undefined }))).toBe(false);
    expect(titleDue(chat("a", { source: "local", taskId: "t1" }))).toBe(false);
  });

  it("a TODO run: once, when it keeps its instructions and series (a later turn reads them, not the title)", () => {
    const run = (extra: Partial<SessionInfo> = {}) => chat("r", { source: "local", taskId: "t1", seriesId: "t1", instructions: "Post one new original post on X as @mecharoyalecom", ...extra });
    expect(titleDue(run())).toBe(true);
    expect(titleDue(run({ source: "cloud" }))).toBe(true);
    expect(titleDue(run({ instructions: undefined }))).toBe(false);
    expect(titleDue(run({ seriesId: undefined }))).toBe(false);
    expect(titleDue(run({ titleBy: "model", titledTurn: 1, turns: RETITLE_AT_TURN }))).toBe(false);
    expect(titleDue(run({ titleBy: "user" }))).toBe(false);
  });

  it("the model's title once more after turn RETITLE_AT_TURN, never a user's", () => {
    expect(titleDue(chat("a", { titleBy: "model", titledTurn: 1, turns: 2 }))).toBe(false);
    expect(titleDue(chat("a", { titleBy: "model", titledTurn: 1, turns: RETITLE_AT_TURN }))).toBe(true);
    expect(titleDue(chat("a", { titleBy: "model", titledTurn: RETITLE_AT_TURN, turns: RETITLE_AT_TURN + 2 }))).toBe(false);
    expect(titleDue(chat("a", { titleBy: "user", turns: 1 }))).toBe(false);
    expect(titleDue(chat("a", { titleBy: "user", turns: RETITLE_AT_TURN }))).toBe(false);
  });
});

describe("ChatTitler", () => {
  it("names a TODO series once: a run of a series that already has a name is not titled", async () => {
    const run = (id: string) => chat(id, { source: "local", taskId: `t-${id}`, seriesId: "daily", instructions: "Post one new original post on X as @mecharoyalecom" });
    const named = new Set<string>();
    titler = new ChatTitler({
      sessions,
      summarizer: () => async (req) => (calls.push(req), { text: "@mecharoyalecom daily X post" }),
      seriesTitled: async (id) => named.has(id),
      log: (m) => logs.push(m),
    });
    await seed(run("r1"));
    titler.ended("r1");
    await titler.run();
    expect(await sessions.get("r1")).toMatchObject({ title: "@mecharoyalecom daily X post", titleBy: "model" });
    named.add("daily");
    await seed(run("r2"));
    titler.ended("r2");
    await titler.run();
    expect((await sessions.get("r2"))?.titleBy).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("names a chat from its conversation after its turn, with the small model's short answer", async () => {
    await seed(chat("s1"));
    titler.ended("s1");
    await titler.run();
    const s = await sessions.get("s1");
    expect(s).toMatchObject({ title: "Check Chrome Web Store emails", titleBy: "model", titledTurn: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(CHAT_TITLE_SYSTEM_PROMPT);
    expect(calls[0]!.maxTokens).toBe(CHAT_TITLE_MAX_TOKENS);
    expect(calls[0]!.sessionId).toBe("s1");
    // The model reads the request itself (a spoken one included), not only the small talk.
    expect(calls[0]!.prompt).toContain("check my chrome web store emails");
  });

  it("writes the title again after turn 3, then never", async () => {
    await seed(chat("s1", { titleBy: "model", titledTurn: 1, title: "Check emails", turns: 2 }));
    titler.ended("s1");
    await titler.run();
    expect(calls).toHaveLength(0);
    await sessions.update("s1", { turns: 3 });
    answers.push("Reply to the Web Store reviewers");
    titler.ended("s1");
    await titler.run();
    expect(await sessions.get("s1")).toMatchObject({ title: "Reply to the Web Store reviewers", titledTurn: 3 });
    await sessions.update("s1", { turns: 4 });
    titler.ended("s1");
    await titler.run();
    expect(calls).toHaveLength(1);
  });

  it("never replaces a title the user gave, even one given while the model wrote", async () => {
    await seed(chat("s1", { title: "My Web Store stuff", titleBy: "user" }));
    titler.ended("s1");
    await titler.run();
    expect(calls).toHaveLength(0);

    await seed(chat("s2"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    titler = new ChatTitler({
      sessions,
      summarizer: () => async () => (await gate, { text: "Check Chrome Web Store emails" }),
      log: (m) => logs.push(m),
    });
    titler.ended("s2");
    const done = titler.run();
    await sessions.retitle("s2", "Renamed by me", "user");
    release();
    await done;
    expect(await sessions.get("s2")).toMatchObject({ title: "Renamed by me", titleBy: "user" });
    expect(logs.at(-1)).toMatch(/renamed it meanwhile/);
  });

  it("keeps the cleaned request when the model fails or answers with no usable title", async () => {
    await seed(chat("s1", { title: "Check my chrome web store emails" }));
    answers.push(new Error("Anthropic 529 overloaded"));
    titler.ended("s1");
    await titler.run();
    expect(await sessions.get("s1")).toMatchObject({ title: "Check my chrome web store emails" });
    expect((await sessions.get("s1"))!.titleBy).toBeUndefined();
    expect(logs.at(-1)).toMatch(/not written: Anthropic 529/);
    answers.push("Use password is hunter22");
    titler.ended("s1");
    await titler.run();
    expect((await sessions.get("s1"))!.title).toBe("Check my chrome web store emails");
  });

  it("brains without a writer keep the cleaned request", async () => {
    await seed(chat("s1", { brain: "scripted" }));
    titler.ended("s1");
    await titler.run();
    expect(calls).toHaveLength(0);
  });

  it("titles past chats a list shows: bounded, once each, after turn titles, never during a run", async () => {
    for (let i = 0; i < MAX_TITLE_BACKFILL + 5; i++) await seed(chat(`p${i}`));
    await seed(chat("done", { titleBy: "model", titledTurn: 1 }));
    await seed(chat("run", { source: "local", taskId: "t1" }));
    const all = await sessions.list(200);
    busy = true;
    titler.shown(all);
    await titler.run();
    expect(calls).toHaveLength(0);
    // A turn's title goes first even while runs go on; the past ones wait for them to end.
    await seed(chat("turn"));
    titler.ended("turn");
    await titler.run();
    expect(calls.map((c) => c.sessionId)).toEqual(["turn"]);
    busy = false;
    titler.shown(all);
    await titler.run();
    expect(calls).toHaveLength(1 + MAX_TITLE_BACKFILL);
    expect(calls.some((c) => c.sessionId === "done" || c.sessionId === "run")).toBe(false);
    // Shown again: nothing more this worker start.
    titler.shown(await sessions.list(200));
    await titler.run();
    expect(calls).toHaveLength(1 + MAX_TITLE_BACKFILL);
  });
});

describe("SessionStore.retitle", () => {
  it("sets the title and who wrote it, pushes it, and a new turn keeps it", async () => {
    await seed(chat("s1"));
    const pushed: SessionInfo[] = [];
    sessions.subscribe({ onSession: (s) => pushed.push(s) });
    await sessions.retitle("s1", "Check Chrome Web Store emails", "model", 1);
    expect(pushed.at(-1)).toMatchObject({ title: "Check Chrome Web Store emails", titleBy: "model", titledTurn: 1 });
    const reopened = await sessions.reopen("s1", { turns: 2 });
    expect(reopened).toMatchObject({ title: "Check Chrome Web Store emails", titleBy: "model", titledTurn: 1 });
    // A rename drops the model's turn.
    const renamed = await sessions.retitle("s1", "Mine", "user");
    expect(renamed).toMatchObject({ title: "Mine", titleBy: "user" });
    expect(renamed!.titledTurn).toBeUndefined();
    expect(await sessions.retitle("s1", "Model again", "model", 3)).toBeNull();
    expect(await sessions.retitle("nope", "x", "user")).toBeNull();
  });
});
