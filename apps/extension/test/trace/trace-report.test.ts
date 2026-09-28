import { describe, expect, it } from "vitest";
import type { AgentEvent, SessionInfo, StampedAgentEvent, TraceEvent } from "@noa/shared";
import { addEvent, beginTurn, linkCid, newBook, observe, type TraceBook } from "../../src/trace/trace-book.js";
import { buildReport, durationText, exportJson, redactDeep, redactSecrets, relText, reportText, SLOW_MS, SLOWEST_COUNT, summaryLines, TEXT_LIMITS, type ReportEnv } from "../../src/trace/trace-report.js";

/** Fake keys for the redaction tests, built at runtime so no key-shaped literal is in the repo. */
const FAKE_ANTHROPIC_KEY = ["sk", "ant", "api03", "abcdefghijklmnop"].join("-");
const FAKE_ANTHROPIC_KEY_2 = ["sk", "ant", "api03", "0123456789abcdef"].join("-");

const T0 = Date.parse("2026-09-26T10:00:00Z");
const session: SessionInfo = { sessionId: "s1", source: "adhoc", title: "Find a flight", brain: "claude-code", model: "claude-sonnet-5", jev: true, startedAt: new Date(T0).toISOString(), turns: 2 };
const env: ReportEnv = {
  extensionVersion: "0.4.0",
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/153.0.7000.0 Safari/537.36",
  os: "win",
  arch: "x86-64",
  helper: { version: "0.4.1", brain: "claude", jev: true },
  voice: { engine: "standard", model: "@cf/deepgram/nova-3" },
};

/** A two-turn conversation: events as stored, and its book as the engine builds it. */
function conversation(): { book: TraceBook; events: StampedAgentEvent[] } {
  const book = newBook("s1");
  const events: StampedAgentEvent[] = [];
  const say = (t: number, e: AgentEvent) => {
    events.push({ ...e, ts: new Date(t).toISOString(), sessionId: "s1" } as StampedAgentEvent);
    observe(book, e, t);
  };
  const tr = (e: Omit<TraceEvent, "src"> & { src?: TraceEvent["src"] }) => addEvent(book, { src: "engine", ...e });

  beginTurn(book, 1, T0, { brain: "claude-code", model: "claude-sonnet-5", jev: true, chars: 13 });
  linkCid(book, "u1");
  tr({ t: T0 - 2000, ms: 900, cat: "voice", name: "voice.transcript", src: "panel", cid: "u1", data: { waitMs: 900, requestAfterMs: 40, lastRequestMs: 820 } });
  tr({ t: T0 - 1100, ms: 1000, cat: "voice", name: "voice.send_window", src: "panel", cid: "u1", data: { waitMs: 1000 } });
  tr({ t: T0 + 100, ms: 2500, cat: "brain", name: "claude.ready", src: "helper" });
  tr({ t: T0 + 2600, ms: 9000, cat: "model", name: "model.call", src: "helper", data: { inTokens: 10, outTokens: 300, cacheReadTokens: 20_000, firstTokenMs: 2100 } });
  say(T0 + 11_700, { type: "tool_call", id: "t1", name: "navigate", args: { url: "https://example.com/?access_token=abc123secretXYZ" } });
  tr({ t: T0 + 11_700, ms: 3500, cat: "tool", name: "tool", src: "helper", data: { tool: "navigate", id: "t1", args: '{"url":"https://example.com/?access_token=abc123secretXYZ"}', chars: 80 } });
  tr({ t: T0 + 11_710, ms: 3400, cat: "browser", name: "browser.navigate", data: { driver: "cdp", host: "example.com" } });
  say(T0 + 15_200, { type: "tool_result", id: "t1", name: "navigate", text: `Page text ${"lorem ipsum ".repeat(200)}` });
  say(T0 + 15_300, { type: "jev", goal: "click Search", operation: "click", index: 4, confidence: 0.93, executed: true, ms: 1600 });
  tr({ t: T0 + 15_400, ms: 1200, cat: "model", name: "model.call", src: "helper", data: { inTokens: 5, outTokens: 50 } });
  say(T0 + 16_600, { type: "assistant_text", id: "m1", text: `The cheapest is $214. Key ${FAKE_ANTHROPIC_KEY} was on the page.` });
  tr({ t: T0 + 16_650, cat: "brain", name: "claude.result", src: "helper", data: { costUsd: 0.05 } });
  say(T0 + 16_700, { type: "task_end", outcome: "done", summary: "Cheapest $214" });

  beginTurn(book, 2, T0 + 60_000, { brain: "claude-code" });
  say(T0 + 60_001, { type: "user_message", text: "and Saturday?" });
  tr({ t: T0 + 60_010, ms: 500, cat: "model", name: "model.call", src: "helper", data: { inTokens: 3, outTokens: 20 } });
  say(T0 + 60_600, { type: "assistant_text", id: "m2", text: "Saturday is $198." });
  say(T0 + 61_000, { type: "task_end", outcome: "done" });
  return { book, events };
}

describe("trace report", () => {
  it("one timeline per turn, times relative to its first event, tool spans on their tool call", () => {
    const { book, events } = conversation();
    const r = buildReport({ session, events, trace: book, now: T0 + 70_000 });
    expect(r.turns.map((t) => t.turn)).toEqual([1, 2]);
    const [t1, t2] = r.turns;
    // Turn 1 starts with the voice before the message (2 s before the engine started it).
    expect(t1!.start).toBe(T0 - 2000);
    expect(t1!.rows[0]).toMatchObject({ name: "voice.transcript", rel: 0 });
    expect(t1!.ms).toBe(16_700 + 2000);
    expect(t1!.running).toBe(false);
    const tool = t1!.rows.find((x) => x.name === "tool_call")!;
    expect(tool).toMatchObject({ ms: 3500, slow: true, rel: 13_700 });
    expect(t1!.rows.filter((x) => x.name === "tool")).toHaveLength(0);
    // Rows are in time order.
    expect(t1!.rows.map((x) => x.t)).toEqual([...t1!.rows.map((x) => x.t)].sort((a, b) => a - b));
    expect(t2!.rows[0]!.name).toBe("turn.start");
    expect(t2!.firstResponseMs).toBe(600);
  });

  it("flags slow items by the named thresholds", () => {
    const { book, events } = conversation();
    const rows = buildReport({ session, events, trace: book }).turns.flatMap((t) => t.rows);
    const slow = (name: string) => rows.filter((x) => x.name === name).map((x) => x.slow);
    expect(slow("model.call")).toEqual([9000 >= SLOW_MS.model, false, false]);
    expect(slow("browser.navigate")).toEqual([3400 >= SLOW_MS.browser]);
    expect(slow("jev")).toEqual([1600 >= SLOW_MS.jev]);
    expect(slow("voice.transcript")).toEqual([false]);
  });

  it("sums up: total, first response, speech to agent, model / tool / Jev / voice time, the slowest items, tokens", () => {
    const { book, events } = conversation();
    const s = buildReport({ session, events, trace: book }).summary;
    expect(s).toMatchObject({ turns: 2, totalMs: 18_700 + 1000, modelMs: 10_700, modelCalls: 3, toolMs: 3500, toolCalls: 1, jevMs: 1600, jevPicks: 1, voiceMs: 1900, costUsd: 0.05, traced: true });
    expect(s.tokens).toEqual({ in: 18, out: 370, cacheRead: 20_000, cacheWrite: 0 });
    expect(s.otherMs).toBe(s.totalMs - s.modelMs - s.toolMs - s.voiceMs);
    // Turn 1: from the voice (T0 - 2 s) to the tool call at T0 + 11.7 s.
    expect(s.firstResponses).toEqual([13_700, 600]);
    // From the end of speech (the transcript's start) to the agent's first event.
    expect(s.speechToResponses).toEqual([13_700, null]);
    expect(s.slowest).toHaveLength(SLOWEST_COUNT);
    expect(s.slowest.map((x) => x.ms)).toEqual([...s.slowest.map((x) => x.ms)].sort((a, b) => b - a));
    // The engine's wait for the first response (from the turn's start) tops the list.
    expect(s.slowest[0]).toMatchObject({ ms: 11_700, turn: 1, label: "First response (tool)" });
    expect(s.slowest.map((x) => x.label)).toContain("Model call");
  });

  it("a conversation from before traces: rows and tool times from its events", () => {
    const { events } = conversation();
    const r = buildReport({ session, events, trace: null });
    expect(r.summary.traced).toBe(false);
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]!.rows.find((x) => x.name === "tool_call")!.ms).toBe(3500);
    expect(r.summary.toolMs).toBe(3500);
  });

  it("Copy text: summary, slowest and each turn, redacted", () => {
    const { book, events } = conversation();
    const text = reportText(buildReport({ session, events, trace: book }), session, env);
    expect(text).toContain("SUMMARY");
    expect(text).toContain("Slowest:");
    expect(text).toMatch(/TURN 1 · .* · done · first response 13\.70 s/);
    expect(text).toContain("helper 0.4.1 (claude)");
    expect(text).toContain("Chrome 153.0.7000.0");
    expect(text).toContain("voice standard (@cf/deepgram/nova-3)");
    expect(text).not.toContain("abc123secretXYZ");
    expect(text).not.toContain("sk-ant-api03");
    // Page content is cut short.
    expect(text).not.toContain("lorem ipsum ".repeat(40));
  });

  it("Download: valid JSON with the environment, caps and thresholds, secrets redacted, page content cut", () => {
    const { book, events } = conversation();
    const doc = exportJson(buildReport({ session, events, trace: book }), session, { ...env, anthropicApiKey: "sk-ant-zzzzzzzzzzzzzzzz" } as ReportEnv, new Date(T0 + 99_000));
    const json = JSON.stringify(doc);
    const back = JSON.parse(json) as { format: string; env: Record<string, unknown>; summary: { turns: number }; turns: { rows: { name: string; text?: string }[] }[] };
    expect(back.format).toBe("noa.trace");
    expect(back.env).toMatchObject({ extensionVersion: "0.4.0", os: "win", helper: { version: "0.4.1" }, voice: { engine: "standard" }, caps: { events: 1000 }, slowMs: { model: SLOW_MS.model } });
    expect(back.env.anthropicApiKey).toBe("[redacted]");
    expect(back.summary.turns).toBe(2);
    expect(json).not.toContain("abc123secretXYZ");
    expect(json).not.toContain("sk-ant-api03");
    const result = back.turns[0]!.rows.find((x) => x.name === "tool_result")!;
    expect(result.text!.length).toBeLessThanOrEqual(TEXT_LIMITS.result + 20);
  });
});

describe("redaction", () => {
  it("keys, tokens, JWTs and passwords in text", () => {
    const text = [
      `key ${FAKE_ANTHROPIC_KEY_2} and sk-proj-0123456789abcdefghij`,
      "Authorization: Bearer abc.def.ghi-123456",
      "https://x.com/cb?code=4/0AbCdEf&state=ok&session_token=zzz111",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl",
      'password: "hunter2 x" and pwd=letmein',
      "bt_live_0123456789abcdef",
    ].join("\n");
    const out = redactSecrets(text);
    for (const secret of ["0123456789abcdef", "abc.def.ghi", "4/0AbCdEf", "zzz111", "eyJhbGci", "hunter2", "letmein", "bt_live"]) expect(out).not.toContain(secret);
    expect(out).toContain("state=ok");
  });

  it("fields named after secrets, whatever they hold, and every string inside", () => {
    expect(redactDeep({ password: "p", nested: { jevApiKey: "k", runnerKey: "", note: "Bearer abcdefghijkl" }, list: ["sk-ant-abcdefghijk"] })).toEqual({
      password: "[redacted]",
      nested: { jevApiKey: "[redacted]", runnerKey: "", note: "Bearer [redacted]" },
      list: ["[redacted]"],
    });
  });
});

describe("formatting", () => {
  it("relative times and durations", () => {
    expect(relText(3400)).toBe("+3.40 s");
    expect(relText(-250)).toBe("-0.25 s");
    expect(durationText(380)).toBe("380 ms");
    expect(durationText(4210)).toBe("4.21 s");
    expect(durationText(62_300)).toBe("1m 02.3 s");
  });
});

describe("trace report: streaming and Realtime", () => {
  it("one row per turn for the streamed text (never one per delta), left out of the slowest", () => {
    const book = newBook("s1");
    beginTurn(book, 1, T0);
    for (let i = 0; i < 300; i++) observe(book, { type: "assistant_text_delta", id: "m", text: "x" }, T0 + 1000 + i * 100);
    observe(book, { type: "assistant_text", id: "m", text: "done" }, T0 + 31_000);
    const r = buildReport({ session, events: [], trace: book });
    const rows = r.turns[0]!.rows.filter((x) => x.cat === "stream" && x.name === "stream");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rel: 1000, ms: 30_000, label: "Streamed text", data: { deltas: 300, texts: 1 } });
    expect(r.summary.slowest.map((x) => x.label)).not.toContain("Streamed text");
    expect(r.summary.deltas).toBe(300);
  });

  it("a Realtime request: the agent's first event timed from the end of speech and from send_to_agent", () => {
    const book = newBook("s1");
    beginTurn(book, 1, T0);
    linkCid(book, "rt-item1");
    addEvent(book, { t: T0 - 2000, ms: 2500, cat: "voice", name: "voice.narrator", src: "panel", cid: "rt-item1", data: { trigger: "speech", waitMs: 700 } });
    addEvent(book, { t: T0 - 1200, cat: "voice", name: "voice.forward", src: "panel", cid: "rt-item1" });
    observe(book, { type: "tool_call", id: "t1", name: "read_page", args: {} }, T0 + 1800);
    const r = buildReport({ session, events: [], trace: book });
    expect(r.turns[0]!.speechToResponseMs).toBe(3800);
    expect(r.turns[0]!.rows.find((x) => x.name === "first.response")!.detail).toBe("3.80 s from the end of speech · 3.00 s after send_to_agent");
  });
  it("the narration audit: the narrator's replies by kind, the audio it sent, what was cancelled and what was noise", () => {
    const book = newBook("s1");
    beginTurn(book, 1, T0);
    const reply = (t: number, data: Record<string, string | number>) => addEvent(book, { t, ms: 500, cat: "voice", name: "voice.narrator", src: "panel", data: { waitMs: 300, ...data } });
    reply(T0 + 100, { trigger: "speech", kind: "speech", spokenMs: 0, status: "completed" });
    reply(T0 + 700, { trigger: "update", kind: "ack", spokenMs: 600, status: "completed" });
    reply(T0 + 9_000, { trigger: "update", kind: "result", spokenMs: 4_200, status: "cancelled" });
    addEvent(book, { t: T0 + 50, ms: 300, cat: "voice", name: "voice.user_words", src: "panel", data: { chars: 0, noise: true } });
    const r = buildReport({ session, events: [], trace: book });
    expect(r.summary.narration).toEqual({ replies: 3, byKind: { speech: 1, ack: 1, result: 1 }, spokenMs: 4_800, cancelled: 1, noise: 1 });
    expect(summaryLines(r.summary).find((l) => l.label === "Narrator")).toMatchObject({ value: "4.80 s spoken", hint: "3 replies: 1 speech, 1 ack, 1 result; 1 cancelled, 1 noise" });
    const labels = r.turns[0]!.rows.filter((x) => x.name === "voice.narrator").map((x) => x.label);
    expect(labels).toEqual(["Voice: narrator reply (to speech)", "Voice: narrator reply (acknowledgement)", "Voice: narrator reply (result)"]);
    expect(r.turns[0]!.rows.find((x) => x.name === "voice.user_words")!.detail).toContain("noise (nothing said)");
    // No narrator: no audit.
    expect(buildReport({ session, events: [], trace: newBook("s1") }).summary.narration).toBeNull();
  });
});

describe("trace report: reasoning", () => {
  it("shows when a stuck Fast run's reasoning was raised and why, when it went back to fast, and each request's reasoning when not fast", () => {
    const book = newBook("s1");
    beginTurn(book, 1, T0, { brain: "claude-api", model: "claude-sonnet-5", jev: false, chars: 10 });
    const tr = (e: Omit<TraceEvent, "src">) => addEvent(book, { src: "engine", ...e });
    tr({ t: T0 + 100, ms: 900, cat: "model", name: "model.call", data: { model: "claude-sonnet-5", reasoning: "fast" } });
    tr({ t: T0 + 1000, cat: "model", name: "reasoning.raise", data: { why: "act failed 3 times in a row", thinking: true } });
    tr({ t: T0 + 1100, ms: 2000, cat: "model", name: "model.call", data: { model: "claude-sonnet-5", reasoning: "raised" } });
    tr({ t: T0 + 3200, cat: "model", name: "reasoning.lower", data: { why: "act worked", thinking: false } });
    const rows = buildReport({ session: { ...session, brain: "claude-api" }, events: [], trace: book, now: T0 + 5000 }).turns[0]!.rows;
    expect(rows.filter((r) => r.name.startsWith("reasoning.")).map((r) => r.label)).toEqual(["Reasoning raised: act failed 3 times in a row", "Reasoning back to fast: act worked"]);
    const calls = rows.filter((r) => r.name === "model.call").map((r) => r.detail);
    expect(calls[0]).not.toContain("reasoning");
    expect(calls[1]).toContain("reasoning raised");
  });
});
