/**
 * The languages the user speaks to voice in, and whether a transcript of
 * what the microphone heard reads as the user talking in one of them.
 *
 * The languages are the one picked in Settings (language.ts), if any, then the
 * browser's preferred languages (navigator.languages, set in Chrome's
 * settings): the Realtime input transcription is told them
 * (its `languages` hint). A transcript with next to no letters in a script
 * none of them is written in ("有，......。", "...") is "unclear": the
 * transcription failed on the user's words, and the narrator's own reading of
 * the audio counts. Whole sentences in any language are the user's ("clear"):
 * people speak to voice in a language their browser is not set to (Korean on
 * an English Chrome), and dropping that as other people talking left them
 * with replies to small talk and their requests silently lost. A script the
 * hint does not pin down (a language not listed below) is never judged. Pure.
 */

/** The scripts each language is written in (ISO 639-1). Languages not listed are not judged. */
const SCRIPTS: Readonly<Record<string, readonly Script[]>> = {
  en: ["Latin"], es: ["Latin"], fr: ["Latin"], de: ["Latin"], it: ["Latin"], pt: ["Latin"], nl: ["Latin"], sv: ["Latin"],
  da: ["Latin"], no: ["Latin"], nb: ["Latin"], fi: ["Latin"], pl: ["Latin"], cs: ["Latin"], ro: ["Latin"], hu: ["Latin"],
  tr: ["Latin"], id: ["Latin"], ms: ["Latin"], vi: ["Latin"], tl: ["Latin"], hr: ["Latin"], sk: ["Latin"], sl: ["Latin"],
  ko: ["Hangul", "Han"], ja: ["Hiragana", "Katakana", "Han"], zh: ["Han"],
  ru: ["Cyrillic"], uk: ["Cyrillic"], bg: ["Cyrillic"], sr: ["Cyrillic", "Latin"],
  el: ["Greek"], ar: ["Arabic"], fa: ["Arabic"], ur: ["Arabic"], he: ["Hebrew"], hi: ["Devanagari"], mr: ["Devanagari"], th: ["Thai"],
};

type Script = "Latin" | "Hangul" | "Han" | "Hiragana" | "Katakana" | "Cyrillic" | "Greek" | "Arabic" | "Hebrew" | "Devanagari" | "Thai";

const SCRIPT_RE: Readonly<Record<Script, RegExp>> = {
  Latin: /\p{Script=Latin}/u,
  Hangul: /\p{Script=Hangul}/u,
  Han: /\p{Script=Han}/u,
  Hiragana: /\p{Script=Hiragana}/u,
  Katakana: /\p{Script=Katakana}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
  Greek: /\p{Script=Greek}/u,
  Arabic: /\p{Script=Arabic}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Devanagari: /\p{Script=Devanagari}/u,
  Thai: /\p{Script=Thai}/u,
};

/** At most this many languages go in the hint (the browser's first ones). */
export const MAX_VOICE_LANGUAGES = 3;
/** Without any from the browser: English. */
const DEFAULT_LANGUAGES = ["en"] as const;

/**
 * The browser's preferred languages ("en-US", "ko") as ISO 639-1 codes, first ones first, without repeats; the language
 * picked in Settings (`chosen`) first of all. The browser's stay listed after it: what the user says in them is still theirs.
 */
export function voiceLanguages(browser: readonly string[], chosen?: string | null): string[] {
  const codes = [...(chosen ? [chosen] : []), ...browser].map((tag) => tag.trim().toLowerCase().split(/[-_]/)[0] ?? "").filter((c) => /^[a-z]{2}$/.test(c));
  const unique = [...new Set(codes)].slice(0, MAX_VOICE_LANGUAGES);
  return unique.length ? unique : [...DEFAULT_LANGUAGES];
}

/** What a transcript is, for the languages the user speaks (see the top of this file). */
export type TranscriptFit = "clear" | "unclear";

/** At least this share of a transcript's letters must be in the user's scripts. */
const MIN_SCRIPT_SHARE = 0.5;
/** A transcript in another script with fewer letters than this, or more punctuation than letters, is unclear rather than speech. */
const MIN_SPEECH_LETTERS = 2;

export function transcriptFit(text: string, languages: readonly string[]): TranscriptFit {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return "unclear";
  const known = languages.map((l) => SCRIPTS[l]);
  // No languages given, or one the table does not know: any script may be the user's.
  if (!known.length || known.some((s) => !s)) return "clear";
  const scripts = [...new Set(known.flatMap((s) => s!))].map((s) => SCRIPT_RE[s]);
  const mine = letters.filter((c) => scripts.some((re) => re.test(c))).length;
  if (mine / letters.length >= MIN_SCRIPT_SHARE) return "clear";
  const marks = [...text].filter((c) => /[\p{P}\p{S}]/u.test(c)).length;
  return letters.length < MIN_SPEECH_LETTERS || marks > letters.length ? "unclear" : "clear";
}
