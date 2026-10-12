import { describe, expect, it } from "vitest";
import { MAX_VOICE_LANGUAGES, transcriptFit, voiceLanguages } from "../../src/voice/voice-language.js";

describe("voiceLanguages: the browser's preferred languages as the transcription's hint", () => {
  it("ISO 639-1 codes, first ones first, without repeats, at most a few; English without any", () => {
    expect(voiceLanguages(["en-US", "en", "ko-KR", "ko"])).toEqual(["en", "ko"]);
    expect(voiceLanguages(["zh-TW", "fr", "de", "ja"])).toHaveLength(MAX_VOICE_LANGUAGES);
    expect(voiceLanguages(["x-klingon", ""])).toEqual(["en"]);
    expect(voiceLanguages([])).toEqual(["en"]);
  });
});

describe("transcriptFit: whether a transcript reads as the user talking in their language", () => {
  const en = ["en"];

  it("the owner's report: 'Yo sup how you doin' transcribed as Chinese punctuation is unclear, not a request", () => {
    expect(transcriptFit("有，......。", en)).toBe("unclear");
    expect(transcriptFit("......", en)).toBe("unclear");
    expect(transcriptFit("Yo sup how you doin", en)).toBe("clear");
  });

  it("other people talking nearby in another language (the owner's trace): not addressed to the assistant", () => {
    for (const heard of ["你不是手上进不来，上面都是锁了。那那个钥匙呢？", "请你做饭了。", "这挺好。", "我这胖，我的刚刚刚。"]) {
      expect(transcriptFit(heard, en), heard).toBe("other_language");
    }
  });

  it("a language the user has set is theirs: Chinese for a Chinese speaker, Korean with Hangul and Hanja", () => {
    expect(transcriptFit("请你做饭了。", ["en", "zh"])).toBe("clear");
    expect(transcriptFit("안녕하세요, 메일 좀 확인해 줘", ["en", "ko"])).toBe("clear");
    expect(transcriptFit("안녕하세요", en)).toBe("other_language");
  });

  it("mixed words count by the share of letters; a language the table does not know is never judged", () => {
    expect(transcriptFit("Open Gmail 그리고", en)).toBe("clear");
    expect(transcriptFit("请你做饭了。", ["en", "sw"])).toBe("clear");
    expect(transcriptFit("请你做饭了。", [])).toBe("clear");
  });
});
