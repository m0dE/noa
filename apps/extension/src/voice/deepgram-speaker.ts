/**
 * Lines said in a Deepgram voice (the deepgram hands-free engine, and notifications said in it): the
 * background gets the MP3 from the account server (POST SPEAK_PATH, voice.speak), and it is played
 * here at the speed from Settings (the pitch kept). Same shape as Speaker: one line at a time,
 * cancel() cuts it off (barge-in).
 */
import type { DeepgramVoiceId } from "@noa/shared";
import { base64ToBytes } from "../base64.js";
import { VoiceError, type VoiceErrorInfo } from "./transcribe.js";

/** What the background answers for voice.speak: the MP3 (base64), or the failure as data. */
export type VoiceSpeakResult = { audio: string } | { error: VoiceErrorInfo };

export interface DeepgramSettings {
  voice: DeepgramVoiceId;
  /** DEEPGRAM_SPEED; 1 is normal. */
  speed: number;
}

/** The player of one line (an HTMLAudioElement in the browser). */
export interface LinePlayer {
  play(): Promise<void>;
  pause(): void;
  playbackRate: number;
  preservesPitch: boolean;
  onplaying: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface DeepgramSpeakerDeps {
  settings(): DeepgramSettings;
  /** voice.speak through the background. */
  fetch(text: string, voice: DeepgramVoiceId): Promise<VoiceSpeakResult>;
  /** A player of the MP3 bytes; revoke frees it. Default: an Audio element on a blob URL. */
  createPlayer?(mp3: Uint8Array): { player: LinePlayer; revoke(): void };
  /** A line that could not be said (the account server refused, no credit…). */
  onError?(err: VoiceError): void;
  /** Says a line Deepgram could not (the browser's voice), so it is not lost. */
  fallback?: Pick<DeepgramSpeaker, "speak" | "cancel">;
}

function audioPlayer(mp3: Uint8Array): { player: LinePlayer; revoke(): void } {
  const url = URL.createObjectURL(new Blob([mp3 as BlobPart], { type: "audio/mpeg" }));
  return { player: new Audio(url) as unknown as LinePlayer, revoke: () => URL.revokeObjectURL(url) };
}

interface Line {
  done: () => void;
  player: LinePlayer | null;
  /** Said by the fallback instead. */
  fallback: Pick<DeepgramSpeaker, "speak" | "cancel"> | null;
}

export class DeepgramSpeaker {
  private current: Line | null = null;

  constructor(private readonly deps: DeepgramSpeakerDeps) {}

  /** Says `text`; resolves when it is over (finished, cut off or failed). onStart: the voice started playing. */
  speak(text: string, opts: { onStart?: () => void } = {}): Promise<void> {
    this.cancel();
    const { voice, speed } = this.deps.settings();
    return new Promise<void>((resolve) => {
      let revoke = () => {};
      const line: Line = {
        player: null,
        fallback: null,
        done: () => {
          if (this.current === line) this.current = null;
          revoke();
          resolve();
        },
      };
      this.current = line;
      void this.deps.fetch(text, voice).then(
        async (res) => {
          if (this.current !== line) return;
          if ("error" in res) {
            this.deps.onError?.(new VoiceError(res.error));
            const fallback = this.deps.fallback;
            if (!fallback) return line.done();
            line.fallback = fallback;
            return void fallback.speak(text, opts).then(() => line.done());
          }
          const made = (this.deps.createPlayer ?? audioPlayer)(base64ToBytes(res.audio));
          revoke = made.revoke;
          const p = made.player;
          line.player = p;
          p.playbackRate = speed;
          p.preservesPitch = true;
          p.onplaying = () => opts.onStart?.();
          p.onended = () => line.done();
          p.onerror = () => line.done();
          await p.play().catch(() => line.done());
        },
        () => line.done(),
      );
    });
  }

  /** Stops the line being said (or fetched) now. */
  cancel(): void {
    const c = this.current;
    this.current = null;
    if (!c) return;
    c.player?.pause();
    c.fallback?.cancel();
    c.done();
  }

  get speaking(): boolean {
    return this.current !== null;
  }
}
