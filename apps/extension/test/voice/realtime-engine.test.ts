import { describe, expect, it, vi } from "vitest";
import { REALTIME_CLOSE } from "@noa/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import { SENT_OUTPUT } from "../../src/voice/realtime-client.js";

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

class FakeMic implements AudioSource {
  deliver: ((s: Float32Array) => void) | null = null;
  async start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.deliver = onSamples;
  }
  stop(): void {
    this.deliver = null;
  }
}

function setup() {
  const socket = new FakeSocket();
  const mic = new FakeMic();
  const log: string[] = [];
  const levels: number[] = [];
  const events: EngineEvents = {
    speech: () => void log.push("speech"),
    heard: (t, f) => void log.push(`heard:${t}:${f}`),
    partial: (t) => void log.push(`partial:${t}`),
    level: (l) => void levels.push(l),
    openingMic: () => void log.push("openingMic"),
    capturing: () => void log.push("capturing"),
    narrating: () => void log.push("narrating"),
    said: () => void log.push("said"),
    narratorText: (t) => void log.push(`narrator:${t}`),
    forward: (t) => void log.push(`forward:${t}`),
    userWords: (w) => void log.push(`words:${w.join(" | ")}`),
    stopTask: async () => (log.push("stopTask"), "Stopped the task."),
    answerApproval: async (allow: boolean) => (log.push(`answerApproval:${allow}`), "Allowed: the task goes on."),
    endVoice: () => void log.push("end"),
    useThisTab: async () => (log.push("useThisTab"), "Moved: you now work in Recipes (example.com)."),
    failed: (f) => void log.push(`failed:${(f as { kind: string }).kind}`),
  };
  const player = { play: vi.fn(), stop: vi.fn(() => ({ itemId: "a1", playedMs: 800 })), close: vi.fn(), playing: false, pause: vi.fn(() => false), resume: vi.fn(), level: () => 0 };
  const engine = new RealtimeEngine({
    ticket: async () => ({ url: "wss://api.test/v1/ai/realtime", token: "tok" }),
    createSource: () => mic,
    events,
    openSocket: () => socket,
    player,
  });
  return { socket, mic, log, levels, engine, player };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function started() {
  const t = setup();
  const start = t.engine.start();
  await settle();
  t.socket.readyState = 1;
  t.socket.onopen?.({});
  t.socket.event({ type: "session.created", session: { type: "realtime" } });
  await start;
  return t;
}

/** The user said `words` in a turn of their own (its reply done): a later tool call is theirs to make. */
function userSaid(s: { event(e: Record<string, unknown>): void }, words: string, id = "said1"): void {
  s.event({ type: "input_audio_buffer.committed", item_id: id });
  s.event({ type: "response.created", response: { id: `r_${id}` } });
  s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
  s.event({ type: "response.done", response: { id: `r_${id}`, status: "completed" } });
}

describe("RealtimeEngine", () => {
  it("starts once the narrator's session is configured, then streams the microphone in ~100 ms PCM16 chunks", async () => {
    const t = await started();
    expect(t.socket.sent[0]!.type).toBe("session.update");
    for (let i = 0; i < 5; i++) t.mic.deliver!(new Float32Array(512).fill(0.1));
    expect(t.socket.sent.filter((e) => e.type === "input_audio_buffer.append")).toHaveLength(1);
  });

  it("says when it opens the microphone (connected), and when its first audio went to the narrator: once, never while muted", async () => {
    const t = setup();
    t.engine.setMuted(true);
    const start = t.engine.start();
    await settle();
    expect(t.log).toEqual([]);
    t.socket.readyState = 1;
    t.socket.onopen?.({});
    t.socket.event({ type: "session.created", session: { type: "realtime" } });
    await start;
    expect(t.log).toEqual(["openingMic"]);
    for (let i = 0; i < 5; i++) t.mic.deliver!(new Float32Array(512).fill(0.1));
    expect(t.log).toEqual(["openingMic"]);
    t.engine.setMuted(false);
    t.mic.deliver!(new Float32Array(1200));
    expect(t.log).toEqual(["openingMic"]);
    t.mic.deliver!(new Float32Array(1200));
    expect(t.log).toEqual(["openingMic", "capturing"]);
    for (let i = 0; i < 5; i++) t.mic.deliver!(new Float32Array(2400));
    expect(t.log.filter((l) => l === "capturing")).toHaveLength(1);
  });

  it("a refusal before the start rejects it with the failure (the panel says why; it never switches engine)", async () => {
    const t = setup();
    const start = t.engine.start();
    await settle();
    t.socket.readyState = 1;
    t.socket.onopen?.({});
    t.socket.event({ type: "noa.error", error: "realtime_unavailable", message: "Realtime voice is not set up on this server yet" });
    t.socket.readyState = 3;
    t.socket.onclose?.({ code: REALTIME_CLOSE.unavailable, reason: "" });
    await expect(start).rejects.toMatchObject({ kind: "unavailable", transient: false });
  });

  it("send_to_agent forwards the request to the panel (which sends it as a chat message) and answers the narrator", async () => {
    const t = await started();
    // The user's turn: its words, then the narrator's call for it.
    t.socket.event({ type: "input_audio_buffer.committed", item_id: "in1" });
    t.socket.event({ type: "response.created", response: { id: "r1" } });
    t.socket.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "in1", transcript: "post gm on x" });
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Post gm on X" }) });
    await settle();
    expect(t.log).toContain("forward:Post gm on X");
    expect(t.socket.sent.find((e) => e.type === "conversation.item.create" && e.item.type === "function_call_output")!.item.output).toBe(SENT_OUTPUT);
  });

  it("stop_task and end_voice reach the panel", async () => {
    const t = await started();
    userSaid(t.socket, "stop it and goodbye");
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "stop_task", arguments: "{}" });
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c2", name: "end_voice", arguments: "{}" });
    await settle();
    await settle();
    const outputs = t.socket.sent.filter((e) => e.item?.type === "function_call_output").map((e) => e.item.output);
    expect(outputs).toContain("Stopped the task.");
    expect(t.log).toContain("end");
  });

  it("use_this_tab reaches the panel, and its answer goes back to the narrator; notes are silent system messages", async () => {
    const t = await started();
    userSaid(t.socket, "use this tab");
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "use_this_tab", arguments: "{}" });
    await settle();
    expect(t.log).toContain("useThisTab");
    expect(t.socket.sent.find((e) => e.item?.type === "function_call_output")!.item.output).toBe("Moved: you now work in Recipes (example.com).");
    const before = t.socket.sent.length;
    t.engine.note("The user is looking at another tab: Recipes (example.com). You work in Shop.");
    expect(t.socket.sent.slice(before)).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "The user is looking at another tab: Recipes (example.com). You work in Shop." }] } },
    ]);
  });

  it("the user speaking cuts the narrator's audio off and trims what it remembers to what was heard", async () => {
    const t = await started();
    t.socket.event({ type: "response.output_audio.delta", delta: "AAAA", item_id: "a1" });
    expect(t.player.play).toHaveBeenCalledWith("AAAA", "a1");
    t.socket.event({ type: "input_audio_buffer.speech_started", audio_start_ms: 10, item_id: "u1" });
    expect(t.player.stop).toHaveBeenCalled();
    expect(t.socket.sent.at(-1)).toEqual({ type: "conversation.item.truncate", item_id: "a1", content_index: 0, audio_end_ms: 800 });
    expect(t.log).toContain("speech");
  });

  it("cancel_request stops the task (the request already went to the agent)", async () => {
    const t = await started();
    userSaid(t.socket, "never mind");
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "cancel_request", arguments: "{}" });
    await settle();
    expect(t.log).toContain("stopTask");
    expect(t.socket.sent.find((e) => e.item?.type === "function_call_output")!.item.output).toBe("Stopped the task.");
  });

  it("the chat's events: its line said word for word, out of band, and the narrator's one status replaced", async () => {
    const t = await started();
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Posted", spoken: "Posted it." }, 0);
    const statuses = () => t.socket.sent.filter((e) => e.type === "conversation.item.create" && e.item.role === "system");
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0]!.item.id).toMatch(/^noa_status_/);
    const say = t.socket.sent.find((e) => e.type === "response.create")!;
    expect(say.response).toMatchObject({ conversation: "none", tool_choice: "none" });
    expect(say.response.instructions).toContain("«Posted it.»");
    // The next status replaces it: the narrator never keeps a pile of updates to say later.
    t.socket.event({ type: "response.created", response: { id: "r1" } });
    t.socket.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    t.engine.agentEvent({ type: "user_message", text: "use the second draft" }, 10);
    expect(t.socket.sent.filter((e) => e.type === "conversation.item.delete").map((e) => e.item_id)).toEqual([statuses()[0]!.item.id]);
  });

  it("a failure after the start is reported; stop() closes without one", async () => {
    const t = await started();
    t.socket.event({ type: "noa.error", error: "out_of_credit", message: "Out of usage credit" });
    t.socket.readyState = 3;
    t.socket.onclose?.({ code: REALTIME_CLOSE.credit, reason: "" });
    expect(t.log).toContain("failed:credit");
    const u = await started();
    u.engine.stop();
    await settle();
    expect(u.log.filter((l) => l.startsWith("failed"))).toEqual([]);
  });
});

describe("RealtimeEngine: muted", () => {
  it("streams nothing while muted (no input audio is billed), the meter drops, and the narrator's speech still plays", async () => {
    const t = await started();
    const appends = () => t.socket.sent.filter((e) => e.type === "input_audio_buffer.append");
    // Half a chunk, then mute: the half is dropped, not sent later.
    t.mic.deliver!(new Float32Array(1200).fill(0.1));
    t.engine.setMuted(true);
    expect(t.levels.at(-1)).toBe(0);
    t.levels.length = 0;
    for (let i = 0; i < 20; i++) t.mic.deliver!(new Float32Array(512).fill(0.2));
    expect(appends()).toHaveLength(0);
    expect(t.levels).toEqual([]);
    expect(t.socket.sent.map((e) => e.type)).toContain("input_audio_buffer.clear");
    t.socket.event({ type: "response.created" });
    t.socket.event({ type: "response.output_audio.delta", delta: "AAAA", item_id: "a1" });
    expect(t.player.play).toHaveBeenCalledWith("AAAA", "a1");
    t.engine.setMuted(false);
    // The first chunk after unmuting is whole (nothing from before the mute).
    t.mic.deliver!(new Float32Array(1200).fill(0.1));
    expect(appends()).toHaveLength(0);
    t.mic.deliver!(new Float32Array(1200).fill(0.1));
    expect(appends()).toHaveLength(1);
    // 2400 samples of PCM16: 4800 bytes, 6400 base64 characters.
    expect(String(appends()[0]!.audio).length).toBe(6400);
    t.engine.stop();
  });

  it("muted before it starts: the narrator is told once connected, and no audio goes out", async () => {
    const t = setup();
    t.engine.setMuted(true);
    const start = t.engine.start();
    await settle();
    t.socket.readyState = 1;
    t.socket.onopen?.({});
    t.socket.event({ type: "session.created", session: { type: "realtime" } });
    await start;
    for (let i = 0; i < 10; i++) t.mic.deliver!(new Float32Array(512).fill(0.2));
    const types = t.socket.sent.map((e) => e.type);
    expect(types).not.toContain("input_audio_buffer.append");
    expect(types).toContain("conversation.item.create");
    t.engine.stop();
  });
});
