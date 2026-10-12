import { z } from "zod";

/**
 * The languages a user can pick for Noa to talk in (Settings > AI > Voice > Language): what they speak to it, what
 * hands-free voice and notifications say, and what the agent writes back. "auto" (the default) keeps Noa as it was:
 * the transcription is told the browser's languages, the narrator and the agent answer in the language the user
 * speaks, and Noa's own fixed lines (progress, notifications) are in English.
 */
export const LANGUAGES = [
  { code: "en", name: "English", native: "English", tag: "en-US" },
  { code: "es", name: "Spanish", native: "Español", tag: "es-ES" },
  { code: "fr", name: "French", native: "Français", tag: "fr-FR" },
  { code: "pt", name: "Portuguese", native: "Português", tag: "pt-BR" },
  { code: "ko", name: "Korean", native: "한국어", tag: "ko-KR" },
  { code: "ja", name: "Japanese", native: "日本語", tag: "ja-JP" },
  { code: "zh", name: "Chinese", native: "中文", tag: "zh-CN" },
  { code: "de", name: "German", native: "Deutsch", tag: "de-DE" },
  { code: "hi", name: "Hindi", native: "हिन्दी", tag: "hi-IN" },
  { code: "ar", name: "Arabic", native: "العربية", tag: "ar-SA" },
] as const;

/** A language's ISO 639-1 code (the transcription's hint). */
export type LanguageCode = (typeof LANGUAGES)[number]["code"];
export const LanguageCode = z.enum(LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]]);

/** The setting: a language, or "auto" (see the top of this file). */
export const LanguageSetting = z.enum(["auto", ...LanguageCode.options]);
export type LanguageSetting = z.infer<typeof LanguageSetting>;

export interface LanguageInfo {
  code: LanguageCode;
  /** Its English name, as the models are told it ("Korean"). */
  name: string;
  /** Its own name, as the user reads it in the list ("한국어"). */
  native: string;
  /** A BCP-47 tag for the browser's speech (speechSynthesis, chrome.tts). */
  tag: string;
}

export function languageInfo(code: LanguageCode): LanguageInfo {
  return LANGUAGES.find((l) => l.code === code)!;
}

/** The language the user picked, or null for "auto". */
export function chosenLanguage(setting: LanguageSetting | undefined): LanguageInfo | null {
  return !setting || setting === "auto" ? null : languageInfo(setting);
}

/** What the agent is told of the user's language each turn (null for "auto": it answers in the language it is spoken to). */
export function languagePromptLine(setting: LanguageSetting | undefined): string | null {
  const lang = chosenLanguage(setting);
  if (!lang) return null;
  return (
    `The user's language is ${lang.name}: write everything you say to them in ${lang.name} (your replies, questions, summaries and every \`spoken\` line), ` +
    "whatever language the task, the pages or your tools are in. Text you post, type or send for them stays in the language they asked for."
  );
}
