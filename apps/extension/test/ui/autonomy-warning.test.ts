import { describe, expect, it } from "vitest";
import { autonomyWarningState } from "../../src/sidepanel/autonomy-warning.js";

describe("autonomy warning", () => {
  it("shows while full autonomy is on until closed", () => {
    expect(autonomyWarningState("full", false)).toEqual({ show: true, clearClosed: false });
    expect(autonomyWarningState("full", true)).toEqual({ show: false, clearClosed: false });
  });

  it("clears the closed mark once full autonomy is off, so turning it on again shows the warning", () => {
    expect(autonomyWarningState("ask_consequential", true)).toEqual({ show: false, clearClosed: true });
    expect(autonomyWarningState("ask_all", false)).toEqual({ show: false, clearClosed: false });
  });
});
