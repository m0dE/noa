import { describe, expect, it } from "vitest";
import { chipHint, taskChip, USER_STOP_REASON, whenText, type SessionInfo } from "@noa/shared";
import { APPROVAL_REASON, STALE_NEEDS_MS, UPCOMING_ON_HOME, buildJobs, distinctTitle, groupJobs, jobKeyOf, jobRow, jobSubtitle, scheduleRow, viewLayout, type JobInputs, type JobTask } from "../../src/sidepanel/jobs.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const DAILY = { cron: "0 9 * * *", tz: "UTC" };

function session(id: string, min: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: `Chat ${id}`, brain: "claude-api", jev: false, startedAt: at(min), endedAt: at(min + 2), outcome: "done", ...extra };
}
function task(id: string, extra: Partial<JobTask> = {}): JobTask {
  return {
    id,
    instructions: `Task ${id}`,
    account: null,
    mediaIds: [],
    notBefore: null,
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
    createdAt: at(-600),
    updatedAt: at(-600),
    ...extra,
  } as JobTask;
}
const jobs = (input: Partial<JobInputs>) => buildJobs({ sessions: [], running: [], tasks: [], ...input }, NOW);
const byKey = (input: Partial<JobInputs>) => new Map(jobs(input).map((j) => [j.key, j]));
const layout = (input: Partial<JobInputs>, query = "") => groupJobs(jobs(input), query).map((g) => [g.label, g.jobs.map((j) => j.key)]);

describe("jobs: what each job is", () => {
  it("a chat is one job; a task and its runs are one job", () => {
    const j = byKey({
      sessions: [session("c1", -30), session("r1", -20, { source: "local", taskId: "t1", seriesId: "t1", title: "Task t1" })],
      tasks: [task("t1", { status: "done", updatedAt: at(-18) })],
    });
    expect([...j.keys()].sort()).toEqual(["chat:c1", "task:t1"]);
    expect(j.get("chat:c1")).toMatchObject({ kind: "chat", title: "Chat c1", state: "done", group: "recent", runs: [expect.objectContaining({ sessionId: "c1" })] });
    expect(j.get("task:t1")).toMatchObject({ kind: "task", title: "Task t1", state: "done", task: expect.objectContaining({ id: "t1" }), session: expect.objectContaining({ sessionId: "r1" }) });
  });

  it("a repeating task shows once: every repeat and run of its series is in the one job, the waiting repeat stands for it", () => {
    const tasks = [
      task("t1", { status: "done", repeat: DAILY, seriesId: "t1", createdAt: at(-3000), updatedAt: at(-2990) }),
      task("t2", { status: "failed", repeat: DAILY, seriesId: "t1", createdAt: at(-1560), updatedAt: at(-1550), failReason: "X was down" }),
      task("t3", { status: "pending", repeat: DAILY, seriesId: "t1", createdAt: at(-120), notBefore: at(1260) }),
    ];
    const sessions = [
      session("r2", -1560, { source: "local", taskId: "t2", seriesId: "t1", outcome: "failed" }),
      // An older run from before tasks had a series: found by its task.
      session("r1", -3000, { source: "local", taskId: "t1" }),
    ];
    const all = jobs({ tasks, sessions });
    expect(all).toHaveLength(1);
    const [j] = all;
    expect(j).toMatchObject({ key: "task:t1", state: "scheduled", group: "scheduled", next: at(1260), repeat: DAILY });
    expect(j!.task!.id).toBe("t3");
    expect(j!.tasks.map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
    expect(j!.runs.map((r) => r.sessionId)).toEqual(["r1", "r2"]);
    expect(j!.session!.sessionId).toBe("r2");
  });

  it("runs of a deleted task stay together, by their series", () => {
    const j = jobs({ sessions: [session("a", -100, { source: "local", taskId: "x1", seriesId: "x" }), session("b", -50, { source: "local", taskId: "x2", seriesId: "x", title: "Post the tip" })] });
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ key: "task:x", kind: "task", task: null, title: "Post the tip", state: "done" });
  });

  it("jobKeyOf: a run belongs to its task's series, a chat to itself", () => {
    expect(jobKeyOf({ sessionId: "c", source: "adhoc" })).toBe("chat:c");
    expect(jobKeyOf({ sessionId: "r", source: "local", taskId: "t2" }, new Map([["t2", "t1"]]))).toBe("task:t1");
    expect(jobKeyOf({ sessionId: "r", source: "cloud", taskId: "q9" })).toBe("task:q9");
    expect(jobKeyOf({ sessionId: "r", source: "local", taskId: "t2", seriesId: "s" })).toBe("task:s");
  });

  it("needs you: a paused task, an approval waiting, a chat that stopped for the user; a chat the user stopped is over", () => {
    const j = byKey({
      tasks: [task("paused", { status: "paused", pauseReason: "Log in to X" })],
      sessions: [
        session("asks", -5, { endedAt: undefined, outcome: undefined }),
        session("dates", -40, { outcome: "paused", reason: "Needs you to pick dates" }),
        session("stopped", -60, { outcome: "paused", reason: USER_STOP_REASON }),
        session("gone", -70, { endedAt: undefined, outcome: undefined }),
      ],
      running: [session("asks", -5, { endedAt: undefined, outcome: undefined })],
      awaitingApproval: ["asks"],
    });
    expect(j.get("task:paused")).toMatchObject({ state: "needs", reason: "Log in to X" });
    expect(j.get("chat:asks")).toMatchObject({ state: "needs", reason: APPROVAL_REASON, running: true });
    expect(j.get("chat:dates")).toMatchObject({ state: "needs", reason: "Needs you to pick dates" });
    expect(j.get("chat:stopped")).toMatchObject({ state: "stopped", group: "recent" });
    // Never ended and not running: its worker stopped under it.
    expect(j.get("chat:gone")).toMatchObject({ state: "stopped", group: "recent" });
  });

  it("running: a run in this browser (the live copy wins), or a task running elsewhere", () => {
    const listed = session("r", -3, { source: "local", taskId: "t1", endedAt: undefined, outcome: undefined, title: "old" });
    const j = byKey({
      tasks: [task("t1", { status: "running" }), task("t9", { status: "running" })],
      sessions: [listed],
      running: [{ ...listed, title: "new" }, session("chat", -1, { endedAt: undefined, outcome: undefined })],
    });
    expect(j.get("task:t1")).toMatchObject({ state: "running", running: true, session: expect.objectContaining({ title: "new" }) });
    expect(j.get("task:t9")).toMatchObject({ state: "running", running: false, session: null });
    // A running session the list does not have yet is a job too.
    expect(j.get("chat:chat")).toMatchObject({ state: "running" });
  });

  it("scheduled: waiting, due now, retrying", () => {
    const j = byKey({
      tasks: [
        task("later", { notBefore: at(60) }),
        task("due", { notBefore: at(-5) }),
        task("asap"),
        task("retry", { retryAfter: at(30), failReason: "Network" }),
      ],
    });
    expect(j.get("task:later")).toMatchObject({ state: "scheduled", next: at(60) });
    expect(j.get("task:due")!.state).toBe("due");
    expect(j.get("task:asap")).toMatchObject({ state: "due", next: null });
    expect(j.get("task:retry")).toMatchObject({ state: "retry", reason: "Network", group: "scheduled" });
  });

  it("the site is its newest run's (www. dropped); a chat without a title is 'Look at this page'", () => {
    const j = byKey({ sessions: [session("c", -5, { url: "https://www.x.com/home", title: "  " })] });
    expect(j.get("chat:c")).toMatchObject({ site: "x.com", title: "Look at this page" });
  });
});

describe("jobs: groups and order", () => {
  const input: Partial<JobInputs> = {
    tasks: [
      task("tomorrow", { notBefore: at(1300), repeat: DAILY }),
      task("soon", { notBefore: at(20) }),
      task("now", { notBefore: at(-1) }),
      task("paused", { status: "paused", updatedAt: at(-10) }),
    ],
    sessions: [
      session("old", -500),
      session("new", -50),
      session("mid", -200, { outcome: "failed" }),
      session("live", -2, { endedAt: undefined, outcome: undefined }),
      session("asking", -30, { outcome: "paused", reason: "Pick a seat" }),
    ],
    running: [session("live", -2, { endedAt: undefined, outcome: undefined })],
  };

  it("Needs you, Running, Upcoming (soonest first, due first), Recent (newest first)", () => {
    expect(layout(input)).toEqual([
      ["Needs you", ["task:paused", "chat:asking"]],
      ["Running", ["chat:live"]],
      ["Upcoming", ["task:now", "task:soon", "task:tomorrow"]],
      ["Recent", ["chat:new", "chat:mid", "chat:old"]],
    ]);
  });

  it("only groups that have jobs", () => {
    expect(layout({ sessions: [session("a", -5)] })).toEqual([["Recent", ["chat:a"]]]);
    expect(layout({})).toEqual([]);
  });

  it("search: every word, in any order, in the title, instructions or site, any case", () => {
    const find = { tasks: [task("t", { instructions: "Post the weekly recap on X" })], sessions: [session("c", -5, { title: "Flights to Lisbon", instructions: "Find the cheapest flight to Lisbon in May", url: "https://www.google.com/travel" }), session("d", -9, { title: "Inbox" })] };
    expect(layout(find, "RECAP weekly")).toEqual([["Upcoming", ["task:t"]]]);
    expect(layout(find, "cheapest may")).toEqual([["Recent", ["chat:c"]]]);
    expect(layout(find, "google.com")).toEqual([["Recent", ["chat:c"]]]);
    expect(layout(find, "lisbon recap")).toEqual([]);
    expect(layout(find, "  ")).toHaveLength(2);
  });
});

describe("jobs: rows and subtitles in words", () => {
  it("a scheduled repeating job: its rule under the title, the next run on the right", () => {
    const [j] = jobs({ tasks: [task("t", { notBefore: at(60), repeat: DAILY })] });
    const row = jobRow(j!, NOW);
    expect(row.meta).toBe("Daily at 9:00 AM");
    // Today: the time alone; later days say which.
    expect(row.when).toMatch(/^(Tomorrow )?\d{1,2}:\d\d/);
    expect(row.label).toContain("Task t, Scheduled, Daily at 9:00 AM, next");
    // Inside a line "today" and "tomorrow" are lower case; only the line starts with a capital.
    expect(jobSubtitle(j!, NOW)).toMatch(/^Daily at 9:00 AM · next (today|tomorrow) /);
  });

  it("a daily 9:00 series: the next run is its waiting row's 9:00, never an earlier run's time", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const daily = { cron: "0 9 * * *", tz: zone };
    // The next 9:00 in this machine's zone after NOW.
    const next = new Date(NOW);
    next.setHours(9, 0, 0, 0);
    if (next.getTime() <= NOW) next.setDate(next.getDate() + 1);
    const tasks = [
      task("s1", { status: "done", repeat: daily, seriesId: "s1", createdAt: at(-1500), updatedAt: at(-1437) }),
      task("s2", { status: "pending", repeat: daily, seriesId: "s1", createdAt: at(-37), updatedAt: at(-37), notBefore: next.toISOString() }),
    ];
    // Its runs ended at odd times (9:03, and 37 minutes ago).
    const sessions = [session("r1", -1440, { source: "local", taskId: "s1", seriesId: "s1" }), session("r2", -40, { source: "local", taskId: "s1", seriesId: "s1" })];
    const [j] = jobs({ tasks, sessions });
    expect(j!.next).toBe(next.toISOString());
    expect(jobSubtitle(j!, NOW)).toMatch(/^Daily at 9:00 AM · next (today|tomorrow) 9:00 AM$/);
    expect(jobRow(j!, NOW).when).toMatch(/^(Tomorrow )?9:00 AM$/);
  });

  it("a one-off due now; a retry", () => {
    const j = byKey({ tasks: [task("due"), task("retry", { retryAfter: at(30) })] });
    expect(jobRow(j.get("task:due")!, NOW).when).toBe("Due now");
    expect(jobSubtitle(j.get("task:due")!, NOW)).toBe("Due now");
    expect(jobRow(j.get("task:retry")!, NOW).when).toMatch(/^Retries \d/);
    expect(jobSubtitle(j.get("task:retry")!, NOW)).toMatch(/^Retries (today|tomorrow) /);
  });

  it("needs you: the reason under the title; recent: the site and how long ago; running: now", () => {
    const j = byKey({
      sessions: [session("n", -40, { outcome: "paused", reason: "Pick a seat" }), session("d", -125, { url: "https://mail.google.com/x" }), session("r", -1, { endedAt: undefined, outcome: undefined })],
      running: [session("r", -1, { endedAt: undefined, outcome: undefined })],
    });
    expect(jobRow(j.get("chat:n")!, NOW)).toMatchObject({ meta: "Pick a seat", when: "38 min ago" });
    expect(jobSubtitle(j.get("chat:n")!, NOW)).toBe("Needs you · Pick a seat");
    expect(jobRow(j.get("chat:d")!, NOW)).toMatchObject({ meta: "mail.google.com", when: "2 h ago", label: "Chat d, Done, 2 h ago, mail.google.com" });
    expect(jobSubtitle(j.get("chat:d")!, NOW)).toBe("Done · 2 h ago");
    expect(jobRow(j.get("chat:r")!, NOW).when).toBe("now");
    expect(jobSubtitle(j.get("chat:r")!, NOW)).toBe("Running");
  });
});

describe("jobs: titles that tell similar jobs apart", () => {
  it("a request leads with the account it acts as, from its words or its task's account", () => {
    expect(distinctTitle("Post one new original post on X as @mecharoyalecom")).toBe("@mecharoyalecom · Post one new original post on X");
    expect(distinctTitle("Post the launch thread on X from @noa today")).toBe("@noa · Post the launch thread on X today");
    expect(distinctTitle("Like posts by @ada_l and reply", null)).toBe("@ada_l · Like posts and reply");
    expect(distinctTitle("Post a tip on X", "@noa")).toBe("@noa · Post a tip on X");
    // Nothing to lead with: an email is not a handle, an account already named stays where it is.
    expect(distinctTitle("Reply to ada@example.com")).toBe("Reply to ada@example.com");
    expect(distinctTitle("@noa post a tip", "@noa")).toBe("@noa post a tip");
    expect(distinctTitle("Check the order status", "shop account")).toBe("Check the order status");
  });

  it("a task is named by its series' name (the user's newest, else the title model's first), else its request", () => {
    const tasks = [task("t1", { status: "done", instructions: "Post one new original post on X as @mecharoyalecom", seriesId: "t1" })];
    const run = (id: string, min: number, extra: Partial<SessionInfo>) => session(id, min, { source: "local", taskId: "t1", seriesId: "t1", ...extra });
    expect(byKey({ tasks }).get("task:t1")?.title).toBe("@mecharoyalecom · Post one new original post on X");
    const named = [run("r1", -300, { title: "@mecharoyalecom: daily X post", titleBy: "model" }), run("r2", -100, { title: "@mecharoyalecom: X post again", titleBy: "model" })];
    expect(byKey({ tasks, sessions: named }).get("task:t1")?.title).toBe("@mecharoyalecom: daily X post");
    expect(byKey({ tasks, sessions: [...named, run("r3", -50, { title: "Mecha daily", titleBy: "user" })] }).get("task:t1")?.title).toBe("Mecha daily");
  });
});

describe("jobs: what the user cleared, and needs nobody answered", () => {
  const DAY = STALE_NEEDS_MS / 60_000;
  const needing = {
    tasks: [task("paused", { status: "paused", pauseReason: "Log in to X" })],
    sessions: [session("asks", -5, { endedAt: undefined, outcome: undefined }), session("dates", -40, { outcome: "paused", reason: "Pick dates" })],
    running: [session("asks", -5, { endedAt: undefined, outcome: undefined })],
    awaitingApproval: ["asks"],
  };

  it("each need has its own mark: the paused task row, or the run (live while an approval waits)", () => {
    const j = byKey(needing);
    expect(j.get("task:paused")?.needs).toBe(`task:paused:${at(-600)}`);
    expect(j.get("chat:asks")?.needs).toBe("run:asks:live");
    expect(j.get("chat:dates")?.needs).toBe(`run:dates:${at(-38)}`);
    expect(byKey({ sessions: [session("ok", -5)] }).get("chat:ok")?.needs).toBeNull();
  });

  it("a need dismissed moves to Recent (still saying what it was); a new need of the same job shows again", () => {
    const dismissals = { "chat:dates": { at: at(-1), needs: `run:dates:${at(-38)}` } };
    const j = byKey({ ...needing, dismissals });
    expect(j.get("chat:dates")).toMatchObject({ state: "dismissed", group: "recent", reason: "Pick dates", needs: null });
    expect(jobRow(j.get("chat:dates")!, NOW)).toMatchObject({ meta: "Pick dates", label: "Chat dates, Dismissed, 38 min ago, Pick dates" });
    expect(jobSubtitle(j.get("chat:dates")!, NOW)).toBe("Dismissed · Pick dates · 38 min ago");
    // The chat went on and stopped for the user again: a new need.
    const again = byKey({ sessions: [session("dates", -10, { outcome: "paused", reason: "Pick a seat" })], dismissals });
    expect(again.get("chat:dates")).toMatchObject({ state: "needs", reason: "Pick a seat" });
  });

  it("a need nobody answered for a day goes to Recent by itself, unless a live approval or a paused repeating task", () => {
    const old = -DAY - 30;
    const j = byKey({
      tasks: [
        task("once", { status: "paused", pauseReason: "Log in to X", updatedAt: at(old) }),
        task("daily", { status: "paused", pauseReason: "Log in to X", repeat: DAILY, updatedAt: at(old) }),
      ],
      sessions: [session("tab", old, { outcome: "paused", reason: "The tab was closed" }), session("asks", old, { endedAt: undefined, outcome: undefined })],
      running: [session("asks", old, { endedAt: undefined, outcome: undefined })],
      awaitingApproval: ["asks"],
    });
    expect(j.get("task:once")).toMatchObject({ state: "lapsed", group: "recent" });
    expect(j.get("chat:tab")).toMatchObject({ state: "lapsed", group: "recent" });
    expect(jobRow(j.get("chat:tab")!, NOW).meta).toBe("Waited for you · The tab was closed");
    expect(jobSubtitle(j.get("chat:tab")!, NOW)).toMatch(/^Waited for you · The tab was closed · /);
    // A repeating task paused would never run again unnoticed; a live approval ends by itself when it expires.
    expect(j.get("task:daily")).toMatchObject({ state: "needs", group: "needs" });
    expect(j.get("chat:asks")).toMatchObject({ state: "needs", group: "needs" });
    // Just under a day: still waiting.
    expect(byKey({ sessions: [session("tab", -DAY + 60, { outcome: "paused", reason: "x" })] }).get("chat:tab")?.state).toBe("needs");
  });

  it("a job put away leaves the list until it does something again; a search still finds it", () => {
    const sessions = [session("a", -30, { title: "Alpha report" }), session("b", -20)];
    const dismissals = { "chat:a": { at: at(-1), archivedAt: at(-28) } };
    expect(layout({ sessions, dismissals })).toEqual([["Recent", ["chat:b"]]]);
    expect(layout({ sessions, dismissals }, "alpha")).toEqual([["Recent", ["chat:a"]]]);
    // It ran again since.
    expect(layout({ sessions: [session("a", -5), session("b", -20)], dismissals })).toEqual([["Recent", ["chat:a", "chat:b"]]]);
  });
});

describe("chip hints", () => {
  it("explains every task chip", () => {
    for (const status of ["pending", "running", "done", "failed", "paused", "cancelled"] as const) {
      expect(chipHint(taskChip({ status, notBefore: null, retryAfter: null }).label)).not.toBe("");
    }
    expect(chipHint("retry")).not.toBe("");
    expect(chipHint("scheduled")).not.toBe("");
  });
});

describe("jobs: the two views (Home and Scheduled)", () => {
  const upcoming = (n: number) => Array.from({ length: n }, (_, i) => task(`u${i}`, { notBefore: at(60 * (n - i)), instructions: `Upcoming ${i}` }));
  const view = (v: "home" | "scheduled", input: Partial<JobInputs>, query = "") => {
    const l = viewLayout(v, jobs(input), query);
    return { groups: l.groups.map((g) => [g.label, g.jobs.map((j) => j.key)]), hidden: l.upcomingHidden, count: l.scheduledCount };
  };

  it("Home: Upcoming is cut to its soonest 3; the rest are in Scheduled (All scheduled (N))", () => {
    const home = view("home", { tasks: upcoming(5), sessions: [session("c", -5)] });
    expect(home.groups).toEqual([
      ["Upcoming", ["task:u4", "task:u3", "task:u2"]],
      ["Recent", ["chat:c"]],
    ]);
    expect(home.hidden).toBe(2);
    expect(home.count).toBe(5);
    // Three or fewer: nothing is left out.
    expect(view("home", { tasks: upcoming(3) }).hidden).toBe(0);
    expect(UPCOMING_ON_HOME).toBe(3);
  });

  it("Home with a search shows every upcoming match; the search filters the view shown", () => {
    const tasks = upcoming(5);
    expect(view("home", { tasks }, "upcoming").groups).toEqual([["Upcoming", ["task:u4", "task:u3", "task:u2", "task:u1", "task:u0"]]]);
    expect(view("home", { tasks }, "upcoming").hidden).toBe(0);
    expect(view("scheduled", { tasks }, "upcoming 1").groups).toEqual([["Next runs", ["task:u1"]]]);
    expect(view("scheduled", { tasks, sessions: [session("c", -5, { title: "Upcoming 1 chat" })] }, "chat").groups).toEqual([]);
  });

  it("Scheduled: every job with a schedule, one row per series, soonest first (running, then needing you, then by time), paused last", () => {
    const run = session("r", -1, { source: "local", taskId: "rep-now", seriesId: "rep", endedAt: undefined, outcome: undefined });
    const tasks = [
      task("later", { notBefore: at(600), repeat: DAILY }),
      task("sooner", { notBefore: at(30) }),
      task("due", { notBefore: at(-5) }),
      // A repeating job running now (its series' row runs), and its earlier done run: one row.
      task("rep-old", { status: "done", repeat: DAILY, seriesId: "rep", createdAt: at(-3000) }),
      task("rep-now", { status: "running", repeat: DAILY, seriesId: "rep", createdAt: at(-100) }),
      task("held-b", { status: "paused", pauseReason: "Paused by you", instructions: "B held" }),
      task("held-a", { status: "paused", pauseReason: "Paused after 3 failed runs in a row. Last: boom", instructions: "A held", repeat: DAILY }),
      task("login", { status: "paused", pauseReason: "Log in to X", instructions: "Task login" }),
      // Not scheduled: over, or a one-off running.
      task("over", { status: "done" }),
      task("once-running", { status: "running" }),
    ];
    expect(view("scheduled", { tasks, sessions: [run], running: [run] }).groups).toEqual([
      // Running first, then one that needs the user, then by time (a due one's time has passed).
      ["Next runs", ["task:rep", "task:login", "task:due", "task:sooner", "task:later"]],
      ["Paused", ["task:held-a", "task:held-b"]],
    ]);
  });

  it("paused by the user: only in Scheduled (not on Home); paused after failures: Needs you on Home and paused in Scheduled", () => {
    const tasks = [
      task("mine", { status: "paused", pauseReason: "Paused by you", repeat: DAILY }),
      task("failing", { status: "paused", pauseReason: "Paused after 3 failed runs in a row. Last: boom", repeat: DAILY }),
    ];
    const j = byKey({ tasks });
    expect(j.get("task:mine")).toMatchObject({ state: "paused", group: "paused", held: true, scheduled: true, reason: "" });
    expect(j.get("task:failing")).toMatchObject({ state: "needs", group: "needs", held: true, reason: "Paused after 3 failed runs in a row. Last: boom" });
    expect(view("home", { tasks }).groups).toEqual([["Needs you", ["task:failing"]]]);
    expect(view("scheduled", { tasks }).groups).toEqual([["Paused", ["task:failing", "task:mine"]]]);
    expect(jobSubtitle(j.get("task:mine")!, NOW)).toBe("Paused · Daily at 9:00 AM");
    // A paused one that comes back by itself (a retry time) is not on hold.
    expect(byKey({ tasks: [task("later", { status: "paused", pauseReason: "Paused by you", retryAfter: at(10) })] }).get("task:later")).toMatchObject({ state: "needs", held: false });
  });

  it("a Scheduled row: its schedule under the title, its next run on the right, and Pause or Resume", () => {
    const j = byKey({
      tasks: [
        task("daily", { notBefore: at(21 * 60), repeat: DAILY, instructions: "Post the tip" }),
        task("once", { notBefore: at(30), instructions: "Call back" }),
        task("mine", { status: "paused", pauseReason: "Paused by you", repeat: DAILY, instructions: "Mine" }),
        task("failing", { status: "paused", pauseReason: "Paused after 3 failed runs in a row. Last: boom", instructions: "Failing" }),
        task("login", { status: "paused", pauseReason: "Log in to X", instructions: "Login" }),
      ],
    });
    // Times read in this computer's zone (whenText).
    const tomorrow9 = whenText(at(21 * 60), NOW);
    const soon = whenText(at(30), NOW).replace(/^Today /, "");
    expect(scheduleRow(j.get("task:daily")!, NOW)).toEqual({
      title: "Post the tip",
      meta: "Daily at 9:00 AM",
      when: tomorrow9,
      label: `Post the tip, Scheduled, Daily at 9:00 AM, next ${tomorrow9.replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}`,
      toggle: "pause",
    });
    expect(scheduleRow(j.get("task:once")!, NOW)).toMatchObject({ meta: "Once", when: soon, toggle: "pause" });
    expect(scheduleRow(j.get("task:mine")!, NOW)).toMatchObject({ meta: "Daily at 9:00 AM", when: "Paused", toggle: "resume", label: "Mine, Paused, Daily at 9:00 AM" });
    expect(scheduleRow(j.get("task:failing")!, NOW)).toMatchObject({ meta: "Once · Paused after 3 failed runs in a row. Last: boom", when: "Paused", toggle: "resume" });
    // Needs the user for something else: neither (Resume on its page goes on from its run).
    expect(scheduleRow(j.get("task:login")!, NOW)).toMatchObject({ meta: "Once · Log in to X", when: "Needs you", toggle: null });
  });
});
