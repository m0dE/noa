import { VOICE_LIMITS, VOICE_TUNING } from "@noa/shared";
import { describe, expect, it } from "vitest";
import { Dictation, joinText, type DictationState, type TranscribeClip } from "../../src/voice/dictation.js";
import { FakeSource, flush, hush, manualTranscriber, tone } from "./fakes.js";

function setup(transcribe: TranscribeClip, source = new FakeSource()) {
  const states: DictationState[] = [];
  const texts: string[] = [];
  const levels: number[] = [];
  const d = new Dictation({
    source,
    transcribe,
    events: { onState: (s) => states.push(s), onText: (t) => texts.push(t), onLevel: (l) => levels.push(l) },
  });
  return { d, source, states, texts, levels };
}

/** Feeds `samples` in real-time-sized steps, letting replies land between steps. */
async function speak(source: FakeSource, samples: Float32Array, stepMs = 100): Promise<void> {
  const step = (VOICE_LIMITS.sampleRate * stepMs) / 1000;
  for (let at = 0; at < samples.length; at += step) {
    source.feed(samples.subarray(at, Math.min(samples.length, at + step)));
    await flush();
  }
}

/** A transcriber that answers every clip at once, recording the audio seconds it was sent. */
function instantTranscriber(reply: (n: number, seconds: number) => string = (n) => `part${n}`) {
  const seconds: number[] = [];
  const contexts: (string | undefined)[] = [];
  const fn: TranscribeClip = async (wav, req) => {
    const s = (wav.byteLength - 44) / 2 / VOICE_LIMITS.sampleRate;
    seconds.push(s);
    contexts.push(req.context);
    return reply(seconds.length, s);
  };
  return { fn, seconds, contexts };
}

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("Dictation state machine", () => {
  it("goes idle -> listening -> transcribing -> done, and Enter returns the final text", async () => {
    const t = manualTranscriber();
    const { d, source, states } = setup(t.fn);
    expect(d.state).toBe("idle");
    const result = d.run();
    await flush();
    expect(d.state).toBe("listening");
    source.feed(tone(1500));
    expect(t.calls).toHaveLength(1); // one partial after 1 s of speech
    void d.stop("send");
    expect(source.stopped).toBe(true);
    expect(d.state).toBe("transcribing");
    await flush();
    expect(t.calls[0]!.req.signal.aborted).toBe(true); // the stale partial is dropped
    expect(t.pending()).toHaveLength(1);
    t.pending()[0]!.resolve("Open Gmail.");
    expect(await result).toEqual({ text: "Open Gmail.", reason: "send" });
    expect(states).toEqual(["listening", "transcribing", "done"]);
  });

  it("sends only the speech, with a little audio around it, and says how much speech it heard", async () => {
    const t = manualTranscriber();
    const { d, source } = setup(t.fn);
    const result = d.run();
    await flush();
    source.feed(concat(hush(1000), tone(1000), hush(900)));
    void d.stop("send");
    await flush();
    const final = t.pending()[0]!;
    // Speech lasts the hangover past the last loud frame; the clip adds the pre- and post-roll around it.
    const speech = 1000 + VOICE_TUNING.speechHangoverMs;
    expect(final.seconds).toBeCloseTo((VOICE_TUNING.preRollMs + speech + VOICE_TUNING.postRollMs) / 1000, 1);
    expect(Math.abs(final.req.speechMs - speech)).toBeLessThanOrEqual(60);
    final.resolve("Hi");
    await result;
  });

  it("sends nothing for silence and keeps listening (the utterance's end is the endpointer's to find)", async () => {
    const t = manualTranscriber();
    const { d, source } = setup(t.fn);
    void d.run();
    await flush();
    source.feed(hush(20_000));
    expect(d.state).toBe("listening");
    expect(t.calls).toHaveLength(0);
    expect(source.stopped).toBe(false);
    d.cancel();
  });

  it("stops at the 60 second cap", async () => {
    const t = instantTranscriber((n) => `p${n}`);
    const { d, source } = setup(t.fn);
    const result = d.run();
    await flush();
    // Speech with a breath every 3 s, like someone reading a long request.
    const talk = concat(...Array.from({ length: 22 }, () => concat(tone(2600), hush(400))));
    await speak(source, talk);
    const r = await result;
    expect(r.reason).toBe("cap");
    expect(source.stopped).toBe(true);
    expect(Math.max(...t.seconds)).toBeLessThanOrEqual(VOICE_LIMITS.maxClipMs / 1000);
  });

  it("Esc cancels: discards the text, aborts the request and releases the microphone", async () => {
    const t = manualTranscriber();
    const { d, source, states } = setup(t.fn);
    const result = d.run();
    await flush();
    source.feed(tone(1500));
    d.cancel();
    expect(await result).toEqual({ text: "", reason: "cancel" });
    expect(t.calls[0]!.req.signal.aborted).toBe(true);
    expect(source.stopped).toBe(true);
    expect(states.at(-1)).toBe("cancelled");
    t.calls[0]!.resolve("late"); // a late reply changes nothing
    await flush();
    expect(d.text).toBe("");
  });

  it("stopping while the microphone opens ends with nothing heard", async () => {
    const source = new FakeSource(false);
    const { d } = setup(manualTranscriber().fn, source);
    const result = d.run();
    void d.stop("send");
    source.open();
    expect(await result).toEqual({ text: "", reason: "send" });
    expect(source.stopped).toBe(true);
    expect(d.state).toBe("done");
  });

  it("fails when the microphone cannot open", async () => {
    const source = new FakeSource(false);
    const { d, states } = setup(manualTranscriber().fn, source);
    const result = d.run();
    source.fail(new DOMException("denied", "NotAllowedError"));
    await expect(result).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(states).toEqual(["error"]);
  });

  it("reports a smoothed level that rises with speech", async () => {
    const { d, source, levels } = setup(manualTranscriber().fn);
    void d.run();
    await flush();
    source.feed(hush(300));
    const quiet = levels.at(-1)!;
    source.feed(tone(300, 0.2));
    expect(quiet).toBeLessThan(0.2);
    expect(levels.at(-1)!).toBeGreaterThan(0.6);
    d.cancel();
  });
});

describe("live text", () => {
  it("re-transcribes about once a second with one request in flight, showing the newest text", async () => {
    const t = manualTranscriber();
    const { d, source, texts } = setup(t.fn);
    void d.run();
    await flush();
    source.feed(tone(3000));
    expect(t.calls).toHaveLength(1); // still in flight: no second request
    t.calls[0]!.resolve("Open");
    await flush();
    expect(texts).toEqual(["Open"]);
    expect(t.calls).toHaveLength(2); // the next one covers everything heard so far
    expect(t.calls[1]!.seconds).toBeGreaterThan(t.calls[0]!.seconds);
    t.calls[1]!.resolve("Open Gmail and");
    await flush();
    expect(texts.at(-1)).toBe("Open Gmail and");
    d.cancel();
  });

  it("does not re-send when nothing new was said", async () => {
    const t = instantTranscriber();
    const { d, source } = setup(t.fn);
    void d.run();
    await flush();
    await speak(source, tone(1100));
    await speak(source, hush(1500)); // one more for the speech after the first request
    const sent = t.seconds.length;
    await speak(source, hush(3000));
    expect(t.seconds.length).toBe(sent);
    d.cancel();
  });

  it("finalises older speech at a pause, then sends only the rest with it as context", async () => {
    const t = instantTranscriber();
    const { d, source } = setup(t.fn);
    const result = d.run();
    await flush();
    await speak(source, concat(tone(6000), hush(500), tone(6000)));
    void d.stop("send");
    const r = await result;
    // Partials grow by a second each until the window (10 s) is passed...
    expect(t.seconds.slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // ...then the part before the pause is finalised: 6 s of speech, the audio around it and half the pause.
    const commit = t.seconds[10]!;
    expect(commit).toBeGreaterThan(6);
    expect(commit).toBeLessThan(6.8);
    // Later requests carry only the audio after the pause, with the finalised text as context.
    const finalised = "part11";
    expect(t.contexts.slice(11).every((c) => c === finalised)).toBe(true);
    expect(Math.max(...t.seconds.slice(11))).toBeLessThan(6.8);
    expect(r.text).toBe(`${finalised} part${t.seconds.length}`);
  });

  it("drops a partial that was made before the latest finalised point", async () => {
    const t = manualTranscriber();
    const { d, source, texts } = setup(t.fn);
    void d.run();
    await flush();
    source.feed(tone(1100)); // partial #1 in flight
    const stale = t.calls[0]!;
    // Simulate the finalising request completing first: reply to the partial after a commit happened.
    (d as unknown as { committedTo: number }).committedTo = 10;
    stale.resolve("stale words");
    await flush();
    expect(texts).toEqual([]);
    d.cancel();
  });

  it("keeps going after a failed partial, but ends on a fatal error", async () => {
    const t = manualTranscriber();
    const { d, source } = setup(t.fn);
    const result = d.run();
    await flush();
    source.feed(tone(1100));
    t.calls[0]!.reject(new Error("network blip"));
    await flush();
    source.feed(tone(1100));
    expect(t.calls).toHaveLength(2);
    t.calls[1]!.reject(Object.assign(new Error("Voice needs the Plus or Pro plan."), { fatal: true }));
    await expect(result).rejects.toThrow("Voice needs the Plus or Pro plan.");
    expect(d.state).toBe("error");
    expect(source.stopped).toBe(true);
  });

  it("fails when the final request fails", async () => {
    const t = manualTranscriber();
    const { d, source } = setup(t.fn);
    const result = d.run();
    await flush();
    source.feed(tone(500));
    void d.stop("send");
    await flush();
    t.pending()[0]!.reject(new Error("server down"));
    await expect(result).rejects.toThrow("server down");
  });

  it("bills a bounded multiple of the audio", async () => {
    // Continuous speech, replies instant (the worst case: a partial every second).
    const cost = async (talk: Float32Array) => {
      const t = instantTranscriber();
      const { d, source } = setup(t.fn);
      const result = d.run();
      await flush();
      await speak(source, talk);
      void d.stop("send");
      await result;
      return t.seconds.reduce((a, b) => a + b, 0) / (talk.length / VOICE_LIMITS.sampleRate);
    };
    const withBreaths = (seconds: number) => concat(...Array.from({ length: Math.round(seconds / 3) }, () => concat(tone(2600), hush(400))));
    expect(await cost(withBreaths(15))).toBeLessThan(7);
    expect(await cost(withBreaths(57))).toBeLessThan(7);
    expect(await cost(tone(15_000))).toBeLessThan(10);
  });
});

describe("joinText", () => {
  it("joins non-empty pieces with single spaces", () => {
    expect(joinText(" Open Gmail. ", "", "Reply to Sarah ")).toBe("Open Gmail. Reply to Sarah");
    expect(joinText("", "")).toBe("");
  });
});
