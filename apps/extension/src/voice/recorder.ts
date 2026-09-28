/**
 * The microphone as an AudioSource: getUserMedia with the browser's noise
 * suppression, echo cancellation and gain control, captured as PCM by an
 * AudioWorklet (a ScriptProcessor where worklets are missing) and delivered
 * mono at the rate asked for: VOICE_LIMITS.sampleRate for Whisper, 24 kHz for
 * Realtime voice.
 */
import { VOICE_LIMITS } from "@noa/shared";
import type { AudioSource } from "./dictation.js";
import { Resampler } from "./wav.js";
import { MIC_CONSTRAINTS, PCM_PROCESSOR, PCM_WORKLET_FILE } from "./capture-config.js";

/** ScriptProcessor fallback buffer (samples at the context rate). */
const SCRIPT_PROCESSOR_SAMPLES = 2048;

export interface MicDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** An AudioContext, asked for `sampleRate` (Chrome resamples the microphone to it). */
  createContext(sampleRate: number): AudioContext;
  /** URL of the worklet module; null forces the ScriptProcessor path. */
  workletUrl: string | null;
}

export function browserMicDeps(): MicDeps {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createContext: (sampleRate) => new AudioContext({ sampleRate }),
    workletUrl: chrome.runtime.getURL(PCM_WORKLET_FILE),
  };
}

export class MicSource implements AudioSource {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private stopped = false;

  constructor(
    private readonly deps: MicDeps = browserMicDeps(),
    /** The rate samples are delivered at. */
    private readonly sampleRate: number = VOICE_LIMITS.sampleRate,
  ) {}

  async start(onSamples: (samples: Float32Array) => void): Promise<void> {
    const stream = await this.deps.getUserMedia({ audio: MIC_CONSTRAINTS });
    this.stream = stream;
    if (this.stopped) return this.release();
    const ctx = this.deps.createContext(this.sampleRate);
    this.ctx = ctx;
    const resampler = new Resampler(ctx.sampleRate, this.sampleRate);
    const deliver = (chunk: Float32Array) => {
      if (this.stopped) return;
      const out = resampler.push(chunk);
      if (out.length) onSamples(out);
    };
    const input = ctx.createMediaStreamSource(stream);
    const worklet = await this.workletNode(ctx);
    if (this.stopped) return this.release();
    if (worklet) {
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => deliver(e.data);
      input.connect(worklet);
    } else {
      const node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_SAMPLES, 1, 1);
      node.onaudioprocess = (e) => deliver(new Float32Array(e.inputBuffer.getChannelData(0)));
      // A ScriptProcessor only runs when it reaches the destination: through a muted gain.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      input.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
    }
    if (ctx.state === "suspended") await ctx.resume();
  }

  /** The capture worklet, or null where worklets are missing or the module does not load. */
  private async workletNode(ctx: AudioContext): Promise<AudioWorkletNode | null> {
    if (!this.deps.workletUrl || !ctx.audioWorklet) return null;
    try {
      await ctx.audioWorklet.addModule(this.deps.workletUrl);
    } catch {
      return null;
    }
    // No outputs: the node is a sink, so it runs without being wired to the speakers.
    return new AudioWorkletNode(ctx, PCM_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
  }

  /** Releases the microphone (also when called while start() is still opening it). */
  stop(): void {
    this.stopped = true;
    this.release();
  }

  private release(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }
}
