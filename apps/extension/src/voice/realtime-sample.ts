/**
 * Test voice for Realtime (Settings > AI > Voice): a short session through
 * the relay that says one line in the chosen voice and speed, then closes.
 * It is billed like any Realtime session (sampleCostText says about how much).
 */
import type { RealtimeVoiceId } from "@noa/shared";
import { PcmPlayer } from "./pcm-player.js";
import { RealtimeClient, realtimeFailure, REALTIME_SAMPLE_RATE, type OpenSocket, type RealtimeFailure } from "./realtime-client.js";
import type { RealtimeTicket } from "./realtime-access.js";

/** A sample session lasts at most this long (connecting, one line, playing it). */
export const SAMPLE_TIMEOUT_MS = 20_000;

/** A voice sample's instructions: the sentence is in `language` (English unless the user picked another in Settings). */
const sampleInstructions = (language = "English") => `You are a voice sample. When asked, say the given sentence exactly, once, in ${language}, and nothing else.`;

/** About how long a sample runs: connecting, then one short line. */
const SAMPLE_SECONDS = 10;

/** About what a sample costs at the engine's rate a minute ("uses about 1¢ of usage credit"), never less than 1¢. */
export function sampleCostText(centsPerMinute: number): string {
  const cents = Math.max(1, Math.round((centsPerMinute * SAMPLE_SECONDS) / 60));
  return `uses about ${cents}¢ of usage credit`;
}

export interface SampleDeps {
  /** Where to connect, with the session token (rejects with why it cannot). */
  ticket(): Promise<RealtimeTicket>;
  voice: RealtimeVoiceId;
  speed: number;
  text: string;
  /** The session's instructions; default: a voice sample's. */
  instructions?: string;
  /** The language of `text` by its English name, for a voice sample's instructions (default English). */
  language?: string;
  openSocket?: OpenSocket;
  /** Plays the reply; calls onIdle when nothing is left to play. */
  createPlayer?(onIdle: () => void): Pick<PcmPlayer, "play" | "close" | "playing">;
}

/** Says `text` in the voice; resolves once it was played, rejects with a RealtimeFailure (or the ticket's error). */
export async function sayRealtimeSample(deps: SampleDeps): Promise<void> {
  const ticket = await deps.ticket();
  await new Promise<void>((resolve, reject) => {
    let replied = false;
    let done = false;
    const end = (failure: RealtimeFailure | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.close();
      player.close();
      if (failure) reject(failure);
      else resolve();
    };
    // All of the reply arrived and nothing is left to play: done.
    const idle = () => replied && !player.playing && end(null);
    const player = deps.createPlayer?.(idle) ?? new PcmPlayer(REALTIME_SAMPLE_RATE, { onIdle: idle });
    const timer = setTimeout(() => end(realtimeFailure({ closeCode: 1006, opened: false })), SAMPLE_TIMEOUT_MS);
    const client = new RealtimeClient({
      url: ticket.url,
      token: ticket.token,
      instructions: deps.instructions ?? sampleInstructions(deps.language),
      voice: deps.voice,
      speed: deps.speed,
      ...(deps.openSocket ? { open: deps.openSocket } : {}),
      handlers: {
        onReady: () => client.say("result", deps.text),
        onAudio: (b64, itemId) => player.play(b64, itemId),
        onReplyDone: () => {
          replied = true;
          idle();
        },
        onClose: (f) => end(f ?? (replied ? null : realtimeFailure({ closeCode: 1006, opened: true }))),
      },
    });
    client.connect();
  });
}
