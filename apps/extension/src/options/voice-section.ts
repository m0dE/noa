/**
 * Settings > AI > Voice: which engine hands-free voice uses (OpenAI Realtime,
 * Realtime mini, Deepgram or the browser voice, each with its cost a minute
 * from the account server), and the selected engine's voice and speed with a
 * Test button: Realtime's are OpenAI's voices (a short relay session says the
 * sample), Deepgram's are Aura's (the account server says it), the browser
 * voice is the browser's. Sounds: the soft sound when the microphone turns on
 * and off. Notifications: how Noa's notifications are heard (notify.ts), and
 * in which of that engine's voices, just for them.
 * Saves by itself, like the rest of the page; voice-view.ts decides what
 * shows.
 */
import { chosenLanguage, DEFAULT_REALTIME_VOICE, errorMessage, isRealtimeEngine, LanguageSetting, NotificationVoice, type ExtensionSettings, type VoiceEngine, type VoiceEngineId } from "@noa/shared";
import { VOICE_COMMAND, readShortcut } from "../shortcut.js";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, find, flash, h } from "../ui/dom.js";
import { sayRealtimeSample } from "../voice/realtime-sample.js";
import { Speaker, speechVoices } from "../voice/speaker.js";
import { VoiceError } from "../voice/transcribe.js";
import { DeepgramSpeaker } from "../voice/deepgram-speaker.js";
import { localizeLine } from "../voice/phrases.js";
import { languageHint, languageOptions, notificationOptions, notificationVoicePicker, sampleFailureText, speedText, voicePatch, voicePicker, voiceView } from "./voice-view.js";

/** What Test voice says. */
export const SPEECH_SAMPLE = "Opening Gmail. You have two new emails; Jordan needs a reply by Friday.";

export interface VoiceSection {
  render(state: UiState): void;
}

export function initVoiceSection(opts: { onState(state: UiState): void }): VoiceSection {
  const voiceSelect = $<HTMLSelectElement>("speech-voice");
  const rate = $<HTMLInputElement>("speech-rate");
  const rateValue = $("speech-rate-value");
  const testBtn = $<HTMLButtonElement>("speech-test");
  const testMsg = $("speech-test-msg");
  const sounds = $<HTMLInputElement>("voice-sounds");
  const noteVoice = $<HTMLSelectElement>("notification-voice");
  const noteSpeakerRow = $("notification-speaker-row");
  const noteSpeaker = $<HTMLSelectElement>("notification-speaker");
  const noteTest = $<HTMLButtonElement>("notification-test");
  const noteMsg = $("notification-test-msg");
  const languageSelect = $<HTMLSelectElement>("voice-language");
  languageSelect.replaceChildren(...languageOptions().map((o) => h("option", { value: o.value }, o.label)));
  let state: UiState | null = null;
  let engines: VoiceEngine[] | null | "loading" = "loading";
  /** What the voice select was last filled with (refilled only when that changes). */
  let filled = "";
  /** What the notifications select was last filled with. */
  let notesFilled = "";
  /** What the notification voice select was last filled with. */
  let speakerFilled = "";

  const settings = (): ExtensionSettings | null => state?.settings ?? null;

  async function save(patch: Partial<ExtensionSettings>): Promise<void> {
    if (!Object.keys(patch).length) return;
    try {
      opts.onState(await uiRequest({ type: "settings.save", settings: patch }));
    } catch (err) {
      flash(testMsg, `Not saved: ${errorMessage(err)}`, "bad");
    }
  }

  function drawPicker(s: ExtensionSettings): void {
    const p = voicePicker({ settings: s, browserVoices: speechVoices(), engines });
    $("speech-voice-title").textContent = p.title;
    $("speech-voice-hint").textContent = p.hint;
    $("speech-rate-hint").textContent = p.speed.hint;
    $("speech-test-hint").textContent = p.testHint;
    const key = JSON.stringify(p.options);
    if (key !== filled) {
      filled = key;
      voiceSelect.replaceChildren(...p.options.map((o) => h("option", { value: o.value }, o.label)));
    }
    voiceSelect.value = p.value;
    if (document.activeElement !== rate) {
      rate.min = String(p.speed.min);
      rate.max = String(p.speed.max);
      rate.step = String(p.speed.step);
      rate.value = String(p.speed.value);
    }
    rateValue.textContent = speedText(Number(rate.value));
  }

  function draw(): void {
    const s = settings();
    if (!s) return;
    const v = voiceView({ engines, selected: s.voiceEngine, account: state?.account });
    for (const o of v.options) {
      const row = find(document, `.opt[data-voice="${o.id}"]`);
      find<HTMLInputElement>(row, "input[type=radio]").checked = o.id === v.selected;
      find(row, ".voice-name").textContent = o.label;
      find(row, ".voice-detail").textContent = o.detail;
      const cost = find(row, ".voice-cost");
      cost.textContent = o.cost;
      cost.title = o.title;
    }
    const note = $("voice-note");
    note.hidden = !v.note;
    note.textContent = v.note ?? "";
    sounds.checked = s.voiceSounds;
    const notes = notificationOptions({ settings: s, engines });
    const notesKey = JSON.stringify(notes);
    if (notesKey !== notesFilled) {
      notesFilled = notesKey;
      noteVoice.replaceChildren(...notes.map((o) => h("option", { value: o.value, disabled: o.disabled }, o.label)));
    }
    noteVoice.value = s.notificationVoice;
    languageSelect.value = s.language;
    $("voice-language-hint").textContent = languageHint(s);
    const sp = notificationVoicePicker({ settings: s, browserVoices: speechVoices() });
    noteSpeakerRow.hidden = !sp;
    if (sp) {
      $("notification-speaker-hint").textContent = `${sp.title}s, just for notifications; hands-free voice keeps its own.`;
      const speakerKey = JSON.stringify(sp.options);
      if (speakerKey !== speakerFilled) {
        speakerFilled = speakerKey;
        noteSpeaker.replaceChildren(...sp.options.map((o) => h("option", { value: o.value }, o.label)));
      }
      noteSpeaker.value = sp.value;
    }
    drawPicker(s);
  }

  const engine = (): VoiceEngineId => settings()?.voiceEngine ?? "realtime";

  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=voiceEngine]")) {
    r.addEventListener("change", () => void save({ voiceEngine: r.value as VoiceEngineId }));
  }
  voiceSelect.addEventListener("change", () => void save(voicePatch(engine(), { voice: voiceSelect.value })));
  rate.addEventListener("input", () => (rateValue.textContent = speedText(Number(rate.value))));
  rate.addEventListener("change", () => void save(voicePatch(engine(), { speed: Number(rate.value) })));
  sounds.addEventListener("change", () => void save({ voiceSounds: sounds.checked }));
  languageSelect.addEventListener("change", () => {
    const v = LanguageSetting.safeParse(languageSelect.value);
    if (v.success) void save({ language: v.data });
  });
  /** The language picked (null: Auto) and Test voice's sample in it. */
  const language = () => chosenLanguage(settings()?.language);
  const sample = () => localizeLine(SPEECH_SAMPLE, language()?.code);
  noteVoice.addEventListener("change", () => {
    const v = NotificationVoice.safeParse(noteVoice.value);
    if (v.success) void save({ notificationVoice: v.data });
  });
  noteSpeaker.addEventListener("change", () => void save({ notificationSpeaker: noteSpeaker.value }));
  noteTest.addEventListener("click", () => {
    noteTest.disabled = true;
    flash(noteMsg, settings()?.notificationVoice === "off" ? "Notifications are silent." : "Playing…");
    void uiRequest({ type: "notify.test" })
      .then(
        () => flash(noteMsg, ""),
        (err: unknown) => flash(noteMsg, errorMessage(err), "bad"),
      )
      .finally(() => (noteTest.disabled = false));
  });

  const speaker = new Speaker(() => {
    const lang = language();
    return { voice: voiceSelect.value, rate: Number(rate.value) || 1, ...(lang ? { lang: lang.tag } : {}) };
  });
  async function testRealtime(): Promise<void> {
    const s = settings();
    const mini = engine() === "realtime-mini";
    await sayRealtimeSample({
      ticket: async () => {
        const r = await uiRequest({ type: "voice.realtime", ...(mini ? { tier: "mini" as const } : {}) });
        if ("error" in r) throw new VoiceError(r.error);
        return r;
      },
      voice: s?.realtimeVoice ?? DEFAULT_REALTIME_VOICE,
      speed: Number(rate.value) || 1,
      text: sample(),
      ...(language() ? { language: language()!.name } : {}),
    });
  }
  async function testDeepgram(): Promise<void> {
    let failed: VoiceError | null = null;
    let started = false;
    await new DeepgramSpeaker({
      settings: () => ({ voice: settings()?.deepgramVoice ?? "thalia", speed: Number(rate.value) || 1 }),
      fetch: (text, voice) => uiRequest({ type: "voice.speak", text, voice }),
      onError: (err) => (failed = err),
    }).speak(SPEECH_SAMPLE, { onStart: () => (started = true) });
    if (failed) throw failed;
    if (!started) throw new Error("The Deepgram voice could not play.");
  }
  testBtn.addEventListener("click", () => {
    if (engine() === "deepgram") {
      flash(testMsg, "Loading…");
      testBtn.disabled = true;
      void testDeepgram()
        .then(
          () => flash(testMsg, ""),
          (err: unknown) => flash(testMsg, errorMessage(err), "bad"),
        )
        .finally(() => (testBtn.disabled = false));
      return;
    }
    if (isRealtimeEngine(engine())) {
      flash(testMsg, "Connecting…");
      testBtn.disabled = true;
      void testRealtime()
        .then(
          () => flash(testMsg, ""),
          (err: unknown) => flash(testMsg, sampleFailureText(err), "bad"),
        )
        .finally(() => (testBtn.disabled = false));
      return;
    }
    if (typeof speechSynthesis === "undefined") return flash(testMsg, "This browser has no built-in speech.", "bad");
    flash(testMsg, "Speaking…");
    void speaker.speak(sample()).then(() => flash(testMsg, ""));
  });
  // Chrome loads its voices a moment after the page.
  globalThis.speechSynthesis?.addEventListener?.("voiceschanged", draw);

  void uiRequest({ type: "voice.engines" }).then(
    (r) => {
      engines = "error" in r ? null : r.engines;
      draw();
    },
    () => {
      engines = null;
      draw();
    },
  );
  void readShortcut(VOICE_COMMAND).then((key) => {
    if (key) $("voice-group-key").textContent = key;
  });

  return {
    render(next) {
      state = next;
      draw();
    },
  };
}
