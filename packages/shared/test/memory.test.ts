import { describe, expect, it } from "vitest";
import {
  condenseRecord,
  ExtensionSettings,
  keyTokens,
  MAX_MEMORY_TEXT_CHARS,
  MAX_RECORD_CHARS,
  MAX_RECORD_NOTES,
  MEMORY_CHARS_PER_TOKEN,
  MEMORY_RECORD_TOKEN_BUDGET,
  MemoryEntrySchema,
  memoryDomain,
  memoryLine,
  memoryRecordKey,
  RECORD_SUMMARY_HEAD_CHARS,
  RecallArgs,
  memoryTaskKey,
  memoryWriteProblem,
  onDomain,
  parseSettings,
  RememberArgs,
  redactSecrets,
  secretProblem,
} from "../src/index.js";

// Key-shaped strings are built at run time, so no key-like literal sits in the repo.
const fakeKey = (prefix: string, n: number) => `${prefix}${"a1B2c3D4".repeat(Math.ceil(n / 8)).slice(0, n)}`;

describe("secretProblem", () => {
  it.each([
    ["an Anthropic key", `key ${fakeKey("sk-ant-", 30)}`],
    ["an OpenAI-style key", `use ${fakeKey("sk-", 32)}`],
    ["a GitHub token", fakeKey("ghp_", 30)],
    ["an AWS access key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["a JWT", `eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4`],
    ["a bearer token", "send Authorization: Bearer abcdefgh12345678"],
    ["a password with a colon", "password: hunter22"],
    ["a password in words", "Her password is Tr0ub4dor&3"],
    ["a PIN", "The PIN is 4821"],
    ["a one-time code", "the code is 482913"],
    ["an OTP with a colon", "OTP: 123-456"],
    ["backup codes", "backup codes 1234-5678 2345-6789"],
    ["a token in a URL", "https://example.com/reset?token=abcdef123456"],
    ["a card number", "card 4111 1111 1111 1111"],
    ["a private key", `-----BEGIN ${"PRIVATE"} KEY-----\nMIIE\n-----END ${"PRIVATE"} KEY-----`],
    ["a seed phrase", "recovery phrase: apple banana cherry"],
  ])("refuses %s", (_what, text) => {
    expect(secretProblem(text)).not.toBeNull();
  });

  it.each([
    ["an account fact", "admin@runhq.io is the work email, Google /u/2"],
    ["a handle", "@mecharoyalecom is the game X account"],
    ["a person", "Paul Lee is my accountant"],
    ["a playbook with a URL", "Compose is at https://mail.google.com/mail/u/2/#inbox?compose=new"],
    ["a site that asks for codes", "Gmail asks for a 2FA code every morning; pause and ask the user"],
    ["a password manager", "The user keeps logins in 1Password"],
    ["a post about tokens", "Posted about the token launch 2026 and the roadmap"],
    ["a rule with a time", "Never post before 8am"],
    ["a phone number", "Paul's office number is +1 415 555 0134"],
    ["a status code", "the page returns error code 404 when signed out"],
  ])("keeps %s", (_what, text) => {
    expect(secretProblem(text)).toBeNull();
  });

  it("redacts what it refuses (the Raw view uses the same patterns)", () => {
    expect(redactSecrets(`key ${fakeKey("sk-ant-", 30)} end`)).toBe("key [redacted] end");
  });
});

describe("memoryWriteProblem", () => {
  it("checks the subject too, and says how to phrase it instead", () => {
    const why = memoryWriteProblem({ subject: "password: hunter22", text: "the bank login" });
    expect(why).toMatch(/^Not saved: .*password/);
    expect(why).toMatch(/Site logins/);
    expect(memoryWriteProblem({ subject: "Work email", text: "admin@runhq.io, Google /u/2" })).toBeNull();
  });
});

describe("memoryDomain and onDomain", () => {
  it("keys sites by host without www, and refuses what is not a host", () => {
    expect(memoryDomain("https://www.X.com/home")).toBe("x.com");
    expect(memoryDomain("mail.google.com")).toBe("mail.google.com");
    expect(memoryDomain("gmail")).toBeNull();
    expect(memoryDomain("http://localhost:4777/w/gmail/u/2/")).toBe("localhost");
    expect(memoryDomain("localhost")).toBe("localhost");
  });
  it("matches subdomains, not look-alikes", () => {
    expect(onDomain("mail.google.com", "google.com")).toBe(true);
    expect(onDomain("google.com", "google.com")).toBe(true);
    expect(onDomain("notgoogle.com", "google.com")).toBe(false);
  });
});

describe("memoryTaskKey", () => {
  it("is the same for every run of a task, whatever the spacing and case", () => {
    expect(memoryTaskKey("Post a daily tip on X", "@me")).toBe(memoryTaskKey("  post a DAILY   tip on x ", "@ME"));
  });
  it("differs when the instructions or the account change", () => {
    const k = memoryTaskKey("Post a daily tip on X", "@me");
    expect(memoryTaskKey("Post a weekly tip on X", "@me")).not.toBe(k);
    expect(memoryTaskKey("Post a daily tip on X", "@other")).not.toBe(k);
    expect(memoryTaskKey("Post a daily tip on X", null)).not.toBe(k);
  });
});

describe("memoryLine", () => {
  it("names the id, the site and, for task notes, the day", () => {
    expect(memoryLine({ id: "m1", kind: "playbook", subject: "Compose", text: "C opens it", domain: "mail.google.com", learnedAt: "2026-09-25T10:00:00Z" })).toBe(
      "[m1] Compose (mail.google.com): C opens it",
    );
    expect(memoryLine({ id: "m2", kind: "task", subject: "Run note", text: "Posted about A", learnedAt: "2026-09-25T10:00:00Z" })).toBe("[m2] 2026-09-25 Run note: Posted about A");
  });
});

describe("RememberArgs and the memory settings", () => {
  it("takes what the tool describes", () => {
    expect(RememberArgs.safeParse({ kind: "account", subject: "Work email", text: "admin@runhq.io" }).success).toBe(true);
    expect(RememberArgs.safeParse({ kind: "secret", subject: "x", text: "y" }).success).toBe(false);
  });
  it("defaults to memory on with every kind, and drops unknown kinds", () => {
    const d = ExtensionSettings.parse({});
    expect(d.memoryPaused).toBe(false);
    expect(d.memoryKindsOff).toEqual([]);
    expect(parseSettings({ memoryKindsOff: ["person"] }).memoryKindsOff).toEqual(["person"]);
    expect(parseSettings({ memoryKindsOff: ["nope"] }).memoryKindsOff).toEqual([]);
  });
});

// Examples only: the product code knows nothing of what a task deals with; these are three differently shaped keys.
describe("record keys", () => {
  it("normalizes an identifier: lower case, one space, emails and IDs whole", () => {
    expect(memoryRecordKey("  Ada.Lee@Example.COM ")).toBe("ada.lee@example.com");
    expect(memoryRecordKey("#48213")).toBe("48213");
    expect(memoryRecordKey("Unit  7-B")).toBe("unit 7-b");
    expect(memoryRecordKey("—")).toBe("");
  });
  it("splits a text into the words keys match against", () => {
    expect(keyTokens("Reply to Ada.Lee@example.com about order #48213.")).toEqual(["reply", "to", "ada.lee@example.com", "about", "order", "48213"]);
    expect(keyTokens("https://shop.example/orders/48213?tab=2")).toEqual(["https", "shop.example", "orders", "48213", "tab", "2"]);
  });
});

describe("condenseRecord", () => {
  const note = (day: number, text: string) => ({ at: `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`, text });

  it("keeps the newest MAX_RECORD_NOTES notes and folds older ones into the summary, dated", () => {
    const notes = Array.from({ length: MAX_RECORD_NOTES + 2 }, (_, i) => note(i + 1, `note ${i + 1}`));
    const r = condenseRecord("First seen.", notes);
    expect(r.notes.map((n) => n.text)).toEqual(notes.slice(2).map((n) => n.text));
    expect(r.text).toBe("First seen. | 2026-09-01: note 1 | 2026-09-02: note 2");
  });

  it("stays within MAX_RECORD_CHARS, and a long summary keeps its beginning and its newest end", () => {
    let summary = `Opening fact ${"x".repeat(100)}`;
    let notes: { at: string; text: string }[] = [];
    for (let i = 1; i <= 30; i++) ({ text: summary, notes } = condenseRecord(summary, [...notes, note((i % 28) + 1, `update ${i} ${"y".repeat(150)}`)]));
    expect(summary.length + notes.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(MAX_RECORD_CHARS);
    expect(summary.length).toBeLessThanOrEqual(MAX_MEMORY_TEXT_CHARS);
    expect(summary.startsWith("Opening fact")).toBe(true);
    expect(summary).toContain(" … ");
    expect(notes.at(-1)!.text).toMatch(/^update 30 /);
    // Deterministic: the same input condenses the same way.
    expect(condenseRecord(summary, notes)).toEqual({ text: summary, notes });
    expect(RECORD_SUMMARY_HEAD_CHARS).toBeLessThan(MAX_MEMORY_TEXT_CHARS);
  });

  it("a whole record fits in the prompt's budget for records", () => {
    const worst = {
      id: "m12345",
      kind: "task" as const,
      subject: "s".repeat(80),
      key: "k".repeat(120),
      text: "t".repeat(MAX_MEMORY_TEXT_CHARS),
      notes: Array.from({ length: MAX_RECORD_NOTES }, (_, i) => note(i + 1, "n".repeat((MAX_RECORD_CHARS - MAX_MEMORY_TEXT_CHARS) / MAX_RECORD_NOTES))),
      learnedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(Math.ceil(memoryLine(worst).length / MEMORY_CHARS_PER_TOKEN) + 10).toBeLessThanOrEqual(MEMORY_RECORD_TOKEN_BUDGET);
  });
});

describe("records in the entry schema and the tools", () => {
  const record = {
    id: "r1",
    kind: "task",
    subject: "#48213",
    text: "Asked for a refund.",
    scope: "task",
    taskKey: "t1",
    key: "48213",
    notes: [{ at: "2026-09-25T10:00:00.000Z", text: "Refund sent." }],
    source: { kind: "task" },
    learnedAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
  };
  it("a record belongs to one task and stays within its size", () => {
    expect(MemoryEntrySchema.safeParse(record).success).toBe(true);
    expect(MemoryEntrySchema.safeParse({ ...record, scope: "global", taskKey: undefined }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...record, key: undefined }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...record, notes: [{ at: "x", text: "n".repeat(MAX_MEMORY_TEXT_CHARS) }, { at: "x", text: "n".repeat(MAX_MEMORY_TEXT_CHARS) }] }).success).toBe(false);
  });
  it("reads a record with its key and dated notes", () => {
    expect(memoryLine(record as never)).toBe("[r1] key #48213: Asked for a refund. · 2026-09-25: Refund sent.");
    expect(memoryLine({ ...record, subject: "Refund case" } as never)).toBe("[r1] key Refund case (key 48213): Asked for a refund. · 2026-09-25: Refund sent.");
  });
  it("remember takes a key (and then no subject); recall takes a query or a key", () => {
    expect(RememberArgs.safeParse({ kind: "task", key: "ada@example.com", text: "Prefers email." }).success).toBe(true);
    expect(RecallArgs.safeParse({ key: "48213" }).success).toBe(true);
    expect(RecallArgs.safeParse({ query: "refund" }).success).toBe(true);
  });
});
