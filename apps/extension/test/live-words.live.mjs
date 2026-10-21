// The user's words while they talk, with Realtime voice, in the built extension's real side panel against the real
// OpenAI Realtime API (no Noa server: the panel's ticket points at OpenAI with the key, as a browser would through the
// relay). Chrome's fake microphone says two turns (OpenAI TTS): small talk, then a request. Every 150 ms the run
// samples what the panel shows (your words and Noa's above the box) and what was sent to the agent, and prints
// the timeline: the words must show while the clip is still speaking, stay after the turn, and the request must go out.
//
// Owner's report (ticket 1bba1841): "when i talk, show the live transcription so I know you can listen".
//
// Usage: pnpm --filter @noa/extension build && OPENAI_API_KEY=... node apps/extension/test/live-words.live.mjs [--headed]
//   NOA_LIVE_SAY="first turn|second turn" overrides the two turns.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, launchExtension, openSidePanel } from "../../../test/e2e/lib/extension.mjs";
import { waitFor } from "../../../test/e2e/lib/suite.mjs";
import { micAllowedPreferences } from "../../../test/fixtures/voice/speech-wav.mjs";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) throw new Error("OPENAI_API_KEY is needed");
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const TURNS = (process.env.NOA_LIVE_SAY || "Hi Noa, can you hear me okay?|Open my inbox and find the latest invoice from Neon, then tell me how much it was for last month.").split("|");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "test", "ui", "screenshots", "e2e");
mkdirSync(shots, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "noa-live-words-"));

// --- The microphone's clip: 2 s of quiet, each turn followed by 6 s of quiet, then 40 s (Chrome loops the file).
const RATE = 24_000;
const silence = (s) => Buffer.alloc(Math.round(s * RATE) * 2);
async function tts(text) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}
const parts = [silence(2)];
/** When each turn's speech starts and ends in the clip, in ms. */
const spoken = [];
let at = 2000;
for (const text of TURNS) {
  const pcm = await tts(text);
  const ms = pcm.length / 2 / (RATE / 1000);
  spoken.push({ text, from: at, to: at + ms });
  parts.push(pcm, silence(6));
  at += ms + 6000;
}
parts.push(silence(40));
const pcm = Buffer.concat(parts);
const wav = Buffer.alloc(44);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + pcm.length, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(pcm.length, 40);
const audioFile = join(scratch, "mic.wav");
writeFileSync(audioFile, Buffer.concat([wav, pcm]));

/** In the panel before its scripts: Plus with Realtime, the ticket to OpenAI itself, messages to the agent recorded. */
const STUBS = `(() => {
  const plus = (s) => {
    if (!s || typeof s !== "object" || !("settings" in s) || !("brain" in s)) return s;
    const a = s.account ?? {};
    return { ...s, settings: { ...s.settings, voiceEngine: "realtime", voiceSounds: false },
      account: { ...a, signedIn: true, user: { email: "voice@example.com", name: "Voice Test", pictureUrl: null },
        plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false },
        credit: { subscriptionCents: 1000, topupCents: 0, totalCents: 1000, periodGrantCents: 2000, periodEnd: null } } };
  };
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  window.__sent = [];
  chrome.runtime.sendMessage = async (msg, ...rest) => {
    if (msg?.type === "voice.engines") return { ok: true, data: { error: "offline" } };
    if (msg?.type === "voice.realtime") return { ok: true, data: { url: "wss://api.openai.com/v1/realtime?model=${MODEL}", token: "x" } };
    if (msg?.type === "run.message" || msg?.type === "run.adhoc") { window.__sent.push({ t: performance.now(), text: msg.text ?? msg.instructions }); return { ok: true, data: { sessionId: "s-live", mode: "new" } }; }
    const res = await send(msg, ...rest);
    return res?.ok ? { ...res, data: plus(res.data) } : res;
  };
  const connect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const addListener = port.onMessage.addListener.bind(port.onMessage);
    port.onMessage.addListener = (l) => addListener((m) => l(m?.type === "state" ? { ...m, state: plus(m.state) } : m));
    return port;
  };
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url) { super(url, ["realtime", "openai-insecure-api-key.${KEY}"]); }
  };
})();`;

/** What the panel shows of the user's words. */
const LOOK = `(() => {
  const you = document.querySelector("#now-heard .now-heard-you");
  const noa = document.querySelector("#now-heard .now-heard-noa");
  return {
    t: performance.now(),
    line: you && !you.hidden && !you.closest("[hidden]") ? you.textContent : null,
    lineLive: you?.dataset.live === "true",
    caption: noa && !noa.hidden && !noa.closest("[hidden]") ? noa.textContent : null,
    talking: false,
    covered: !!document.querySelector(".voice-orb, .voice-caption"),
    phase: document.getElementById("voice-bar").dataset.phase ?? null,
    sent: window.__sent.map((s) => s.text),
  };
})()`;

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

const ext = await launchExtension({
  name: "live-words",
  prefs: micAllowedPreferences(EXTENSION_ID),
  args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audioFile}`, "--remote-debugging-port=0", "--autoplay-policy=no-user-gesture-required"],
});
const { context, sw, extensionId, profile } = ext;
let failed = false;
try {
  const devtoolsPort = await waitFor(() => Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]), "DevToolsActivePort");
  const page = await context.newPage();
  await page.goto("https://example.com/");
  const opener = await context.newPage();
  await opener.goto(`chrome-extension://${extensionId}/mic-permission.html#opener`);
  const { windowId, tabId } = await sw.evaluate(async () => {
    const t = (await chrome.tabs.query({ url: "https://example.com/*" }))[0];
    return { windowId: t.windowId, tabId: t.id };
  });
  await openSidePanel(sw, opener, windowId);
  const panel = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
    const t = targets.find((x) => URL.canParse(x.url) && new URL(x.url).pathname === "/sidepanel.html");
    return t ? cdpConnect(t) : null;
  }, "the side panel");
  await panel.send("Page.enable");
  await panel.send("Page.addScriptToEvaluateOnNewDocument", { source: STUBS });
  await panel.send("Page.reload", {});
  await waitFor(() => panel.evaluate(`document.querySelector("#now-actions .voice-mic")?.dataset.state === "idle"`), "the panel on Plus", { timeout: 15_000 });
  await sw.evaluate((t) => chrome.tabs.update(t, { active: true }), tabId);
  await panel.evaluate(`document.querySelector("#now-actions .voice-mic").click()`);
  await waitFor(() => panel.evaluate(`document.getElementById("voice-bar").dataset.phase === "listening"`), "listening", { timeout: 20_000 });
  // The fake microphone's clip restarts when the capture opens: time from here (within a few hundred ms).
  const t0 = await panel.evaluate(`performance.now()`);
  const samples = [];
  const end = spoken.at(-1).to + 9000;
  let shotMid = false;
  while (true) {
    const look = await panel.evaluate(LOOK);
    look.ms = Math.round(look.t - t0);
    samples.push(look);
    const second = spoken.at(-1);
    if (!shotMid && look.ms > (second.from + second.to) / 2 && look.line) {
      shotMid = true;
      await panel.screenshot(join(shots, "live-words-mid-speech.png"));
    }
    if (look.ms > end) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await panel.screenshot(join(shots, "live-words-after.png"));

  // The timeline, one line per change.
  let last = "";
  for (const s of samples) {
    const key = JSON.stringify([s.line, s.lineLive, s.caption, s.talking, s.phase, s.sent.length]);
    if (key === last) continue;
    last = key;
    const during = spoken.find((x) => s.ms >= x.from && s.ms <= x.to);
    console.log(`${String(s.ms).padStart(6)} ms ${during ? "[speaking]" : "          "} line=${JSON.stringify(s.line)}${s.lineLive ? " (live)" : ""} caption=${JSON.stringify(s.caption)}${s.talking ? " (talking)" : ""} phase=${s.phase} sent=${s.sent.length}`);
  }
  console.log("clip:", JSON.stringify(spoken.map((x) => ({ ...x, from: Math.round(x.from), to: Math.round(x.to) }))));
  console.log("sent to the agent:", JSON.stringify(samples.at(-1).sent));

  // Words showed while each turn was still being said (the clip's timing is within a few hundred ms of the panel's).
  for (const turn of spoken) {
    const live = samples.filter((s) => s.ms > turn.from && s.ms < turn.to - 300 && s.lineLive && s.line);
    console.log(`turn "${turn.text.slice(0, 40)}…": ${live.length} samples with live words while speaking; first at ${live[0] ? live[0].ms - Math.round(turn.from) : "-"} ms into it`);
    assert.ok(live.length > 0, `no live words while saying "${turn.text}"`);
  }
  assert.ok(samples.every((s) => !s.covered), "nothing covers the panel");
  // The last turn's words stay after it.
  const after = samples.filter((s) => s.ms > spoken.at(-1).to + 3000);
  assert.ok(after.length && after.every((s) => s.line), "the last turn's words stay on the line after it");
  console.log("PASS");
} catch (err) {
  failed = true;
  console.error("FAIL", err);
} finally {
  await context.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
