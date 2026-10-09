/**
 * Live check of what the Realtime narrator passes on to the agent (send_to_agent's text), for the owner's report
 * (ticket 49670f0f): after an invoice answer, "Go to the site and check what projects I'm using" went out as "... I'm
 * using. User wants to see project usage.", the narrator's own note shown as the user's words. The extension's real
 * RealtimeEngine against OpenAI's Realtime model; the user's words by OpenAI TTS; a scripted agent.
 * Prints each request passed on next to the user's words; fails when one adds a sentence the user did not say.
 *
 * It costs money. From apps/extension:
 *   set -a; . /app/data/home/noa-mono/.env; set +a; NOA_LIVE=1 npx vitest run --config test/manual/live.config.ts test/manual/realtime-forward.live.ts
 * REALTIME_MODEL: the model (default gpt-realtime-2.1; gpt-realtime-2.1-mini is the Realtime mini engine's).
 * NOA_LIVE_REQUEST: the second turn's words instead of the reported ones. NOA_LIVE_RUNS: how many times to run the
 * conversation (default 3). NOA_LIVE_OUT: a file the timeline is appended to.
 * NOA_LIVE_AGENT=claude-code: the real agent (the helper with headless Claude Code on a fake Gmail with the Neon
 * invoice; `pnpm --filter @noa/helper build` first) instead of the scripted one. NOA_LIVE_ECHO: the gain of the
 * narrator's voice heard back by the microphone (default 0: none; 0.03-0.15 is realistic).
 * NOA_LIVE_SCENARIO=midtask (with the real agent): a long task, and a question asked while it runs (NOA_LIVE_REQUEST),
 * to see whether its answer is said then.
 * NOA_LIVE_SCENARIO=turns: after one exchange, each of TURN_UTTERANCES in a conversation of its own; prints whether it
 * went to the agent and what the narrator said, and fails on a request the narrator kept or small talk it passed on.
 * NOA_LIVE_KINDS=request (or small_talk): only those utterances.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noa/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import { voiceLanguages } from "../../src/voice/voice-language.js";
import { ClaudeCodeAgent } from "./claude-code-agent.js";

const KEY = process.env.OPENAI_API_KEY ?? "";
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const RUNS = Number(process.env.NOA_LIVE_RUNS ?? "3");
const REAL = process.env.NOA_LIVE_AGENT === "claude-code";
const ECHO = Number(process.env.NOA_LIVE_ECHO ?? "0");
/** What plays out of the speaker, heard back by the microphone (scaled by ECHO). */
let echo: number[] = [];
const RATE = 24_000;
const CHUNK = RATE / 10;
let t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
const log = (s: string) => {
  console.log(`${at()}s ${s}`);
  if (process.env.NOA_LIVE_OUT) appendFileSync(process.env.NOA_LIVE_OUT, `${at()}s ${s}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MIDTASK = process.env.NOA_LIVE_SCENARIO === "midtask";
const TURNS_SCENARIO = process.env.NOA_LIVE_SCENARIO === "turns";

/** What the user says after the first exchange (NOA_LIVE_SCENARIO=turns): requests the narrator may be tempted to answer, and small talk. */
const TURN_UTTERANCES: Record<"request" | "small_talk", string[]> = {
  request: [
    "What did you just tell me?",
    "Was it paid with my card?",
    "What time is it?",
    "Did anyone else email me today?",
    "Can you check my calendar for tomorrow?",
    "¿Cuánto fue la factura?",
    // The owner's trace of 2026-09-27: the narrator answered these from its own notes ("Yesterday, I told you about...").
    "No, you're being a jerk. I'm talking about like yesterday.",
    "What did the second email say exactly?",
  ],
  small_talk: ["Hey, how are you doing?", "Can you hear me?", "Thanks, that's great.", "Hola, ¿qué tal?", "Merci beaucoup !", "Danke schön!", "ありがとう！"],
};
/** The user's turns, and the agent's answer to each (spoken: its line said aloud). */
const TURNS: { say: string; answer: string; spoken: string }[] = MIDTASK
  ? [
      { say: "Open each email in my inbox, one by one, and give me a one line summary of each.", answer: "", spoken: "" },
      { say: process.env.NOA_LIVE_REQUEST || "Actually, can you skip the GitHub one?", answer: "", spoken: "" },
    ]
  : [
  {
    say: REAL ? "Open the Neon invoice email. Who is it billed to, and is it paid?" : "What is this invoice? Who is it billed to?",
    answer: "Confirmed invoice billing account and payment status.",
    spoken: "This invoice, for $170.39 from Neon, is billed to jaeyun@gmail.com and it's already been auto-paid on October 1st.",
  },
  { say: process.env.NOA_LIVE_REQUEST || "Go to the site and check what projects I'm using.", answer: "Opened the Neon console.", spoken: "You have two projects on Neon: noa-prod and noa-staging." },
      { say: "Ok and which one costs the most?", answer: "Checked usage.", spoken: "noa-prod is most of it, about $160." },
    ];

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
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly ctx: FakeContext) {}
  connect() {}
  start(when: number) {
    const delay = Math.max(0, (when - this.ctx.currentTime) * 1000);
    const data = this.buffer!.getChannelData();
    if (ECHO > 0) this.echoTimer = setTimeout(() => echo.push(...Array.from(data, (x) => x * ECHO)), delay);
    this.timer = setTimeout(() => this.onended?.(), delay + this.buffer!.duration * 1000);
  }
  private echoTimer: ReturnType<typeof setTimeout> | null = null;
  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.echoTimer) clearTimeout(this.echoTimer);
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

const words = (t: string) => t.toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
/** Words of the request passed on that the user did not say (beyond small rewording: at most 2). */
function added(sent: string, heard: readonly string[]): string[] {
  const said = new Set(words(heard.join(" ")));
  return words(sent).filter((w) => !said.has(w));
}

type Turn = { say: string; answer: string; spoken: string };

/** The narrator's lines said after the user's turn `i` began (`from`: how many were said before it). */
interface Talk {
  sent: { sent: string; heard: readonly string[] }[];
  said: { at: string; text: string }[];
  from: number[];
}

async function conversation(audio: Float32Array[], turns: Turn[] = TURNS): Promise<Talk> {
  const mic = new LiveMic();
  let engine!: RealtimeEngine;
  const sent: { sent: string; heard: readonly string[] }[] = [];
  /** What the narrator said, line by line. */
  const said: { at: string; text: string }[] = [];
  const from: number[] = [];
  /** The narrator's audio: playing now, and when it last went quiet. */
  let playing = false;
  let quietSince = Date.now();
  let turn = 0;
  const emit = (ev: AgentEvent) => engine.agentEvent(ev, Date.now());
  const real = REAL ? new ClaudeCodeAgent(emit, (w) => engine.setAgentWorking(w), log) : null;
  const agent = async (text: string) => {
    if (real) return real.request(text);
    const reply = turns[Math.min(turn++, turns.length - 1)]!;
    engine.setAgentWorking(true);
    emit({ type: "user_message", text, voice: true });
    await sleep(1_500);
    emit({ type: "assistant_text", text: reply.answer });
    emit({ type: "task_end", outcome: "done", summary: reply.answer, spoken: reply.spoken });
    engine.setAgentWorking(false);
  };
  const events = {
    speech: () => {},
    heard: () => {},
    partial: () => {},
    level: () => {},
    openingMic: () => {},
    capturing: () => {},
    narrating: () => {
      playing = true;
    },
    said: () => {
      playing = false;
      quietSince = Date.now();
    },
    narratorText: (t: string) => {
      // Streamed: each update holds the whole line so far; a new line starts when it no longer extends the last.
      if (said.length && t.startsWith(said[said.length - 1]!.text)) said[said.length - 1]!.text = t;
      else said.push({ at: at(), text: t });
    },
    forward: (text: string, heard?: readonly string[]) => {
      sent.push({ sent: text, heard: heard ?? [] });
      log(`FORWARD ${JSON.stringify(text)}  heard ${JSON.stringify(heard ?? [])}`);
      void agent(text);
    },
    userWords: () => {},
    stopTask: async () => "Stopped the task.",
    answerApproval: async () => "Nothing waits for approval.",
    endVoice: () => {},
    useThisTab: async () => "Already here.",
    failed: (f: unknown) => log(`FAILED ${JSON.stringify(f)}`),
  } as unknown as EngineEvents;
  const openSocket = (): RealtimeSocketLike => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, ["realtime", `openai-insecure-api-key.${KEY}`]);
    const wrap: RealtimeSocketLike = {
      get readyState() {
        return ws.readyState;
      },
      send: (data: string) => ws.send(data),
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
      if (e.type === "conversation.item.input_audio_transcription.completed") log(`USER    words: "${e.transcript}"`);
      if (e.type === "error") log(`ERROR   ${JSON.stringify(e.error)}`);
      wrap.onmessage?.({ data: m.data });
    };
    return wrap;
  };
  engine = new RealtimeEngine({
    ticket: async () => ({ url: "wss://relay.invalid/v1/ai/realtime", token: "live" }),
    createSource: () => mic,
    events,
    openSocket,
    languages: voiceLanguages(["en"], undefined),
  });
  await engine.start();
  await real?.start();
  const ticker = setInterval(() => engine.tick(Date.now()), 1_000);
  await sleep(1_200);
  for (const [i, a] of audio.entries()) {
    log(`USER    says "${turns[i]!.say}"`);
    from.push(said.length);
    const before = sent.length;
    await mic.say(a);
    await sleep(9_000);
    // A user who lets the narrator finish: the next turn waits until it has been quiet for 1.5 s (at most 30 s).
    if (TURNS_SCENARIO) {
      const until = Date.now() + 30_000;
      while (Date.now() < until && (playing || Date.now() - quietSince < 1_500)) await sleep(200);
    }
    // Mid-task: the next question goes in while the agent still works on this one.
    if (MIDTASK && i === 0) continue;
    // The real agent: its turn done (at most 3 minutes), and a few seconds for its result to be said.
    if (real) {
      const until = Date.now() + 180_000;
      while (Date.now() < until && (sent.length === before || real.working)) await sleep(500);
      await sleep(8_000);
    }
  }
  clearInterval(ticker);
  engine.stop();
  real?.stop();
  log(`SAID\n${said.map((l) => `${l.at}s  ${l.text}`).join("\n")}`);
  return { sent, said, from };
}

describe.skipIf(!KEY || !process.env.NOA_LIVE || TURNS_SCENARIO)("live: the narrator passes on the user's words, adding nothing", () => {
  it("each request passed on is the user's words, with no note of the narrator's own", async () => {
    const audio = await Promise.all(TURNS.map((t) => tts(t.say)));
    const bad: { sent: string; extra: string[] }[] = [];
    let total = 0;
    for (let r = 0; r < RUNS; r++) {
      t0 = Date.now();
      log(`==== run ${r + 1}`);
      for (const s of (await conversation(audio)).sent) {
        total++;
        const extra = added(s.sent, s.heard);
        if (extra.length > 2 || /\b(the )?user\b/i.test(s.sent)) bad.push({ sent: s.sent, extra });
      }
    }
    log(`RESULT  ${bad.length} of ${total} requests added words: ${JSON.stringify(bad)}`);
    expect(bad).toEqual([]);
  });
});

describe.skipIf(!KEY || !process.env.NOA_LIVE || !TURNS_SCENARIO)("live: requests go to the agent, small talk is answered by the narrator", () => {
  it("after the invoice exchange, each utterance in a conversation of its own", async () => {
    const first: Turn = { say: "What is this invoice? Who is it billed to?", answer: "Checked the invoice.", spoken: "This invoice, for $170.39 from Neon, is billed to jaeyun@gmail.com and it's already been auto-paid on October 1st." };
    const firstAudio = await tts(first.say);
    const rows: { kind: string; say: string; forwarded: boolean; said: string[] }[] = [];
    for (let r = 0; r < RUNS; r++) {
      for (const [kind, list] of Object.entries(TURN_UTTERANCES).filter(([k]) => !process.env.NOA_LIVE_KINDS || k === process.env.NOA_LIVE_KINDS)) {
        for (const say of list) {
          t0 = Date.now();
          log(`==== ${kind}: ${say}`);
          // The agent's answer to the second turn, when it gets it: its line is said for it.
          const second: Turn = { say, answer: "Checked.", spoken: "AGENT ANSWER." };
          const talk = await conversation([firstAudio, await tts(say)], [first, second]);
          const forwarded = talk.sent.length > 1;
          const said = talk.said.slice(talk.from[1]).map((l) => l.text);
          rows.push({ kind, say, forwarded, said });
          log(`ROW     ${kind} | ${forwarded ? "to agent" : "kept"} | ${JSON.stringify(said)}`);
        }
      }
    }
    const wrong = rows.filter((x) => (x.kind === "request") !== x.forwarded);
    log(`RESULT  ${wrong.length} of ${rows.length} wrong\n${wrong.map((w) => `  ${w.kind} ${w.forwarded ? "passed on" : "kept"}: ${w.say} -> ${JSON.stringify(w.said)}`).join("\n")}`);
    expect(wrong).toEqual([]);
  }, 3_600_000);
});
