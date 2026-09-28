/**
 * Utterance endpointing for hands-free voice: where one thing the user said
 * ends, from the speech detector's per-frame verdicts (speech.ts). An
 * utterance is at least `minSpeechMs` of speech; it ends once it has been
 * quiet for `endPauseMs`. The detector's own hangover (VOICE_TUNING
 * .speechHangoverMs) comes on top, so the pause people make is about a second.
 * Pure: frames in, decisions out.
 */

export interface EndpointSettings {
  /** Quiet after speech that ends the utterance. */
  endPauseMs: number;
  /** Less speech than this (a click, a cough) is not an utterance. */
  minSpeechMs: number;
}

export const ENDPOINTING: EndpointSettings = { endPauseMs: 800, minSpeechMs: 240 };

/**
 * The frame count after which the first utterance in `speech` has ended (the
 * frame where its closing pause reached `endPauseMs`), or null when none has.
 */
export function utteranceEnd(speech: readonly boolean[], frameMs: number, t: EndpointSettings = ENDPOINTING): number | null {
  const e = new Endpointer(frameMs, t);
  for (let i = 0; i < speech.length; i++) if (e.push(speech[i]!) === "end") return i + 1;
  return null;
}

export type EndpointSignal = "start" | "end";

/** utteranceEnd over a stream: push each frame's verdict; it says when an utterance starts and ends, then starts over. */
export class Endpointer {
  private speechFrames = 0;
  private quietFrames = 0;
  private started = false;
  private readonly minFrames: number;
  private readonly pauseFrames: number;

  constructor(
    private readonly frameMs: number,
    t: EndpointSettings = ENDPOINTING,
  ) {
    this.minFrames = Math.max(1, Math.ceil(t.minSpeechMs / frameMs));
    this.pauseFrames = Math.max(1, Math.ceil(t.endPauseMs / frameMs));
  }

  /** Milliseconds of speech in the utterance so far. */
  get speechMs(): number {
    return this.speechFrames * this.frameMs;
  }

  /** "start" when the speech just became an utterance, "end" when it just ended, else null. */
  push(speech: boolean): EndpointSignal | null {
    if (speech) {
      this.speechFrames++;
      this.quietFrames = 0;
      if (!this.started && this.speechFrames >= this.minFrames) {
        this.started = true;
        return "start";
      }
      return null;
    }
    this.quietFrames++;
    if (this.started && this.quietFrames >= this.pauseFrames) {
      this.reset();
      return "end";
    }
    // Speech too short to count, followed by quiet: forgotten.
    if (!this.started && this.quietFrames >= this.pauseFrames) this.speechFrames = 0;
    return null;
  }

  reset(): void {
    this.speechFrames = 0;
    this.quietFrames = 0;
    this.started = false;
  }
}
