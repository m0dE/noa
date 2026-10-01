// Canned data for the UI harness: what the background would answer in each situation (a running
// session, a conversation, signed in or out, out of credit, ...), by scenario kind.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RAW_SESSION as rawSessionId, rawScenario } from "./raw-scenario.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMANDS = JSON.parse(readFileSync(join(root, "static", "manifest.json"), "utf8")).commands;
/** The panel's shortcuts as the manifest suggests them (what chrome.commands reports when Chrome assigned them). */
export const SHORTCUT = COMMANDS["open-chat"].suggested_key.default;
export const VOICE_SHORTCUT = COMMANDS.voice.suggested_key.default;
/** How the panel writes them ("Ctrl+Period" reads "Ctrl+.", "Ctrl+Comma" reads "Ctrl+,"). */
const label = (key) => key.split("+").map((k) => ({ Period: ".", Comma: "," })[k] ?? k).join("+");
export const SHORTCUT_LABEL = label(SHORTCUT);
export const VOICE_SHORTCUT_LABEL = label(VOICE_SHORTCUT);

/** A small JPEG "screenshot" for thumbnails (base64), rendered once by renderThumbnail(browser). */
export let thumbnail = "";
export async function renderThumbnail(browser) {
  const thumbPage = await browser.newPage({ viewport: { width: 320, height: 200 } });
  await thumbPage.setContent(
    `<body style="margin:0;font:14px system-ui;background:#fff"><div style="background:#000;color:#fff;padding:10px">X</div>
     <div style="padding:12px">What's happening?<div style="margin-top:40px;float:right;background:#1d9bf0;color:#fff;border-radius:16px;padding:6px 14px">Post</div></div></body>`,
  );
  thumbnail = (await thumbPage.screenshot({ type: "jpeg", quality: 50 })).toString("base64");
  await thumbPage.close();
}

/** A long Markdown answer (made-up sample text): headings, nested lists, bold labels, links, inline code, a code block, a quote. */
export const PUBLISH_ANSWER = [
  "Here's how to publish a Chrome extension to the **Chrome Web Store**:",
  "",
  "## 1. Prepare the package",
  "",
  "- Make sure `manifest.json` has a unique `name`, a `version` and `manifest_version: 3`.",
  "- Add icons in 16, 48 and 128 px.",
  "- Zip the extension folder (the manifest must be at the root of the zip):",
  "",
  "```sh",
  "cd my-extension",
  "zip -r ../my-extension-1.0.0.zip . -x '*.git*' 'node_modules/*' '*.map'",
  "```",
  "",
  "## 2. Register as a developer",
  "",
  "1. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) and sign in.",
  "2. Pay the one-time **$5 registration fee**.",
  "3. Verify your contact email.",
  "",
  "## 3. Upload and fill in the listing",
  "",
  "- **Store listing:** description, category, language and at least one screenshot (1280×800).",
  "- **Privacy:** declare what data you collect and justify each permission, for example:",
  "  - `tabs`: to read the active tab's URL",
  "  - `storage`: to save settings",
  "- **Distribution:** public, unlisted or private.",
  "",
  "> Review usually takes a few days; broad host permissions can make it longer.",
  "",
  "After approval the extension goes live, and updates go through the same review when you upload a new version.",
].join("\n");

export const EMAIL_ANSWER = [
  "You have **4 unread emails**. Here's what each one needs:",
  "",
  "### Needs a reply",
  "",
  "1. **Jordan Lee** (Example Corp), 9:12 AM: *Contract renewal*",
  "   - Asks whether you can sign the renewal by **Friday**.",
  "   - The draft is linked here: https://docs.example.com/d/renewal-draft-2026-final-version?usp=sharing&view=comments",
  "2. **Sam Ortiz**, yesterday: *Team offsite dates*",
  "   - Wants you to pick between Oct 14 and Oct 21.",
  "",
  "### For your information",
  "",
  "- **Billing** (no-reply@shop.example.com): order `#48213` shipped, arriving Monday.",
  "- **Newsletter**: this week's product updates; nothing to do.",
  "",
  "Want me to draft replies to Jordan and Sam?",
].join("\n");

/** The follow-up the agent suggests after the email answer (task_complete's suggestion). */
export const SUGGESTION = "Reply to Jordan and say I'll sign by Thursday";

/**
 * The job of the conversation tab 1 has in `data` (bound to it, else running there): what the old panel showed on
 * opening, now one click into the list. Its key as the panel makes it (jobs.ts): a chat's, or its task's series'.
 */
export function tabJobKey(data) {
  const st = data.state;
  const sid = st.tabChats?.["1"] ?? Object.entries(st.runningTabs ?? {}).find(([, tabs]) => tabs.includes(1))?.[0] ?? st.running?.sessionId;
  const s = [...(st.runningSessions ?? []), st.running, ...data.sessions].find((x) => x?.sessionId === sid);
  if (!s || s.source === "adhoc") return `chat:${sid}`;
  const t = data.tasks.find((x) => x.id === s.taskId);
  return `task:${(t && (t.seriesId ?? t.id)) || s.seriesId || s.taskId}`;
}

export function scenario(kind) {
  const now = Date.now();
  const iso = (minutes) => new Date(now + minutes * 60_000).toISOString();
  /** Minutes from now to the soonest of `hours` (o'clock, this machine's zone: the browser's) still to come. */
  const untilNext = (...hours) => {
    const times = hours.flatMap((h) => [0, 1].map((d) => new Date(new Date(now).setHours(24 * d + h, 0, 0, 0)).getTime()));
    return (Math.min(...times.filter((t) => t > now)) - now) / 60_000;
  };
  const helper = {
    version: "0.2.0",
    jevAvailable: true,
    claudePath: "C:\\Users\\me\\.local\\bin\\claude.exe",
    logDir: "C:\\Users\\me\\AppData\\Local\\noa\\logs",
    selfTest: { ok: true, ms: 5300, at: iso(-30) },
  };
  const running = {
    sessionId: "s-live",
    source: "local",
    taskId: "t2",
    title: "Post the launch thread on X from @noa and reply to the first comment",
    brain: "claude-api",
    jev: true,
    model: "claude-sonnet-5",
    startedAt: iso(-2),
  };
  const settings = {
    brain: "auto", anthropicApiKey: "set", anthropicModel: "claude-sonnet-5", jevApiKey: "",
    maxConsecutiveFailures: 3, retryAfterMinutes: 10, intervalMinutes: 15,
    delayMinSec: 60, delayMaxSec: 180, maxToolCalls: 60, maxTaskMinutes: 10, maxParallelTasks: 2, jevEnabled: true, jevThreshold: 0.8,
    pauseRetryMinutes: 15, accountApiBase: "https://app.noa.bot",
    voiceEngine: "realtime", speechVoice: "", speechRate: 1, realtimeVoice: "marin", realtimeSpeed: 1, realtimeCostNoticed: true, voiceSounds: true, notificationVoice: "same", deepgramVoice: "thalia", deepgramSpeed: 1, showControlOverlay: true, imageGeneration: true, imageModel: "gpt-image-2",
    automationLevel: "ask_consequential", scheduledAutomation: "full_within_task",
    memoryPaused: false, memoryKindsOff: [], reasoning: "fast", reasoningAutoRaise: true,
  };
  const state = {
    settings,
    brain: { effective: "claude-api", helper, hasApiKey: true, jevActive: true },
    running,
    nextRunAt: iso(12),
    lastRunAt: iso(-3),
    openConversations: [],
    // The panel is in window 1 and tab 1 is active; the running task acts in tab 1.
    tabChats: {},
    runningTabs: { "s-live": [1] },
  };
  // Signed in on a paid plan by default (the TODO tab shows the list); account scenarios below change it.
  const API = "https://app.noa.bot";
  const avatar =
    "data:image/svg+xml;utf8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#0f766e"/><text x="24" y="32" font-size="22" text-anchor="middle" fill="#fff" font-family="Segoe UI, sans-serif">A</text></svg>');
  const FREE = { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false };
  const PLUS = { id: "plus", status: "active", currentPeriodEnd: iso(60 * 24 * 30), cancelAtPeriodEnd: false };
  const money = (sub, top, grant = 0) => ({ subscriptionCents: sub, topupCents: top, totalCents: sub + top, periodGrantCents: grant, periodEnd: grant ? iso(60 * 24 * 30) : null });
  state.account = {
    signedIn: true, signInConfigured: true, apiBase: API, dashboardUrl: `${API}/`, billingUrl: `${API}/billing`,
    user: { email: "ada.lovelace@example.com", name: "Ada Lovelace", pictureUrl: avatar },
    plan: PLUS, credit: money(0, 0), stripeConfigured: true, fetchedAt: iso(0),
  };
  let tasksSource;
  /** The account's list came back locked (a plan without the TODO list). */
  let tasksLocked = false;
  if (kind === "loggedout" || kind === "loggedout-noclient") {
    state.account = { signedIn: false, signInConfigured: kind === "loggedout", apiBase: API, dashboardUrl: `${API}/`, billingUrl: `${API}/billing` };
    state.running = null;
  }
  if (kind === "account" || kind === "hosted-out") {
    // Signed in on Plus: the TODO list is the account's, Noa AI runs tasks.
    state.running = null;
    state.brain = { effective: "noa", helper, hasApiKey: false, jevActive: true };
    settings.anthropicApiKey = "";
    state.account = { ...state.account, plan: PLUS, credit: money(421, 1000, 2000), localTasks: 3 };
    tasksSource = "account";
  }
  if (kind === "hosted-out") {
    state.account = { ...state.account, plan: FREE, credit: money(0, 0), localTasks: undefined, outOfCredit: true };
  }
  if (kind === "opt-free" || kind === "free") state.account = { ...state.account, plan: FREE, credit: money(0, 0) };
  if (kind === "todo-locked" || kind === "todo-locked-empty") {
    // Signed in on Free: the account keeps the tasks of an earlier subscription, read-only.
    state.running = null;
    state.account = { ...state.account, plan: FREE, credit: money(0, 0) };
    tasksSource = "account";
    tasksLocked = true;
  }
  if (kind === "opt-paid") {
    state.account = { ...state.account, plan: PLUS, credit: money(1540, 1000, 2000) };
  }
  if (kind === "opt-out") state.account = { ...state.account, plan: FREE, credit: money(0, 0), outOfCredit: true };
  // A paid plan whose usage credit ran out (runs paused on a 402).
  if (kind === "opt-paid-out") state.account = { ...state.account, plan: PLUS, credit: money(0, 0, 2000), outOfCredit: true };
  if (kind === "opt-nobilling") state.account = { ...state.account, plan: FREE, credit: money(0, 0), stripeConfigured: false };
  if (kind === "opt-signedout") state.account = { signedIn: false, signInConfigured: true, apiBase: API, dashboardUrl: `${API}/`, billingUrl: `${API}/billing` };
  if (kind === "idle" || kind === "free" || kind === "empty" || kind === "noshortcut") state.running = null;
  if (kind === "nobrain") {
    state.brain = { effective: null, note: "No AI set up. Install the helper, add a Claude API key, or log in.", helper: null, helperError: "Helper not installed", hasApiKey: false, jevActive: false };
    state.running = null;
    settings.anthropicApiKey = "";
  }
  if (kind === "pause-migration") {
    // The old pause of every scheduled run could not be converted into paused jobs yet (the account's server is older).
    state.pauseMigration = "HTTP 404: not found";
    state.running = null;
  }
  const task = (id, status, instructions, extra = {}) => ({
    id, instructions, status, account: null, mediaIds: [], notBefore: null, priority: 0, attempts: 0,
    leaseOwner: null, leaseExpiresAt: null, retryAfter: null, resultSummary: null, resultUrl: null,
    resultScreenshotId: null, pauseReason: null, failReason: null, createdAt: iso(-600), updatedAt: iso(-60),
    repeat: null, media: [], ...extra,
  });
  const tasks = [
    task("t2", "running", running.title, { account: "noa" }),
    task("t1", "pending", "Reply to new mentions with a short thank-you\nKeep it friendly.", { account: "noa", notBefore: iso(untilNext(9, 18)), repeat: { cron: "0 9,18 * * *", tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }),
    task("t3", "pending", "Post the photo of the week with the caption from the doc", { media: [{ id: "m1", name: "week38.jpg", type: "image/jpeg", size: 184000 }] }),
    task("t4", "pending", "Like the three newest posts from @anthropic", { retryAfter: iso(8), attempts: 1 }),
    task("t5", "paused", "Log in to example.com and download the September invoice", { pauseReason: "Needs a one-time code sent by SMS" }),
    task("t6", "done", "Post 'good morning' on X", { account: "noa", resultUrl: "https://x.com/noa/status/1838912345678901234", updatedAt: iso(-180) }),
    task("t7", "failed", "Share yesterday's blog post on LinkedIn", { failReason: "LinkedIn asked for a captcha", updatedAt: iso(-1500) }),
  ];
  const ev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-live" });
  const events = [
    ev(-2, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
    ev(-2, { type: "assistant_text", text: "I'll open X, check that the right account is active, then write the thread." }),
    ev(-2, { type: "tool_call", id: "1", name: "switch_x_account", args: { handle: "@noa" } }),
    ev(-2, { type: "tool_result", id: "1", name: "switch_x_account", text: "Already on @noa" }),
    ev(-2, { type: "tool_call", id: "2", name: "navigate", args: { url: "https://x.com/compose/post" } }),
    ev(-2, { type: "tool_result", id: "2", name: "navigate", text: "Opened https://x.com/compose/post (title: Compose new post / X)" }),
    ev(-1, { type: "tool_call", id: "3", name: "act", args: { steps: [{ goal: "focus the post text box" }, { goal: "type the first post", text: "We just shipped..." }, { goal: "add another post to the thread" }] } }),
    ev(-1, { type: "jev", goal: "focus the post text box", operation: "click", index: 14, confidence: 0.97, executed: true, ms: 184 }),
    ev(-1, { type: "jev", goal: "type the first post", operation: "type", index: 14, confidence: 0.93, executed: true, ms: 211 }),
    ev(-1, { type: "jev", goal: "add another post to the thread", operation: "click", index: null, confidence: 0.42, executed: false, ms: 176 }),
    ev(-1, { type: "tool_result", id: "3", name: "act", text: "step 1 ok\nstep 2 ok\nstep 3 not confident: no element matched 'add another post'. Use click/type.\n" + "[12] button \"Add post\"\n[13] button \"Post all\"\n".repeat(3) }),
    ev(-1, { type: "tool_call", id: "4", name: "screenshot", args: {} }),
    ev(-1, { type: "tool_result", id: "4", name: "screenshot", thumbnail }),
    ev(-1, { type: "user_message", text: "Use the second draft for the last post, please" }),
    ev(0, { type: "assistant_text", text: "Got it, switching the last post to the second draft." }),
    ev(0, { type: "tool_call", id: "5", name: "type", args: { index: 22, text: "Try it: add a task, close the laptop lid, and it still posts on time." } }),
  ];
  const sessions = [
    running,
    { sessionId: "s-2", source: "local", taskId: "t6", title: "Post 'good morning' on X", brain: "claude-code", jev: false, startedAt: iso(-182), endedAt: iso(-180), outcome: "done", url: "https://x.com/noa/status/1838912345678901234" },
    { sessionId: "s-3", source: "adhoc", title: "Find the cheapest flight to Lisbon next weekend", brain: "claude-api", jev: true, startedAt: iso(-400), endedAt: iso(-390), outcome: "paused", reason: "Needs you to pick dates" },
    { sessionId: "s-4", source: "local", taskId: "t7", title: "Share yesterday's blog post on LinkedIn", brain: "claude-api", jev: true, startedAt: iso(-1502), endedAt: iso(-1500), outcome: "failed", reason: "LinkedIn asked for a captcha" },
  ];
  if (kind === "idle") tasks[0] = { ...tasks[0], status: "pending", notBefore: iso(40) };
  if (kind === "empty" || kind === "todo-locked-empty") tasks.splice(0, tasks.length);
  if (kind === "views") {
    // Every kind of scheduled job: more upcoming than Home shows, one the user paused, one paused after failures.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    tasks.push(
      task("t8", "pending", "Send the weekly report to the team", { notBefore: iso(60 * 26), repeat: { cron: "0 10 * * 1", tz } }),
      task("t9", "pending", "Renew the domain before it expires", { notBefore: iso(60 * 24 * 6) }),
      task("t10", "paused", "Post a tip about keyboard shortcuts on X", { account: "noa", pauseReason: "Paused by you", repeat: { cron: "0 8 * * *", tz } }),
      task("t11", "paused", "Check the store for new orders and reply to buyers", { pauseReason: "Paused after 3 failed runs in a row. Last: the orders page did not load", repeat: { cron: "0 */4 * * *", tz } }),
    );
  }
  const eventsBySession = {};
  if (kind === "parallel") {
    // Two due tasks run at once, each in its own tab.
    const second = {
      sessionId: "s-par2", source: "local", taskId: "t3", title: "Post the photo of the week with the caption from the doc",
      brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: iso(-1),
    };
    const pev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-par2" });
    eventsBySession["s-par2"] = [
      pev(-1, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
      pev(-1, { type: "assistant_text", text: "Opening the doc to copy the caption." }),
      pev(-1, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://docs.example.com/d/week38" } }),
      pev(-1, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://docs.example.com/d/week38 (title: Week 38 caption)" }),
    ];
    state.runningSessions = [running, second];
    state.runningTabs = { "s-live": [1], "s-par2": [2] };
    sessions.unshift(second);
    tasks[2] = { ...tasks[2], status: "running" };
  }
  if (kind === "tabs") {
    // A one-off chat runs in tab 1 (it belongs there); tab 2 has no chat yet.
    running.source = "adhoc";
    running.title = "Summarize this pull request and post the summary as a comment";
    running.instructions = running.title;
    state.tabChats = { "1": "s-live" };
    state.runningTabs = { "s-live": [1] };
  }
  if (kind === "conversation") {
    // A one-off conversation with two turns: the second started with the user's message.
    const conv = {
      sessionId: "s-conv", source: "adhoc", title: "Post on X from @alpha: our launch is live", instructions: "Post on X from @alpha: our launch is live", brain: "claude-code", jev: true,
      model: "claude-sonnet-5", startedAt: iso(-2), endedAt: iso(-1), firstStartedAt: iso(-6), outcome: "done", turns: 2,
      summary: "Liked the first reply", url: "https://x.com/alpha/status/1838912345678901299",
      logPath: "C:\\Users\\me\\AppData\\Local\\noa\\runs\\s-conv-2026\\log.jsonl",
    };
    const cev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-conv" });
    eventsBySession["s-conv"] = [
      cev(-6, { type: "status", text: "Claude Code started (claude-sonnet-5)" }),
      cev(-6, { type: "assistant_text", text: "I'll switch to @alpha and post it." }),
      cev(-6, { type: "tool_call", id: "1", name: "switch_x_account", args: { handle: "@alpha" } }),
      cev(-6, { type: "tool_result", id: "1", name: "switch_x_account", text: "Switched to @alpha" }),
      cev(-5, { type: "tool_call", id: "2", name: "act", args: { steps: [{ goal: "type into the Post text box", text: "Our launch is live" }, { goal: "click the Post button in the composer" }] } }),
      cev(-5, { type: "jev", goal: "type into the Post text box", operation: "type", index: 14, confidence: 0.99, executed: true, ms: 96 }),
      cev(-5, { type: "jev", goal: "click the Post button in the composer", operation: "click", index: 22, confidence: 0.98, executed: true, ms: 81 }),
      cev(-5, { type: "tool_result", id: "2", name: "act", text: "step 1 ok\nstep 2 ok" }),
      cev(-5, { type: "status", text: "Jev chose 2 of 2 element picks (clicks and typing)", picks: { jev: 2, claude: 0 } }),
      cev(-5, { type: "status", text: "Post verified" }),
      cev(-5, { type: "task_end", outcome: "done", summary: "Posted from @alpha", url: "https://x.com/alpha/status/1838912345678901234" }),
      cev(-2, { type: "user_message", text: "Now like the first reply to it" }),
      cev(-2, { type: "status", text: "Continuing the same Claude Code session" }),
      cev(-2, { type: "assistant_text", text: "Opening the post and liking the first reply." }),
      cev(-2, { type: "tool_call", id: "3", name: "navigate", args: { url: "https://x.com/alpha/status/1838912345678901234" } }),
      cev(-2, { type: "tool_result", id: "3", name: "navigate", text: "Opened https://x.com/alpha/status/1838912345678901234" }),
      cev(-1, { type: "tool_call", id: "4", name: "act", args: { steps: [{ goal: "click the Like button under the first reply" }] } }),
      cev(-1, { type: "jev", goal: "click the Like button under the first reply", operation: "click", index: 31, confidence: 0.62, executed: false, ms: 120 }),
      cev(-1, { type: "tool_result", id: "4", name: "act", text: "not confident at step 1" }),
      cev(-1, { type: "tool_call", id: "5", name: "act", args: { steps: [{ goal: "click the Like button under the first reply", index: 31 }] } }),
      cev(-1, { type: "tool_result", id: "5", name: "act", text: "step 1: clicked [31] (picked by Claude)" }),
      cev(-1, { type: "status", text: "Jev chose 0 of 1 element pick (clicks and typing); Claude chose 1", picks: { jev: 0, claude: 1 } }),
      cev(-1, { type: "task_end", outcome: "done", summary: "Liked the first reply", url: "https://x.com/alpha/status/1838912345678901299" }),
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-conv" };
    state.brain = { ...state.brain, effective: "claude-code", jevActive: false };
    state.openConversations = ["s-conv"];
    sessions.unshift(conv);
    sessions.splice(1, 1);
  }
  if (kind === "answer" || kind === "streaming" || kind === "suggest") {
    // A question answered in the chat. Turn 1: an older run that put the whole answer (Markdown) into
    // task_complete's summary. Turn 2: the answer as the agent's own text, then a one-line summary.
    // Made-up sample content only.
    const ans = {
      sessionId: "s-ans", source: "adhoc", title: "how do I publish a Chrome extension", brain: "claude-code", jev: false,
      model: "claude-sonnet-5", startedAt: iso(-2), endedAt: iso(-1), firstStartedAt: iso(-9), outcome: "done", turns: 2,
      summary: "Summarized 4 unread emails",
    };
    const aev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-ans" });
    eventsBySession["s-ans"] = [
      aev(-9, { type: "status", text: "Claude Code started (claude-sonnet-5)" }),
      aev(-8, { type: "tool_call", id: "1", name: "task_complete", args: { summary: PUBLISH_ANSWER } }),
      aev(-8, { type: "tool_result", id: "1", name: "task_complete", text: "Task marked complete." }),
      aev(-8, { type: "task_end", outcome: "done", summary: PUBLISH_ANSWER }),
      aev(-3, { type: "user_message", text: "Summarize my unread email" }),
      aev(-3, { type: "status", text: "Continuing the same Claude Code session" }),
      aev(-3, { type: "assistant_text", text: "I'll open your inbox and read the unread messages." }),
      aev(-3, { type: "tool_call", id: "2", name: "navigate", args: { url: "https://mail.example.com/inbox" } }),
      aev(-3, { type: "tool_result", id: "2", name: "navigate", text: "Opened https://mail.example.com/inbox (title: Inbox (4))" }),
      aev(-3, { type: "tool_call", id: "3", name: "read_page", args: {} }),
      aev(-3, { type: "tool_result", id: "3", name: "read_page", text: "URL: https://mail.example.com/inbox\n4 unread conversations" }),
      aev(-2, { type: "tool_call", id: "4", name: "open_tabs", args: { urls: ["https://mail.example.com/m/1", "https://mail.example.com/m/2", "https://mail.example.com/m/3", "https://mail.example.com/m/4"] } }),
      aev(-2, { type: "tool_result", id: "4", name: "open_tabs", text: "Opened t2, t3, t4, t5" }),
      aev(-2, { type: "tool_call", id: "5", name: "read_page", args: { tabs: ["t2", "t3", "t4", "t5"] } }),
      aev(-2, { type: "tool_result", id: "5", name: "read_page", text: "4 pages read" }),
      aev(-2, { type: "tool_call", id: "6", name: "close_tabs", args: { tabs: ["t2", "t3", "t4", "t5"] } }),
      aev(-2, { type: "tool_result", id: "6", name: "close_tabs", text: "Closed 4 tabs" }),
      aev(-1, { type: "assistant_text", text: EMAIL_ANSWER }),
      aev(-1, { type: "tool_call", id: "7", name: "task_complete", args: { summary: "Summarized 4 unread emails" } }),
      aev(-1, { type: "tool_result", id: "7", name: "task_complete", text: "Task marked complete." }),
      aev(-1, { type: "task_end", outcome: "done", summary: "Summarized 4 unread emails" }),
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-ans" };
    state.brain = { ...state.brain, effective: "claude-code", jevActive: false };
    state.openConversations = ["s-ans"];
    sessions.unshift(ans);
    sessions.splice(1, 1);
    if (kind === "suggest") {
      // The turn ended with a follow-up suggestion: kept with the session, offered in the box.
      ans.suggestion = SUGGESTION;
      Object.assign(eventsBySession["s-ans"].at(-1), { suggestion: SUGGESTION });
    }
    if (kind === "streaming") {
      // The second turn is still being written: the harness pushes its text in pieces.
      const live = { ...ans, endedAt: undefined, outcome: undefined, summary: undefined };
      delete live.endedAt;
      delete live.outcome;
      delete live.summary;
      eventsBySession["s-ans"] = eventsBySession["s-ans"].slice(0, -4);
      sessions[0] = live;
      state.running = live;
      state.runningSessions = [live];
      state.runningTabs = { "s-ans": [1] };
    }
  }
  if (kind === "voice-chat") {
    // A hands-free conversation: spoken messages (the mic mark), the plan and the result said aloud (spoken lines,
    // the plan compact since the text above says it), a typed follow-up, and the narrator's reply. Made-up content.
    const vc = {
      sessionId: "s-voice", source: "adhoc", title: "Read my newest email", instructions: "Read my newest email", voice: true,
      brain: "noa", jev: true, model: "claude-sonnet-5", startedAt: iso(-2), endedAt: iso(-1), firstStartedAt: iso(-6),
      outcome: "done", turns: 2, summary: "Archived Sarah's email",
    };
    const vev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-voice" });
    eventsBySession["s-voice"] = [
      vev(-6, { type: "assistant_text", text: "I'll open Gmail and read your newest email." }),
      vev(-6, { type: "spoken", text: "I'll open Gmail and read your newest email." }),
      vev(-6, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://mail.google.com/mail/u/0/#inbox" } }),
      vev(-6, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://mail.google.com/mail/u/0/#inbox (title: Inbox (1))" }),
      vev(-5, { type: "tool_call", id: "2", name: "read_page", args: {} }),
      vev(-5, { type: "tool_result", id: "2", name: "read_page", text: "1 unread conversation" }),
      vev(-5, { type: "assistant_text", text: "Your newest email is from **Sarah**: dinner on Friday moved from 7 to 8 pm, same place. She asks you to confirm by Thursday." }),
      vev(-5, { type: "task_end", outcome: "done", summary: "Read Sarah's email", spoken: "Sarah says Friday's dinner moved to eight. She wants a yes by Thursday." }),
      vev(-5, { type: "spoken", text: "Sarah says Friday's dinner moved to eight. She wants a yes by Thursday." }),
      vev(-3, { type: "user_message", text: "Tell her yes and archive it", voice: true }),
      vev(-3, { type: "user_message", text: "sign it Ada" }),
      vev(-2, { type: "tool_call", id: "3", name: "act", args: { steps: [{ goal: "click Reply" }, { goal: "type the reply", text: "Yes, see you at 8! Ada" }, { goal: "click Send" }] } }),
      vev(-2, { type: "tool_result", id: "3", name: "act", text: "step 1 ok\nstep 2 ok\nstep 3 ok" }),
      vev(-2, { type: "tool_call", id: "4", name: "act", args: { steps: [{ goal: "click Archive" }] } }),
      vev(-2, { type: "tool_result", id: "4", name: "act", text: "step 1 ok" }),
      vev(-1, { type: "task_end", outcome: "done", summary: "Replied yes and archived Sarah's email", spoken: "Done: I said yes and archived it." }),
      vev(-1, { type: "spoken", text: "Done: I said yes and archived it. Anything else?" }),
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-voice" };
    state.brain = { effective: "noa", helper, hasApiKey: false, jevActive: true };
    state.account = { ...state.account, plan: PLUS, credit: money(421, 1000, 2000) };
    state.openConversations = ["s-voice"];
    sessions.unshift(vc);
    sessions.splice(1, 1);
  }
  if (kind === "stopped") {
    // The user pressed Stop after the agent typed the post: the run ends paused "stopped by user".
    const stopped = {
      sessionId: "s-stop", source: "adhoc", title: "make a post on X for me about how Noa keeps posting while the laptop sleeps",
      brain: "claude-code", jev: false, startedAt: iso(-3),
    };
    const post = "Close the laptop lid, and Noa still posts on time. Your todo list runs in your own browser, on a schedule, with your own accounts. Try it";
    const sev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-stop" });
    eventsBySession["s-stop"] = [
      sev(-3, { type: "status", text: "Claude Code started" }),
      sev(-3, { type: "assistant_text", text: "I'll open X and write the post." }),
      sev(-3, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://x.com/home" } }),
      sev(-3, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://x.com/home (title: Home / X)" }),
      sev(-2, { type: "tool_call", id: "2", name: "click", args: { index: 31 } }),
      sev(-2, { type: "tool_result", id: "2", name: "click", text: "clicked [31] textbox \"Post text\"" }),
      sev(-2, { type: "tool_call", id: "3", name: "type", args: { index: 31, text: post } }),
      sev(-2, { type: "tool_result", id: "3", name: "type", text: `typed ${post.length} characters` }),
    ];
    eventsBySession["s-3"] = [
      { type: "assistant_text", text: "Searching flights to Lisbon for next weekend." },
      { type: "tool_call", id: "1", name: "navigate", args: { url: "https://www.google.com/travel/flights" } },
      { type: "tool_result", id: "1", name: "navigate", text: "Opened https://www.google.com/travel/flights" },
      { type: "task_end", outcome: "paused", reason: "Needs you to pick dates" },
    ].map((e) => ({ ...e, ts: iso(-395), sessionId: "s-3" }));
    state.running = stopped;
    state.tabChats = { "1": "s-stop" };
    state.runningTabs = { "s-stop": [1] };
    tasks[0] = { ...tasks[0], status: "pending", notBefore: iso(40) };
    tasks[4] = { ...tasks[4], attempts: 1 };
    sessions.unshift({ ...stopped, endedAt: iso(-1), outcome: "paused", reason: "stopped by user" });
    sessions.splice(1, 1);
    sessions.push({ sessionId: "s-5", source: "local", taskId: "t5", title: tasks[4].instructions, brain: "claude-api", jev: true, startedAt: iso(-70), endedAt: iso(-60), outcome: "paused", reason: "Needs a one-time code sent by SMS" });
  }
  if (kind === "hosted-out") {
    // The last run hit the end of the usage credit: paused, with a Top up link.
    const out = {
      sessionId: "s-out", source: "adhoc", title: "Summarize the three newest issues on the tracker", brain: "noa", jev: true,
      model: "claude-sonnet-5", startedAt: iso(-3), endedAt: iso(-2), outcome: "paused", reason: "Out of usage credit",
    };
    const oev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-out" });
    eventsBySession["s-out"] = [
      oev(-3, { type: "status", text: "Noa AI (claude-sonnet-5) with Jev" }),
      oev(-3, { type: "assistant_text", text: "Opening the tracker." }),
      oev(-3, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://tracker.example.com/issues" } }),
      oev(-3, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://tracker.example.com/issues" }),
      oev(-2, { type: "error", text: "Out of usage credit: No usage credit left" }),
      oev(-2, { type: "task_end", outcome: "paused", reason: "Out of usage credit" }),
    ];
    sessions.unshift(out);
    state.tabChats = { "1": "s-out" };
    tasks[0] = { ...tasks[0], status: "paused", pauseReason: "Out of usage credit", attempts: 1 };
  }
  if (kind.startsWith("err-")) {
    // A failed turn in the chat of tab 1: each shows its error once, in plain words, with the button that fixes it.
    const failures = {
      // The server's own AI key was refused (502 hosted_ai_unavailable): the error event, then the end with the same reason.
      "err-hosted": { brain: "noa", model: "claude-opus-5-5", error: "Noa AI is unavailable right now", outcome: "failed", reason: "Noa AI is unavailable right now" },
      // Local Claude Code's helper went away mid-turn: no error event, only the end's reason.
      "err-helper": { brain: "claude-code", outcome: "retry", reason: "helper disconnected: Native host has exited." },
      "err-ratelimit": {
        brain: "claude-api", error: "Claude API rate limit (HTTP 429: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit)",
        outcome: "retry", reason: "Claude API rate limit (HTTP 429: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit); gave up after 4 attempts",
      },
      // An error the panel does not know: a generic line, Retry, and the text behind Details.
      "err-unknown": {
        brain: "claude-api", error: "Claude API error (HTTP 400: invalid_request_error: prompt is too long: 250312 tokens > 200000 maximum)",
        outcome: "failed", reason: "Claude API error (HTTP 400: invalid_request_error: prompt is too long: 250312 tokens > 200000 maximum)",
      },
    };
    const f = failures[kind];
    const s = {
      sessionId: "s-err", source: "adhoc", title: "Summarize the three newest issues on the tracker", brain: f.brain, jev: true,
      ...(f.model ? { model: f.model } : {}), startedAt: iso(-3), endedAt: iso(-2), outcome: f.outcome, reason: f.reason,
    };
    const eev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-err" });
    eventsBySession["s-err"] = [
      eev(-3, { type: "assistant_text", text: "Opening the tracker." }),
      eev(-3, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://tracker.example.com/issues" } }),
      eev(-3, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://tracker.example.com/issues" }),
      ...(f.error ? [eev(-2, { type: "error", text: f.error })] : []),
      eev(-2, { type: "task_end", outcome: f.outcome, reason: f.reason }),
    ];
    sessions.unshift(s);
    state.running = null;
    state.tabChats = { "1": "s-err" };
    if (f.brain === "noa") {
      state.brain = { effective: "noa", helper, hasApiKey: false, jevActive: true };
      settings.anthropicApiKey = "";
    }
  }
  if (kind === "scheduled" || kind === "scheduled-free") {
    // Scheduling from the chat (schedule_task): the agent checked an order, then the user asked for a check-up
    // later. On Plus the task is in the TODO list with a card (View in TODO, Undo); on Free the refusal's card.
    const free = kind === "scheduled-free";
    const check = "Open https://shop.example.com/orders/48213 and tell me whether order #48213 has shipped yet; if it has, give me the carrier and tracking number.";
    const conv = {
      sessionId: "s-sched", source: "adhoc", title: "Has my order #48213 shipped?", brain: "claude-api", jev: true,
      model: "claude-sonnet-5", startedAt: iso(-1), endedAt: iso(0), firstStartedAt: iso(-6), outcome: "done", turns: 2,
      summary: free ? "Could not schedule the check-up" : "Scheduled a check-up in 3 hours",
    };
    const sev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-sched" });
    const turn2 = [
      sev(-1, { type: "user_message", text: "k schedule a check up after 3 hours" }),
      sev(-1, { type: "tool_call", id: "3", name: "schedule_task", args: { task: check, schedule: { at: iso(180) } } }),
      ...(free
        ? [
            sev(-1, { type: "error", text: "Scheduling needs a paid plan." }),
            sev(-1, { type: "tool_result", id: "3", name: "schedule_task", isError: true, text: "Scheduling needs a paid plan. Nothing was scheduled. Tell the user; the chat shows them a Choose a plan button. Do not retry." }),
            sev(0, { type: "assistant_text", text: "I couldn't schedule that: scheduling needs a paid plan. You can pick one with the button above, then ask me again." }),
          ]
        : [
            sev(-1, { type: "task_scheduled", taskId: "t-sched", instructions: check, schedule: { at: iso(180) } }),
            sev(-1, { type: "tool_result", id: "3", name: "schedule_task", text: 'Scheduled in the user\'s TODO list (task t-sched): "Open https://shop.example.com/orders/48213…" · Once, today at 6:45 PM.' }),
            sev(0, { type: "assistant_text", text: "Done. I'll check order #48213 again today at 6:45 PM; it's in your TODO list." }),
          ]),
      sev(0, { type: "task_end", outcome: "done", summary: conv.summary }),
    ];
    eventsBySession["s-sched"] = [
      sev(-6, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
      sev(-6, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://shop.example.com/orders/48213" } }),
      sev(-6, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://shop.example.com/orders/48213 (title: Order #48213)" }),
      sev(-5, { type: "tool_call", id: "2", name: "read_page", args: {} }),
      sev(-5, { type: "tool_result", id: "2", name: "read_page", text: "Order #48213 · Status: Preparing to ship" }),
      sev(-5, { type: "assistant_text", text: "Not yet: order #48213 is still **preparing to ship**." }),
      sev(-5, { type: "task_end", outcome: "done", summary: "Order #48213 has not shipped yet" }),
      ...turn2,
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-sched" };
    sessions.unshift(conv);
    if (free) state.account = { ...state.account, plan: FREE, credit: money(0, 0) };
    else {
      tasksSource = "account";
      tasks.splice(1, 0, task("t-sched", "pending", check, { notBefore: iso(180), createdAt: iso(-1), updatedAt: iso(-1) }));
    }
  }
  if (kind === "todo-changes") {
    // The TODO tools from a calendar: the agent moved the Vendor call task this chat scheduled (a Changed card, no
    // approval), then cancelled the dentist task the user made in the TODO tab (its approval, allowed once, and a
    // Cancelled card). Both cards have View in TODO and Undo.
    const vendor = "Open the Vendor call meeting link https://meet.example.com/vendor-call and join the call.";
    const dentist = "Dentist appointment: leave the office by 2:30 PM.";
    const conv = {
      sessionId: "s-todo", source: "adhoc", title: "Look at my calendar and add Thursday's Vendor call to our schedule", brain: "claude-code", jev: false,
      startedAt: iso(-1), endedAt: iso(0), firstStartedAt: iso(-8), outcome: "done", turns: 3, summary: "Cancelled the dentist TODO",
    };
    const tev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-todo" });
    eventsBySession["s-todo"] = [
      tev(-8, { type: "status", text: "Claude Code" }),
      tev(-8, { type: "tool_call", id: "1", name: "schedule_task", args: { task: vendor, schedule: { at: iso(60 * 24 + 50) } } }),
      tev(-8, { type: "task_scheduled", taskId: "t-vendor", instructions: vendor, schedule: { at: iso(60 * 24 + 50) } }),
      tev(-8, { type: "assistant_text", text: "Added: the Vendor call link opens tomorrow, 10 minutes before the call." }),
      tev(-8, { type: "task_end", outcome: "done", summary: "Scheduled the Vendor call" }),
      tev(-4, { type: "user_message", text: "move the Vendor call TODO two days from now" }),
      tev(-4, { type: "tool_call", id: "2", name: "update_scheduled_task", args: { task_id: "t-vendor", schedule: { at: iso(60 * 48) } } }),
      tev(-4, {
        type: "task_changed", changeId: "c-move", taskId: "t-vendor", change: "updated", instructions: vendor, schedule: { at: iso(60 * 48) },
        before: { instructions: vendor, account: null, schedule: { at: iso(60 * 24 + 50) } },
      }),
      tev(-4, { type: "assistant_text", text: "Moved: the Vendor call task now runs two days from now, at this time of day (your time)." }),
      tev(-4, { type: "task_end", outcome: "done", summary: "Moved the Vendor call TODO" }),
      tev(-1, { type: "user_message", text: "cancel the TODO for the dentist" }),
      tev(-1, { type: "tool_call", id: "3", name: "list_scheduled_tasks", args: {} }),
      tev(-1, { type: "tool_call", id: "4", name: "cancel_scheduled_task", args: { task_id: "t-dentist" } }),
      tev(-1, { type: "approval_request", request: { id: "ap-todo", action: 'Cancel the scheduled job "Dentist appointment: leave the office by 2:30 PM."', site: "", why: "cancels one of your scheduled jobs", expiresAt: iso(9) } }),
      tev(-1, { type: "approval_resolved", id: "ap-todo", outcome: "allow_once" }),
      tev(-1, { type: "task_changed", changeId: "c-cancel", taskId: "t-dentist", change: "cancelled", instructions: dentist, schedule: { at: iso(60 * 26) } }),
      tev(0, { type: "assistant_text", text: "Cancelled the dentist TODO; Undo on the card puts it back." }),
      tev(0, { type: "task_end", outcome: "done", summary: conv.summary }),
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-todo" };
    sessions.unshift(conv);
    tasksSource = "account";
    tasks.splice(1, 0, task("t-vendor", "pending", vendor, { notBefore: iso(60 * 48), createdAt: iso(-8), updatedAt: iso(-4) }));
    tasks.splice(2, 0, task("t-dentist", "cancelled", dentist, { notBefore: iso(60 * 26), createdAt: iso(-60 * 24), updatedAt: iso(-1) }));
  }
  if (kind === "approval") {
    // "Ask before posting, sending or paying": the agent wrote the post; its Post click waits for the user's OK.
    // An earlier approval in the thread (the Like it was allowed once) keeps one quiet line.
    const post = "We just shipped Noa 0.3: approvals before anything is posted, sent or paid.\n\nhttps://noa.example.com/blog/0-3";
    const conv = {
      sessionId: "s-appr", source: "adhoc", title: "Post the 0.3 launch note on X", brain: "claude-api", jev: true,
      model: "claude-sonnet-5", startedAt: iso(-2), firstStartedAt: iso(-2), instructions: "Like the pinned post, then post the 0.3 launch note on X",
    };
    const aev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-appr" });
    eventsBySession["s-appr"] = [
      aev(-2, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
      aev(-2, { type: "tool_call", id: "1", name: "act", args: { steps: [{ goal: "click Like on the pinned post" }] } }),
      aev(-2, { type: "approval_request", request: { id: "ap-1", action: 'Click "Like"', site: "x.com", why: "publishes", kind: "publish", expiresAt: iso(8) } }),
      aev(-2, { type: "approval_resolved", id: "ap-1", outcome: "allow_once" }),
      aev(-2, { type: "tool_result", id: "1", name: "act", text: 'step 1: clicked [12] button "Like" (picked by Jev, 0.99, 91 ms)' }),
      aev(-1, { type: "assistant_text", text: "Liked. Now writing the launch note." }),
      aev(-1, { type: "tool_call", id: "2", name: "act", args: { steps: [{ goal: "type the post", text: post }, { goal: "click Post" }] } }),
      aev(0, { type: "approval_request", request: { id: "ap-2", action: 'Click "Post"', site: "x.com", why: "publishes", kind: "publish", text: post, expiresAt: iso(10) } }),
    ];
    state.running = conv;
    state.runningTabs = { "s-appr": [1] };
    state.tabChats = { "1": "s-appr" };
    sessions.unshift(conv);
  }
  if (kind === "dialog") {
    // A page's browser dialogs in a finished run: a harmless-looking "Clean up" asked confirm("Delete “Report Q3”?"),
    // whose OK waited for the user's approval; then the agent's navigation met "Leave site?", which nobody answered,
    // so it was cancelled automatically. Each dialog is one line among the steps.
    const conv = {
      sessionId: "s-dlg", source: "adhoc", title: "Clean up the old reports", instructions: "Clean up the old reports, then open the newsletter draft", brain: "claude-api", jev: false,
      model: "claude-sonnet-5", startedAt: iso(-4), endedAt: iso(0), firstStartedAt: iso(-4), outcome: "done", summary: "Deleted Report Q3",
    };
    const frozen = (d) => `A browser dialog is open: ${d}. The page is frozen until it is answered: call handle_dialog (accept false: Cancel / Stay on the page; true: OK / Leave).`;
    const dev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-dlg" });
    const confirm = { type: "confirm", message: "Delete “Report Q3”?", url: "https://reports.example.com/list" };
    eventsBySession["s-dlg"] = [
      dev(-4, { type: "status", text: "Claude API (claude-sonnet-5)" }),
      dev(-4, { type: "tool_call", id: "1", name: "act", args: { steps: [{ goal: "click Clean up", index: 4 }] } }),
      dev(-4, { type: "tool_result", id: "1", name: "act", text: `step 1: "click Clean up": ${frozen("confirm “Delete “Report Q3”?”")}` }),
      dev(-3, { type: "tool_call", id: "2", name: "handle_dialog", args: { accept: true } }),
      dev(-3, { type: "approval_request", request: { id: "ap-d", action: "Confirm “Delete “Report Q3”?”", site: "reports.example.com", why: "deletes", kind: "delete", expiresAt: iso(7) } }),
      dev(-3, { type: "approval_resolved", id: "ap-d", outcome: "allow_once" }),
      dev(-3, { type: "dialog", dialog: confirm, outcome: "accepted", by: "agent", tab: "t1" }),
      dev(-3, { type: "tool_result", id: "2", name: "handle_dialog", text: "Pressed OK on the confirm “Delete “Report Q3”?” in t1. Read the page to see what it did." }),
      dev(-2, { type: "tool_call", id: "3", name: "navigate", args: { url: "https://docs.example.com/newsletter" } }),
      dev(-2, { type: "tool_result", id: "3", name: "navigate", text: `navigate failed: ${frozen("beforeunload “Leave site? Changes you made may not be saved.”")}`, isError: true }),
      dev(-1, { type: "dialog", dialog: { type: "beforeunload", message: "", url: "https://reports.example.com/list" }, outcome: "dismissed", by: "auto", tab: "t1" }),
      dev(0, { type: "assistant_text", text: "Deleted **Report Q3**. The reports page then asked to leave with unsaved changes, so I stayed on it: nothing there was lost." }),
      dev(0, { type: "task_end", outcome: "done", summary: "Deleted Report Q3" }),
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-dlg" };
    state.openConversations = ["s-dlg"];
    sessions.unshift(conv);
  }
  if (kind === "approval-paused") {
    // A daily scheduled post ran with nobody watching: its Post click needed the user's OK, so the run paused there.
    // Its long instructions open the thread; Jev picked for it; the run said why it paused. The page shows the card
    // alone (Allow & continue, Don't); the rest is for the Raw view.
    state.running = null;
    tasksSource = "account";
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const instructions = [
      "Post one short update about Noa on X from @noa.",
      "Product, features and vision only; never pricing.",
      "Keep it under 200 characters.",
      "Check the last two weeks of posts first and never repeat one.",
      "Link the docs page of the feature it is about.",
      "No hashtags, no emoji.",
      "If X asks to confirm the login, stop and tell me.",
      "Reply to nobody.",
    ].join("\n");
    const post = "Scheduled jobs now keep a history of every run: open a job to see how each one went, filter the failed ones, and edit what the next run does. https://noa.example.com/docs/jobs";
    const action = 'Click "Post" as @noa';
    const reason = `Needs your OK to: ${action} (publishes) — open to allow`;
    tasks.splice(0, 0, task("t-post", "paused", instructions, { account: "noa", seriesId: "t-post", repeat: { cron: "0 9 * * *", tz: zone }, attempts: 1, pauseReason: reason, retryAfter: iso(14), updatedAt: iso(-1) }));
    const conv = {
      sessionId: "s-paused", source: "cloud", taskId: "t-post", seriesId: "t-post", title: "Post one short update about Noa on X from @noa.",
      instructions, account: "noa", brain: "noa", jev: true, model: "claude-sonnet-5", startedAt: iso(-4), firstStartedAt: iso(-4), endedAt: iso(-1), outcome: "paused", reason,
    };
    const pev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-paused" });
    eventsBySession["s-paused"] = [
      pev(-4, { type: "status", text: "Noa AI (claude-sonnet-5) with Jev" }),
      pev(-3, { type: "assistant_text", text: "Checked the last two weeks of posts. Writing about run history." }),
      pev(-2, { type: "tool_call", id: "1", name: "act", args: { steps: [{ goal: "type the post", text: post }, { goal: "click Post" }] } }),
      pev(-2, { type: "jev", goal: "type the post", operation: "type", index: 7, confidence: 0.97, executed: true, ms: 120 }),
      pev(-2, { type: "jev", goal: "click Post", operation: "click", index: 8, confidence: 1, executed: false, ms: 95 }),
      pev(-1, { type: "approval_request", request: { id: "ap-p", action, site: "x.com", why: "publishes", kind: "publish", text: post, expiresAt: iso(-1) } }),
      pev(-1, { type: "approval_resolved", id: "ap-p", outcome: "paused" }),
      pev(-1, { type: "status", text: `Pausing: ${reason}` }),
      pev(-1, { type: "tool_result", id: "1", name: "act", text: "Not done: the user did not approve this action.", isError: true }),
      pev(-1, { type: "status", text: "Jev chose 1 of 2 element picks (clicks and typing); Claude chose 1", picks: { jev: 1, claude: 1 } }),
      pev(-1, { type: "task_end", outcome: "paused", reason }),
    ];
    sessions.unshift(conv);
  }
  if (kind === "details") {
    // The running task has long instructions with links, files and an account; a one-off chat has a multi-line message.
    const text = [
      "Post the launch thread on X from @noa and reply to the first comment.",
      "",
      "1. We just shipped Noa 0.2: https://noa.example.com/blog/2026/09/launch-of-noa-0-2-with-scheduled-runs?utm_source=x&utm_campaign=launch",
      "2. It runs your todo list in the browser, on a schedule",
      "3. Pin the thread",
      "",
      "If the first comment asks about pricing, link https://noa.example.com/pricing.",
    ].join("\n");
    const one = text.replace(/\s+/g, " ").trim();
    running.title = one.length > 80 ? `${one.slice(0, 79)}…` : one;
    tasks[0] = {
      ...tasks[0], instructions: text, attempts: 1,
      media: [
        { id: "m7", name: "launch-banner-final-v3.png", type: "image/png", size: 482133 },
        { id: "m8", name: "thread.txt", type: "text/plain", size: 1210 },
      ],
    };
    tasks[1] = { ...tasks[1], media: [{ id: "m9", name: "thank-you.gif", type: "image/gif", size: 90112 }] };
    const lisbon = sessions.find((x) => x.sessionId === "s-3");
    lisbon.instructions = "Find the cheapest flight to Lisbon next weekend.\nLeave Friday after 17:00, back Sunday night.\nCompare https://www.google.com/travel/flights and https://www.skyscanner.net/transport/flights/ber/lis/ before picking.";
    lisbon.model = "claude-sonnet-5";
  }
  if (kind === "recent" || kind === "recent-empty") {
    // Tab 1 has no chat: the new chat offers the recent ones (a chat runs in tab 2), titled by the title model; a TODO
    // run is not offered. Made-up content.
    const chat = (id, title, minutes, extra = {}) => ({
      sessionId: id, source: "adhoc", title, instructions: title, titleBy: "model", titledTurn: 1, brain: "claude-code", jev: true,
      startedAt: iso(minutes - 3), endedAt: iso(minutes), outcome: "done", ...extra,
    });
    const live = { ...chat("s-r1", "Schedule 3x daily X posts", 0), startedAt: iso(-1) };
    delete live.endedAt;
    delete live.outcome;
    const recent = [
      live,
      chat("s-r2", "Check Chrome Web Store emails", -12, { instructions: "yo sup how you doin. can you check my chrome web store emails", url: "https://mail.google.com/mail/u/0/#inbox", summary: "2 new emails from the review team", turns: 2 }),
      { sessionId: "s-r5", source: "local", taskId: "t6", title: "Post 'good morning' on X", brain: "claude-code", jev: false, startedAt: iso(-62), endedAt: iso(-60), outcome: "done" },
      chat("s-r3", "Find cheap flights to Lisbon", -190, { outcome: "paused", reason: "Needs you to pick dates", url: "https://www.google.com/travel/flights" }),
      chat("s-r4", "Download the September invoice", -26 * 60, { outcome: "failed", reason: "The site asked for a one-time code", url: "https://billing.example.com/invoices" }),
      chat("s-r6", "Reply to Jordan about the lease", -2 * 24 * 60, { url: "https://mail.google.com/mail/u/0/#sent" }),
      chat("s-r7", "Summarize this pull request and post the summary as a comment on GitHub", -5 * 24 * 60, { titleBy: undefined, titledTurn: undefined, url: "https://github.com/runhq/api/pull/412" }),
      chat("s-r8", "Compare three standing desks", -8 * 24 * 60, { url: "https://www.example-desks.com/compare" }),
    ];
    const rev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-r2" });
    eventsBySession["s-r2"] = [
      rev(-15, { type: "assistant_text", text: "I'll open the Chrome Web Store developer inbox." }),
      rev(-15, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://mail.google.com/mail/u/0/#inbox" } }),
      rev(-15, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://mail.google.com/mail/u/0/#inbox (title: Inbox (2))" }),
      rev(-12, { type: "assistant_text", text: "Two new emails from the Chrome Web Store review team: your item passed review, and a policy reminder about permissions." }),
      rev(-12, { type: "task_end", outcome: "done", summary: "2 new emails from the review team" }),
    ];
    state.running = null;
    state.runningSessions = [live];
    state.runningTabs = { "s-r1": [2] };
    state.tabChats = { "2": "s-r1" };
    sessions.splice(0, sessions.length, ...(kind === "recent" ? recent : []));
    if (kind === "recent-empty") {
      state.runningSessions = [];
      state.runningTabs = {};
      state.tabChats = {};
    }
  }
  if (kind === "nojobs") {
    // A first run: no chat, no task, nothing running.
    state.running = null;
    sessions.splice(0, sessions.length);
    tasks.splice(0, tasks.length);
  }
  /** series-long: every row of the series as the account has it (tasks.series pages through them). */
  let seriesRows;
  if (kind === "series" || kind === "series-long") {
    // A repeating task that ran three times (the last one failed), waiting for tomorrow's run: one job, its runs inside.
    state.running = null;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const TIP = "Post a short tip about keyboard shortcuts on X from @noa";
    const repeat = { cron: "0 9 * * *", tz: zone };
    const day = 24 * 60;
    /** The last 9:00 that went by (minutes from now, negative). */
    const nine = untilNext(9) - day;
    const row = (id, status, minutes, extra = {}) => task(id, status, TIP, { seriesId: "tip1", repeat, account: "noa", createdAt: iso(minutes - 10), updatedAt: iso(minutes), ...extra });
    tasks.splice(0, tasks.length,
      // Each ran at 9:00 (the last three mornings) and ended a few minutes later; the next waits for the next 9:00.
      row("tip3", "pending", nine + 3, { notBefore: iso(nine + day) }),
      row("tip2", "failed", nine - day + 3, { failReason: "X asked to confirm the login" }),
      row("tip1", "done", nine - 2 * day + 3, { resultUrl: "https://x.com/noa/status/1839000000000000001" }),
      task("t9", "done", "Post 'good morning' on X", { updatedAt: iso(-3 * day) }),
    );
    const run = (id, taskId, minutes, extra) => ({ sessionId: id, source: "local", taskId, seriesId: "tip1", title: TIP, brain: "claude-code", jev: true, model: "claude-sonnet-5", startedAt: iso(minutes - 3), endedAt: iso(minutes), ...extra });
    const runs = [
      run("r-tip3", "tip3", nine + 3, { outcome: "done", summary: "Posted: Ctrl+. opens Noa from any tab", url: "https://x.com/noa/status/1839000000000000003" }),
      run("r-tip2", "tip2", nine - day + 3, { outcome: "failed", reason: "X asked to confirm the login" }),
      run("r-tip1", "tip1", nine - 2 * day + 3, { outcome: "done", summary: "Posted: Ctrl+, talks to it", url: "https://x.com/noa/status/1839000000000000001" }),
    ];
    sessions.splice(0, sessions.length, ...runs);
    const rev = (sid, minutes, e) => ({ ...e, ts: iso(minutes), sessionId: sid });
    for (const r of runs) {
      const m = (Date.parse(r.endedAt) - now) / 60_000;
      eventsBySession[r.sessionId] = [
        rev(r.sessionId, m - 3, { type: "status", text: "Claude Code started (claude-sonnet-5)" }),
        rev(r.sessionId, m - 3, { type: "assistant_text", text: "Opening X to write today's tip." }),
        rev(r.sessionId, m - 2, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://x.com/compose/post" } }),
        rev(r.sessionId, m - 2, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://x.com/compose/post" }),
        r.outcome === "done"
          ? rev(r.sessionId, m, { type: "task_end", outcome: "done", summary: r.summary, url: r.url })
          : rev(r.sessionId, m, { type: "task_end", outcome: "failed", reason: r.reason }),
      ];
    }
    if (kind === "series-long") {
      // The same job after 300 runs, 3 a day, in the account: this browser keeps the conversations of the last three;
      // the rest are known by their task rows (the list has the newest 100 of them; tasks.series pages through all).
      // Most were done; 7 in a row failed for the same reason, a few others failed. Its instructions are long.
      tasksSource = "account";
      const LONG = `${TIP}.
Keep it under 200 characters, one shortcut per post.
Never repeat a shortcut posted in the last two weeks.
End with a link to the docs page for that shortcut.
No hashtags, no emoji.`;
      tasks[0] = { ...tasks[0], instructions: LONG };
      const tips = ["Ctrl+. opens the panel", "Ctrl+, talks to it", "Esc goes back", "Alt+Y allows", "Tab takes a suggestion", "Delete dismisses a job"];
      const older = Array.from({ length: 297 }, (_, i) => {
        const minutes = nine - 2 * day - (i + 1) * 8 * 60 + 3;
        const n = i + 4;
        if (i >= 20 && i < 27) return row(`h${n}`, "failed", minutes, { attempts: 1, failReason: "I couldn't switch X to @getbnty: the account menu did not list it" });
        if (i % 23 === 5) return row(`h${n}`, "failed", minutes, { attempts: 3, failReason: "X asked to confirm the login" });
        return row(`h${n}`, "done", minutes, { attempts: 1, resultSummary: `Posted: ${tips[i % tips.length]} (#${n})`, resultUrl: `https://x.com/noa/status/18390000000000${String(n).padStart(5, "0")}` });
      });
      seriesRows = [...tasks.slice(0, 3), ...older];
      tasks.splice(3, 0, ...older.slice(0, 100));
    }
  }
  // Nothing runs in tab 1 when the default run is not running.
  if (state.running?.sessionId !== "s-live") delete state.runningTabs["s-live"];
  // Other extensions took the keys: Chrome assigned none.
  const shortcut = kind === "noshortcut" ? "" : SHORTCUT;
  const voiceShortcut = kind === "noshortcut" ? "" : VOICE_SHORTCUT;
  // Log In in the stub signs in as a subscriber (the TODO tab then shows the list).
  // The Raw view: a two-turn voice conversation with its timing trace (raw-scenario.mjs).
  const traces = kind === "raw" ? { [rawSessionId]: rawScenario({ state, sessions, eventsBySession }) } : {};
  return { state, tasks, seriesRows, tasksSource, tasksLocked, signInPlan: PLUS, events, sessions, eventsBySession, traces, shortcut, voiceShortcut, pastEvents: events.slice(0, 6).map((e) => ({ ...e, sessionId: "s-2" })) };
}
