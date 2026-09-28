import { describe, expect, it, vi } from "vitest";
import { Speaker } from "../../src/voice/speaker.js";

class FakeUtterance {
  rate = 1;
  voice: unknown = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function setup(settings = { voice: "Samantha", rate: 1.3 }) {
  const spoken: FakeUtterance[] = [];
  const synth = {
    speak: vi.fn((u: FakeUtterance) => void spoken.push(u)),
    cancel: vi.fn(),
    getVoices: () => [{ name: "Samantha", lang: "en-US" }, { name: "Yuna", lang: "ko-KR" }] as SpeechSynthesisVoice[],
  };
  const speaker = new Speaker(() => settings, synth as unknown as SpeechSynthesis, (t) => new FakeUtterance(t) as unknown as SpeechSynthesisUtterance);
  return { speaker, synth, spoken };
}

describe("Speaker", () => {
  it("says a line with the voice and speed from Settings, and resolves when it ends", async () => {
    const { speaker, spoken } = setup();
    const done = speaker.speak("Opening gmail.com");
    expect(spoken[0]).toMatchObject({ text: "Opening gmail.com", rate: 1.3, lang: "en-US" });
    expect(speaker.speaking).toBe(true);
    spoken[0]!.onend!();
    await done;
    expect(speaker.speaking).toBe(false);
  });

  it("an unknown voice keeps the browser's default", () => {
    const { speaker, spoken } = setup({ voice: "Gone", rate: 1 });
    void speaker.speak("x");
    expect(spoken[0]!.voice).toBeNull();
  });

  it("cancel cuts the line off and resolves it (barge-in)", async () => {
    const { speaker, synth } = setup();
    const done = speaker.speak("A long summary");
    speaker.cancel();
    await done;
    expect(synth.cancel).toHaveBeenCalled();
    expect(speaker.speaking).toBe(false);
  });
});
