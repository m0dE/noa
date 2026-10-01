// The options page cases of the UI harness. OPTION_CASES: [name, scenario kind, hash, data edit,
// checks(page)], screenshotted at every size and scheme; OPTION_FLOWS: interactions run once, at
// the size and scheme their screenshot names.
import { join } from "node:path";
import { eventually, shown } from "./checks.mjs";
import { scenario } from "./scenarios.mjs";
import { installVoiceFakes } from "./chrome-stub.mjs";

// Options page: the sidebar, the brain choices and what each reveals, Jev, tasks, logins, advanced.
// It opens in a browser tab, so a wide and a narrow viewport.
export const OPT_SIZES = [
  { w: 1280, h: 1000 },
  { w: 420, h: 900 },
];

const radio = (v) => `input[name=brain][value="${v}"]`;
const OPT_PLUS = { id: "plus", status: "active", currentPeriodEnd: new Date(Date.now() + 864e5 * 20).toISOString(), cancelAtPeriodEnd: false };
const onPlus = (data) => {
  data.state.account = {
    ...data.state.account,
    plan: OPT_PLUS,
    credit: { subscriptionCents: 1540, topupCents: 0, totalCents: 1540, periodGrantCents: 2000, periodEnd: OPT_PLUS.currentPeriodEnd },
  };
};

/** The visible billing buttons' labels (the Account section has one at most). */
const billingButtons = (p) => p.locator("#panel-account button.billing-open:visible").allTextContents();

const onFree = (data) => {
  data.state.account = { ...data.state.account, plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false } };
};

// Site logins: three saved logins behind a passphrase ("correct horse" in the stub), and the way out when it is forgotten.
const lockedVault = (d) => (d.vault = { exists: true, locked: true, sites: ["bank.example", "example.com", "news.ycombinator.com"] });
const sent = (p, type) => p.evaluate((t) => window.__requests.filter((r) => r.type === t).length, type);
/** Enters `passphrase` and waits until the answer is shown. */
async function tryPassphrase(p, passphrase) {
  const before = await sent(p, "vault.unlock");
  await p.fill("#vault-pass", passphrase);
  await p.click("#vault-unlock");
  await p.waitForFunction((n) => window.__requests.filter((r) => r.type === "vault.unlock").length > n && !document.getElementById("vault-unlock").disabled, before);
}
const forgotProminent = (p) => p.evaluate(() => document.getElementById("vault-forgot-row").hasAttribute("data-prominent"));
const eraseQuestion = (p) => p.textContent("#vault-erase-question");
/** Forgot passphrase? then Erase saved logins (with `click`): the confirm step. */
async function armErase(p, click = (sel) => p.click(sel)) {
  await p.click("#vault-forgot");
  await click("#vault-erase");
  await p.waitForFunction(() => document.getElementById("vault-erase-question").textContent !== "");
}
const choosingPassphrase = async (p) =>
  (await p.getAttribute("#vault-pass", "placeholder")) === "Choose a passphrase" && (await p.textContent("#vault-unlock")) === "Set passphrase" && (await shown(p, "#vault-create-note"));

/**
 * The header: the product icon, "Noa extension settings" and a one-line subtitle, the account avatar at the
 * right. Below it the sidebar: every section with its icon tile, the open one filled with the accent; wide, a column
 * left of the content; narrow (720 px or less), a sideways-scrolling row that stays at the top.
 */
const headerChecks = (p, signedIn) => [
  ["title and subtitle", async () =>
    (await p.textContent(".head h1")) === "Noa extension settings" && /Changes save as you make them/.test(await p.textContent(".head-sub"))],
  ["product icon shown", () => p.evaluate(() => { const i = document.querySelector(".head .brand"); return i.complete && i.naturalWidth > 0; })],
  ["avatar at the right of the header", () =>
    p.evaluate(() => {
      const head = document.querySelector(".head").getBoundingClientRect();
      const acct = document.querySelector(".head .acct summary").getBoundingClientRect();
      return acct.right <= head.right + 0.5 && acct.right >= head.right - 8;
    })],
  ["every section in the sidebar, each with an icon tile", async () =>
    (await p.locator("#sections [role=tab]").allTextContents()).join(" | ") === "Account | AI | Permission | Tasks | Site logins | Memory | Advanced" &&
    (await p.locator("#sections [role=tab] .side-icon svg").count()) === 7],
  ["the open section filled with the accent, its title over the content", () =>
    p.evaluate(() => {
      const on = document.querySelector("#sections [aria-selected=true]");
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const probe = document.createElement("i");
      probe.style.color = accent;
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      const panel = document.getElementById(on.getAttribute("aria-controls"));
      return getComputedStyle(on).backgroundColor === want && panel.querySelector(".panel-title").textContent === on.textContent;
    })],
  ["sidebar: a column at the left when wide, a row on top when narrow", () =>
    p.evaluate(() => {
      const side = document.querySelector(".side").getBoundingClientRect();
      const content = document.querySelector(".content").getBoundingClientRect();
      const items = [...document.querySelectorAll("#sections [role=tab]")].map((b) => b.getBoundingClientRect());
      if (innerWidth > 720) return side.right <= content.left && items.every((r, i) => !i || r.top >= items[i - 1].bottom - 0.5);
      return side.bottom <= content.top + 0.5 && items.every((r) => Math.abs(r.top - items[0].top) < 1) && getComputedStyle(document.querySelector(".side")).position === "sticky";
    })],
  ["no Speed tab", async () => (await p.locator("#tab-speed").count()) === 0],
  ["menu opens with the account", async () => {
    await p.click("#menu-acct-btn");
    const shownItems = await p.locator("#menu-acct-menu button:visible").allTextContents();
    const who = signedIn ? await p.textContent("#menu-acct-menu .acct-email") : "";
    return signedIn
      ? who === "ada.lovelace@example.com" && /Plus plan · \$25\.40 usage credit/.test(await p.textContent("#menu-acct-menu .acct-plan")) && shownItems.join("|") === "Plan & billing|Sign out"
      : shownItems.join("|") === "Log in with Google" && (await p.locator("#menu-acct-btn .acct-anon").isVisible());
  }],
];

/** [name, scenario kind, hash, data edit, checks(page)] */
export const OPTION_CASES = [
  ["options-header-signedin", "opt-paid", "#ai", () => {}, (p) => headerChecks(p, true)],
  ["options-header-signedout", "opt-signedout", "#ai", () => {}, (p) => headerChecks(p, false)],
  ["options-ai-auto", "ok", "#ai", onFree, (p) => [
    ["Auto checked", () => p.isChecked(radio("auto"))],
    ["Auto says what it picks", async () => /picks Local Claude Code/.test(await p.textContent("#auto-pick"))],
    ["API key hidden under Auto", async () => !(await shown(p, "[data-secret=anthropicApiKey]"))],
    ["helper hidden under Auto", async () => !(await shown(p, "#helper-headline"))],
    ["hosted: plan inline with Get a plan", async () => /Free plan/.test(await p.textContent("#hosted-plan")) && (await shown(p, "#hosted-action"))],
    ["model select", async () => (await p.inputValue("#model-select")) === "claude-sonnet-5"],
    ["Reasoning: Fast, with its hint", async () => (await p.inputValue("#f-reasoning")) === "fast" && /little thinking/.test(await p.textContent("#reasoning-hint"))],
    ["Think harder when stuck: shown and on", async () => (await shown(p, "#f-reasoningAutoRaise")) && (await p.isChecked("#f-reasoningAutoRaise"))],
  ]],
  ["options-ai-thorough", "ok", "#ai", (d) => (d.state.settings.reasoning = "thorough"), (p) => [
    ["Reasoning: Thorough, with its hint", async () => (await p.inputValue("#f-reasoning")) === "thorough" && /Thinks before steps/.test(await p.textContent("#reasoning-hint"))],
    ["Think harder when stuck hidden (Thorough already thinks)", async () => !(await shown(p, "#f-reasoningAutoRaise"))],
  ]],
  // Auto takes the user's own Claude first: with the helper working it picks Local Claude Code even on a plan with credit.
  ["options-ai-auto-plus", "ok", "#ai", onPlus, (p) => [
    ["Auto checked", () => p.isChecked(radio("auto"))],
    ["Auto describes its order", async () => /Uses your own Claude first, then Noa AI/.test(await p.textContent("#panel-ai"))],
    ["Auto picks Local Claude Code over Noa AI", async () => /picks Local Claude Code/.test(await p.textContent("#auto-pick"))],
  ]],
  ["options-ai-hosted", "ok", "#ai", (d) => {
    onPlus(d);
    d.state.settings.brain = "noa";
    d.state.brain = { ...d.state.brain, effective: "noa" };
  }, (p) => [
    ["Noa AI enabled and checked", async () => (await p.isChecked(radio("noa"))) && (await p.isEnabled(radio("noa")))],
    ["credit inline", async () => /\$15\.40 usage credit left/.test(await p.textContent("#hosted-credit"))],
    ["no buy action on a paid plan with credit", async () => !(await shown(p, "#hosted-action"))],
    ["no problem note", async () => !(await shown(p, "#brain-problem"))],
    // Noa AI brings its own Jev: nothing may ask for the user's Jev key.
    ["no Jev key field (hosted brings its own Jev)", async () => !(await shown(p, "[data-secret=jevApiKey]"))],
    ["Use Jev does not ask for a key", async () => !/key/i.test(await p.textContent("label[for=f-jevEnabled]"))],
  ]],
  // Auto that resolves to Noa AI (no helper, no Claude API key): same rule, no Jev key asked for.
  ["options-ai-auto-hosted", "ok", "#ai", (d) => {
    onPlus(d);
    d.state.settings.brain = "auto";
    d.state.settings.anthropicApiKey = "";
    d.state.brain = { effective: "noa", helper: null, helperError: "Helper not installed", hasApiKey: false, jevActive: true };
  }, (p) => [
    ["Auto checked", () => p.isChecked(radio("auto"))],
    ["Auto picks Noa AI", async () => /picks Noa AI/.test(await p.textContent("#auto-pick"))],
    ["no Jev key field (hosted brings its own Jev)", async () => !(await shown(p, "[data-secret=jevApiKey]"))],
    ["Use Jev does not ask for a key", async () => !/key/i.test(await p.textContent("label[for=f-jevEnabled]"))],
  ]],
  ["options-ai-hosted-signedout", "opt-signedout", "#ai", (d) => {
    d.state.settings.brain = "noa";
    d.state.brain = { ...d.state.brain, effective: null, note: "Sign in to use Noa AI" };
  }, (p) => [
    ["Noa AI disabled", async () => !(await p.isEnabled(radio("noa")))],
    ["still shown as the saved choice", () => p.isChecked(radio("noa"))],
    ["log in button", () => shown(p, "#hosted-signin")],
    ["signed-out problem explained", async () => /Logged out/.test(await p.textContent("#brain-problem"))],
  ]],
  ["options-ai-signedout", "opt-signedout", "#ai", () => {}, (p) => [
    ["Noa AI disabled", async () => !(await p.isEnabled(radio("noa")))],
    ["log in button", () => shown(p, "#hosted-signin")],
    ["no credit shown", async () => !(await shown(p, "#hosted-in"))],
  ]],
  ["options-ai-claudecode", "ok", "#ai", (d) => (d.state.settings.brain = "claude-code"), (p) => [
    ["helper shown", () => shown(p, "#helper-headline")],
    ["no install steps when connected", async () => !(await shown(p, "#helper-install"))],
    ["API key hidden", async () => !(await shown(p, "[data-secret=anthropicApiKey]"))],
  ]],
  ["options-ai-nothing", "nobrain", "#ai", (d) => {
    d.state.settings.brain = "auto";
    d.state.account = { signedIn: false, signInConfigured: true, apiBase: d.state.account.apiBase, dashboardUrl: d.state.account.dashboardUrl };
  }, (p) => [
    ["Auto points signed-in Claude Code users at the helper", async () => /install the helper/.test(await p.textContent("#auto-pick"))],
  ]],
  ["options-ai-nohelper", "nobrain", "#ai", (d) => (d.state.settings.brain = "claude-code"), (p) => [
    ["helper not installed", async () => /not installed/.test(await p.textContent("#helper-headline"))],
    ["says signing in is not enough", async () => /not enough/.test(await p.textContent("#helper-details"))],
    ["install steps", () => shown(p, "#helper-install")],
    ["one Terminal command, for this extension", async () => (await shown(p, "#helper-command")) && (await p.textContent("#helper-command")) === "curl -fsSL https://noa.bot/helper/install.sh | sh -s -- --extension-id abcdefghijklmnopabcdefghijklmnop"],
    ["no repo steps off Windows", async () => (await shown(p, "#helper-copy")) && !(await shown(p, "#helper-step-repo"))],
    ["says how to open Terminal", () => shown(p, "#helper-step-terminal")],
    ["Connect button", async () => (await p.textContent("#helper-connect")) === "Connect"],
  ]],
  // The installer is not on the site (not deployed): no command that would 404 in Terminal.
  ["options-ai-noinstaller", "nobrain", "#ai", (d) => ((d.state.settings.brain = "claude-code"), (d.helperInstallerDown = true)), (p) => [
    ["no Terminal command", async () => !(await shown(p, "#helper-command")) && !(await shown(p, "#helper-step-terminal"))],
    ["says the installer is not online, and the repo steps", async () => (await shown(p, "#helper-step-repo")) && /not online yet/.test(await p.textContent("#helper-step-repo"))],
  ]],
  ["options-ai-claudeapi", "ok", "#ai", (d) => (d.state.settings.brain = "claude-api"), (p) => [
    ["API key shown", () => shown(p, "[data-secret=anthropicApiKey]")],
    ["Test key shown", () => shown(p, "#test-claude")],
    ["key is set", async () => /Set/.test(await p.textContent("[data-secret=anthropicApiKey]"))],
    ["helper hidden", async () => !(await shown(p, "#helper-headline"))],
  ]],
  ["options-ai-nokey", "nobrain", "#ai", (d) => (d.state.settings.brain = "claude-api"), (p) => [
    ["key input", () => shown(p, "[data-secret=anthropicApiKey] input")],
    ["missing key hint", () => shown(p, "#api-key-missing")],
    ["Save disabled until typed", async () => !(await p.isEnabled("[data-secret=anthropicApiKey] button.primary"))],
  ]],
  // Jev (it had its own Speed section): #jev and #speed open the AI section on its Speed tab.
  ["options-speed-on", "ok", "#jev", () => {}, (p) => [
    ["on the AI section", async () => (await p.getAttribute("#tab-ai", "aria-selected")) === "true"],
    ["no Speed section in the sidebar", async () => (await p.locator("#tab-speed").count()) === 0],
    ["hash normalised", async () => (await p.evaluate(() => location.hash)) === "#ai"],
    ["AI tabs: Source, Speed, Voice, Images (automation is on Permission)", async () =>
      (await p.locator("#ai-tabs [role=tab]").allTextContents()).join(" | ") === "Source | Speed | Voice | Images"],
    ["on the Speed tab, only its panel shown", async () =>
      (await p.getAttribute("#ai-tab-speed", "aria-selected")) === "true" && (await shown(p, "#jev-group")) && !(await shown(p, "#source-group")) && !(await shown(p, "#voice-group"))],
    ["groups per tab: Source and Model | Jev | Voice | Image generation", async () =>
      (await p.evaluate(() => [...document.querySelectorAll("#panel-ai > .subpanel")].map((sp) => [...sp.querySelectorAll(":scope > .group > h3")].map((e) => e.textContent).join(", ")).join(" | "))) === "Source, Model | Speed (Jev) | Voice | Image generation"],
    ["Jev key shown", () => shown(p, "[data-secret=jevApiKey]")],
    ["threshold shown", () => shown(p, "#f-jevThreshold")],
  ]],
  ["options-speed-off", "ok", "#speed", (d) => (d.state.settings.jevEnabled = false), (p) => [
    ["on the AI section", async () => (await p.getAttribute("#tab-ai", "aria-selected")) === "true"],
    ["Jev key hidden", async () => !(await shown(p, "[data-secret=jevApiKey]"))],
    ["test hidden", async () => !(await shown(p, "#test-jev"))],
  ]],
  // Voice: the two engines with the server's cost a minute; with Realtime selected, OpenAI's voices, its speed range
  // and what a test costs.
  ["options-voice", "opt-paid", "#voice", () => {}, (p) => [
    ["on the AI section", async () => (await p.getAttribute("#tab-ai", "aria-selected")) === "true"],
    ["on the Voice tab", async () => (await p.getAttribute("#ai-tab-voice", "aria-selected")) === "true"],
    ["Realtime checked by default", () => p.isChecked("input[name=voiceEngine][value=realtime]")],
    ["names", async () => (await p.locator(".opt[data-voice] .voice-name").allTextContents()).join(" | ") === "OpenAI Realtime (recommended) | OpenAI Realtime mini | Deepgram | Browser voice"],
    ["costs from the server", () =>
      eventually(async () => (await p.locator(".opt[data-voice] .voice-cost").allTextContents()).join(" | ") === "about 6.1¢ of usage credit a minute | about 2.3¢ of usage credit a minute | about 1.7¢ of usage credit a minute | about 0.067¢ of usage credit a minute")],
    ["cost assumption and model as tooltip", async () => /speaks for 18 seconds.*Model: gpt-realtime-2\.1\.$/.test(await p.getAttribute(".opt[data-voice=realtime] .voice-cost", "title"))],
    ["the browser voice says it is free", async () => (await p.textContent(".opt[data-voice=standard] .voice-detail")) === "Deepgram hears you (Nova-3); short summaries are read aloud by your browser's own voice, at no charge."],
    ["no plan note on Plus", async () => !(await shown(p, "#voice-note"))],
    ["Realtime voice title", async () => (await p.textContent("#speech-voice-title")) === "Realtime voice"],
    ["OpenAI's voices", async () => (await p.locator("#speech-voice option").allTextContents()).join(", ") === "Marin (recommended), Cedar (recommended), Alloy, Ash, Ballad, Coral, Echo, Sage, Shimmer, Verse"],
    ["Marin selected", async () => (await p.inputValue("#speech-voice")) === "marin"],
    ["Realtime speed range", async () => JSON.stringify(await p.evaluate(() => { const r = document.getElementById("speech-rate"); return [r.type, r.min, r.max, r.step, r.value]; })) === JSON.stringify(["range", "0.25", "1.5", "0.05", "1"])],
    ["speed shown", async () => (await p.textContent("#speech-rate-value")) === "1.0×" && (await p.textContent("#speech-rate-hint")) === "0.25× to 1.5×; 1.0× is normal."],
    ["test cost", () => eventually(async () => (await p.textContent("#speech-test-hint")) === "Says a sample line with this voice and speed (uses about 1¢ of usage credit).")],
    ["Sounds on by default", () => p.isChecked("#voice-sounds")],
    ["notifications follow the hands-free voice by default", async () => (await p.inputValue("#notification-voice")) === "same"],
    ["notification choices", async () =>
      (await p.locator("#notification-voice option").allTextContents()).join(" | ") ===
      "Same as hands-free voice (OpenAI Realtime) | OpenAI Realtime (Marin) | OpenAI Realtime mini (Marin) | Deepgram (Thalia) | Browser voice (browser default) | Chime only | Off (silent)"],
    ["notification voice row: the hands-free voice first, then OpenAI's voices", async () =>
      (await shown(p, "#notification-speaker-row")) &&
      (await p.locator("#notification-speaker option").first().textContent()) === "Same as hands-free voice (Marin)" &&
      (await p.locator("#notification-speaker option").count()) === 11],
    ["notifications in Deepgram: its voices, just for them", async () => {
      await p.selectOption("#notification-voice", "deepgram");
      return eventually(async () =>
        (await p.textContent("#notification-speaker-hint")) === "Deepgram voices, just for notifications; hands-free voice keeps its own." &&
        (await p.locator("#notification-speaker option").first().textContent()) === "Default (Thalia)");
    }],
    ["a notification voice saves, the hands-free voice untouched", async () => {
      await p.selectOption("#notification-speaker", "apollo");
      return eventually(async () =>
        (await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.notificationSpeaker === "apollo"))) &&
        (await p.inputValue("#notification-speaker")) === "apollo" &&
        (await p.inputValue("#speech-voice")) === "marin");
    }],
    ["chime saves", async () => {
      await p.selectOption("#notification-voice", "chime");
      return eventually(() => p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.notificationVoice === "chime")));
    }],
    ["a chime has no voice row", () => eventually(async () => !(await shown(p, "#notification-speaker-row")))],
    ["notification test asks the background", async () => {
      await p.click("#notification-test");
      return eventually(() => p.evaluate(() => window.__requests.some((r) => r.type === "notify.test")));
    }],
  ]],
  // Voice with Deepgram selected: Aura's voices and its own speed range; Test asks the background for the line.
  ["options-voice-deepgram", "opt-paid", "#voice", (d) => (d.state.settings = { ...d.state.settings, voiceEngine: "deepgram", deepgramVoice: "apollo" }), (p) => [
    ["Deepgram checked", () => p.isChecked("input[name=voiceEngine][value=deepgram]")],
    ["Deepgram voice title", async () => (await p.textContent("#speech-voice-title")) === "Deepgram voice"],
    ["Aura's voices, its picks first", async () => (await p.locator("#speech-voice option").first().textContent()) === "Thalia (recommended)" && (await p.locator("#speech-voice option").count()) === 40],
    ["Apollo selected", async () => (await p.inputValue("#speech-voice")) === "apollo"],
    ["Deepgram speed range", async () => JSON.stringify(await p.evaluate(() => { const r = document.getElementById("speech-rate"); return [r.min, r.max, r.step, r.value]; })) === JSON.stringify(["0.5", "2", "0.05", "1"])],
    ["test asks for Apollo's line", async () => {
      await p.click("#speech-test");
      return eventually(() => p.evaluate(() => window.__requests.some((r) => r.type === "voice.speak" && r.voice === "apollo")));
    }],
    ["picking a voice saves it", async () => {
      await p.selectOption("#speech-voice", "zeus");
      return eventually(() => p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.deepgramVoice === "zeus")));
    }],
  ]],
  // Voice with Standard selected: the browser's voices and speed range.
  ["options-voice-standard", "opt-paid", "#voice", (d) => (d.state.settings = { ...d.state.settings, voiceEngine: "standard", speechRate: 1.4 }), (p) => [
    ["Standard checked", () => p.isChecked("input[name=voiceEngine][value=standard]")],
    ["Standard voice title", async () => (await p.textContent("#speech-voice-title")) === "Browser voice"],
    ["browser voices", async () => (await p.locator("#speech-voice option").first().textContent()) === "Browser default" && !(await p.locator("#speech-voice option", { hasText: "Marin" }).count())],
    ["Standard speed range", async () => JSON.stringify(await p.evaluate(() => { const r = document.getElementById("speech-rate"); return [r.min, r.max, r.step, r.value]; })) === JSON.stringify(["0.5", "2", "0.1", "1.4"])],
    ["speed shown", async () => (await p.textContent("#speech-rate-value")) === "1.4×" && (await p.textContent("#speech-rate-hint")) === "0.5× to 2.0×; 1.0× is normal."],
    ["local test", async () => (await p.textContent("#speech-test-hint")) === "Says a sample line with this voice and speed, on this computer."],
  ]],
  // Settings > Permission: the three chat levels (the middle one by default), then scheduled tasks: their choice and
  // when they run, and last the no-warranty note. The old #automation link (it was on AI) lands here; full autonomy on shows its warning and the level
  // in the warning colour.
  ["options-permission", "ok", "#automation", () => {}, (p) => [
    ["on the Permission section", async () => (await p.getAttribute("#tab-permission", "aria-selected")) === "true" && (await p.textContent("#tab-permission")) === "Permission"],
    ["hash normalised", async () => (await p.evaluate(() => location.hash)) === "#permission"],
    ["sidebar order: AI, Permission, Tasks", async () => (await p.locator("#sections [role=tab]").allTextContents()).slice(1, 4).join(" | ") === "AI | Permission | Tasks"],
    ["groups: Chat, then Scheduled jobs", async () =>
      (await p.evaluate(() => [...document.querySelectorAll("#panel-permission > .group > h3")].map((e) => e.textContent).join(" | "))) === "Chat | Scheduled jobs"],
    ["three levels, the middle one checked", async () =>
      (await p.locator("#automation-levels .opt b").allTextContents()).join(" | ") === "Ask before every action | Ask before posting, sending or paying | Full autonomy (dangerous)" &&
      (await p.isChecked("input[name=automationLevel][value=ask_consequential]"))],
    ["scheduled tasks do what they say", () => p.isChecked("input[name=scheduledAutomation][value=full_within_task]")],
    ["schedule under it", async () => (await shown(p, "#schedule-group #f-intervalMinutes")) && (await p.inputValue("#f-intervalMinutes")) === "15" && (await p.inputValue("#f-maxParallelTasks")) === "2"],
    ["no warning", async () => !(await shown(p, "#automation-warning"))],
    ["no-warranty note last, linking to the terms", async () => (await shown(p, "#panel-permission > .disclaimer")) && /without warranty/.test(await p.textContent("#panel-permission > .disclaimer")) && (await p.getAttribute("#panel-permission > .disclaimer a", "href")) === "https://noa.bot/terms"],
    ["scheduled choices in effect (no note)", async () => !(await shown(p, "#scheduled-automation-note")) && (await p.locator("input[name=scheduledAutomation]:disabled").count()) === 0],
    ["the section is in view", () => p.evaluate(() => { const r = document.getElementById("automation-group").getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })],
  ]],
  ["options-permission-full", "ok", "#permission", (d) => (d.state.settings.automationLevel = "full"), (p) => [
    ["full checked", () => p.isChecked("input[name=automationLevel][value=full]")],
    ["warning shown", async () => (await shown(p, "#automation-warning")) && /Full autonomy is on/.test(await p.textContent("#automation-warning"))],
    ["full in the warning colour", () => p.evaluate(() => {
      const row = document.querySelector('.opt[data-automation="full"]');
      return getComputedStyle(row).boxShadow.includes("inset") && row.hasAttribute("data-dangerous");
    })],
    // Full autonomy covers scheduled jobs: their choice is greyed out and says why.
    ["scheduled choices greyed out", async () =>
      (await p.locator("input[name=scheduledAutomation]").count()) === 2 && (await p.locator("input[name=scheduledAutomation]:disabled").count()) === 2 &&
      (await p.evaluate(() => Number(getComputedStyle(document.querySelector("#scheduled-automation .opt")).opacity) < 1))],
    ["scheduled note says full autonomy covers them", async () =>
      (await shown(p, "#scheduled-automation-note")) && (await p.textContent("#scheduled-automation-note")) === "Full autonomy is on, so scheduled jobs never ask either. These choices apply when Full autonomy is off."],
    ["full autonomy's detail names scheduled jobs", async () => /^Never asks, in chats and scheduled jobs\./.test(await p.textContent('.opt[data-automation="full"] .opt-detail'))],
  ]],
  ["options-tasks", "ok", "#tasks", () => {}, (p) => [
    // Both shortcuts, as Chrome assigned them, each with Change.
    ["open shortcut", async () => (await p.textContent("#shortcut-key")) === "Ctrl+." && (await p.textContent("#shortcut-change")) === "Change"],
    ["talk shortcut", async () => (await p.textContent("#voice-shortcut-key")) === "Ctrl+," && (await p.textContent("#voice-shortcut-change")) === "Change"],
    // The schedule moved to Permission.
    ["no schedule here", async () => (await p.locator("#panel-tasks #f-intervalMinutes").count()) === 0],
    ["limits", async () => shown(p, "#f-maxToolCalls")],
    // The page glow while Noa controls a tab: on by default.
    ["control overlay switch shown and on", async () => (await shown(p, "#f-showControlOverlay")) && (await p.isChecked("#f-showControlOverlay"))],
    ["control overlay says what it shows", async () => /glow/.test(await p.textContent("label[for=f-showControlOverlay]"))],
  ]],
  ["options-logins", "ok", "#logins", () => {}, (p) => [
    ["saved sites", async () => (await p.locator("#vault-sites li").count()) === 2],
    ["no passphrase field when unlocked", async () => !(await shown(p, "#vault-locked"))],
  ]],
  ["options-logins-create", "ok", "#logins", (d) => (d.vault = { exists: false, locked: true, sites: [] }), (p) => [
    ["choose a passphrase", () => choosingPassphrase(p)],
    ["says up front that a forgotten passphrase means erasing", async () => (await p.textContent("#vault-create-note")) === "If you forget this passphrase, your saved logins can't be recovered; you'd erase them and add them again."],
    ["no Forgot passphrase? (nothing to forget yet)", async () => !(await shown(p, "#vault-forgot-row"))],
  ]],
  ["options-logins-locked", "ok", "#logins", lockedVault, (p) => [
    ["unlock field", async () => (await p.getAttribute("#vault-pass", "placeholder")) === "Passphrase" && (await p.textContent("#vault-unlock")) === "Unlock"],
    ["no create note", async () => !(await shown(p, "#vault-create-note"))],
    ["quiet Forgot passphrase? link", async () => (await shown(p, "#vault-forgot")) && !(await forgotProminent(p)) && (await p.textContent("#vault-forgot")) === "Forgot passphrase?"],
    ["its explanation closed", async () => !(await shown(p, "#vault-forgot-box")) && (await p.getAttribute("#vault-forgot", "aria-expanded")) === "false"],
    ["logins hidden while locked", async () => !(await shown(p, "#vault-open"))],
  ]],
  ["options-logins-wrong", "ok", "#logins", lockedVault, (p) => [
    ["two wrong tries: the link stays quiet", async () => (await tryPassphrase(p, "hunter2"), await tryPassphrase(p, "hunter3"), !(await forgotProminent(p)))],
    ["Wrong passphrase", async () => (await p.textContent("#vault-msg")) === "Wrong passphrase"],
    ["third wrong try in a row: Forgot passphrase? stands out", async () => (await tryPassphrase(p, "hunter4"), forgotProminent(p))],
    ["says why", async () => (await p.textContent("#vault-forgot-lead")) === "Wrong passphrase 3 times in a row."],
    ["no lockout: Unlock still enabled", () => p.isEnabled("#vault-unlock")],
    ["nothing erased", async () => (await sent(p, "vault.reset")) === 0],
  ]],
  ["options-logins-forgot", "ok", "#logins", lockedVault, (p) => [
    ["Forgot passphrase? opens the explanation", async () => (await p.click("#vault-forgot"), (await shown(p, "#vault-forgot-box")) && (await p.getAttribute("#vault-forgot", "aria-expanded")) === "true")],
    ["explains why it can't be recovered", async () => (await p.textContent("#vault-forgot-box p")).startsWith("Your passphrase can't be recovered: your logins are encrypted on this computer, and Noa never sees them.")],
    ["one way out: Erase saved logins, styled as danger", async () => (await p.textContent("#vault-erase")) === "Erase saved logins" && (await p.getAttribute("#vault-erase", "class")).includes("danger")],
    ["no question yet", async () => (await eraseQuestion(p)) === ""],
  ]],
  ["options-logins-confirm", "ok", "#logins", lockedVault, (p) => [
    // The second click confirms in the same place: asking must not move the button.
    ["Erase stays in place when it asks", async () => {
      await p.click("#vault-forgot");
      const before = await p.locator("#vault-erase").boundingBox();
      await p.click("#vault-erase");
      const after = await p.locator("#vault-erase").boundingBox();
      await p.click("#vault-erase-cancel");
      return before.x === after.x && before.y === after.y;
    }],
    // A double-click on Erase saved logins asks, but its second click (on the same button) never erases.
    ["a double-click only asks", async () => (await armErase(p, (sel) => p.dblclick(sel)), (await sent(p, "vault.reset")) === 0)],
    ["and selects no text", async () => (await p.evaluate(() => getSelection().toString())) === ""],
    ["the question names the count", async () => (await eraseQuestion(p)) === "Erase 3 saved logins? This can't be undone."],
    ["the same button confirms", async () => (await p.textContent("#vault-erase")) === "Yes, erase 3 logins"],
  ]],
  ["options-logins-erased", "ok", "#logins", lockedVault, (p) => [
    ["a second click erases", async () => {
      await armErase(p);
      await p.click("#vault-erase");
      await p.waitForSelector("#vault-create-note:not([hidden])");
      return (await sent(p, "vault.reset")) === 1;
    }],
    ["back to choosing a passphrase", () => choosingPassphrase(p)],
    ["the forgot steps are gone", async () => !(await shown(p, "#vault-forgot-row")) && !(await shown(p, "#vault-forgot-box"))],
    ["says what went and what next", async () => (await p.textContent("#vault-msg")) === "Erased 3 saved logins. Choose a new passphrase to start over."],
  ]],
  ["options-advanced", "ok", "#advanced", () => {}, (p) => [
    ["account server", async () => (await p.inputValue("#f-accountApiBase")) === scenario("ok").state.settings.accountApiBase],
    ["no runner-key cloud sync", async () => (await p.locator("#panel-advanced").textContent()).match(/Cloud sync|Runner key|Task server/) === null],
  ]],
  // Account: plan and credit, and one billing button to the dashboard's Billing page (no Stripe buttons here).
  ["options-account-free", "opt-free", "#account", () => {}, (p) => [
    ["signed in", () => shown(p, "#acct-in")],
    ["one billing button: Choose a plan", async () => (await billingButtons(p)).join() === "Choose a plan"],
    ["says where plans are", async () => /Plans, top-ups and invoices are on your Noa dashboard\./.test(await p.textContent("#acct-billing"))],
    ["no subscribe, top-up or portal buttons", async () => (await p.locator("#panel-account button").allTextContents()).every((t) => !/Subscribe|Top up \$|\$\d|Manage billing|Change plan/.test(t))],
    ["no API keys in the extension (they are made on the dashboard)", async () => (await p.locator("#keys-card, #tab-keys").count()) === 0],
  ]],
  ["options-account-paid", "opt-paid", "#account", () => {}, (p) => [
    ["one billing button: Manage plan & billing", async () => (await billingButtons(p)).join() === "Manage plan & billing"],
    ["credit", async () => (await p.textContent("#acct-credit")) === "$25.40"],
    ["plan", async () => (await p.textContent("#acct-plan")) === "Plus"],
  ]],
  ["options-account-outofcredit", "opt-out", "#account", () => {}, (p) => [
    ["out of credit", async () => (await p.textContent("#acct-credit")) === "Out of usage credit"],
    ["note", async () => /paused until you top up/.test(await p.textContent("#acct-note"))],
    // On Free a plan is the way to credit.
    ["one billing button: Choose a plan", async () => (await billingButtons(p)).join() === "Choose a plan"],
  ]],
  ["options-account-paid-outofcredit", "opt-paid-out", "#account", () => {}, (p) => [
    ["plan", async () => (await p.textContent("#acct-plan")) === "Plus"],
    ["out of credit", async () => (await p.textContent("#acct-credit")) === "Out of usage credit"],
    ["one billing button: Top up or change plan", async () => (await billingButtons(p)).join() === "Top up or change plan"],
  ]],
  ["options-account-nobilling", "opt-nobilling", "#account", () => {}, (p) => [
    ["no billing button", async () => (await billingButtons(p)).length === 0],
    ["note", async () => /Billing isn't set up/.test(await p.textContent("#acct-note"))],
  ]],
  ["options-account-signedout", "opt-signedout", "#account", () => {}, (p) => [
    ["log in", () => shown(p, "#acct-signin")],
    ["no account", async () => !(await shown(p, "#acct-in"))],
  ]],
  // API keys had their own section; an old #keys link lands on Account.
  ["options-keys-link", "opt-free", "#keys", () => {}, (p) => [
    ["on the Account section", async () => (await p.getAttribute("#tab-account", "aria-selected")) === "true"],
  ]],
];

export const OPTION_FLOWS = [
  // Regression (Settings showed "$11.14 usage credit left" while runs were refused and the dashboard said $0.67):
  // Settings is open on Auto -> Noa AI with $11.14; runs in the side panel spend credit, and the background's
  // account now says $0.67 (its state push, as hub.pushState sends it). Coming back to the Settings tab must show
  // the current balance, not the one from when the page was opened. Only a settings save (clicking another Brain
  // option) used to bring the new balance in.
  {
    name: "options-credit-fresh",
    size: { w: 1280 },
    scheme: "light",
    async run({ openOptions, optChecks }) {
      const p = await openOptions({ w: 1280, h: 1000 }, "light", "ok", "#ai", (d) => {
        onPlus(d);
        d.state.account.credit = { ...d.state.account.credit, subscriptionCents: 1114, totalCents: 1114 };
        d.state.settings.brain = "auto";
        d.state.settings.anthropicApiKey = "";
        d.state.brain = { effective: "noa", helper: null, helperError: "Helper not installed", hasApiKey: false, jevActive: true };
      });
      const credit = () => p.textContent("#hosted-credit");
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      check("opened: $11.14 shown", await eventually(async () => /\$11\.14 usage credit left/.test(await credit())));
      // The background's account after the runs (refresh after each turn): $0.67 left.
      await p.evaluate(() => {
        return window.chrome.runtime.sendMessage({ type: "state.get" }).then((r) => {
          const state = r.data;
          const next = { ...state, rev: (state.rev ?? 0) + 1, account: { ...state.account, credit: { ...state.account.credit, subscriptionCents: 67, totalCents: 67 } } };
          window.__push({ type: "state", state: next });
        });
      });
      // The user comes back to the Settings tab.
      await p.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const shownNow = await eventually(async () => /\$0\.67 usage credit left/.test(await credit()), 3000);
      check(`after the runs spent credit: $0.67 shown (shows "${await credit()}")`, shownNow);
      console.log(`options-credit-fresh: #hosted-credit after the background's balance changed = "${await credit()}"`);
      await p.click(radio("claude-code"));
      const afterClick = await eventually(async () => /\$0\.67 usage credit left/.test(await credit()), 3000);
      console.log(`options-credit-fresh: #hosted-credit after clicking another Brain option = "${await credit()}" (updated: ${afterClick})`);
      await optChecks(p, "credit fresh", checks);
      await p.ctx.close();
    },
  },
  // Automation: turning on full autonomy asks first (Keep asking saves nothing); confirmed, it saves and warns; the
  // other choices save at once.
  {
    name: "options-permission-confirm",
    size: { w: 1280 },
    scheme: "light",
    async run({ openOptions, optChecks, optShot }) {
      const p = await openOptions({ w: 1280, h: 1000 }, "light", "ok", "#permission");
      const saved = () => p.evaluate(() => window.__requests.filter((r) => r.type === "settings.save").map((r) => r.settings));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      await p.click("input[name=automationLevel][value=full]");
      check("the dialog opens", await eventually(() => p.evaluate(() => document.getElementById("automation-confirm").open)));
      check("it says what full autonomy does", /post, send messages, pay, delete/.test(await p.textContent("#automation-confirm")));
      await optShot(p, "options-permission-confirm", { w: 1280, h: 1000 }, "light");
      await p.click("#automation-confirm-cancel");
      check("Keep asking closes it", await eventually(() => p.evaluate(() => !document.getElementById("automation-confirm").open)));
      check("nothing saved", (await saved()).length === 0);
      check("the middle level checked again", await eventually(() => p.isChecked("input[name=automationLevel][value=ask_consequential]")));
      await p.click("input[name=automationLevel][value=full]");
      await p.waitForFunction(() => document.getElementById("automation-confirm").open);
      await p.click("#automation-confirm-ok");
      check("confirmed: saved", await eventually(async () => (await saved()).some((s) => s.automationLevel === "full")));
      check("confirmed: the warning shows", await eventually(() => shown(p, "#automation-warning")));
      await p.click("input[name=automationLevel][value=ask_all]");
      check("a safer level saves at once", await eventually(async () => (await saved()).some((s) => s.automationLevel === "ask_all")));
      check("no dialog for it", !(await p.evaluate(() => document.getElementById("automation-confirm").open)));
      check("the warning goes", await eventually(async () => !(await shown(p, "#automation-warning"))));
      await p.click("input[name=scheduledAutomation][value=ask_consequential]");
      check("scheduled choice saved", await eventually(async () => (await saved()).some((s) => s.scheduledAutomation === "ask_consequential")));
      await optChecks(p, "automation confirm", checks);
      await p.ctx.close();
    },
  },
  // Voice: picking Standard and a speed saves them; a stored "speed" tab (the old Speed tab) reopens as AI.
  {
    name: "options-voice-choice",
    size: { w: 1280 },
    scheme: "light",
    async run({ openOptions, optChecks }) {
      const p = await openOptions({ w: 1280, h: 1000 }, "light", "opt-paid", "#voice");
      const saved = () => p.evaluate(() => window.__requests.filter((r) => r.type === "settings.save").map((r) => r.settings));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      const setSpeed = (v) => p.evaluate((x) => {
        const r = document.getElementById("speech-rate");
        r.value = x;
        r.dispatchEvent(new Event("input"));
        r.dispatchEvent(new Event("change"));
      }, v);
      // Realtime: a voice and a speed save to Realtime's own settings.
      await p.selectOption("#speech-voice", "cedar");
      check("Realtime voice saved", await eventually(async () => (await saved()).some((s) => s.realtimeVoice === "cedar")));
      await setSpeed("1.2");
      check("Realtime speed saved", await eventually(async () => (await saved()).some((s) => s.realtimeSpeed === 1.2)));
      check("speed shown", (await p.textContent("#speech-rate-value")) === "1.2×");
      await p.click("input[name=voiceEngine][value=standard]");
      check("Standard saved", await eventually(async () => (await saved()).some((s) => s.voiceEngine === "standard")));
      check("Standard checked after the save", await p.isChecked("input[name=voiceEngine][value=standard]"));
      check("the picker follows the engine", await eventually(async () => (await p.textContent("#speech-voice-title")) === "Browser voice" && (await p.getAttribute("#speech-rate", "max")) === "2"));
      await setSpeed("1.4");
      check("speed saved", await eventually(async () => (await saved()).some((s) => s.speechRate === 1.4)));
      await p.selectOption("#speech-voice", { index: 0 });
      check("Standard voice saved", await eventually(async () => (await saved()).some((s) => s.speechVoice === "")));
      check("Realtime voice kept", !(await saved()).some((s) => "realtimeVoice" in s && s.realtimeVoice !== "cedar"));
      // Sounds: the start and stop sounds turn off, and back on.
      await p.click("#voice-sounds");
      check("Sounds off saved", await eventually(async () => (await saved()).some((s) => s.voiceSounds === false)));
      check("Sounds unchecked after the save", !(await p.isChecked("#voice-sounds")));
      await p.evaluate(() => localStorage.setItem("noa.options.tab", "speed"));
      await p.goto(p.url().replace(/#.*$/, ""));
      await p.waitForSelector("#helper-headline:not(:empty)", { state: "attached" });
      check("a remembered Speed tab opens AI", (await p.getAttribute("#tab-ai", "aria-selected")) === "true");
      await optChecks(p, "voice choice", checks);
      await p.ctx.close();
    },
  },
  // Image generation: on with GPT Image 2 by default; the model and the switch save; off hides the model.
  {
    name: "options-images",
    size: { w: 1280 },
    scheme: "light",
    async run({ openOptions, optChecks }) {
      const p = await openOptions({ w: 1280, h: 1000 }, "light", "opt-paid", "#images");
      const saved = () => p.evaluate(() => window.__requests.filter((r) => r.type === "settings.save").map((r) => r.settings));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      check("on the AI section", (await p.getAttribute("#tab-ai", "aria-selected")) === "true");
      check("on its Images tab", (await p.getAttribute("#ai-tab-images", "aria-selected")) === "true" && (await shown(p, "#images-group")) && !(await shown(p, "#voice-group")));
      check("on by default", await p.isChecked("#images-on"));
      check("the models", (await p.locator("#images-model option").allTextContents()).join(" | ") === "GPT Image 2 | GPT Image 1 Mini");
      check("GPT Image 2 picked, with its cost", (await p.inputValue("#images-model")) === "gpt-image-2" && /7 cents/.test(await p.textContent("#images-model-hint")));
      await p.screenshot({ path: "test/ui/screenshots/options-images-on.png", clip: await p.locator("#images-group").boundingBox() });
      await p.selectOption("#images-model", "gpt-image-1-mini");
      check("model saved", await eventually(async () => (await saved()).some((s) => s.imageModel === "gpt-image-1-mini")));
      check("its hint follows", await eventually(async () => /2 cents/.test(await p.textContent("#images-model-hint"))));
      await p.click("#images-on");
      check("off saved", await eventually(async () => (await saved()).some((s) => s.imageGeneration === false)));
      check("off hides the model", await eventually(async () => !(await shown(p, "#images-model"))));
      await p.screenshot({ path: "test/ui/screenshots/options-images-off.png", clip: await p.locator("#images-group").boundingBox() });
      await optChecks(p, "images", checks);
      await p.ctx.close();
    },
  },
  // Test voice with Realtime: a short relay session in the chosen voice and speed says the sample, then closes; when
  // the server cannot run Realtime, it says so.
  {
    name: "options-voice-test-realtime",
    size: { w: 1280 },
    scheme: "light",
    async run({ openOptions, optChecks }) {
      const edit = (d) => (d.state.settings = { ...d.state.settings, realtimeVoice: "cedar", realtimeSpeed: 1.2 });
      const p = await openOptions({ w: 1280, h: 1000 }, "light", "opt-paid", "#voice", edit, [installVoiceFakes]);
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      await p.click("#speech-test");
      check("connecting shown", await eventually(async () => (await p.textContent("#speech-test-msg")) === "Connecting…"));
      await p.waitForFunction(() => window.__rt?.sent.some((e) => e.type === "response.create"));
      const sent = await p.evaluate(() => window.__rt.sent);
      check("the voice and speed from Settings", JSON.stringify(sent[0].session.audio.output) === JSON.stringify({ format: { type: "audio/pcm", rate: 24000 }, voice: "cedar", speed: 1.2 }));
      // Word for word, out of band (realtime-client.ts lineResponse).
      check("asks for the sample line", /Say exactly this.*«Opening Gmail\./.test(sent.find((e) => e.type === "response.create")?.response?.instructions ?? ""));
      check("button busy while it runs", await p.isDisabled("#speech-test"));
      await p.evaluate(() => {
        const pcm = btoa(String.fromCharCode(...new Uint8Array(24_000 * 2 * 0.3)));
        window.__rt.emit({ type: "response.created", response: { id: "r1" } });
        window.__rt.emit({ type: "response.output_audio.delta", item_id: "a1", response_id: "r1", delta: pcm });
        window.__rt.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
      });
      check("closes once it was said", await eventually(() => p.evaluate(() => window.__rt.closedWith === 1000), 5000));
      check("done: no message, button back", await eventually(async () => (await p.textContent("#speech-test-msg")) === "" && !(await p.isDisabled("#speech-test"))));
      // The server cannot run Realtime: said in a few words.
      await p.evaluate(() => (window.__rtMode = "unavailable"));
      await p.click("#speech-test");
      check("unavailable said", await eventually(async () => (await p.textContent("#speech-test-msg")) === "Realtime voice is unavailable on the server right now.", 5000));
      await optChecks(p, "voice test realtime", checks);
      await p.ctx.close();
    },
  },
  // Interactions (wide, light): the sidebar by keyboard and hash, reveals, auto-save, keys, model, validation, Jev, sign-in.
  {
    name: "options-validation",
    size: { w: 1280 },
    scheme: "light",
    async run({ base, openOptions, optChecks, optShot }) {
      const size = { w: 1280, h: 1000 };
      const p = await openOptions(size, "light", "opt-signedout", "");
      const saves = () => p.evaluate(() => window.__requests.filter((r) => r.type === "settings.save").map((r) => r.settings));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      const selected = async (id) => (await p.getAttribute(`#tab-${id}`, "aria-selected")) === "true";
      /** Runs `action`, then waits until the auto-save it causes is answered. */
      const autoSaved = async (action) => {
        const before = (await saves()).length;
        await action();
        await p.waitForFunction(
          (n) => window.__requests.filter((r) => r.type === "settings.save").length > n && document.getElementById("save-msg").textContent !== "Saving…",
          before,
        );
      };
      /** Runs `action`, then waits until the auto-save refuses it (a field is invalid: nothing is sent). */
      const autoRefused = async (action) => {
        await action();
        await p.waitForFunction(() => document.getElementById("save-msg").textContent.startsWith("Not saved"));
      };

      // The sidebar by keyboard: Tab reaches the open section only (roving tabindex); the arrows move through the column.
      check("first section by default", await selected("account"));
      await p.focus("#tab-account");
      await p.keyboard.press("ArrowDown");
      check("ArrowDown -> AI, focused", (await selected("ai")) && (await p.evaluate(() => document.activeElement.id)) === "tab-ai");
      check("hash #ai", (await p.evaluate(() => location.hash)) === "#ai");
      check("keyboard focus is visible", await p.evaluate(() => document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).outlineStyle !== "none"));
      check("one tab stop in the sidebar", (await p.locator("#sections [tabindex='0']").count()) === 1);
      check("only the AI panel shows", (await shown(p, "#panel-ai")) && !(await shown(p, "#panel-account")));
      // The AI section's own tabs: Source first; the arrows move through them, one tab stop.
      check("AI opens on Source", (await p.getAttribute("#ai-tab-source", "aria-selected")) === "true" && (await shown(p, "#source-group")) && !(await shown(p, "#jev-group")));
      await p.focus("#ai-tab-source");
      await p.keyboard.press("ArrowRight");
      check("AI tabs: ArrowRight -> Speed, focused", (await p.getAttribute("#ai-tab-speed", "aria-selected")) === "true" && (await p.evaluate(() => document.activeElement.id)) === "ai-tab-speed");
      check("Speed shows Jev only", (await shown(p, "#jev-group")) && !(await shown(p, "#source-group")));
      await p.keyboard.press("End");
      check("AI tabs: End -> Images", (await shown(p, "#images-group")) && (await p.locator("#ai-tabs [tabindex='0']").count()) === 1);
      await p.keyboard.press("ArrowRight");
      check("AI tabs: ArrowRight wraps to Source", await shown(p, "#source-group"));
      await p.focus("#tab-ai");
      await p.keyboard.press("ArrowUp");
      check("ArrowUp -> Account", await selected("account"));
      await p.keyboard.press("ArrowRight");
      check("ArrowRight works too (the narrow row)", await selected("ai"));
      await p.keyboard.press("End");
      check("End -> Advanced", await selected("advanced"));
      await p.keyboard.press("ArrowDown");
      check("ArrowDown wraps to Account", await selected("account"));
      // A section opens at its top, wherever the last one was scrolled to.
      await p.click("#tab-ai");
      await p.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight }));
      await p.click("#tab-tasks");
      check("a new section starts at the top", (await p.evaluate(() => scrollY)) === 0);
      // Our hashchange listener runs after the page's.
      await p.evaluate(() => new Promise((r) => (addEventListener("hashchange", () => r(), { once: true }), (location.hash = "#vault"))));
      check("hash #vault -> Site logins", await selected("logins"));
      await p.click("#tab-ai");
      await p.goto(`${base}/options.html`);
      await p.waitForSelector("#helper-headline:not(:empty)", { state: "attached" });
      check("no hash: the last section", await selected("ai"));

      // Signed out: Noa AI is disabled; Log in runs sign-in and enables it.
      check("hosted disabled", !(await p.isEnabled(radio("noa"))));
      await p.click("#hosted-signin");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.signIn"));
      check("hosted enabled after sign-in", await eventually(() => p.isEnabled(radio("noa"))));
      check("signed in: plan inline", await shown(p, "#hosted-in"));

      // Claude API reveals the key and saves the choice by itself.
      check("key hidden before", !(await shown(p, "[data-secret=anthropicApiKey]")));
      await autoSaved(() => p.click(`.opt[data-brain="claude-api"] .opt-head`));
      check("key revealed", await shown(p, "[data-secret=anthropicApiKey]"));
      check("brain auto-saved", (await saves()).some((s) => s.brain === "claude-api"));
      check("Saved note", /Saved/.test(await p.textContent("#save-msg")));
      await autoSaved(() => p.click(`.opt[data-brain="claude-code"] .opt-head`));
      check("helper revealed, key hidden", (await shown(p, "#helper-headline")) && !(await shown(p, "[data-secret=anthropicApiKey]")));

      // Key: Replace, type, Save sends only that key.
      await autoSaved(() => p.click(`.opt[data-brain="claude-api"] .opt-head`));
      await p.click("[data-secret=anthropicApiKey] button:has-text('Replace')");
      await p.fill("[data-secret=anthropicApiKey] input", "sk-ant-new");
      await p.click("[data-secret=anthropicApiKey] button:has-text('Save')");
      check("key saved alone", await eventually(async () => (await saves()).some((s) => s.anthropicApiKey === "sk-ant-new" && Object.keys(s).length === 1)));
      check("key saved note", /saved/.test(await p.textContent("[data-secret=anthropicApiKey] .msg")));

      // Model: a known model saves right away; Custom… shows the id field.
      await autoSaved(() => p.selectOption("#model-select", "claude-opus-5-5"));
      check("model saved", (await saves()).some((s) => s.anthropicModel === "claude-opus-5-5"));
      check("custom field hidden", !(await shown(p, "#f-anthropicModel")));
      await p.selectOption("#model-select", "custom");
      check("custom field shown", await shown(p, "#f-anthropicModel"));
      await autoSaved(() => p.fill("#f-anthropicModel", "claude-test-model"));
      check("custom model saved", (await saves()).some((s) => s.anthropicModel === "claude-test-model"));

      // Reasoning: Thorough saves by itself and hides "Think harder when stuck"; its switch saves too.
      await autoSaved(() => p.click("#f-reasoningAutoRaise"));
      check("auto-raise off saved", (await saves()).some((s) => s.reasoningAutoRaise === false));
      await autoSaved(() => p.selectOption("#f-reasoning", "thorough"));
      check("Thorough saved", (await saves()).some((s) => s.reasoning === "thorough"));
      check("auto-raise hidden under Thorough", !(await shown(p, "#f-reasoningAutoRaise")));

      // Validation: out of range is explained and not saved; fixing it saves (the schedule is on Permission).
      await p.click("#tab-permission");
      const before = (await saves()).length;
      await autoRefused(() => p.fill("#f-maxParallelTasks", "9"));
      check("range error", /1 to 4/.test(await p.textContent("#err-maxParallelTasks")));
      check("invalid not saved", (await saves()).length === before);
      await autoSaved(() => p.fill("#f-maxParallelTasks", "3"));
      check("error cleared", (await p.textContent("#err-maxParallelTasks")) === "");
      check("fixed value saved", (await saves()).some((s) => s.maxParallelTasks === 3));
      await autoRefused(() => p.fill("#f-delayMaxSec", "10"));
      check("longest pause below shortest", /at least the shortest/.test(await p.textContent("#err-delayMaxSec")));
      await optShot(p, "options-validation", size, "light");

      // Jev off hides its key; on shows it again (Jev is on the AI section's Speed tab).
      await p.click("#tab-ai");
      await p.click("#ai-tab-speed");
      await autoSaved(() => p.click("#f-jevEnabled"));
      check("Jev off saved", (await saves()).some((s) => s.jevEnabled === false));
      check("Jev key hidden", !(await shown(p, "[data-secret=jevApiKey]")));
      await autoSaved(() => p.click("#f-jevEnabled"));
      check("Jev key shown", await shown(p, "[data-secret=jevApiKey]"));
      // The control overlay switch (Tasks) saves by itself.
      await p.click("#tab-tasks");
      await autoSaved(() => p.click("#f-showControlOverlay"));
      check("control overlay off saved", (await saves()).some((s) => s.showControlOverlay === false));
      await optChecks(p, "interactions", checks);
      await p.ctx.close();
    },
  },
  // Free plan: every billing button opens the dashboard's Billing page in a new tab (never a Stripe page from
  // here); coming back to the page refreshes the account. The section used last is remembered.
  {
    name: "options-account-free",
    size: { w: 420 },
    scheme: "light",
    async run({ base, openOptions, optChecks }) {
      const p = await openOptions({ w: 420, h: 900 }, "light", "opt-free", "#ai");
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      const BILLING = "https://app.noa.bot/billing";
      const created = () => p.evaluate(() => window.__created.slice());
      const forced = () => p.evaluate(() => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length);
      check("Get a plan", (await p.textContent("#hosted-action")) === "Get a plan");
      await p.click("#hosted-action");
      await p.waitForFunction((u) => window.__created.includes(u), BILLING);
      check("AI tab Get a plan -> Billing page", (await created()).join() === BILLING);
      check("stays on the AI tab", (await p.getAttribute("#tab-ai", "aria-selected")) === "true");
      // Back from the dashboard: blur then focus (the tab was left) refreshes plan and credit once.
      const before = await forced();
      await p.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        dispatchEvent(new Event("blur"));
        dispatchEvent(new Event("focus"));
      });
      await p.waitForFunction((n) => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length === n + 1, before);
      check("refreshed once on return", (await forced()) === before + 1);
      await p.click("#tab-account");
      await p.click("#acct-billing-open");
      await p.waitForFunction((u) => window.__created.filter((c) => c === u).length === 2, BILLING);
      await p.click("#acct-dashboard");
      await p.waitForFunction(() => window.__created.includes("https://app.noa.bot/"));
      check("no Stripe page asked for", !(await p.evaluate(() => window.__requests.some((r) => /billing/.test(r.type)))));
      check("only dashboard pages opened", (await created()).every((u) => u.startsWith("https://app.noa.bot/")));
      // A plain options.html opens the section used last: Account.
      await p.goto(`${base}/options.html`);
      await p.waitForSelector("#acct-in:not([hidden])");
      check("last section remembered: Account", (await p.getAttribute("#tab-account", "aria-selected")) === "true");
      await optChecks(p, "billing", checks);
      await p.ctx.close();
    },
  },
  // Site logins: wrong tries start over after a right one; Cancel closes the forgot steps; after the erase a new passphrase works.
  {
    name: "options-logins-recover",
    size: { w: 1280 },
    scheme: "light",
    async run({ openOptions, optChecks }) {
      const p = await openOptions({ w: 1280, h: 1000 }, "light", "ok", "#logins", lockedVault);
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      for (const guess of ["a", "b", "c"]) await tryPassphrase(p, guess);
      check("3 wrong: prominent", await forgotProminent(p));
      await tryPassphrase(p, "correct horse");
      check("the right passphrase unlocks", (await shown(p, "#vault-open")) && (await p.textContent("#vault-msg")) === "Unlocked.");
      await p.click("#vault-lock");
      await p.waitForSelector("#vault-locked:not([hidden])");
      check("wrong tries start over after an unlock", !(await forgotProminent(p)));
      await p.click("#vault-forgot");
      await p.click("#vault-erase-cancel");
      check("Cancel closes and returns focus", !(await shown(p, "#vault-forgot-box")) && (await p.evaluate(() => document.activeElement.id)) === "vault-forgot");
      await armErase(p);
      await p.click("#vault-erase");
      await p.waitForSelector("#vault-create-note:not([hidden])");
      check("focus in the new passphrase field", (await p.evaluate(() => document.activeElement.id)) === "vault-pass");
      await tryPassphrase(p, "a new start");
      check("a new passphrase opens the empty vault", (await shown(p, "#vault-open")) && (await p.textContent("#vault-sites")) === "No saved logins yet.");
      check("says so", (await p.textContent("#vault-msg")) === "Passphrase set. Add your first login.");
      await optChecks(p, "logins-recover", checks);
      await p.ctx.close();
    },
  },
];
