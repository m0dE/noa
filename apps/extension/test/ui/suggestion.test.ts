/** The follow-up suggestion in the chat's input box: inline completion, Tab, Esc, typing, voice, and the empty send. */
import { describe, expect, it } from "vitest";
import { emptySend } from "../../src/sidepanel/composer.js";
import { FollowUpSuggestion, suggestionDescription, suggestionRest, type SuggestionKey } from "../../src/sidepanel/suggestion.js";

const TEXT = "Reply to Jordan and say I'll sign by Thursday";
const key = (k: string, mods: Partial<SuggestionKey> = {}): SuggestionKey => ({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...mods });

function offered(turn = "s1@t1") {
  const s = new FollowUpSuggestion();
  s.setOffer({ text: TEXT, turn });
  return s;
}

describe("suggestionRest", () => {
  it("an empty box shows the whole suggestion; a typed start shows the rest (case ignored)", () => {
    expect(suggestionRest(TEXT, "")).toBe(TEXT);
    expect(suggestionRest(TEXT, "Reply to")).toBe(" Jordan and say I'll sign by Thursday");
    expect(suggestionRest(TEXT, "reply TO j")).toBe("ordan and say I'll sign by Thursday");
  });

  it("anything else hides it, as does the whole suggestion typed out", () => {
    expect(suggestionRest(TEXT, "Forward")).toBeNull();
    expect(suggestionRest(TEXT, " Reply")).toBeNull();
    expect(suggestionRest(TEXT, TEXT)).toBeNull();
    expect(suggestionRest(TEXT, `${TEXT}!`)).toBeNull();
  });
});

describe("FollowUpSuggestion", () => {
  it("shows nothing without an offer", () => {
    const s = new FollowUpSuggestion();
    expect(s.rest("")).toBeNull();
    expect(s.onKey(key("Tab"), "")).toBeNull();
  });

  it("Tab in the empty box takes the whole suggestion into the box", () => {
    const s = offered();
    expect(s.shown("")).toBe(TEXT);
    expect(s.onKey(key("Tab"), "")).toEqual({ accept: TEXT });
  });

  it("typing its start keeps the rest showing, and Tab completes it after the typed text", () => {
    const s = offered();
    expect(s.rest("reply to")).toBe(" Jordan and say I'll sign by Thursday");
    expect(s.onKey(key("Tab"), "reply to")).toEqual({ accept: "reply to Jordan and say I'll sign by Thursday" });
    // Once taken, the box holds all of it: nothing more to show, Tab is the box's again.
    expect(s.rest(TEXT)).toBeNull();
    expect(s.onKey(key("Tab"), TEXT)).toBeNull();
  });

  it("typing something else hides it; Tab then moves the focus as usual; clearing the box shows it again", () => {
    const s = offered();
    expect(s.rest("Open")).toBeNull();
    expect(s.onKey(key("Tab"), "Open")).toBeNull();
    expect(s.onKey(key("Escape"), "Open")).toBeNull();
    expect(s.rest("")).toBe(TEXT);
  });

  it("Shift+Tab, modified Tab and Tab while composing (IME) are the box's", () => {
    const s = offered();
    expect(s.onKey(key("Tab", { shiftKey: true }), "")).toBeNull();
    expect(s.onKey(key("Tab", { ctrlKey: true }), "")).toBeNull();
    expect(s.onKey(key("Tab", { isComposing: true }), "")).toBeNull();
  });

  it("Esc dismisses it for this turn; the next turn's suggestion shows", () => {
    const s = offered("s1@t1");
    expect(s.onKey(key("Escape"), "")).toBe("dismissed");
    expect(s.rest("")).toBeNull();
    expect(s.onKey(key("Tab"), "")).toBeNull();
    s.setOffer({ text: "Archive the newsletter", turn: "s1@t1" });
    expect(s.rest("")).toBeNull();
    s.setOffer({ text: "Archive the newsletter", turn: "s1@t2" });
    expect(s.rest("")).toBe("Archive the newsletter");
  });

  it("sending anything dismisses it (the box empties before the new turn arrives)", () => {
    const s = offered();
    s.dismiss();
    expect(s.shown("")).toBeNull();
  });

  it("hands-free voice hides it while it is on (it may write into the box)", () => {
    const s = offered();
    s.setDictating(true);
    expect(s.rest("")).toBeNull();
    expect(s.onKey(key("Tab"), "")).toBeNull();
    s.setDictating(false);
    expect(s.rest("")).toBe(TEXT);
  });

  it("Enter is never the suggestion's: an empty Enter still looks at the page", () => {
    const s = offered();
    expect(s.onKey(key("Enter"), "")).toBeNull();
    expect(emptySend({ mode: "conversation", sessionId: "s1", hasFiles: false, tabId: 3 })).toEqual({
      request: { type: "run.message", sessionId: "s1", text: "", screen: true, tabId: 3 },
    });
  });

  it("screen readers hear the suggestion and how to take it", () => {
    expect(suggestionDescription(TEXT)).toBe(`Suggestion: “${TEXT}”. Press Tab to use it.`);
  });
});
