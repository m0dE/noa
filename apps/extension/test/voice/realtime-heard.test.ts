/**
 * The user's words in a Realtime chat, end to end in the side panel (the real RealtimeEngine and RealtimeClient over
 * a fake OpenAI socket, the chat's events as the background keeps them, described as the chat shows them): one
 * message per request, its text what the narrator understood and passed on, with the user's words for it (every part
 * of their speech since the last request or spoken reply) folded under it. Words that led to no request are kept for
 * the record only. Reported: the narrator's condensed request showed as a second bubble ("transcribed twice"); and
 * one request split by server VAD into three turns showed as two muted lines, a bubble with the last part only, and
 * "Sent to agent" with the whole request.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ExtensionSettings, VoiceEnginesResponse } from "@noa/shared";
import { initHandsFree, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import { describeEvent } from "../../src/sidepanel/event-format.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import { installMiniDom, MiniElement } from "../ui/mini-dom.js";

class FakeOpenAi implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  private n = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    const e = JSON.parse(data);
    this.sent.push(e);
    // A reply we ask for (the acknowledgement): "On it."
    if (e.type === "response.create") {
      const id = `ours_${++this.n}`;
      setTimeout(() => {
        this.event({ type: "response.created", response: { id } });
        this.event({ type: "response.output_audio.delta", item_id: `a_${id}`, delta: "AAAA" });
        this.event({ type: "response.done", response: { id, status: "completed", output: [] } });
      }, 5);
    }
  }
  close(code = 1000): void {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason: "" }));
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

// The report's words (gpt-transcribe) and the narrator's send_to_agent text.
const W1 = "Herring's Landing. Give me one second here. Let me take a look.";
const W2 = "So the ticket here says, one sec, view task.";
const W3 =
  "Yeah, so take a look at the ticket that I'm showing you right now. So they were experiencing this issue a few days, or this was a while ago, actually. Maybe this is not relevant. You know what? Forget this for now, and I want you to look at something else. I want you to look at, let's look at the intercom and see if there are any other tickets from REN from Heron's Landing, either from REN or the property.";
const REQUEST = "Forget that for now. I want you to look at Intercom and see if there are any other tickets from Ren from Herons Landing, either from Ren or the property.";

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** The tab the side panel's window shows. */
let shown = 1;

/** The session in tab 1 (Intercom, chat s1); `viewing`: the tab the user looks at. The chat's events as kept. */
async function session(viewing: number) {
  shown = 1;
  const socket = new FakeOpenAi();
  const chat: AgentEvent[] = [];
  const deps: HandsFreeDeps = {
    voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: () => {}, setLevel: () => {}, showTip: () => {}, ensureMic: async () => true, shortcutLabel: null },
    composer: { draft: () => "", setDraft: () => {} },
    notify: () => {},
    activeTab: () => shown,
    chatOf: () => "s1",
    tabsOf: () => [1],
    // The background keeps the message as it was sent (runner deliver / lifecycle: user_message, voice).
    send: vi.fn(async (text: string, _target, extra) => {
      chat.push({ type: "user_message", text, voice: true, ...(extra?.heard?.length ? { heard: [...extra.heard] } : {}) });
      return "s1";
    }),
    panel: "p1",
    tabPage: async (id) => (id === 1 ? { title: "Intercom", url: "https://app.intercom.com/" } : { title: "Ticket", url: "https://tickets.example/" }),
    goToTab: () => {},
    onSpeaking: () => {},
    keepSpoken: () => {},
    // voice.heard: kept as a heard event.
    keepHeard: (_s, text) => void chat.push({ type: "heard", text }),
    settings: () => ({ voiceEngine: "realtime", realtimeCostNoticed: true }) as ExtensionSettings,
    account: () => undefined,
    engines: async () => ({ default: "realtime", engines: [{ id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 6, assumption: "", available: true }] }) as VoiceEnginesResponse,
    saveSettings: async () => {},
    openVoiceSettings: () => {},
    createEngine: (_id, events) =>
      new RealtimeEngine({
        ticket: async () => ({ url: "wss://x/v1/ai/realtime", token: "t" }),
        createSource: () => ({ start: async () => {}, stop: () => {} }),
        events,
        openSocket: () => {
          queueMicrotask(() => {
            socket.readyState = 1;
            socket.onopen?.({});
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
  // The user switches to tab `viewing`: the panel follows its window's active tab and looks again (sidepanel.ts setActive).
  shown = viewing;
  hf.refresh();
  await settle();
  return { socket, chat, deps };
}

/**
 * One user turn (input item `id`): its reply speaks ("speaks"), says nothing ("silent": one request split by server
 * VAD, its earlier parts), or calls send_to_agent with `request`; its words before or after.
 */
async function turn(s: FakeOpenAi, id: string, words: string, request: string | "speaks" | "silent", wordsLate: boolean): Promise<void> {
  const transcribed = () => s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: words });
  s.event({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 });
  s.event({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 3000 });
  s.event({ type: "input_audio_buffer.committed", item_id: id });
  s.event({ type: "response.created", response: { id: `r_${id}` } });
  if (!wordsLate) transcribed();
  if (request === "speaks") s.event({ type: "response.output_audio.delta", item_id: `a_${id}`, delta: "AAAA" });
  else if (request !== "silent") {
    s.event({ type: "response.output_item.added", item: { type: "function_call", name: "send_to_agent" } });
    s.event({ type: "response.function_call_arguments.done", call_id: `c_${id}`, name: "send_to_agent", arguments: JSON.stringify({ text: request }) });
  }
  s.event({ type: "response.done", response: { id: `r_${id}`, status: "completed", output: [] } });
  if (wordsLate) transcribed();
  await settle(30);
}

/** What the chat shows for the user: each message's text, and the words folded under it. */
function userBubbles(events: readonly AgentEvent[]): { text: string; heard?: string[] }[] {
  return events.flatMap((ev) => {
    const v = describeEvent(ev);
    return v.kind === "user" ? [{ text: v.text, ...(v.heard ? { heard: v.heard } : {}) }] : [];
  });
}

describe("Realtime: one message per request, the user's words folded under it", () => {
  beforeAll(installMiniDom);

  for (const viewing of [1, 2]) {
    for (const wordsLate of [false, true]) {
      it(`looking at ${viewing === 1 ? "the session's tab" : "another tab"}, words ${wordsLate ? "after" : "before"} the call: the request is the message, its words under it, never two bubbles`, async () => {
        const t = await session(viewing);
        await turn(t.socket, "in1", W1, "speaks", wordsLate);
        await turn(t.socket, "in2", W2, "speaks", wordsLate);
        await turn(t.socket, "in3", W3, REQUEST, wordsLate);
        // Late or repeated transcription events of settled items add nothing.
        t.socket.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "in3", content_index: 0, transcript: W3 });
        t.socket.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "in3", error: { message: "x" } });
        await settle(30);
        // The agent got the narrator's request only (with the note on the tab the user looks at, when away).
        expect(t.deps.send).toHaveBeenCalledTimes(1);
        expect((t.deps.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(/^Forget that for now\. I want you to look at Intercom/);
        // One message: the request as understood, with every part of the speech that led to it (the narrator's replies
        // to the first two answered a request by itself, so they were never heard: those parts are the request's too).
        expect(userBubbles(t.chat)).toEqual([{ text: REQUEST, heard: [W1, W2, W3] }]);
        expect(t.chat.filter((e) => e.type === "heard")).toEqual([]);
      });
    }
  }

  it("one request split by server VAD into three turns (the owner's report): one message, all three parts under it, in order", async () => {
    const t = await session(1);
    const parts = [
      "You, like, you barely.",
      "Skim through my, you know, previous posts. You know, you should be, like, going through pages and pages just so you get a better understanding of.",
      "You know, how, like, how my mind works.",
    ];
    const request = "Skim through pages and pages of my previous posts to get a better understanding of how my mind works.";
    await turn(t.socket, "p1", parts[0]!, "silent", false);
    await turn(t.socket, "p2", parts[1]!, "silent", false);
    await turn(t.socket, "p3", parts[2]!, request, false);
    expect(userBubbles(t.chat)).toEqual([{ text: request, heard: parts }]);
    expect(t.chat.filter((e) => e.type === "heard")).toEqual([]);
  });
});
