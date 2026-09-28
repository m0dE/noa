/**
 * Lines said aloud by the browser's own speech (speechSynthesis), for the
 * Standard engine: the voice and speed from Settings. One line at a time;
 * cancel() cuts it off (barge-in).
 */

export interface SpeechSettings {
  /** A voice's name from speechSynthesis.getVoices(); "" = the browser's default. */
  voice: string;
  /** 0.5 to 2; 1 is normal speed. */
  rate: number;
}

type Synth = Pick<SpeechSynthesis, "speak" | "cancel" | "getVoices">;
type MakeUtterance = (text: string) => SpeechSynthesisUtterance;

export class Speaker {
  private current: { utterance: SpeechSynthesisUtterance; done: () => void } | null = null;

  constructor(
    private readonly settings: () => SpeechSettings,
    private readonly synth: Synth = globalThis.speechSynthesis,
    private readonly makeUtterance: MakeUtterance = (text) => new SpeechSynthesisUtterance(text),
  ) {}

  /** Says `text`; resolves when it is over (finished, cut off or failed). onStart: the voice started (the browser may take a moment). */
  speak(text: string, opts: { onStart?: () => void } = {}): Promise<void> {
    this.cancel();
    const { voice, rate } = this.settings();
    const u = this.makeUtterance(text);
    u.rate = rate;
    const chosen = voice ? this.synth.getVoices().find((v) => v.name === voice) : undefined;
    if (chosen) {
      u.voice = chosen;
      u.lang = chosen.lang;
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.current?.utterance === u) this.current = null;
        resolve();
      };
      this.current = { utterance: u, done };
      u.onstart = () => opts.onStart?.();
      u.onend = done;
      u.onerror = done;
      this.synth.speak(u);
    });
  }

  /** Stops the line being said now. */
  cancel(): void {
    const c = this.current;
    this.current = null;
    if (!c) return;
    this.synth.cancel();
    c.done();
  }

  get speaking(): boolean {
    return this.current !== null;
  }
}

/** The browser's voices, for the Settings list (they may load a moment after the page). */
export function speechVoices(synth: Pick<SpeechSynthesis, "getVoices"> | undefined = globalThis.speechSynthesis): { name: string; lang: string }[] {
  return (synth?.getVoices() ?? []).map((v) => ({ name: v.name, lang: v.lang }));
}
