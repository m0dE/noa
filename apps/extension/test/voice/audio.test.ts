import { VOICE_TUNING } from "@noa/shared";
import { describe, expect, it } from "vitest";
import { FrameBuffer, SpeechDetector, meterLevel, rms } from "../../src/voice/speech.js";
import { Resampler, encodeWav, toInt16 } from "../../src/voice/wav.js";
import { FRAME, hush, sine, tone } from "./fakes.js";

describe("WAV encoding", () => {
  it("writes a 16 kHz mono 16-bit PCM header and the samples", () => {
    const wav = encodeWav(Int16Array.from([0, 1000, -1000, 32767]), 16_000);
    const v = new DataView(wav.buffer);
    const ascii = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint32(28, true), v.getUint16(34, true)]).toEqual([1, 1, 16_000, 32_000, 16]);
    expect(v.getUint32(40, true)).toBe(8);
    expect(Array.from(new Int16Array(wav.buffer, 44))).toEqual([0, 1000, -1000, 32767]);
  });

  it("converts floats to 16-bit, clipping out-of-range samples", () => {
    expect(Array.from(toInt16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2])))).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
  });
});

describe("Resampler", () => {
  it("passes audio through at the same rate", () => {
    const x = Float32Array.from([0.1, 0.2]);
    expect(new Resampler(16_000, 16_000).push(x)).toBe(x);
  });

  it("turns 48 kHz into 16 kHz, the same whether it arrives in one piece or in chunks", () => {
    const input = sine(1000, 0.5, 440, 48_000);
    const whole = new Resampler(48_000, 16_000).push(input);
    const r = new Resampler(48_000, 16_000);
    const parts: number[] = [];
    for (let at = 0; at < input.length; at += 128) parts.push(...r.push(input.subarray(at, at + 128)));
    expect(Math.abs(whole.length - 16_000)).toBeLessThanOrEqual(1);
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i]!, 6);
  });

  it("keeps a speech-band tone and damps one above the new Nyquist frequency", () => {
    const keep = new Resampler(48_000, 16_000).push(sine(500, 0.5, 440, 48_000));
    const fold = new Resampler(48_000, 16_000).push(sine(500, 0.5, 15_000, 48_000));
    expect(rms(keep)).toBeGreaterThan(0.3);
    expect(rms(fold)).toBeLessThan(rms(keep) / 2);
  });

  it("handles 44.1 kHz", () => {
    const out = new Resampler(44_100, 16_000).push(sine(1000, 0.5, 300, 44_100));
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
  });
});

describe("SpeechDetector", () => {
  const frames = (samples: Float32Array) => {
    const out: Float32Array[] = [];
    for (let at = 0; at + FRAME <= samples.length; at += FRAME) out.push(samples.subarray(at, at + FRAME));
    return out;
  };

  it("starts speech after the debounce and keeps it through syllable dips", () => {
    const d = new SpeechDetector();
    const verdicts = frames(tone(2000)).map((f) => d.push(f));
    const startAt = verdicts.findIndex((v) => v.started);
    expect(startAt).toBeGreaterThanOrEqual(VOICE_TUNING.speechStartMs / VOICE_TUNING.frameMs - 1);
    expect(startAt).toBeLessThan(10);
    expect(verdicts.filter((v) => v.started)).toHaveLength(1);
    expect(verdicts.slice(startAt).every((v) => v.speech)).toBe(true);
  });

  it("ends speech after the hangover", () => {
    const d = new SpeechDetector();
    for (const f of frames(tone(1125))) d.push(f); // ends on a syllable peak
    const after = frames(hush(1000)).map((f) => d.push(f).speech);
    const hangover = VOICE_TUNING.speechHangoverMs / VOICE_TUNING.frameMs;
    expect(after.slice(0, hangover - 1).every(Boolean)).toBe(true);
    expect(after.slice(hangover + 2).some(Boolean)).toBe(false);
  });

  it("ignores a short click and quiet hiss", () => {
    const d = new SpeechDetector();
    const click = new Float32Array(FRAME * 2).fill(0.3);
    const verdicts = [...frames(hush(500)), ...frames(click), ...frames(hush(500))].map((f) => d.push(f));
    expect(verdicts.some((v) => v.speech)).toBe(false);
  });

  it("stops counting a steady hum as speech after a few seconds", () => {
    const d = new SpeechDetector();
    const verdicts = frames(sine(15_000, 0.03)).map((f) => d.push(f));
    expect(verdicts[20]!.speech).toBe(true); // it is loud at first...
    expect(verdicts.at(-1)!.speech).toBe(false); // ...until the floor catches up
  });

  it("maps RMS to a 0..1 meter", () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(0.001)).toBe(0); // -60 dBFS
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(0.05)).toBeGreaterThan(0.5);
  });
});

describe("FrameBuffer", () => {
  const buffer = (...parts: Float32Array[]) => {
    const b = new FrameBuffer();
    for (const p of parts) b.append(p);
    return b;
  };
  const ms = (b: FrameBuffer, frames: number) => b.ms(frames);

  it("cuts audio into frames, keeping the remainder for the next append", () => {
    const b = new FrameBuffer();
    expect(b.append(new Float32Array(FRAME + 10))).toHaveLength(1);
    expect(b.append(new Float32Array(FRAME - 10))).toHaveLength(1);
    expect(b.length).toBe(2);
  });

  it("trims a range to its speech plus the pre- and post-roll", () => {
    const b = buffer(hush(1000), tone(1000), hush(1000));
    const r = b.trimmed({ from: 0, to: b.length })!;
    expect(ms(b, r.from)).toBe(1000 - VOICE_TUNING.preRollMs);
    const expectedEnd = 2000 + VOICE_TUNING.speechHangoverMs + VOICE_TUNING.postRollMs;
    expect(Math.abs(ms(b, r.to) - expectedEnd)).toBeLessThanOrEqual(60);
    expect(b.trimmed({ from: 0, to: b.framesIn(900) })).toBeNull();
  });

  it("finds the latest pause, its middle as the cut point", () => {
    const b = buffer(tone(2000), hush(600), tone(2000), hush(800), tone(1000));
    const cut = b.latestPause({ from: 0, to: b.length })!;
    // The later pause (4.6 s to 5.4 s, minus the hangover) is chosen, not the first.
    expect(ms(b, cut)).toBeGreaterThan(4600);
    expect(ms(b, cut)).toBeLessThan(5400);
    expect(b.latestPause({ from: 0, to: b.framesIn(2000) })).toBeNull();
  });

  it("gives back the samples of a range and finds its quietest frame", () => {
    const b = buffer(tone(500), hush(100), tone(500));
    expect(b.samples({ from: 2, to: 5 })).toHaveLength(3 * FRAME);
    const q = b.quietest({ from: 0, to: b.length });
    expect(ms(b, q)).toBeGreaterThanOrEqual(500);
    expect(ms(b, q)).toBeLessThan(600);
  });
});
