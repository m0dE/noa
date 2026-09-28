/**
 * Pure logic of Settings > AI > Voice: the two hands-free engines with what
 * a minute of each costs in usage credit (the server's numbers), and whether
 * the plan includes voice. voice-section.ts renders it.
 */
import {
  clampSpeed,
  plansWithText,
  REALTIME_SPEED,
  REALTIME_VOICES,
  realtimeVoiceName,
  RECOMMENDED_REALTIME_VOICES,
  STANDARD_SPEED,
  type ExtensionSettings,
  type SpeedRange,
  type VoiceEngine,
  type VoiceEngineId,
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
  standard: "Your words become text on our server; short summaries are read aloud by your browser.",
};

export function voiceView(input: { engines: readonly VoiceEngine[] | null | "loading"; selected: VoiceEngineId; account: AccountView | null | undefined }): VoiceView {
  const { engines } = input;
  const options = (["realtime", "standard"] as const).map((id): VoiceOption => {
    const e = engines === "loading" || !engines ? undefined : engines.find((x) => x.id === id);
    let cost: string;
    if (engines === "loading") cost = "Loading the price…";
    else if (!e) cost = "The price couldn't be loaded right now.";
    else if (!e.available) cost = "Not available on this server right now: Whisper + browser voice is used instead.";
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
  settings: Pick<ExtensionSettings, "voiceEngine" | "speechVoice" | "speechRate" | "realtimeVoice" | "realtimeSpeed">;
  browserVoices: readonly BrowserVoice[];
  engines: readonly VoiceEngine[] | null | "loading";
}): VoicePicker {
  const s = input.settings;
  if (s.voiceEngine === "realtime") {
    const rt = input.engines === "loading" || !input.engines ? undefined : input.engines.find((e) => e.id === "realtime");
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
    hint: "Your browser's voices (also used when Realtime falls back to Whisper).",
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
    return engine === "realtime" ? { realtimeSpeed: clampSpeed(change.speed, REALTIME_SPEED) } : { speechRate: clampSpeed(change.speed, STANDARD_SPEED) };
  }
  if (engine === "standard") return { speechVoice: change.voice };
  return (REALTIME_VOICES as readonly string[]).includes(change.voice) ? { realtimeVoice: change.voice as ExtensionSettings["realtimeVoice"] } : {};
}

/** Why Test voice could not say the Realtime sample, in a few words. */
export function sampleFailureText(err: unknown): string {
  const f = (err ?? {}) as { kind?: string; transient?: boolean; message?: string };
  if (f.kind === "busy") return "Realtime voice is on in another window. Try again once it ends.";
  if (f.transient) return "Realtime voice could not connect. Try again.";
  return f.message || String(err);
}
