import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@noa/shared";
import { detailsModel, formatWhen, linkParts, originOf, repeatSentence, type DetailsTask } from "../../src/sidepanel/task-details.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const WHEN = { locale: "en-US", timeZone: "UTC" };

const task = (extra: Partial<DetailsTask> = {}): DetailsTask => ({
  id: "t1",
  instructions: "Reply to new mentions\nKeep it friendly: https://example.com/guide.",
  account: "noa",
  mediaIds: ["m1"],
  notBefore: "2026-09-24T13:30:00Z",
  priority: 0,
  status: "pending",
  attempts: 0,
  leaseOwner: null,
  leaseExpiresAt: null,
  retryAfter: null,
  resultSummary: null,
  resultUrl: null,
  resultScreenshotId: null,
  pauseReason: null,
  failReason: null,
  createdAt: "2026-09-20T08:00:00Z",
  updatedAt: "2026-09-23T09:15:00Z",
  repeat: { cron: "0 9,18 * * *", tz: "UTC" },
  media: [{ id: "m1", name: "week38.jpg", type: "image/jpeg", size: 184000 }],
  ...extra,
});

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: "s1",
  source: "local",
  taskId: "t1",
  title: "Reply to new mentions Keep it friendly",
  brain: "claude-api",
  model: "claude-sonnet-5",
  jev: true,
  startedAt: "2026-09-24T11:00:00Z",
  endedAt: "2026-09-24T11:05:00Z",
  outcome: "done",
  ...extra,
});

const field = (m: ReturnType<typeof detailsModel>, label: string) => m.fields.find((f) => f.label === label);
const labels = (m: ReturnType<typeof detailsModel>) => m.fields.map((f) => f.label);

describe("detailsModel", () => {
  it("a TODO entry: full instructions, schedule, repeat, attempts, files, times, id, and its latest run", () => {
    const m = detailsModel({ task: task(), listSource: "account", session: session() }, NOW, WHEN);
    expect(m.heading).toBe("Task details");
    expect(m.textLabel).toBe("Instructions");
    expect(m.copyLabel).toBe("Copy instructions");
    expect(m.text).toBe("Reply to new mentions\nKeep it friendly: https://example.com/guide.");
    expect(m.textNote).toBeUndefined();
    expect(m.chip).toMatchObject({ label: "scheduled", tone: "muted" });
    expect(m.chip?.hint).toMatch(/Waits until/);
    expect(labels(m)).toEqual(["Account", "Source", "Next run", "Repeats", "Attempts", "Last run by", "Created", "Updated", "Task id", "Run id"]);
    expect(field(m, "Account")?.value).toBe("@noa");
    expect(field(m, "Source")?.value).toBe("Scheduled in your account");
    expect(field(m, "Next run")?.value).toBe("Sep 24, 2026, 1:30 PM");
    expect(field(m, "Repeats")?.value).toBe("Daily at 9:00 AM and 6:00 PM");
    expect(field(m, "Attempts")?.value).toBe("0");
    expect(field(m, "Last run by")?.value).toBe("Claude API · claude-sonnet-5 · Jev on");
    expect(field(m, "Task id")).toMatchObject({ value: "t1", mono: true });
    expect(m.files).toEqual([{ name: "week38.jpg", detail: "image/jpeg · 180 KB" }]);
  });

  it("leaves out what the task does not have", () => {
    const m = detailsModel({ task: task({ account: null, notBefore: null, repeat: null, media: [], mediaIds: [] }), listSource: "local" }, NOW, WHEN);
    expect(labels(m)).toEqual(["Source", "Attempts", "Created", "Updated", "Task id"]);
    expect(field(m, "Source")?.value).toBe("Scheduled in this browser");
    expect(m.files).toEqual([]);
  });

  it("failed and paused tasks show the reason; a retry shows when it is tried again", () => {
    const failed = detailsModel({ task: task({ status: "failed", attempts: 3, failReason: "LinkedIn asked for a captcha" }) }, NOW, WHEN);
    expect(failed.chip?.label).toBe("failed");
    expect(field(failed, "Attempts")?.value).toBe("3");
    expect(field(failed, "Last failure")).toMatchObject({ value: "LinkedIn asked for a captcha", tone: "bad" });
    const paused = detailsModel({ task: task({ status: "paused", pauseReason: "Needs a one-time code" }) }, NOW, WHEN);
    expect(field(paused, "Last pause reason")).toMatchObject({ value: "Needs a one-time code", tone: "warn" });
    const retry = detailsModel({ task: task({ notBefore: null, retryAfter: "2026-09-24T12:10:00Z", attempts: 1 }) }, NOW, WHEN);
    expect(retry.chip?.label).toBe("retry");
    expect(field(retry, "Tries again")?.value).toBe("Sep 24, 2026, 12:10 PM");
  });

  it("the TODO entry's reasons and result win over its run's", () => {
    const m = detailsModel(
      { task: task({ status: "pending", pauseReason: null }), session: session({ outcome: "paused", reason: "old reason", url: "https://x.com/old" }) },
      NOW,
      WHEN,
    );
    expect(field(m, "Last pause reason")).toBeUndefined();
    expect(field(m, "Result")).toBeUndefined();
  });

  it("a done task links its result", () => {
    const m = detailsModel({ task: task({ status: "done", resultUrl: "https://x.com/a/status/1", resultSummary: "Posted" }) }, NOW, WHEN);
    expect(field(m, "Result")).toMatchObject({ value: "Posted", href: "https://x.com/a/status/1" });
  });

  it("a repeat in another zone names it; a one-off says when; files known by id only are listed by id", () => {
    const m = detailsModel({ task: task({ repeat: { cron: "0 9,18 * * *", tz: "Europe/Berlin" }, media: undefined, mediaIds: ["med_1"] }), listSource: "account" }, NOW, WHEN);
    expect(field(m, "Repeats")?.value).toBe("Daily at 9:00 AM and 6:00 PM (Europe/Berlin)");
    expect(field(detailsModel({ task: task({ repeat: null }) }, NOW, WHEN), "Scheduled at")?.value).toBe("Sep 24, 2026, 1:30 PM");
    expect(m.files).toEqual([{ name: "med_1", detail: "" }]);
  });

  it("a chat message: the full message typed, its account, and the run", () => {
    const text = "Post on X from @alpha:\nour launch is live https://example.com/launch";
    const m = detailsModel({ session: session({ source: "adhoc", taskId: undefined, instructions: text, account: "alpha", title: "Post on X from @alpha: our launch…", outcome: "paused", reason: "stopped by user", firstStartedAt: "2026-09-24T10:00:00Z", turns: 2 }) }, NOW, WHEN);
    expect(m.heading).toBe("Chat message");
    expect(m.textLabel).toBe("Message");
    expect(m.copyLabel).toBe("Copy message");
    expect(m.emptyText).toBe("No message was saved.");
    expect(m.text).toBe(text);
    expect(m.textNote).toBeUndefined();
    expect(m.chip?.label).toBe("needs you");
    expect(labels(m)).toEqual(["Account", "Source", "Last pause reason", "Run by", "Started", "Ended", "Run id"]);
    expect(field(m, "Source")?.value).toBe("Chat message");
    expect(field(m, "Started")?.value).toBe("Sep 24, 2026, 10:00 AM");
  });

  it("a running run shows as running with no end time", () => {
    const m = detailsModel({ session: session({ source: "adhoc", instructions: "x", endedAt: undefined, outcome: undefined }) }, NOW, WHEN);
    expect(m.chip).toMatchObject({ label: "running", tone: "accent" });
    expect(field(m, "Ended")).toBeUndefined();
  });

  it("a run whose task the list does not have: only the title is known, and it says so", () => {
    const clipped = detailsModel({ session: session({ source: "cloud", taskId: "c9", title: "Post the weekly recap with the numbers from the dashboard and tag the whole te…" }) }, NOW, WHEN);
    expect(clipped.text).toMatch(/^Post the weekly recap/);
    expect(clipped.textNote).toBe("Only the start of the instructions was saved with this run.");
    expect(field(clipped, "Source")?.value).toBe("Scheduled in your account");
    expect(field(clipped, "Task id")?.value).toBe("c9");
    const whole = detailsModel({ session: session({ title: "Like three posts" }) }, NOW, WHEN);
    expect(whole.textNote).toBe("Only a one-line copy of the instructions was saved with this run.");
    expect(field(whole, "Source")?.value).toBe("Scheduled in this browser");
  });
});

describe("originOf", () => {
  it("the TODO list it is in, else the run's source", () => {
    expect(originOf({ task: task(), listSource: "account" })).toBe("account");
    expect(originOf({ task: task() })).toBe("local");
    expect(originOf({ session: session({ source: "cloud" }) })).toBe("account");
    expect(originOf({ session: session({ source: "adhoc" }) })).toBe("adhoc");
    expect(originOf({})).toBeUndefined();
  });
});

describe("formatting", () => {
  it("times use the given locale; bad input gives nothing", () => {
    expect(formatWhen("2026-09-24T13:30:00Z", { locale: "de-DE", timeZone: "UTC" })).toBe("24.09.2026, 13:30");
    expect(formatWhen("nope")).toBe("");
    expect(formatWhen(null)).toBe("");
  });

  it("a task stored with the old { dailyAt } rule shows it in words (before the store migrates it)", () => {
    const m = detailsModel({ task: task({ repeat: { dailyAt: ["09:00"] } as never }), listSource: "local" }, NOW, WHEN);
    expect(field(m, "Repeats")?.value).toMatch(/^Daily at 9:00 AM/);
  });

  it("repeat rules read as a sentence", () => {
    expect(repeatSentence({ cron: "0 9 * * *", tz: "UTC" }, { hour12: false, localZone: "UTC" })).toBe("Daily at 09:00");
    expect(repeatSentence({ cron: "0 9,12,18 * * 1-5", tz: "Asia/Seoul" }, { hour12: true, localZone: "UTC" })).toBe("Every weekday at 9:00 AM, 12:00 PM and 6:00 PM (Asia/Seoul)");
    expect(repeatSentence(null)).toBe("");
  });
});

describe("linkParts", () => {
  it("splits http(s) links out of the text, keeping everything else as is", () => {
    expect(linkParts("Open https://x.com/home and post.\nThen https://example.com/a?b=1.")).toEqual([
      { text: "Open " },
      { url: "https://x.com/home" },
      { text: " and post.\nThen " },
      { url: "https://example.com/a?b=1" },
      { text: "." },
    ]);
  });

  it("a closing paren stays only when it belongs to the link", () => {
    expect(linkParts("(see https://example.com/x)")).toEqual([{ text: "(see " }, { url: "https://example.com/x" }, { text: ")" }]);
    expect(linkParts("https://en.wikipedia.org/wiki/Foo_(bar), ok")).toEqual([{ url: "https://en.wikipedia.org/wiki/Foo_(bar)" }, { text: ", ok" }]);
  });

  it("other schemes and plain text are not links", () => {
    expect(linkParts("javascript:alert(1) and www.example.com")).toEqual([{ text: "javascript:alert(1) and www.example.com" }]);
    expect(linkParts("")).toEqual([]);
  });
});

describe("previous runs", () => {
  const kept = (i: number, extra: Record<string, unknown> = {}) =>
    ({ id: `r${i}`, kind: "task", subject: "Run note", text: `Posted ${i}`, scope: "task", taskKey: "s1", source: { kind: "task" }, learnedAt: `2026-09-2${i}T09:00:00.000Z`, updatedAt: `2026-09-2${i}T09:00:00.000Z`, ...extra }) as never;

  it("lists the task's runs newest first with date, output line, output and note; the older runs' summary apart", () => {
    const long = `Shipped: ${"scheduled tasks that remember ".repeat(6)}`;
    const m = detailsModel({ task: task(), listSource: "account", runs: [kept(3, { output: long }), kept(2, { text: "(no note)", output: "Only an output" }), kept(1), kept(0, { subject: "Earlier runs", text: "9 earlier runs, 2026-09-01 to 2026-09-19." })] }, NOW, WHEN);
    expect(m.previousRuns).toEqual([
      { when: "Sep 23, 2026, 9:00 AM", line: expect.stringMatching(/^Shipped: scheduled tasks .*…$/), output: long, note: "Posted 3" },
      { when: "Sep 22, 2026, 9:00 AM", line: "Only an output", output: "Only an output" },
      { when: "Sep 21, 2026, 9:00 AM", line: "Posted 1", note: "Posted 1" },
    ]);
    expect(m.previousRuns![0]!.line.length).toBeLessThanOrEqual(90);
    expect(m.earlierRuns).toBe("9 earlier runs, 2026-09-01 to 2026-09-19.");
    expect(detailsModel({ task: task() }, NOW, WHEN).previousRuns).toBeUndefined();
  });
});
