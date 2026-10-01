/**
 * Who the narrator is listening to, from the owner's real traces (2026-09-27):
 * - "Yo sup how you doin" transcribed as "有，......。": the words were taken for a request and the small talk went
 *   to the agent. Unclear words never make a turn a request; the narrator's own reading counts.
 * - Other people talking Chinese in the room while the user speaks English: not for the assistant (no reply, no
 *   request, nothing kept), unless the user speaks that language.
 * - The narrator sent the agent its own result line ("Tell the user the result: Done. Mecha Royale, ...") on a turn
 *   of that background speech: refused, whatever the turn.
 * - A stray "Hey." while the agent worked got a 6.35 s reply: small talk then is made again, capped.
 */
import { describe, expect, it } from "vitest";
import {
  NOT_A_REQUEST_OUTPUT,
  RealtimeClient,
  TRANSCRIPTION_PROMPT,
  WORKING_SMALL_TALK_RESPONSE,
  type RealtimeHandlers,
  type RealtimeSocketLike,
  SENT_OUTPUT,
} from "../../src/voice/realtime-client.js";
import { echoesUpdate } from "../../src/voice/narrator-policy.js";

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

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A client for a user who speaks English (the browser's languages), with what reaches the panel. */
function client(languages = ["en"]) {
  let socket!: FakeSocket;
  const tools: [string, Record<string, unknown>, string | null, string[]][] = [];
  const audio: string[] = [];
  const heard: string[][] = [];
  const traces: string[] = [];
  const handlers: RealtimeHandlers = {
    onTool: (name, args, inputId, words) => (tools.push([name, args, inputId, words]), SENT_OUTPUT),
    onAudio: (b64) => void audio.push(b64),
    onHeard: (w) => void heard.push(w),
    onTrace: (e) => void traces.push(e.name),
  };
  const c = new RealtimeClient({ url: "wss://x/v1/ai/realtime", token: "t", languages, open: () => (socket = new FakeSocket()), handlers });
  c.connect();
  socket.open();
  const s = socket;
  return {
    c,
    s,
    tools,
    audio,
    heard,
    traces,
    /** The user's turn `id`: speech, committed, and the reply the server starts for it. */
    turn(id: string) {
      s.event({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 });
      s.event({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 3_000 });
      s.event({ type: "input_audio_buffer.committed", item_id: id });
      s.event({ type: "response.created", response: { id: `r_${id}` } });
    },
    words: (id: string, transcript: string) => s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript }),
    speaks: (id: string, text: string) => {
      s.event({ type: "response.output_audio_transcript.delta", response_id: `r_${id}`, delta: text });
      s.event({ type: "response.output_audio.delta", response_id: `r_${id}`, item_id: `a_${id}`, delta: "AAAA" });
    },
    calls: (id: string, text: string) => {
      s.event({ type: "response.output_item.added", item: { type: "function_call", name: "send_to_agent" } });
      s.event({ type: "response.function_call_arguments.done", call_id: `c_${id}`, name: "send_to_agent", arguments: JSON.stringify({ text }) });
    },
    done: (id: string) => s.event({ type: "response.done", response: { id: `r_${id}`, status: "completed" } }),
    creates: () => s.sent.filter((e) => e.type === "response.create"),
    outputs: () => s.sent.filter((e) => e.item?.type === "function_call_output").map((e) => e.item.output as string),
  };
}

describe("the transcription is told the user's languages", () => {
  it("gpt-transcribe's languages hint and the recording's context", () => {
    const t = client(["en", "ko"]);
    expect(t.s.sent[0]!.session.audio.input.transcription).toEqual({ model: "gpt-transcribe", languages: ["en", "ko"], prompt: TRANSCRIPTION_PROMPT });
  });
});

describe("unclear words ('Yo sup how you doin' as '有，......。')", () => {
  it("do not make the turn a request: the narrator's small-talk reply is heard, nothing is made again, nothing goes to the agent", async () => {
    const t = client();
    t.turn("in1");
    t.speaks("in1", "Hey! Not much. What can I do for you?");
    t.words("in1", "有，......。");
    t.done("in1");
    await flush();
    expect(t.audio).toEqual(["AAAA"]);
    expect(t.creates()).toEqual([]);
    expect(t.tools).toEqual([]);
    expect(t.traces).toContain("voice.unclear");
    // Kept for the record only (the chat shows none of it).
    expect(t.heard).toEqual([["有，......。"]]);
  });

  it("a request the narrator understood anyway goes out as it understood it, the transcript kept word for word", async () => {
    const t = client();
    t.turn("in1");
    t.words("in1", "有，......。");
    t.calls("in1", "Check my Chrome Web Store emails");
    await flush();
    expect(t.tools).toEqual([["send_to_agent", { text: "Check my Chrome Web Store emails" }, "in1", ["有，......。"]]]);
  });
});

describe("other people talking nearby in another language", () => {
  it("no reply is heard, no request goes out, nothing is kept", async () => {
    const t = client();
    t.turn("bg1");
    t.speaks("bg1", "你好！有什么可以帮你的吗？");
    t.words("bg1", "你不是手上进不来，上面都是锁了。那那个钥匙呢？");
    t.calls("bg1", "Find the key");
    t.done("bg1");
    await flush();
    expect(t.audio).toEqual([]);
    expect(t.s.sent.filter((e) => e.type === "response.cancel").length).toBeGreaterThan(0);
    expect(t.tools).toEqual([]);
    expect(t.outputs()).toEqual([NOT_A_REQUEST_OUTPUT.not_user]);
    expect(t.heard).toEqual([]);
    expect(t.traces).toContain("voice.not_addressed");
    expect(t.traces).toContain("voice.refused_forward");
  });

  it("no tool runs for it either (ending voice, stopping the task, moving tabs)", async () => {
    const t = client();
    t.turn("bg2");
    t.words("bg2", "请你做饭了。");
    for (const name of ["end_voice", "stop_task", "use_this_tab"]) t.s.event({ type: "response.function_call_arguments.done", call_id: `c_${name}`, name, arguments: "{}" });
    await flush();
    expect(t.tools).toEqual([]);
    expect(t.outputs()).toEqual([NOT_A_REQUEST_OUTPUT.not_user, NOT_A_REQUEST_OUTPUT.not_user, NOT_A_REQUEST_OUTPUT.not_user]);
  });

  it("the user's own language is theirs: a Chinese speaker's request goes out", async () => {
    const t = client(["en", "zh"]);
    t.turn("in1");
    t.words("in1", "请帮我查一下邮件。");
    t.calls("in1", "Check my email");
    await flush();
    expect(t.tools.map((x) => x[1])).toEqual([{ text: "Check my email" }]);
  });
});

describe("the narrator passing on its own update (the owner's trace, turn 5)", () => {
  const RESULT =
    'Your update (finished): The task is done. Tell the user in one to three short sentences, in the first person: "Done. Mecha Royale, Rooftop, Bounty and ARRR will each post three times a day."';
  const ECHO = "Tell the user the result: Done. Mecha Royale, Rooftop, Bounty and ARRR will each post three times a day.";

  it("on a turn of background speech: refused, the narrator told it was an update, nothing acknowledged", async () => {
    const t = client();
    t.c.setStatus(RESULT);
    t.turn("bg5");
    t.words("bg5", "我这胖，我的刚刚刚。");
    t.calls("bg5", ECHO);
    t.done("bg5");
    await flush();
    expect(t.tools).toEqual([]);
    expect(t.outputs()).toHaveLength(1);
    expect(t.creates()).toEqual([]);
  });

  it("on a reply to the update itself, or on a clear turn of the user's: refused as an update (without its wording too)", async () => {
    const t = client();
    t.c.say("result", RESULT);
    t.s.event({ type: "response.created", response: { id: "ours" } });
    t.calls("ours", ECHO);
    await flush();
    t.turn("in2");
    t.words("in2", "okay, what now?");
    t.calls("in2", "Done. Mecha Royale, Rooftop, Bounty and ARRR will each post three times a day.");
    await flush();
    expect(t.tools).toEqual([]);
    expect(t.outputs()).toEqual([NOT_A_REQUEST_OUTPUT.echo, NOT_A_REQUEST_OUTPUT.echo]);
  });

  it("the user's answer made of the update's words is theirs ('post it' to 'Should I post it?')", async () => {
    const t = client();
    t.c.say("question", "Should I post it?");
    t.turn("in1");
    t.words("in1", "yes, post it");
    t.calls("in1", "Yes, post it");
    await flush();
    expect(t.tools.map((x) => x[1])).toEqual([{ text: "Yes, post it" }]);
  });

  it("echoesUpdate: the feed's wording, or mostly an update's words and not the user's", () => {
    expect(echoesUpdate(ECHO, [], null)).toBe(true);
    expect(echoesUpdate("Agent update: done", [], "anything")).toBe(true);
    expect(echoesUpdate("Your update (finished): done", [], "anything")).toBe(true);
    // The user's own words that begin like it are theirs.
    expect(echoesUpdate("your update was wrong, post it again", [], "your update was wrong, post it again")).toBe(false);
    expect(echoesUpdate("Mecha Royale, Rooftop, Bounty and ARRR will each post three times a day", [RESULT], null)).toBe(true);
    expect(echoesUpdate("Mecha Royale, Rooftop, Bounty and ARRR will each post three times a day", [RESULT], "make Mecha Royale Rooftop Bounty and ARRR each post three times a day")).toBe(false);
    expect(echoesUpdate("Post gm on X", [RESULT], null)).toBe(false);
  });
});

describe("the microphone hearing the narrator (echo)", () => {
  it("its line heard back right after it said it is not the user: no reply heard, no request, nothing kept", async () => {
    const t = client();
    // The narrator says a line (a reply we asked for), heard here.
    t.s.event({ type: "response.created", response: { id: "ours" } });
    t.s.event({ type: "response.output_audio_transcript.delta", item_id: "a_ours", delta: "Opening the home timeline now." });
    t.s.event({ type: "response.output_audio.delta", item_id: "a_ours", response_id: "ours", delta: "AAAA" });
    t.s.event({ type: "response.done", response: { id: "ours", status: "completed" } });
    t.turn("echo1");
    t.words("echo1", "opening the home timeline");
    t.calls("echo1", "Open the home timeline");
    t.done("echo1");
    await flush();
    expect(t.tools).toEqual([]);
    expect(t.outputs()).toEqual([NOT_A_REQUEST_OUTPUT.not_user]);
    expect(t.heard).toEqual([]);
    expect(t.traces).toContain("voice.echo");
  });

  it("the parts of one reply are sentences apart (a real trace ran them together: 'exciting!I need')", () => {
    const shown: string[] = [];
    let socket!: FakeSocket;
    const c = new RealtimeClient({ url: "wss://x", token: "t", open: () => (socket = new FakeSocket()), handlers: { onNarratorText: (x) => void shown.push(x) } });
    c.connect();
    socket.open();
    socket.event({ type: "response.created", response: { id: "r" } });
    socket.event({ type: "response.output_audio_transcript.delta", item_id: "i1", delta: "Got it, exciting!" });
    socket.event({ type: "response.output_audio_transcript.delta", item_id: "i2", delta: "Stopped." });
    expect(shown.at(-1)).toBe("Got it, exciting! Stopped.");
  });
});

describe("small talk while the agent works", () => {
  it("a stray 'Hey.' gets a few words: the long reply is never heard, it is made again capped", async () => {
    const t = client();
    t.c.setAgentWorking(true);
    t.turn("in1");
    t.words("in1", "Hey.");
    t.speaks("in1", "Hey! I'm here. If you want, you can tell me what else you'd like while the agent works.");
    expect(t.audio).toEqual([]);
    t.done("in1");
    expect(t.creates()).toEqual([{ type: "response.create", response: WORKING_SMALL_TALK_RESPONSE }]);
    expect(WORKING_SMALL_TALK_RESPONSE).toMatchObject({ tool_choice: "none", max_output_tokens: 80 });
    // The short reply is heard.
    t.s.event({ type: "response.created", response: { id: "short" } });
    t.s.event({ type: "response.output_audio.delta", response_id: "short", item_id: "a_short", delta: "BBBB" });
    t.s.event({ type: "response.done", response: { id: "short", status: "completed" } });
    await flush();
    expect(t.audio).toEqual(["BBBB"]);
    expect(t.tools).toEqual([]);
  });

  it("with the agent idle, small talk is answered as it was", () => {
    const t = client();
    t.turn("in1");
    t.words("in1", "Hey.");
    t.speaks("in1", "Hey! What can I do for you?");
    t.done("in1");
    expect(t.audio).toEqual(["AAAA"]);
    expect(t.creates()).toEqual([]);
  });

  it("the narrator is told to ignore speech not addressed to it", () => {
    const t = client();
    expect(t.s.sent[0]!.session.instructions).toContain("Speech that is not addressed to you, or is in another language than the user's, is not for you");
  });
});
