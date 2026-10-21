/**
 * Everything the user says goes to the agent (the owner's rule, 2026-10-21: "everything goes to the AI logic, stop
 * gatekeeping"): the narrator makes no reply of its own to their speech and decides nothing; each turn goes to the
 * agent word for word, a request said with pauses as one. Not passed on: the speaker heard back, a sound with no words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTINUE_MS, RealtimeClient, SENT_OUTPUT, type RealtimeSocketLike } from "../../src/voice/realtime-client.js";

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
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

function client(audible = () => false) {
  let socket!: FakeSocket;
  const passed: { text: unknown; heard: string[] }[] = [];
  const c = new RealtimeClient({
    url: "wss://x/v1/ai/realtime",
    token: "t",
    open: () => (socket = new FakeSocket()),
    handlers: {
      playing: audible,
      quietMs: () => (audible() ? 0 : 60_000),
      onTool: (name, args, _input, heard) => {
        if (name === "send_to_agent") passed.push({ text: args.text, heard });
        return SENT_OUTPUT;
      },
    },
  });
  c.connect();
  socket.open();
  const s = socket;
  return {
    c,
    s,
    passed,
    /** A turn of the user's: speech, its end, committed, its words (no reply follows: the narrator makes none). */
    turn(id: string, words: string) {
      s.event({ type: "input_audio_buffer.speech_started", item_id: id });
      s.event({ type: "input_audio_buffer.speech_stopped", item_id: id });
      s.event({ type: "input_audio_buffer.committed", item_id: id });
      s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
    },
    asked: () => s.sent.filter((e) => e.type === "response.create"),
  };
}

const run = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("everything the user says goes to the agent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the narrator makes no reply of its own to the user's speech", () => {
    const t = client();
    expect(t.s.sent[0]!.session.audio.input.turn_detection.create_response).toBe(false);
  });

  it("a request, small talk and a question alike go to the agent, word for word; the narrator is asked for nothing", async () => {
    const t = client();
    t.turn("in1", "Hey, what's up?");
    await run(0);
    t.turn("in2", "Open my inbox.");
    await run(0);
    t.turn("in3", "이 페이지가 무슨 내용인지 알려줘.");
    await run(0);
    expect(t.passed).toEqual([
      { text: "Hey, what's up?", heard: ["Hey, what's up?"] },
      { text: "Open my inbox.", heard: ["Open my inbox."] },
      { text: "이 페이지가 무슨 내용인지 알려줘.", heard: ["이 페이지가 무슨 내용인지 알려줘."] },
    ]);
    expect(t.asked()).toEqual([]);
  });

  it("words the transcription garbled go too (the agent makes of them what it can)", async () => {
    const t = client();
    t.turn("in1", "有，......。");
    await run(0);
    expect(t.passed.map((p) => p.text)).toEqual(["有，......。"]);
  });

  it("a request said with pauses goes as one message, every part of it", async () => {
    const t = client();
    t.turn("in1", "Okay so I got an email from");
    await run(400);
    t.turn("in2", "Dana at Brightline, and I want you to reply that we accept.");
    await run(0);
    expect(t.passed).toEqual([
      { text: "Okay so I got an email from Dana at Brightline, and I want you to reply that we accept.", heard: ["Okay so I got an email from", "Dana at Brightline, and I want you to reply that we accept."] },
    ]);
  });

  it("words that trail off, then quiet: they go after CONTINUE_MS", async () => {
    const t = client();
    t.turn("in1", "Look up the weather for");
    await run(CONTINUE_MS - 100);
    expect(t.passed).toEqual([]);
    await run(200);
    expect(t.passed.map((p) => p.text)).toEqual(["Look up the weather for"]);
  });

  it("not passed on: a sound with no words, and the speaker heard back", async () => {
    let playing = false;
    const t = client(() => playing);
    t.c.say("result", "Your inbox has three new emails.");
    t.s.event({ type: "response.created", response: { id: "r_line" } });
    t.s.event({ type: "response.output_audio_transcript.delta", response_id: "r_line", item_id: "a1", delta: "Your inbox has three new emails." });
    t.s.event({ type: "response.output_audio.delta", response_id: "r_line", item_id: "a1", delta: "AAAA" });
    t.s.event({ type: "response.done", response: { id: "r_line", status: "completed", output: [] } });
    t.turn("noise", "");
    // The speaker playing the line: the microphone hears it back.
    playing = true;
    t.turn("echo", "Your inbox has three new emails.");
    await run(CONTINUE_MS + 100);
    expect(t.passed).toEqual([]);
  });
});
