import { z } from "zod";
import type { LanguageInfo } from "./language.js";

/**
 * Voice input: the one place for its contract, limits and tuning. The API
 * (apps/api/src/transcribe.ts) enforces the limits; the extension
 * (apps/extension/src/voice/) captures, detects speech and dictates live with
 * the same numbers. Prices are in apps/api/src/pricing.ts, the plans that
 * include voice in PLAN_CATALOG (`voice`), request rates in apps/api/src/ratelimit.ts.
 */

/** POST: a WAV clip in, its text out (session token; paid plans). */
export const TRANSCRIBE_PATH = "/v1/ai/transcribe";
export const TRANSCRIBE_CONTENT_TYPE = "audio/wav";

/** Query parameters of TRANSCRIBE_PATH. */
export const TRANSCRIBE_QUERY = {
  /** Language hint ("en", "ko", "pt-BR"); absent = the model detects it. */
  language: "language",
  /** Milliseconds of speech the client's detector heard (0 = silence: nothing is sent to the model). */
  speechMs: "speech_ms",
  /** Text said just before this clip (live dictation), for consistent wording. */
  context: "context",
} as const;

/** 200 of TRANSCRIBE_PATH. */
export const TranscribeResponse = z.object({
  text: z.string(),
  /** Audio length billed. */
  seconds: z.number(),
  /** Charged for this clip, in (fractional) cents. */
  chargedCents: z.number(),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponse>;

/** Limits both sides agree on. */
export const VOICE_LIMITS = {
  /** Sample rate of the clips (Whisper's native rate), mono 16-bit PCM. */
  sampleRate: 16_000,
  /** Longest clip, and longest listening session. */
  maxClipMs: 60_000,
  /** Largest request body: 60 s at 16 kHz mono 16-bit is 1.92 MB plus the header. */
  maxClipBytes: 2 * 1024 * 1024,
  /** Shorter clips are not sent to the model and cost nothing. */
  minClipMs: 250,
  /** Whisper's stock phrases ("Thank you.") on less speech than this are treated as silence. */
  hallucinationSpeechMs: 1_500,
  /** Most characters of `context` the model is given. */
  contextChars: 300,
} as const;

/** Capture, speech detection and live dictation tuning (extension). */
export const VOICE_TUNING = {
  /** Analysis frame of the speech detector. */
  frameMs: 20,
  /** A frame is speech when its RMS is this many times the running noise floor... */
  speechOverNoise: 3,
  /** ...and at least this loud (RMS of samples in -1..1). */
  minSpeechRms: 0.012,
  /** Loud audio for this long starts speech (debounces clicks and taps). */
  speechStartMs: 80,
  /** Speech lasts until it has been quiet this long (bridges the dips between syllables). */
  speechHangoverMs: 200,
  /**
   * The noise floor tracks the quietest input: it drops this fast (per frame,
   * 0..1) to a quieter frame, like the dips between syllables...
   */
  noiseFloorFall: 0.2,
  /** ...and otherwise rises this slowly, so a new steady noise (a fan) stops counting as speech after a few seconds. */
  noiseFloorRise: 0.002,
  /** Audio kept before the first and after the last speech frame of a clip. */
  preRollMs: 200,
  postRollMs: 300,
  /** Live text: send the audio heard so far this often while someone speaks (one request in flight). */
  partialIntervalMs: 1_000,
  /** Re-transcribe at most about this much audio: older speech is finalised at a pause. */
  windowMs: 10_000,
  /** Quiet (after the hangover) at least this long is a pause where finalised text may end. */
  commitPauseMs: 200,
  /** With no such pause for this long, finalise at the quietest moment anyway. */
  forceCommitMs: 20_000,
  /** Level meter smoothing (0..1 per frame; higher follows faster). */
  levelSmoothing: 0.35,
} as const;

// ---- Realtime voice (GET /v1/ai/realtime) ----------------------------------------------------
// A WebSocket relay to OpenAI's Realtime API: the extension speaks OpenAI Realtime events,
// the server holds the key, filters what the client may change and meters every response.
// Contract: docs/BILLING-CONTRACT.md ("Realtime voice"); server: apps/api/src/realtime/.

/** GET: the WebSocket (with Upgrade), or a JSON check of whether it would be accepted (without). */
export const REALTIME_PATH = "/v1/ai/realtime";

/**
 * Browsers cannot set headers on a WebSocket, so the session token rides in the subprotocol
 * list: `new WebSocket(url, [REALTIME_PROTOCOL, REALTIME_TOKEN_PROTOCOL_PREFIX + token])`.
 * The server selects REALTIME_PROTOCOL (the token is never echoed).
 */
export const REALTIME_PROTOCOL = "noa";
export const REALTIME_TOKEN_PROTOCOL_PREFIX = "bt.";

/**
 * The input transcription model the extension turns on in a realtime session (the user's own
 * words for the chat). The relay allows and bills it (the server's REALTIME_TRANSCRIBE_PRICES),
 * and the voice engines' Realtime price includes it.
 */
export const REALTIME_INPUT_TRANSCRIPTION_MODEL = "gpt-transcribe";

/** Query parameters of REALTIME_PATH. */
export const REALTIME_QUERY = {
  /** Optional chat/run id, recorded with the session's usage (like X-Noa-Session). */
  session: "session",
  /**
   * "1": if another session of this user is open, it is ended (REALTIME_CLOSE.concurrent with a
   * `session_replaced` event) and this one takes its place, instead of the 409 session_open.
   */
  takeover: "takeover",
  /**
   * REALTIME_TIER_MINI ("mini"): the session runs on the server's smaller Realtime model (the
   * realtime-mini voice engine, about a third of the price). Absent: the full model.
   */
  tier: "tier",
} as const;

/** REALTIME_QUERY.tier of the smaller model. */
export const REALTIME_TIER_MINI = "mini";

/** Limits of one realtime session (the server enforces them). */
export const REALTIME_LIMITS = {
  /** Longest session; then it closes with REALTIME_CLOSE.sessionLimit. */
  maxSessionMs: 30 * 60_000,
  /**
   * No activity this long closes the session (REALTIME_CLOSE.idle). Activity: the user
   * speaking (the server VAD's input_audio_buffer.speech_started), or the client sending
   * input_audio_buffer.commit, conversation.item.create or response.create. Streaming
   * silent microphone audio alone is not activity.
   */
  idleMs: 5 * 60_000,
  /** Largest client message; a bigger one closes the session with 1009. */
  maxClientMessageBytes: 2 * 1024 * 1024,
  /** Realtime sessions one user may have open at once (another answers 409 / REALTIME_CLOSE.concurrent). */
  sessionsPerUser: 1,
} as const;

/**
 * WebSocket close codes of a realtime session. A refusal before the session starts
 * (auth, plan, credit, not configured, another session open) also arrives this way on an
 * upgrade request: the server accepts, sends one `noa.error` event and closes, so
 * browsers (which cannot read an HTTP refusal) learn why.
 */
export const REALTIME_CLOSE = {
  /** The client closed, or the server closed after the client did. */
  normal: 1000,
  /** A client message over REALTIME_LIMITS.maxClientMessageBytes. */
  tooBig: 1009,
  /** Not signed in, or the session token is invalid or expired. */
  auth: 4401,
  /** Out of usage credit (before the start, or mid-session after a response was charged). */
  credit: 4402,
  /** The plan does not include voice. */
  plan: 4403,
  /** Idle for REALTIME_LIMITS.idleMs. */
  idle: 4408,
  /** Another realtime session of this user is open, or (with `session_replaced`) a new one took this one's place. */
  concurrent: 4409,
  /** REALTIME_LIMITS.maxSessionMs reached. */
  sessionLimit: 4410,
  /** OpenAI failed or closed the connection. */
  upstream: 4500,
  /** Realtime is unavailable on this server (not configured, or OpenAI refused the server's key). */
  unavailable: 4503,
} as const;

/** The server's own event type (every other event is OpenAI's, relayed verbatim). */
export const REALTIME_ERROR_EVENT = "noa.error";

/** `error` codes of a REALTIME_ERROR_EVENT. */
export const RealtimeErrorCode = z.enum([
  "unauthorized",
  "plan_required",
  "out_of_credit",
  "realtime_unavailable",
  "session_open",
  /** This session was ended because a new one of the same user took over (REALTIME_QUERY.takeover). */
  "session_replaced",
  "denied",
  "idle_timeout",
  "session_limit",
  "message_too_big",
  "upstream_error",
]);
export type RealtimeErrorCode = z.infer<typeof RealtimeErrorCode>;

/**
 * `{ type: "noa.error", error, message, ... }`. Extra fields by code: out_of_credit has
 * `topupUrl`; plan_required has `feature` and `upgradeUrl`; denied has `event_id` (of the
 * refused client event, when it had one) and is not followed by a close.
 */
export const RealtimeErrorEvent = z.looseObject({ type: z.literal(REALTIME_ERROR_EVENT), error: RealtimeErrorCode, message: z.string() });
export type RealtimeErrorEvent = z.infer<typeof RealtimeErrorEvent>;

/** `error` of a refusal before the session starts (HTTP status for a plain GET, close code for an upgrade). */
export const REALTIME_UNAVAILABLE_CODE = "realtime_unavailable";

// ---- Voice engines (GET /v1/billing/voice-engines, public) -------------------------------------

export const VOICE_ENGINES_PATH = "/v1/billing/voice-engines";
/**
 * realtime: OpenAI Realtime (the full model) listens and talks. realtime-mini: the same on the
 * smaller model. deepgram: Deepgram Nova-3 turns speech into text, Deepgram Aura says the replies
 * (SPEAK_PATH). standard: Nova-3 turns speech into text, the browser's own voice says the replies.
 */
export const VoiceEngineId = z.enum(["realtime", "realtime-mini", "deepgram", "standard"]);
export type VoiceEngineId = z.infer<typeof VoiceEngineId>;

export const VoiceEngine = z.object({
  id: VoiceEngineId,
  name: z.string(),
  /** The provider model (realtime*: the OpenAI model; deepgram: speech-to-text + text-to-speech; standard: the speech-to-text model). */
  model: z.string(),
  /** Usage credit per minute of conversation, in (fractional) cents, under `assumption`. */
  approxCentsPerMinute: z.number(),
  /** What a "minute of conversation" is assumed to contain, in words users can read. */
  assumption: z.string(),
  /** False when this server cannot run the engine (e.g. no OpenAI key): clients fall back to the other. */
  available: z.boolean(),
});
export type VoiceEngine = z.infer<typeof VoiceEngine>;

/** 200 of VOICE_ENGINES_PATH. `default`: the engine to use unless the user picked one. */
export const VoiceEnginesResponse = z.object({ engines: z.array(VoiceEngine), default: VoiceEngineId });
export type VoiceEnginesResponse = z.infer<typeof VoiceEnginesResponse>;

// ---- Voices and speaking speed of the two hands-free engines -----------------------------------

/**
 * OpenAI's built-in Realtime voices (`session.audio.output.voice`), as the API reference lists them
 * for gpt-realtime-2.1 (checked 2026-09-26); OpenAI recommends Marin and Cedar. The relay accepts
 * only these (a custom voice id would be this server's organization's). The voice cannot change
 * after the narrator first spoke in a session: it is set when the session starts.
 */
export const REALTIME_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
export const RealtimeVoiceId = z.enum(REALTIME_VOICES);
export type RealtimeVoiceId = z.infer<typeof RealtimeVoiceId>;
/** The narrator's voice unless the user picks another. */
export const DEFAULT_REALTIME_VOICE: RealtimeVoiceId = "ash";
/** OpenAI's recommended voices (shown first, marked). */
export const RECOMMENDED_REALTIME_VOICES: ReadonlySet<RealtimeVoiceId> = new Set(["marin", "cedar"]);

/** A voice's name as users read it ("marin" -> "Marin"). */
export const realtimeVoiceName = (id: RealtimeVoiceId): string => id.charAt(0).toUpperCase() + id.slice(1);

/** The engines where OpenAI Realtime listens and talks (one relay session). */
export const isRealtimeEngine = (id: VoiceEngineId): id is "realtime" | "realtime-mini" => id === "realtime" || id === "realtime-mini";

// ---- Text-to-speech (POST SPEAK_PATH): Deepgram Aura on Workers AI --------------------------------

/** Says `text` in a Deepgram voice: JSON SpeakRequest in, audio/mpeg out (header CHARGED_CENTS_HEADER). */
export const SPEAK_PATH = "/v1/ai/speak";

/**
 * Deepgram Aura-2's English voices (Workers AI @cf/deepgram/aura-2-en `speaker`, checked 2026-09-30).
 * Deepgram features Thalia, Andromeda, Helena, Apollo, Arcas and Aries.
 */
export const DEEPGRAM_VOICES = [
  "thalia", "andromeda", "helena", "apollo", "arcas", "aries",
  "amalthea", "asteria", "athena", "atlas", "aurora", "callista", "cora", "cordelia", "delia", "draco",
  "electra", "harmonia", "hera", "hermes", "hyperion", "iris", "janus", "juno", "jupiter", "luna",
  "mars", "minerva", "neptune", "odysseus", "ophelia", "orion", "orpheus", "pandora", "phoebe", "pluto",
  "saturn", "theia", "vesta", "zeus",
] as const;
export const DeepgramVoiceId = z.enum(DEEPGRAM_VOICES);
export type DeepgramVoiceId = z.infer<typeof DeepgramVoiceId>;
export const DEFAULT_DEEPGRAM_VOICE: DeepgramVoiceId = "thalia";
export const RECOMMENDED_DEEPGRAM_VOICES: ReadonlySet<DeepgramVoiceId> = new Set(["thalia", "andromeda", "helena", "apollo", "arcas", "aries"]);
/**
 * Whether the Deepgram voice can say lines in the language picked in Settings (null: "auto", as before): its Aura
 * voices are English (aura-2-en). In another language the browser's voice says them (the hands-free engine, notifications).
 */
export const deepgramSpeaks = (language: Pick<LanguageInfo, "code"> | null | undefined): boolean => !language || language.code === "en";
/** "thalia" -> "Thalia". */
export const deepgramVoiceName = (id: DeepgramVoiceId): string => id.charAt(0).toUpperCase() + id.slice(1);

/** Longest text one SPEAK_PATH request says (a spoken summary or notice is far shorter). */
export const SPEAK_MAX_CHARS = 1_000;

export const SpeakRequest = z.object({ text: z.string().trim().min(1).max(SPEAK_MAX_CHARS), voice: DeepgramVoiceId });
export type SpeakRequest = z.infer<typeof SpeakRequest>;

/** The Deepgram voice's speed, applied by the player (Aura has no speed of its own). */
export const DEEPGRAM_SPEED: SpeedRange = { min: 0.5, max: 2, step: 0.05, default: 1 };

/**
 * How Noa's notifications are said (Settings > AI > Voice): "same" as the hands-free voice engine, one
 * engine's voice, "chime" (a short sound, no words), or "off" (silent; the notification still shows).
 */
export const NotificationVoice = z.enum(["same", "realtime", "realtime-mini", "deepgram", "standard", "chime", "off"]);
export type NotificationVoice = z.infer<typeof NotificationVoice>;

/** The engine notifications are said with ("same" = the hands-free engine), or "chime" / "off". */
export function notificationSource(s: { notificationVoice: NotificationVoice; voiceEngine: VoiceEngineId }): VoiceEngineId | "chime" | "off" {
  return s.notificationVoice === "same" ? s.voiceEngine : s.notificationVoice;
}

/** A speaking speed range: a multiple of normal speed, `step` for the slider. */
export interface SpeedRange {
  min: number;
  max: number;
  step: number;
  default: number;
}

/** `session.audio.output.speed` (API reference, 2026-09-26): 0.25 to 1.5, 1 normal; it changes between turns only. */
export const REALTIME_SPEED: SpeedRange = { min: 0.25, max: 1.5, step: 0.05, default: 1 };
/** The browser's speechSynthesis rate as the Standard engine uses it. */
export const STANDARD_SPEED: SpeedRange = { min: 0.5, max: 2, step: 0.1, default: 1 };

/** `speed` kept inside `range` and on its steps. */
export function clampSpeed(speed: number, range: SpeedRange): number {
  if (!Number.isFinite(speed)) return range.default;
  const stepped = Math.round((speed - range.min) / range.step) * range.step + range.min;
  return Math.round(Math.min(range.max, Math.max(range.min, stepped)) * 100) / 100;
}
