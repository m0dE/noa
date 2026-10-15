import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings } from "@noa/shared";
import { BEFORE_START_POINTS, BEFORE_START_TITLE, beforeStartShown } from "../../src/sidepanel/before-start.js";

describe("before you start", () => {
  it("shows until the user says they understand, then never again", () => {
    expect(beforeStartShown({ disclaimerAccepted: false })).toBe(true);
    expect(beforeStartShown({ disclaimerAccepted: true })).toBe(false);
  });

  it("shows on a fresh install, and on an install from before the setting existed", () => {
    expect(DEFAULT_SETTINGS.disclaimerAccepted).toBe(false);
    expect(parseSettings({ brain: "noa" }).disclaimerAccepted).toBe(false);
    expect(parseSettings({ disclaimerAccepted: true }).disclaimerAccepted).toBe(true);
  });

  it("says first that Noa can make mistakes, in a short plain sentence", () => {
    expect(BEFORE_START_TITLE).toBe("Before you start");
    expect(BEFORE_START_POINTS[0]?.text.startsWith("Noa can make mistakes.")).toBe(true);
    for (const p of BEFORE_START_POINTS) expect(p.text.length).toBeLessThan(260);
  });
});
