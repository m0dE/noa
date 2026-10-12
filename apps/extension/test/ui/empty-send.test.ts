/** Sending an empty box: it looks at the page (a new job, or the next turn of the one shown). */
import { describe, expect, it } from "vitest";
import { SCREEN_HELP_TEXT } from "@noa/shared";
import { emptySend, NEW_JOB_PLACEHOLDER, SCREEN_SEND_TITLE } from "../../src/sidepanel/composer.js";
import { describeEvent, isScreenHelp } from "../../src/sidepanel/event-format.js";

const base = { mode: "new" as const, sessionId: null, hasFiles: false, tabId: 7 };

describe("emptySend", () => {
  it("a new chat: a one-off run with the screen flag, in the panel's tab", () => {
    expect(emptySend(base)).toEqual({ request: { type: "run.adhoc", instructions: "", screen: true, tabId: 7 } });
    expect(emptySend({ ...base, tabId: null })).toEqual({ request: { type: "run.adhoc", instructions: "", screen: true } });
  });

  it("an ended conversation: its next turn, look at the page now and continue", () => {
    expect(emptySend({ ...base, mode: "conversation", sessionId: "S1" })).toEqual({
      request: { type: "run.message", sessionId: "S1", text: "", screen: true, tabId: 7 },
    });
  });

  it("nothing is sent while a turn runs, or with files but no words", () => {
    expect(emptySend({ ...base, mode: "running", sessionId: "S1" })).toMatchObject({ hint: expect.stringMatching(/working/) });
    expect(emptySend({ ...base, hasFiles: true })).toMatchObject({ hint: expect.stringMatching(/files/) });
  });

  it("a new job's placeholder says what an empty send does, and the user's turn reads the same", () => {
    // The list's box invites a new job; Send's tooltip says an empty send looks at the page.
    expect(NEW_JOB_PLACEHOLDER).toBe("Start a new job…");
    expect(SCREEN_SEND_TITLE).toMatch(/look at this page/);
    expect(isScreenHelp(SCREEN_HELP_TEXT)).toBe(true);
    expect(isScreenHelp("hello")).toBe(false);
    expect(describeEvent({ type: "user_message", text: SCREEN_HELP_TEXT })).toEqual({ kind: "user", text: SCREEN_HELP_TEXT, screen: true });
    expect(describeEvent({ type: "user_message", text: "hi" })).toEqual({ kind: "user", text: "hi" });
  });
});
