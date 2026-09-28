import { describe, expect, it } from "vitest";
import { DIALOG_AUTO_DISMISS_MS, dialogAnswerLabel, dialogLabel, dialogLine, dialogOpenText, dialogText, isDialogOpenText, LEAVE_SITE_TEXT, TOOL_NAMES, toolsFor } from "../src/index.js";

describe("dialog texts", () => {
  it('a "Leave site?" (beforeunload has no text of its own) reads as Chrome shows it; long texts are cut', () => {
    expect(dialogText({ type: "beforeunload", message: "" })).toBe(LEAVE_SITE_TEXT);
    expect(dialogLabel({ type: "confirm", message: " Delete this item? " })).toBe("confirm “Delete this item?”");
    expect(dialogText({ type: "alert", message: "x".repeat(400) })).toHaveLength(300);
  });

  it("the error of a call on a frozen page says what is open, where, and how to answer it", () => {
    const text = dialogOpenText({ type: "confirm", message: "Delete this item?" });
    expect(text).toBe("A browser dialog is open: confirm “Delete this item?”. The page is frozen until it is answered: call handle_dialog (accept false: Cancel / Stay on the page; true: OK / Leave).");
    expect(dialogOpenText({ type: "beforeunload", message: "" }, "t3")).toContain("beforeunload “Leave site? Changes you made may not be saved.” in t3. The page is frozen until it is answered: call handle_dialog with tab t3");
    expect(isDialogOpenText(`act failed: ${text}`)).toBe(true);
    expect(isDialogOpenText("Navigation failed: net::ERR_ABORTED")).toBe(false);
  });

  it("the run's line says what was pressed, and by whom when it was not the agent", () => {
    const dialog = { type: "confirm" as const, message: "Delete this item?", url: "https://shop.test/" };
    expect(dialogLine({ dialog, outcome: "accepted", by: "agent" })).toBe("Dialog: Delete this item? → OK");
    expect(dialogLine({ dialog, outcome: "dismissed", by: "auto" })).toBe(`Dialog: Delete this item? → Cancel (automatically after ${DIALOG_AUTO_DISMISS_MS / 1000} s)`);
    expect(dialogLine({ dialog: { ...dialog, type: "prompt", message: "Name?" }, outcome: "accepted", by: "user", text: "Bo" })).toBe("Dialog: Name? → OK “Bo” (in the browser)");
    expect(dialogAnswerLabel("beforeunload", "accepted")).toBe("Leave");
    expect(dialogAnswerLabel("alert", "dismissed")).toBe("OK");
  });

  it("handle_dialog is a tool the agent gets, also in the user's own Claude Code", () => {
    expect(TOOL_NAMES).toContain("handle_dialog");
    expect(toolsFor({ interactive: true })).toContain("handle_dialog");
  });
});
