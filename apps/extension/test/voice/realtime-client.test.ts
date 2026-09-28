import { describe, expect, it, vi } from "vitest";
import { DEFAULT_REALTIME_VOICE, REALTIME_CLOSE, REALTIME_PROTOCOL, REALTIME_TOKEN_PROTOCOL_PREFIX } from "@noa/shared";
import { base64ToBytes } from "../../src/base64.js";
import { errorHelp } from "../../src/sidepanel/error-help.js";
import {
  ackResponse,
  ACKNOWLEDGE_INSTRUCTIONS,
  NARRATOR_TOOLS,
  REALTIME_SAMPLE_RATE,
  RealtimeClient,
  realtimeFailure,
  realtimeUrl,
  takeoverUrl,
  TRANSCRIPTION_PROMPT,
  type RealtimeHandlers,
  type RealtimeSocketLike,
} from "../../src/voice/realtime-client.js";

/** A WebSocket the test drives: what the client sent, and the server's side. */
class FakeSocket implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  // The server's side.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  types(): string[] {
    return this.sent.map((e) => String(e.type));
  }
}

function setup(handlers: RealtimeHandlers = {}, languages?: string[]) {
  let socket!: FakeSocket;
  const client = new RealtimeClient({
    url: "wss://api.example.com/v1/ai/realtime",
    token: "tok123",
    instructions: "Be brief.",
    open: (url, protocols) => (socket = new FakeSocket(url, protocols)),
    handlers,
    ...(languages ? { languages } : {}),
  });
  client.connect();
  return { client, socket: () => socket };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("realtimeUrl", () => {
  it("is the account server's REALTIME_PATH over wss (ws for a local http server)", () => {
    expect(realtimeUrl("https://app.noa.bot")).toBe("wss://app.noa.bot/v1/ai/realtime");
    expect(realtimeUrl("http://127.0.0.1:8787/", "s-1")).toBe("ws://127.0.0.1:8787/v1/ai/realtime?session=s-1");
  });
});

/** The user said `words` in a turn of their own (its reply done): a later tool call is theirs to make. */
function userSaid(s: { event(e: Record<string, unknown>): void }, words: string, id = "said1"): void {
  s.event({ type: "input_audio_buffer.committed", item_id: id });
  s.event({ type: "response.created", response: { id: `r_${id}` } });
  s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
  s.event({ type: "response.done", response: { id: `r_${id}`, status: "completed" } });
}

describe("RealtimeClient: connecting", () => {
  it("offers the noa subprotocol with the session token, then configures the narrator", () => {
    const { socket } = setup();
    expect(socket().protocols).toEqual([REALTIME_PROTOCOL, `${REALTIME_TOKEN_PROTOCOL_PREFIX}tok123`]);
    socket().open();
    const [update] = socket().sent as [{ type: string; session: Record<string, any> }];
    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("realtime");
    expect(update.session.instructions).toBe("Be brief.");
    expect(update.session.model).toBeUndefined(); // the server picks the model
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcm", rate: REALTIME_SAMPLE_RATE });
    expect(update.session.audio.output.format).toEqual({ type: "audio/pcm", rate: REALTIME_SAMPLE_RATE });
    expect(update.session.audio.input.turn_detection).toMatchObject({ type: "server_vad", create_response: true, interrupt_response: false });
    // The user's own words for the chat (the server's price includes them).
    expect(update.session.audio.input.transcription).toEqual({ model: "gpt-transcribe", prompt: TRANSCRIPTION_PROMPT });
    expect(update.session.tools.map((t: { name: string }) => t.name)).toEqual(["send_to_agent", "cancel_request", "stop_task", "answer_approval", "use_this_tab", "end_voice"]);
    expect(update.session.tools.every((t: { type: string }) => t.type === "function")).toBe(true);
    expect(NARRATOR_TOOLS).toHaveLength(6);
  });

  it("tells the transcription the languages the user speaks (gpt-transcribe's `languages`, ISO 639-1)", () => {
    const { socket } = setup({}, ["en", "ko"]);
    socket().open();
    const [update] = socket().sent as [{ session: Record<string, any> }];
    expect(update.session.audio.input.transcription).toEqual({ model: "gpt-transcribe", languages: ["en", "ko"], prompt: TRANSCRIPTION_PROMPT });
  });

  it("speaks in the default voice at normal speed, or the voice and speed from Settings (kept in OpenAI's range)", () => {
    const { socket } = setup();
    socket().open();
    expect((socket().sent[0] as { session: Record<string, any> }).session.audio.output).toMatchObject({ voice: DEFAULT_REALTIME_VOICE, speed: 1 });
    for (const [speed, sent] of [[1.2, 1.2], [9, 1.5], [0.1, 0.25]] as const) {
      let s!: FakeSocket;
      new RealtimeClient({ url: "wss://x/v1/ai/realtime", token: "t", voice: "cedar", speed, open: (u, p) => (s = new FakeSocket(u, p)), handlers: {} }).connect();
      s.open();
      expect((s.sent[0] as { session: Record<string, any> }).session.audio.output).toMatchObject({ voice: "cedar", speed: sent });
    }
  });

  it("is ready on OpenAI's first event (session.created), once, and streams microphone PCM16 as base64 input_audio_buffer.append", () => {
    const onReady = vi.fn();
    const { client, socket } = setup({ onReady });
    socket().open();
    socket().event({ type: "session.created", session: { type: "realtime", model: "gpt-realtime-2.1" } });
    socket().event({ type: "session.updated", session: {} });
    expect(onReady).toHaveBeenCalledTimes(1);
    client.appendAudio(new Int16Array([1, -1, 256]));
    const append = socket().sent.at(-1)!;
    expect(append.type).toBe("input_audio_buffer.append");
    expect([...base64ToBytes(String(append.audio))]).toEqual([1, 0, 0xff, 0xff, 0, 1]);
  });

  it("sends nothing before the socket is open", () => {
    const { client, socket } = setup();
    client.appendAudio(new Int16Array([1]));
    client.note("Your update: x", "result");
    expect(socket().sent).toEqual([]);
  });
});

describe("RealtimeClient: the feed, the narrator's replies and its tools", () => {
  const ready = (handlers: RealtimeHandlers = {}) => {
    const s = setup(handlers);
    s.socket().open();
    s.socket().sent.length = 0;
    return s;
  };

  it("a note is a system message item; a line to say asks for a reply, and news waits for the reply being made", () => {
    const { client, socket } = ready();
    client.note("Your update (progress): Opening x.com.", "milestone");
    expect(socket().sent).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "Your update (progress): Opening x.com." }] } },
      { type: "response.create" },
    ]);
    socket().event({ type: "response.created", response: { id: "r1" } });
    client.note("Your update (finished): Posted.", "result");
    client.note("Your update (problem): more", "error");
    expect(socket().types()).toEqual(["conversation.item.create", "response.create", "conversation.item.create", "conversation.item.create"]);
    // One reply for both, once the current one is done.
    socket().event({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    expect(socket().types().at(-1)).toBe("response.create");
    expect(socket().types().filter((t) => t === "response.create")).toHaveLength(2);
  });

  it("the user starting to talk drops a reply we were about to ask for (their turn gets one anyway)", () => {
    const onUserSpeech = vi.fn();
    const { client, socket } = ready({ onUserSpeech });
    socket().event({ type: "response.created", response: { id: "r1" } });
    client.note("Your update: x", "result");
    socket().event({ type: "input_audio_buffer.speech_started", audio_start_ms: 100, item_id: "u1" });
    expect(onUserSpeech).toHaveBeenCalledTimes(1);
    socket().event({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
    expect(socket().types().filter((t) => t === "response.create")).toHaveLength(0);
  });

  it("passes the narrator's audio and its words on", () => {
    const onAudio = vi.fn();
    const onNarratorText = vi.fn();
    const { socket } = ready({ onAudio, onNarratorText });
    socket().event({ type: "response.output_audio.delta", delta: "AAEC", item_id: "a1", response_id: "r1", content_index: 0 });
    socket().event({ type: "response.output_audio_transcript.delta", delta: "On ", item_id: "a1" });
    socket().event({ type: "response.output_audio_transcript.delta", delta: "it.", item_id: "a1" });
    expect(onAudio).toHaveBeenCalledWith("AAEC", "a1");
    expect(onNarratorText.mock.calls.map((c) => c[0])).toEqual(["On ", "On it."]);
  });

  it("send_to_agent runs through onTool (with the user's input item it answers), its output goes back, then one short acknowledgement", async () => {
    const onTool = vi.fn(async () => "Started.");
    const { socket } = ready({ onTool });
    socket().event({ type: "input_audio_buffer.committed", item_id: "in1", previous_item_id: null });
    socket().event({ type: "response.created", response: { id: "r1" } });
    socket().event({ type: "conversation.item.input_audio_transcription.completed", item_id: "in1", transcript: "post gm on x" });
    socket().event({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_to_agent", arguments: '{"text":"Post gm on X"}', item_id: "f1" });
    await flush();
    expect(onTool).toHaveBeenCalledWith("send_to_agent", { text: "Post gm on X" }, "in1", ["post gm on x"]);
    expect(socket().sent.at(-1)).toEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: "Started." } });
    socket().event({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    expect(socket().sent.at(-1)).toEqual({ type: "response.create", response: ackResponse("Post gm on X") });
  });

  it("other tools ask for a plain reply after their output (the narrator says what happened)", async () => {
    const { socket } = ready({ onTool: async () => "Stopped the task." });
    userSaid(socket(), "stop the task");
    socket().event({ type: "response.function_call_arguments.done", call_id: "c1", name: "stop_task", arguments: "{}" });
    await flush();
    expect(socket().sent.at(-1)).toEqual({ type: "response.create" });
  });

  it("a tool that throws answers with its error; unknown tools and bad arguments are answered, not run", async () => {
    const onTool = vi.fn(async () => {
      throw new Error("No chat to stop");
    });
    const { socket } = ready({ onTool });
    userSaid(socket(), "stop the task");
    socket().event({ type: "response.function_call_arguments.done", call_id: "c1", name: "stop_task", arguments: "{}" });
    socket().event({ type: "response.function_call_arguments.done", call_id: "c2", name: "rm_rf", arguments: "{}" });
    socket().event({ type: "response.function_call_arguments.done", call_id: "c3", name: "send_to_agent", arguments: "{not json" });
    await flush();
    const outputs = socket().sent.filter((e) => e.type === "conversation.item.create").map((e) => e.item as { call_id: string; output: string })
      .sort((a, b) => a.call_id.localeCompare(b.call_id));
    expect(outputs).toEqual([
      { type: "function_call_output", call_id: "c1", output: "Error: No chat to stop" },
      { type: "function_call_output", call_id: "c2", output: "Error: unknown tool rm_rf" },
      { type: "function_call_output", call_id: "c3", output: "Error: the arguments are not valid JSON" },
    ]);
    expect(onTool).toHaveBeenCalledTimes(1);
  });

  it("cancelling (the user's Esc, the shortcut) stops the reply being made; truncate says how much was heard", () => {
    const { client, socket } = ready();
    client.cancelResponse();
    expect(socket().sent).toEqual([]); // nothing to cancel
    socket().event({ type: "response.created", response: { id: "r1" } });
    client.cancelResponse();
    client.truncate("a1", 1234.6);
    expect(socket().sent).toEqual([{ type: "response.cancel" }, { type: "conversation.item.truncate", item_id: "a1", content_index: 0, audio_end_ms: 1235 }]);
  });
});

describe("RealtimeClient: how a session ends", () => {
  it("closing it ourselves ends without a failure", () => {
    const onClose = vi.fn();
    const { client, socket } = setup({ onClose });
    socket().open();
    client.close();
    expect(socket().closed?.code).toBe(1000);
    socket().serverClose(1000);
    expect(onClose).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the server's noa.error names the failure the close then reports", () => {
    const onClose = vi.fn();
    const { socket } = setup({ onClose });
    socket().open();
    socket().event({ type: "noa.error", error: "session_open", message: "Another realtime session is open" });
    socket().serverClose(REALTIME_CLOSE.concurrent, "session_open");
    expect(onClose.mock.calls[0]![0]).toMatchObject({ kind: "busy", transient: true });
  });

  it("taken over by a new session of the user (session_replaced): it ends for good, saying where voice went", () => {
    const onClose = vi.fn();
    const { socket } = setup({ onClose });
    socket().open();
    socket().event({ type: "noa.error", error: "session_replaced", message: "Voice was turned on in another window, so it stopped here." });
    socket().serverClose(REALTIME_CLOSE.concurrent, "taken over");
    expect(onClose.mock.calls[0]![0]).toEqual({ kind: "replaced", transient: false, message: "Voice was turned on in another window, so it stopped here." });
  });

  it("a 'denied' event is only logged (the session goes on); OpenAI's own error events too", () => {
    const log = vi.fn();
    const onClose = vi.fn();
    const { socket } = setup({ log, onClose });
    socket().open();
    socket().event({ type: "noa.error", error: "denied", message: "session.tracing is not allowed" });
    socket().event({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "bad voice" } });
    expect(onClose).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[0])).toEqual(["realtime denied: session.tracing is not allowed", "realtime error: invalid_value: bad voice"]);
  });

  it("a socket that never opened (no relay, no network) is a transient failure: the panel tries again, never another engine", () => {
    const onClose = vi.fn();
    const { socket } = setup({ onClose });
    socket().onerror?.({});
    socket().serverClose(1006);
    expect(onClose.mock.calls[0]![0]).toEqual({ kind: "network", transient: true, message: "Voice disconnected." });
  });
});

describe("realtimeFailure: close codes and server errors -> what the panel says and offers", () => {
  const fixes = (code: number) => errorHelp(realtimeFailure({ closeCode: code, opened: true }).message).fixes.map((f) => f.kind);

  it("auth, credit and plan end the session with the error card's fix (Log in, Top up, Choose a plan)", () => {
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.auth, opened: true })).toMatchObject({ kind: "auth", transient: false });
    expect(fixes(REALTIME_CLOSE.auth)).toEqual(["login"]);
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.credit, opened: true })).toMatchObject({ kind: "credit", transient: false });
    expect(fixes(REALTIME_CLOSE.credit)).toContain("topup");
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.plan, opened: true })).toMatchObject({ kind: "plan", transient: false });
    expect(fixes(REALTIME_CLOSE.plan)).toEqual(["plans"]);
  });

  it("upstream and protocol trouble, and another session still open, may pass (tried again); none names another engine", () => {
    for (const code of [REALTIME_CLOSE.concurrent, REALTIME_CLOSE.upstream, REALTIME_CLOSE.tooBig, 1006, 1011]) {
      const f = realtimeFailure({ closeCode: code, opened: true });
      expect(f.transient, `close ${code}`).toBe(true);
      expect(f.message).not.toMatch(/Standard/);
    }
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.upstream, opened: true }).message).toBe("Voice disconnected.");
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.concurrent, opened: true }).message).toBe("Realtime voice is on in another window or on another device.");
    // Realtime not set up on the server does not pass by trying again.
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.unavailable, opened: false })).toMatchObject({ kind: "unavailable", transient: false });
  });

  it("idle and the session limit end quietly with a note, without switching engines", () => {
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.idle, opened: true })).toMatchObject({ kind: "idle", transient: false });
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.sessionLimit, opened: true })).toMatchObject({ kind: "limit", transient: false });
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.sessionLimit, opened: true }).message).toBe("Hands-free stopped: a Realtime session lasts up to 30 minutes.");
  });

  it("the server's error code wins over the close code; an unknown close is a dropped connection", () => {
    expect(realtimeFailure({ closeCode: 1011, error: "out_of_credit", opened: true }).kind).toBe("credit");
    expect(realtimeFailure({ closeCode: 1011, opened: true })).toMatchObject({ kind: "upstream", transient: true });
    expect(realtimeFailure({ closeCode: 1006, opened: false })).toMatchObject({ kind: "network", transient: true });
  });

  it("takeoverUrl asks the relay to end the user's open session and take its place", () => {
    expect(takeoverUrl("wss://api.test/v1/ai/realtime?session=s1")).toBe("wss://api.test/v1/ai/realtime?session=s1&takeover=1");
  });
});

describe("RealtimeClient: timing trace", () => {
  it("connecting, each reply from the end of speech (commit, start, first audio, done, usage), and the user's words", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const traces: { name: string; t: number; ms?: number; data?: Record<string, unknown>; inputId: string | null }[] = [];
      const { socket } = setup({ onTrace: (e, inputId) => traces.push({ name: e.name, t: e.t, ms: e.ms, data: e.data, inputId }) });
      vi.advanceTimersByTime(120);
      socket().open();
      vi.advanceTimersByTime(300);
      socket().event({ type: "session.created", session: { model: "gpt-realtime" } });
      vi.advanceTimersByTime(2000);
      socket().event({ type: "input_audio_buffer.speech_stopped" });
      vi.advanceTimersByTime(80);
      socket().event({ type: "input_audio_buffer.committed", item_id: "item_1" });
      vi.advanceTimersByTime(40);
      socket().event({ type: "response.created" });
      vi.advanceTimersByTime(500);
      socket().event({ type: "response.output_audio.delta", delta: "AAAA", item_id: "a1" });
      socket().event({ type: "response.output_audio.delta", delta: "AAAA", item_id: "a1" });
      vi.advanceTimersByTime(200);
      socket().event({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: " check my email ", usage: { input_tokens: 40, output_tokens: 5 } });
      vi.advanceTimersByTime(900);
      socket().event({ type: "response.done", response: { status: "completed", usage: { input_tokens: 900, output_tokens: 120, input_token_details: { audio_tokens: 300, cached_tokens: 512 }, output_token_details: { audio_tokens: 100 } } } });
      await vi.runAllTimersAsync();

      expect(traces.map((x) => x.name)).toEqual(["voice.connect", "voice.user_words", "voice.narrator"]);
      expect(traces[0]).toMatchObject({ t: 1_000_000, ms: 420, data: { openMs: 120, readyMs: 300, model: "gpt-realtime" }, inputId: null });
      expect(traces[1]).toMatchObject({ t: 1_002_500, ms: 740, data: { chars: 14, inTokens: 40, outTokens: 5 }, inputId: "item_1" });
      expect(traces[2]).toMatchObject({
        t: 1_002_420,
        ms: 1720,
        inputId: "item_1",
        data: { trigger: "speech", commitMs: 80, createdMs: 120, firstAudioMs: 620, waitMs: 620, audioDeltas: 2, status: "completed", inTokens: 900, outTokens: 120, inAudioTokens: 300, cachedTokens: 512, outAudioTokens: 100 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reply we asked for is timed from asking", async () => {
    vi.useFakeTimers({ now: 5_000 });
    try {
      const traces: { name: string; t: number; data?: Record<string, unknown> }[] = [];
      const { client, socket } = setup({ onTrace: (e) => traces.push(e) });
      socket().open();
      socket().event({ type: "session.updated" });
      client.note("The agent finished.", "result");
      vi.advanceTimersByTime(700);
      socket().event({ type: "response.created" });
      socket().event({ type: "response.done", response: {} });
      expect(traces.at(-1)).toMatchObject({ name: "voice.narrator", t: 5_000, data: { trigger: "update", createdMs: 700, firstAudioMs: null, waitMs: 700 } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RealtimeClient: muted", () => {
  const ready = () => {
    const t = setup();
    t.socket().open();
    t.socket().event({ type: "session.created", session: { type: "realtime" } });
    t.socket().sent.length = 0;
    return t;
  };

  it("sends no microphone audio while muted, and clears what the server holds of an unfinished turn", () => {
    const { client, socket } = ready();
    client.appendAudio(new Int16Array([1]));
    client.setMuted(true);
    client.appendAudio(new Int16Array([2]));
    client.appendAudio(new Int16Array([3]));
    const types = socket().types();
    expect(types.filter((t) => t === "input_audio_buffer.append")).toHaveLength(1);
    // Cleared right after the last audio sent, so half an utterance is never committed on unmute.
    expect(types.slice(0, 2)).toEqual(["input_audio_buffer.append", "input_audio_buffer.clear"]);
    // The narrator is told it cannot hear the user (it goes on with updates); no reply is asked for.
    const note = socket().sent.find((e) => e.type === "conversation.item.create") as { item: { role: string; content: { text: string }[] } };
    expect(note.item.role).toBe("system");
    expect(note.item.content[0]!.text).toMatch(/muted/i);
    expect(types).not.toContain("response.create");
    client.setMuted(true);
    expect(socket().types()).toEqual(types);
  });

  it("unmuted, audio goes out again and the narrator is told it can hear the user", () => {
    const { client, socket } = ready();
    client.setMuted(true);
    socket().sent.length = 0;
    client.setMuted(false);
    client.appendAudio(new Int16Array([4]));
    expect(socket().types()).toEqual(["conversation.item.create", "input_audio_buffer.append"]);
    expect((socket().sent[0] as { item: { content: { text: string }[] } }).item.content[0]!.text).toMatch(/unmuted/i);
    expect(socket().types()).not.toContain("input_audio_buffer.clear");
  });

  it("muting mid-turn: the user no longer counts as speaking, so a waiting update may be said", () => {
    const { client, socket } = ready();
    socket().event({ type: "input_audio_buffer.speech_started", item_id: "in1", audio_start_ms: 0 });
    client.note("Agent result: done.", "result");
    expect(socket().types()).not.toContain("response.create");
    client.setMuted(true);
    client.note("Agent result: done again.", "result");
    expect(socket().types()).toContain("response.create");
  });
});
