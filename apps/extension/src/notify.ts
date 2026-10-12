/**
 * Noa's notifications: a Chrome notification with the extension icon, and the
 * same news heard, so the user notices it while they work in another tab or
 * window (Settings > AI > Voice > Notifications): said in the hands-free
 * engine's voice or another engine's (in that engine's voice above, or one
 * picked just for notifications), a chime, or nothing. A Realtime or
 * Deepgram voice and the chime play in an offscreen document (notice-voice.ts);
 * the browser voice is Chrome's own speech (chrome.tts, from the background),
 * which also says a line the other voices could not. Nothing is heard while a
 * hands-free session is on: it speaks for itself, and its microphone would
 * take the line for the user's words. Nothing is heard either while the screen
 * is locked (closing a laptop's lid locks it): the notification still shows,
 * for when the user is back. In the language picked in Settings
 * (phrases.ts), shown and said; Deepgram's English voices leave a line in
 * another language to Chrome's speech.
 */
import { chosenLanguage, DEEPGRAM_VOICES, deepgramSpeaks, errorMessage, notificationSource, REALTIME_VOICES, type DeepgramVoiceId, type ExtensionSettings, type RealtimeVoiceId } from "@noa/shared";
import type { NoticeSound } from "./voice/notice-voice.js";
import { localizeLine } from "./voice/phrases.js";
import { logger } from "./log.js";

const log = logger("notify");

/** A spoken notice is at most this long (the notification shows the rest). */
const SPOKEN_MAX = 180;

export type Notify = (title: string, message: string, spoken?: string) => Promise<void>;

type Tts = Pick<typeof chrome.tts, "speak" | "getVoices">;

export interface NotifierDeps {
  settings(): Promise<
    Pick<
      ExtensionSettings,
      "notificationVoice" | "notificationSpeaker" | "voiceEngine" | "speechVoice" | "speechRate" | "realtimeVoice" | "realtimeSpeed" | "deepgramVoice" | "deepgramSpeed"
    > &
      Partial<Pick<ExtensionSettings, "language">>
  >;
  /** A hands-free voice session is on. */
  voiceOn(): boolean;
  /** The screen is locked (chrome.idle): notices are shown, not heard. */
  locked?(): Promise<boolean>;
  notifications?: Pick<typeof chrome.notifications, "create">;
  tts?: Tts;
  /** Plays a Realtime or Deepgram line, or the chime (the offscreen document); rejects when it could not. */
  play?(sound: NoticeSound): Promise<void>;
  iconUrl?(): string;
}

/** "ko-KR" and "ko" are the same language. */
const sameLanguage = (a: string, b: string) => a.toLowerCase().split(/[-_]/)[0] === b.toLowerCase().split(/[-_]/)[0];

/** The first sentence of `text`, cut to `max` at a word. */
function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // Chinese and Japanese end a sentence with 。！？ and no space.
  const sentence = flat.match(/^.+?(?:[.!?](?=\s|$)|[。！？])/)?.[0] ?? flat;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1))}…`;
}

/** What is said for a notification: "Noa: Task paused. @getbnty is not signed in in this browser." */
export function spokenNotice(title: string, message: string): string {
  const bare = title.trim().replace(/[.!?:。！？：]$/, "");
  // Chinese and Japanese end the sentence with their own full stop.
  const head = `Noa: ${bare}${/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(bare) ? "。" : "."}`;
  const rest = firstSentence(message, Math.max(SPOKEN_MAX - head.length, 40));
  return rest ? `${head} ${rest}` : head;
}

/** The notify of the background: shows a notification and says it aloud. Never throws. */
export function notifier(deps: NotifierDeps): Notify {
  const notifications = deps.notifications ?? chrome.notifications;
  const iconUrl = deps.iconUrl ?? (() => chrome.runtime.getURL("icons/icon128.png"));
  // One after the other, like chrome.tts's enqueue.
  let queue: Promise<unknown> = Promise.resolve();
  const play = (sound: NoticeSound): Promise<void> => {
    // A notice queued before the screen locked is not heard after it.
    const next = queue.then(async () => {
      if (await isLocked(deps)) return;
      return deps.play!(sound);
    });
    queue = next.catch(() => {});
    return next;
  };
  return async (english, englishMessage, englishSpoken) => {
    const lang = chosenLanguage((await deps.settings().catch(() => null))?.language)?.code;
    const title = localizeLine(english, lang);
    const message = localizeLine(englishMessage, lang);
    try {
      await notifications.create({ type: "basic", iconUrl: iconUrl(), title: `Noa: ${title}`, message: message.slice(0, 500), priority: 1 });
    } catch (err) {
      log(`notification failed: ${errorMessage(err)}`);
    }
    try {
      await say(deps, englishSpoken ? localizeLine(englishSpoken, lang) : spokenNotice(title, message), play);
    } catch (err) {
      log(`saying the notification failed: ${errorMessage(err)}`);
    }
  };
}

type NoticeSettings = Awaited<ReturnType<NotifierDeps["settings"]>>;

const isRealtimeVoice = (v: string): v is RealtimeVoiceId => (REALTIME_VOICES as readonly string[]).includes(v);
const isDeepgramVoice = (v: string): v is DeepgramVoiceId => (DEEPGRAM_VOICES as readonly string[]).includes(v);

/** The browser voice notifications use: the one picked for them (not another engine's voice id), else the browser voice above. */
function browserVoice(s: NoticeSettings): string {
  const own = s.notificationSpeaker;
  return own && !isRealtimeVoice(own) && !isDeepgramVoice(own) ? own : s.speechVoice;
}

/** What a notification plays with these settings: a sound for the offscreen document, "tts" (Chrome's speech), or null (silent). */
export function noticeSound(s: NoticeSettings, line: string): NoticeSound | "tts" | null {
  const source = notificationSource(s);
  const own = s.notificationSpeaker;
  switch (source) {
    case "off":
      return null;
    case "chime":
      return { kind: "chime" };
    case "realtime":
    case "realtime-mini":
      return { kind: "realtime", mini: source === "realtime-mini", line, voice: isRealtimeVoice(own) ? own : s.realtimeVoice, speed: s.realtimeSpeed };
    case "deepgram":
      // Aura speaks English only: a line in another language is Chrome's.
      if (!deepgramSpeaks(chosenLanguage(s.language))) return "tts";
      return { kind: "deepgram", line, voice: isDeepgramVoice(own) ? own : s.deepgramVoice, speed: s.deepgramSpeed };
    case "standard":
      return "tts";
  }
}

/** The screen is locked; when that cannot be told, it is not. */
const isLocked = (deps: NotifierDeps): Promise<boolean> => deps.locked?.().catch(() => false) ?? Promise.resolve(false);

async function say(deps: NotifierDeps, line: string, play: NonNullable<NotifierDeps["play"]>): Promise<void> {
  if (deps.voiceOn() || (await isLocked(deps))) return;
  const s = await deps.settings();
  const sound = noticeSound(s, line);
  if (!sound) return;
  if (sound !== "tts" && deps.play) {
    try {
      return await play(sound);
    } catch (err) {
      // The chime has no words to fall back on.
      if (sound.kind === "chime") return log(`the notification chime failed: ${errorMessage(err)}`);
      log(`saying the notification in the ${sound.kind} voice failed, using Chrome's speech: ${errorMessage(err)}`);
    }
  } else if (sound !== "tts" && sound.kind === "chime") {
    return;
  }
  const tts = deps.tts ?? globalThis.chrome?.tts;
  if (!tts) return;
  const lang = chosenLanguage(s.language)?.tag;
  // The voice picked for the browser's speech, when Chrome's speech has it too and it speaks the language picked.
  const wanted = browserVoice(s);
  const voices = wanted ? await tts.getVoices() : [];
  const picked = voices.find((v) => v.voiceName === wanted);
  const voiceName = picked && (!lang || !picked.lang || sameLanguage(picked.lang, lang)) ? wanted : undefined;
  // Queued: two notices one after the other are both said.
  await tts.speak(line, { enqueue: true, rate: s.speechRate, ...(voiceName ? { voiceName } : lang ? { lang } : {}) });
}
