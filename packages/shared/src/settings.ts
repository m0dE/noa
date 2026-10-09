import { z } from "zod";
import { DEFAULT_MODEL } from "./models.js";
import { DEFAULT_REASONING, ReasoningLevel } from "./reasoning.js";
import { MemoryKind } from "./memory.js";
import { AutomationLevel, DEFAULT_AUTOMATION_LEVEL, DEFAULT_SCHEDULED_AUTOMATION, ScheduledAutomation } from "./automation.js";
import { DEFAULT_IMAGE_MODEL, ImageModelId } from "./images.js";
import { LanguageSetting } from "./language.js";
import {
  DEEPGRAM_SPEED,
  DeepgramVoiceId,
  DEFAULT_DEEPGRAM_VOICE,
  DEFAULT_REALTIME_VOICE,
  NotificationVoice,
  REALTIME_SPEED,
  RealtimeVoiceId,
  STANDARD_SPEED,
  VoiceEngineId,
} from "./voice.js";

/** The Noa account server. */
export const ACCOUNT_API_BASE = "https://app.noa.bot";
/**
 * Other addresses of the same server (the Worker's workers.dev address, and the one from before the rebrand, which now
 * redirects: a redirect to another site loses the Authorization header); a saved one is moved to ACCOUNT_API_BASE. The
 * former name is assembled from parts, as in scripts/lib/old-brand.mjs, so it appears nowhere in the repository.
 */
export const PREVIOUS_ACCOUNT_API_BASES: readonly string[] = ["https://noa-api.jaeyun.workers.dev", `https://app.${["brow", "ser", "to", "do"].join("")}.com`];

/**
 * An account server address as it is kept: trimmed, without a trailing
 * slash, and an earlier default (PREVIOUS_ACCOUNT_API_BASES) moved to
 * ACCOUNT_API_BASE. Stored settings and the session issued by that server
 * both go through it, so they keep naming the same server.
 */
export function currentAccountApiBase(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return PREVIOUS_ACCOUNT_API_BASES.includes(u) ? ACCOUNT_API_BASE : u;
}

export const BrainMode = z.enum(["auto", "claude-code", "claude-api", "noa"]);
export type BrainMode = z.infer<typeof BrainMode>;

/** Extension settings stored in chrome.storage.local under "settings". */
export const ExtensionSettings = z.object({
  /**
   * Which agent runs tasks. auto: the user's own Claude first (local Claude
   * Code when the helper is connected and its self-test passed, else the
   * Claude API key), else Noa AI when signed in with usage credit or
   * an active paid plan (apps/extension/src/engine/brain-resolver.ts).
   */
  brain: BrainMode.default("auto"),
  anthropicApiKey: z.string().default(""),
  anthropicModel: z.string().default(DEFAULT_MODEL),
  /** How much Claude thinks before it acts, for every brain (reasoning.ts). */
  reasoning: ReasoningLevel.default(DEFAULT_REASONING),
  /** Fast only: when a run gets stuck (a step keeps failing, the same action repeats), its next steps think. */
  reasoningAutoRaise: z.boolean().default(true),
  /** Jev speeds up single steps. Used only when a key is set and jevEnabled. */
  jevApiKey: z.string().default(""),
  /**
   * The Noa account server (Google sign-in, the account's TODO list,
   * billing and the hosted AI). Self-hosters point it at their own API.
   */
  accountApiBase: z.string().default(ACCOUNT_API_BASE),
  /** Pause a scheduled job (the rest of its repeats) after this many of its runs failed in a row. 0 never pauses. */
  maxConsecutiveFailures: z.number().int().min(0).max(100).default(3),
  /** Minutes before a task that hit a temporary problem is retried. */
  retryAfterMinutes: z.number().int().min(1).max(24 * 60).default(10),
  intervalMinutes: z.number().min(1).max(24 * 60).default(15),
  delayMinSec: z.number().min(0).max(3600).default(60),
  delayMaxSec: z.number().min(0).max(3600).default(180),
  maxToolCalls: z.number().int().min(5).max(500).default(60),
  /** A turn's limit in ACTIVE minutes: waiting in wait_for or for an approval does not count (turn-time.ts). */
  maxTaskMinutes: z.number().min(1).max(120).default(10),
  /**
   * Due tasks that may run at the same time, each in its own tab (tasks that
   * act as an X account still run one at a time). One-off runs from the side
   * panel run beside them.
   */
  maxParallelTasks: z.number().int().min(1).max(4).default(2),
  jevEnabled: z.boolean().default(true),
  jevThreshold: z.number().min(0).max(1).default(0.8),
  /** Minutes before a paused task can be claimed again. */
  pauseRetryMinutes: z.number().int().min(1).max(24 * 60).default(15),
  /**
   * Hands-free voice (the voice shortcut): realtime / realtime-mini = OpenAI Realtime through
   * the account server (a spoken narrator; the full or the smaller model); deepgram =
   * speech-to-text and Deepgram's voice on the server; standard = speech-to-text on the server
   * with the browser's own speech. See VoiceEngineId.
   */
  voiceEngine: VoiceEngineId.default("realtime"),
  /** The Standard engine's voice: a speechSynthesis voice name; "" = the browser's default. */
  speechVoice: z.string().default(""),
  /** The Standard engine's speaking speed (1 = normal; STANDARD_SPEED). */
  speechRate: z.number().min(STANDARD_SPEED.min).max(STANDARD_SPEED.max).default(STANDARD_SPEED.default),
  /** The Realtime narrator's voice (one of OpenAI's built-in voices). */
  realtimeVoice: RealtimeVoiceId.default(DEFAULT_REALTIME_VOICE),
  /** The Realtime narrator's speaking speed (1 = normal; REALTIME_SPEED). */
  realtimeSpeed: z.number().min(REALTIME_SPEED.min).max(REALTIME_SPEED.max).default(REALTIME_SPEED.default),
  /** The Deepgram engine's voice (one of Aura's English voices). */
  deepgramVoice: DeepgramVoiceId.default(DEFAULT_DEEPGRAM_VOICE),
  /** The Deepgram engine's speaking speed (1 = normal; DEEPGRAM_SPEED), applied when played. */
  deepgramSpeed: z.number().min(DEEPGRAM_SPEED.min).max(DEEPGRAM_SPEED.max).default(DEEPGRAM_SPEED.default),
  /** Hands-free voice makes a short soft sound when the microphone goes live and when it stops. */
  voiceSounds: z.boolean().default(true),
  /**
   * How Noa's notifications (a scheduled job started, paused, needs your OK) are also heard, so the user notices
   * them while working in another tab (notify.ts): in the hands-free engine's voice ("same"), another engine's
   * voice (with that engine's voice and speed above), a chime, or not at all. Replaces speakNotifications (false
   * became "off", parseSettings).
   */
  notificationVoice: NotificationVoice.default("same"),
  /**
   * The voice notifications are said in, just for them, among the voices of the engine they use
   * (notificationSource): a Realtime or Deepgram voice id, or a browser voice name. "" = that engine's voice above.
   * A value that is not one of that engine's voices (the engine changed since) also means the voice above.
   */
  notificationSpeaker: z.string().max(200).default(""),
  /**
   * The language Noa talks in (language.ts): the transcription's hint, what hands-free voice and notifications say,
   * and what the agent writes back. "auto": the language the user speaks, with Noa's own lines in English.
   */
  language: LanguageSetting.default("auto"),
  /** A tab the agent controls shows it on the page: a glow and a "Noa is working" pill with Stop (Settings > Tasks). */
  showControlOverlay: z.boolean().default(true),
  /** How much the chat agent does without asking (automation.ts); enforced before each browser action. */
  automationLevel: AutomationLevel.default(DEFAULT_AUTOMATION_LEVEL),
  /** The side panel's "Permission: Full autonomy" line was closed; cleared when full autonomy is turned off (it shows again when turned on). */
  autonomyWarningClosed: z.boolean().default(false),
  /** The same for scheduled runs of the TODO list (automation.ts). */
  scheduledAutomation: ScheduledAutomation.default(DEFAULT_SCHEDULED_AUTOMATION),
  /**
   * The agent may make pictures (generate_image, paid from the Noa account's usage credit). Off: the tool is not
   * offered to either brain, and a call from a session that started before is refused.
   */
  imageGeneration: z.boolean().default(true),
  /** The model generate_image uses (images.ts IMAGE_MODELS). */
  imageModel: ImageModelId.default(DEFAULT_IMAGE_MODEL),
  /** Memory is paused: the agent is given none and saves none (Settings > Memory). What is kept stays. */
  memoryPaused: z.boolean().default(false),
  /** Kinds of memory turned off: not given to the agent, not saved (memory.ts). */
  memoryKindsOff: z.array(MemoryKind).default([]),
  /** Noa Browser: its bookmarks sync with the signed-in Noa account (bookmark-sync.ts; the extension in Chrome has no bookmarks). */
  bookmarkSync: z.boolean().default(false),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettings>;

export const DEFAULT_SETTINGS: ExtensionSettings = ExtensionSettings.parse({});

/** Parse stored settings, filling defaults for missing or invalid fields. */
export function parseSettings(raw: unknown): ExtensionSettings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ExtensionSettings)[]) {
    const field = ExtensionSettings.shape[key];
    const parsed = field.safeParse(obj[key]);
    if (parsed.success && obj[key] !== undefined) out[key] = parsed.data;
  }
  const s = out as ExtensionSettings;
  // "Read notifications aloud" turned off, before notificationVoice.
  if (obj.notificationVoice === undefined && obj.speakNotifications === false) s.notificationVoice = "off";
  if (s.delayMaxSec < s.delayMinSec) s.delayMaxSec = s.delayMinSec;
  // Installs saved with an earlier default follow the default to its new address.
  s.accountApiBase = currentAccountApiBase(s.accountApiBase);
  return s;
}

/** Random delay in ms between tasks, uniform in [min, max] seconds. */
export function pickDelayMs(s: Pick<ExtensionSettings, "delayMinSec" | "delayMaxSec">, rand = Math.random): number {
  const min = Math.min(s.delayMinSec, s.delayMaxSec);
  const max = Math.max(s.delayMinSec, s.delayMaxSec);
  return Math.round((min + rand() * (max - min)) * 1000);
}

/** Settings that hold secrets: never shown or logged, only marked as set (redactSettings). */
export const SECRET_SETTING_KEYS = ["anthropicApiKey", "jevApiKey"] as const satisfies readonly (keyof ExtensionSettings)[];
/** What a secret that is set reads as in redacted settings ("" when it is not set). */
export const REDACTED = "set";

/** Settings with secrets replaced by REDACTED/"" markers, safe to show or log. */
export function redactSettings(s: ExtensionSettings): ExtensionSettings {
  const out = { ...s };
  for (const key of SECRET_SETTING_KEYS) out[key] = s[key] ? REDACTED : "";
  return out;
}
