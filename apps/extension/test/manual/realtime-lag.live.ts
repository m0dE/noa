/**
 * Live reproduction of "the voice answers lag a turn behind": the extension's real RealtimeEngine (client, feed,
 * policy, PcmPlayer) against OpenAI's Realtime model, with the user's questions synthesized by OpenAI TTS and streamed
 * in as microphone audio in real time, and a scripted agent that answers each request with the events the real
 * brains emit (user_message, text, tool steps, task_end with its spoken line). Playback runs on a wall-clock fake
 * AudioContext, so the floor, barge-in and pacing logic run as in the panel.
 *
 * It costs money (Realtime audio + TTS). Run from apps/extension:
 *   OPENAI_API_KEY=... NOA_LIVE=1 npx vitest run --config test/manual/live.config.ts
 * Prints a timeline and, per question, which answer the narrator said after it.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, localTimeZone, type AgentEvent } from "@noa/shared";
import { buildFollowUpMessage, startApiAgent, type AgentSession } from "@noa/core";
import { FakeGmail } from "./fake-gmail.js";
import { ClaudeCodeAgent } from "./claude-code-agent.js";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";

const KEY = process.env.OPENAI_API_KEY ?? "";
const MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const RATE = 24_000;
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const timeline: string[] = [];
const log = (s: string) => {
  const line = `${at()}s ${s}`;
  timeline.push(line);
  console.log(line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a wall-clock AudioContext, enough for PcmPlayer
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
    playedChunks++;
    const ms = (when - this.ctx.currentTime + this.buffer!.duration) * 1000;
    this.timer = setTimeout(() => this.onended?.(), Math.max(0, ms));
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}
/** Chunks started playing (what the user heard). */
let playedChunks = 0;
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

// ---- the user's voice
async function tts(text: string): Promise<Float32Array> {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      response_format: "pcm",
    }),
  });
  if (!r.ok) throw new Error(`tts ${r.status} ${await r.text()}`);
  const b = new Uint8Array(await r.arrayBuffer());
  const pcm = new Int16Array(
    b.buffer,
    b.byteOffset,
    Math.floor(b.byteLength / 2),
  );
  return Float32Array.from(pcm, (s) => s / 0x8000);
}

class LiveMic implements AudioSource {
  private deliver: ((s: Float32Array) => void) | null = null;
  private queue: Float32Array[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private done: (() => void) | null = null;
  async start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.deliver = onSamples;
    const chunk = RATE / 10;
    this.timer = setInterval(() => {
      const next = this.queue.shift();
      if (next) this.deliver?.(next);
      else {
        // Room noise, not digital silence.
        this.deliver?.(
          Float32Array.from(
            { length: chunk },
            () => (Math.random() - 0.5) * 0.002,
          ),
        );
        if (this.done) {
          this.done();
          this.done = null;
        }
      }
    }, 100);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.deliver = null;
  }
  /** Says `audio` in real time; resolves when it is all out. */
  say(audio: Float32Array): Promise<void> {
    const chunk = RATE / 10;
    for (let i = 0; i < audio.length; i += chunk)
      this.queue.push(audio.slice(i, i + chunk));
    return new Promise((r) => (this.done = r));
  }
}

// ---- the scripted agent: the answer to each question, found by its words
interface Qa {
  q: string;
  match: RegExp;
  a: string;
  /** Words of the answer that identify it when said. */
  mark: RegExp;
}
const QA: Qa[] = [
  {
    q: "What's the latest email in my inbox?",
    match: /latest|newest|recent|inbox/i,
    a: "The latest email is from Dana Kim, moving Friday's design review to 3 PM.",
    mark: /dana|design review/i,
  },
  {
    q: "What did she say about the agenda?",
    match: /agenda/i,
    a: "She wants to go over the onboarding flow first, then the pricing page.",
    mark: /onboarding|pricing/i,
  },
  {
    q: "Did anyone reply to her?",
    match: /repl/i,
    a: "Yes, Marco replied that 3 PM works for him.",
    mark: /marco/i,
  },
  {
    q: "And what's the email after that one?",
    match: /after|next|older|previous|below/i,
    a: "The one after it is a GitHub notice about a failed build on main.",
    mark: /failed build|on main|ci run|run failed|build failed|failed on|9:15/i,
  },
  {
    q: "Who sent that build notice?",
    match: /who|sent|sender|build|notice/i,
    a: "It came from GitHub Actions for the noa-mono repository.",
    mark: /sent (?:it|by)|came from|sender|notifications@|github actions/i,
  },
];

type Emit = (ev: AgentEvent) => void;

class ScriptedAgent {
  working = false;
  requests = 0;
  /** Turns ended (task_end). */
  ended = 0;
  private step = 0;
  /** Messages sent while a turn runs, not read yet (the model reads them at its next step). */
  private unread: Qa[] = [];
  constructor(
    private readonly emit: Emit,
    private readonly setWorking: (w: boolean) => void,
  ) {}
  /** A request from the narrator: a new turn when idle, else a message into the running turn (like both brains). */
  async request(text: string): Promise<void> {
    this.requests++;
    const qa = [...QA].reverse().find((x) => x.match.test(text)) ?? null;
    const n = ++this.step;
    log(
      `AGENT   <- request #${n}${this.working ? " (into the running turn)" : ""}: "${text}" => ${qa ? `A${QA.indexOf(qa) + 1}` : "(no match)"}`,
    );
    await sleep(150);
    this.emit({ type: "user_message", text, voice: true });
    if (this.working) {
      if (qa) this.unread.push(qa);
      return;
    }
    this.working = true;
    this.setWorking(true);
    const answer = qa;
    // Steps of 2-4 s like the real agent's (a model call, then a tool), each with a line of text. A message sent
    // meanwhile is read after the current step: the text of a step already being written predates it.
    const lines = [
      "Let me check your inbox.",
      "The inbox is open.",
      "Opening the message.",
      "Reading it now.",
    ];
    for (let k = 0; k < lines.length; k++) {
      await sleep(600 + Math.random() * 900);
      this.emit({ type: "assistant_text", text: lines[k]! });
      this.emit({
        type: "tool_call",
        id: `c${n}${k}`,
        name: "read_page",
        args: {},
      });
      await sleep(1_500 + Math.random() * 2_000);
      this.emit({
        type: "tool_result",
        id: `c${n}${k}`,
        name: "read_page",
        ok: true,
        summary: "read",
      } as unknown as AgentEvent);
      // Read now: a question is answered with answer_user, then the task goes on.
      const read = this.unread.splice(0);
      // The brains' "interjection" trace: the model read the message (sessions.ts passes it on live).
      if (read.length) this.emit({ type: "trace", trace: { t: Date.now(), cat: "user", name: "interjection", data: { route: "request", count: read.length } } } as unknown as AgentEvent);
      for (const q of read) {
        await sleep(1_500);
        log(`AGENT   -> answers the message read mid-turn: "${q.a}"`);
        this.emit({ type: "tool_call", id: `ans${n}`, name: "answer_user", args: { text: q.a } });
      }
    }
    const a = answer?.a ?? "I couldn't find that.";
    log(`AGENT   -> task_end #${n}: "${a}"`);
    this.emit({ type: "assistant_text", text: a });
    this.emit({ type: "task_end", outcome: "done", summary: a, spoken: a });
    this.working = false;
    this.ended++;
    this.setWorking(false);
  }
}

/**
 * The real agent: the Claude API brain's loop (@noa/core startApiAgent, as the extension runs it) on a fake Gmail,
 * driven like the extension's runner does: the first request starts it, a request while its turn runs goes into that
 * turn (sendUserMessage: read at its next step), one after the turn ended is its next turn (continueWith, with
 * buildFollowUpMessage). Like the runner, the voice message is in the chat (user_message, voice) and the brain's echo
 * of it is not; the "interjection" trace reaches the panel live (sessions.ts).
 */
class ClaudeAgent {
  working = false;
  requests = 0;
  ended = 0;
  private session: AgentSession | null = null;
  private readonly gmail = new FakeGmail();
  constructor(
    private readonly emit: Emit,
    private readonly setWorking: (w: boolean) => void,
  ) {}

  private onEvent = (e: AgentEvent): void => {
    if (e.type === "user_message" || e.type === "assistant_text_delta") return;
    if (e.type === "assistant_text") log(`AGENT   text: "${e.text.replace(/\s+/g, " ").slice(0, 140)}"`);
    if (e.type === "tool_call") log(`AGENT   tool: ${e.name}`);
    if (e.type === "task_end") log(`AGENT   -> task_end ${e.outcome}: spoken "${e.spoken ?? ""}"`);
    this.emit(e);
  };

  async request(text: string): Promise<void> {
    this.requests++;
    const n = this.requests;
    log(`AGENT   <- request #${n}${this.working ? " (into the running turn)" : ""}: "${text}"`);
    if (this.working && this.session) {
      this.emit({ type: "user_message", text, voice: true });
      this.session.sendUserMessage(text);
      return;
    }
    this.working = true;
    this.setWorking(true);
    const opts = {
      sessionId: "live",
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: process.env.NOA_LIVE_MODEL || DEFAULT_MODEL,
      mediaPaths: [],
      config: { maxToolCalls: 40, maxTaskMinutes: 5, jevEnabled: false, jevThreshold: 0.8, isRetry: false },
      browser: this.gmail.caller(),
      jev: null,
      onEvent: this.onEvent,
      onTrace: (t: Record<string, unknown>) => {
        if (t.cat === "user" && t.name === "interjection") {
          log("AGENT   read the message sent into its turn");
          this.emit({ type: "trace", trace: { ...t, src: "engine" } } as unknown as AgentEvent);
        }
      },
    };
    if (!this.session) {
      // A new chat's first turn has no message of its own (the request is the task).
      this.session = startApiAgent({ ...opts, task: { id: "live", instructions: text, account: null, userTab: { ...FakeGmail.start, access: "here" } } } as never);
    } else {
      this.emit({ type: "user_message", text, voice: true });
      this.session = this.session.continueWith!(buildFollowUpMessage({ text, timeZone: localTimeZone() }));
    }
    try {
      await this.session.done;
    } catch (err) {
      log(`AGENT   failed: ${String(err)}`);
    }
    this.working = false;
    this.ended++;
    this.setWorking(false);
  }
}


/** What the user does after saying a step: wait for its answer, or talk on this long after it reached the agent (or after it was said). */
type Then = "answered" | { afterForward: number } | { after: number };
interface Step {
  /** A question (index in QA), or small talk. */
  qa: number | null;
  say?: string;
  then: Then;
}
const SCENARIOS: Record<
  string,
  {
    steps: Step[];
    /** Questions (1-based) whose own answer must be said before the next one. */ required: number[];
  }
> = {
  waits: {
    steps: QA.map((_, i) => ({ qa: i, then: "answered" as const })),
    required: [1, 2, 3, 4, 5],
  },
  "talks-on": {
    steps: QA.map((_, i) => ({
      qa: i,
      then: i < QA.length - 1 ? { afterForward: 4_000 } : ("answered" as const),
    })),
    required: [5],
  },
  // Like people use it: a question while the agent still works on the last one, "hello?" while waiting, then waiting.
  mixed: {
    steps: [
      { qa: 0, then: { afterForward: 1_500 } },
      { qa: 1, then: "answered" },
      { qa: 2, then: { after: 3_500 } },
      { qa: null, say: "Hello? Are you still there?", then: "answered" },
      { qa: 3, then: "answered" },
      { qa: 4, then: "answered" },
    ],
    required: [2, 3, 4, 5],
  },
};

/** Which answers a line of the narrator's says. */
const answersIn = (line: string) =>
  QA.map((x, i) => (x.mark.test(line) ? `A${i + 1}` : null))
    .filter(Boolean)
    .join("+") || "-";

describe.skipIf(!KEY || !process.env.NOA_LIVE)(
  "live: Realtime answers keep up with the conversation",
  () => {
    for (const patience of Object.keys(SCENARIOS)) {
      it(`each answer is said for the question it answers, not a turn later (a user who ${patience})`, async () => {
        timeline.length = 0;
        const { steps, required } = SCENARIOS[patience]!;
        const audio = await Promise.all(
          steps.map((st) => tts(st.say ?? QA[st.qa!]!.q)),
        );
        const mic = new LiveMic();
        let engine!: RealtimeEngine;
        /** What the narrator said, per reply, in order. */
        const said: { at: number; text: string }[] = [];
        let lastPlayEnd = Date.now();
        let playing = false;
        const events: EngineEvents = {
          speech: () => log("VAD     user speech started"),
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
            lastPlayEnd = Date.now();
          },
          narratorText: () => {},
          forward: (text) => {
        if (process.env.NOA_LIVE_EVENTS) appendFileSync(process.env.NOA_LIVE_EVENTS, `${at()} FORWARD ${text}\n`);
        void agent.request(text);
      },
          userWords: () => {},
          stopTask: async () => "Stopped the task.",
          answerApproval: async () => "Nothing waits for approval.",
          endVoice: () => {},
          useThisTab: async () => "Already here.",
          failed: (f) => log(`FAILED ${JSON.stringify(f)}`),
        };
        const Agent = process.env.NOA_LIVE_AGENT === "claude-code" ? ClaudeCodeAgent : process.env.NOA_LIVE_AGENT === "claude" ? ClaudeAgent : ScriptedAgent;
        const agent = new Agent(
          (ev) => {
            if (process.env.NOA_LIVE_EVENTS) appendFileSync(process.env.NOA_LIVE_EVENTS, `${at()} ${JSON.stringify(ev).slice(0, 300)}\n`);
            engine.agentEvent(ev, Date.now());
          },
          (w) => engine.setAgentWorking(w),
          log,
        );
        const openSocket = (url: string): RealtimeSocketLike => {
          const ws = new WebSocket(
            `wss://api.openai.com/v1/realtime?model=${MODEL}`,
            ["realtime", `openai-insecure-api-key.${KEY}`],
          );
          const wrap: RealtimeSocketLike = {
            get readyState() {
              return ws.readyState;
            },
            send(data: string) {
              const e = JSON.parse(data);
              if (e.type === "response.create")
                log(
                  `CLIENT  response.create ${JSON.stringify(e.response ?? {}).slice(0, 110)}`,
                );
              if (
                e.type === "conversation.item.create" &&
                e.item?.role === "system"
              )
                log(`CLIENT  note: ${e.item.content[0].text.slice(0, 110)}`);
              ws.send(data);
            },
            close: (code?: number, reason?: string) =>
              ws.close(code === 1000 ? 1000 : undefined, reason),
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
          };
          ws.onopen = (e) => wrap.onopen?.(e);
          ws.onclose = (e) =>
            wrap.onclose?.({ code: e.code, reason: e.reason });
          ws.onerror = (e) => wrap.onerror?.(e);
          /** Replies whose audio played (heard, at least in part), and when their audio started. */
          const heard = new Map<string, number>();
          ws.onmessage = (m) => {
            const e = JSON.parse(String(m.data));
            if (e.type === "response.output_audio_transcript.done") {
              const start = heard.get(e.response_id);
              if (start === undefined) log(`NARRATOR (not played, never heard) "${e.transcript}"`);
              else {
                // Counted from when the user started hearing it.
                said.push({ at: start, text: e.transcript });
                log(`NARRATOR said (heard from ${((start - t0) / 1000).toFixed(1)}s): "${e.transcript}"  [${answersIn(e.transcript)}]`);
              }
            }
            if (
              e.type === "conversation.item.input_audio_transcription.completed"
            )
              log(`USER    words: "${e.transcript}"`);
            if (e.type === "error") log(`ERROR   ${JSON.stringify(e.error)}`);
            if (
              process.env.NOA_LIVE_VERBOSE &&
              /^(response\.(created|done)|input_audio_buffer\.(committed|speech_stopped)|response\.output_item\.added|response\.function_call_arguments\.done)$/.test(
                e.type,
              )
            )
              log(
                `SERVER  ${e.type} ${e.item_id ?? e.response?.id ?? ""} ${e.name ?? e.item?.type ?? e.response?.status ?? ""}`,
              );
            const before = playedChunks;
            wrap.onmessage?.({ data: m.data });
            if (e.type === "response.output_audio.delta" && playedChunks > before && !heard.has(e.response_id)) heard.set(e.response_id, Date.now());
          };
          void url;
          return wrap;
        };
        engine = new RealtimeEngine({
          ticket: async () => ({
            url: "wss://relay.invalid/v1/ai/realtime",
            token: "live",
          }),
          createSource: () => mic,
          events,
          openSocket,
          languages: ["en"],
        });
        await engine.start();
        if ("start" in agent) await agent.start();
        const ticker = setInterval(() => engine.tick(Date.now()), 1_000);
        await sleep(1_000);

        /** When each question was finished being said. */
        const asked: number[] = [];
        for (let k = 0; k < steps.length; k++) {
          const st = steps[k]!;
          log(
            `USER    says ${st.qa === null ? "" : `Q${st.qa + 1}: `}"${st.say ?? QA[st.qa!]!.q}"`,
          );
          const requests = agent.requests;
          await mic.say(audio[k]!);
          if (st.qa !== null) asked.push(Date.now());
          const until = Date.now() + (process.env.NOA_LIVE_AGENT ? 120_000 : 25_000);
          if (st.then !== "answered") {
            if ("afterForward" in st.then)
              while (Date.now() < until && agent.requests === requests)
                await sleep(200);
            await sleep(
              "afterForward" in st.then ? st.then.afterForward : st.then.after,
            );
            continue;
          }
          // Waits for the answer: the request reaching the agent (if it makes one), its work being done, the narrator
          // saying something after that (at most 10 s), and 2 s of quiet.
          const reach = Date.now() + 2_500;
          while (Date.now() < reach && agent.requests === requests)
            await sleep(200);
          await sleep(300);
          while (Date.now() < until && agent.working) await sleep(200);
          const done = Date.now();
          while (
            Date.now() < Math.min(until, done + 10_000) &&
            !said.some((x) => x.at >= done)
          )
            await sleep(200);
          while (
            Date.now() < until &&
            (playing || Date.now() - lastPlayEnd < 2_000)
          )
            await sleep(200);
        }
        await sleep(6_000);
        clearInterval(ticker);
        engine.stop();
        if ("stop" in agent) agent.stop();

        // What was said after each question (before the next one), by answer.
        const report: string[] = [];
        let lagging = 0;
        // A line that answers only questions older than the latest one asked before it: the lag.
        for (const s of said) {
          const latest = asked.filter((a) => a <= s.at).length;
          const answers = answersIn(s.text)
            .split("+")
            .filter((a) => a !== "-")
            .map((a) => Number(a.slice(1)));
          // ...while the latest one is not answered yet (a turn's end after it answered a follow-up is its own result).
          const answeredLatest = said.some((x) => x.at < s.at && answersIn(x.text).split("+").includes(`A${latest}`));
          if (answers.length && Math.max(...answers) < latest && !answeredLatest) {
            lagging++;
            report.push(
              `LAG: after Q${latest} it said "${s.text}" (answers Q${answers.join("+Q")})`,
            );
          }
        }
        for (let i = 0; i < asked.length; i++) {
          const from = asked[i]!;
          const to = asked[i + 1] ?? Infinity;
          const lines = said
            .filter((s) => s.at >= from && s.at < to)
            .map((s) => answersIn(s.text));
          const heard = [
            ...new Set(
              lines.flatMap((l) => l.split("+")).filter((l) => l !== "-"),
            ),
          ];
          const own = heard.includes(`A${i + 1}`);
          const stale = heard.filter((a) => a !== `A${i + 1}`);
          if (required.includes(i + 1) && !own) lagging++;
          report.push(
            `Q${i + 1}: answers said before the next question: [${heard.join(", ")}]${own ? "" : "  MISSING its answer"}${stale.length ? `  STALE ${stale.join(",")}` : ""}`,
          );
        }
        const out = `\n==== ${patience}\n${timeline.join("\n")}\n==== per question\n${report.join("\n")}\nRESULT ${patience}: ${lagging ? `FAIL (${lagging})` : "OK"}\n`;
        console.log(out);
        if (process.env.NOA_LIVE_OUT)
          appendFileSync(process.env.NOA_LIVE_OUT, out);
        expect(lagging, report.join("\n")).toBe(0);
      }, 900_000);
    }
  },
);
