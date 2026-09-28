/**
 * A Realtime hands-free turn, end to end in the extension: the narrator's send_to_agent reaches the chat at once
 * (no sending window, nothing written into the box), the narrator acknowledges at most once, the user's own words
 * (the input transcription) are kept with the request sent for them whatever order they arrive in, and stopping
 * while the engine starts leaves nothing open.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, VoiceEngineId, VoiceEnginesResponse } from "@noa/shared";
import { initHandsFree, RECONNECT_DELAYS_MS, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import type { VoiceTip } from "../../src/sidepanel/voice-input.js";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents, HandsFreeEngine } from "../../src/voice/engine.js";
import { HANDS_FREE } from "../../src/voice/hands-free.js";
import {
  ackResponse,
  ACKNOWLEDGE_INSTRUCTIONS,
  NARRATOR_INSTRUCTIONS,
  NOT_A_REQUEST_OUTPUT,
  RealtimeClient,
  TRANSCRIPTION_PROMPT,
  type RealtimeHandlers,
  type RealtimeSocketLike,
} from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import { installMiniDom, MiniElement } from "../ui/mini-dom.js";

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
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason: "" }));
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  replies(): Record<string, any>[] {
    return this.sent.filter((e) => e.type === "response.create");
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The server's side of one user turn: their audio committed (item `input`), then the reply to it begins. */
function userTurn(socket: FakeSocket, input: string, reply: string): void {
  socket.event({ type: "input_audio_buffer.speech_started", item_id: input });
  socket.event({ type: "input_audio_buffer.speech_stopped", item_id: input });
  socket.event({ type: "input_audio_buffer.committed", item_id: input, previous_item_id: null });
  socket.event({ type: "response.created", response: { id: reply } });
}

const callSend = (socket: FakeSocket, text: string, callId = "c1") =>
  socket.event({ type: "response.function_call_arguments.done", call_id: callId, name: "send_to_agent", arguments: JSON.stringify({ text }) });
const transcribed = (socket: FakeSocket, input: string, transcript: string) =>
  socket.event({ type: "conversation.item.input_audio_transcription.completed", item_id: input, content_index: 0, transcript });
const replyDone = (socket: FakeSocket, reply: string) => socket.event({ type: "response.done", response: { id: reply, status: "completed", output: [] } });

describe("the narrator: tool first, at most one acknowledgement", () => {
  function client(handlers: RealtimeHandlers = {}) {
    let socket!: FakeSocket;
    const c = new RealtimeClient({ url: "wss://x/v1/ai/realtime", token: "t", open: () => (socket = new FakeSocket()), handlers });
    c.connect();
    socket.open();
    return { c, socket };
  }

  it("is told to call send_to_agent before saying anything, and to acknowledge at most once after", () => {
    expect(NARRATOR_INSTRUCTIONS).toContain("When the user asks for something, call send_to_agent immediately, before saying anything, with kind 'question'");
    expect(NARRATOR_INSTRUCTIONS).toContain("Never say yourself what you will do or when.");
    const { socket } = client();
    expect(socket.sent[0]!.session.audio.input.transcription).toEqual({ model: "gpt-transcribe", prompt: TRANSCRIPTION_PROMPT });
  });

  it("a reply that only called send_to_agent is followed by exactly one short acknowledgement", async () => {
    const { socket } = client({ onTool: () => "Started. Your updates on it will follow." });
    userTurn(socket, "in1", "r1");
    transcribed(socket, "in1", "open gmail");
    callSend(socket, "Open Gmail");
    await flush();
    // Still replying: nothing yet (a second reply would be refused while one is being made).
    expect(socket.replies()).toEqual([]);
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([{ type: "response.create", response: ackResponse("Open Gmail") }]);
    // The acknowledgement itself asks for nothing more.
    socket.event({ type: "response.created", response: { id: "r2" } });
    socket.event({ type: "response.output_audio.delta", item_id: "a2", delta: "AAAA" });
    replyDone(socket, "r2");
    expect(socket.replies()).toHaveLength(1);
  });

  it("the acknowledgement is out of the conversation: cut off, nothing of it is truncated (there is no such item)", async () => {
    const { c, socket } = client({ onTool: () => "Started. Your updates on it will follow." });
    userTurn(socket, "in1", "r1");
    transcribed(socket, "in1", "open gmail");
    callSend(socket, "Open Gmail");
    await flush();
    replyDone(socket, "r1");
    socket.event({ type: "response.created", response: { id: "r2" } });
    socket.event({ type: "response.output_audio.delta", item_id: "a2", delta: "AAAA" });
    c.truncate("a2", 300);
    expect(socket.sent.filter((e) => e.type === "conversation.item.truncate")).toEqual([]);
  });

  it("the tool's output arriving after its reply is done still gets one acknowledgement", async () => {
    let answer!: (s: string) => void;
    const { socket } = client({ onTool: () => new Promise<string>((r) => (answer = r)) });
    userTurn(socket, "in1", "r1");
    transcribed(socket, "in1", "open gmail");
    callSend(socket, "Open Gmail");
    replyDone(socket, "r1");
    await flush();
    answer("Started.");
    await flush();
    expect(socket.replies()).toEqual([{ type: "response.create", response: ackResponse("Open Gmail") }]);
  });

  it("a reply that already spoke gets no acknowledgement", async () => {
    const { socket } = client({ onTool: () => "Started." });
    userTurn(socket, "in1", "r1");
    socket.event({ type: "response.output_audio.delta", item_id: "a1", delta: "AAAA" });
    // Words that let its speech be heard (small talk), then it passes something on too.
    transcribed(socket, "in1", "okay");
    callSend(socket, "Open Gmail");
    await flush();
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([]);
  });

  it("an agent update asking for a reply meanwhile makes the one reply (no acknowledgement on top)", async () => {
    const { c, socket } = client({ onTool: () => "Started." });
    userTurn(socket, "in1", "r1");
    transcribed(socket, "in1", "open gmail");
    callSend(socket, "Open Gmail");
    await flush();
    c.note("Your update (problem): the page did not load.", "error");
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([{ type: "response.create" }]);
  });

  it("the user talking again drops the acknowledgement (their turn gets its own reply)", async () => {
    const { socket } = client({ onTool: () => "Started." });
    userTurn(socket, "in1", "r1");
    transcribed(socket, "in1", "open gmail");
    callSend(socket, "Open Gmail");
    await flush();
    socket.event({ type: "input_audio_buffer.speech_started", item_id: "in2" });
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([]);
  });

  it("the server never cuts a reply off for the user's voice: the client does, and never while it calls send_to_agent", async () => {
    const onTool = vi.fn(() => "Started.");
    const { socket } = client({ onTool });
    // OpenAI's own barge-in cancels the reply mid-call (measured: the arguments end cut off, as invalid JSON).
    expect(socket.sent[0]!.session.audio.input.turn_detection).toMatchObject({ type: "server_vad", create_response: true, interrupt_response: false });
    userTurn(socket, "in1", "r1");
    socket.event({ type: "response.output_item.added", response_id: "r1", item: { type: "function_call", name: "send_to_agent" } });
    // The user talks on while the call is being written: it is let finish.
    socket.event({ type: "input_audio_buffer.speech_started", item_id: "in2" });
    expect(socket.sent.filter((e) => e.type === "response.cancel")).toEqual([]);
    transcribed(socket, "in1", "open gmail");
    callSend(socket, "Open Gmail");
    await flush();
    expect(onTool).toHaveBeenCalledWith("send_to_agent", { text: "Open Gmail" }, "in1", ["open gmail"]);
    // Its output goes back, then the rest of the reply (the acknowledgement) is cancelled: the user has the floor.
    const sent = socket.sent.map((e) => e.type);
    expect(sent.indexOf("response.cancel")).toBeGreaterThan(sent.lastIndexOf("conversation.item.create"));
    expect(socket.replies()).toEqual([]);
  });

  it("the user talking over the narrator's speech cancels that reply at once", () => {
    const { socket } = client();
    userTurn(socket, "in1", "r1");
    socket.event({ type: "response.output_audio.delta", item_id: "a1", delta: "AAAA" });
    socket.event({ type: "input_audio_buffer.speech_started", item_id: "in2" });
    expect(socket.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
    // Its done event (cancelled) ends it; the user's next turn gets its reply as usual.
    socket.event({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
    expect(socket.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
  });

  it("names the user's input item and their words with the tool call, and the input when its reply is done", async () => {
    const onTool = vi.fn(() => "ok");
    const onHeard = vi.fn();
    const onTurnDone = vi.fn();
    const { socket } = client({ onTool, onHeard, onTurnDone });
    userTurn(socket, "in1", "r1");
    callSend(socket, "Open Gmail");
    transcribed(socket, "in1", " um, open my gmail ");
    replyDone(socket, "r1");
    socket.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "in2", error: { message: "x" } });
    await flush();
    expect(onTool).toHaveBeenCalledWith("send_to_agent", { text: "Open Gmail" }, "in1", ["um, open my gmail"]);
    // Its words went with the request; a failed transcription has none.
    expect(onHeard).not.toHaveBeenCalled();
    expect(onTurnDone.mock.calls).toEqual([["in1"]]);
    // A reply we asked for (an update's) answers no input item: with no new words of the user's since the last
    // request, what it passes on is not the user's (it is refused, and the narrator is told so).
    socket.event({ type: "response.created", response: { id: "r2" } });
    callSend(socket, "And archive it", "c2");
    replyDone(socket, "r2");
    await flush();
    expect(onTool).toHaveBeenCalledTimes(1);
    expect(socket.sent.at(-1)).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c2", output: NOT_A_REQUEST_OUTPUT.not_user } });
    // New words of the user's first (a turn whose reply went elsewhere): the same call goes out, as answering no input item.
    transcribed(socket, "in3", "and archive it");
    socket.event({ type: "response.created", response: { id: "r3" } });
    callSend(socket, "And archive it", "c3");
    replyDone(socket, "r3");
    await flush();
    expect(onTool).toHaveBeenLastCalledWith("send_to_agent", { text: "And archive it" }, null, ["and archive it"]);
    expect(onTurnDone).toHaveBeenCalledTimes(1);
  });
});

class FakeMic implements AudioSource {
  started = false;
  stopped = false;
  async start(): Promise<void> {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

function engineEvents(log: string[]): EngineEvents {
  return {
    speech: () => void log.push("speech"),
    heard: (t, f) => void log.push(`heard:${t}:${f}`),
    partial: (t) => void log.push(`partial:${t}`),
    level: () => {},
    narrating: () => {},
    said: () => {},
    narratorText: () => {},
    forward: (t, heard) => void log.push(`forward:${t}${heard?.length ? ` [${heard.join(" | ")}]` : ""}`),
    userWords: (w) => void log.push(`words:${w.join(" | ")}`),
    stopTask: async () => (log.push("stopTask"), "Stopped the task."),
    answerApproval: async () => "Nothing is waiting for the user's OK.",
    endVoice: () => {},
    useThisTab: async () => "The user is already looking at the tab you work in.",
    failed: (f) => void log.push(`failed:${(f as { kind: string }).kind}`),
  };
}

/** The user said `words` in a turn of their own (its reply done): a later tool call is theirs to make. */
function userSaid(s: { event(e: Record<string, unknown>): void }, words: string, id = "said1"): void {
  s.event({ type: "input_audio_buffer.committed", item_id: id });
  s.event({ type: "response.created", response: { id: `r_${id}` } });
  s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
  s.event({ type: "response.done", response: { id: `r_${id}`, status: "completed" } });
}

describe("RealtimeEngine: a turn, and stopping while it starts", () => {
  function engine(ticket: () => Promise<{ url: string; token: string }> = async () => ({ url: "wss://x", token: "t" })) {
    const log: string[] = [];
    const sockets: FakeSocket[] = [];
    const mic = new FakeMic();
    const player = { play: vi.fn(), stop: vi.fn(() => null), close: vi.fn(), playing: false };
    const e = new RealtimeEngine({ ticket, createSource: () => mic, events: engineEvents(log), openSocket: () => (sockets.push(new FakeSocket()), sockets.at(-1)!), player });
    return { e, log, sockets, mic };
  }

  it("send_to_agent goes to the panel with the user's words for it; words that led to no request are passed on once their reply is done", async () => {
    const t = engine();
    const start = t.e.start();
    await flush();
    const socket = t.sockets[0]!;
    socket.open();
    socket.event({ type: "session.created", session: {} });
    await start;
    userTurn(socket, "in1", "r1");
    transcribed(socket, "in1", "could you check what Sarah wrote me");
    expect(t.log).toEqual(["speech"]);
    callSend(socket, "Open Gmail and read the newest email from Sarah");
    await flush();
    expect(t.log).toEqual(["speech", "forward:Open Gmail and read the newest email from Sarah [could you check what Sarah wrote me]"]);
    expect(socket.sent.find((x) => x.item?.type === "function_call_output")!.item.output).toBe("Started. Your updates on it will follow.");
    // A turn with no request, answered aloud: its words once its reply is done.
    userTurn(socket, "in2", "r2");
    transcribed(socket, "in2", "thanks");
    socket.event({ type: "response.output_audio.delta", item_id: "a2", delta: "AAAA" });
    replyDone(socket, "r2");
    await flush();
    expect(t.log.at(-1)).toBe("words:thanks");
  });

  it("cancel_request stops the task: the request already went out", async () => {
    const t = engine();
    const start = t.e.start();
    await flush();
    t.sockets[0]!.open();
    t.sockets[0]!.event({ type: "session.created", session: {} });
    await start;
    userSaid(t.sockets[0]!, "never mind");
    t.sockets[0]!.event({ type: "response.function_call_arguments.done", call_id: "c9", name: "cancel_request", arguments: "{}" });
    await flush();
    expect(t.log).toEqual(["stopTask"]);
  });

  it("stopped while the ticket is fetched: no connection, no microphone", async () => {
    let give!: (v: { url: string; token: string }) => void;
    const t = engine(() => new Promise((r) => (give = r)));
    const start = t.e.start();
    t.e.stop();
    give({ url: "wss://x", token: "t" });
    await start;
    expect(t.sockets).toHaveLength(0);
    expect(t.mic.started).toBe(false);
  });

  it("stopped while connecting: the start ends, the socket is closed, the microphone never opens", async () => {
    const t = engine();
    const start = t.e.start();
    await flush();
    const socket = t.sockets[0]!;
    socket.open();
    t.e.stop();
    await start;
    expect(socket.readyState).toBe(3);
    expect(t.mic.started).toBe(false);
    // The server's late "ready" changes nothing.
    socket.event({ type: "session.created", session: {} });
    expect(t.mic.started).toBe(false);
    expect(t.log).toEqual([]);
  });
});

/** An engine the panel drives; `hold`: its start waits until it is stopped (or opened); `failure`: its start rejects with it. */
class FakeEngine implements HandsFreeEngine {
  readonly halfDuplex: boolean;
  ticks = 0;
  stopped = false;
  private release!: () => void;
  private readonly ready = new Promise<void>((r) => (this.release = r));
  constructor(
    readonly id: VoiceEngineId,
    readonly events: EngineEvents,
    private readonly hold: boolean,
    private readonly failure: unknown = null,
    readonly takeover = false,
  ) {
    this.halfDuplex = id === "standard";
  }
  start(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.hold) this.release();
    return this.ready;
  }
  stop(): void {
    this.stopped = true;
    this.release();
  }
  speak(): void {}
  hush(): void {}
  setTranscribing(): void {}
  setMuted(): void {}
  agentEvent(): void {}
  notes: string[] = [];
  note(text: string): void {
    this.notes.push(text);
  }
  tick(): void {
    this.ticks++;
  }
}

const ENGINES: VoiceEnginesResponse = {
  default: "realtime",
  engines: [
    { id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 6.0762, assumption: "", available: true },
    { id: "standard", name: "Standard", model: "whisper-large-v3-turbo", approxCentsPerMinute: 0.0667, assumption: "", available: true },
  ],
};

describe("the side panel's hands-free session on Realtime", () => {
  beforeAll(installMiniDom);

  function panel(opts: { costNoticed?: boolean; holdRealtime?: boolean; patch?: Partial<HandsFreeDeps>; failStarts?: unknown[]; traced?: boolean } = {}) {
    const engines: FakeEngine[] = [];
    /** How the next engines' starts fail, in order (then they start). */
    const failures = [...(opts.failStarts ?? [])];
    const saved: Partial<ExtensionSettings>[] = [];
    const trace: { name: string; data?: Record<string, unknown> }[] = [];
    const tips: (VoiceTip & { key?: string })[] = [];
    const box = { draft: vi.fn(() => "half-typed note"), setDraft: vi.fn() };
    let finishSend!: (id: string) => void;
    const deps: HandsFreeDeps = {
      voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: () => {}, setLevel: () => {}, showTip: () => {}, ensureMic: async () => true, shortcutLabel: null },
      composer: box,
      notify: (tip) => void tips.push(tip),
      activeTab: () => 1,
      chatOf: () => null,
      tabsOf: () => [],
      send: vi.fn(() => new Promise<string>((r) => (finishSend = r))),
      panel: "p1",
      tabPage: async () => ({ title: "Inbox", url: "https://mail.example.com/" }),
      goToTab: () => {},
      onSpeaking: () => {},
      keepSpoken: vi.fn(),
      keepHeard: vi.fn(),
      settings: () => ({ voiceEngine: "realtime", realtimeCostNoticed: opts.costNoticed ?? true }) as ExtensionSettings,
      account: () => undefined,
      engines: async () => ENGINES,
      saveSettings: async (patch) => void saved.push(patch),
      openVoiceSettings: () => {},
      createEngine: (id, events, o) => {
        const e = new FakeEngine(id, events, id === "realtime" && !!opts.holdRealtime, failures.shift(), o?.takeover ?? false);
        engines.push(e);
        return e;
      },
      ...(opts.traced
        ? {
            trace: {
              record: (e) => void trace.push({ name: e.name, ...(e.data ? { data: e.data as Record<string, unknown> } : {}) }),
              utterance: () => "u1",
              endUtterance: () => {},
              bind: () => {},
              target: () => null,
            },
          }
        : {}),
      stopTask: async () => "Stopped the task.",
      answerApproval: async () => true,
      openBilling: () => {},
      signIn: () => {},
      onActive: () => {},
      stopRemote: () => {},
      bar: new MiniElement("div") as unknown as HTMLElement,
      earcons: { play: () => {} },
      ...opts.patch,
    };
    const hf = initHandsFree(deps);
    return { hf, deps, engines, tips, box, saved, trace, finish: (id: string) => finishSend(id) };
  }

  it("a request goes to the chat at once with the user's words for it, the box untouched; words that led to no request are kept for the record", async () => {
    vi.useFakeTimers();
    try {
      const t = panel();
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      const rt = t.engines[0]!;
      expect(rt.id).toBe("realtime");
      expect(t.hf.phase).toBe("listening");
      rt.events.forward("Open Gmail and read the newest email from Sarah", ["could you check what Sarah wrote me"]);
      // No sending window: out before any tick, the words with it.
      expect(t.deps.send).toHaveBeenCalledWith("Open Gmail and read the newest email from Sarah", { tabId: 1, sessionId: null }, { heard: ["could you check what Sarah wrote me"] });
      expect(t.hf.phase).toBe("listening");
      t.finish("s-new");
      await vi.advanceTimersByTimeAsync(0);
      // Words with no request go to the session's chat, for the record.
      rt.events.userWords(["thanks"]);
      await vi.advanceTimersByTimeAsync(HANDS_FREE.sendDelayMs * 2);
      expect(t.deps.keepHeard).toHaveBeenCalledTimes(1);
      expect(t.deps.keepHeard).toHaveBeenLastCalledWith("s-new", "thanks");
      expect(t.deps.send).toHaveBeenCalledTimes(1);
      expect(t.box.setDraft).not.toHaveBeenCalled();
      t.hf.toggle("button");
      expect(rt.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("words that led to no request before the chat exists are let go (nothing to keep them in)", async () => {
    vi.useFakeTimers();
    try {
      const t = panel();
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      t.engines[0]!.events.userWords(["hmm"]);
      await vi.advanceTimersByTimeAsync(0);
      t.engines[0]!.events.forward("Open Gmail", ["open gmail"]);
      t.finish("s-new");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.deps.keepHeard).not.toHaveBeenCalled();
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests said one after another before the first one's chat exists all go to that chat, the first at once", async () => {
    vi.useFakeTimers();
    try {
      const t = panel();
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      const rt = t.engines[0]!;
      rt.events.forward("Open Gmail");
      rt.events.forward("and find the invoice from Acme");
      await vi.advanceTimersByTimeAsync(0);
      // The second waits for the chat the first is starting (it would start a second one).
      expect(t.deps.send).toHaveBeenCalledTimes(1);
      expect(t.deps.send).toHaveBeenLastCalledWith("Open Gmail", { tabId: 1, sessionId: null });
      t.finish("s-new");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.deps.send).toHaveBeenCalledTimes(2);
      expect(t.deps.send).toHaveBeenLastCalledWith("and find the invoice from Acme", { tabId: 1, sessionId: "s-new" });
      // Once the chat is known, a request goes out at once, even while an earlier one is still on its way.
      rt.events.forward("and print it");
      expect(t.deps.send).toHaveBeenCalledTimes(3);
      expect(t.deps.send).toHaveBeenLastCalledWith("and print it", { tabId: 1, sessionId: "s-new" });
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the cost notice points to Settings; it never changes the engine itself", async () => {
    vi.useFakeTimers();
    try {
      const t = panel({ costNoticed: false });
      t.hf.toggle("shortcut");
      await vi.advanceTimersByTimeAsync(0);
      const notice = t.tips.find((x) => /Realtime voice uses/.test(x.text))!;
      expect(notice.actions?.map((a) => a.label)).toEqual(["Voice settings"]);
      expect(t.saved).toEqual([{ realtimeCostNoticed: true }]);
      expect(t.engines.map((e) => e.id)).toEqual(["realtime"]);
      t.hf.toggle("shortcut");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Realtime connection that drops is made again (taking the place of the old one), the session and its chat going on", async () => {
    vi.useFakeTimers();
    try {
      const t = panel({ traced: true });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      const first = t.engines[0]!;
      first.events.forward("Post gm on X");
      t.finish("s-voice");
      await vi.advanceTimersByTimeAsync(0);
      first.events.failed({ kind: "upstream", transient: true, message: "Voice disconnected." });
      expect(first.stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      const second = t.engines[1]!;
      expect([second.id, second.takeover]).toEqual(["realtime", true]);
      expect(t.hf.active).toBe(true);
      expect(t.hf.phase).toBe("listening");
      expect(t.hf.chat()).toBe("s-voice");
      expect(t.tips.filter((x) => x.level === "error")).toEqual([]);
      expect(t.trace.find((e) => e.name === "voice.reconnect")?.data).toEqual({ reason: "upstream", attempt: 0 });
      // The clock drives the new engine.
      await vi.advanceTimersByTimeAsync(HANDS_FREE.tickMs * 2);
      expect(second.ticks).toBeGreaterThanOrEqual(2);
      expect(t.saved).toEqual([]);
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a connection that cannot be made again: tried RECONNECT_DELAYS_MS times, then it stops with Try again; Settings untouched, never Standard", async () => {
    vi.useFakeTimers();
    try {
      const drop = { kind: "network", transient: true, message: "Voice disconnected." };
      const t = panel({ failStarts: [null, drop, drop, drop, drop], traced: true });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      t.engines[0]!.events.failed({ kind: "upstream", transient: true, message: "Voice disconnected." });
      for (const ms of RECONNECT_DELAYS_MS) await vi.advanceTimersByTimeAsync(ms);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engines.map((e) => e.id)).toEqual(["realtime", "realtime", "realtime", "realtime", "realtime"]);
      expect(t.hf.active).toBe(false);
      const tip = t.tips.at(-1)!;
      expect(tip.text).toBe("Voice disconnected.");
      expect(tip.actions?.map((a) => a.label)).toEqual(["Try again", "Use Whisper voice"]);
      expect(t.saved).toEqual([]);
      expect(t.trace.filter((e) => e.name === "voice.reconnect").map((e) => e.data?.attempt)).toEqual([0, 1, 2, 3]);
      expect(t.trace.at(-1)).toMatchObject({ name: "voice.end", data: { why: "error" } });
      // Try again: Realtime again, as picked.
      tip.actions![0]!.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engines.at(-1)!.id).toBe("realtime");
      expect(t.hf.active).toBe(true);
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the user's previous session still closing on the server (busy while connecting) is waited out; still busy: Take over here, never Standard", async () => {
    vi.useFakeTimers();
    try {
      const busy = { kind: "busy", transient: true, message: "Realtime voice is on in another window or on another device." };
      const waited = panel({ failStarts: [busy] });
      waited.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
      expect(waited.hf.phase).toBe("listening");
      expect(waited.engines.map((e) => e.id)).toEqual(["realtime", "realtime"]);
      waited.hf.toggle("button");

      const t = panel({ failStarts: [busy, busy, busy, busy] });
      t.hf.toggle("button");
      for (const ms of RECONNECT_DELAYS_MS) await vi.advanceTimersByTimeAsync(ms);
      expect(t.hf.active).toBe(false);
      const tip = t.tips.at(-1)!;
      expect(tip).toMatchObject({ text: busy.message, level: "error" });
      expect(tip.actions?.map((a) => a.label)).toEqual(["Take over here"]);
      expect(t.engines.every((e) => e.id === "realtime" && !e.takeover)).toBe(true);
      tip.actions![0]!.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engines.at(-1)).toMatchObject({ id: "realtime", takeover: true });
      expect(t.hf.phase).toBe("listening");
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Realtime the server cannot run: nothing starts; the notice offers Standard for this once (Settings untouched)", async () => {
    vi.useFakeTimers();
    try {
      const off: VoiceEnginesResponse = { default: "standard", engines: ENGINES.engines.map((e) => (e.id === "realtime" ? { ...e, available: false } : e)) };
      const t = panel({ patch: { engines: async () => off } });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engines).toEqual([]);
      expect(t.hf.active).toBe(false);
      const tip = t.tips.at(-1)!;
      expect(tip).toMatchObject({ text: "Realtime voice is unavailable on the server right now.", level: "error" });
      tip.actions![0]!.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engines.map((e) => e.id)).toEqual(["standard"]);
      expect(t.saved).toEqual([]);
      t.hf.toggle("button");
    } finally {
      vi.useRealTimers();
    }
  });

  it("taken over by another window (replaced): it stops, saying so, with Take over here; no reconnect", async () => {
    vi.useFakeTimers();
    try {
      const t = panel();
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      t.engines[0]!.events.failed({ kind: "replaced", transient: false, message: "Voice was turned on in another window, so it stopped here." });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.engines).toHaveLength(1);
      expect(t.hf.active).toBe(false);
      expect(t.tips.at(-1)!.actions?.map((a) => a.label)).toEqual(["Take over here"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopped while the engine starts: nothing runs on", async () => {
    vi.useFakeTimers();
    try {
      const t = panel({ holdRealtime: true });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(HANDS_FREE.tickMs * 3);
      expect(t.engines[0]!.stopped).toBe(true);
      expect(t.engines[0]!.ticks).toBe(0);
      expect(t.hf.active).toBe(false);
      expect(t.hf.phase).toBe("off");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the voice strip shows while it is on (Hearing you with a voice on the microphone); the tab goes to the background; a sound marks the microphone going live and off", async () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const active: [boolean, number | null, VoiceEngineId | null][] = [];
      const bar = new MiniElement("div") as unknown as HTMLElement;
      const t = panel({ patch: { bar, earcons: { play: (k) => void played.push(k) }, onActive: (on, tab, engine) => void active.push([on, tab, engine]) } });
      t.hf.toggle("button");
      // Starting: the bar is up at once, no sound until the microphone is live.
      expect([bar.hidden, bar.dataset.state, played]).toEqual([false, "starting", []]);
      await vi.advanceTimersByTimeAsync(0);
      // Reported when it starts, and again with its engine once that is open.
      expect([bar.dataset.state, played, active, t.hf.tab]).toEqual(["listening", ["start"], [[true, 1, null], [true, 1, "realtime"]], 1]);
      // It names the tab it runs for (tab 1, "Inbox"), here too.
      expect(bar.textContent).toContain("Voice on · InboxListening");
      expect(bar.textContent).toContain("0:00");
      expect(bar.title).toMatch(/^Realtime voice · /);
      t.engines[0]!.events.level(0.9);
      expect(bar.dataset.state).toBe("hearing");
      expect(bar.textContent).toContain("Hearing you");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(bar.dataset.state).toBe("listening");
      expect(bar.textContent).toContain("0:02");
      t.hf.toggle("button");
      expect([bar.hidden, played, active.at(-1), t.hf.tab]).toEqual([true, ["start", "stop"], [false, null, null], null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no sounds when Settings turned them off, or when it stopped before the microphone was live", async () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const earcons = { play: (k: string) => void played.push(k) };
      const quiet = panel({ patch: { earcons, settings: () => ({ voiceEngine: "realtime", realtimeCostNoticed: true, voiceSounds: false }) as ExtensionSettings } });
      quiet.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      expect(quiet.hf.phase).toBe("listening");
      quiet.hf.toggle("button");
      const early = panel({ holdRealtime: true, patch: { earcons } });
      early.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      early.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(HANDS_FREE.tickMs);
      expect(played).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
