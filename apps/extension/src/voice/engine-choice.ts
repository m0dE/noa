/**
 * Before a hands-free session starts on the engine picked in Settings
 * (Realtime by default): whether it can, and what is worth knowing. The
 * engine is always the one picked; when it cannot run (the server does not
 * offer it, or not yet) the session does not start, and the panel says why and
 * lets the user choose (the browser voice for this once, or Settings). Costs
 * come from the server (GET VOICE_ENGINES_PATH), never from here. Pure.
 */
import { isRealtimeEngine, type VoiceEngineId, type VoiceEnginesResponse } from "@noa/shared";

/** Credit for fewer minutes of Realtime than this is worth a note (the session still starts). */
export const LOW_CREDIT_MINUTES = 3;

/** The engines' names (the owner's wording; the server's list gives their prices). */
export const ENGINE_NAMES: Record<VoiceEngineId, string> = {
  realtime: "OpenAI Realtime (recommended)",
  "realtime-mini": "OpenAI Realtime mini",
  deepgram: "Deepgram",
  standard: "Browser voice",
};

/** An engine's name in a sentence ("Realtime mini voice"). */
export const ENGINE_SHORT_NAMES: Record<VoiceEngineId, string> = { realtime: "Realtime", "realtime-mini": "Realtime mini", deepgram: "Deepgram", standard: "Browser" };

/** Realtime cannot run on the account server (not offered, or it refused the server's key). */
export const REALTIME_UNAVAILABLE_TEXT = "Realtime voice is unavailable on the server right now.";

/** The picked engine cannot run on the account server (not offered, or not yet: an older server). */
export const unavailableText = (id: VoiceEngineId) => (id === "realtime" ? REALTIME_UNAVAILABLE_TEXT : `${ENGINE_SHORT_NAMES[id]} voice is unavailable on the server right now.`);

export interface EngineCheck {
  /** Why the picked engine cannot start (null: it can). */
  blocked: string | null;
  /** Worth knowing as it starts, e.g. credit for only a few minutes (null: nothing). */
  note: string | null;
}

/** "Usage credit is low: about 2 minutes of Realtime voice left." */
export const lowCreditText = (minutes: number, id: VoiceEngineId = "realtime") =>
  `Usage credit is low: about ${minutes} minute${minutes === 1 ? "" : "s"} of ${ENGINE_SHORT_NAMES[id]} voice left.`;

export function checkEngine(opts: {
  picked: VoiceEngineId;
  /** The server's engines and its default; null when they could not be loaded (the relay then says if it cannot). */
  engines: VoiceEnginesResponse | null;
  /** Usage credit left, in cents (undefined: not known). */
  creditCents: number | undefined;
}): EngineCheck {
  if (opts.picked === "standard" || !opts.engines) return { blocked: null, note: null };
  const picked = opts.engines.engines.find((e) => e.id === opts.picked);
  // Not listed: a server from before this engine. The server offers Standard as its default only when it cannot run Realtime.
  if (!picked?.available || (isRealtimeEngine(opts.picked) && opts.engines.default === "standard")) return { blocked: unavailableText(opts.picked), note: null };
  const perMinute = picked.approxCentsPerMinute;
  if (opts.creditCents !== undefined && perMinute > 0 && opts.creditCents < perMinute * LOW_CREDIT_MINUTES) {
    return { blocked: null, note: lowCreditText(Math.floor(opts.creditCents / perMinute), opts.picked) };
  }
  return { blocked: null, note: null };
}

/** "about 30¢ of usage credit a minute", "about 2.3¢ …", "about $1.25 of usage credit a minute". */
export function costPerMinuteText(cents: number): string {
  const unit = " of usage credit a minute";
  if (cents >= 100) return `about $${(cents / 100).toFixed(2)}${unit}`;
  if (cents >= 10) return `about ${Math.round(cents)}¢${unit}`;
  // One decimal under 10¢, so engines a cent or so apart read apart (1.7¢, 2.3¢).
  if (cents >= 1) return `about ${Number(cents.toFixed(1))}¢${unit}`;
  if (cents < 0.01) return `under 0.01¢${unit}`;
  return `about ${Number(cents.toPrecision(2))}¢${unit}`;
}
