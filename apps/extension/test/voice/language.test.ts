import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ExtensionSettings, type LanguageSetting, type NotificationVoice, type VoiceEngineId } from "@noa/shared";
import { approvalsLine } from "../../src/engine/run/turn.js";
import { notifier } from "../../src/notify.js";
import { languageHint, languageOptions } from "../../src/options/voice-view.js";
import { explicitYes, spokenApprovalAnswer } from "../../src/voice/approval-voice.js";
import { isCancelPhrase, isStopPhrase } from "../../src/voice/hands-free.js";
import type { NoticeSound } from "../../src/voice/notice-voice.js";
import { ackResponse, lineResponse, narratorInstructions, NARRATOR_INSTRUCTIONS, progressResponse, workingSmallTalkResponse } from "../../src/voice/realtime-client.js";
import { pickVoice, Speaker } from "../../src/voice/speaker.js";
import { panelTranscriber, transcribeForPanel } from "../../src/voice/transcribe.js";
import { voiceLanguages } from "../../src/voice/voice-language.js";

describe("the language picked in Settings, in voice", () => {
  it("is the transcription's first hint, the browser's languages after it", () => {
    expect(voiceLanguages(["en-US", "ko"], "ja")).toEqual(["ja", "en", "ko"]);
    expect(voiceLanguages(["ko-KR", "en"], "ko")).toEqual(["ko", "en"]);
    expect(voiceLanguages(["en-US"], null)).toEqual(["en"]);
  });

  it("goes with each Standard / Deepgram clip to the server, and only a known code passes", async () => {
    const send = vi.fn(async () => ({ text: "hola" }));
    const clip = panelTranscriber(send, () => undefined, () => "es");
    await clip(new Uint8Array([1]), { speechMs: 500, signal: new AbortController().signal });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ language: "es" }));
    const account = { transcribe: vi.fn(async () => ({ text: "hola" })) };
    await transcribeForPanel(account, { wav: "AQ==", speechMs: 500, language: "es" });
    expect(account.transcribe).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ language: "es" }));
  });

  it("the browser voice speaks it: the voice picked if it does, else one that does, else the language alone", () => {
    const voices = [
      { name: "Samantha", lang: "en-US", default: true },
      { name: "Google 한국의", lang: "ko-KR", default: false },
      { name: "Monica", lang: "es-ES", default: false },
      { name: "Paulina", lang: "es-MX", default: false },
    ];
    expect(pickVoice(voices, "Samantha")?.name).toBe("Samantha");
    expect(pickVoice(voices, "Samantha", "ko-KR")?.name).toBe("Google 한국의");
    expect(pickVoice(voices, "Paulina", "es-ES")?.name).toBe("Paulina");
    expect(pickVoice(voices, "", "es-ES")?.name).toBe("Monica");
    expect(pickVoice(voices, "Samantha", "hi-IN")).toBeUndefined();

    const spoken: { voice: unknown; lang: string }[] = [];
    const synth = { speak: (u: { voice: unknown; lang: string }) => void spoken.push(u), cancel: () => {}, getVoices: () => voices };
    const make = () => ({ rate: 1, voice: null, lang: "", onend: null, onerror: null, onstart: null }) as unknown as SpeechSynthesisUtterance;
    void new Speaker(() => ({ voice: "Samantha", rate: 1, lang: "hi-IN" }), synth as never, make).speak("नमस्ते");
    expect(spoken[0]).toMatchObject({ voice: null, lang: "hi-IN" });
  });

  it("the Realtime narrator always speaks it, and says every line in it", () => {
    expect(narratorInstructions(null)).toBe(NARRATOR_INSTRUCTIONS);
    expect(narratorInstructions("Korean")).toContain("Always speak Korean");
    expect(narratorInstructions("Korean")).not.toContain("Speak the user's language.");
    for (const r of [lineResponse("Done.", "hello", "Korean"), progressResponse("Opening x.com", null, "Korean"), ackResponse("post it", false, "Korean")]) {
      expect(r.instructions).toContain("Say it in Korean");
      expect(r.instructions).not.toContain("sample");
    }
    expect(workingSmallTalkResponse("Korean").instructions).toContain("in Korean");
    // Auto: the language of the user's words, as before.
    expect(lineResponse("Done.", "안녕하세요").instructions).toContain("«안녕하세요»");
  });

  it("stop, cancel, yes and no are heard in it", () => {
    for (const s of ["그만", "Para.", "停止", "रुको", "توقف", "ストップ"]) expect(isStopPhrase(s), s).toBe(true);
    for (const s of ["취소", "Cancela", "算了", "रद्द करो", "Annule !"]) expect(isCancelPhrase(s), s).toBe(true);
    expect(isStopPhrase("para el correo")).toBe(false);
    for (const s of ["네", "Sí.", "oui", "はい", "好的", "हाँ", "نعم"]) expect(spokenApprovalAnswer(s), s).toBe("allow_once");
    for (const s of ["아니요", "Não", "nein", "いいえ", "不要", "नहीं", "لا"]) expect(spokenApprovalAnswer(s), s).toBe("deny");
    expect(explicitYes("हाँ, कर दो")).toBe(true);
    expect(explicitYes("नहीं, रुको")).toBe(false);
  });
});

describe("the language picked in Settings, in notifications", () => {
  const setup = (opts: { language?: LanguageSetting; notes?: NotificationVoice; engine?: VoiceEngineId; voice?: string } = {}) => {
    const created = vi.fn(async () => "n1");
    const speak = vi.fn(async () => {});
    const play = vi.fn(async (_s: NoticeSound) => {});
    const notify = notifier({
      settings: async () => ({ ...DEFAULT_SETTINGS, notificationVoice: opts.notes ?? "same", voiceEngine: opts.engine ?? "standard", speechVoice: opts.voice ?? "", language: opts.language ?? "auto" }),
      voiceOn: () => false,
      play,
      notifications: { create: created as never },
      tts: { speak: speak as never, getVoices: (async () => [{ voiceName: "Samantha", lang: "en-US" }]) as never },
      iconUrl: () => "icon.png",
    });
    return { notify, created, speak, play };
  };

  it("shows and says it in that language, with Chrome's voice for it", async () => {
    const { notify, created, speak } = setup({ language: "es", voice: "Samantha" });
    await notify("Started: Post a tip on X", "Working on it in the background.", "Noa started working on: Post a tip on X");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ title: "Noa: Comenzó: Publicar un consejo en X", message: "Trabajando en ello en segundo plano." }));
    expect(speak).toHaveBeenCalledWith("Noa empezó a trabajar en: Publicar un consejo en X", { enqueue: true, rate: 1, lang: "es-ES" });
  });

  it("a notification with no spoken line is said from its translated title and message", async () => {
    const { notify, speak } = setup({ language: "ja" });
    await notify("Task paused", "The task needs your attention.");
    expect(speak).toHaveBeenCalledWith("Noa: タスクを一時停止しました。 タスクの確認が必要です。", expect.objectContaining({ lang: "ja-JP" }));
  });

  it("leaves Deepgram's English voices for Chrome's speech in another language; Realtime says it as given", async () => {
    const dg = setup({ language: "ko", engine: "deepgram" });
    await dg.notify("Task paused", "x");
    expect(dg.play).not.toHaveBeenCalled();
    expect(dg.speak).toHaveBeenCalledWith(expect.stringContaining("작업이 일시 중지됐어요"), expect.objectContaining({ lang: "ko-KR" }));
    const en = setup({ language: "en", engine: "deepgram" });
    await en.notify("Task paused", "x");
    expect(en.play).toHaveBeenCalledWith(expect.objectContaining({ kind: "deepgram" }));
    const rt = setup({ language: "fr", engine: "realtime" });
    await rt.notify("Task paused", "x");
    expect(rt.play).toHaveBeenCalledWith(expect.objectContaining({ kind: "realtime", line: "Noa: Tâche en pause. x" }));
  });

  it("Auto changes nothing", async () => {
    const { notify, created, speak } = setup();
    await notify("Task paused", "Needs you.");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ title: "Noa: Task paused" }));
    expect(speak).toHaveBeenCalledWith("Noa: Task paused. Needs you.", { enqueue: true, rate: 1 });
  });
});

describe("the language picked in Settings, for the agent and in Settings", () => {
  const settings = (language: LanguageSetting): ExtensionSettings => ({ ...DEFAULT_SETTINGS, language });

  it("the agent is told it each turn, with the approvals line", () => {
    const run = { scheduled: false, agentAuthored: false };
    expect(approvalsLine(settings("auto"), run)).not.toMatch(/language/);
    const line = approvalsLine(settings("pt"), run);
    expect(line).toContain("The user's language is Portuguese");
    expect(line).toMatch(/^Approvals/);
  });

  it("lists Auto and ten languages, and says what the engine cannot do in it", () => {
    const options = languageOptions();
    expect(options).toHaveLength(11);
    expect(options[0]!.value).toBe("auto");
    expect(options.find((o) => o.value === "ko")!.label).toBe("한국어 (Korean)");
    expect(languageHint({ language: "ko", voiceEngine: "deepgram" })).toContain("English only");
    expect(languageHint({ language: "en", voiceEngine: "deepgram" })).not.toContain("English only");
    expect(languageHint({ language: "auto", voiceEngine: "realtime" })).toContain("language you speak");
  });
});
