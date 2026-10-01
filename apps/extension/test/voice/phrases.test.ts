import { describe, expect, it } from "vitest";
import { LANGUAGES, type LanguageCode } from "@noa/shared";
import { approvalLine } from "../../src/voice/approval-voice.js";
import { useThisTabLine } from "../../src/voice/hands-free-tab.js";
import { milestoneOf } from "../../src/voice/milestones.js";
import { localizeLine } from "../../src/voice/phrases.js";

/** options/voice-section.ts SPEECH_SAMPLE (that module needs the options page). */
const SPEECH_SAMPLE = "Opening Gmail. You have two new emails; Jordan needs a reply by Friday.";
const call = (name: string, args: unknown = {}) => ({ type: "tool_call" as const, id: "1", name, args });
const OTHERS = LANGUAGES.map((l) => l.code).filter((c): c is Exclude<LanguageCode, "en"> => c !== "en");

/** Every kind of progress line milestones.ts makes. */
const MILESTONES = [
  call("navigate", { url: "https://x.com/home" }),
  call("navigate", { url: "about:blank" }),
  call("open_tabs", { urls: ["https://a.com"] }),
  call("open_tabs", { urls: ["https://a.com", "https://b.com", "https://c.com"] }),
  call("open_tabs", { urls: [] }),
  call("read_page"),
  call("read_page", { tabs: [1, 2] }),
  call("screenshot"),
  call("act", { steps: [{ text: "a" }, { text: "b" }] }),
  call("act", { steps: [{ text: "a" }] }),
  call("act", { steps: [{ click: "x" }] }),
  call("scroll"),
  call("upload"),
  call("switch_tab"),
  call("switch_x_account", { handle: "@noa" }),
  call("switch_x_account"),
  call("get_credential", { site: "github.com" }),
  call("get_credential"),
].map((ev) => milestoneOf(ev)!);

describe("localizeLine: Noa's own lines in the language picked", () => {
  it("leaves every line as it is for Auto and English", () => {
    expect(localizeLine("Opening x.com", null)).toBe("Opening x.com");
    expect(localizeLine("Opening x.com", "en")).toBe("Opening x.com");
  });

  it("translates every progress line, and its Still line, in every language", () => {
    expect(MILESTONES.every(Boolean)).toBe(true);
    for (const lang of OTHERS) {
      for (const line of [...MILESTONES, "Still working on it"]) {
        expect(localizeLine(line, lang), `${lang}: ${line}`).not.toBe(line);
      }
      // ProgressPacer.stillWorking: "Still " and the step, its first letter lowercased.
      for (const line of MILESTONES) {
        const still = `Still ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
        expect(localizeLine(still, lang), `${lang}: ${still}`).not.toBe(still);
      }
    }
  });

  it("keeps the site, count and handle as they are", () => {
    expect(localizeLine("Opening x.com", "es")).toBe("Abriendo x.com");
    expect(localizeLine("Still opening x.com", "es")).toBe("Sigo abriendo x.com");
    expect(localizeLine("Opening 3 tabs", "ko")).toBe("탭 3개를 여는 중이에요");
    expect(localizeLine("Still reading the page", "ko")).toBe("아직 페이지를 읽는 중이에요");
    expect(localizeLine("Switching to @noa", "ja")).toBe("@noa に切り替えています");
    expect(localizeLine("Still filling in the form", "zh")).toBe("仍在填写表单");
    expect(localizeLine("Signing in to github.com", "fr")).toBe("Je me connecte à github.com");
  });

  it("translates the approval question around the action, and Standard's use-this-tab answers", () => {
    const line = approvalLine({ action: 'Click "Post"', site: "x.com", why: "publishes" });
    expect(localizeLine(line, "pt")).toBe('Preciso da sua permissão: Click "Post" on x.com; it publishes. Diga sim para permitir, ou não.');
    for (const outcome of ["unknown", "here", "gone", { moved: { title: "Inbox", url: "https://mail.google.com" } }] as const) {
      const english = useThisTabLine(outcome);
      for (const lang of OTHERS) expect(localizeLine(english, lang), `${lang}: ${english}`).not.toBe(english);
    }
  });

  it("translates notifications and the Test voice sample", () => {
    expect(localizeLine("Started: Post a tip on X", "de")).toBe("Gestartet: Einen Tipp auf X posten");
    expect(localizeLine("Started: Weekly report", "de")).toBe("Gestartet: Weekly report");
    expect(localizeLine("Noa started working on: Post a tip on X", "ko")).toBe("Noa가 작업을 시작했어요: X에 팁 올리기");
    expect(localizeLine('Click "Send" on gmail.com: it sends an email. Answer in the side panel.', "es")).toBe(
      'Click "Send" on gmail.com: it sends an email. Responde en el panel lateral.',
    );
    for (const lang of OTHERS) {
      for (const line of ["Task paused", "needs your OK", "Paused: Daily post", "Failing: Daily post", "Cannot run tasks", SPEECH_SAMPLE]) {
        expect(localizeLine(line, lang), `${lang}: ${line}`).not.toBe(line);
      }
    }
  });

  it("leaves a line it does not know as it is (the agent's own words)", () => {
    expect(localizeLine("I posted it.", "ko")).toBe("I posted it.");
    expect(localizeLine("Still no reply from Jordan", "es")).toBe("Still no reply from Jordan");
  });
});
