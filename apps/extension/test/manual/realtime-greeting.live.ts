/**
 * Live reproduction of the owner's Realtime trace (session 4b99459b): "Hey, how you doing?", the agent answers with a
 * text and a spoken line, and the narrator's own voice leaks back into the microphone at low volume (a Mac's speakers
 * and microphone). The extension's real RealtimeEngine against OpenAI's Realtime model; the user's words by OpenAI TTS.
 * Prints each line the user heard; fails when anything other than the agent's spoken line was said after it.
 *
 * It costs money. From apps/extension:
 *   set -a; . /app/data/home/noa-mono/.env; set +a; NOA_LIVE=1 npx vitest run --config test/manual/live.config.ts test/manual/realtime-greeting.live.ts
 * NOA_LIVE_AGENT=claude-code: the real agent (the helper with headless Claude Code; `pnpm --filter @noa/helper build`
 * first) instead of a scripted one. NOA_LIVE_OUT: a file the timeline is appended to. NOA_LIVE_ECHO: the echo's gain (default 0.15; 0: none). NOA_LIVE_ECHO_KIND=residue: noise shaped like the voice
 * instead of the voice (what echo cancellation leaves; transcribed as nothing). NOA_LIVE_LANGUAGE=ko (a code of
 * language.ts): the language picked in Settings; the user greets in it, the scripted agent's line stays English, and
 * everything the narrator says must be in that language's script.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chosenLanguage, LanguageSetting, type AgentEvent } from "@noa/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import { transcriptFit, voiceLanguages } from "../../src/voice/voice-language.js";
import { ClaudeCodeAgent } from "./claude-code-agent.js";

const KEY = process.env.OPENAI_API_KEY ?? "";
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const ECHO = Number(process.env.NOA_LIVE_ECHO ?? "0.15");
/** words: the narrator's voice itself, scaled; residue: noise shaped like it (what echo cancellation leaves: no words). */
const ECHO_KIND = process.env.NOA_LIVE_ECHO_KIND === "residue" ? "residue" : "words";
/** The echo as the microphone gets it. */
function echoOf(data: Float32Array): number[] {
  if (ECHO_KIND === "words") return Array.from(data, (s) => s * ECHO);
  // Noise with the voice's loudness, 10 ms at a time.
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 240) {
    let sum = 0;
    const end = Math.min(data.length, i + 240);
    for (let j = i; j < end; j++) sum += data[j]! * data[j]!;
    const level = Math.sqrt(sum / (end - i)) * ECHO * 1.7;
    for (let j = i; j < end; j++) out.push((Math.random() * 2 - 1) * level);
  }
  return out;
}
/** The language picked in Settings (NOA_LIVE_LANGUAGE), and the user's greeting in it. */
const LANGUAGE = chosenLanguage(LanguageSetting.catch("auto").parse(process.env.NOA_LIVE_LANGUAGE));
const GREETINGS: Record<string, string> = {
  en: "Hey, how you doing?", es: "Hola, ¿qué tal?", fr: "Salut, comment ça va ?", pt: "Oi, tudo bem?", ko: "안녕, 잘 지내?", ja: "やあ、元気？",
  zh: "嗨，你好吗？", de: "Hallo, wie geht's?", hi: "नमस्ते, कैसे हो?", ar: "مرحبا، كيف حالك؟",
};
const GREETING = GREETINGS[LANGUAGE?.code ?? "en"]!;
const RATE = 24_000;
const CHUNK = RATE / 10;
let t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
const log = (s: string) => {
  console.log(`${at()}s ${s}`);
  if (process.env.NOA_LIVE_OUT) appendFileSync(process.env.NOA_LIVE_OUT, `${at()}s ${s}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What plays out of the speaker, heard back by the microphone (scaled by ECHO). */
let echo: number[] = [];
/** Narrator audio the user heard (chunks that played to their end), in ms. */
let heardMs = 0;

class FakeBuffer {
  private readonly data: Float32Array;
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData() {
    return this.data;
  }
}
class FakeSource {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor(private readonly ctx: FakeContext) {}
  connect() {}
  start(when: number) {
    const delay = Math.max(0, (when - this.ctx.currentTime) * 1000);
    const data = this.buffer!.getChannelData();
    this.timers.push(setTimeout(() => ECHO > 0 && echo.push(...echoOf(data)), delay));
    this.timers.push(
      setTimeout(() => {
        heardMs += this.buffer!.duration * 1000;
        this.onended?.();
      }, delay + this.buffer!.duration * 1000),
    );
  }
  stop() {
    for (const t of this.timers) clearTimeout(t);
    echo = [];
  }
}
class FakeContext {
  state = "running";
  destination = {};
  private readonly start = performance.now();
  get currentTime() {
    return (performance.now() - this.start) / 1000;
  }
  createBuffer(_c: number, length: number, rate: number) {
    return new FakeBuffer(length, rate);
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  async resume() {}
  async close() {}
}
(globalThis as any).AudioContext = FakeContext;

async function tts(text: string): Promise<Float32Array> {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" }),
  });
  if (!r.ok) throw new Error(`tts ${r.status} ${await r.text()}`);
  const b = new Uint8Array(await r.arrayBuffer());
  const pcm = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
  return Float32Array.from(pcm, (s) => s / 0x8000);
}

/** The microphone: the user's words when they talk, room noise, and the speaker's echo mixed in. */
class LiveMic implements AudioSource {
  private queue: Float32Array[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private done: (() => void) | null = null;
  async start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.timer = setInterval(() => {
      const next = this.queue.shift();
      const out = next ?? Float32Array.from({ length: CHUNK }, () => (Math.random() - 0.5) * 0.002);
      const e = echo.splice(0, CHUNK);
      for (let i = 0; i < e.length && i < out.length; i++) out[i]! += e[i]!;
      onSamples(out);
      if (!next && this.done) {
        this.done();
        this.done = null;
      }
    }, 100);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  say(audio: Float32Array): Promise<void> {
    for (let i = 0; i < audio.length; i += CHUNK) this.queue.push(audio.slice(i, i + CHUNK));
    return new Promise((r) => (this.done = r));
  }
}

const SPOKEN = "I'm doing well, thanks! Let me know what you'd like help with.";

/** What the user says over the result line (NOA_LIVE_SCENARIO=talk-over). */
const TALK_OVER = "Wait, stop. What time is it in Tokyo?";

describe.skipIf(!KEY || !process.env.NOA_LIVE)("live: Realtime says the agent's answer to a greeting once, and nothing after it", () => {
  const talkOver = process.env.NOA_LIVE_SCENARIO === "talk-over";
  it(talkOver ? "the user talking over the result cuts it off, and their request goes to the agent" : "'Hey, how you doing?': the result is said once, and the echo of it gets no reply", async () => {
    t0 = Date.now();
    heardMs = 0;
    const audio = await tts(GREETING);
    const over = talkOver ? await tts(TALK_OVER) : null;
    const forwarded: string[] = [];
    const mic = new LiveMic();
    let engine!: RealtimeEngine;
    const heard: { at: string; response: string; text: string }[] = [];
    let requests = 0;
    const plain = (t: string) => t.toLowerCase().replace(/[’`]/g, "'");
    /** The agent's spoken lines (task_end), in order: what the narrator is to say once each. */
    const results: string[] = [];
    const emit = (ev: AgentEvent) => {
      if (ev.type === "task_end" && ev.spoken) results.push(ev.spoken);
      engine.agentEvent(ev, Date.now());
    };
    /** Narrator audio heard when the user's talk-over reached the agent. */
    let heardAtRequest: number | null = null;
    const real = process.env.NOA_LIVE_AGENT === "claude-code" ? new ClaudeCodeAgent(emit, (w) => engine.setAgentWorking(w), log) : null;
    const agent = async (text: string) => {
      requests++;
      if (real) {
        if (/tokyo|time/i.test(text)) heardAtRequest = heardMs;
        return real.request(text);
      }
      const tokyo = /tokyo|time/i.test(text);
      if (tokyo) heardAtRequest = heardMs;
      const spoken = tokyo ? "It's 3 PM in Tokyo." : SPOKEN;
      engine.setAgentWorking(true);
      emit({ type: "user_message", text, voice: true });
      await sleep(2_200);
      emit({ type: "assistant_text", text: tokyo ? "It's 3 PM in Tokyo right now." : "I'm doing well, thanks for asking! I'm ready to help whenever you have a task for me." });
      await sleep(780);
      emit({ type: "tool_call", id: "c", name: "task_complete", args: { summary: "Replied", spoken } });
      emit({ type: "task_end", outcome: "done", summary: "Replied", spoken });
      engine.setAgentWorking(false);
    };
    const events: EngineEvents = {
      speech: () => log("VAD     user speech started"),
      heard: () => {},
      partial: () => {},
      level: () => {},
      openingMic: () => {},
      capturing: () => {},
      narrating: () => {},
      said: () => {},
      narratorText: () => {},
      forward: (text) => {
        forwarded.push(text);
        log(`FORWARD ${text}`);
        void agent(text);
      },
      userWords: (w) => log(`WORDS   ${JSON.stringify(w)}`),
      stopTask: async () => "Stopped the task.",
      answerApproval: async () => "Nothing waits for approval.",
      endVoice: () => {},
      useThisTab: async () => "Already here.",
      failed: (f) => log(`FAILED ${JSON.stringify(f)}`),
    } as EngineEvents;
    const openSocket = (): RealtimeSocketLike => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, ["realtime", `openai-insecure-api-key.${KEY}`]);
      const played = new Set<string>();
      const wrap: RealtimeSocketLike = {
        get readyState() {
          return ws.readyState;
        },
        send(data: string) {
          const e = JSON.parse(data);
          if (e.type === "response.create") log(`CLIENT  response.create ${JSON.stringify(e.response ?? {}).slice(0, 160)}`);
          else if (e.type === "response.cancel") log("CLIENT  response.cancel");
          else if (e.type === "conversation.item.create" && e.item?.role === "system") log(`CLIENT  note: ${String(e.item.content[0].text).slice(0, 160)}`);
          else if (e.type === "conversation.item.truncate") log(`CLIENT  truncate ${e.item_id} at ${e.audio_end_ms}`);
          ws.send(data);
        },
        close: (code?: number, reason?: string) => ws.close(code === 1000 ? 1000 : undefined, reason),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      ws.onopen = (e) => wrap.onopen?.(e);
      ws.onclose = (e) => wrap.onclose?.({ code: e.code, reason: e.reason });
      ws.onerror = (e) => wrap.onerror?.(e);
      ws.onmessage = (m) => {
        const e = JSON.parse(String(m.data));
        if (process.env.NOA_LIVE_ALL && !/delta$/.test(e.type)) log(`RAW     ${e.type} ${JSON.stringify(e).slice(0, 200)}`);
        if (/^(response\.(created|done)|input_audio_buffer\.(committed|speech_started|speech_stopped))$/.test(e.type))
          log(`SERVER  ${e.type} ${e.item_id ?? e.response?.id ?? ""} ${e.response?.status ?? ""}`);
        if (e.type === "conversation.item.input_audio_transcription.completed") log(`USER    words (${e.item_id}): "${e.transcript}"`);
        if (e.type === "response.output_audio_transcript.done") log(`REPLY   ${e.response_id} transcript: "${e.transcript}"${played.has(e.response_id) ? "" : " (not played)"}`);
        if (e.type === "error") log(`ERROR   ${JSON.stringify(e.error)}`);
        const before = echo.length;
        wrap.onmessage?.({ data: m.data });
        void before;
        if (e.type === "response.output_audio.delta") played.add(e.response_id);
      };
      return wrap;
    };
    engine = new RealtimeEngine({
      ticket: async () => ({ url: "wss://relay.invalid/v1/ai/realtime", token: "live" }),
      createSource: () => mic,
      events: {
        ...events,
        narratorText: (t: string) => {
          const last = heard[heard.length - 1];
          if (last && t.startsWith(last.text)) last.text = t;
          else heard.push({ at: at(), response: "", text: t });
        },
      },
      openSocket,
      languages: voiceLanguages(["en"], LANGUAGE?.code),
      ...(LANGUAGE ? { language: LANGUAGE.name } : {}),
      trace: {
        record: (e) => /narrator|user_words|echo|noise|talk_over/.test(e.name) && log(`TRACE   ${e.name} ${JSON.stringify(e.data ?? {}).slice(0, 220)}`),
        utterance: () => "u",
        useUtterance: () => {},
        endUtterance: () => {},
      },
    });
    await engine.start();
    await real?.start();
    const ticker = setInterval(() => engine.tick(Date.now()), 1_000);
    await sleep(1_200);
    log(`USER    says "${GREETING}"`);
    await mic.say(audio);
    if (over) {
      // Once the result has been playing for a second, the user talks over it.
      const until = Date.now() + 20_000;
      while (Date.now() < until && !(results[0] && heard.some((h) => plain(h.text).startsWith(plain(results[0]!).slice(0, 8))))) await sleep(100);
      await sleep(1_000);
      log(`USER    says over it "${TALK_OVER}"`);
      await mic.say(over);
    }
    await sleep(over ? 12_000 : 20_000);
    clearInterval(ticker);
    engine.stop();
    real?.stop();
    if (process.env.NOA_LIVE_OUT) appendFileSync(process.env.NOA_LIVE_OUT, `==== heard\n${heard.map((h) => `${h.at}s  ${h.text}`).join("\n")}\n`);
    console.log(`\n==== heard (narrator text shown/said)\n${heard.map((h) => `${h.at}s  ${h.text}`).join("\n")}\n`);
    log(`HEARD   ${Math.round(heardMs)} ms of narrator audio${heardAtRequest !== null ? ` (${Math.round(heardAtRequest)} ms when the talk-over reached the agent)` : ""}`);
    // A line said for result `r` (its first words; the narrator says it word for word).
    const saysResult = (text: string, r: string) => plain(text).startsWith(plain(r).slice(0, 16));
    const saidFor = (r: string | undefined) => (r ? heard.filter((h) => saysResult(h.text, r)).length : 0);
    log(`RESULTS ${JSON.stringify(results)}`);
    if (over) {
      // The greeting's result cut off (not all of its ~4 s heard) and not said again; their question reached the agent
      // and its answer was said once.
      expect({
        cut: heardAtRequest !== null && heardAtRequest < 3_000,
        greetingSaid: saidFor(results[0]),
        asked: forwarded.some((f) => /tokyo|time/i.test(f)),
        answerSaid: saidFor(results[1]),
      }).toEqual({ cut: true, greetingSaid: 1, asked: true, answerSaid: 1 });
      return;
    }
    if (LANGUAGE) {
      // In the language picked: the request went out once, and every line said is in its script (the English result translated).
      expect({ requests, said: heard.length > 0, notInIt: heard.filter((h) => transcriptFit(h.text, [LANGUAGE.code]) !== "clear").map((h) => h.text) }).toEqual({
        requests: 1,
        said: true,
        notInIt: [],
      });
      return;
    }
    // The result said once, and nothing after it.
    const first = heard.findIndex((h) => saysResult(h.text, results[0] ?? "\u0000"));
    expect({ requests, resultSaid: saidFor(results[0]), afterResult: first < 0 ? null : heard.slice(first + 1).map((h) => h.text) }).toEqual({ requests: 1, resultSaid: 1, afterResult: [] });
  });
});
