import { describe, expect, it } from "vitest";
import type { VoiceEngine } from "@noa/shared";
import { checkEngine, costPerMinuteText, LOW_CREDIT_MINUTES, REALTIME_UNAVAILABLE_TEXT } from "../../src/voice/engine-choice.js";

const engine = (id: "realtime" | "standard", cents: number, available = true): VoiceEngine => ({
  id,
  name: id === "realtime" ? "Realtime (OpenAI)" : "Standard",
  model: id === "realtime" ? "gpt-realtime-2.1" : "whisper",
  approxCentsPerMinute: cents,
  assumption: "half talking, half listening",
  available,
});
const list = (...engines: VoiceEngine[]) => ({ engines, default: "realtime" as const });
const ENGINES = list(engine("realtime", 30), engine("standard", 0.2));

describe("checkEngine: the engine is always the one picked", () => {
  it("the engine picked in Settings starts", () => {
    expect(checkEngine({ picked: "realtime", engines: ENGINES, creditCents: 1000 })).toEqual({ blocked: null, note: null });
    expect(checkEngine({ picked: "standard", engines: ENGINES, creditCents: 1000 })).toEqual({ blocked: null, note: null });
  });

  it("Realtime the server cannot run does not start, and says why (never Standard in its place)", () => {
    const r = checkEngine({ picked: "realtime", engines: list(engine("realtime", 30, false), engine("standard", 0.2)), creditCents: 1000 });
    expect(r).toEqual({ blocked: REALTIME_UNAVAILABLE_TEXT, note: null });
    expect(checkEngine({ picked: "realtime", engines: list(engine("standard", 0.2)), creditCents: 1000 }).blocked).toBe(REALTIME_UNAVAILABLE_TEXT);
    // The server's default says so too.
    expect(checkEngine({ picked: "realtime", engines: { ...ENGINES, default: "standard" }, creditCents: 1000 }).blocked).toBe(REALTIME_UNAVAILABLE_TEXT);
  });

  it(`credit for fewer than ${LOW_CREDIT_MINUTES} minutes of Realtime: it still starts, with a note`, () => {
    const low = checkEngine({ picked: "realtime", engines: ENGINES, creditCents: 30 * LOW_CREDIT_MINUTES - 1 });
    expect(low).toEqual({ blocked: null, note: "Usage credit is low: about 2 minutes of Realtime voice left." });
    expect(checkEngine({ picked: "realtime", engines: ENGINES, creditCents: 30 * LOW_CREDIT_MINUTES })).toEqual({ blocked: null, note: null });
  });

  it("without the engine list or the credit, tries Realtime (the relay says if it cannot)", () => {
    expect(checkEngine({ picked: "realtime", engines: null, creditCents: undefined })).toEqual({ blocked: null, note: null });
  });
});

describe("costPerMinuteText: the cost from the server's numbers", () => {
  it("says the approximate usage credit a minute", () => {
    expect(costPerMinuteText(30)).toBe("about 30¢ of usage credit a minute");
    expect(costPerMinuteText(125)).toBe("about $1.25 of usage credit a minute");
    expect(costPerMinuteText(0.42)).toBe("about 0.42¢ of usage credit a minute");
    expect(costPerMinuteText(1.729)).toBe("about 1.7¢ of usage credit a minute");
    expect(costPerMinuteText(6.0762)).toBe("about 6.1¢ of usage credit a minute");
    expect(costPerMinuteText(0.004)).toBe("under 0.01¢ of usage credit a minute");
  });
});
