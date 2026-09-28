/**
 * AudioWorklet processor (built to dist/pcm-worklet.js): posts the first input
 * channel to the page in batches. Runs in the AudioWorkletGlobalScope: it may
 * import only code the bundle can inline (constants).
 */
import { PCM_PROCESSOR } from "./capture-config.js";

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Render quanta (128 samples each) per message: 4 is 32 ms at 16 kHz. */
const QUANTA_PER_MESSAGE = 4;

class PcmCapture extends AudioWorkletProcessor {
  private batch: Float32Array[] = [];

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      this.batch.push(channel.slice());
      if (this.batch.length >= QUANTA_PER_MESSAGE) {
        const out = new Float32Array(this.batch.reduce((n, b) => n + b.length, 0));
        let at = 0;
        for (const b of this.batch) {
          out.set(b, at);
          at += b.length;
        }
        this.batch = [];
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor(PCM_PROCESSOR, PcmCapture);
