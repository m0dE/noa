/**
 * A long request said with pauses to think (ticket 1bba1841: "I gave an essay of a command"): server VAD ends a turn at
 * every pause, so it comes as a string of turns. A request for a turn that trails off waits CONTINUE_MS for the user to
 * go on; going on, it is not sent and the narrator passes on the whole request once they finish; quiet, it goes out. A
 * turn that ends like a sentence is never held, and a held request is never lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTINUE_MS, NOT_A_REQUEST_OUTPUT, RealtimeClient, SENT_OUTPUT, unfinishedWords, type RealtimeSocketLike } from "../../src/voice/realtime-client.js";

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

function client() {
  let socket!: FakeSocket;
  const sent: { text: unknown; heard: string[] }[] = [];
  const c = new RealtimeClient({ passOnEverything: false, 
    url: "wss://x/v1/ai/realtime",
    token: "t",
    open: () => (socket = new FakeSocket()),
    handlers: {
      onTool: (name, args, _input, heard) => {
        if (name === "send_to_agent") sent.push({ text: args.text, heard });
        return SENT_OUTPUT;
      },
    },
  });
  c.connect();
  socket.open();
  const s = socket;
  return {
    s,
    sent,
    /** A turn of the user's: speech, its end, committed, and the reply the server starts for it. */
    turn(id: string, words: string) {
      s.event({ type: "input_audio_buffer.speech_started", item_id: id });
      s.event({ type: "input_audio_buffer.speech_stopped", item_id: id });
      s.event({ type: "input_audio_buffer.committed", item_id: id });
      s.event({ type: "response.created", response: { id: `r_${id}` } });
      s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
    },
    call: (id: string, text: string) => s.event({ type: "response.function_call_arguments.done", call_id: `c_${id}`, name: "send_to_agent", arguments: JSON.stringify({ text }) }),
    done: (id: string) => s.event({ type: "response.done", response: { id: `r_${id}`, status: "completed", output: [] } }),
    outputs: () => s.sent.filter((e) => e.item?.type === "function_call_output").map((e) => e.item.output as string),
  };
}

const run = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("unfinishedWords: the words stop mid-thought", () => {
  it("no sentence end, or a trailing off, is unfinished; a sentence end is not", () => {
    for (const t of ["Okay, so I got an email from", "Dana at Brightline about their renewal and", "I want you to, um", "Happy to revisit the topic of, you know...", "and then…"]) expect(unfinishedWords(t), t).toBe(true);
    for (const t of ["What's on this page?", "Open my inbox.", "Send it now!", "“Done.”", "이메일 확인해 줘.", "这个页面上有几个链接？", "ما هو عنوان هذه الصفحة؟", "इस पेज पर कौन सा लिंक है।", "یہ صفحہ کس بارے میں ہے۔", "Τι είναι αυτή η σελίδα;", "このページは何ですか。", ""]) expect(unfinishedWords(t), t).toBe(false);
  });
});

describe("a request said with pauses: one request, the whole of it", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the user goes on talking after a fragment: not sent, the narrator is told; its whole request then goes once, with every part", async () => {
    const t = client();
    t.turn("in1", "Okay, so I got an email from");
    t.call("in1", "Okay, so I got an email from");
    await run(300);
    t.turn("in2", "Dana at Brightline, and I want you to reply that we accept.");
    await run(0);
    expect(t.sent).toEqual([]);
    expect(t.outputs()).toEqual([NOT_A_REQUEST_OUTPUT.unfinished]);
    t.call("in2", "Reply to Dana at Brightline that we accept.");
    await run(0);
    expect(t.sent).toEqual([{ text: "Reply to Dana at Brightline that we accept.", heard: ["Okay, so I got an email from", "Dana at Brightline, and I want you to reply that we accept."] }]);
  });

  it("the call comes only after the user went on talking: still held (their next turn is under way)", async () => {
    const t = client();
    t.turn("in1", "Mention that the onboarding sessions are, um,");
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in2" });
    t.call("in1", "Mention that the onboarding sessions are");
    await run(0);
    expect(t.sent).toEqual([]);
    expect(t.outputs()).toEqual([NOT_A_REQUEST_OUTPUT.unfinished]);
  });

  it("a fragment the narrator answers aloud ('go ahead, I'm listening') stays part of the request said next", async () => {
    const t = client();
    t.turn("in1", "and block out Friday from two to");
    t.s.event({ type: "response.output_audio_transcript.delta", response_id: "r_in1", item_id: "a1", delta: "Go ahead, I'm listening." });
    t.s.event({ type: "response.output_audio.delta", response_id: "r_in1", item_id: "a1", delta: "AAAA" });
    t.done("in1");
    await run(0);
    t.turn("in2", "four for the quarterly review.");
    t.call("in2", "Block out Friday from two to four for the quarterly review.");
    await run(0);
    expect(t.sent).toEqual([{ text: "Block out Friday from two to four for the quarterly review.", heard: ["and block out Friday from two to", "four for the quarterly review."] }]);
  });

  it("a fragment and then quiet: it goes out after CONTINUE_MS", async () => {
    const t = client();
    t.turn("in1", "Look up the weather for");
    t.call("in1", "Look up the weather");
    await run(CONTINUE_MS - 100);
    expect(t.sent).toEqual([]);
    await run(200);
    expect(t.sent.map((x) => x.text)).toEqual(["Look up the weather"]);
  });

  it("a turn that ends like a sentence goes out at once (no wait)", async () => {
    const t = client();
    t.turn("in1", "What's on this page?");
    t.call("in1", "What's on this page?");
    await run(0);
    expect(t.sent.map((x) => x.text)).toEqual(["What's on this page?"]);
  });

  it("never lost: the turn it waited on asks nothing (the narrator stayed silent), so the held request goes out, as said", async () => {
    const t = client();
    t.turn("in1", "Book a table for two at");
    t.call("in1", "Book a table for two");
    await run(300);
    t.turn("in2", "the Italian place on Main Street at eight.");
    await run(0);
    // The narrator makes no call for it.
    t.done("in2");
    await run(0);
    expect(t.sent).toEqual([{ text: "Book a table for two at the Italian place on Main Street at eight.", heard: ["Book a table for two at", "the Italian place on Main Street at eight."] }]);
  });

  it("never lost: what seemed the user going on was noise, so the held request goes out", async () => {
    const t = client();
    t.turn("in1", "Remind me to call mom");
    t.call("in1", "Remind me to call mom");
    await run(300);
    t.turn("in2", "");
    await run(0);
    expect(t.sent.map((x) => x.text)).toEqual(["Remind me to call mom"]);
  });

  it("a chain of fragments the narrator waits through: held until the user finishes, then sent once with all of it", async () => {
    const t = client();
    t.turn("in1", "So for next week I need you to");
    t.call("in1", "So for next week I need you to");
    await run(300);
    t.turn("in2", "move my dentist appointment to");
    await run(0);
    t.done("in2");
    await run(300);
    t.turn("in3", "Thursday afternoon.");
    await run(0);
    expect(t.sent).toEqual([]);
    t.done("in3");
    await run(0);
    expect(t.sent).toEqual([{ text: "So for next week I need you to move my dentist appointment to Thursday afternoon.", heard: ["So for next week I need you to", "move my dentist appointment to", "Thursday afternoon."] }]);
  });
});
