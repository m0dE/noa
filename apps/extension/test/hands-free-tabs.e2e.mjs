// Hands-free voice across tabs with one side panel per window, in the built extension (Playwright's Chromium,
// Chrome's fake microphone). Owner's requests: "when there's an active voice chat, make sure it clearly indicates
// where the voice is currently running regardless of which tab I'm currently viewing. and help me jump to that tab"
// (and earlier: voice on in one tab must not look live on another, where the narrator cannot see the page).
//
// Checked: hands-free started on tab A; the strip says "Voice on · Shop A". The user switches to tab B: the same panel
// stays on screen and its strip still names tab A, with Go to tab and Use voice here, nothing live; what is said goes
// to A's chat with a note naming both tabs; B's toolbar button has the grey MIC badge. Go to tab brings tab A back.
// Use voice here moves the session to B in the same panel; so does saying "use this tab". Another window's panel shows
// the session (Go to tab, Use voice here, Turn off): Go to tab brings back tab A and its window, Turn off ends it, and
// Use voice here moves a muted session there still muted.
//
// Usage: pnpm build && node apps/extension/test/hands-free-tabs.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, launchExtension, openSidePanel } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { micAllowedPreferences, writeSpeechLikeWav } from "../../../test/fixtures/voice/speech-wav.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "test", "ui", "screenshots", "e2e");
mkdirSync(shots, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "noa-hf-tabs-"));
// Quiet after a short sound: the session listens and nothing is sent.
const audioFile = writeSpeechLikeWav(join(scratch, "speech.wav"), { seconds: 10 });

/**
 * Runs in a side panel before its scripts: signed in on Plus with the Standard engine (the mic unlocked), no message
 * goes out (window.__sent), speech is not said aloud, and window.__pushToPanel(msg) delivers a message as the
 * background's UI port would. The ports and every other request are the real ones.
 */
const STUBS = `(() => {
  const plus = (s) => {
    if (!s || typeof s !== "object" || !("settings" in s) || !("brain" in s)) return s;
    const a = s.account ?? {};
    return { ...s, settings: { ...s.settings, voiceEngine: "standard" },
      account: { ...a, signedIn: true, user: { email: "voice@example.com", name: "Voice Test", pictureUrl: null },
        plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false },
        credit: { subscriptionCents: 1000, topupCents: 0, totalCents: 1000, periodGrantCents: 2000, periodEnd: null } } };
  };
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  window.__sent = [];
  chrome.runtime.sendMessage = async (msg, ...rest) => {
    if (msg?.type === "voice.transcribe") return { ok: true, data: { text: window.__transcript ?? "What is on this page?" } };
    if (msg?.type === "run.message" && msg.voice) { window.__sent.push({ text: msg.text, context: msg.context ?? null, tabId: msg.tabId ?? null, sessionId: msg.sessionId ?? null }); return { ok: true, data: { sessionId: "s-hf", mode: "new" } }; }
    const res = await send(msg, ...rest);
    return res?.ok ? { ...res, data: plus(res.data) } : res;
  };
  const connect = chrome.runtime.connect.bind(chrome.runtime);
  const listeners = [];
  window.__pushToPanel = (m) => listeners.forEach((l) => l(m));
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const addListener = port.onMessage.addListener.bind(port.onMessage);
    port.onMessage.addListener = (l) => { listeners.push(l); addListener((m) => l(m?.type === "state" ? { ...m, state: plus(m.state) } : m)); };
    return port;
  };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
    speak(u) { setTimeout(() => u.onend?.(), 50); }, cancel() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {} } });
})();`;

/** What a panel shows of voice: the bar, the mic button, the box, and the page's live marks. */
const VOICE_LOOK = `(() => {
  const bar = document.getElementById("voice-bar");
  const mic = document.querySelector("#now-actions .voice-mic");
  const box = document.getElementById("now-text");
  const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none";
  const links = !bar.querySelector(".vb-links").hidden;
  return {
    visible: document.visibilityState === "visible",
    mark: window.__mark ?? null,
    bar: { shown: !bar.hidden, state: bar.hidden ? null : bar.dataset.state ?? null, phase: bar.dataset.phase ?? null,
      label: bar.querySelector(".vb-label")?.textContent ?? "", status: bar.querySelector(".vb-status")?.textContent ?? "", detail: bar.title,
      go: links && vis(bar.querySelector(".vb-go")), use: links && vis(bar.querySelector(".vb-use")), stop: links && vis(bar.querySelector(".vb-off")),
      meter: vis(bar.querySelector(".vb-meter")) },
    mic: { state: mic?.dataset.state ?? null, pressed: mic?.getAttribute("aria-pressed") ?? null, title: mic?.title ?? "" },
    box: { placeholder: box?.placeholder ?? "", classes: box?.className ?? "" },
    voiceLive: document.body.classList.contains("voice-live"),
    orb: vis(document.querySelector(".voice-orb")),
  };
})()`;

/** A DevTools target (a real side panel is not a Playwright page): evaluate, send, screenshot. */
async function cdpConnect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  const send = (method, params) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    async evaluate(expression) {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
      return res.result?.result?.value;
    },
    async screenshot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, "base64"));
    },
    close: () => ws.close(),
  };
}

const site = await serveHtml((path) => `<!doctype html><title>${path.includes("b") ? "Recipes B" : path.includes("c") ? "Notes C" : "Shop A"}</title><body><h1>${path}</h1></body>`);
const { step, finish } = createSuite("hands-free-tabs");
const ext = await launchExtension({
  name: "hf-tabs",
  prefs: micAllowedPreferences(EXTENSION_ID),
  args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audioFile}`, "--remote-debugging-port=0"],
});
const { context, sw, extensionId, profile } = ext;
const devtoolsPort = await waitFor(() => Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]), "DevToolsActivePort");
const badgeOf = (tabId) => sw.evaluate(async (t) => chrome.action.getBadgeText({ tabId: t }), tabId);
/** A tab's badge: its text and colour ("live" red, "elsewhere" grey, as MUTE is too; see voice-session.ts VOICE_BADGES). */
const badgeLook = (tabId) =>
  sw.evaluate(async (t) => {
    const text = await chrome.action.getBadgeText({ tabId: t });
    if (!text) return "";
    const [r, g, b] = await chrome.action.getBadgeBackgroundColor({ tabId: t });
    return `${text}:${r === 200 && g === 35 && b === 63 ? "live" : r === 128 && g === 134 && b === 139 ? "elsewhere" : `${r},${g},${b}`}`;
  }, tabId);
const session = () => sw.evaluate(() => globalThis.__noa.voiceSessions.view());
const opened = [];

/** The side panel page of window `windowId` (its DevTools target), once it runs. */
async function panelTarget(windowId) {
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  for (const t of targets.filter((x) => x.type !== "service_worker" && URL.canParse(x.url) && new URL(x.url).pathname === "/sidepanel.html")) {
    const p = await cdpConnect(t);
    if ((await p.evaluate(`chrome.windows.getCurrent().then((w) => w.id)`)) === windowId) return p;
    p.close();
  }
  return null;
}

/** Opens window `windowId`'s side panel from `opener` (an extension page there), stubs it (Plus) and waits until its mic is unlocked. */
async function openPanel(opener, windowId) {
  await openSidePanel(sw, opener, windowId);
  const panel = await waitFor(() => panelTarget(windowId), `window ${windowId}'s side panel target`);
  opened.push(panel);
  await panel.send("Page.enable");
  await panel.send("Page.addScriptToEvaluateOnNewDocument", { source: STUBS });
  await panel.send("Page.reload", {});
  await waitFor(() => panel.evaluate(`document.querySelector("#now-actions .voice-mic")?.dataset.state === "idle"`), `window ${windowId}'s panel on Plus`, { timeout: 15_000 });
  return panel;
}

try {
  const pageA = await context.newPage();
  await pageA.goto(`${site.base}/a`);
  const pageB = await context.newPage();
  await pageB.goto(`${site.base}/b`);
  // The extension page whose click opens the panel (a user gesture), in the same window.
  const opener = await context.newPage();
  await opener.goto(`chrome-extension://${extensionId}/mic-permission.html#opener`);
  const ids = await sw.evaluate(async (base) => {
    const a = (await chrome.tabs.query({ url: `${base}/a` }))[0];
    const b = (await chrome.tabs.query({ url: `${base}/b` }))[0];
    return { a: a.id, b: b.id, windowId: a.windowId };
  }, site.base);
  const activate = (tab) => sw.evaluate((t) => chrome.tabs.update(t, { active: true }), tab);
  const activeTab = (windowId) => sw.evaluate(async (w) => (await chrome.tabs.query({ active: true, windowId: w }))[0]?.id, windowId);
  const startVoice = async (panel) => {
    await panel.evaluate(`window.__pushToPanel({ type: "panel.voice" })`);
    await waitFor(() => panel.evaluate(`document.getElementById("voice-bar").dataset.phase === "listening"`), "listening", { timeout: 10_000 });
  };
  const stopVoice = async (panel, tab) => {
    await panel.evaluate(`document.querySelector("#now-actions .voice-mic").click()`);
    await waitFor(async () => (await badgeOf(tab)) === "" && (await session()) === null, "voice to end");
  };

  let panel;
  await step("hands-free starts on tab A: the strip says where ('Voice on · Shop A'), live, and the MIC badge is on tab A", async () => {
    panel = await openPanel(opener, ids.windowId);
    await panel.evaluate(`window.__mark = "the page"`);
    await activate(ids.a);
    await startVoice(panel);
    assert.equal(await waitFor(async () => (await badgeOf(ids.a)) || null, "MIC on A"), "MIC");
    const look = await waitFor(async () => {
      const l = await panel.evaluate(VOICE_LOOK);
      return l.bar.label === "Voice on · Shop A" ? l : null;
    }, "the strip to name tab A");
    assert.ok(look.bar.shown && look.bar.state !== "elsewhere" && look.voiceLive && !look.bar.go && !look.bar.use, JSON.stringify(look));
    return JSON.stringify(look.bar);
  });

  await step("switching to tab B: the same panel stays on screen, its strip still names tab A with Go to tab and Use voice here; what is said goes to A with a note; B has the grey badge", async () => {
    const before = await panel.evaluate(`window.__sent.length`);
    await activate(ids.b);
    await waitFor(() => panel.evaluate(`document.getElementById("voice-bar").dataset.state === "elsewhere"`), "the strip to say it listens in another tab");
    const look = await panel.evaluate(VOICE_LOOK);
    await panel.screenshot(join(shots, "hands-free-tabs-B.png"));
    // Said while the user looks at tab B: to A's chat as said, with the note as the message's context (the agent gets it, the chat does not show it).
    const said = await waitFor(() => panel.evaluate(`window.__sent[${before}] ?? null`), "a message said while tab B shows", { timeout: 30_000 });
    const badges = { a: await badgeLook(ids.a), b: await badgeLook(ids.b) };
    const evidence = JSON.stringify({ said, tabA: ids.a, tabB: ids.b, look, badges });
    assert.ok(look.visible && look.mark === "the page", `the same panel, on screen: ${evidence}`);
    assert.equal(look.bar.label, "Voice on · Shop A", evidence);
    assert.ok(look.bar.go && look.bar.use && !look.bar.stop, `Go to tab and Use voice here (the mic ends it here): ${evidence}`);
    assert.equal(look.voiceLive, false, evidence);
    assert.equal(look.bar.meter, false, evidence);
    assert.equal(said.tabId, ids.a, evidence);
    assert.equal(said.text, "What is on this page?", evidence);
    assert.match(said.context ?? "", /^The user is looking at another tab: Recipes B \(127\.0\.0\.1:\d+\)\. You work in Shop A \(127\.0\.0\.1:\d+\)\.$/, evidence);
    assert.deepEqual(badges, { a: "MIC:live", b: "MIC:elsewhere" }, evidence);
    return evidence;
  });

  await step("Go to tab brings tab A to the front: the strip is the plain live one again, the grey badge goes", async () => {
    await panel.evaluate(`document.querySelector("#voice-bar .vb-go").click()`);
    await waitFor(async () => (await activeTab(ids.windowId)) === ids.a, "tab A to be the active tab");
    const look = await waitFor(async () => {
      const l = await panel.evaluate(VOICE_LOOK);
      return l.bar.state !== "elsewhere" && l.voiceLive ? l : null;
    }, "the live strip on tab A");
    await waitFor(async () => (await badgeLook(ids.b)) === "", "B's grey badge to go");
    assert.ok(!look.bar.go && !look.bar.use && look.bar.label === "Voice on · Shop A", JSON.stringify(look));
    return JSON.stringify(look.bar);
  });

  await step("on tab B, Use voice here moves the session to B in the same panel: the strip names Recipes B, the badge moves", async () => {
    await activate(ids.b);
    await waitFor(() => panel.evaluate(`document.getElementById("voice-bar").dataset.state === "elsewhere"`), "the strip on B");
    await panel.evaluate(`document.querySelector("#voice-bar .vb-use").click()`);
    await waitFor(async () => (await session())?.tabId === ids.b, "the session to be tab B's");
    const look = await waitFor(async () => {
      const l = await panel.evaluate(VOICE_LOOK);
      return l.bar.label === "Voice on · Recipes B" && l.voiceLive ? l : null;
    }, "the strip to name tab B, live");
    await waitFor(async () => (await badgeLook(ids.b)) === "MIC:live" && (await badgeLook(ids.a)) === "", "the badge to move to B");
    assert.equal(look.mark, "the page");
    await stopVoice(panel, ids.b);
    return JSON.stringify(look.bar);
  });

  await step("voice on A again; on tab B the user says 'use this tab': it moves to B, one session, the same panel", async () => {
    await activate(ids.a);
    await startVoice(panel);
    const panelId = (await session()).panel;
    await activate(ids.b);
    await waitFor(() => panel.evaluate(`document.getElementById("voice-bar").dataset.state === "elsewhere"`), "the strip on B");
    await panel.evaluate(`window.__transcript = "Use this tab."`);
    await waitFor(async () => (await session())?.tabId === ids.b, "the session to move to B", { timeout: 30_000 });
    await waitFor(async () => (await badgeLook(ids.b)) === "MIC:live" && (await badgeLook(ids.a)) === "", "the badge on B");
    const s = await session();
    assert.equal(s.panel, panelId, JSON.stringify(s));
    assert.equal(await panel.evaluate(`window.__sent.some((m) => /use this tab/i.test(m.text))`), false, "'use this tab' is not sent to the agent");
    await panel.evaluate(`window.__transcript = undefined`);
    await stopVoice(panel, ids.b);
    return JSON.stringify(s);
  });

  let panel2;
  let tabC;
  let window2;
  await step("another window's panel shows where voice runs (Go to tab, Use voice here, Turn off), nothing live; Go to tab brings back tab A and its window", async () => {
    await activate(ids.a);
    await startVoice(panel);
    const pageC = await context.newPage();
    await pageC.goto(`${site.base}/c`);
    const opener2 = await context.newPage();
    await opener2.goto(`chrome-extension://${extensionId}/mic-permission.html#opener2`);
    ({ tabC, window2 } = await sw.evaluate(async (base) => {
      const c = (await chrome.tabs.query({ url: `${base}/c` }))[0];
      const w = await chrome.windows.create({ tabId: c.id, focused: true });
      const o = (await chrome.tabs.query({})).find((t) => t.url?.endsWith("/mic-permission.html#opener2"));
      await chrome.tabs.move(o.id, { windowId: w.id, index: -1 });
      await chrome.tabs.update(o.id, { active: true });
      return { tabC: c.id, window2: w.id };
    }, site.base));
    panel2 = await openPanel(opener2, window2);
    await sw.evaluate((t) => chrome.tabs.update(t, { active: true }), tabC);
    const look = await waitFor(async () => {
      const l = await panel2.evaluate(VOICE_LOOK);
      return l.bar.shown && l.bar.label === "Voice on · Shop A" ? l : null;
    }, "window 2's strip to name tab A");
    await panel2.screenshot(join(shots, "hands-free-tabs-window2.png"));
    const evidence = JSON.stringify(look);
    assert.equal(look.bar.state, "elsewhere", evidence);
    assert.ok(look.bar.go && look.bar.use && look.bar.stop, evidence);
    assert.equal(look.voiceLive, false, evidence);
    assert.notEqual(look.mic.state, "handsfree", evidence);
    assert.ok(!/Listening/i.test(look.box.placeholder), evidence);
    assert.equal(look.bar.meter, false, evidence);
    await waitFor(async () => (await badgeLook(tabC)) === "MIC:elsewhere", "the grey badge on tab C");
    // Window focus is not real in headless Chromium: what the extension asks of Chrome is recorded.
    await sw.evaluate(() => {
      const update = chrome.windows.update.bind(chrome.windows);
      globalThis.__focused = [];
      chrome.windows.update = (id, info) => (info?.focused && globalThis.__focused.push(id), update(id, info));
    });
    await sw.evaluate((t) => chrome.tabs.update(t, { active: true }), ids.b);
    await panel2.evaluate(`document.querySelector("#voice-bar .vb-go").click()`);
    await waitFor(async () => (await activeTab(ids.windowId)) === ids.a, "tab A to be window 1's active tab");
    assert.deepEqual(await waitFor(() => sw.evaluate(() => (globalThis.__focused.length ? globalThis.__focused : null)), "window 1 to be focused"), [ids.windowId]);
    return evidence;
  });

  await step("Turn off in window 2's strip ends the session in window 1: both strips go, no badge", async () => {
    await panel2.evaluate(`document.querySelector("#voice-bar .vb-off").click()`);
    await waitFor(async () => !(await panel.evaluate(VOICE_LOOK)).bar.shown && !(await panel2.evaluate(VOICE_LOOK)).bar.shown, "both strips gone");
    await waitFor(async () => (await badgeOf(ids.a)) === "" && (await session()) === null, "no badge, no session");
    return "ended";
  });

  await step("muted on A: grey MUTE badges; window 2's strip says so; Use voice here there runs it in window 2, still muted", async () => {
    await activate(ids.a);
    await startVoice(panel);
    await panel.evaluate(`document.querySelector("#now-actions .voice-mute").click()`);
    await waitFor(async () => (await badgeLook(ids.a)) === "MUTE:elsewhere", "the grey MUTE badge on A");
    const a = await panel.evaluate(VOICE_LOOK);
    assert.ok(a.bar.state === "muted" && !a.voiceLive && !a.bar.meter, JSON.stringify(a));
    await sw.evaluate((w) => chrome.windows.update(w, { focused: true }), window2);
    await waitFor(async () => (await badgeLook(tabC)) === "MUTE:elsewhere", "the grey MUTE badge on tab C");
    await waitFor(() => panel2.evaluate(`document.querySelector("#voice-bar .vb-status").textContent === "Muted"`), "window 2's strip to say it is muted");
    await panel2.evaluate(`document.querySelector("#voice-bar .vb-use").click()`);
    await waitFor(() => panel2.evaluate(`document.getElementById("voice-bar").dataset.state === "muted"`), "window 2 to run the session, muted", { timeout: 10_000 });
    await waitFor(async () => (await badgeLook(tabC)) === "MUTE:elsewhere" && (await badgeLook(ids.a)) === "", "the MUTE badge moved to tab C");
    const c = await panel2.evaluate(VOICE_LOOK);
    assert.equal(c.voiceLive, false, JSON.stringify(c));
    assert.match(c.box.placeholder, /muted/i, JSON.stringify(c));
    assert.equal(c.bar.label, "Voice on · Notes C", JSON.stringify(c));
    const s = await session();
    assert.equal(s.muted, true, JSON.stringify(s));
    assert.equal(s.tabId, tabC, JSON.stringify(s));
    await panel2.screenshot(join(shots, "hands-free-tabs-window2-muted.png"));
    // Unmuted there, the badge is the live MIC again.
    await panel2.evaluate(`document.querySelector("#now-actions .voice-mute").click()`);
    await waitFor(async () => (await badgeLook(tabC)) === "MIC:live", "MIC on tab C once unmuted");
    await stopVoice(panel2, tabC);
    return JSON.stringify({ aMuted: a.bar, cMuted: c.bar, session: s });
  });
} finally {
  for (const p of opened) p.close();
  await ext.close();
  await site.close();
  rmSync(scratch, { recursive: true, force: true });
}
finish();
