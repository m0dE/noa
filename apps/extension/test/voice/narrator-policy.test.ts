/**
 * When the Realtime narrator speaks (narrator-policy.ts), unit by unit and through the real engine (client + feed)
 * with OpenAI's events in their real order. Regression for the owner's report "the agent responds to what I'm saying,
 * then it transcribes what I said and re-responds to the transcription after": the agent's first words restate the
 * request, and a timed progress note made the narrator say them again (a second reply for one utterance); and for the
 * trace of 2026-09-27: a result spoken over the user, a talked-over summary still heard, progress piled on the answer
 * to the user, a reply to noise.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@noa/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import {
  floor,
  freshMemory,
  isNoise,
  MAX_MILESTONES_PER_REQUEST,
  narrationOf,
  NARRATOR_MILESTONE_GAP_MS,
  NOISE_MAX_SPEECH_MS,
  echoesSpoken,
  repeatsRequest,
  requestKind,
  speechTurnOf,
  type Floor,
} from "../../src/voice/narrator-policy.js";
import {
  ACK_MAX_OUTPUT_TOKENS,
  ackResponse,
  ACKNOWLEDGE_INSTRUCTIONS,
  ACKNOWLEDGE_WHILE_WORKING_INSTRUCTIONS,
  HOLD_FOR_WORDS_MS,
  MAKE_AGAIN_RESPONSE,
  NARRATOR_INSTRUCTIONS,
  NARRATOR_TOOLS,
  type RealtimeSocketLike,
} from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";

const GAP = NARRATOR_MILESTONE_GAP_MS;
const nav = (url: string): AgentEvent => ({ type: "tool_call", id: "t", name: "navigate", args: { url } });

describe("narrationOf: what may make the narrator speak", () => {
  it("never the user's message or words, the agent's text, status lines or routine steps", () => {
    const m = freshMemory(0);
    const quiet: AgentEvent[] = [
      { type: "user_message", text: "Check my inbox.", voice: true },
      { type: "user_message", text: "Check my inbox." },
      { type: "heard", text: "Check my inbox." },
      { type: "assistant_text", text: "I'll open your Gmail inbox and summarize it." },
      { type: "status", text: "Claude API" },
      nav("https://mail.google.com/"),
      ...["read_page", "screenshot", "click", "act", "scroll", "type", "paste", "switch_tab"].map((name): AgentEvent => ({ type: "tool_call", id: "t", name, args: {} })),
    ];
    for (const [i, ev] of quiet.entries()) expect(narrationOf(ev, m, GAP * (i + 1)), ev.type).toBeNull();
  });

  it("the result, the agent's question and a problem, each once", () => {
    const m = freshMemory(0);
    expect(narrationOf({ type: "task_end", outcome: "done", summary: "x", spoken: "You have 3 new emails; one is from your accountant." }, m, 1)).toEqual({
      kind: "result",
      line: "You have 3 new emails; one is from your accountant.",
    });
    expect(narrationOf({ type: "task_end", outcome: "done", summary: "x", spoken: "You have 3 new emails; one is from your accountant." }, m, 2)).toBeNull();
    expect(narrationOf({ type: "task_end", outcome: "paused", reason: "Which account?" }, m, 3)).toEqual({ kind: "question", line: "Which account?" });
    expect(narrationOf({ type: "error", text: "Claude API rate limit (HTTP 429)" }, m, 4)?.kind).toBe("error");
  });

  it("a meaningful step (another site, an account switch, a sign-in): not the first site, NARRATOR_MILESTONE_GAP_MS apart, MAX_MILESTONES_PER_REQUEST", () => {
    const m = freshMemory(0);
    expect(narrationOf(nav("https://mail.google.com/"), m, GAP)).toBeNull();
    expect(narrationOf(nav("https://calendar.google.com/"), m, GAP)).toEqual({ kind: "milestone", line: "Opening calendar.google.com" });
    expect(narrationOf({ type: "tool_call", id: "t", name: "switch_x_account", args: { handle: "@acme" } }, m, GAP * 2 - 1)).toBeNull();
    expect(narrationOf({ type: "tool_call", id: "t", name: "switch_x_account", args: { handle: "@acme" } }, m, GAP * 2)).toEqual({ kind: "milestone", line: "Switching to @acme" });
    expect(MAX_MILESTONES_PER_REQUEST).toBe(2);
    expect(narrationOf(nav("https://drive.google.com/"), m, GAP * 10)).toBeNull();
  });
});

describe("floor: one speaker at a time", () => {
  const free: Floor = { userSpeaking: false, awaitingReply: false, replying: false, playing: false };
  const kinds = ["ack", "milestone", "result", "question", "error"] as const;

  it("the user speaking, or their reply about to start: every line is let go (their reply answers, with the news in it)", () => {
    for (const k of kinds) {
      expect(floor(k, { ...free, userSpeaking: true })).toBe("drop");
      expect(floor(k, { ...free, awaitingReply: true })).toBe("drop");
    }
  });

  it("a reply being made or audio playing: a milestone is let go, the rest wait", () => {
    for (const busy of [{ ...free, replying: true }, { ...free, playing: true }]) {
      expect(floor("milestone", busy)).toBe("drop");
      for (const k of ["ack", "result", "question", "error"] as const) expect(floor(k, busy)).toBe("later");
    }
  });

  it("a free floor: now", () => {
    for (const k of kinds) expect(floor(k, free)).toBe("now");
  });
});

describe("isNoise", () => {
  it("an empty transcript of a short sound is noise; words, or long speech, are not", () => {
    expect(isNoise("", 2_000)).toBe(true);
    expect(isNoise("  ", NOISE_MAX_SPEECH_MS)).toBe(true);
    expect(isNoise("", null)).toBe(true);
    expect(isNoise("", NOISE_MAX_SPEECH_MS + 1)).toBe(false);
    expect(isNoise("hi", 300)).toBe(false);
  });
});

it("the narrator is told to speak only with news", () => {
  expect(NARRATOR_INSTRUCTIONS).toContain("Speak only when you have news the user doesn't have: results, questions, blockers, errors. Never describe routine steps");
  expect(NARRATOR_INSTRUCTIONS).toContain("never repeat the user's request back to them");
});

// ---------------------------------------------------------------- the real engine

class FakeSocket implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason: "" }));
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0));

async function started() {
  const socket = new FakeSocket();
  const mic: AudioSource = { start: async () => {}, stop: () => {} };
  const words: string[] = [];
  /** What the panel was shown as said (each reply's words as they grow) and sent to the agent. */
  const shown: string[] = [];
  const forwarded: string[] = [];
  const paired: [string, string | null][] = [];
  const noop = () => {};
  const events = {
    speech: noop,
    heard: noop,
    partial: noop,
    level: noop,
    narrating: noop,
    said: noop,
    narratorText: (text: string) => void shown.push(text),
    // A request, with the user's words for it; words that led to none.
    forward: (text: string, heard?: readonly string[]) => {
      forwarded.push(text);
      if (heard?.length) {
        words.push(heard.join(" "));
        paired.push([heard.join(" "), text]);
      }
    },
    userWords: (w: readonly string[]) => {
      words.push(w.join(" "));
      paired.push([w.join(" "), null]);
    },
    stopTask: async () => "ok",
    endVoice: noop,
    failed: noop,
  } as unknown as EngineEvents;
  const player = { play: vi.fn(), stop: vi.fn(() => null), close: vi.fn(), playing: false };
  const engine = new RealtimeEngine({ ticket: async () => ({ url: "wss://x", token: "t" }), createSource: () => mic, events, openSocket: () => socket, player });
  const start = engine.start();
  await settle();
  socket.readyState = 1;
  socket.onopen?.({});
  socket.event({ type: "session.created", session: {} });
  await start;
  let served = 0;
  const creates = () => socket.sent.filter((e) => e.type === "response.create");
  /** The server answers each response.create the client sent (created, audio, done). */
  const serve = () => {
    while (served < creates().length) {
      const id = `ours${++served}`;
      socket.event({ type: "response.created", response: { id } });
      socket.event({ type: "response.output_audio.delta", response_id: id, item_id: `a_${id}`, delta: "AAAA" });
      socket.event({ type: "response.done", response: { id, status: "completed" } });
    }
  };
  const played = () => player.play.mock.calls.map((c) => c[0] as string);
  return { s: socket, engine, player, serve, creates, played, words, shown, forwarded, paired };
}

/** The user's turn as server VAD reports it (speech of `ms`), and the reply the server makes for it (create_response). */
function userTurn(s: FakeSocket, input: string, reply: string, ms = 3_000): void {
  s.event({ type: "input_audio_buffer.speech_started", item_id: input, audio_start_ms: 1_000 });
  s.event({ type: "input_audio_buffer.speech_stopped", item_id: input, audio_end_ms: 1_000 + ms });
  s.event({ type: "input_audio_buffer.committed", item_id: input, previous_item_id: null });
  s.event({ type: "response.created", response: { id: reply } });
}
const transcribed = (s: FakeSocket, input: string, transcript: string) =>
  s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: input, content_index: 0, transcript, usage: { type: "duration", seconds: 3 } });

describe("one reply per spoken request (the owner's report)", () => {
  for (const order of ["before", "after"] as const) {
    it(`the transcript ${order} response.done: the acknowledgement only, whatever the agent does next`, async () => {
      const t = await started();
      const T0 = Date.now();
      userTurn(t.s, "in1", "r1");
      t.s.event({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Check my inbox." }) });
      await settle();
      if (order === "before") transcribed(t.s, "in1", "Check my inbox.");
      t.s.event({ type: "response.done", response: { id: "r1", status: "completed" } });
      if (order === "after") transcribed(t.s, "in1", "Check my inbox.");
      // The call went out once its turn's words were in.
      await settle();
      t.serve();
      // The agent's first events for the request (the panel feeds them), its steps, and the clock.
      const evs: AgentEvent[] = [
        { type: "user_message", text: "Check my inbox.", voice: true },
        { type: "assistant_text", text: "I'll open your Gmail inbox and summarize the important emails." },
        nav("https://mail.google.com/mail/u/0/#inbox"),
        { type: "heard", text: "Check my inbox." },
        { type: "tool_call", id: "t2", name: "read_page", args: {} },
        { type: "assistant_text", text: "I'm still working through the inbox." },
        { type: "tool_call", id: "t3", name: "act", args: { steps: [{ goal: "open the first email" }] } },
      ];
      evs.forEach((e, i) => {
        t.engine.agentEvent(e, T0 + 500 + i * 3_000);
        t.serve();
      });
      for (let ms = 0; ms <= 30_000; ms += 1_000) {
        t.engine.tick(T0 + ms);
        t.serve();
      }
      expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("Check my inbox.") }]);
      expect(t.words).toEqual(["Check my inbox."]);
      // The result is news: it is said, once.
      t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have 3 new emails; one is from your accountant." }, T0 + 40_000);
      t.serve();
      expect(t.creates()).toHaveLength(2);
      expect(t.s.sent.filter((e) => e.item?.role === "system").map((e) => e.item.content[0].text)).toEqual([
        'Your update (finished): The task is done. Tell the user in one to three short sentences, in the first person: "You have 3 new emails; one is from your accountant."',
      ]);
    });
  }
});

describe("the owner's trace of 2026-09-27", () => {
  it("(a) a result arriving while the user speaks is not said over them: their reply answers, with it", async () => {
    const t = await started();
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in2", audio_start_ms: 1_000 });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have over 7,000 unread emails." }, Date.now());
    expect(t.creates()).toHaveLength(0);
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in2", audio_end_ms: 4_000 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in2" });
    t.s.event({ type: "response.created", response: { id: "r2" } });
    transcribed(t.s, "in2", "You're looking at the wrong inbox.");
    t.s.event({ type: "response.done", response: { id: "r2", status: "completed" } });
    t.serve();
    expect(t.creates()).toHaveLength(0);
  });

  it("(a) a summary the user talked over is not heard afterwards, and not said again", async () => {
    const t = await started();
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have over 7,000 unread emails." }, Date.now());
    expect(t.creates()).toHaveLength(1);
    t.s.event({ type: "response.created", response: { id: "sum" } });
    t.s.event({ type: "response.output_audio.delta", response_id: "sum", item_id: "a_sum", delta: "AAAA" });
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in2", audio_start_ms: 1_000 });
    t.s.event({ type: "response.output_audio.delta", response_id: "sum", item_id: "a_sum", delta: "BBBB" });
    t.s.event({ type: "response.done", response: { id: "sum", status: "cancelled" } });
    expect(t.played()).toEqual(["AAAA"]);
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in2", audio_end_ms: 4_000 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in2" });
    t.s.event({ type: "response.created", response: { id: "r2" } });
    t.s.event({ type: "response.done", response: { id: "r2", status: "completed" } });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have over 7,000 unread emails." }, Date.now());
    t.serve();
    expect(t.creates()).toHaveLength(1);
  });

  it("(b) progress is never said on a clock, and routine steps never", async () => {
    const t = await started();
    const T0 = Date.now();
    for (let i = 0; i < 20; i++) {
      t.engine.agentEvent({ type: "tool_call", id: `t${i}`, name: i % 2 ? "read_page" : "act", args: {} }, T0 + i * 5_000);
      t.engine.agentEvent({ type: "assistant_text", text: "Still working on it." }, T0 + i * 5_000 + 1);
      t.engine.tick(T0 + i * 5_000 + 2);
    }
    expect(t.creates()).toHaveLength(0);
  });

  it("(c) progress while the narrator answers the user is let go; a result waits until the answer has been heard", async () => {
    const t = await started();
    t.engine.agentEvent(nav("https://mail.google.com/"), Date.now());
    userTurn(t.s, "in3", "ans");
    transcribed(t.s, "in3", "Are you still there?");
    t.s.event({ type: "response.output_audio.delta", response_id: "ans", item_id: "a_ans", delta: "AAAA" });
    t.engine.agentEvent(nav("https://calendar.google.com/"), Date.now() + GAP * 2);
    t.engine.tick(Date.now() + GAP * 3);
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Switched", spoken: "Switched to admin@runhq.io; 2 emails need you." }, Date.now());
    t.player.playing = true;
    t.s.event({ type: "response.done", response: { id: "ans", status: "completed" } });
    // The answer is still playing: nothing starts over it.
    expect(t.creates()).toHaveLength(0);
    t.player.playing = false;
    (t.engine as unknown as { client: { playbackIdle(): void } }).client.playbackIdle();
    expect(t.creates()).toEqual([{ type: "response.create" }]);
  });

  it("(d) an empty transcript of a short sound: its reply is cancelled and never heard, and it is no message", async () => {
    const t = await started();
    userTurn(t.s, "in0", "r0", 2_000);
    transcribed(t.s, "in0", "");
    t.s.event({ type: "response.output_audio.delta", response_id: "r0", item_id: "a0", delta: "AAAA" });
    expect(t.s.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
    expect(t.played()).toEqual([]);
    expect(t.words).toEqual([]);
  });

  it("(d) the transcript of noise arriving before its reply starts: that reply is cancelled when it does", async () => {
    const t = await started();
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in0", audio_start_ms: 0 });
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in0", audio_end_ms: 800 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in0" });
    transcribed(t.s, "in0", "");
    expect(t.s.sent.filter((e) => e.type === "response.cancel")).toHaveLength(0);
    t.s.event({ type: "response.created", response: { id: "r0" } });
    t.s.event({ type: "response.output_audio.delta", response_id: "r0", item_id: "a0", delta: "AAAA" });
    expect(t.s.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
    expect(t.played()).toEqual([]);
  });

  it("(d) news let go for a turn that was noise is said after all", async () => {
    const t = await started();
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in0", audio_start_ms: 0 });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Posted", spoken: "Posted it." }, Date.now());
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in0", audio_end_ms: 700 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in0" });
    t.s.event({ type: "response.created", response: { id: "r0" } });
    transcribed(t.s, "in0", "");
    expect(t.creates()).toHaveLength(0);
    t.s.event({ type: "response.done", response: { id: "r0", status: "cancelled" } });
    expect(t.creates()).toEqual([{ type: "response.create" }]);
  });
});

/** The reply `id` (to the user's speech) starts saying `line`: its words, then its audio. */
function speaks(s: FakeSocket, id: string, line: string, audio = "AAAA"): void {
  s.event({ type: "response.output_audio_transcript.delta", response_id: id, delta: line });
  s.event({ type: "response.output_audio.delta", response_id: id, item_id: `a_${id}`, delta: audio });
}
const cancels = (s: FakeSocket) => s.sent.filter((e) => e.type === "response.cancel").length;
const truncations = (s: FakeSocket) => s.sent.filter((e) => e.type === "conversation.item.truncate").map((e) => [e.item_id, e.audio_end_ms]);

describe("the owner's trace of 2026-09-27, gpt-realtime-2.1 with Claude Code: the narrator answering by itself", () => {
  const CORRECTION = "No, you're being a jerk. I'm talking about like yesterday.";
  const MADE_UP = "Yesterday, I told you about two Chrome Web Store emails";

  it("(1, 5) a correction the narrator starts answering from its own notes: never heard or shown, cancelled, made again with a tool call required, and it reaches the agent", async () => {
    const t = await started();
    userTurn(t.s, "in3", "r3", 3_500);
    speaks(t.s, "r3", MADE_UP);
    transcribed(t.s, "in3", CORRECTION);
    expect(t.played()).toEqual([]);
    expect(t.shown).toEqual([]);
    expect(cancels(t.s)).toBe(1);
    t.s.event({ type: "response.done", response: { id: "r3", status: "cancelled" } });
    // What it began is out of its memory too (nothing of it was heard), and the turn is asked again: a tool must answer.
    expect(truncations(t.s)).toEqual([["a_r3", 0]]);
    expect(t.creates()).toEqual([{ type: "response.create", response: MAKE_AGAIN_RESPONSE }]);
    t.s.event({ type: "response.created", response: { id: "r3b" } });
    t.s.event({ type: "response.output_item.added", response_id: "r3b", item: { type: "function_call", name: "send_to_agent" } });
    t.s.event({ type: "response.function_call_arguments.done", response_id: "r3b", call_id: "c3", name: "send_to_agent", arguments: JSON.stringify({ text: "I'm talking about yesterday." }) });
    await settle();
    t.s.event({ type: "response.done", response: { id: "r3b", status: "completed" } });
    expect(t.forwarded).toEqual(["I'm talking about yesterday."]);
    expect(t.paired).toEqual([[CORRECTION, "I'm talking about yesterday."]]);
    // Then the one short acknowledgement, and nothing of the made-up answer was ever played.
    expect(t.creates().slice(1)).toEqual([{ type: "response.create", response: ackResponse("I'm talking about yesterday.") }]);
    expect(t.played()).toEqual([]);
  });

  it("(5) the words arriving after that reply is done: it is still never heard, and made again at once", async () => {
    const t = await started();
    userTurn(t.s, "in3", "r3");
    speaks(t.s, "r3", "It asked you to add a privacy policy.");
    t.s.event({ type: "response.done", response: { id: "r3", status: "completed" } });
    expect(t.played()).toEqual([]);
    expect(t.words).toEqual([]);
    transcribed(t.s, "in3", "What did the second email say exactly?");
    expect(t.played()).toEqual([]);
    expect(t.shown).toEqual([]);
    expect(truncations(t.s)).toEqual([["a_r3", 0]]);
    expect(t.creates()).toEqual([{ type: "response.create", response: MAKE_AGAIN_RESPONSE }]);
  });

  it("a request whose reply says a made-up answer and then calls send_to_agent (live, 2026-09-27): the call goes, nothing it said is heard, the acknowledgement is ours", async () => {
    for (const wordsFirst of [true, false]) {
      const t = await started();
      userTurn(t.s, "in3", "r3");
      if (wordsFirst) transcribed(t.s, "in3", "What did the second email say exactly?");
      else speaks(t.s, "r3", "It says you need to add a privacy policy.");
      t.s.event({ type: "response.output_item.added", response_id: "r3", item: { type: "function_call", name: "send_to_agent" } });
      t.s.event({ type: "response.function_call_arguments.done", response_id: "r3", call_id: "c3", name: "send_to_agent", arguments: JSON.stringify({ text: "What did the second email say exactly?" }) });
      await settle();
      t.s.event({ type: "response.done", response: { id: "r3", status: "completed" } });
      if (!wordsFirst) transcribed(t.s, "in3", "What did the second email say exactly?");
      await settle();
      expect(t.forwarded).toEqual(["What did the second email say exactly?"]);
      expect(t.played()).toEqual([]);
      expect(t.shown).toEqual([]);
      expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("What did the second email say exactly?") }]);
    }
  });

  it("a request whose reply calls send_to_agent first is not held or asked again: the call goes out the moment its words are in", async () => {
    const t = await started();
    userTurn(t.s, "in1", "r1");
    t.s.event({ type: "response.output_item.added", response_id: "r1", item: { type: "function_call", name: "send_to_agent" } });
    t.s.event({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Check my Chrome Web Store emails." }) });
    await settle();
    // Only the user's own request goes to the agent: its turn's words say whether it is theirs.
    expect(t.forwarded).toEqual([]);
    transcribed(t.s, "in1", "Check my Chrome Web Store emails.");
    await settle();
    expect(t.forwarded).toEqual(["Check my Chrome Web Store emails."]);
    t.s.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("Check my Chrome Web Store emails.") }]);
    expect(cancels(t.s)).toBe(0);
  });

  it("small talk is answered by the narrator itself: heard once the words are in, nothing goes to the agent", async () => {
    const t = await started();
    userTurn(t.s, "in2", "r2", 1_200);
    transcribed(t.s, "in2", "Hey, can you hear me?");
    speaks(t.s, "r2", "Yes, I can hear you.");
    t.s.event({ type: "response.done", response: { id: "r2", status: "completed" } });
    // Its words came first (as measured: 385-510 ms after the turn, its audio ~650 ms): played on arrival.
    expect(t.played()).toEqual(["AAAA"]);
    expect(t.shown).toEqual(["Yes, I can hear you."]);
    expect(t.forwarded).toEqual([]);
    expect(t.creates()).toEqual([]);
    expect(t.paired).toEqual([["Hey, can you hear me?", null]]);
  });

  it("small talk whose audio came before its words: held, then played in full once they are in", async () => {
    const t = await started();
    userTurn(t.s, "in2", "r2", 1_200);
    speaks(t.s, "r2", "Yes, ", "AAAA");
    speaks(t.s, "r2", "I can hear you.", "BBBB");
    expect(t.played()).toEqual([]);
    transcribed(t.s, "in2", "Can you hear me?");
    expect(t.played()).toEqual(["AAAA", "BBBB"]);
    expect(t.shown).toEqual(["Yes, I can hear you."]);
  });

  it("words that never come: what is held is heard after HOLD_FOR_WORDS_MS, as before", async () => {
    const t = await started();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      userTurn(t.s, "in2", "r2");
      speaks(t.s, "r2", "Hello!");
      vi.advanceTimersByTime(HOLD_FOR_WORDS_MS - 1);
      expect(t.played()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(t.played()).toEqual(["AAAA"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(2) the acknowledgement is capped (max_output_tokens) and told to say at most four words, no answer", async () => {
    // ~20 audio tokens a second: at most ~6 s even if its reasoning took nothing (the trace's ran 12.6 s, 492 tokens).
    const ack = ackResponse("What did the second email say exactly?");
    expect(ack).toMatchObject({ tool_choice: "none", max_output_tokens: ACK_MAX_OUTPUT_TOKENS, reasoning: { effort: "minimal" } });
    // Out of band with no context: it has none of the agent's updates (or the user's question) to answer from, and
    // keeps nothing of what it says; the request is only a sample of the user's language.
    expect(ack).toMatchObject({ conversation: "none", input: [] });
    expect(ack.instructions).toContain("a sample only: not something to answer): «What did the second email say exactly?»");
    expect(ackResponse(null).instructions).toBe(ACKNOWLEDGE_INSTRUCTIONS);
    expect(ACK_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(120);
    expect(ACKNOWLEDGE_INSTRUCTIONS).toContain("at most four words");
    expect(ACKNOWLEDGE_INSTRUCTIONS).toContain("no answer, no facts, no question");
    expect(NARRATOR_INSTRUCTIONS).toContain("Never answer those yourself from the updates, never guess dates or times");
  });

  it("(3) a reply cut off by noise shows nothing ('Said aloud: I don't have'), and the result that follows is the only line", async () => {
    const t = await started();
    userTurn(t.s, "in4", "r4", 900);
    speaks(t.s, "r4", "I don't have");
    transcribed(t.s, "in4", "");
    speaks(t.s, "r4", " the exact wording.");
    t.s.event({ type: "response.done", response: { id: "r4", status: "cancelled" } });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "x", spoken: "The second email asks you to add a privacy policy." }, Date.now());
    expect(t.creates()).toEqual([{ type: "response.create" }]);
    t.s.event({ type: "response.created", response: { id: "res" } });
    speaks(t.s, "res", "The second email asks for a privacy policy.", "RRRR");
    t.s.event({ type: "response.done", response: { id: "res", status: "completed" } });
    expect(t.shown).toEqual(["The second email asks for a privacy policy."]);
    expect(t.played()).toEqual(["RRRR"]);
  });

  it("(3) the words of a reply talked over are not shown past the point it was cut", async () => {
    const t = await started();
    userTurn(t.s, "in2", "r2");
    transcribed(t.s, "in2", "Hello?");
    speaks(t.s, "r2", "Hi! I'm");
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in5", audio_start_ms: 9_000 });
    speaks(t.s, "r2", " still here and");
    expect(t.shown).toEqual(["Hi! I'm"]);
    expect(t.played()).toEqual(["AAAA"]);
  });

  it("(4) three replies to noise: none heard or shown, none made again, nothing sent; each cancelled", async () => {
    const t = await started();
    for (const n of [1, 2, 3]) {
      userTurn(t.s, `n${n}`, `rn${n}`, 600);
      speaks(t.s, `rn${n}`, "Sorry, I");
      transcribed(t.s, `n${n}`, "");
      t.s.event({ type: "response.done", response: { id: `rn${n}`, status: "cancelled" } });
    }
    expect(cancels(t.s)).toBe(3);
    expect(t.played()).toEqual([]);
    expect(t.shown).toEqual([]);
    expect(t.creates()).toEqual([]);
    expect(t.words).toEqual([]);
  });
});

describe("speechTurnOf: what the narrator may answer by itself", () => {
  // Small talk only: it answers these itself (no agent turn). Everything else must go through a tool.
  const smallTalk = [
    "Hey, can you hear me?",
    "Hello?",
    "Hi there.",
    "Can you hear me now?",
    "Are you still there?",
    "Testing, testing.",
    "Thanks!",
    "Thank you so much.",
    "Okay.",
    "Okay, cool.",
    "Got it, thanks.",
    "Um...",
    "Hold on.",
    "What are you doing right now?",
    "Good morning!",
    "여보세요, 들려요?",
    "",
  ];
  // The owner's trace (2026-09-27) and the kinds of words that must reach the agent (or a tool).
  const requests = [
    "No, you're being a jerk. I'm talking about like yesterday.",
    "I'm talking about yesterday.",
    "What did the second email say exactly?",
    "What did you find?",
    "Do you remember what I asked you this morning?",
    "No, the other inbox.",
    "Hey, open my Gmail.",
    "Thanks, and now check my calendar.",
    "Stop.",
    "Cancel that.",
    "Yes.",
    "No.",
    "Goodbye.",
    "Use this tab.",
    "What's on this page?",
    "Check my inbox.",
  ];

  it("small talk is answered by the narrator; nothing of it starts an agent turn (false-forward risk: 0 of the corpus)", () => {
    const forwarded = smallTalk.filter((w) => speechTurnOf(w) !== "small_talk");
    expect(forwarded).toEqual([]);
  });

  it("anything about what the agent did, knows or remembers, a follow-up or correction, a question for the browser, a command: a tool call is required (0 answered alone)", () => {
    const answeredAlone = requests.filter((w) => speechTurnOf(w) !== "request");
    expect(answeredAlone).toEqual([]);
  });
});

describe("speechTurnOf: what the agent is doing, or whether the assistant is there (the owner's trace: these restarted the agent)", () => {
  it("is answered by the narrator from the latest update, whatever the fillers and swearing", () => {
    const status = ["What are you doing bro", "I'm asking you what the fuck are you doing", "I'm asking you a question", "Are you there? Hello?", "What's going on?", "Hey, what are you working on right now?", "Are you done yet?"];
    expect(status.filter((w) => speechTurnOf(w) !== "small_talk")).toEqual([]);
  });

  it("what it did, found or remembers still goes to the agent", () => {
    const requests = ["What did you do bro?", "I'm asking you what you found", "What are you doing on Gmail? Stop that.", "Tell me what the second email said", "So what did it post?"];
    expect(requests.filter((w) => speechTurnOf(w) !== "request")).toEqual([]);
  });
});

describe("echoesSpoken: the microphone hearing the assistant's own voice (the owner's trace)", () => {
  it("what was just said aloud, heard back, is echo; the user's own words are not", () => {
    expect(echoesSpoken("opening the home timeline", ["Opening the home timeline now."])).toBe(true);
    expect(echoesSpoken("posted open Gmail", ["Posted. Opening Gmail next."])).toBe(true);
    expect(echoesSpoken("Post gm on X from beta", ["Opening the home timeline now."])).toBe(false);
    // Too short to tell, or nothing said lately.
    expect(echoesSpoken("okay", ["Okay, on it."])).toBe(false);
    expect(echoesSpoken("opening the home timeline", [])).toBe(false);
  });
});

describe("repeatsRequest: a request passed on again goes to the agent once", () => {
  const last = { inputId: "in1", text: "Resume from where I left off." };

  it("the same or nearly the same words in the same turn, or in a reply we asked for (no new words of the user's)", () => {
    expect(repeatsRequest("Resume from where I left off.", "in1", last)).toBe(true);
    expect(repeatsRequest("resume from where I left off", null, last)).toBe(true);
    expect(repeatsRequest("Please resume from where I left off", "in1", last)).toBe(true);
  });

  it("not another request in the same turn, the same words in a new turn, or nothing sent yet", () => {
    expect(repeatsRequest("And then open my calendar for tomorrow.", "in1", last)).toBe(false);
    expect(repeatsRequest("Resume from where I left off.", "in2", last)).toBe(false);
    expect(repeatsRequest("Resume from where I left off.", "in1", null)).toBe(false);
  });
});

describe("the owner's report of 2026-09-27: 'can you speak Korean?' while the agent sent a refund email", () => {
  /** The user says `said` (the narrator passes it on as `kind`), while the agent works or not. */
  async function passedOn(said: string, kind: "question" | "instruction", working: boolean, input = "in1") {
    const t = await started();
    t.engine.setAgentWorking(working);
    userTurn(t.s, input, `r_${input}`);
    transcribed(t.s, input, said);
    t.s.event({ type: "response.output_item.added", response_id: `r_${input}`, item: { type: "function_call", name: "send_to_agent" } });
    t.s.event({ type: "response.function_call_arguments.done", response_id: `r_${input}`, call_id: `c_${input}`, name: "send_to_agent", arguments: JSON.stringify({ text: said, kind }) });
    await settle();
    t.s.event({ type: "response.done", response: { id: `r_${input}`, status: "completed" } });
    await settle();
    return t;
  }
  const notes = (s: FakeSocket) => s.sent.filter((e) => e.item?.role === "system").map((e) => e.item.content[0].text as string);

  for (const [question, answer] of [
    ["너 한국어 가능해?", "네, 한국어 가능해요! 지금 Streamlabs 환불 요청 이메일 보내는 중이에요."],
    ["Can you speak Korean?", "Yes, I can speak Korean. I'm sending the Streamlabs refund email now."],
  ] as const) {
    it(`"${question}" mid-task: passed on, no acknowledgement; the agent's answer is said once, at once`, async () => {
      const t = await passedOn(question, "question", true);
      expect(t.forwarded).toEqual([question]);
      expect(t.creates()).toEqual([]);
      const T0 = Date.now();
      t.engine.agentEvent({ type: "user_message", text: question, voice: true }, T0);
      t.engine.agentEvent({ type: "assistant_text", text: answer }, T0 + 1_000);
      expect(t.creates()).toEqual([{ type: "response.create" }]);
      expect(notes(t.s)).toEqual([`Your update (answer): Your answer to the user's question: "${answer}" Tell the user in one or two short sentences, in the first person.`]);
      t.serve();
      // Its next words go on with the task: not said.
      t.engine.agentEvent({ type: "assistant_text", text: "Clicking Send on the refund email." }, T0 + 2_000);
      t.engine.agentEvent({ type: "assistant_text", text: answer }, T0 + 3_000);
      expect(t.creates()).toHaveLength(1);
      // The task's end is said as usual.
      t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Sent", spoken: "Sent the refund request to Streamlabs." }, T0 + 20_000);
      expect(t.creates()).toHaveLength(2);
    });
  }

  it("the narrator answering '너 한국어 가능해?' by itself (live, 2026-09-27: '응, 가능해. 한국어로 편하게 말해줘.'): never heard, made again, passed on as a question, no acknowledgement", async () => {
    const t = await started();
    t.engine.setAgentWorking(true);
    userTurn(t.s, "in1", "r1", 1_500);
    speaks(t.s, "r1", "응, 가능해. 한국어로 편하게 말해줘.");
    transcribed(t.s, "in1", "너 한국어 가능해?");
    t.s.event({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    expect(t.creates()).toEqual([{ type: "response.create", response: MAKE_AGAIN_RESPONSE }]);
    t.s.event({ type: "response.created", response: { id: "r1b" } });
    t.s.event({ type: "response.output_item.added", response_id: "r1b", item: { type: "function_call", name: "send_to_agent" } });
    t.s.event({ type: "response.function_call_arguments.done", response_id: "r1b", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "너 한국어 가능해?", kind: "question" }) });
    await settle();
    t.s.event({ type: "response.done", response: { id: "r1b", status: "completed" } });
    await settle();
    expect(t.forwarded).toEqual(["너 한국어 가능해?"]);
    expect(t.creates()).toHaveLength(1);
    expect(t.played()).toEqual([]);
    t.engine.agentEvent({ type: "assistant_text", text: "네, 한국어 가능해요!" }, Date.now());
    expect(t.creates().slice(1)).toEqual([{ type: "response.create" }]);
  });

  it("the user's correction ('아니, 저는 그냥 한국어 가능한지 물어본 거예요') is a question too: no acknowledgement", async () => {
    const t = await passedOn("아니, 저는 그냥 한국어 가능한지 물어본 거예요", "question", true);
    expect(t.forwarded).toEqual(["아니, 저는 그냥 한국어 가능한지 물어본 거예요"]);
    expect(t.creates()).toEqual([]);
  });

  it("a question when the agent is idle: no acknowledgement; its turn's end is the answer", async () => {
    const t = await passedOn("What's on my calendar tomorrow?", "question", false);
    expect(t.creates()).toEqual([]);
    // The turn's own words are not the answer (its end is).
    t.engine.agentEvent({ type: "assistant_text", text: "I'll open your calendar." }, Date.now());
    expect(t.creates()).toEqual([]);
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Read", spoken: "Two meetings tomorrow." }, Date.now() + 5_000);
    expect(t.creates()).toEqual([{ type: "response.create" }]);
  });

  it('"also cc my accountant" mid-task: one neutral acknowledgement only', async () => {
    const t = await passedOn("also cc my accountant", "instruction", true);
    expect(t.forwarded).toEqual(["also cc my accountant"]);
    expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("also cc my accountant", true) }]);
    expect(t.creates()[0]!.response.instructions).toContain(ACKNOWLEDGE_WHILE_WORKING_INSTRUCTIONS);
    t.serve();
    expect(t.creates()).toHaveLength(1);
  });

  it("a new task when the agent is idle: one short acknowledgement", async () => {
    const t = await passedOn("Send Streamlabs a refund request", "instruction", false);
    expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("Send Streamlabs a refund request", false) }]);
    expect(t.creates()[0]!.response.instructions).toContain(ACKNOWLEDGE_INSTRUCTIONS);
  });

  it("no acknowledgement may claim what will be done or when, and each stays small (max_output_tokens)", () => {
    for (const say of [ACKNOWLEDGE_INSTRUCTIONS, ACKNOWLEDGE_WHILE_WORKING_INSTRUCTIONS]) {
      expect(say).toContain("Never say what will be done, is being done or when (never 'I'll start', 'starting soon', 'I'll do it now').");
      expect(say).toContain("no answer, no facts, no question");
    }
    expect(ACKNOWLEDGE_WHILE_WORKING_INSTRUCTIONS).toContain("neutral acknowledgement of one to three words");
    expect(ACK_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(120);
    for (const working of [false, true]) {
      expect(ackResponse("너 한국어 가능해?", working)).toMatchObject({ tool_choice: "none", max_output_tokens: ACK_MAX_OUTPUT_TOKENS, reasoning: { effort: "minimal" }, conversation: "none", input: [] });
    }
  });

  it("send_to_agent carries the narrator's own reading of the words (kind); a call without it is an instruction", () => {
    const send = NARRATOR_TOOLS.find((t) => t.name === "send_to_agent")!;
    expect(send.parameters.required).toEqual(["text", "kind"]);
    expect(send.parameters.properties).toMatchObject({ kind: { type: "string", enum: ["question", "instruction"] } });
    expect(requestKind({ text: "x", kind: "question" })).toBe("question");
    expect(requestKind({ text: "x", kind: "instruction" })).toBe("instruction");
    expect(requestKind({ text: "x" })).toBe("instruction");
    expect(requestKind(null)).toBe("instruction");
  });
});
