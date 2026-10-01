import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/base64.js";
import { PcmPlayer } from "../../src/voice/pcm-player.js";

const RATE = 1_000;

/** An AudioContext on a clock the test moves: what was started, when, and what ended. */
class Ctx {
  currentTime = 0;
  state = "running";
  destination = {};
  started: { at: number; data: Float32Array; stopped: boolean; node: Node }[] = [];
  createBuffer(_c: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    return new Node(this);
  }
  async resume() {}
  async close() {}
  /** Moves the clock: chunks that played to their end end. */
  advance(s: number) {
    this.currentTime += s;
    for (const x of this.started) {
      if (!x.stopped && x.at + x.data.length / RATE <= this.currentTime + 1e-9) {
        x.stopped = true;
        x.node.onended?.();
      }
    }
  }
}
class Node {
  buffer: { getChannelData(): Float32Array; duration: number } | null = null;
  onended: (() => void) | null = null;
  constructor(private readonly ctx: Ctx) {}
  connect() {}
  start(at: number) {
    this.ctx.started.push({ at, data: this.buffer!.getChannelData(), stopped: false, node: this });
  }
  stop() {
    const x = this.ctx.started.find((s) => s.node === this);
    if (x) x.stopped = true;
  }
}

/** `ms` of PCM16 at `value` (-1..1), base64. */
function chunk(ms: number, value: number): string {
  const pcm = new Int16Array((RATE * ms) / 1000).fill(Math.round(value * 0x7fff));
  return bytesToBase64(new Uint8Array(pcm.buffer));
}

function player() {
  const ctx = new Ctx();
  const events: string[] = [];
  const p = new PcmPlayer(RATE, { onStart: () => void events.push("start"), onIdle: () => void events.push("idle") }, () => ctx as unknown as AudioContext);
  return { ctx, p, events };
}

describe("PcmPlayer: pause keeps what is left, resume plays on from there", () => {
  it("paused mid-chunk, the rest of it and what came meanwhile play after resume, once", () => {
    const { ctx, p, events } = player();
    p.play(chunk(400, 0.5), "a1");
    p.play(chunk(400, 0.25), "a1");
    ctx.advance(0.1);
    p.pause();
    expect(p.playing).toBe(true);
    // What comes while paused is kept, not played.
    p.play(chunk(200, 0.125), "a1");
    expect(ctx.started.filter((s) => !s.stopped)).toEqual([]);
    ctx.advance(1);
    p.resume();
    const again = ctx.started.slice(2);
    expect(again.map((s) => [Math.round(s.at * 1000) / 1000, s.data.length])).toEqual([
      [1.1, 300],
      [1.4, 400],
      [1.8, 200],
    ]);
    ctx.advance(1);
    expect(events).toEqual(["start", "start", "idle"]);
    expect(p.playing).toBe(false);
  });

  it("stop while paused drops what was kept; how much of the item was heard is from before the pause", () => {
    const { ctx, p, events } = player();
    p.play(chunk(400, 0.5), "a1");
    ctx.advance(0.1);
    p.pause();
    ctx.advance(2);
    const cut = p.stop();
    expect(cut?.itemId).toBe("a1");
    expect(Math.round(cut!.playedMs)).toBe(100);
    expect(events).toEqual(["start", "idle"]);
    expect(p.playing).toBe(false);
    p.resume();
    expect(ctx.started.filter((s) => !s.stopped)).toEqual([]);
  });

  it("paused with nothing playing: what comes is kept for resume (never heard over the user), dropped by stop", () => {
    const { ctx, p, events } = player();
    p.pause();
    p.play(chunk(200, 0.5), "a1");
    expect(ctx.started).toEqual([]);
    p.stop();
    p.resume();
    expect(ctx.started).toEqual([]);
    expect(events).toEqual(["idle"]);
  });

  it("the heard time of the item carries on across a pause (for a later cut)", () => {
    const { ctx, p } = player();
    p.play(chunk(1_000, 0.5), "a1");
    ctx.advance(0.3);
    p.pause();
    ctx.advance(5);
    p.resume();
    ctx.advance(0.2);
    expect(Math.round(p.stop()!.playedMs)).toBe(500);
  });

  it("level: how loud what plays is, over the last window; 0 when nothing plays or paused", () => {
    const { ctx, p } = player();
    expect(p.level()).toBe(0);
    p.play(chunk(1_000, 0.5), "a1");
    ctx.advance(0.3);
    expect(p.level()).toBeCloseTo(0.5, 2);
    p.pause();
    expect(p.level()).toBe(0);
  });
});
