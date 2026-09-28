import { describe, expect, it } from "vitest";
import {
  endsWithTab,
  listensElsewhere,
  lookingElsewhereNote,
  lookingHomeNote,
  remoteSession,
  spokenUseThisTab,
  TAB_TITLE_CHARS,
  useThisTabAnswer,
  useThisTabLine,
  voiceKeyAction,
  voiceOnLabel,
} from "../../src/voice/hands-free-tab.js";
import type { VoiceSessionView } from "../../src/voice-session.js";

const tabs = (...ids: number[]) => new Set(ids);

describe("hands-free voice belongs to the tab it started in", () => {
  it("the voice key starts a session when none is on, and ends the one that is on, wherever it listens", () => {
    expect(voiceKeyAction(false)).toBe("start");
    expect(voiceKeyAction(true)).toBe("stop");
  });

  it("a tab its chat lives in (the agent's own tab brought to the front) is the session's own", () => {
    expect(listensElsewhere(tabs(1, 7), 7)).toBe(false);
    expect(listensElsewhere(tabs(1, 7), 2)).toBe(true);
  });

  it("the voice bar says where it listens only on other tabs", () => {
    expect(listensElsewhere(tabs(1), 1)).toBe(false);
    expect(listensElsewhere(tabs(1), 2)).toBe(true);
    expect(listensElsewhere(tabs(), 2)).toBe(false);
    expect(listensElsewhere(tabs(1), null)).toBe(false);
  });

  it("closing the session's tab ends it; closing another tab does not", () => {
    expect(endsWithTab(1, 1)).toBe(true);
    expect(endsWithTab(1, 2)).toBe(false);
    expect(endsWithTab(null, 2)).toBe(false);
  });

  it("the strip names the tab it runs for: its title cut short, else its site; on another tab 'another tab' when unknown", () => {
    expect(voiceOnLabel({ title: "Inbox (3) - Gmail", url: "https://mail.google.com/" })).toBe("Voice on · Inbox (3) - Gmail");
    const long = voiceOnLabel({ title: "Quarterly planning   doc — Google Docs — shared with the whole team", url: null });
    expect(long).toMatch(/^Voice on · Quarterly planning doc — G.*…$/);
    expect(long.length - "Voice on · ".length).toBeLessThanOrEqual(TAB_TITLE_CHARS);
    expect(voiceOnLabel({ title: "  ", url: "https://mail.google.com/u/0/" })).toBe("Voice on · mail.google.com");
    expect(voiceOnLabel(null)).toBe("Voice on");
    expect(voiceOnLabel({ title: null, url: "not a url" })).toBe("Voice on");
    expect(voiceOnLabel(null, true)).toBe("Voice on · another tab");
  });
});

const session = (s: Partial<VoiceSessionView> = {}): VoiceSessionView => ({ tabId: 1, windowId: 9, panel: "p1", engine: "realtime", viewing: 1, ...s });

describe("one session, known to every panel through the background", () => {
  it("another panel's session is a notice in this one; this panel's own report (it has just stopped) is nothing", () => {
    expect(remoteSession(null, "p2")).toBe("none");
    expect(remoteSession(session(), "p2")).toBe("notice");
    expect(remoteSession(session({ tabId: 2 }), "p2")).toBe("notice");
    expect(remoteSession(session(), "p1")).toBe("none");
    // Not known which panel runs it (kept from an older version): another one's.
    expect(remoteSession(session({ panel: null }), "p1")).toBe("notice");
  });
});

describe("what the agent and the narrator are told while the user looks at another tab", () => {
  const shop = { title: "Shop A", url: "https://shop.example.com/cart" };
  const recipes = { title: "Recipes  B", url: "http://127.0.0.1:5173/b" };

  it("names both tabs, with their sites, short", () => {
    expect(lookingElsewhereNote(recipes, shop)).toBe("The user is looking at another tab: Recipes B (127.0.0.1:5173). You work in Shop A (shop.example.com).");
    expect(lookingElsewhereNote(null, null)).toBe("The user is looking at another tab: another tab. You work in the tab where voice started.");
    expect(lookingElsewhereNote({ title: "", url: "chrome://newtab/" }, { title: "Shop A", url: null })).toBe("The user is looking at another tab: newtab. You work in Shop A.");
    expect(lookingHomeNote(shop)).toBe("The user is looking at Shop A (shop.example.com) again, the tab you work in.");
  });

  it("hears 'use this tab' and its variants, not requests that mention a tab", () => {
    for (const said of ["Use this tab.", "use this tab please", "OK, switch here!", "Switch to this tab", "move over here", "Use voice here", "work in the current tab"]) {
      expect(spokenUseThisTab(said), said).toBe(true);
    }
    for (const said of ["Close this tab", "use this tab to find the cheapest flight", "What's on this tab?", "switch the heater on here", ""]) {
      expect(spokenUseThisTab(said), said).toBe(false);
    }
  });

  it("tells the narrator (and Standard, aloud) what use this tab did", () => {
    expect(useThisTabAnswer({ moved: recipes })).toBe("Moved: you now work in Recipes B (127.0.0.1:5173); what the user says goes to that tab's chat.");
    expect(useThisTabAnswer({ moved: { title: "New Tab", url: "chrome://newtab/" } })).toMatch(/Chrome doesn't let you see that page/);
    expect(useThisTabAnswer("here")).toBe("The user is already looking at the tab you work in.");
    expect(useThisTabAnswer("unknown")).toMatch(/Use voice here/);
    expect(useThisTabAnswer("gone")).toBe("That tab is gone: nothing moved.");
    expect(useThisTabLine({ moved: recipes })).toBe("Now working in Recipes B.");
    expect(useThisTabLine("here")).toBe("I'm already working in this tab.");
  });
});
