/**
 * Regression (production trace, scheduled "Post one new original post on X" run with the Post click waiting for
 * approval): the user opened voice and asked "So why is it talking about Sunday 1 PM on the rooftop?", then
 * "I'm asking you a question". Neither is a yes. A narrator's answer_approval {allow: true} after such words must
 * not allow the waiting action: only an explicit yes from the user does.
 */
import { describe, expect, it, vi } from "vitest";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import { explicitYes, namesAction } from "../../src/voice/approval-voice.js";

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
  async start(): Promise<void> {}
  stop(): void {}
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function started() {
  const socket = new FakeSocket();
  const answers: boolean[] = [];
  const noop = () => {};
  const events: EngineEvents = {
    speech: noop,
    heard: noop,
    partial: noop,
    level: noop,
    openingMic: noop,
    capturing: noop,
    narrating: noop,
    said: noop,
    narratorText: noop,
    forward: noop,
    userWords: noop,
    stopTask: async () => "Stopped the task.",
    answerApproval: async (allow: boolean) => (answers.push(allow), allow ? "Allowed: the task goes on." : "Denied: it will not be done."),
    endVoice: noop,
    useThisTab: async () => "",
    failed: noop,
  };
  const engine = new RealtimeEngine({
    ticket: async () => ({ url: "wss://api.test/v1/ai/realtime", token: "tok" }),
    createSource: () => new FakeMic(),
    events,
    openSocket: () => socket,
    player: { play: vi.fn(), stop: vi.fn(() => ({ itemId: "a1", playedMs: 0 })), close: vi.fn(), playing: false },
  });
  const start = engine.start();
  await settle();
  socket.readyState = 1;
  socket.onopen?.({});
  socket.event({ type: "session.created", session: { type: "realtime" } });
  await start;
  return { socket, answers, engine };
}

function userSaid(s: FakeSocket, words: string, id: string): void {
  s.event({ type: "input_audio_buffer.committed", item_id: id });
  s.event({ type: "response.created", response: { id: `r_${id}` } });
  s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: words });
}

describe("Realtime answer_approval (production trace)", () => {
  it("the user only asked questions (no yes): the narrator's answer_approval {allow: true} does not allow the waiting Post click", async () => {
    const t = await started();
    t.engine.agentEvent(
      { type: "approval_request", request: { id: "ap1", action: 'Click "Post"', site: "x.com", why: "publishes", kind: "publish", text: "Sunday 1pm on the rooftop…", expiresAt: new Date(Date.now() + 600_000).toISOString() } },
      Date.now(),
    );
    userSaid(t.socket, "So why is it talking about Sunday 1 PM on the rooftop?", "u1");
    t.socket.event({ type: "response.done", response: { id: "r_u1", status: "completed" } });
    userSaid(t.socket, "I'm asking you a question", "u2");
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "answer_approval", arguments: JSON.stringify({ allow: true }) });
    await settle();
    await settle();
    const output = t.socket.sent.find((e) => e.item?.type === "function_call_output")?.item.output;
    console.log(`[repro] answerApproval calls: ${JSON.stringify(t.answers)}; narrator was told: ${JSON.stringify(output)}`);
    expect(t.answers).not.toContain(true);
  });
});

describe("Realtime answer_approval: a spoken allow needs the user's plain yes and the action named", () => {
  const POST_REQUEST = { type: "approval_request" as const, request: { id: "ap1", action: 'Click "Post"', site: "x.com", why: "publishes", kind: "publish" as const, expiresAt: new Date(Date.now() + 600_000).toISOString() } };

  async function answered(words: string, args: Record<string, unknown>) {
    const t = await started();
    t.engine.agentEvent(POST_REQUEST, Date.now());
    userSaid(t.socket, words, "u1");
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "answer_approval", arguments: JSON.stringify(args) });
    await settle();
    await settle();
    const output = t.socket.sent.find((e) => e.item?.type === "function_call_output")?.item.output as string | undefined;
    return { answers: t.answers, output };
  }

  it("'Yes, post it' with the action named allows it", async () => {
    const r = await answered("Yes, post it.", { allow: true, action: 'Click "Post"' });
    expect(r.answers).toEqual([true]);
  });

  it("a yes without the action named is refused; the narrator is told what to say", async () => {
    const r = await answered("Yes.", { allow: true });
    expect(r.answers).toEqual([]);
    expect(r.output).toMatch(/Click "Post"/);
  });

  it("a question is never a yes; the narrator is told to ask plainly", async () => {
    const r = await answered("Yes? Why Sunday?", { allow: true, action: 'Click "Post"' });
    expect(r.answers).toEqual([]);
    expect(r.output).toMatch(/Ask them plainly/);
  });

  it("a no always stands", async () => {
    const r = await answered("No, don't.", { allow: false });
    expect(r.answers).toEqual([false]);
  });

  it("nothing waiting: nothing is allowed", async () => {
    const t = await started();
    userSaid(t.socket, "Yes, go ahead", "u1");
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "answer_approval", arguments: JSON.stringify({ allow: true, action: 'Click "Post"' }) });
    await settle();
    await settle();
    expect(t.answers).toEqual([]);
  });
});

describe("explicitYes / namesAction", () => {
  it("plain yes in the languages voice listens in", () => {
    for (const yes of ["Yes", "yeah, go ahead", "Okay, post it.", "Allow it please", "네, 올려줘", "はい", "是的", "Sí, adelante", "Oui, vas-y", "Ja, mach es", "Да, давай"]) {
      expect(explicitYes(yes), yes).toBe(true);
    }
  });

  it("questions, noes, waits and remarks are not a yes", () => {
    for (const not of ["So why is it talking about Sunday 1 PM on the rooftop?", "I'm asking you a question", "yes?", "No", "Wait, yes", "not yet", "为什么是周日", "왜 일요일이야", "hmm", ""]) {
      expect(explicitYes(not), not).toBe(false);
    }
  });

  it("the narrator names the waiting action by its label", () => {
    expect(namesAction('Click "Post"', 'Click "Post"')).toBe(true);
    expect(namesAction("post", 'Click "Post"')).toBe(true);
    expect(namesAction("reply", 'Click "Post"')).toBe(false);
    expect(namesAction("", 'Click "Post"')).toBe(false);
    expect(namesAction("open x.com/compose/post", "Open x.com/compose/post")).toBe(true);
  });
});
