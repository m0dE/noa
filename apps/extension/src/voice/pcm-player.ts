/**
 * Plays the Realtime narrator's audio: base64 PCM16 chunks, scheduled back
 * to back on an AudioContext. stop() cuts it off at once (barge-in) and says
 * how much of the item was heard, for conversation.item.truncate. pause()
 * stops it at once but keeps what was not heard yet (and what comes
 * meanwhile), for resume() to play on from there: the user may have been
 * the speaker heard back, not the user talking.
 */
import { base64ToBytes } from "../base64.js";

export interface PlayerEvents {
  /** Audio started playing (after silence). */
  onStart?(): void;
  /** Everything scheduled has played (or was stopped). */
  onIdle?(): void;
}

/** A chunk scheduled to play: its samples, when it starts on the context's clock, and its item. */
interface Scheduled {
  node: AudioBufferSourceNode;
  data: Float32Array;
  startAt: number;
  itemId: string;
}

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private readonly sources = new Set<Scheduled>();
  /** When the next chunk starts, on the context's clock. */
  private nextAt = 0;
  /** The item playing, and when it would have started had it played without a pause (context clock). */
  private item: { id: string; startedAt: number } | null = null;
  /** Paused: what is left to play, in order, how much of the item was heard, and whether it was playing then. */
  private paused: { left: { data: Float32Array; itemId: string }[]; cut: { itemId: string; playedMs: number } | null; wasPlaying: boolean } | null = null;

  constructor(
    private readonly sampleRate: number,
    private readonly events: PlayerEvents = {},
    private readonly createContext: (sampleRate: number) => AudioContext = (rate) => new AudioContext({ sampleRate: rate }),
  ) {}

  /** Queues a chunk of item `itemId` (kept for resume() while paused). */
  play(base64: string, itemId: string): void {
    const bytes = base64ToBytes(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!pcm.length) return;
    const data = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i]! / 0x8000;
    if (this.paused) this.paused.left.push({ data, itemId });
    else this.schedule(data, itemId);
  }

  private schedule(data: Float32Array, itemId: string): void {
    const ctx = (this.ctx ??= this.createContext(this.sampleRate));
    if (ctx.state === "suspended") void ctx.resume();
    const buffer = ctx.createBuffer(1, data.length, this.sampleRate);
    buffer.getChannelData(0).set(data);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextAt);
    if (this.item?.id !== itemId) this.item = { id: itemId, startedAt: startAt };
    const wasIdle = this.sources.size === 0;
    const s: Scheduled = { node, data, startAt, itemId };
    this.sources.add(s);
    node.onended = () => {
      this.sources.delete(s);
      if (!this.sources.size) this.events.onIdle?.();
    };
    node.start(startAt);
    this.nextAt = startAt + buffer.duration;
    if (wasIdle) this.events.onStart?.();
  }

  /** Audio is playing, or paused with some left to play. */
  get playing(): boolean {
    return this.sources.size > 0 || !!this.paused?.left.length;
  }

  /**
   * How loud what plays is (RMS, -1..1), over the last `windowMs`: what the microphone may hear of it, a little later
   * (echo-gate.ts). 0 while nothing plays (or paused).
   */
  level(windowMs = 250): number {
    const ctx = this.ctx;
    if (!ctx || !this.sources.size) return 0;
    const now = ctx.currentTime;
    const from = now - windowMs / 1000;
    let sum = 0;
    let n = 0;
    for (const s of this.sources) {
      const a = Math.max(0, Math.floor((from - s.startAt) * this.sampleRate));
      const b = Math.min(s.data.length, Math.ceil((now - s.startAt) * this.sampleRate));
      for (let i = a; i < b; i++) sum += s.data[i]! * s.data[i]!;
      n += Math.max(0, b - a);
    }
    return n ? Math.sqrt(sum / n) : 0;
  }

  /** Stops at once, keeping what is left to play; what comes until resume() or stop() is kept too, not played. */
  pause(): void {
    if (this.paused) return;
    const wasPlaying = this.sources.size > 0;
    const cut = wasPlaying ? this.heard() : null;
    const left: { data: Float32Array; itemId: string }[] = [];
    const now = this.ctx?.currentTime ?? 0;
    for (const s of [...this.sources].sort((a, b) => a.startAt - b.startAt)) {
      const from = Math.max(0, Math.round((now - s.startAt) * this.sampleRate));
      if (from < s.data.length) left.push({ data: s.data.subarray(from), itemId: s.itemId });
    }
    this.halt();
    this.paused = { left, cut, wasPlaying };
  }

  /** Plays on from where pause() stopped (with what came meanwhile). */
  resume(): void {
    const p = this.paused;
    if (!p) return;
    this.paused = null;
    // The item's heard time carries on from where it stopped.
    const at = this.ctx ? Math.max(this.ctx.currentTime, this.nextAt) : 0;
    this.item = p.cut ? { id: p.cut.itemId, startedAt: at - p.cut.playedMs / 1000 } : null;
    for (const c of p.left) this.schedule(c.data, c.itemId);
    // Nothing was left of what played: it is over.
    if (!p.left.length && p.wasPlaying) this.events.onIdle?.();
  }

  /** Stops at once (and forgets what a pause kept); the item cut off and how many ms of it were heard (null when nothing played). */
  stop(): { itemId: string; playedMs: number } | null {
    const p = this.paused;
    this.paused = null;
    const cut = p ? p.cut : this.sources.size ? this.heard() : null;
    const had = this.sources.size > 0 || !!p?.wasPlaying || !!p?.left.length;
    this.halt();
    this.item = null;
    if (had) this.events.onIdle?.();
    return cut;
  }

  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  /** The item playing and how much of it was heard. */
  private heard(): { itemId: string; playedMs: number } | null {
    const ctx = this.ctx;
    return this.item && ctx ? { itemId: this.item.id, playedMs: Math.max(0, (ctx.currentTime - this.item.startedAt) * 1000) } : null;
  }

  private halt(): void {
    for (const s of this.sources) {
      s.node.onended = null;
      try {
        s.node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextAt = 0;
  }
}
