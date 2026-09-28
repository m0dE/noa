/**
 * Plays the Realtime narrator's audio: base64 PCM16 chunks, scheduled back
 * to back on an AudioContext. stop() cuts it off at once (barge-in) and says
 * how much of the item was heard, for conversation.item.truncate.
 */
import { base64ToBytes } from "../base64.js";

export interface PlayerEvents {
  /** Audio started playing (after silence). */
  onStart?(): void;
  /** Everything scheduled has played (or was stopped). */
  onIdle?(): void;
}

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  /** When the next chunk starts, on the context's clock. */
  private nextAt = 0;
  private item: { id: string; startedAt: number } | null = null;

  constructor(
    private readonly sampleRate: number,
    private readonly events: PlayerEvents = {},
    private readonly createContext: (sampleRate: number) => AudioContext = (rate) => new AudioContext({ sampleRate: rate }),
  ) {}

  /** Queues a chunk of item `itemId`. */
  play(base64: string, itemId: string): void {
    const bytes = base64ToBytes(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!pcm.length) return;
    const ctx = (this.ctx ??= this.createContext(this.sampleRate));
    if (ctx.state === "suspended") void ctx.resume();
    const buffer = ctx.createBuffer(1, pcm.length, this.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i]! / 0x8000;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextAt);
    if (this.item?.id !== itemId) this.item = { id: itemId, startedAt: startAt };
    const wasIdle = this.sources.size === 0;
    this.sources.add(node);
    node.onended = () => {
      this.sources.delete(node);
      if (!this.sources.size) this.events.onIdle?.();
    };
    node.start(startAt);
    this.nextAt = startAt + buffer.duration;
    if (wasIdle) this.events.onStart?.();
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  /** Stops at once; the item cut off and how many ms of it were heard (null when nothing played). */
  stop(): { itemId: string; playedMs: number } | null {
    const ctx = this.ctx;
    const cut = this.item && ctx && this.sources.size ? { itemId: this.item.id, playedMs: Math.max(0, (ctx.currentTime - this.item.startedAt) * 1000) } : null;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    const had = this.sources.size > 0;
    this.sources.clear();
    this.nextAt = 0;
    this.item = null;
    if (had) this.events.onIdle?.();
    return cut;
  }

  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
