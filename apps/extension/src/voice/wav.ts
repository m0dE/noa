/** 16-bit PCM WAV encoding and sample-rate conversion for voice clips. No DOM. */

const HEADER_BYTES = 44;

/** Float samples (-1..1) as 16-bit PCM, clipped. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/** A mono 16-bit PCM WAV file of `pcm` at `sampleRate`. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, HEADER_BYTES).set(pcm);
  return new Uint8Array(buf);
}

/**
 * Converts a stream of chunks from `fromRate` to `toRate` by linear
 * interpolation, carrying its state across chunks. When downsampling (48 kHz
 * to 16 kHz) each input sample is first averaged over the span one output
 * sample covers (a box filter), so high frequencies do not fold into the
 * speech band.
 */
export class Resampler {
  private readonly step: number;
  private readonly width: number;
  /** The last width-1 raw inputs (box filter state). */
  private readonly history: number[];
  private historySum: number;
  /** Next output position, relative to the current chunk's first sample (-1 = the previous chunk's last). */
  private pos = 0;
  private prev = 0;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    this.step = fromRate / toRate;
    this.width = Math.max(1, Math.floor(this.step));
    this.history = new Array(this.width - 1).fill(0);
    this.historySum = 0;
  }

  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return input;
    const filtered = this.filter(input);
    const out: number[] = [];
    while (this.pos < filtered.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.prev : filtered[i]!;
      const b = filtered[i + 1]!;
      out.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= filtered.length;
    if (filtered.length) this.prev = filtered[filtered.length - 1]!;
    return Float32Array.from(out);
  }

  /** Moving average over `width` raw samples, continuing from the previous chunk. */
  private filter(input: Float32Array): Float32Array {
    if (this.width === 1) return input;
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const x = input[i]!;
      out[i] = (this.historySum + x) / this.width;
      this.history.push(x);
      this.historySum += x - this.history.shift()!;
    }
    return out;
  }
}
