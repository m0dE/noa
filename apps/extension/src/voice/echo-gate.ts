/**
 * Keeps the narrator's own voice, heard back by the microphone, from OpenAI's turn detection (Realtime). While the
 * narrator's audio plays here, the microphone's audio goes out as silence unless it is clearly louder than what the
 * speaker puts into it (the echo coupling, learned as it plays): the user talking over it, for BARGE_IN_MS. Then the
 * last REPLAY_MS of what it heard goes out first (their first words) and everything after, until the narrator is
 * quiet. Without it, the speaker's voice heard back (a Mac's speakers, echo cancellation leaving some) started a
 * turn: the line was cut off and said again from the start, over and over, and pieces of it ("I'm doing.", "So.")
 * went to the agent as requests (test/manual/realtime-greeting.live.ts). Pure.
 */
import { VOICE_TUNING } from "@noa/shared";
import { rms } from "./speech.js";

/** Speech over the narrator this long is the user talking (not a click, a cough, a burst of echo). */
export const BARGE_IN_MS = 300;
/** Audio kept to send first once the user talks over the narrator (their first words, before BARGE_IN_MS ran out). */
export const REPLAY_MS = 600;
/** The microphone must be this many times louder than the echo it is expected to hear to be the user. */
export const DOUBLE_TALK_MARGIN = 3;
/** The echo coupling (microphone RMS per RMS played) before any is measured, and the most it is taken to be. */
export const INITIAL_COUPLING = 0.1;
export const MAX_COUPLING = 0.5;
/** How fast the coupling follows what is measured (per chunk). */
const COUPLING_RATE = 0.2;
/** Played audio quieter than this (RMS) is silence: nothing to hear back, and nothing to learn from. */
const FAR_MIN = 0.003;
/** The narrator counts as heard this long after what plays went quiet (its pauses, the room's echo of its last words). */
const FAR_HANGOVER_MS = 400;

export class EchoGate {
  private coupling = INITIAL_COUPLING;
  private loudMs = 0;
  /** The user talks over the narrator: the microphone goes out as it is until the narrator is quiet. */
  private open = false;
  private recent: Float32Array[] = [];
  private recentMs = 0;
  /** How loud the narrator was when last heard, and how long it has been quiet since. */
  private lastFar = 0;
  private quietMs = Infinity;

  constructor(private readonly sampleRate: number) {}

  /**
   * What goes out for `mic` (a chunk of the microphone), given how loud what plays is now (`far`, RMS; 0: nothing
   * plays). `opened`: this chunk let the user's speech through.
   */
  push(mic: Float32Array, far: number): { send: Float32Array[]; opened: boolean } {
    const ms = (mic.length / this.sampleRate) * 1000;
    if (far >= FAR_MIN) {
      this.lastFar = far;
      this.quietMs = 0;
    } else this.quietMs += ms;
    if (this.quietMs >= FAR_HANGOVER_MS) {
      // The narrator is quiet: the microphone goes out as it is.
      this.open = false;
      this.loudMs = 0;
      this.remember(mic, ms);
      return { send: [mic], opened: false };
    }
    if (this.open) return { send: [mic], opened: false };
    const r = rms(mic);
    const heard = Math.max(far, this.lastFar);
    const expected = heard * this.coupling;
    if (r >= Math.max(VOICE_TUNING.minSpeechRms, expected * DOUBLE_TALK_MARGIN)) this.loudMs += ms;
    else {
      this.loudMs = 0;
      // Only the speaker heard: how much of it comes back.
      if (far >= FAR_MIN) this.coupling = Math.min(MAX_COUPLING, this.coupling + (r / far - this.coupling) * COUPLING_RATE);
    }
    this.remember(mic, ms);
    if (this.loudMs < BARGE_IN_MS) return { send: [new Float32Array(mic.length)], opened: false };
    this.open = true;
    this.loudMs = 0;
    const send = this.recent;
    this.recent = [];
    this.recentMs = 0;
    return { send, opened: true };
  }

  /** What the microphone heard lately (REPLAY_MS), to send first once the user talks over the narrator. */
  private remember(mic: Float32Array, ms: number): void {
    this.recent.push(mic);
    this.recentMs += ms;
    while (this.recent.length > 1 && this.recentMs - (this.recent[0]!.length / this.sampleRate) * 1000 >= REPLAY_MS) {
      this.recentMs -= (this.recent.shift()!.length / this.sampleRate) * 1000;
    }
  }
}
