import { describe, expect, it } from "vitest";
import {
  EARLIER_RUNS_SUBJECT,
  MAX_INJECTED_TASK_NOTES,
  MAX_INJECTED_TASK_RUNS,
  MAX_MEMORY_NOTE_CHARS,
  MEMORY_RECORD_TOKEN_BUDGET,
  MEMORY_TASK_HISTORY_TOKEN_BUDGET,
  MEMORY_TOKEN_BUDGET,
  memoryRecordKey,
  TASK_PROFILE_SUBJECT,
  type MemoryEntry,
} from "@noa/shared";
import { hostsIn, MEMORY_HEADER, recallMemory, recordFor, recordsNamedIn, RECORDS_LABEL, selectMemory, tokensOf } from "../../src/memory/select.js";

let n = 0;
function entry(e: Partial<MemoryEntry> & Pick<MemoryEntry, "kind" | "subject" | "text">): MemoryEntry {
  n++;
  return {
    id: `m${n}`,
    scope: e.domain ? "domain" : e.taskKey ? "task" : "global",
    source: { kind: "chat" },
    learnedAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, n)).toISOString(),
    ...e,
  };
}

const workEmail = entry({ kind: "account", subject: "Work email", text: "admin@runhq.io is the work Gmail, Google account /u/2" });
const gameX = entry({ kind: "account", subject: "@mecharoyalecom", text: "The X account for the game Mecha Royale" });
const paul = entry({ kind: "person", subject: "Paul Lee", text: "The user's accountant" });
const tone = entry({ kind: "preference", subject: "Tone", text: "Friendly, short, no emoji" });
const gmailBook = entry({ kind: "playbook", subject: "Work inbox", text: "Open https://mail.google.com/mail/u/2/ directly", domain: "mail.google.com" });
const xBook = entry({ kind: "playbook", subject: "Compose", text: "The Post button is in the left rail", domain: "x.com" });
const linkedIn = entry({ kind: "playbook", subject: "Messaging", text: "Needs sign-in each morning", domain: "linkedin.com" });
const all = [workEmail, gameX, paul, tone, gmailBook, xBook, linkedIn];

describe("hostsIn", () => {
  it("finds the sites a request names, not mailboxes", () => {
    expect(hostsIn("Post on x.com and check https://www.LinkedIn.com/feed, then mail admin@runhq.io")).toEqual(["linkedin.com", "x.com"]);
    expect(hostsIn("http://localhost:4777/w/gmail/u/0/")).toEqual(["localhost"]);
  });
});

describe("selectMemory", () => {
  it("leaves out the episode of a conversation the user stopped (where it looked is no lead), not a finished one", () => {
    const stopped = entry({ kind: "episode", subject: "Send the Lindgren quote", text: "User asked to send the Lindgren quote. Agent started searching Drive but the user stopped the task.", at: "2026-09-20T10:00:00.000Z", stopped: true });
    const done = entry({ kind: "episode", subject: "Found the Lindgren quote", text: "User asked for the Lindgren quote. Agent found it in Drive. Done.", at: "2026-09-21T10:00:00.000Z" });
    const s = selectMemory([stopped, done], { hosts: [], text: "send the Lindgren quote again" });
    expect(s.entries).toEqual([done]);
    // recall still finds it ("what did we do about the Lindgren quote").
    expect(recallMemory([stopped, done], "Lindgren quote", { now: new Date("2026-09-25T00:00:00.000Z") }).map((e) => e.id)).toContain(stopped.id);
  });

  it("gives the playbook of the user's tab and of sites the request names, not other sites'", () => {
    const s = selectMemory(all, { hosts: ["mail.google.com"], text: "reply to the newest email" });
    expect(s.entries).toContain(gmailBook);
    expect(s.entries).not.toContain(xBook);
    expect(s.entries).not.toContain(linkedIn);
  });

  it("gives account and people facts that share words with the request", () => {
    const s = selectMemory(all, { hosts: [], text: "Email Paul Lee the invoice from my work email" });
    expect(s.entries).toEqual(expect.arrayContaining([paul, workEmail]));
    expect(s.entries).not.toContain(gameX);
  });

  it("gives a site's playbook when the request names it by word, but not for a word in its text", () => {
    expect(selectMemory(all, { hosts: [], text: "open my work inbox" }).entries).toContain(gmailBook);
    expect(selectMemory(all, { hosts: [], text: "Post a tip on LinkedIn" }).entries).not.toContain(xBook);
  });

  it("gives a preference only when the request is about it, or when the user pinned it", () => {
    expect(selectMemory(all, { hosts: [], text: "anything" }).entries).toEqual([]);
    expect(selectMemory(all, { hosts: [], text: "What tone should the reply have?" }).entries).toEqual([tone]);
    const pinnedTone = { ...tone, pinned: true as const };
    expect(selectMemory([...all.filter((e) => e !== tone), pinnedTone], { hosts: [], text: "anything" }).entries).toEqual([pinnedTone]);
  });

  it("puts this task's newest runs first (the newest in full, then one line each), and never another task's", () => {
    const notes = Array.from({ length: MAX_INJECTED_TASK_NOTES + 2 }, (_, i) => entry({ kind: "task", subject: "Run note", text: `Posted topic ${i}`, taskKey: "tA", output: `Tip ${i}: short lists get done` }));
    const other = entry({ kind: "task", subject: "Run note", text: "Other task", taskKey: "tB" });
    const s = selectMemory([...all, ...notes, other], { taskKey: "tA", hosts: ["x.com"], text: "Post a daily tip" });
    const given = s.entries.filter((e) => e.kind === "task");
    expect(given).toHaveLength(MAX_INJECTED_TASK_NOTES + 2);
    expect(given[0]!.text).toBe(`Posted topic ${MAX_INJECTED_TASK_NOTES + 1}`);
    expect(s.entries).not.toContain(other);
    expect(s.text.split("\n")[0]).toBe(MEMORY_HEADER);
    expect(s.text).toMatch(/^Task history:\n- \[m\d+\] \d{4}-\d\d-\d\d Run note: Posted topic 3 · output: "Tip 3: short lists get done"/m);
    // Past the newest MAX_INJECTED_TASK_NOTES: the date and the start of the output.
    expect(s.text).toMatch(/^- \d{4}-\d\d-\d\d "Tip 0: short lists get done"$/m);
    expect(s.brief?.size).toBe(2);
    // Without the task (a chat), no run notes at all.
    expect(selectMemory([...notes], { hosts: [], text: "Post a daily tip" }).entries).toEqual([]);
  });

  it("gives the task's profile first at every run, then its runs, within the task history's own budget (measured)", () => {
    const long = (i: number) => `Run ${i}: ${"posted a grounded update about the product roadmap and what shipped this week ".repeat(4)}`.slice(0, MAX_MEMORY_NOTE_CHARS);
    const runs = Array.from({ length: 40 }, (_, i) =>
      entry({ kind: "task", subject: "Run note", text: long(i), taskKey: "tA", output: `Post ${i}: ${"We shipped scheduled tasks that remember every earlier run, so nothing is posted twice. ".repeat(3)}`.slice(0, 280) }),
    );
    const profile = entry({ kind: "task", subject: TASK_PROFILE_SUBJECT, text: "@acme is the account of Acme, a browser agent. Voice: plain, confident. Never talk about price.", taskKey: "tA", learnedAt: "2020-01-01T00:00:00.000Z" });
    const summary = entry({ kind: "task", subject: EARLIER_RUNS_SUBJECT, text: "57 earlier runs, 2026-06-01 to 2026-07-20. Frequent words (runs): ship (40), roadmap (22)", taskKey: "tA" });
    const s = selectMemory([...all, profile, summary, ...runs], { taskKey: "tA", hosts: ["x.com"], text: "Post a daily update on X" });
    const history = s.entries.filter((e) => e.kind === "task");
    expect(history[0]).toBe(profile);
    expect(history).toContain(summary);
    const runsGiven = history.filter((e) => e.subject === "Run note");
    expect(runsGiven.length).toBeLessThanOrEqual(MAX_INJECTED_TASK_RUNS);
    const historyText = s.text.slice(s.text.indexOf("Task history:"), s.text.indexOf("\n", s.text.indexOf("older runs are kept")) + 1 || undefined);
    // What it costs, measured: within its own budget, apart from the rest of memory's.
    const cost = tokensOf(historyText);
    expect(cost).toBeLessThanOrEqual(MEMORY_TASK_HISTORY_TOKEN_BUDGET);
    expect({ runsGiven: runsGiven.length, cost }).toEqual({ runsGiven: 20, cost: expect.any(Number) });
    expect(s.text).toMatch(/- \(20 older runs are kept: check_similar compares a draft with all of them; recall finds them\)/);
    // The rest of memory still has its own budget (the X playbook is given too).
    expect(s.entries).toContain(xBook);
  });

  it("leaves out kinds the user turned off", () => {
    const s = selectMemory(all, { hosts: ["mail.google.com"], text: "Email Paul Lee" }, { kindsOff: ["person", "playbook"] });
    expect(s.entries).not.toContain(paul);
    expect(s.entries).not.toContain(gmailBook);
  });

  it("stays within the token budget, most relevant first", () => {
    const many = Array.from({ length: 200 }, (_, i) => entry({ kind: "preference", subject: `Rule ${i}`, text: "Always write in plain words and keep every message short and polite." }));
    const s = selectMemory([...many, gmailBook], { hosts: ["mail.google.com"], text: "check mail" });
    expect(s.tokens).toBeLessThanOrEqual(MEMORY_TOKEN_BUDGET);
    expect(tokensOf(s.text)).toBe(s.tokens);
    expect(s.entries[0]).toBe(gmailBook);
    expect(s.entries.length).toBeLessThan(many.length);
    expect(selectMemory([gmailBook, tone], { hosts: ["mail.google.com"], text: "x" }, { budget: tokensOf(MEMORY_HEADER) + 30 }).entries).toEqual([gmailBook]);
  });

  it("is empty when nothing applies", () => {
    expect(selectMemory([xBook], { hosts: [], text: "hello" })).toEqual({ entries: [], text: "", tokens: 0 });
  });

  it("is cheap: a full store of 500 entries is picked from in a few milliseconds", () => {
    const store = Array.from({ length: 500 }, (_, i) =>
      entry({ kind: (["account", "person", "playbook", "preference"] as const)[i % 4]!, subject: `Subject ${i}`, text: `Fact number ${i} about site${i % 50}.example.com and person ${i}`, ...(i % 4 === 2 ? { domain: `site${i % 50}.example.com` } : {}) }),
    );
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) selectMemory(store, { hosts: ["site7.example.com"], text: "Tell person 42 about Subject 99 on site7.example.com" });
    const perCall = (performance.now() - t0) / 20;
    expect(perCall).toBeLessThan(25);
  });
});

describe("recallMemory", () => {
  it("finds entries by words or by site, whatever task or site they belong to", () => {
    const note = entry({ kind: "task", subject: "Run note", text: "Posted about the Mecha Royale beta", taskKey: "tA" });
    expect(recallMemory([...all, note], "mecha royale")).toEqual(expect.arrayContaining([gameX, note]));
    expect(recallMemory(all, "linkedin.com")).toEqual([linkedIn]);
    expect(recallMemory(all, "unrelated words")).toEqual([]);
  });
});

// A task's records, by key. Examples only: three differently shaped identifiers (an address, a number, a name).
const record = (key: string, text: string, taskKey = "tA", notes?: { at: string; text: string }[]) =>
  entry({ kind: "task", subject: key, text, taskKey, key: memoryRecordKey(key), ...(notes ? { notes } : {}) });
const ada = record("ada.lee@example.com", "Prefers email; writes about the March invoice.");
const order = record("#48213", "Refund asked on Sep 20.", "tA", [{ at: "2026-09-22T10:00:00.000Z", text: "Refund sent." }]);
const unit = record("Unit 7-B", "Heating fixed twice this year.");
const otherTask = record("ada.lee@example.com", "Another task's record.", "tB");
const records = [ada, order, unit, otherTask];

describe("records named in a turn", () => {
  it("finds a record whose key the text names, whole, case aside, in the order named", () => {
    expect(recordsNamedIn(records.slice(0, 3), "Answer ADA.LEE@example.com, then check order #48213 and unit 7-b")).toEqual([ada, order, unit]);
    expect(recordsNamedIn(records.slice(0, 3), "https://shop.example/orders/48213?tab=2")).toEqual([order]);
    // Not part of a longer identifier, nor a key's words out of order.
    expect(recordsNamedIn(records.slice(0, 3), "order 148213, lee@example.com, 7-B unit")).toEqual([]);
  });

  it("gives this task's named records first, within their own budget, never another task's", () => {
    const s = selectMemory([...all, ...records], { taskKey: "tA", hosts: [], text: "Work through the queue", pageText: "https://shop.example/orders/48213\nOrder #48213 - Shop" });
    expect(s.entries[0]).toBe(order);
    expect(s.entries).not.toContain(ada);
    expect(s.entries).not.toContain(otherTask);
    expect(s.text).toContain(`${RECORDS_LABEL}:\n- [${order.id}] key #48213: Refund asked on Sep 20. · 2026-09-22: Refund sent.`);
    // In a chat (no task) no record is given.
    expect(selectMemory(records, { hosts: [], text: "about #48213" }).entries).toEqual([]);
  });

  it("records spend at most MEMORY_RECORD_TOKEN_BUDGET, leaving the rest for other memory", () => {
    const big = Array.from({ length: 12 }, (_, i) => record(`item-${i}`, `A long summary ${"x".repeat(380)}`));
    const pinnedTone = { ...tone, pinned: true as const };
    const s = selectMemory([...big, pinnedTone], { taskKey: "tA", hosts: [], text: big.map((_, i) => `item-${i}`).join(" ") });
    // Each of these records costs about 105 tokens: two fit in the records' budget, a third would not.
    const given = s.entries.filter((e) => e.key !== undefined);
    expect(given.map((e) => e.subject)).toEqual(["item-0", "item-1"]);
    expect(tokensOf(RECORDS_LABEL) + given.reduce((n, e) => n + tokensOf(`- ${e.id} key ${e.subject}: ${e.text}`) + 1, 0)).toBeLessThanOrEqual(MEMORY_RECORD_TOKEN_BUDGET);
    expect(s.entries).toContain(pinnedTone);
    expect(s.tokens).toBeLessThanOrEqual(MEMORY_TOKEN_BUDGET);
  });
});

describe("recall of records", () => {
  it("by key: this task's record, whatever way the key is written", () => {
    expect(recordFor(records, "tA", " ADA.Lee@Example.com")).toBe(ada);
    expect(recordFor(records, "tA", "48213")).toBe(order);
    expect(recordFor(records, "tB", "#48213")).toBeNull();
  });
  it("by words: this task's records rank the exact key first; another task's records are left out", () => {
    expect(recallMemory([...all, ...records], "#48213", { taskKey: "tA" })[0]).toBe(order);
    expect(recallMemory([...all, ...records], "invoice", { taskKey: "tA" })).toContain(ada);
    expect(recallMemory([...all, ...records], "Another task", { taskKey: "tA" })).not.toContain(otherTask);
    expect(recallMemory(records, "refund")).toEqual([]);
  });
});
