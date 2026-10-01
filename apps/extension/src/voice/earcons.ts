/**
 * The soft sounds hands-free voice makes when the microphone goes live and
 * when it stops (Settings > AI > Voice > Sounds): two short sine notes,
 * rising to start and falling to stop, made with WebAudio (no sound files).
 * Mute and unmute are the same shape a register lower, so they read as the
 * microphone going off and on without sounding like the session ending.
 * Played in the side panel, after the microphone is open (Chrome lets a page
 * that captures audio play it without a click). "notice" is the notification
 * chime (Settings > AI > Voice > Notifications: Chime), played by the offscreen
 * document: three rising notes, louder and longer, heard from another tab.
 */

export type Earcon = "start" | "stop" | "mute" | "unmute" | "notice";

/** Each sound's notes (Hz), one after the other. */
export const EARCON_NOTES: Record<Earcon, readonly number[]> = {
  start: [587.33, 880], // D5 -> A5
  stop: [880, 587.33], // A5 -> D5
  mute: [523.25, 392], // C5 -> G4
  unmute: [392, 523.25], // G4 -> C5
  notice: [659.25, 830.61, 987.77], // E5 -> G#5 -> B5
};

/** Soft: a low peak with quick fades, each note short. */
export const EARCON_SHAPE = { peak: 0.08, noteSec: 0.09, gapSec: 0.03, attackSec: 0.012 } as const;
/** The notification chime: louder and a little longer, so it is heard over what the user is doing. */
export const NOTICE_SHAPE = { peak: 0.2, noteSec: 0.16, gapSec: 0.04, attackSec: 0.01 } as const;

/** What of an AudioContext the sounds use (a fake in tests). */
export interface EarconContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(v: number, t: number): unknown };
    connect(node: unknown): unknown;
    start(t: number): void;
    stop(t: number): void;
  };
  createGain(): {
    gain: { setValueAtTime(v: number, t: number): unknown; linearRampToValueAtTime(v: number, t: number): unknown; exponentialRampToValueAtTime(v: number, t: number): unknown };
    connect(node: unknown): unknown;
  };
}

export class Earcons {
  private ctx: EarconContext | null = null;

  constructor(
    private readonly create: () => EarconContext = () => new AudioContext() as unknown as EarconContext,
    private readonly log?: (message: string) => void,
  ) {}

  play(kind: Earcon): void {
    try {
      const ctx = (this.ctx ??= this.create());
      if (ctx.state === "suspended") void ctx.resume().catch((err: unknown) => this.log?.(`earcon: resuming audio failed: ${String(err)}`));
      const { peak, noteSec, gapSec, attackSec } = kind === "notice" ? NOTICE_SHAPE : EARCON_SHAPE;
      let t = ctx.currentTime + 0.01;
      for (const hz of EARCON_NOTES[kind]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(hz, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(peak, t + attackSec);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + noteSec);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + noteSec + 0.02);
        t += noteSec + gapSec;
      }
    } catch (err) {
      // A sound is a nicety: without audio the session goes on as it is.
      this.log?.(`earcon ${kind} failed: ${String(err)}`);
    }
  }
}
