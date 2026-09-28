/** search_history: past chats and runs from the History (SessionStore), by words, time words and site; one transcript. */
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_HISTORY_RESULTS, MAX_HISTORY_TRANSCRIPT_CHARS, mcpToolName, type AgentEvent, type ExtensionSettings, type MemoryKind, type SessionInfo } from "@noa/shared";
import { SessionStore } from "../../src/engine/sessions.js";
import { MAX_HISTORY_RESULT_CHARS, searchHistory } from "../../src/memory/history.js";
import { MemoryService } from "../../src/memory/service.js";
import { MemoryStore } from "../../src/memory/store.js";
import { MemoryKvDb } from "../memory-kv.js";
import { memoryStorage } from "./fakes.js";

// Sunday 27 September 2026, 10:00 in the user's zone (UTC-4): "yesterday" is Saturday the 26th, local time.
const OFFSET = -240;
const NOW = new Date("2026-09-27T14:00:00.000Z");
const YESTERDAY = "2026-09-26T19:30:00.000Z"; // 15:30 local
const LAST_WEEK = "2026-09-18T13:00:00.000Z";
const EMAILS_ANSWER =
  "You have 3 unread emails: 1. Stripe: invoice #4411 for $120 is due Friday. 2. Paul Lee: lunch moved to Thursday. 3. GitHub: a security alert on runhq/api.";

let clock: number;
let sessions: SessionStore;
let deps: Parameters<typeof searchHistory>[2];

beforeEach(async () => {
  clock = Date.parse(YESTERDAY);
  sessions = new SessionStore(new MemoryKvDb(), { now: () => new Date(clock) });
  deps = { sessions, now: NOW, offsetMinutes: OFFSET };
});

/** A past conversation: created at `at`, its events, ended a few minutes later. */
async function past(id: string, at: string, events: AgentEvent[], extra: Partial<SessionInfo> = {}): Promise<void> {
  clock = Date.parse(at);
  const first = events.find((e) => e.type === "user_message");
  const title = extra.title ?? (first?.type === "user_message" ? first.text : id);
  await sessions.create({ sessionId: id, source: "adhoc", title, instructions: title, brain: "claude-code", jev: false, startedAt: at, ...extra });
  for (const e of events) sessions.append(id, e);
  clock += 5 * 60_000;
  await sessions.update(id, { endedAt: new Date(clock).toISOString(), outcome: "done" });
  await sessions.flush();
}

async function seed(): Promise<void> {
  await past("s-emails", YESTERDAY, [
    { type: "user_message", text: "Check my unread emails and summarize them" },
    { type: "tool_call", id: "t1", name: mcpToolName("navigate"), args: { url: "https://mail.google.com/mail/u/0/#inbox" } },
    { type: "tool_result", id: "t1", name: mcpToolName("navigate"), text: "ok" },
    { type: "assistant_text", text: EMAILS_ANSWER },
    { type: "task_end", outcome: "done", summary: "Summarized 3 unread emails" },
  ]);
  await past("s-x", YESTERDAY.replace("19:30", "21:00"), [
    { type: "user_message", text: "Post a tip about Mecha Royale on X" },
    { type: "tool_call", id: "t1", name: "navigate", args: { url: "https://x.com/home" } },
    { type: "assistant_text", text: "Posted the tip." },
  ]);
  await past("s-old-emails", LAST_WEEK, [
    { type: "user_message", text: "Any new emails from the bank?" },
    { type: "tool_call", id: "t1", name: "navigate", args: { url: "https://mail.google.com/mail/u/0/#search/bank" } },
    { type: "assistant_text", text: "One email from Chase about your statement." },
  ]);
}

const search = (args: unknown, asking = "s-now") => searchHistory(asking, args, deps);

describe("search_history: a search", () => {
  it("'what emails did you tell me about yesterday': yesterday's chat about emails, with its answer", async () => {
    await seed();
    const { text, isError } = await search({ query: "which emails did you tell me about yesterday" });
    expect(isError).toBeUndefined();
    expect(text).toMatch(/^1 past conversation\(s\) for "which emails did you tell me about yesterday" \(2026-09-26\), best match first\./);
    expect(text).toContain('[s-emails] 2026-09-26 15:30 chat "Check my unread emails and summarize them" (done)');
    expect(text).toContain("First request: Check my unread emails and summarize them");
    expect(text).toContain("Result: You have 3 unread emails: 1. Stripe: invoice #4411");
    // Last week's email chat is outside "yesterday"; yesterday's X chat has no email words.
    expect(text).not.toContain("s-old-emails");
    expect(text).not.toContain("s-x");
    expect(text).toMatch(/Give search_history a session_id/);
  });

  it("without a time: every match, best first, then newest", async () => {
    await seed();
    const { text } = await search({ query: "emails" });
    expect(text.indexOf("[s-emails]")).toBeGreaterThan(-1);
    expect(text.indexOf("[s-emails]")).toBeLessThan(text.indexOf("[s-old-emails]"));
    expect(text).not.toContain("[s-x]");
  });

  it("time words alone list everything from then, newest first", async () => {
    await seed();
    const { text } = await search({ query: "what did we do yesterday" });
    expect(text).toMatch(/2 past conversation\(s\) for .* newest first\./);
    expect(text.indexOf("[s-x]")).toBeLessThan(text.indexOf("[s-emails]"));
    expect(text).not.toContain("s-old-emails");
  });

  it("a time whose chats lack the words: says so and lists what happened then", async () => {
    await seed();
    const { text } = await search({ query: "invoices from Acme last week" });
    expect(text).toContain("None has those words; here is everything from then.");
    expect(text).toContain("[s-old-emails]");
  });

  it("by site (a host, subdomains included), with or without words", async () => {
    await seed();
    const onMail = (await search({ site: "google.com" })).text;
    expect(onMail).toContain("[s-emails]");
    expect(onMail).toContain("[s-old-emails]");
    expect(onMail).not.toContain("[s-x]");
    expect((await search({ query: "bank", site: "https://mail.google.com/" })).text).toMatch(/^1 past conversation\(s\) for "bank" on mail\.google\.com/);
    expect((await search({ site: "gmail" })).isError).toBe(true);
  });

  it("never lists the conversation asking, nor a chat whose memory the user turned off", async () => {
    await seed();
    await past("s-private", YESTERDAY, [{ type: "user_message", text: "Read my private emails" }], { memoryOff: true });
    const { text } = await search({ query: "emails yesterday" }, "s-emails");
    expect(text).not.toContain("[s-emails]");
    expect(text).not.toContain("[s-private]");
    // What else happened then is listed instead, said so.
    expect(text).toMatch(/^1 past conversation\(s\) for "emails yesterday" \(2026-09-26\), newest first\. None has those words/);
    expect(text).toContain("[s-x]");
  });

  it("keeps each result short and at most MAX_HISTORY_RESULTS, and redacts secrets", async () => {
    for (let i = 0; i < MAX_HISTORY_RESULTS + 3; i++) {
      await past(`s${i}`, new Date(Date.parse(YESTERDAY) - i * 60_000).toISOString(), [
        { type: "user_message", text: `Email report ${i}` },
        { type: "assistant_text", text: `Report ${i}: api key sk-ant-api03-${"x".repeat(40)} ${"word ".repeat(400)}` },
      ]);
    }
    const { text } = await search({ query: "email report" });
    expect(text.match(/^- \[s\d+\]/gm)).toHaveLength(MAX_HISTORY_RESULTS);
    expect(text).not.toContain("sk-ant-api03");
    const result = text.split("\n").find((l) => l.startsWith("  Result:"))!;
    expect(result.length).toBeLessThanOrEqual("  Result: ".length + MAX_HISTORY_RESULT_CHARS);
  });

  it("needs a query, a site or a session_id", async () => {
    expect(await search({})).toEqual({ text: expect.stringMatching(/needs a query/), isError: true });
    expect((await search({ query: "" })).isError).toBe(true);
  });
});

describe("search_history: one conversation (session_id)", () => {
  it("its heading and transcript: the request, what was done and said, redacted and shortened", async () => {
    await seed();
    await past("s-long", LAST_WEEK, [
      { type: "user_message", text: "Log in to the bank" },
      { type: "tool_call", id: "t1", name: "type", args: { index: 3, text: "password: hunter22" } },
      ...Array.from({ length: 200 }, (_, i): AgentEvent => ({ type: "assistant_text", text: `Step ${i}: ${"reading the statement ".repeat(4)}` })),
    ]);
    const { text } = await search({ session_id: "[s-emails]" });
    expect(text.split("\n")[0]).toBe('[s-emails] 2026-09-26 15:30 chat "Check my unread emails and summarize them" (done)');
    expect(text).toContain("User: Check my unread emails and summarize them");
    expect(text).toContain("Did: navigate");
    expect(text).toContain(`Agent: ${EMAILS_ANSWER}`);

    const long = (await search({ session_id: "s-long" })).text;
    expect(long.length).toBeLessThan(MAX_HISTORY_TRANSCRIPT_CHARS + 200);
    expect(long).toContain("User: Log in to the bank");
    expect(long).toContain("Step 199");
    expect(long).toMatch(/earlier line\(s\) left out/);
    expect(long).not.toContain("hunter22");
  });

  it("an unknown one, the asking one, or one with memory off: not in History", async () => {
    await seed();
    await past("s-private", YESTERDAY, [{ type: "user_message", text: "Read my private emails" }], { memoryOff: true });
    expect((await search({ session_id: "nope" })).text).toBe("No conversation nope in History.");
    expect((await search({ session_id: "s-private" })).text).toBe("No conversation s-private in History.");
    expect((await search({ session_id: "s-emails" }, "s-emails")).text).toMatch(/that is this conversation/);
  });
});

describe("search_history through the memory service (every brain's memory tool)", () => {
  let settings: Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">;
  let memory: MemoryService;

  beforeEach(async () => {
    settings = { memoryPaused: false, memoryKindsOff: [] as MemoryKind[] };
    memory = new MemoryService({ store: new MemoryStore({ storage: memoryStorage() }), sessions, settings: async () => settings, now: () => NOW });
    await seed();
    await past("s-now", NOW.toISOString(), [{ type: "user_message", text: "Which emails did you tell me about yesterday?" }]);
  });

  it("answers from History in the user's time zone", async () => {
    // The service reads the zone from the clock; this test's machine may be in any zone, so only the match is checked.
    const r = await memory.tool("s-now", "search_history", { query: "emails yesterday" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("[s-emails]");
    expect(r.text).not.toContain("[s-now]");
  });

  it("is refused while memory is paused, or off in the asking chat", async () => {
    settings.memoryPaused = true;
    expect(await memory.tool("s-now", "search_history", { query: "emails" })).toEqual({ text: expect.stringMatching(/paused.*nothing was searched/), isError: true });
    settings.memoryPaused = false;
    await sessions.update("s-now", { memoryOff: true });
    expect(await memory.tool("s-now", "search_history", { query: "emails" })).toEqual({ text: expect.stringMatching(/off in this chat.*nothing was searched/), isError: true });
  });
});
