/** Synthetic audio and fakes for the voice tests. */
import { VOICE_LIMITS, VOICE_TUNING } from "@noa/shared";
import type { AudioSource, ClipRequest, TranscribeClip } from "../../src/voice/dictation.js";

export const RATE = VOICE_LIMITS.sampleRate;
export const FRAME = (RATE * VOICE_TUNING.frameMs) / 1000;

/**
 * `ms` of speech-like sound at peak `amp`: a 180 Hz voice with two harmonics,
 * shaped into syllables (4 per second) that dip close to silence between them.
 */
export function tone(ms: number, amp = 0.1, rate: number = RATE, hz = 180): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const syllable = Math.abs(Math.sin(Math.PI * 4 * t)) ** 0.6;
    const voice = Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.25 * Math.sin(6 * Math.PI * hz * t);
    out[i] = (amp / 1.75) * syllable * voice;
  }
  return out;
}

/** A steady sine (e.g. a hum), unlike speech. */
export function sine(ms: number, amp: number, hz = 120, rate: number = RATE): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** `ms` of near-silence (a faint hiss, so the noise floor has something to follow). */
export function hush(ms: number, amp = 0.0008, rate: number = RATE): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((seed / 0x7fffffff) * 2 - 1);
  }
  return out;
}

/** An AudioSource the test feeds by hand, in 32 ms chunks like the worklet sends. */
export class FakeSource implements AudioSource {
  private sink: ((s: Float32Array) => void) | null = null;
  started = false;
  stopped = false;
  private opened!: () => void;
  private failed!: (e: unknown) => void;
  private readonly opening: Promise<void>;

  constructor(private readonly auto = true) {
    this.opening = new Promise((res, rej) => ((this.opened = res), (this.failed = rej)));
    if (auto) this.opened();
  }

  start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.started = true;
    this.sink = onSamples;
    return this.opening;
  }

  /** Lets start() resolve (when constructed with auto = false). */
  open(): void {
    this.opened();
  }

  fail(err: unknown): void {
    this.failed(err);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Feeds samples in worklet-sized chunks. */
  feed(samples: Float32Array, chunk = 512): void {
    for (let at = 0; at < samples.length; at += chunk) this.sink?.(samples.subarray(at, Math.min(samples.length, at + chunk)));
  }
}

export interface ClipCall {
  seconds: number;
  req: ClipRequest;
  resolve(text: string): void;
  reject(err: unknown): void;
}

/** A TranscribeClip whose replies the test gives by hand. */
export function manualTranscriber() {
  const calls: ClipCall[] = [];
  const fn: TranscribeClip = (wav, req) =>
    new Promise<string>((resolve, reject) => {
      const seconds = (wav.byteLength - 44) / 2 / RATE;
      calls.push({ seconds, req, resolve, reject });
      req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  return { fn, calls, pending: () => calls.filter((c) => !c.req.signal.aborted) };
}

// Node's (the tests run in node; the extension's tsconfig has no node types).
declare function setImmediate(callback: () => void): unknown;

/** Lets pending promise callbacks run (setImmediate: timers are clamped to ~15 ms on Windows). */
export const flush = () => new Promise<void>((r) => setImmediate(r));
