import { describe, expect, it } from "vitest";
import type { VoiceEngine } from "@noa/shared";
import { notificationOptions, notificationVoicePicker, sampleFailureText, speedText, voicePatch, voicePicker, voiceView } from "../../src/options/voice-view.js";
import { DEFAULT_SETTINGS } from "@noa/shared";
import type { AccountView } from "../../src/ui-protocol.js";

const engines: VoiceEngine[] = [
  { id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 5.3, assumption: "Per minute of conversation: you talk for 1 minute and it speaks for 18 seconds.", available: true },
  { id: "realtime-mini", name: "Realtime mini", model: "gpt-realtime-2.1-mini", approxCentsPerMinute: 2.3, assumption: "Per minute of conversation.", available: true },
  { id: "deepgram", name: "Deepgram", model: "nova-3 + aura-2-en", approxCentsPerMinute: 1.1, assumption: "Per minute of conversation.", available: true },
  { id: "standard", name: "Standard", model: "whisper", approxCentsPerMinute: 0.05, assumption: "Per minute of speech transcribed.", available: true },
];
const base: AccountView = { signedIn: true, signInConfigured: true, apiBase: "https://api.test", dashboardUrl: "https://api.test/", billingUrl: "https://api.test/billing", filesUrl: "https://api.test/files" };
const PLUS: AccountView = { ...base, plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } };
const FREE: AccountView = { ...base, plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false } };

describe("voiceView: the voice engine choice in Settings", () => {
  it("offers OpenAI Realtime (recommended), Realtime mini, Deepgram and the browser voice, each with its cost a minute from the server", () => {
    const v = voiceView({ engines, selected: "realtime", account: PLUS });
    expect(v.options.map((o) => [o.id, o.label])).toEqual([
      ["realtime", "OpenAI Realtime (recommended)"],
      ["realtime-mini", "OpenAI Realtime mini"],
      ["deepgram", "Deepgram"],
      ["standard", "Browser voice"],
    ]);
    const cost = (id: string) => v.options.find((o) => o.id === id)!;
    expect(cost("realtime").cost).toBe("about 5.3¢ of usage credit a minute");
    expect(cost("realtime-mini").cost).toBe("about 2.3¢ of usage credit a minute");
    expect(cost("deepgram").cost).toBe("about 1.1¢ of usage credit a minute");
    expect(cost("standard").cost).toBe("about 0.05¢ of usage credit a minute");
    expect(cost("realtime").title).toBe("Per minute of conversation: you talk for 1 minute and it speaks for 18 seconds. Model: gpt-realtime-2.1.");
    expect(cost("deepgram").detail).toBe("Deepgram hears you (Nova-3) and reads short summaries aloud in a natural voice (Aura).");
    expect(cost("standard").detail).toBe("Deepgram hears you (Nova-3); short summaries are read aloud by your browser's own voice, at no charge.");
    expect(cost("standard").title).toMatch(/Model: whisper\.$/);
    expect(v.note).toBeNull();
  });

  it("an older server that lists only Realtime and Standard: the new engines say they are not available yet", () => {
    const v = voiceView({ engines: engines.filter((e) => e.id === "realtime" || e.id === "standard"), selected: "realtime", account: PLUS });
    expect(v.options.map((o) => o.cost)).toEqual(["about 5.3¢ of usage credit a minute", "Not available on the server yet.", "Not available on the server yet.", "about 0.05¢ of usage credit a minute"]);
  });

  it("while the prices load, and when they cannot be loaded, says so instead of guessing", () => {
    expect(voiceView({ engines: "loading", selected: "realtime", account: PLUS }).options[0]!.cost).toBe("Loading the price…");
    expect(voiceView({ engines: null, selected: "realtime", account: PLUS }).options[1]!.cost).toBe("The price couldn't be loaded right now.");
  });

  it("an engine the server cannot run says so", () => {
    const v = voiceView({ engines: [{ ...engines[0]!, available: false }, ...engines.slice(1)], selected: "realtime", account: PLUS });
    expect(v.options[0]!.cost).toBe("Not available on this server right now.");
  });

  it("without a plan that includes voice, says which plans do", () => {
    expect(voiceView({ engines, selected: "realtime", account: FREE }).note).toBe("Voice needs the Plus or Pro plan");
    expect(voiceView({ engines, selected: "realtime", account: { ...base, signedIn: false } }).note).toBe("Voice needs the Plus or Pro plan");
  });
});

describe("voicePicker: the voice and speed follow the engine selected", () => {
  const browserVoices = [{ name: "Google US English", lang: "en-US" }];
  const settings = { ...DEFAULT_SETTINGS };

  it("Realtime: OpenAI's voices (recommended first), its own speed range, and what a test costs", () => {
    const p = voicePicker({ settings: { ...settings, voiceEngine: "realtime", realtimeVoice: "cedar", realtimeSpeed: 1.2 }, browserVoices, engines });
    expect(p.title).toBe("Realtime voice");
    expect(p.options.map((o) => o.label)).toEqual(["Marin (recommended)", "Cedar (recommended)", "Alloy", "Ash", "Ballad", "Coral", "Echo", "Sage", "Shimmer", "Verse"]);
    expect(p.options.map((o) => o.value)).toContain("verse");
    expect(p.value).toBe("cedar");
    expect(p.speed).toMatchObject({ min: 0.25, max: 1.5, step: 0.05, value: 1.2, hint: "0.25× to 1.5×; 1.0× is normal." });
    expect(p.testHint).toBe("Says a sample line with this voice and speed (uses about 1¢ of usage credit).");
    // Prices not known: no cost claimed.
    expect(voicePicker({ settings: { ...settings, voiceEngine: "realtime" }, browserVoices, engines: null }).testHint).toBe("Says a sample line with this voice and speed.");
  });

  it("Standard: the browser's voices (a voice from another computer kept), the browser's speed range", () => {
    const p = voicePicker({ settings: { ...settings, voiceEngine: "standard", speechVoice: "Samantha", speechRate: 1.4 }, browserVoices, engines });
    expect(p.title).toBe("Browser voice");
    expect(p.options).toEqual([
      { value: "", label: "Browser default" },
      { value: "Google US English", label: "Google US English (en-US)" },
      { value: "Samantha", label: "Samantha (not on this computer)" },
    ]);
    expect(p.speed).toMatchObject({ min: 0.5, max: 2, step: 0.1, value: 1.4, hint: "0.5× to 2.0×; 1.0× is normal." });
    expect(p.testHint).toBe("Says a sample line with this voice and speed, on this computer.");
  });

  it("a change saves to the selected engine's own settings, kept in its range", () => {
    expect(voicePatch("realtime", { voice: "cedar" })).toEqual({ realtimeVoice: "cedar" });
    expect(voicePatch("realtime", { voice: "nova" })).toEqual({});
    expect(voicePatch("realtime", { speed: 1.9 })).toEqual({ realtimeSpeed: 1.5 });
    expect(voicePatch("realtime", { speed: 0.78 })).toEqual({ realtimeSpeed: 0.8 });
    expect(voicePatch("standard", { voice: "Google US English" })).toEqual({ speechVoice: "Google US English" });
    expect(voicePatch("standard", { speed: 1.44 })).toEqual({ speechRate: 1.4 });
    expect(voicePatch("standard", { speed: 0.1 })).toEqual({ speechRate: 0.5 });
  });

  it("speeds read as multiples", () => {
    expect([0.25, 1, 1.2, 1.5, 2].map(speedText)).toEqual(["0.25×", "1.0×", "1.2×", "1.5×", "2.0×"]);
  });

  it("a Realtime test that cannot run says why in a few words", () => {
    expect(sampleFailureText({ kind: "unavailable", transient: false, message: "Realtime voice is unavailable on the server right now." })).toBe("Realtime voice is unavailable on the server right now.");
    expect(sampleFailureText({ kind: "network", transient: true, message: "Voice disconnected." })).toBe("Realtime voice could not connect. Try again.");
    expect(sampleFailureText({ kind: "busy", transient: true })).toBe("Realtime voice is on in another window. Try again once it ends.");
    expect(sampleFailureText({ kind: "credit", transient: false, message: "Out of usage credit: top up to keep using voice." })).toBe("Out of usage credit: top up to keep using voice.");
  });
});

describe("the Deepgram voice and the notification choices", () => {
  it("Deepgram lists Aura's voices (its picks marked) with its own speed, and saves them", () => {
    const p = voicePicker({ settings: { ...DEFAULT_SETTINGS, voiceEngine: "deepgram", deepgramSpeed: 1.2 }, browserVoices: [], engines });
    expect(p.title).toBe("Deepgram voice");
    expect(p.options[0]).toEqual({ value: "thalia", label: "Thalia (recommended)" });
    expect(p.options).toHaveLength(40);
    expect(p.value).toBe("thalia");
    expect(p.speed.value).toBe(1.2);
    expect(voicePatch("deepgram", { voice: "zeus" })).toEqual({ deepgramVoice: "zeus" });
    expect(voicePatch("deepgram", { voice: "ash" })).toEqual({});
    expect(voicePatch("deepgram", { speed: 1.5 })).toEqual({ deepgramSpeed: 1.5 });
    // Realtime mini shares Realtime's voice and speed.
    expect(voicePatch("realtime-mini", { voice: "marin" })).toEqual({ realtimeVoice: "marin" });
    expect(voicePicker({ settings: { ...DEFAULT_SETTINGS, voiceEngine: "realtime-mini" }, browserVoices: [], engines }).title).toBe("Realtime voice");
  });

  it("notifications: the hands-free voice, each engine with its voice, a chime or nothing; engines the server lacks are disabled", () => {
    const opts = notificationOptions({ settings: { ...DEFAULT_SETTINGS, voiceEngine: "deepgram" }, engines: engines.filter((e) => e.id !== "realtime-mini") });
    expect(opts).toEqual([
      { value: "same", label: "Same as hands-free voice (Deepgram)", disabled: false },
      { value: "realtime", label: "OpenAI Realtime (Ash)", disabled: false },
      { value: "realtime-mini", label: "OpenAI Realtime mini (Ash)", disabled: true },
      { value: "deepgram", label: "Deepgram (Thalia)", disabled: false },
      { value: "standard", label: "Browser voice (browser default)", disabled: false },
      { value: "chime", label: "Chime only", disabled: false },
      { value: "off", label: "Off (silent)", disabled: false },
    ]);
  });

  it("notification voice: the voices of the engine notifications use, the one above first; none for a chime or silence", () => {
    const browserVoices = [{ name: "Samantha", lang: "en-US" }];
    const same = notificationVoicePicker({ settings: { ...DEFAULT_SETTINGS, voiceEngine: "deepgram", deepgramVoice: "apollo" }, browserVoices })!;
    expect(same.title).toBe("Deepgram voice");
    expect(same.options[0]).toEqual({ value: "", label: "Same as hands-free voice (Apollo)" });
    expect(same.options).toHaveLength(41);
    expect(same.value).toBe("");

    const other = notificationVoicePicker({ settings: { ...DEFAULT_SETTINGS, voiceEngine: "deepgram", notificationVoice: "realtime", notificationSpeaker: "cedar" }, browserVoices })!;
    expect(other.title).toBe("Realtime voice");
    expect(other.options.slice(0, 3).map((o) => o.label)).toEqual(["Default (Ash)", "Marin (recommended)", "Cedar (recommended)"]);
    expect(other.value).toBe("cedar");

    // A voice of another engine (picked before the engine changed) shows as the default.
    expect(notificationVoicePicker({ settings: { ...DEFAULT_SETTINGS, voiceEngine: "realtime", notificationSpeaker: "apollo" }, browserVoices })!.value).toBe("");

    const browser = notificationVoicePicker({ settings: { ...DEFAULT_SETTINGS, notificationVoice: "standard", notificationSpeaker: "Daniel" }, browserVoices })!;
    expect(browser.options).toEqual([
      { value: "", label: "Default (browser default)" },
      { value: "Samantha", label: "Samantha (en-US)" },
      { value: "Daniel", label: "Daniel (not on this computer)" },
    ]);
    expect(browser.value).toBe("Daniel");

    expect(notificationVoicePicker({ settings: { ...DEFAULT_SETTINGS, notificationVoice: "chime" }, browserVoices })).toBeNull();
    expect(notificationVoicePicker({ settings: { ...DEFAULT_SETTINGS, notificationVoice: "off" }, browserVoices })).toBeNull();
  });
});
