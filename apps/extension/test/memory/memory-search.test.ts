import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@noa/shared";
import { entitiesOf, MAX_RUNS_PER_TASK, searchMemory, SEMANTIC_MIN_SCORE, termsOf } from "../../src/memory/search.js";
import { selectMemory } from "../../src/memory/select.js";
import { stem } from "../../src/memory/stem.js";
import { parseTime } from "../../src/memory/when.js";

const NOW = new Date("2026-09-26T09:00:00.000Z");

let n = 0;
function entry(e: Partial<MemoryEntry> & Pick<MemoryEntry, "kind" | "subject" | "text">): MemoryEntry {
  n++;
  const at = e.learnedAt ?? new Date(Date.UTC(2025, 0, n)).toISOString();
  return { id: `m${n}`, scope: e.domain ? "domain" : "global", source: { kind: "chat" }, learnedAt: at, updatedAt: at, ...e };
}
const ids = (hits: { entry: MemoryEntry }[]) => hits.map((h) => h.entry.id);

describe("stem (Porter)", () => {
  it("gives the reference stems", () => {
    const cases: Record<string, string> = { caresses: "caress", ponies: "poni", hopping: "hop", relational: "relat", formalize: "formal", adjustment: "adjust", booked: "book", booking: "book", cancelled: "cancel", flights: "flight" };
    for (const [w, s] of Object.entries(cases)) expect(stem(w)).toBe(s);
  });
  it("leaves identifiers, short words and other scripts alone", () => {
    for (const w of ["x2", "ab", "48213", "서울", "déjà"]) expect(stem(w)).toBe(w);
  });
});

describe("termsOf and entitiesOf", () => {
  it("stems words, keeps identifiers whole and by their parts, keeps 2-letter acronyms", () => {
    expect(termsOf("Booked the HR meeting from admin@runhq.io")).toEqual(expect.arrayContaining(["book", "hr", "meet", "admin@runhq.io", "admin", "runhq", "io"]));
    expect(termsOf("what is the")).toEqual([]);
  });
  it("finds identifiers and names, not a sentence's first word nor a bare year", () => {
    expect(entitiesOf("Email Paul Lee about booking HM4K2ZQ9 on x.com in 2025, from @runhq")).toEqual(expect.arrayContaining(["paul", "lee", "hm4k2zq9", "x.com", "@runhq"]));
    expect(entitiesOf("Email Paul")).not.toContain("email");
    expect(entitiesOf("in 2025")).toEqual([]);
    expect(entitiesOf("What did the 'Post the daily tip' run do?")).toContain("post the daily tip");
  });
});

describe("parseTime", () => {
  const t = (q: string) => parseTime(q, NOW);
  it("reads periods into [from, to) ranges", () => {
    expect(t("What did we do on Channex last spring?")).toMatchObject({ from: "2026-03-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" });
    expect(t("last summer")).toMatchObject({ from: "2026-06-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" });
    expect(t("in autumn 2025")).toMatchObject({ from: "2025-09-01T00:00:00.000Z", to: "2025-12-01T00:00:00.000Z" });
    expect(t("the run on 3 June 2025")).toMatchObject({ from: "2025-06-03T00:00:00.000Z", to: "2025-06-04T00:00:00.000Z" });
    expect(t("in August 2025")).toMatchObject({ from: "2025-08-01T00:00:00.000Z", to: "2025-09-01T00:00:00.000Z" });
    expect(t("in March")).toMatchObject({ from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" });
    expect(t("in November")).toMatchObject({ from: "2025-11-01T00:00:00.000Z" });
    expect(t("yesterday")).toMatchObject({ from: "2026-09-25T00:00:00.000Z", to: "2026-09-26T00:00:00.000Z" });
    expect(t("3 days ago")).toMatchObject({ from: "2026-09-23T00:00:00.000Z", to: "2026-09-24T00:00:00.000Z" });
    expect(t("last week")).toMatchObject({ from: "2026-09-14T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" });
    expect(t("this year")).toMatchObject({ from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
    expect(t("on 2025-11-03")).toMatchObject({ from: "2025-11-03T00:00:00.000Z", to: "2025-11-04T00:00:00.000Z" });
  });
  it("uses the user's calendar day", () => {
    // 09:00 UTC is already the 27th at UTC+16:00 (an extreme offset, to make the day change).
    expect(parseTime("yesterday", NOW, 16 * 60)).toMatchObject({ from: "2026-09-25T08:00:00.000Z", to: "2026-09-26T08:00:00.000Z" });
  });
  it("does not take a name for a time", () => {
    expect(t("When was the 2024 tax return filed?").from).toBeUndefined();
    expect(t("What did we report in the Q2 2026 update?").from).toBeUndefined();
  });
  it("reads order, before / after bounds and events, the past and the present", () => {
    expect(t("When did we first run the recon?").order).toBe("first");
    expect(t("What happened in the most recent run?").order).toBe("last");
    expect(t("What time can we post at the earliest?").order).toBeUndefined();
    expect(t("Which address was my work email before February 2026?")).toMatchObject({ to: "2026-02-01T00:00:00.000Z", past: true });
    expect(t("the last check before our Pro price change")).toMatchObject({ anchor: { side: "before", words: "Pro price change" }, order: "last" });
    expect(t("the run right after the listing photos went up")).toMatchObject({ anchor: { side: "after", words: "listing photos went up" }, order: "first" });
    expect(t("Who is my accountant now?")).toMatchObject({ current: true, rest: "Who is my accountant ?" });
    expect(t("How do I export last week's payouts?").rest).toBe("How do I export payouts?");
  });
});

describe("searchMemory", () => {
  const workEmail = entry({ kind: "account", subject: "Work email", text: "ops@runhq.io is the work email (Google /u/1)." });
  const paul = entry({ kind: "person", subject: "Paul Lee", text: "Paul Lee is my accountant: tax return and VAT." });
  const tone = entry({ kind: "preference", subject: "Guest tone", text: "Guest replies: warm and short, end with a smiley." });
  const xBook = entry({ kind: "playbook", subject: "Compose", text: "Open https://x.com/compose/post; the Post button stays disabled until text is typed.", domain: "x.com" });
  const facts = [workEmail, paul, tone, xBook];

  it("finds nothing for what memory does not hold, although words are shared", () => {
    expect(searchMemory(facts, "How do I post on Instagram?", { now: NOW }).hits).toEqual([]);
    expect(searchMemory(facts, "Who is my dentist?", { now: NOW }).hits).toEqual([]);
  });

  it("finds an entry a long request names by its subject, however much else it says", () => {
    const hits = searchMemory(facts, "Open the Zephyr quarterly report, pull the numbers for Margo Quint and send them from my work email", { now: NOW }).hits;
    expect(ids(hits)).toContain(workEmail.id);
  });

  it("finds a site's playbook by its name or site only, not by a word of its text", () => {
    expect(ids(searchMemory(facts, "Post a tip on LinkedIn", { now: NOW }).hits)).not.toContain(xBook.id);
    expect(ids(searchMemory(facts, "Compose a post on x.com", { now: NOW }).hits)).toContain(xBook.id);
  });

  it("uses meaning when given, above SEMANTIC_MIN_SCORE only", () => {
    const semantic = new Map([[paul.id, SEMANTIC_MIN_SCORE + 0.1], [tone.id, SEMANTIC_MIN_SCORE - 0.1]]);
    expect(ids(searchMemory(facts, "Who is my tax guy?", { now: NOW, semantic }).hits)).toEqual([paul.id]);
    expect(searchMemory(facts, "Who is my tax guy?", { now: NOW }).hits.map((h) => h.via)).not.toContainEqual({ meaning: 0 });
  });

  const runs = Array.from({ length: 8 }, (_, i) =>
    entry({ kind: "episode", subject: "Reconcile Stripe payouts", text: `Reconciled ${i + 4} payouts; matched the Wise export.`, at: new Date(Date.UTC(2025, i, 10)).toISOString(), taskKey: "tR", taskTitle: "Reconcile Stripe payouts" }),
  );
  const priceChange = entry({ kind: "episode", subject: "Pro price change", text: "Changed the Pro price in Stripe from 12 to 15 USD.", at: "2025-05-20T12:00:00.000Z" });

  it("with a time: the dated entries in it about the subject; first and latest in date order", () => {
    expect(ids(searchMemory([...runs, ...facts], "What did we reconcile in March 2025?", { now: NOW }).hits)[0]).toBe(runs[2]!.id);
    expect(ids(searchMemory([...runs, ...facts], "When did we first reconcile the payouts?", { now: NOW }).hits)[0]).toBe(runs[0]!.id);
    expect(ids(searchMemory([...runs, ...facts], "the most recent payout reconciliation", { now: NOW }).hits)[0]).toBe(runs[7]!.id);
  });

  it("before / after an event: the event first, then the nearest runs on that side", () => {
    const hits = ids(searchMemory([...runs, priceChange, ...facts], "How many payouts did the last reconciliation before the Pro price change match?", { now: NOW }).hits);
    expect(hits.slice(0, 2)).toEqual([priceChange.id, runs[4]!.id]);
  });

  it("without a time, a task's runs do not crowd out the rest", () => {
    const hits = searchMemory([...runs, ...facts], "reconcile payouts", { now: NOW }).hits;
    expect(hits.filter((h) => h.entry.taskKey === "tR")).toHaveLength(MAX_RUNS_PER_TASK);
  });

  it("asked for the value before, a changed fact with its history; asked now, the newer of two", () => {
    const tz = entry({ kind: "preference", subject: "Timezone", text: "My timezone is Europe/Berlin.", history: [{ subject: "Timezone", text: "My timezone is Europe/Lisbon.", since: "2025-01-01T00:00:00.000Z", until: "2026-06-15T00:00:00.000Z" }] });
    expect(ids(searchMemory([tz, ...facts], "What timezone was I in before?", { now: NOW }).hits)).toContain(tz.id);
    const hannah = entry({ kind: "person", subject: "Hannah Brooks", text: "Hannah Brooks is my accountant since Paul Lee retired.", learnedAt: "2026-01-01T00:00:00.000Z" });
    expect(ids(searchMemory([paul, hannah, ...facts.slice(2)], "Who is my accountant?", { now: NOW }).hits)).toEqual([hannah.id, paul.id]);
  });
});

describe("selectMemory abstains", () => {
  it("gives nothing to a turn memory has nothing for", () => {
    const facts = [entry({ kind: "preference", subject: "Sign-off", text: "Sign emails 'Best, Jae'." }), entry({ kind: "person", subject: "Paul Lee", text: "Paul Lee is my accountant." })];
    expect(selectMemory(facts, { hosts: [], text: "What's the weather in Porto tomorrow?", now: NOW })).toEqual({ entries: [], text: "", tokens: 0 });
  });
});
