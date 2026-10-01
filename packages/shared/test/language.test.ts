import { describe, expect, it } from "vitest";
import { chosenLanguage, LANGUAGES, languagePromptLine, LanguageSetting, parseSettings } from "../src/index.js";

describe("the language setting", () => {
  it("is Auto by default and for anything it does not know", () => {
    expect(parseSettings({}).language).toBe("auto");
    expect(parseSettings({ language: "xx" }).language).toBe("auto");
    expect(parseSettings({ language: "ko" }).language).toBe("ko");
  });

  it("offers English, Spanish, French, Portuguese, Korean, Japanese, Chinese and three more", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", "es", "fr", "pt", "ko", "ja", "zh", "de", "hi", "ar"]);
    expect(LanguageSetting.options).toEqual(["auto", ...LANGUAGES.map((l) => l.code)]);
  });

  it("tells the agent the language only when one was picked", () => {
    expect(chosenLanguage("auto")).toBeNull();
    expect(languagePromptLine("auto")).toBeNull();
    expect(chosenLanguage("zh")).toMatchObject({ name: "Chinese", tag: "zh-CN" });
    expect(languagePromptLine("ja")).toMatch(/^The user's language is Japanese: write everything you say to them in Japanese/);
  });
});
