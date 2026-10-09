/**
 * Live: does the real agent start from the page the user already has open? The helper with headless Claude Code on
 * this machine's login gets a request while the user's tab (access "here") shows a page that answers part of it, but
 * the request does not say "this page". A webmail is there too, as the place an agent might go to guess instead. The
 * run counts as starting from the user's tab when its first page tool (read_page / screenshot) is on that tab, before
 * any navigate or open_tabs. The memory tools are on (recall finds only an unrelated entry), as in a chat. Prints every
 * tool call.
 *
 * The scenarios are on different sites with different wording: one is the page and request the user reported, the
 * others check that the rule holds in general rather than for that one page.
 *
 *   pnpm --filter @noa/helper build
 *   cd apps/extension && NOA_LIVE=1 npx vitest run --config test/manual/live.config.ts user-tab
 *
 * NOA_LIVE_SCENARIO: one scenario's name. NOA_LIVE_REQUEST: other wording for its request. NOA_LIVE_RUNS: runs per scenario (default 1). NOA_LIVE_OUT: a log file.
 * NOA_LIVE_MODEL: the model (default claude-sonnet-5). NOA_LIVE_MEMORY=1: a memory block (see MEMORY); NOA_LIVE_MEMORY_FILE: one read from a file. NOA_LIVE_JEV=1: Jev on, with TYPESAFE_API_KEY (without a key the helper runs without Jev).
 */
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentTabInfo, BrowserMethod, ElementInfo, PageSnapshot } from "@noa/shared";
import { startHost } from "../../../helper/test/support/host-process.js";
import { ENV } from "../../../helper/src/env-names.js";

const LIVE = process.env.NOA_LIVE === "1";
const RUNS = Number(process.env.NOA_LIVE_RUNS ?? 1);
const MODEL = process.env.NOA_LIVE_MODEL ?? "claude-sonnet-5";

interface Page {
  url: string;
  title: string;
  text: string;
  links?: string[];
}

interface Scenario {
  name: string;
  request: string;
  tab: Page;
}

const SCENARIOS: Scenario[] = [
  {
    // The report: a payments account's transactions, and a question about a client's invoices.
    name: "reported",
    request:
      "When's the last time I submitted an invoice for SmartBid, and can you help me submit another one for this month? I forgot to do it, I guess I should've done it on September 28th, I see that now. Yeah, help me.",
    tab: {
      url: "https://wise.com/all-transactions",
      title: "Wise - Transactions",
      text: [
        "Home Cards Transactions Expenses Payments Scheduled transfers Direct Debits Batch payments Pay Invoices Create invoices Payment links",
        "Transactions",
        "Date Details Attachment Amount",
        "Yesterday Pranshu Jain Sent 256,260.71 INR 2,660 USD",
        "11 September Nick Van Urk Sent 2,875 USD",
        "31 August Hak Cheal Noh Sent 3,000 CAD",
        "28 August SmartBid.ai LLC + 10,000 USD",
        "20 August BEATRICE ENTERTAINMENT, INC. + 4,493.89 USD",
      ].join("\n"),
      links: ["Create invoices", "Pay Invoices", "SmartBid.ai LLC"],
    },
  },
  {
    // A shop's orders, and a question about one customer that the list answers.
    name: "orders",
    request: "When did I last send Marta Okafor anything, and can you get her the tracking number? She keeps asking.",
    tab: {
      url: "https://admin.shopify.com/store/fernhill/orders",
      title: "Orders · Fernhill Ceramics · Shopify",
      text: [
        "Orders",
        "Order Date Customer Total Payment Fulfillment",
        "#1043 Oct 6 Liam Chen $84.00 Paid Unfulfilled",
        "#1042 Oct 3 Marta Okafor $212.50 Paid Fulfilled — UPS 1Z999AA10123456784",
        "#1041 Sep 29 Priya Natarajan $46.00 Refunded —",
      ].join("\n"),
      links: ["#1043", "#1042", "#1041"],
    },
  },
  {
    // A calendar week, and a question about a meeting on it.
    name: "calendar",
    request: "When was the last time I met the Lindqvist people? Set up another one with them for next week.",
    tab: {
      url: "https://calendar.google.com/calendar/u/0/r/week",
      title: "Google Calendar - Week of October 5, 2026",
      text: ["Week of October 5, 2026", "Mon Oct 5 9:00–9:30 Standup", "Tue Oct 6 14:00–15:00 Lindqvist & Co. — contract review", "Tue Oct 6 14:30–15:00 Dentist", "Thu Oct 8 11:00–12:00 Hiring sync"].join("\n"),
      links: ["Lindqvist & Co. — contract review", "Dentist"],
    },
  },
];

const MAIL: Page = {
  url: "https://mail.google.com/mail/u/0/#inbox",
  title: "Inbox (2) - Gmail",
  text: ["Inbox", "Newsletter — This week in design — Oct 7", "Bank — Your statement is ready — Oct 1"].join("\n"),
};

/**
 * The memory tools (the extension's memory.call): recall finds only an unrelated entry, as the user's memory did in
 * the report; search_history finds nothing.
 */
function memoryCall(params: unknown): { text: string } {
  const tool = (params as { tool?: string }).tool;
  if (tool === "recall") return { text: "- [m7k2] 2026-10-01 Identified the Neon invoice account: billing@neon.tech emails the monthly invoice to Gmail." };
  if (tool === "search_history") return { text: "No matching conversations." };
  return { text: "ok" };
}

/**
 * NOA_LIVE_MEMORY=1: the memory block a chat is given, shaped like the one in the reported trace: episodes of finding
 * things in the user's several Gmail accounts, and which account is which. None of it is about the scenario's page.
 */
const MEMORY = [
  "Memory from earlier chats and runs (ids in brackets). Use it before exploring; it may be out of date: when an entry proves wrong, remember the corrected fact with the same kind and subject, or forget it by id.",
  "Episodes:",
  "- [m7k2] 2026-10-01 Identified the Neon invoice account under jaeyun@modd.io: the user asked which Neon account held a $170.39 invoice. Checked jaeyun@gmail.com (free org, no match), then jaeyun@modd.io (Launch Plan, matched).",
  "- [m7k5] 2026-09-24 Found the AWS bill for August: searched Gmail in all three accounts; it was in jaeyun@modd.io from no-reply@aws.amazon.com.",
  "Accounts:",
  "- [m7a1] Google accounts in sign-in order: /u/0 jaeyun@gmail.com, /u/1 aigrowthhacker@gmail.com, /u/2 jaeyun@modd.io (work).",
].join("\n");

function log(line: string): void {
  console.log(line);
  if (process.env.NOA_LIVE_OUT) appendFileSync(process.env.NOA_LIVE_OUT, line + "\n");
}

function snapshot(p: Page): PageSnapshot {
  const elements = (p.links ?? []).map((name, i) => ({ index: i + 1, tag: "a", role: "link", name, inViewport: true }) as ElementInfo);
  return { url: p.url, title: p.title, text: p.text, elements, truncated: false };
}

/** Tabs of the run: t1 is the user's tab; open_tabs adds more (anything not mail shows the user's page's site as blank). */
class Tabs {
  tabs: { id: string; page: Page }[];
  current = "t1";
  /** Page tool calls in order: which tab they looked at, or what they opened. */
  steps: string[] = [];
  constructor(private readonly user: Page) {
    this.tabs = [{ id: "t1", page: user }];
  }
  private pageFor(url: string): Page {
    if (/mail\.google\.com/.test(url)) return { ...MAIL, url };
    if (url === this.user.url) return this.user;
    return { url, title: url, text: "(nothing relevant here)" };
  }
  private info(): AgentTabInfo[] {
    return this.tabs.map((t) => ({ id: t.id, url: t.page.url, title: t.page.title, current: t.id === this.current }));
  }
  private tab(id?: string) {
    return this.tabs.find((t) => t.id === (id ?? this.current)) ?? this.tabs[0]!;
  }
  handle(m: BrowserMethod, params: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (m) {
      case "browser.navigate": {
        this.steps.push(`navigate ${p.url}`);
        this.tab().page = this.pageFor(String(p.url));
        return { url: this.tab().page.url, title: this.tab().page.title };
      }
      case "browser.readPage": {
        const t = this.tab(p.tab as string | undefined);
        this.steps.push(`read ${t.id === "t1" && t.page === this.user ? "user-tab" : t.page.url}`);
        return snapshot(t.page);
      }
      case "browser.screenshot":
        this.steps.push(`screenshot ${this.tab().page === this.user ? "user-tab" : this.tab().page.url}`);
        return { base64: btoa("fake-jpeg"), mimeType: "image/jpeg" };
      case "browser.openTabs": {
        const urls = (p.urls as string[]) ?? [];
        this.steps.push(`open_tabs ${urls.join(" ")}`);
        const opened = urls.map((u, i) => ({ id: `t${this.tabs.length + 1 + i}`, page: this.pageFor(u) }));
        this.tabs.push(...opened);
        if (!p.background && opened[0]) this.current = opened[0].id;
        return { tabs: this.info() };
      }
      case "browser.switchTab":
        this.current = this.tab(String(p.tab)).id;
        return this.info().find((t) => t.current);
      case "browser.listTabs":
        return { tabs: this.info() };
      case "browser.closeTabs": {
        const ids = ((p.tabs as string[]) ?? []).filter((id) => id !== "t1");
        this.tabs = this.tabs.filter((t) => !ids.includes(t.id));
        if (!this.tabs.some((t) => t.id === this.current)) this.current = "t1";
        return { closed: ids, tabs: this.info() };
      }
      case "browser.currentUrl":
        return { url: this.tab().page.url };
      case "browser.waitFor":
        return { met: 0, url: this.tab().page.url, title: this.tab().page.title };
      default:
        this.steps.push(m.replace("browser.", ""));
        return { ok: true };
    }
  }
}

/** True when the run looked at the user's tab before going anywhere else. */
function startedOnUserTab(steps: string[]): boolean {
  const first = steps.find((s) => /^(read|screenshot|navigate|open_tabs)/.test(s));
  return !!first && /^(read|screenshot) user-tab/.test(first);
}

async function run(n: number, s: Scenario): Promise<boolean> {
  const tabs = new Tabs(s.tab);
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: mkdtempSync(join(tmpdir(), "noa-live-usertab-")) };
  delete env[ENV.brain];
  const host = startHost({
    env,
    methods: [
      "browser.navigate",
      "browser.readPage",
      "browser.screenshot",
      "browser.click",
      "browser.type",
      "browser.paste",
      "browser.pressKey",
      "browser.scroll",
      "browser.currentUrl",
      "browser.openTabs",
      "browser.switchTab",
      "browser.listTabs",
      "browser.closeTabs",
      "browser.waitFor",
      "memory.call" as BrowserMethod,
    ],
    browser: (m, p) => {
      if ((m as string) === "memory.call") {
        tabs.steps.push(`${(p as { tool?: string }).tool}`);
        return memoryCall(p);
      }
      return tabs.handle(m, p);
    },
    onEvent: ({ event: e }) => {
      if (e.type === "tool_call") log(`#${n} tool: ${e.name} ${JSON.stringify(e.args).slice(0, 200)}`);
      if (e.type === "assistant_text") log(`#${n} text: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`);
      if (e.type === "task_end") log(`#${n} end: ${JSON.stringify(e).slice(0, 200)}`);
    },
  });
  try {
    await host.ext.call("helper.hello", {}, { timeoutMs: 120_000 });
    await host.ext.call(
      "helper.runTask",
      {
        sessionId: `LIVE-USERTAB-${n}`,
        task: { id: `T-LIVE-USERTAB-${n}`, instructions: s.request, account: null, userTab: { url: s.tab.url, title: s.tab.title, access: "here" }, ...(process.env.NOA_LIVE_MEMORY_FILE ? { memory: readFileSync(process.env.NOA_LIVE_MEMORY_FILE, "utf8") } : process.env.NOA_LIVE_MEMORY === "1" ? { memory: MEMORY } : {}) },
        mediaPaths: [],
        // Stops after a few calls: only where the run starts is measured.
        config: { model: MODEL, maxToolCalls: 6, maxTaskMinutes: 3, jevEnabled: process.env.NOA_LIVE_JEV === "1", ...(process.env.NOA_LIVE_JEV === "1" && process.env.TYPESAFE_API_KEY ? { jevApiKey: process.env.TYPESAFE_API_KEY } : {}), jevThreshold: 0.8, isRetry: false },
      },
      { timeoutMs: 4 * 60_000 },
    );
  } catch (err) {
    log(`#${n} run ended: ${String(err).slice(0, 200)}`);
  } finally {
    host.child.stdin.end();
    setTimeout(() => host.child.exitCode === null && host.child.kill(), 1_000);
  }
  const ok = startedOnUserTab(tabs.steps);
  log(`#${n} [${s.name}] steps: ${tabs.steps.join(" | ")} -> ${ok ? "started on the user's tab" : "WENT ELSEWHERE FIRST"}`);
  return ok;
}

test.skipIf(!LIVE)("the agent starts from the page the user has open", async () => {
  const picked = process.env.NOA_LIVE_SCENARIO ? SCENARIOS.filter((s) => s.name === process.env.NOA_LIVE_SCENARIO) : SCENARIOS;
  // NOA_LIVE_REQUEST: other wording for the picked scenarios (e.g. as the voice narrator passes a request on).
  const scenarios = process.env.NOA_LIVE_REQUEST ? picked.map((s) => ({ ...s, request: process.env.NOA_LIVE_REQUEST! })) : picked;
  const results: Record<string, number> = {};
  let n = 0;
  for (const s of scenarios) {
    results[s.name] = 0;
    for (let i = 0; i < RUNS; i++) if (await run(++n, s)) results[s.name]!++;
    log(`[${s.name}] started on the user's tab in ${results[s.name]}/${RUNS} runs`);
  }
  for (const s of scenarios) expect(results[s.name]).toBe(RUNS);
});
