import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_SPOKEN_CHARS,
  isOnHold,
  taskChip,
  chipHint,
  PAUSED_BY_USER,
  failureHoldReason,
  resumedNotBefore,
  ACCOUNT_API_BASE,
  BatchCreateInput,
  CreateTaskInput,
  currentAccountApiBase,
  PREVIOUS_ACCOUNT_API_BASES,
  DEFAULT_SETTINGS,
  INTERACTIVE_TOOL_NAMES,
  isXSite,
  isXStatusUrl,
  isXTask,
  isXUrl,
  MAX_SUGGESTION_CHARS,
  MAX_TABS_PER_CALL,
  RpcPeer,
  SUGGESTION_NEVER,
  TOOL_DESCRIPTIONS,
  ToolArgs,
  mcpToolName,
  parseSettings,
  pauseReasonForUrl,
  pickDelayMs,
  registrableDomain,
  sameSite,
  siteHost,
  toolsFor,
  type RpcMessage,
} from "../src/index.js";

describe("CreateTaskInput", () => {
  it("accepts a minimal task", () => {
    expect(CreateTaskInput.parse({ instructions: "Post hello" })).toEqual({ instructions: "Post hello" });
  });
  it("accepts a full task with offset time", () => {
    const t = CreateTaskInput.parse({
      instructions: "Post hello",
      account: "@me",
      mediaIds: ["m1"],
      notBefore: "2026-09-24T09:00:00+02:00",
      priority: 5,
    });
    expect(t.account).toBe("@me");
  });
  it("rejects empty instructions and bad dates", () => {
    expect(CreateTaskInput.safeParse({ instructions: "  " }).success).toBe(false);
    expect(CreateTaskInput.safeParse({ instructions: "x", notBefore: "tomorrow" }).success).toBe(false);
  });
  it("limits batch size to 100", () => {
    const tasks = Array.from({ length: 101 }, () => ({ instructions: "x" }));
    expect(BatchCreateInput.safeParse({ tasks }).success).toBe(false);
    expect(BatchCreateInput.safeParse({ tasks: tasks.slice(0, 100) }).success).toBe(true);
  });
});

describe("pauseReasonForUrl", () => {
  it.each([
    "https://x.com/i/flow/login",
    "https://x.com/i/flow/login?redirect_after_login=%2Fhome",
    "https://twitter.com/login",
    "https://x.com/account/access",
    "https://www.x.com/account/login_challenge",
  ])("pauses on %s", (url) => {
    expect(pauseReasonForUrl(url)).not.toBeNull();
  });
  it.each(["https://x.com/home", "https://x.com/compose/post", "https://x.com/loginhelper", "https://example.com/login", "not a url"])(
    "does not pause on %s",
    (url) => {
      expect(pauseReasonForUrl(url)).toBeNull();
    },
  );
});

describe("settings", () => {
  it("fills defaults", () => {
    const s = parseSettings({ intervalMinutes: 5, jevThreshold: "bad" });
    expect(s.intervalMinutes).toBe(5);
    expect(s.jevThreshold).toBe(DEFAULT_SETTINGS.jevThreshold);
  });
  it("moves a saved earlier default account server to the current one, and keeps a self-hosted one", () => {
    expect(parseSettings({ accountApiBase: "https://noa-api.jaeyun.workers.dev/" }).accountApiBase).toBe("https://app.noa.bot");
    expect(parseSettings({ accountApiBase: "https://api.example.org" }).accountApiBase).toBe("https://api.example.org");
    expect(parseSettings({}).accountApiBase).toBe("https://app.noa.bot");
  });
  it("currentAccountApiBase: one rule for settings and sessions", () => {
    expect(currentAccountApiBase(" https://noa-api.jaeyun.workers.dev// ")).toBe(ACCOUNT_API_BASE);
    for (const old of PREVIOUS_ACCOUNT_API_BASES) expect(currentAccountApiBase(old)).toBe(ACCOUNT_API_BASE);
    expect(currentAccountApiBase("https://app.noa.bot/")).toBe(ACCOUNT_API_BASE);
    expect(currentAccountApiBase("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(currentAccountApiBase("")).toBe("");
  });
  it("fixes an inverted delay range", () => {
    const s = parseSettings({ delayMinSec: 100, delayMaxSec: 10 });
    expect(s.delayMaxSec).toBe(100);
  });
  it("picks delays within range", () => {
    expect(pickDelayMs({ delayMinSec: 60, delayMaxSec: 180 }, () => 0)).toBe(60_000);
    expect(pickDelayMs({ delayMinSec: 60, delayMaxSec: 180 }, () => 1)).toBe(180_000);
  });
});

describe("mcpToolName", () => {
  it("prefixes with the server name", () => {
    expect(mcpToolName("click")).toBe("mcp__noa__click");
  });
});

describe("RpcPeer", () => {
  type A = { "b.echo": { params: { v: number }; result: { v: number } } };
  type B = { "a.fail": { params: Record<string, never>; result: null } };

  function pair() {
    let a!: RpcPeer<A, B>;
    let b!: RpcPeer<B, A>;
    a = new RpcPeer<A, B>((m: RpcMessage) => void b.receive(JSON.parse(JSON.stringify(m))), "a");
    b = new RpcPeer<B, A>((m: RpcMessage) => void a.receive(JSON.parse(JSON.stringify(m))), "b");
    return { a, b };
  }

  it("calls a handler on the other side", async () => {
    const { a, b } = pair();
    b.handle("b.echo", ({ v }) => ({ v: v * 2 }));
    await expect(a.call("b.echo", { v: 21 })).resolves.toEqual({ v: 42 });
  });
  it("propagates handler errors", async () => {
    const { a, b } = pair();
    a.handle("a.fail", () => {
      throw new Error("boom");
    });
    await expect(b.call("a.fail", {})).rejects.toThrow("boom");
  });
  it("rejects unknown methods", async () => {
    const { a } = pair();
    await expect(a.call("b.echo", { v: 1 })).rejects.toThrow("Unknown method");
  });
  it("delivers notifications without replies", async () => {
    const { a, b } = pair();
    const got: unknown[] = [];
    b.onNotification<{ n: number }>("tick", (p) => got.push(p.n));
    a.notify("tick", { n: 1 });
    a.notify("unhandled", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([1]);
    expect(a.pendingCount).toBe(0);
  });
  it("times out and rejects pending calls on close", async () => {
    const silent = new RpcPeer<A, B>(() => {});
    await expect(silent.call("b.echo", { v: 1 }, { timeoutMs: 10 })).rejects.toThrow("timed out");
    const p = silent.call("b.echo", { v: 1 });
    silent.close("gone");
    await expect(p).rejects.toThrow("gone");
    await expect(silent.call("b.echo", { v: 1 })).rejects.toThrow("closed");
  });
});

describe("multi-tab tools", () => {
  it("open_tabs takes 1..8 URLs and an optional background flag", () => {
    expect(ToolArgs.open_tabs.safeParse({ urls: ["https://a.test/"] }).success).toBe(true);
    expect(ToolArgs.open_tabs.safeParse({ urls: ["https://a.test/"], background: false }).success).toBe(true);
    expect(ToolArgs.open_tabs.safeParse({ urls: [] }).success).toBe(false);
    expect(ToolArgs.open_tabs.safeParse({ urls: Array(MAX_TABS_PER_CALL + 1).fill("https://a.test/") }).success).toBe(false);
  });

  it("read_page keeps the no-argument form and accepts 1..8 tabs", () => {
    expect(ToolArgs.read_page.safeParse({}).success).toBe(true);
    expect(ToolArgs.read_page.safeParse({ tabs: ["t2", "t3"] }).success).toBe(true);
    expect(ToolArgs.read_page.safeParse({ tabs: [] }).success).toBe(false);
    expect(ToolArgs.read_page.safeParse({ tabs: Array(9).fill("t2") }).success).toBe(false);
  });

  it("switch_tab, list_tabs and close_tabs validate their arguments", () => {
    expect(ToolArgs.switch_tab.safeParse({ tab: "t2" }).success).toBe(true);
    expect(ToolArgs.switch_tab.safeParse({}).success).toBe(false);
    expect(ToolArgs.list_tabs.safeParse({}).success).toBe(true);
    expect(ToolArgs.close_tabs.safeParse({ tabs: ["t2"] }).success).toBe(true);
    expect(ToolArgs.close_tabs.safeParse({ tabs: [] }).success).toBe(false);
  });

  it("are offered to tasks and to mcp-server --attach, with descriptions", () => {
    for (const n of ["open_tabs", "switch_tab", "list_tabs", "close_tabs"] as const) {
      expect(TOOL_DESCRIPTIONS[n].length).toBeGreaterThan(10);
      expect(toolsFor()).toContain(n);
      expect(toolsFor({ interactive: true })).toContain(n);
      expect(INTERACTIVE_TOOL_NAMES).toContain(n);
    }
    // act replaces click/type; no task_* for --attach.
    expect(toolsFor()).not.toContain("click");
    expect(toolsFor({ interactive: true })).not.toContain("task_complete");
  });

  it("the user's own Claude Code (--attach) gets no saved logins: get_credential is a task's tool only", () => {
    expect(toolsFor()).toContain("get_credential");
    expect(INTERACTIVE_TOOL_NAMES).not.toContain("get_credential");
    expect(toolsFor({ interactive: true })).not.toContain("get_credential");
  });
});

describe("follow-up suggestion (task_* suggestion)", () => {
  const ends = [
    ["task_complete", { summary: "Summarized 4 unread emails" }],
    ["task_fail", { reason: "The page would not load" }],
    ["task_pause", { reason: "Sign in to example.com" }],
  ] as const;

  it("is optional on task_complete, task_fail and task_pause, trimmed, and capped at MAX_SUGGESTION_CHARS", () => {
    for (const [name, args] of ends) {
      expect(ToolArgs[name].safeParse(args).success).toBe(true);
      const withIt = ToolArgs[name].safeParse({ ...args, suggestion: "  Reply to Jordan and say I'll sign by Thursday " });
      expect(withIt.success && withIt.data.suggestion).toBe("Reply to Jordan and say I'll sign by Thursday");
      expect(ToolArgs[name].safeParse({ ...args, suggestion: "x".repeat(MAX_SUGGESTION_CHARS) }).success).toBe(true);
      expect(ToolArgs[name].safeParse({ ...args, suggestion: "x".repeat(MAX_SUGGESTION_CHARS + 1) }).success).toBe(false);
      expect(ToolArgs[name].safeParse({ ...args, suggestion: "   " }).success).toBe(false);
    }
    expect(MAX_SUGGESTION_CHARS).toBe(80);
  });

  it("the schema the model sees states the cap and what never to suggest", () => {
    const schema = z.toJSONSchema(ToolArgs.task_complete, { io: "input" }) as { properties: Record<string, { maxLength?: number; description?: string }>; required: string[] };
    expect(schema.properties.suggestion!.maxLength).toBe(MAX_SUGGESTION_CHARS);
    expect(schema.properties.suggestion!.description).toContain(SUGGESTION_NEVER);
    expect(schema.required).toEqual(["summary"]);
    for (const [name] of ends) expect(TOOL_DESCRIPTIONS[name]).toMatch(/suggestion/);
  });
});

describe("spoken line (task_* spoken)", () => {
  const ends = [
    ["task_complete", { summary: "Summarized 4 unread emails" }],
    ["task_fail", { reason: "The page would not load" }],
    ["task_pause", { reason: "Sign in to example.com" }],
  ] as const;

  it("is optional on task_complete, task_fail and task_pause, trimmed, and capped at MAX_SPOKEN_CHARS", () => {
    for (const [name, args] of ends) {
      const withIt = ToolArgs[name].safeParse({ ...args, spoken: "  Done. Jordan needs your signature by Friday. " });
      expect(withIt.success && withIt.data.spoken).toBe("Done. Jordan needs your signature by Friday.");
      expect(ToolArgs[name].safeParse({ ...args, spoken: "x".repeat(MAX_SPOKEN_CHARS) }).success).toBe(true);
      expect(ToolArgs[name].safeParse({ ...args, spoken: "x".repeat(MAX_SPOKEN_CHARS + 1) }).success).toBe(false);
      expect(ToolArgs[name].safeParse({ ...args, spoken: "  " }).success).toBe(false);
    }
    expect(MAX_SPOKEN_CHARS).toBe(200);
  });

  it("the schema the model sees states the cap and asks for natural speech", () => {
    const schema = z.toJSONSchema(ToolArgs.task_pause, { io: "input" }) as { properties: Record<string, { maxLength?: number; description?: string }>; required: string[] };
    expect(schema.properties.spoken!.maxLength).toBe(MAX_SPOKEN_CHARS);
    expect(schema.properties.spoken!.description).toMatch(/read aloud/);
    expect(schema.properties.spoken!.description).toContain('in the first person as Noa ("I…"), never "the agent"');
    expect(schema.required).toEqual(["reason"]);
  });
});

describe("isXTask", () => {
  it("names an X account (account field or @handle) or works on x.com", () => {
    expect(isXTask({ instructions: "Post: gm", account: "@alpha" })).toBe(true);
    expect(isXTask({ instructions: "Post on X from @alpha. Post: first turn" })).toBe(true);
    expect(isXTask({ instructions: "Reply to @beta's newest post" })).toBe(true);
    expect(isXTask({ instructions: "Open https://x.com/home and like the first post" })).toBe(true);
    expect(isXTask({ instructions: "open twitter.com" })).toBe(true);
  });
  it("not for email addresses or other sites", () => {
    expect(isXTask({ instructions: "Email paul@example.com the invoice" })).toBe(false);
    expect(isXTask({ instructions: "Check https://notes.test/notes/a?delay=3000. Post: note A", account: null })).toBe(false);
    expect(isXTask({ instructions: "Buy milk", account: "  " })).toBe(false);
  });
});

describe("maxParallelTasks", () => {
  it("defaults to 2 and stays within 1..4", () => {
    expect(DEFAULT_SETTINGS.maxParallelTasks).toBe(2);
    expect(parseSettings({ maxParallelTasks: 3 }).maxParallelTasks).toBe(3);
    expect(parseSettings({ maxParallelTasks: 9 }).maxParallelTasks).toBe(2);
    expect(parseSettings({ maxParallelTasks: 0 }).maxParallelTasks).toBe(2);
  });
});

describe("url helpers", () => {
  it("normalize hosts and recognize X URLs", () => {
    expect(siteHost(" https://WWW.Example.com/login ")).toBe("example.com");
    expect(siteHost("mail.example.com")).toBe("mail.example.com");
    expect(isXSite("twitter.com")).toBe(true);
    expect(isXSite("https://mobile.x.com/home")).toBe(true);
    expect(isXSite("notx.com")).toBe(false);
    expect(isXUrl("https://x.com/home")).toBe(true);
    expect(isXUrl("not a url")).toBe(false);
    expect(isXStatusUrl("https://x.com/alpha/status/123")).toBe(true);
    expect(isXStatusUrl("https://x.com/alpha")).toBe(false);
    // Only the path counts: a /status/ in the query is not a post.
    expect(isXStatusUrl("https://x.com/home?ref=/status/123")).toBe(false);
    expect(isXStatusUrl("https://x.com/i/web/status/123")).toBe(true);
    expect(isXStatusUrl("https://example.com/alpha/status/123")).toBe(false);
  });

  it("registrableDomain: the site a host belongs to (its eTLD+1)", () => {
    expect(registrableDomain("mail.google.com")).toBe("google.com");
    expect(registrableDomain("https://WWW.Example.com/login")).toBe("example.com");
    expect(registrableDomain("bank.test")).toBe("bank.test");
    expect(registrableDomain("x.com")).toBe("x.com");
    // Two-label public suffixes under a country code.
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.amazon.com.au")).toBe("amazon.com.au");
    expect(registrableDomain("x.co")).toBe("x.co");
    // Hosting suffixes where every customer is a site of its own.
    expect(registrableDomain("attacker.github.io")).toBe("attacker.github.io");
    expect(registrableDomain("a.b.vercel.app")).toBe("b.vercel.app");
    // Hosts without a site above them are their own.
    expect(registrableDomain("localhost:8080")).toBe("localhost");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("co.uk")).toBe("co.uk");
    expect(registrableDomain("")).toBe("");
  });

  it("sameSite: hosts or URLs of one registrable domain", () => {
    expect(sameSite("login.bank.test", "https://bank.test/account")).toBe(true);
    expect(sameSite("bank.test", "https://evil.test/login")).toBe(false);
    expect(sameSite("bank.test", "https://bank.test.evil.test/")).toBe(false);
    expect(sameSite("victim.github.io", "https://attacker.github.io/")).toBe(false);
    expect(sameSite("bbc.co.uk", "https://evil.co.uk/")).toBe(false);
    expect(sameSite("", "https://bank.test/")).toBe(false);
    expect(sameSite("bank.test", "not a url")).toBe(false);
  });
});

describe("plan features", () => {
  it("a feature works when the catalog grants it and the plan is in good standing", async () => {
    const { PLAN_CATALOG, planAllows, VOICE_LIMITS } = await import("../src/index.js");
    expect(Object.values(PLAN_CATALOG).filter((p) => p.voice).map((p) => p.id)).toEqual(["plus", "pro"]);
    // Voice starts at Plus: Starter includes the TODO list and API keys but not voice.
    expect(planAllows({ id: "starter", status: "active" }, "voice")).toBe(false);
    expect(planAllows({ id: "plus", status: "active" }, "voice")).toBe(true);
    expect(planAllows({ id: "pro", status: "past_due" }, "apiKeys")).toBe(true);
    expect(planAllows({ id: "starter", status: "canceled" }, "voice")).toBe(false);
    expect(planAllows({ id: "free", status: "none" }, "voice")).toBe(false);
    expect(planAllows({ id: "gold", status: "active" }, "voice")).toBe(false);
    expect(planAllows(null, "voice")).toBe(false);
    // The TODO list (account tasks, scheduled runs) is a paid feature like voice.
    expect(Object.values(PLAN_CATALOG).filter((p) => p.todo).map((p) => p.id)).toEqual(["starter", "plus", "pro"]);
    expect(planAllows({ id: "starter", status: "active" }, "todo")).toBe(true);
    expect(planAllows({ id: "free", status: "canceled" }, "todo")).toBe(false);
    // 60 s of the clips the extension sends fits the byte limit.
    expect(44 + (VOICE_LIMITS.maxClipMs / 1000) * VOICE_LIMITS.sampleRate * 2).toBeLessThanOrEqual(VOICE_LIMITS.maxClipBytes);
  });
});

describe("the locked TODO list", () => {
  it("says how many saved tasks come back", async () => {
    const { keptTasksText } = await import("../src/index.js");
    expect(keptTasksText(0)).toBe("");
    expect(keptTasksText(1)).toBe("You have 1 saved task; it comes back when you subscribe.");
    expect(keptTasksText(1200)).toBe("You have 1,200 saved tasks; they come back when you subscribe.");
  });
});

describe("plan descriptions", () => {
  it("say what a plan includes, generated from the catalog flags", async () => {
    const { PLAN_CATALOG, planIncludesText } = await import("../src/index.js");
    expect(planIncludesText(PLAN_CATALOG.free)).toBe("");
    expect(planIncludesText(PLAN_CATALOG.plus)).toBe("Includes TODO list, voice input and API access");
    expect(planIncludesText({ todo: true, voice: false, apiKeys: false })).toBe("Includes TODO list");
  });
});

describe("pausing a job (task-view, schedule)", () => {
  it("a task is on hold when paused by the user or after its runs kept failing, with no time to come back by itself", () => {
    expect(isOnHold({ status: "paused", pauseReason: PAUSED_BY_USER, retryAfter: null })).toBe(true);
    expect(isOnHold({ status: "paused", pauseReason: failureHoldReason(3, "boom"), retryAfter: null })).toBe(true);
    expect(failureHoldReason(3, "boom")).toBe("Paused after 3 failed runs in a row. Last: boom");
    expect(isOnHold({ status: "paused", pauseReason: "Log in to X", retryAfter: null })).toBe(false);
    expect(isOnHold({ status: "paused", pauseReason: PAUSED_BY_USER, retryAfter: "2026-09-28T10:00:00Z" })).toBe(false);
    expect(isOnHold({ status: "pending", pauseReason: PAUSED_BY_USER })).toBe(false);
  });

  it("its chip says paused, not needs you", () => {
    expect(taskChip({ status: "paused", pauseReason: PAUSED_BY_USER, retryAfter: null })).toEqual({ label: "paused", tone: "muted" });
    expect(taskChip({ status: "paused", pauseReason: "Log in" })).toEqual({ label: "needs you", tone: "warn" });
    expect(chipHint("paused")).toMatch(/until you resume it/);
  });

  it("resumedNotBefore: a repeating task whose time went by runs at its next time; otherwise its own time", () => {
    const rule = { cron: "0 9 * * *", tz: "UTC" };
    const now = new Date("2026-09-28T12:00:00Z");
    expect(resumedNotBefore("2026-09-25T09:00:00.000Z", rule, now)).toBe("2026-09-29T09:00:00.000Z");
    expect(resumedNotBefore("2026-09-30T09:00:00.000Z", rule, now)).toBe("2026-09-30T09:00:00.000Z");
    expect(resumedNotBefore("2026-09-25T09:00:00.000Z", null, now)).toBe("2026-09-25T09:00:00.000Z");
    expect(resumedNotBefore(null, null, now)).toBeNull();
  });
});
