/**
 * Lines said aloud by the browser's own speech (speechSynthesis), for the
 * Standard engine: the voice and speed from Settings, in the language picked
 * there (a voice that speaks it, when the voice picked does not). One line at
 * a time; cancel() cuts it off (barge-in).
 */

export interface SpeechSettings {
  /** A voice's name from speechSynthesis.getVoices(); "" = the browser's default. */
  voice: string;
  /** 0.5 to 2; 1 is normal speed. */
  rate: number;
  /** The language to speak (a BCP-47 tag, language.ts); absent: the voice's own. */
  lang?: string;
}

/** Whether a voice's language ("ko-KR", "ko_KR") is the language of `tag` ("ko-KR"). */
const speaks = (voiceLang: string, tag: string) => voiceLang.toLowerCase().split(/[-_]/)[0] === tag.toLowerCase().split("-")[0];

/**
 * The voice to use: the one picked, unless it does not speak `lang`; then the browser's voice for exactly `lang`, else
 * any of its language (the browser's default one first), else none (the browser picks one by the utterance's lang).
 */
export function pickVoice<V extends Pick<SpeechSynthesisVoice, "name" | "lang" | "default">>(voices: readonly V[], name: string, lang?: string): V | undefined {
  const chosen = name ? voices.find((v) => v.name === name) : undefined;
  if (!lang || (chosen && speaks(chosen.lang, lang))) return chosen;
  const theirs = voices.filter((v) => speaks(v.lang, lang));
  const exact = (v: V) => v.lang.replace("_", "-").toLowerCase() === lang.toLowerCase();
  return theirs.find((v) => exact(v) && v.default) ?? theirs.find(exact) ?? theirs.find((v) => v.default) ?? theirs[0];
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
    const { voice, rate, lang } = this.settings();
    const u = this.makeUtterance(text);
    u.rate = rate;
    const chosen = pickVoice(this.synth.getVoices(), voice, lang);
    if (chosen) {
      u.voice = chosen;
      u.lang = chosen.lang;
    } else if (lang) u.lang = lang;
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
