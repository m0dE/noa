import { describe, expect, it, vi } from "vitest";
import { VOICE_LIMITS } from "@noa/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import { HANDS_FREE } from "../../src/voice/hands-free.js";
import { StandardEngine } from "../../src/voice/standard-engine.js";

class FakeMic implements AudioSource {
  deliver: ((s: Float32Array) => void) | null = null;
  async start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.deliver = onSamples;
  }
  stop(): void {
    this.deliver = null;
  }
  /** `ms` of a voice-like tone (loud) or near silence, in 20 ms chunks. */
  play(ms: number, loud: boolean): void {
    const n = Math.round((VOICE_LIMITS.sampleRate * 20) / 1000);
    for (let t = 0; t < ms; t += 20) {
      const chunk = new Float32Array(n);
      for (let i = 0; i < n; i++) chunk[i] = loud ? 0.3 * Math.sin((2 * Math.PI * 220 * (t * 16 + i)) / VOICE_LIMITS.sampleRate) : 0.0005 * Math.sin(i);
      this.deliver?.(chunk);
    }
  }
}

function events(): EngineEvents & { log: string[]; captured: number } {
  const log: string[] = [];
  const ev = {
    log,
    captured: 0,
    speech: () => void log.push("speech"),
    heard: (text, forward) => void log.push(`heard:${text}:${forward}`),
    partial: () => {},
    level: () => {},
    openingMic: () => {},
    capturing: () => void ev.captured++,
    narrating: () => {},
    said: () => void log.push("said"),
    narratorText: () => {},
    forward: () => {},
    userWords: () => {},
    stopTask: async () => "",
    answerApproval: async () => "",
    endVoice: () => {},
    useThisTab: async () => "",
    failed: (err: unknown) => void log.push(`failed:${String(err)}`),
  } satisfies EngineEvents & { log: string[]; captured: number };
  return ev;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(speaking = false) {
  const mic = new FakeMic();
  const ev = events();
  const speaker = { speaking, speak: vi.fn(async () => {}), cancel: vi.fn() };
  const transcribe = vi.fn(async () => "open gmail");
  const engine = new StandardEngine({ createSource: () => mic, transcribe, speaker, events: ev });
  return { mic, ev, speaker, transcribe, engine };
}

describe("StandardEngine", () => {
  it("says when the microphone's first audio reaches it (once; muted, none does)", async () => {
    const { mic, ev, engine } = setup();
    engine.setMuted(true);
    await engine.start();
    mic.play(100, false);
    expect(ev.captured).toBe(0);
    engine.setMuted(false);
    mic.play(100, false);
    expect(ev.captured).toBe(1);
    engine.stop();
  });

  it("an utterance followed by a pause is reported once as speech, then heard (for the agent)", async () => {
    const { mic, ev, engine } = setup();
    await engine.start();
    engine.setTranscribing(true);
    await settle();
    mic.play(300, false);
    mic.play(900, true);
    expect(ev.log).toEqual(["speech"]);
    mic.play(1500, false);
    await settle();
    await settle();
    expect(ev.log).toEqual(["speech", "heard:open gmail:true"]);
    engine.stop();
  });

  it("while a line is said nothing is transcribed; only speech longer than HANDS_FREE.bargeInMs is reported (barge-in)", async () => {
    const { mic, ev, engine, transcribe } = setup(true);
    await engine.start();
    engine.setTranscribing(false);
    mic.play(HANDS_FREE.bargeInMs - 100, true);
    mic.play(1500, false);
    expect(ev.log).toEqual([]);
    mic.play(HANDS_FREE.bargeInMs + 100, true);
    expect(ev.log).toEqual(["speech"]);
    mic.play(1500, false);
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
    engine.stop();
  });

  it("says lines; a line cut off by hush (or a newer line) does not report its end", async () => {
    const { ev, engine, speaker } = setup();
    let finish!: () => void;
    speaker.speak.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    engine.speak("Opening x.com");
    engine.hush();
    finish();
    await settle();
    expect(ev.log).toEqual([]);
    engine.speak("Done.");
    await settle();
    expect(ev.log).toEqual(["said"]);
    expect(speaker.cancel).toHaveBeenCalled();
  });
});

describe("StandardEngine: timing trace", () => {
  function traced(speaking = false) {
    const mic = new FakeMic();
    const ev = events();
    const records: { name: string; cid?: string; data?: Record<string, unknown> }[] = [];
    const trace = { record: (e: { name: string; cid?: string; data?: Record<string, unknown> }) => void records.push(e), utterance: () => "u1", useUtterance: () => {}, endUtterance: () => {} };
    let onStart: (() => void) | undefined;
    const speaker = {
      speaking,
      speak: vi.fn(async (_text: string, opts?: { onStart?: () => void }) => {
        onStart = opts?.onStart;
        onStart?.();
      }),
      cancel: vi.fn(),
    };
    const transcribe = vi.fn(async () => "open gmail");
    const engine = new StandardEngine({ createSource: () => mic, transcribe, speaker, events: ev, trace, model: () => "@cf/deepgram/nova-3" });
    return { mic, ev, engine, records };
  }

  it("speech start, then the transcript from the end of speech: its requests, round trip, size and model", async () => {
    const { mic, engine, records } = traced();
    await engine.start();
    engine.setTranscribing(true);
    await settle();
    mic.play(900, true);
    mic.play(1500, false);
    await settle();
    await settle();
    expect(records.map((r) => r.name)).toEqual(["voice.speech", "voice.transcript"]);
    expect(records[0]!.cid).toBe("u1");
    expect(records[1]).toMatchObject({ cid: "u1", data: { chars: 10, reason: "send", model: "@cf/deepgram/nova-3" } });
    const d = records[1]!.data!;
    expect(d.requests).toBeGreaterThanOrEqual(1);
    for (const k of ["lastRequestMs", "lastKB", "waitMs"]) expect(typeof d[k]).toBe("number");
    engine.stop();
  });

  it("each line said: queued to started (waited) and its whole length, and whether it was cut off", async () => {
    const { engine, records } = traced();
    engine.speak("Opening Gmail.");
    await settle();
    expect(records).toEqual([expect.objectContaining({ name: "voice.tts", data: expect.objectContaining({ chars: 14, cut: false, startMs: expect.any(Number), waitMs: expect.any(Number) }) })]);
  });

  it("a barge-in is recorded as such", async () => {
    const { mic, engine, records } = traced(true);
    await engine.start();
    engine.setTranscribing(false);
    mic.play(HANDS_FREE.bargeInMs + 100, true);
    expect(records.map((r) => r.name)).toEqual(["voice.barge_in"]);
    engine.stop();
  });
});

describe("StandardEngine: muted", () => {
  it("transcribes nothing while muted (the utterance under way is dropped, not sent), and listens again when unmuted", async () => {
    const { mic, ev, engine, transcribe } = setup();
    const levels: number[] = [];
    ev.level = (l) => void levels.push(l);
    await engine.start();
    engine.setTranscribing(true);
    await settle();
    mic.play(900, true);
    expect(ev.log).toEqual(["speech"]);
    const calls = transcribe.mock.calls.length;
    engine.setMuted(true);
    // The meter falls to nothing at once.
    expect(levels.at(-1)).toBe(0);
    levels.length = 0;
    mic.play(1500, false);
    mic.play(900, true);
    mic.play(1500, false);
    // Half-duplex asks for transcription again after a line: muted, it still waits.
    engine.setTranscribing(false);
    engine.setTranscribing(true);
    mic.play(900, true);
    mic.play(1500, false);
    await settle();
    await settle();
    expect(ev.log).toEqual(["speech"]);
    expect(transcribe.mock.calls.length).toBe(calls);
    expect(levels).toEqual([]);
    engine.setMuted(false);
    await settle();
    mic.play(300, false);
    mic.play(900, true);
    mic.play(1500, false);
    await settle();
    await settle();
    expect(ev.log).toEqual(["speech", "speech", "heard:open gmail:true"]);
    engine.stop();
  });

  it("muted while a line is said: speech cannot cut it off", async () => {
    const { mic, ev, engine } = setup(true);
    await engine.start();
    engine.setTranscribing(false);
    engine.setMuted(true);
    mic.play(HANDS_FREE.bargeInMs + 400, true);
    expect(ev.log).toEqual([]);
    engine.stop();
  });

  it("muted before it starts: the microphone opens muted", async () => {
    const { mic, ev, engine, transcribe } = setup();
    engine.setMuted(true);
    await engine.start();
    engine.setTranscribing(true);
    mic.play(900, true);
    mic.play(1500, false);
    await settle();
    expect(ev.log).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
    engine.stop();
  });
});
