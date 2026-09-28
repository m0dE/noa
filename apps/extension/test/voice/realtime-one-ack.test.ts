/**
 * One spoken acknowledgement per request, end to end in the side panel: the hands-free session on the real
 * RealtimeEngine and RealtimeClient over a fake OpenAI socket, one utterance that resumes an ended chat (the
 * agent's fresh session, its list_tabs). Also the holes around the acknowledgement: the reply we ask for must not
 * be able to call tools, and a request the narrator passes on twice in one turn goes to the agent once.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, StampedAgentEvent, VoiceEnginesResponse } from "@noa/shared";
import { initHandsFree, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import type { AudioSource } from "../../src/voice/dictation.js";
import { installMiniDom, MiniElement } from "../ui/mini-dom.js";

/** What the model does in a reply we asked for (response.create): by default it says a line. */
type OurReply = (socket: FakeOpenAi, id: string, n: number) => void;

const speaks = (line: string): OurReply => (s, id) => {
  s.event({ type: "response.created", response: { id } });
  s.event({ type: "response.output_audio_transcript.delta", response_id: id, delta: line });
  s.event({ type: "response.output_audio.delta", response_id: id, item_id: `a_${id}`, delta: "AAAA" });
  s.event({ type: "response.done", response: { id, status: "completed", output: [] } });
};

/** OpenAI's side: replies to our response.create (a few ms later), and the events a test plays. */
class FakeOpenAi implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  private n = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public ourReply: OurReply = speaks("Okay, it's been sent.")) {}
  send(data: string): void {
    const e = JSON.parse(data);
    this.sent.push(e);
    if (e.type === "response.create") {
      const n = ++this.n;
      setTimeout(() => this.ourReply(this, `ours_${n}`, n), 5);
    }
  }
  close(code = 1000): void {
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
  creates(): Record<string, any>[] {
    return this.sent.filter((e) => e.type === "response.create");
  }
  outputs(): string[] {
    return this.sent.filter((e) => e.item?.type === "function_call_output").map((e) => String(e.item.output));
  }
}

class Mic implements AudioSource {
  async start(): Promise<void> {}
  stop(): void {}
}

const ENGINES: VoiceEnginesResponse = {
  default: "realtime",
  engines: [
    { id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 6, assumption: "", available: true },
    { id: "standard", name: "Standard", model: "whisper-large-v3-turbo", approxCentsPerMinute: 0.07, assumption: "", available: true },
  ],
};

const SAID = "So I kind of like to, I like to resume from where I left things off, right?";
const REQUEST = "Resume from where I left off.";

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
let clock = Date.now();
const stamped = (ev: Record<string, unknown>): StampedAgentEvent => ({ ...ev, sessionId: "s-old", ts: new Date((clock += 10)).toISOString() }) as unknown as StampedAgentEvent;

/** The panel's session on tab 1, whose chat (s-old) ended earlier: what is said goes to it. */
async function panel() {
  const socket = new FakeOpenAi();
  shown = 1;
  const deps: HandsFreeDeps = {
    voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: () => {}, setLevel: () => {}, showTip: () => {}, ensureMic: async () => true, shortcutLabel: null },
    composer: { draft: () => "", setDraft: () => {} },
    notify: () => {},
    activeTab: () => shown,
    chatOf: () => "s-old",
    tabsOf: () => [1],
    send: vi.fn(async () => "s-old"),
    panel: "p1",
    tabPage: async (id) => (id === 1 ? { title: "Intercom", url: "https://app.intercom.com/" } : { title: "Recipes", url: "https://recipes.example/" }),
    goToTab: () => {},
    onSpeaking: () => {},
    keepSpoken: () => {},
    keepHeard: () => {},
    settings: () => ({ voiceEngine: "realtime", realtimeCostNoticed: true }) as ExtensionSettings,
    account: () => undefined,
    engines: async () => ENGINES,
    saveSettings: async () => {},
    openVoiceSettings: () => {},
    createEngine: (_id, events) =>
      new RealtimeEngine({
        ticket: async () => ({ url: "wss://x/v1/ai/realtime", token: "t" }),
        createSource: () => new Mic(),
        events,
        openSocket: () => {
          queueMicrotask(() => {
            socket.open();
            socket.event({ type: "session.created", session: {} });
          });
          return socket;
        },
        player: { play: () => {}, stop: () => null, close: () => {}, playing: false },
      }),
    stopTask: async () => "",
    answerApproval: async () => true,
    openBilling: () => {},
    signIn: () => {},
    onActive: () => {},
    stopRemote: () => {},
    bar: new MiniElement("div") as unknown as HTMLElement,
    earcons: { play: () => {} },
  };
  const hf = initHandsFree(deps);
  hf.toggle("button");
  await settle();
  return { hf, deps, socket };
}

/** The user's turn `input`, answered by a reply that calls send_to_agent (and nothing else); its words before or after. */
function utterance(s: FakeOpenAi, opts: { input?: string; wordsFirst?: boolean; calls?: number } = {}): void {
  const input = opts.input ?? "in1";
  const words = () => s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: input, content_index: 0, transcript: SAID });
  s.event({ type: "input_audio_buffer.speech_started", item_id: input, audio_start_ms: 0 });
  s.event({ type: "input_audio_buffer.speech_stopped", item_id: input, audio_end_ms: 4000 });
  s.event({ type: "input_audio_buffer.committed", item_id: input });
  s.event({ type: "response.created", response: { id: `r_${input}` } });
  if (opts.wordsFirst) words();
  for (let i = 1; i <= (opts.calls ?? 1); i++) {
    s.event({ type: "response.output_item.added", item: { type: "function_call", name: "send_to_agent" } });
    s.event({ type: "response.function_call_arguments.done", call_id: `c_${input}_${i}`, name: "send_to_agent", arguments: JSON.stringify({ text: REQUEST }) });
  }
  s.event({ type: "response.done", response: { id: `r_${input}`, status: "completed", output: [] } });
  if (!opts.wordsFirst) words();
}

/** The background's events for the turn: the ended chat's agent session is gone, a fresh one starts and lists tabs. */
async function agentTurn(hf: Awaited<ReturnType<typeof panel>>["hf"]): Promise<void> {
  for (const ev of [
    { type: "user_message", text: REQUEST, voice: true },
    { type: "status", text: "The earlier agent session has ended; starting a fresh one with a summary of the conversation" },
    { type: "heard", text: SAID, sent: REQUEST },
    { type: "spoken", text: "Okay, it's been sent." },
    { type: "tool_call", id: "t1", name: "list_tabs", args: {} },
    { type: "tool_result", id: "t1", name: "list_tabs", text: "t1 (current) https://app.intercom.com/" },
  ]) {
    hf.onEvent(stamped(ev));
  }
  await settle(50);
}

/** The tab the side panel's window shows (the session runs for tab 1). */
let shown = 1;

/** The user switches to tab `tab`: the panel follows its window's active tab and looks again (sidepanel.ts setActive). */
function lookAt(hf: Awaited<ReturnType<typeof panel>>["hf"], tab: number): void {
  shown = tab;
  hf.refresh();
}

describe("one utterance that resumes an ended chat: one acknowledgement", () => {
  beforeAll(installMiniDom);

  for (const wordsFirst of [false, true]) {
    it(`its words ${wordsFirst ? "before" : "after"} the call: one request to the agent, one acknowledgement, nothing for the fresh session or list_tabs`, async () => {
      const t = await panel();
      utterance(t.socket, { wordsFirst });
      await settle();
      await agentTurn(t.hf);
      expect(t.deps.send).toHaveBeenCalledTimes(1);
      expect(t.socket.creates()).toHaveLength(1);
    });
  }

  for (const viewing of [1, 2]) {
    it(`the user looking at tab ${viewing} and switching during the turn: the notes are silent, still one acknowledgement`, async () => {
      const t = await panel();
      lookAt(t.hf, viewing);
      await settle();
      utterance(t.socket);
      await settle();
      lookAt(t.hf, viewing === 1 ? 2 : 1);
      await agentTurn(t.hf);
      lookAt(t.hf, viewing);
      await settle(50);
      expect(t.deps.send).toHaveBeenCalledTimes(1);
      expect(t.socket.creates()).toHaveLength(1);
    });
  }
});

describe("the acknowledgement cannot start more work, and a request passed on twice goes out once", () => {
  beforeAll(installMiniDom);

  it("the acknowledgement is asked for with tool_choice none (OpenAI: the model will not call any tool)", async () => {
    const t = await panel();
    utterance(t.socket);
    await settle();
    expect(t.socket.creates()).toHaveLength(1);
    expect(t.socket.creates()[0]!.response).toMatchObject({ tool_choice: "none" });
  });

  it("send_to_agent called again in the same turn with the same request: not sent again, no second acknowledgement, the narrator is told it already went", async () => {
    const t = await panel();
    utterance(t.socket, { calls: 2 });
    await settle(50);
    expect(t.deps.send).toHaveBeenCalledTimes(1);
    expect(t.socket.creates()).toHaveLength(1);
    const [first, second] = t.socket.outputs();
    expect(first).toBe("Started. Your updates on it will follow.");
    expect(second).toMatch(/already/i);
  });

  it("an acknowledgement reply that calls send_to_agent without speaking: the request goes out once, at most one acknowledgement", async () => {
    const t = await panel();
    // What the model did when tools were on for it: the same request again, silently (first time only).
    t.socket.ourReply = (s, id, n) => {
      if (n > 1) return speaks("Okay, it's been sent along.")(s, id, n);
      s.event({ type: "response.created", response: { id } });
      s.event({ type: "response.output_item.added", item: { type: "function_call", name: "send_to_agent" } });
      s.event({ type: "response.function_call_arguments.done", call_id: `c_${id}`, name: "send_to_agent", arguments: JSON.stringify({ text: REQUEST }) });
      s.event({ type: "response.done", response: { id, status: "completed", output: [] } });
    };
    utterance(t.socket);
    await settle(80);
    expect(t.socket.creates().length).toBeLessThanOrEqual(1);
    expect(t.deps.send).toHaveBeenCalledTimes(1);
  });
});

describe("a reply cut off is never kept as said (the trace's stray 'Said aloud: I don't have' before the result)", () => {
  beforeAll(installMiniDom);

  it("a reply to noise that began a sentence: nothing of it reaches the chat; the result that follows is the line", async () => {
    const t = await panel();
    const kept: string[] = [];
    const shown: string[] = [];
    t.deps.keepSpoken = (_chat, text) => void kept.push(text);
    t.deps.onSpeaking = (line) => void (line && shown.push(line.text));
    const s = t.socket;
    s.ourReply = speaks("The second email asks for a privacy policy.");
    s.event({ type: "input_audio_buffer.speech_started", item_id: "in_noise", audio_start_ms: 0 });
    s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in_noise", audio_end_ms: 700 });
    s.event({ type: "input_audio_buffer.committed", item_id: "in_noise" });
    s.event({ type: "response.created", response: { id: "r_noise" } });
    s.event({ type: "response.output_audio_transcript.delta", response_id: "r_noise", delta: "I don't have" });
    s.event({ type: "response.output_audio.delta", response_id: "r_noise", item_id: "a_noise", delta: "AAAA" });
    s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "in_noise", content_index: 0, transcript: "" });
    s.event({ type: "response.done", response: { id: "r_noise", status: "cancelled", output: [] } });
    t.hf.onEvent(stamped({ type: "task_end", outcome: "done", summary: "x", spoken: "The second email asks you to add a privacy policy." }));
    await settle(50);
    // The result is asked for once, and is what is shown; the cut reply never was.
    expect(s.creates()).toEqual([{ type: "response.create" }]);
    expect([...shown, ...kept].filter((l) => l.includes("I don't have"))).toEqual([]);
    expect(shown.at(-1)).toBe("The second email asks for a privacy policy.");
  });
});
