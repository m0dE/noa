/**
 * Speech detection over fixed frames, and the buffer of captured frames the
 * dictation reads clips from. Pure: no DOM, no timers.
 */
import { VOICE_LIMITS, VOICE_TUNING } from "@noa/shared";

export type Tuning = typeof VOICE_TUNING;

/** Root mean square of samples in -1..1. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** RMS as a 0..1 meter value: -60 dBFS and below is 0, -12 dBFS and above is 1. */
export function meterLevel(r: number): number {
  if (r <= 0) return 0;
  const db = 20 * Math.log10(r);
  return Math.max(0, Math.min(1, (db + 60) / 48));
}

export interface FrameVerdict {
  rms: number;
  /** Louder than the noise floor by the configured margin. */
  loud: boolean;
  /** Speech started on this frame: the loud frames just before it were speech too. */
  started: boolean;
  /** Inside speech: from a debounced start until the hangover runs out. */
  speech: boolean;
}

/**
 * Energy speech detector with an adaptive noise floor. A frame is loud when
 * its RMS is `speechOverNoise` times the floor and at least `minSpeechRms`.
 * Speech starts after `speechStartMs` of loud frames and ends after
 * `speechHangoverMs` without one. The floor tracks the minimum: down fast to
 * any quieter frame, up slowly otherwise.
 */
export class SpeechDetector {
  private floor: number;
  private loudRun = 0;
  private quietRun = 0;
  private inSpeech = false;
  readonly startFrames: number;
  private readonly hangoverFrames: number;

  constructor(private readonly t: Tuning = VOICE_TUNING) {
    this.floor = t.minSpeechRms / t.speechOverNoise;
    this.startFrames = Math.max(1, Math.round(t.speechStartMs / t.frameMs));
    this.hangoverFrames = Math.max(1, Math.round(t.speechHangoverMs / t.frameMs));
  }

  push(frame: Float32Array): FrameVerdict {
    const r = rms(frame);
    const loud = r >= Math.max(this.t.minSpeechRms, this.floor * this.t.speechOverNoise);
    this.floor += (r - this.floor) * (r < this.floor ? this.t.noiseFloorFall : this.t.noiseFloorRise);
    this.loudRun = loud ? this.loudRun + 1 : 0;
    this.quietRun = loud ? 0 : this.quietRun + 1;
    let started = false;
    if (!this.inSpeech && this.loudRun >= this.startFrames) this.inSpeech = started = true;
    else if (this.inSpeech && this.quietRun >= this.hangoverFrames) this.inSpeech = false;
    return { rms: r, loud, started, speech: this.inSpeech };
  }
}

/** A closed-open range of frame indexes. */
export interface FrameRange {
  from: number;
  to: number;
}

/**
 * Captured audio cut into frames of `frameMs`, each with its speech flag.
 * Frames are indexed from the start of the session.
 */
export class FrameBuffer {
  readonly frameSamples: number;
  private readonly frames: Float32Array[] = [];
  private readonly speech: boolean[] = [];
  private readonly energy: number[] = [];
  private pending = new Float32Array(0);
  private readonly detector: SpeechDetector;
  private readonly startFrames: number;

  constructor(
    readonly sampleRate: number = VOICE_LIMITS.sampleRate,
    private readonly t: Tuning = VOICE_TUNING,
  ) {
    this.frameSamples = Math.round((sampleRate * t.frameMs) / 1000);
    this.detector = new SpeechDetector(t);
    this.startFrames = this.detector.startFrames;
  }

  get length(): number {
    return this.frames.length;
  }

  /** Milliseconds of audio in `n` frames. */
  ms(n: number): number {
    return n * this.t.frameMs;
  }

  /** Frames in `ms` milliseconds (rounded up). */
  framesIn(ms: number): number {
    return Math.ceil(ms / this.t.frameMs);
  }

  /** Appends samples; returns the verdict of every frame they completed. */
  append(samples: Float32Array): FrameVerdict[] {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    const verdicts: FrameVerdict[] = [];
    let at = 0;
    for (; at + this.frameSamples <= joined.length; at += this.frameSamples) {
      const frame = joined.slice(at, at + this.frameSamples);
      const v = this.detector.push(frame);
      this.frames.push(frame);
      this.energy.push(v.rms);
      this.speech.push(v.speech);
      // The loud frames that led up to a debounced start were speech too.
      if (v.started) for (let k = 1; k < this.startFrames; k++) this.speech[this.speech.length - 1 - k] = true;
      verdicts.push(v);
    }
    this.pending = joined.slice(at);
    return verdicts;
  }

  /** Speech frames in `r`. */
  speechFrames(r: FrameRange): number {
    let n = 0;
    for (let i = r.from; i < r.to; i++) if (this.speech[i]) n++;
    return n;
  }

  /** `r` trimmed to its speech plus the pre- and post-roll; null when it has no speech. */
  trimmed(r: FrameRange): FrameRange | null {
    let first = -1;
    let last = -1;
    for (let i = r.from; i < r.to; i++) {
      if (!this.speech[i]) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return null;
    return {
      from: Math.max(r.from, first - this.framesIn(this.t.preRollMs)),
      to: Math.min(r.to, last + 1 + this.framesIn(this.t.postRollMs)),
    };
  }

  /**
   * Where finalised text may end inside `r`: the middle of the latest pause of
   * at least `commitPauseMs`, or null when there is none.
   */
  latestPause(r: FrameRange): number | null {
    const need = this.framesIn(this.t.commitPauseMs);
    let run = 0;
    for (let i = r.to - 1; i >= r.from; i--) {
      if (this.speech[i]) {
        if (run >= need) return i + 1 + Math.floor(run / 2);
        run = 0;
      } else run++;
    }
    return null;
  }

  /** The quietest frame in `r` (a cut point when someone talks without pausing). */
  quietest(r: FrameRange): number {
    let best = r.from;
    for (let i = r.from; i < r.to; i++) if (this.energy[i]! < this.energy[best]!) best = i;
    return best;
  }

  /** The samples of `r`, as 16-bit PCM input (floats). */
  samples(r: FrameRange): Float32Array {
    const out = new Float32Array(Math.max(0, r.to - r.from) * this.frameSamples);
    for (let i = r.from; i < r.to; i++) out.set(this.frames[i]!, (i - r.from) * this.frameSamples);
    return out;
  }
}
