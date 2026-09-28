// The Raw view's canned conversation for the UI harness: three turns started by voice (two on Standard: speech,
// transcript, sending window; one on Realtime: connecting, the narrator's reply, send_to_agent, the user's words),
// Claude Code with its model calls and tools, act steps with Jev, lines said back and a barge-in, and a few slow
// items. The trace is built with the extension's own reducer
// (src/trace/trace-book.ts, bundled here with esbuild), so its totals are the real ones.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bundled = join(mkdtempSync(join(tmpdir(), "bt-trace-book-")), "trace-book.mjs");
await build({ entryPoints: [join(root, "src/trace/trace-book.ts")], bundle: true, platform: "node", format: "esm", outfile: bundled, logLevel: "warning" });
const { newBook, beginTurn, addEvent, observe, linkCid } = await import(pathToFileURL(bundled).href);

export const RAW_SESSION = "s-raw";
/** A made-up secret the export must not carry (the page shows it; Copy and Download redact it). */
export const RAW_SECRET = "abc123secretXYZtoken";

/** Adds the "raw" conversation to a scenario's data (bound to tab 1) and returns its trace.get answer. */
export function rawScenario({ state, sessions, eventsBySession }) {
  const T0 = Date.now() - 5 * 60_000;
  const T1 = T0 + 60_000;
  const T2 = T1 + 60_000;
  const book = newBook(RAW_SESSION);
  const events = [];
  const at = (t) => new Date(t).toISOString();
  /** A conversation event at time t, counted by the trace as the engine would. */
  const ev = (t, e) => {
    events.push({ ...e, ts: at(t), sessionId: RAW_SESSION });
    observe(book, e, t);
  };
  const tr = (e) => addEvent(book, { src: "engine", ...e });
  const deltas = (from, n, every) => {
    for (let i = 0; i < n; i++) observe(book, { type: "assistant_text_delta", id: "m:1", text: "…" }, from + i * every);
  };

  // ---- Turn 1: said, not typed (Standard voice).
  const u1 = "utt-1";
  beginTurn(book, 1, T0, { brain: "claude-code", jev: true, source: "adhoc", model: "claude-sonnet-5", voice: true, chars: 64 });
  linkCid(book, u1);
  tr({ t: T0 - 4200, cat: "voice", name: "voice.speech", src: "panel", cid: u1 });
  tr({ t: T0 - 2600, ms: 780, cat: "voice", name: "voice.transcript", src: "panel", cid: u1, data: { chars: 64, requests: 3, requestAfterMs: 35, lastRequestMs: 612, lastKB: 41, reason: "send", waitMs: 780, model: "@cf/deepgram/nova-3" } });
  tr({ t: T0 - 1820, cat: "voice", name: "voice.heard", src: "panel", cid: u1, data: { chars: 64 } });
  tr({ t: T0 - 1820, ms: 1200, cat: "voice", name: "voice.send_window", src: "panel", cid: u1, data: { waitMs: 1200 } });
  tr({ t: T0 - 620, ms: 598, cat: "voice", name: "voice.deliver", src: "panel", cid: u1, data: { chars: 64, waitMs: 598 } });
  tr({ t: T0 - 600, ms: 35, cat: "brain", name: "brain.resolve", data: { brain: "claude-code", mode: "auto", model: "claude-sonnet-5", jev: true } });
  tr({ t: T0 + 5, ms: 140, cat: "turn", name: "engine.tab", data: { mode: "current-tab" } });
  tr({ t: T0 + 150, cat: "brain", name: "brain.start", data: { brain: "claude-code", fresh: true, chars: 412 } });
  tr({ t: T0 + 170, ms: 12, cat: "brain", name: "helper.setup", src: "helper", data: { jev: true, media: 0 } });
  tr({ t: T0 + 185, ms: 1450, cat: "brain", name: "claude.ready", src: "helper", data: { model: "claude-sonnet-5", version: "2.1.282" } });
  ev(T0 + 1640, { type: "status", text: "Claude Code started (claude-sonnet-5)" });
  const call = (t, ms, d) => tr({ t, ms, cat: "model", name: "model.call", src: "helper", data: { model: "claude-sonnet-5", sinceInputMs: 3, ...d } });
  call(T0 + 1640, 4100, { responseMs: 2350, firstTokenMs: 2380, firstTextMs: 3500, firstToolMs: 3900, deltas: 18, toolUses: 1, inTokens: 8, cacheReadTokens: 18420, cacheWriteTokens: 5320, outTokens: 212, stop: "tool_use" });
  deltas(T0 + 5140, 6, 60);
  ev(T0 + 5700, { type: "assistant_text", text: "I'll look up flights to Lisbon for next Friday on Google Flights.", id: "m:1" });
  const tool = (t, ms, id, name, args, result, extra = {}) => {
    ev(t, { type: "tool_call", id, name, args });
    tr({ t, ms, cat: "tool", name: "tool", src: "helper", data: { tool: name, id, args: JSON.stringify(args), chars: result.length, ...extra } });
    ev(t + ms, { type: "tool_result", id, name, text: result, ...(extra.error ? { isError: true } : {}) });
  };
  const flightsUrl = "https://www.google.com/travel/flights?q=Flights%20to%20LIS%20on%202026-10-02&access_token=abc123secretXYZtoken";
  tool(T0 + 5800, 6230, "t1", "navigate", { url: flightsUrl }, "Navigated to https://www.google.com/travel/flights\nTitle: Google Flights");
  tr({ t: T0 + 5815, ms: 6190, cat: "browser", name: "browser.navigate", data: { driver: "cdp", host: "www.google.com" } });
  call(T0 + 12040, 3200, { responseMs: 1900, firstTokenMs: 1930, firstToolMs: 2950, deltas: 0, toolUses: 1, inTokens: 4, cacheReadTokens: 23740, cacheWriteTokens: 610, outTokens: 88, stop: "tool_use" });
  tool(T0 + 15300, 820, "t2", "read_page", {}, `URL: https://www.google.com/travel/flights\nTitle: Google Flights\n${"[12] link \"Friday, October 2\"\n".repeat(40)}`);
  tr({ t: T0 + 15310, ms: 790, cat: "browser", name: "browser.readPage", data: { driver: "cdp", elements: 412, chars: 16200 } });
  call(T0 + 16130, 5200, { responseMs: 2100, firstTokenMs: 2120, firstTextMs: 2400, firstToolMs: 4900, deltas: 22, toolUses: 1, inTokens: 6, cacheReadTokens: 24350, cacheWriteTokens: 4980, outTokens: 301, stop: "tool_use" });
  deltas(T0 + 18530, 8, 90);
  ev(T0 + 21300, { type: "assistant_text", text: "Filling in the destination and searching.", id: "m:2" });
  ev(T0 + 21400, { type: "tool_call", id: "t3", name: "act", args: { steps: [{ goal: "type into the Where to? field", text: "Lisbon" }, { goal: "click the Search button" }] } });
  tr({ t: T0 + 21400, ms: 2900, cat: "tool", name: "tool", src: "helper", data: { tool: "act", id: "t3", args: '{"steps":[{"goal":"type into the Where to? field","text":"Lisbon"},{"goal":"click the Search button"}]}', chars: 5120 } });
  tr({ t: T0 + 21405, ms: 1240, cat: "act", name: "act.step", src: "helper", data: { step: 1, goal: "type into the Where to? field", readMs: 180, performMs: 420, ran: true, picker: "jev", jevMs: 640, confidence: 0.97, operation: "type" } });
  ev(T0 + 22045, { type: "jev", goal: "type into the Where to? field", operation: "type", index: 14, confidence: 0.97, executed: true, ms: 640 });
  tr({ t: T0 + 21410, ms: 176, cat: "browser", name: "browser.readPage", data: { driver: "cdp", elements: 398, chars: 15800 } });
  tr({ t: T0 + 22050, ms: 118, cat: "browser", name: "browser.type", data: { driver: "cdp" } });
  tr({ t: T0 + 22650, ms: 1370, cat: "act", name: "act.step", src: "helper", data: { step: 2, goal: "click the Search button", readMs: 170, performMs: 610, ran: true, picker: "jev", jevMs: 590, confidence: 0.91, operation: "click" } });
  ev(T0 + 23410, { type: "jev", goal: "click the Search button", operation: "click", index: 31, confidence: 0.91, executed: true, ms: 590 });
  tr({ t: T0 + 23420, ms: 95, cat: "browser", name: "browser.click", data: { driver: "cdp" } });
  ev(T0 + 24300, { type: "tool_result", id: "t3", name: "act", text: "step 1: typed 6 characters into [14] textbox \"Where to?\" (picked by Jev, 0.97, 640 ms)\nstep 2: clicked [31] button \"Search\" (picked by Jev, 0.91, 590 ms)\nAll 2 step(s) done." });
  call(T0 + 24330, 9800, { responseMs: 2800, firstTokenMs: 2810, firstTextMs: 2100, firstToolMs: 9600, deltas: 64, toolUses: 1, inTokens: 5, cacheReadTokens: 29330, cacheWriteTokens: 5400, outTokens: 890, stop: "tool_use" });
  deltas(T0 + 26430, 20, 150);
  ev(T0 + 30000, { type: "assistant_text", text: "The cheapest nonstop is TAP Air Portugal TP 1351, Friday 2 October, 07:05 → 09:40, $214 round trip.", id: "m:3" });
  tool(T0 + 34200, 3, "t4", "task_complete", { summary: "Cheapest flight: TAP TP 1351 on Oct 2, $214 round trip", spoken: "The cheapest is TAP at 7:05 on Friday, 214 dollars round trip." }, "Task recorded as done. Stop now.");
  tr({ t: T0 + 34250, cat: "brain", name: "claude.result", src: "helper", data: { durationMs: 32500, apiMs: 22300, modelCalls: 4, costUsd: 0.1432, inTokens: 23, outTokens: 1491, cacheReadTokens: 95840, cacheWriteTokens: 16310 } });
  ev(T0 + 34300, { type: "task_end", outcome: "done", summary: "Cheapest flight: TAP TP 1351 on Oct 2, $214 round trip", spoken: "The cheapest is TAP at 7:05 on Friday, 214 dollars round trip." });
  tr({ t: T0 + 34600, ms: 5200, cat: "voice", name: "voice.tts", src: "panel", data: { chars: 64, waitMs: 240, startMs: 240, cut: false } });
  ev(T0 + 39800, { type: "spoken", text: "The cheapest is TAP at 7:05 on Friday, 214 dollars round trip." });

  // ---- Turn 2: another spoken message after the first turn ended, in the same Claude Code session.
  const u2 = "utt-2";
  // The panel sends its voice events once the message went out, so they join the turn it started.
  beginTurn(book, 2, T1, { brain: "claude-code", jev: true, source: "adhoc", model: "claude-sonnet-5" });
  linkCid(book, u2);
  tr({ t: T1 - 5200, cat: "voice", name: "voice.speech", src: "panel", cid: u2 });
  tr({ t: T1 - 1900 - 1650, ms: 1650, cat: "voice", name: "voice.transcript", src: "panel", cid: u2, data: { chars: 38, requests: 2, lastRequestMs: 1480, lastKB: 29, reason: "send", waitMs: 1650, model: "@cf/deepgram/nova-3" } });
  tr({ t: T1 - 1900, cat: "voice", name: "voice.heard", src: "panel", cid: u2, data: { chars: 38 } });
  tr({ t: T1 - 1900, ms: 1200, cat: "voice", name: "voice.send_window", src: "panel", cid: u2, data: { waitMs: 1200 } });
  tr({ t: T1 - 700, ms: 690, cat: "voice", name: "voice.deliver", src: "panel", cid: u2, data: { chars: 38, waitMs: 690 } });
  tr({ t: T1 - 30, ms: 21, cat: "brain", name: "brain.resolve", data: { brain: "claude-code", mode: "auto", model: "claude-sonnet-5", jev: true } });
  ev(T1 + 2, { type: "user_message", text: "Also check Saturday, and tell me if it's cheaper", voice: true });
  ev(T1 + 4, { type: "status", text: "Continuing the same Claude Code session" });
  tr({ t: T1 + 10, ms: 95, cat: "turn", name: "engine.tab", data: { mode: "current-tab" } });
  tr({ t: T1 + 110, cat: "brain", name: "brain.start", data: { brain: "claude-code", fresh: false, chars: 96 } });
  call(T1 + 130, 4600, { sinceInputMs: 2, responseMs: 3900, firstTokenMs: 3920, firstToolMs: 4400, deltas: 0, toolUses: 1, inTokens: 4, cacheReadTokens: 31200, cacheWriteTokens: 420, outTokens: 120, stop: "tool_use" });
  tool(T1 + 4800, 410, "t5", "screenshot", {}, "Screenshot skipped: the tab is in the background", { error: true });
  tr({ t: T1 + 4805, ms: 402, cat: "browser", name: "browser.screenshot", data: { driver: "cdp", error: "Screenshot skipped: the tab is in the background" } });
  call(T1 + 5230, 2600, { sinceInputMs: 3, responseMs: 1800, firstTokenMs: 1820, firstToolMs: 2500, deltas: 0, toolUses: 1, inTokens: 5, cacheReadTokens: 31620, cacheWriteTokens: 310, outTokens: 95, stop: "tool_use" });
  tool(T1 + 7850, 760, "t6", "read_page", {}, "URL: https://www.google.com/travel/flights\nTitle: Google Flights\n[40] button \"Saturday, October 3 · from $198\"");
  tr({ t: T1 + 7860, ms: 740, cat: "browser", name: "browser.readPage", data: { driver: "cdp", elements: 430, chars: 17100 } });
  call(T1 + 8630, 5100, { sinceInputMs: 2, responseMs: 1700, firstTokenMs: 1720, firstTextMs: 1750, firstToolMs: 4900, deltas: 31, toolUses: 1, inTokens: 6, cacheReadTokens: 32400, cacheWriteTokens: 1200, outTokens: 402, stop: "tool_use" });
  deltas(T1 + 10380, 12, 120);
  ev(T1 + 13200, { type: "assistant_text", text: "Saturday is cheaper: TP 1353 at 08:10 for $198 round trip ($16 less).", id: "m:4" });
  tool(T1 + 13750, 2, "t7", "task_complete", { summary: "Saturday TP 1353 is $198, $16 cheaper" }, "Task recorded as done. Stop now.");
  tr({ t: T1 + 13800, cat: "brain", name: "claude.result", src: "helper", data: { durationMs: 13600, apiMs: 12300, modelCalls: 3, costUsd: 0.0611, inTokens: 15, outTokens: 617, cacheReadTokens: 95220, cacheWriteTokens: 1930 } });
  ev(T1 + 14000, { type: "task_end", outcome: "done", summary: "Saturday TP 1353 is $198, $16 cheaper" });
  tr({ t: T1 + 14300, ms: 900, cat: "voice", name: "voice.tts", src: "panel", data: { chars: 58, waitMs: 1900, startMs: 1900, cut: true } });
  tr({ t: T1 + 15200, cat: "voice", name: "voice.barge_in", src: "panel" });

  // ---- Turn 3: Realtime voice (the narrator hears the request and sends it to the agent at once).
  const u3 = "rt-item_3";
  beginTurn(book, 3, T2, { brain: "claude-code", jev: true, source: "adhoc", model: "claude-sonnet-5", voice: true, chars: 44 });
  linkCid(book, u3);
  tr({ t: T2 - 9000, ms: 380, cat: "voice", name: "voice.ticket", src: "panel", data: { waitMs: 380 } });
  tr({ t: T2 - 8600, ms: 1450, cat: "voice", name: "voice.connect", src: "panel", data: { openMs: 260, readyMs: 1190, model: "gpt-realtime", waitMs: 1450 } });
  tr({ t: T2 - 1400, ms: 2600, cat: "voice", name: "voice.narrator", src: "panel", cid: u3, data: { trigger: "speech", commitMs: 60, createdMs: 140, firstAudioMs: 720, waitMs: 720, audioDeltas: 38, status: "completed", inTokens: 1830, outTokens: 96, inAudioTokens: 210, cachedTokens: 1536, outAudioTokens: 74 } });
  tr({ t: T2 - 1340, ms: 900, cat: "voice", name: "voice.user_words", src: "panel", cid: u3, data: { chars: 52, model: "gpt-4o-mini-transcribe", inTokens: 55, outTokens: 14 } });
  tr({ t: T2 - 1100, cat: "voice", name: "voice.tool.send_to_agent", src: "panel", cid: u3 });
  tr({ t: T2 - 1100, cat: "voice", name: "voice.forward", src: "panel", cid: u3, data: { chars: 44 } });
  tr({ t: T2 - 1095, ms: 610, cat: "voice", name: "voice.deliver", src: "panel", cid: u3, data: { chars: 44, waitMs: 610 } });
  tr({ t: T2 - 20, ms: 18, cat: "brain", name: "brain.resolve", data: { brain: "claude-code", mode: "auto", model: "claude-sonnet-5", jev: true } });
  ev(T2 + 2, { type: "user_message", text: "Book the Saturday one, window seat please", voice: true });
  ev(T2 + 3, { type: "heard", text: "uh can you book the saturday one, window seat please", sent: "Book the Saturday one, window seat please" });
  tr({ t: T2 + 12, ms: 90, cat: "turn", name: "engine.tab", data: { mode: "current-tab" } });
  tr({ t: T2 + 105, cat: "brain", name: "brain.start", data: { brain: "claude-code", fresh: false, chars: 44 } });
  call(T2 + 120, 3100, { sinceInputMs: 2, responseMs: 2200, firstTokenMs: 2210, firstTextMs: 2230, firstToolMs: 2900, deltas: 9, toolUses: 1, inTokens: 4, cacheReadTokens: 33_100, cacheWriteTokens: 380, outTokens: 110, stop: "tool_use" });
  deltas(T2 + 2350, 9, 60);
  ev(T2 + 2900, { type: "assistant_text", text: "Opening the Saturday flight to pick a window seat.", id: "m:5" });
  tool(T2 + 3250, 2400, "t8", "click", { index: 40 }, "clicked [40] button \"Saturday, October 3 · from $198\"");
  tr({ t: T2 + 3260, ms: 2380, cat: "browser", name: "browser.click", data: { driver: "cdp" } });
  call(T2 + 5680, 2200, { sinceInputMs: 3, responseMs: 1500, firstTokenMs: 1510, firstToolMs: 2000, deltas: 0, toolUses: 1, inTokens: 5, cacheReadTokens: 33_600, cacheWriteTokens: 900, outTokens: 70, stop: "tool_use" });
  tool(T2 + 7900, 2, "t9", "task_ask", { question: "The seat map needs you to sign in. Should I sign in with your saved login?" }, "Question asked. Stop now.");
  tr({ t: T2 + 7950, cat: "brain", name: "claude.result", src: "helper", data: { durationMs: 7800, apiMs: 5300, modelCalls: 2, costUsd: 0.0294, inTokens: 9, outTokens: 180, cacheReadTokens: 66_700, cacheWriteTokens: 1280 } });
  ev(T2 + 8000, { type: "task_end", outcome: "paused", reason: "The seat map needs you to sign in. Should I sign in with your saved login?" });
  tr({ t: T2 + 8100, ms: 3900, cat: "voice", name: "voice.narrator", src: "panel", data: { trigger: "update", createdMs: 90, firstAudioMs: 540, waitMs: 540, audioDeltas: 51, status: "completed", inTokens: 2400, outTokens: 130, inAudioTokens: 0, cachedTokens: 2048, outAudioTokens: 101 } });

  const session = {
    sessionId: RAW_SESSION, source: "adhoc", title: "Find the cheapest flight to Lisbon next Friday and tell me", brain: "claude-code", jev: true,
    model: "claude-sonnet-5", voice: true, turns: 3, firstStartedAt: at(T0), startedAt: at(T2), endedAt: at(T2 + 8000), outcome: "paused",
    reason: "The seat map needs you to sign in. Should I sign in with your saved login?", instructions: "Find the cheapest flight to Lisbon next Friday and tell me",
  };
  sessions.unshift(session);
  eventsBySession[RAW_SESSION] = events;
  state.running = null;
  state.runningSessions = [];
  state.runningTabs = {};
  state.tabChats = { "1": RAW_SESSION };
  state.openConversations = [RAW_SESSION];
  state.brain = { ...state.brain, effective: "claude-code" };
  return {
    session,
    events,
    trace: book,
    env: {
      extensionVersion: "0.4.0",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.7000.0 Safari/537.36",
      os: "win",
      arch: "x86-64",
      helper: { version: "0.4.0", brain: "claude", jev: true },
    },
  };
}
