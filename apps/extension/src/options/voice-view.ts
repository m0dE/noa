/**
 * Pure logic of Settings > AI > Voice: the four hands-free engines with what
 * a minute of each costs in usage credit (the server's numbers), whether the
 * plan includes voice, the selected engine's voice and speed, and how
 * notifications are heard (and in which voice). voice-section.ts renders it.
 */
import {
  chosenLanguage,
  clampSpeed,
  deepgramSpeaks,
  LANGUAGES,
  type LanguageSetting,
  DEEPGRAM_SPEED,
  DEEPGRAM_VOICES,
  deepgramVoiceName,
  isRealtimeEngine,
  notificationSource,
  RECOMMENDED_DEEPGRAM_VOICES,
  VoiceEngineId,
  type NotificationVoice,
  plansWithText,
  REALTIME_SPEED,
  REALTIME_VOICES,
  realtimeVoiceName,
  RECOMMENDED_REALTIME_VOICES,
  STANDARD_SPEED,
  type ExtensionSettings,
  type SpeedRange,
  type VoiceEngine,
} from "@noa/shared";
import { voiceAllowed } from "../account/types.js";
import type { AccountView } from "../ui-protocol.js";
import { costPerMinuteText, ENGINE_NAMES } from "../voice/engine-choice.js";
import { sampleCostText } from "../voice/realtime-sample.js";

export interface VoiceOption {
  id: VoiceEngineId;
  label: string;
  /** What it is, in one line. */
  detail: string;
  /** What a minute costs (or why that is not shown). */
  cost: string;
  /** The server's assumption behind the cost, for the tooltip. */
  title: string;
}

export interface VoiceView {
  options: VoiceOption[];
  selected: VoiceEngineId;
  /** Without a plan that includes voice: which plans do. */
  note: string | null;
}

const DETAILS: Record<VoiceEngineId, string> = {
  realtime: "A spoken conversation: it listens, talks back in its own words, and hands your requests to the agent.",
  "realtime-mini": "The same conversation on OpenAI's smaller model: about a third of the price, a little less sharp.",
  deepgram: "Deepgram hears you (Nova-3) and reads short summaries aloud in a natural voice (Aura).",
  standard: "Deepgram hears you (Nova-3); short summaries are read aloud by your browser's own voice, at no charge.",
};

export function voiceView(input: { engines: readonly VoiceEngine[] | null | "loading"; selected: VoiceEngineId; account: AccountView | null | undefined }): VoiceView {
  const { engines } = input;
  const options = VoiceEngineId.options.map((id): VoiceOption => {
    const e = engines === "loading" || !engines ? undefined : engines.find((x) => x.id === id);
    let cost: string;
    if (engines === "loading") cost = "Loading the price…";
    // An older server lists only Realtime and the browser voice.
    else if (engines && !e && id !== "realtime" && id !== "standard") cost = "Not available on the server yet.";
    else if (!e) cost = "The price couldn't be loaded right now.";
    else if (!e.available) cost = "Not available on this server right now.";
    else cost = costPerMinuteText(e.approxCentsPerMinute);
    // The tooltip names the server's model (its exact version may change).
    const title = e ? `${e.assumption} Model: ${e.model}.` : "";
    return { id, label: ENGINE_NAMES[id], detail: DETAILS[id], cost, title };
  });
  const allowed = !!input.account?.signedIn && voiceAllowed(input.account.plan);
  return { options, selected: input.selected, note: allowed ? null : `Voice needs ${plansWithText("voice")}` };
}

/** A browser voice as speechSynthesis lists it. */
export interface BrowserVoice {
  name: string;
  lang: string;
}

/** The voice and speed rows under the engines: they follow the engine selected. */
export interface VoicePicker {
  title: string;
  hint: string;
  options: { value: string; label: string }[];
  value: string;
  speed: SpeedRange & { value: number; hint: string };
  /** Under Test voice (Realtime: about what a sample costs). */
  testHint: string;
}

/** "1.0×", "0.75×". */
export const speedText = (n: number): string => `${Math.abs(n * 10 - Math.round(n * 10)) < 1e-9 ? n.toFixed(1) : String(n)}×`;

const speedHint = (r: SpeedRange) => `${speedText(r.min)} to ${speedText(r.max)}; ${speedText(r.default)} is normal.`;

export function voicePicker(input: {
  settings: Pick<ExtensionSettings, "voiceEngine" | "speechVoice" | "speechRate" | "realtimeVoice" | "realtimeSpeed" | "deepgramVoice" | "deepgramSpeed">;
  browserVoices: readonly BrowserVoice[];
  engines: readonly VoiceEngine[] | null | "loading";
}): VoicePicker {
  const s = input.settings;
  const listed = (id: VoiceEngineId) => (input.engines === "loading" || !input.engines ? undefined : input.engines.find((e) => e.id === id));
  if (s.voiceEngine === "deepgram") {
    const dg = listed("deepgram");
    return {
      title: "Deepgram voice",
      hint: "Deepgram's Aura voices. Thalia, Andromeda, Helena, Apollo, Arcas and Aries are Deepgram's picks.",
      options: DEEPGRAM_VOICES.map((id) => ({ value: id, label: `${deepgramVoiceName(id)}${RECOMMENDED_DEEPGRAM_VOICES.has(id) ? " (recommended)" : ""}` })),
      value: s.deepgramVoice,
      speed: { ...DEEPGRAM_SPEED, value: clampSpeed(s.deepgramSpeed, DEEPGRAM_SPEED), hint: speedHint(DEEPGRAM_SPEED) },
      testHint: `Says a sample line with this voice and speed${dg ? " (uses well under 1¢ of usage credit)" : ""}.`,
    };
  }
  if (isRealtimeEngine(s.voiceEngine)) {
    const rt = listed(s.voiceEngine);
    return {
      title: "Realtime voice",
      hint: "OpenAI's voices for Realtime. Marin and Cedar sound the most natural.",
      options: REALTIME_VOICES.map((id) => ({ value: id, label: `${realtimeVoiceName(id)}${RECOMMENDED_REALTIME_VOICES.has(id) ? " (recommended)" : ""}` })),
      value: s.realtimeVoice,
      speed: { ...REALTIME_SPEED, value: clampSpeed(s.realtimeSpeed, REALTIME_SPEED), hint: speedHint(REALTIME_SPEED) },
      testHint: `Says a sample line with this voice and speed${rt ? ` (${sampleCostText(rt.approxCentsPerMinute)})` : ""}.`,
    };
  }
  const current = s.speechVoice;
  const known = !current || input.browserVoices.some((v) => v.name === current);
  return {
    title: "Browser voice",
    hint: "Your browser's voices (also used when another voice can't be reached).",
    options: [
      { value: "", label: "Browser default" },
      ...input.browserVoices.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` })),
      // A voice saved on another computer: kept, shown as it is.
      ...(known ? [] : [{ value: current, label: `${current} (not on this computer)` }]),
    ],
    value: current,
    speed: { ...STANDARD_SPEED, value: clampSpeed(s.speechRate, STANDARD_SPEED), hint: speedHint(STANDARD_SPEED) },
    testHint: "Says a sample line with this voice and speed, on this computer.",
  };
}

/** The settings a voice or speed change saves, for the engine selected. */
export function voicePatch(engine: VoiceEngineId, change: { voice: string } | { speed: number }): Partial<ExtensionSettings> {
  if ("speed" in change) {
    if (engine === "deepgram") return { deepgramSpeed: clampSpeed(change.speed, DEEPGRAM_SPEED) };
    return isRealtimeEngine(engine) ? { realtimeSpeed: clampSpeed(change.speed, REALTIME_SPEED) } : { speechRate: clampSpeed(change.speed, STANDARD_SPEED) };
  }
  if (engine === "standard") return { speechVoice: change.voice };
  if (engine === "deepgram") return (DEEPGRAM_VOICES as readonly string[]).includes(change.voice) ? { deepgramVoice: change.voice as ExtensionSettings["deepgramVoice"] } : {};
  return (REALTIME_VOICES as readonly string[]).includes(change.voice) ? { realtimeVoice: change.voice as ExtensionSettings["realtimeVoice"] } : {};
}

/** Why Test voice could not say the Realtime sample, in a few words. */
export function sampleFailureText(err: unknown): string {
  const f = (err ?? {}) as { kind?: string; transient?: boolean; message?: string };
  if (f.kind === "busy") return "Realtime voice is on in another window. Try again once it ends.";
  if (f.transient) return "Realtime voice could not connect. Try again.";
  return f.message || String(err);
}

/** A choice of how notifications are heard (Settings > AI > Voice > Notifications). */
export interface NotificationOption {
  value: NotificationVoice;
  label: string;
  /** The server does not offer that engine (yet). */
  disabled: boolean;
}

/** The notification choices, each voice with the voice it would use ("OpenAI Realtime (Ash)"). */
export function notificationOptions(input: {
  settings: Pick<ExtensionSettings, "voiceEngine" | "speechVoice" | "realtimeVoice" | "deepgramVoice">;
  engines: readonly VoiceEngine[] | null | "loading";
}): NotificationOption[] {
  const s = input.settings;
  const voiceOf = (id: VoiceEngineId) =>
    isRealtimeEngine(id) ? realtimeVoiceName(s.realtimeVoice) : id === "deepgram" ? deepgramVoiceName(s.deepgramVoice) : s.speechVoice || "browser default";
  const unavailable = (id: VoiceEngineId) => {
    if (id === "standard" || input.engines === "loading" || !input.engines) return false;
    const e = input.engines.find((x) => x.id === id);
    return !e?.available;
  };
  return [
    { value: "same", label: `Same as hands-free voice (${ENGINE_NAMES[s.voiceEngine].replace(" (recommended)", "")})`, disabled: false },
    ...VoiceEngineId.options.map((id) => ({ value: id, label: `${ENGINE_NAMES[id].replace(" (recommended)", "")} (${voiceOf(id)})`, disabled: unavailable(id) })),
    { value: "chime", label: "Chime only", disabled: false },
    { value: "off", label: "Off (silent)", disabled: false },
  ];
}

/** The Language choices: Auto, then each language by its own name ("한국어 (Korean)"). */
export function languageOptions(): { value: LanguageSetting; label: string }[] {
  return [
    { value: "auto", label: "Auto (the language you speak)" },
    ...LANGUAGES.map((l) => ({ value: l.code, label: l.native === l.name ? l.name : `${l.native} (${l.name})` })),
  ];
}

/** Under Language: what it changes, and what the selected engine cannot do in it. */
export function languageHint(s: Pick<ExtensionSettings, "language" | "voiceEngine">): string {
  const lang = chosenLanguage(s.language);
  if (!lang) return "Noa answers in the language you speak to it; its own lines, like progress and notifications, are in English.";
  const base = `You talk to Noa in ${lang.name}, and it answers in ${lang.name}: spoken lines, notifications and its replies in chat.`;
  if (s.voiceEngine === "deepgram" && !deepgramSpeaks(lang)) return `${base} Deepgram's voices speak English only, so your browser's voice reads the lines.`;
  if (s.voiceEngine === "standard") return `${base} Your browser reads them with a voice for ${lang.name} when it has one.`;
  return base;
}

/** The voice row under Notifications: the voices of the engine notifications use. */
export interface NotificationVoicePicker {
  title: string;
  options: { value: string; label: string }[];
  /** "" = the engine's voice above. */
  value: string;
}

/** The notification voice row, or null when notifications have no voice (a chime, or off). */
export function notificationVoicePicker(input: {
  settings: Pick<ExtensionSettings, "notificationVoice" | "notificationSpeaker" | "voiceEngine" | "speechVoice" | "realtimeVoice" | "deepgramVoice">;
  browserVoices: readonly BrowserVoice[];
}): NotificationVoicePicker | null {
  const s = input.settings;
  const source = notificationSource(s);
  if (source === "chime" || source === "off") return null;
  const own = s.notificationSpeaker;
  let title: string;
  let above: string;
  let voices: { value: string; label: string }[];
  if (source === "deepgram") {
    title = "Deepgram voice";
    above = deepgramVoiceName(s.deepgramVoice);
    voices = DEEPGRAM_VOICES.map((id) => ({ value: id, label: `${deepgramVoiceName(id)}${RECOMMENDED_DEEPGRAM_VOICES.has(id) ? " (recommended)" : ""}` }));
  } else if (isRealtimeEngine(source)) {
    title = "Realtime voice";
    above = realtimeVoiceName(s.realtimeVoice);
    voices = REALTIME_VOICES.map((id) => ({ value: id, label: `${realtimeVoiceName(id)}${RECOMMENDED_REALTIME_VOICES.has(id) ? " (recommended)" : ""}` }));
  } else {
    title = "Browser voice";
    above = s.speechVoice || "browser default";
    voices = input.browserVoices.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` }));
    // A voice saved on another computer: kept, shown as it is.
    if (own && !voices.some((v) => v.value === own) && !isEngineVoiceId(own)) voices.push({ value: own, label: `${own} (not on this computer)` });
  }
  // A voice of another engine (picked before the engine changed) is not used: the voice above is.
  const value = voices.some((v) => v.value === own) ? own : "";
  // The voice above is the hands-free one only when notifications use the hands-free engine.
  const first = source === s.voiceEngine ? `Same as hands-free voice (${above})` : `Default (${above})`;
  return { title, options: [{ value: "", label: first }, ...voices], value };
}

const isEngineVoiceId = (v: string) => (REALTIME_VOICES as readonly string[]).includes(v) || (DEEPGRAM_VOICES as readonly string[]).includes(v);
