import { describe, expect, it } from "vitest";
import { agentTabToView, chatInTab, isBound, ownChatOfTab, tabOfSession } from "../../src/sidepanel/tab-chat.js";

const state = {
  tabChats: { "1": "A", "2": "B" },
  runningTabs: { B: [2, 5], S: [9], A: [1] },
};

describe("ownChatOfTab: the tab's own chat (its job shows; hands-free voice talks to it)", () => {
  it("the tab's bound or just-started chat, never a scheduled run that only acts in the tab (its results were read out)", () => {
    expect(ownChatOfTab(1, state)).toBe("A");
    expect(ownChatOfTab(3, state, { pending: { tab: 3, sessionId: "N" } })).toBe("N");
    expect(ownChatOfTab(4, state, { pending: { tab: 3, sessionId: "N" } })).toBeNull();
    // Once it is bound somewhere (it moved to a new tab), the pending note no longer applies.
    expect(ownChatOfTab(3, { tabChats: { "8": "N" } }, { pending: { tab: 3, sessionId: "N" } })).toBeNull();
    // Tab 9 has no chat; a scheduled run S only works in it.
    expect(ownChatOfTab(9, state)).toBeNull();
    expect(ownChatOfTab(null, state)).toBeNull();
  });
});

describe("chatInTab: the job a panel following the active tab shows", () => {
  it("the tab's own chat, else a run working there that belongs to no tab, else none (the list)", () => {
    expect(chatInTab(1, state)).toBe("A");
    expect(chatInTab(9, state)).toBe("S");
    // Tab 5 was opened by B's agent, and B belongs to tab 2.
    expect(chatInTab(5, state)).toBeNull();
    expect(chatInTab(3, state)).toBeNull();
    expect(chatInTab(3, state, { pending: { tab: 3, sessionId: "N" } })).toBe("N");
    expect(chatInTab(null, state)).toBeNull();
  });
});

describe("where a conversation lives", () => {
  it("its tab, else the tab it runs in", () => {
    expect(tabOfSession("B", state)).toBe(2);
    expect(tabOfSession("S", state)).toBe(9);
    expect(tabOfSession("X", state)).toBeNull();
    expect(isBound("A", state)).toBe(true);
    expect(isBound("S", state)).toBe(false);
  });
});

describe("agentTabToView: the job page's row to watch the agent's tab", () => {
  it("while it runs: the tab it acts on now, unless the user looks at it", () => {
    // B belongs to tab 2 and acts on tab 5 now (a tab it opened): the user on tab 2 is offered tab 5.
    const acting = { tabChats: { "2": "B" }, runningTabs: { B: [5, 2] } };
    expect(agentTabToView("B", 2, acting)).toBe(5);
    expect(agentTabToView("B", 5, acting)).toBeNull();
    // A scheduled run (bound to no tab) in tab 9, seen from tab 1.
    expect(agentTabToView("S", 1, state)).toBe(9);
    expect(agentTabToView("S", 9, state)).toBeNull();
    // Running in the user's own tab: nothing to show.
    expect(agentTabToView("A", 1, state)).toBeNull();
  });

  it("not running: the tab it belongs to (it just ran there), else none", () => {
    const ended = { tabChats: { "2": "B" }, runningTabs: {} };
    expect(agentTabToView("B", 1, ended)).toBe(2);
    expect(agentTabToView("B", 2, ended)).toBeNull();
    expect(agentTabToView("X", 1, ended)).toBeNull();
    expect(agentTabToView(null, 1, ended)).toBeNull();
    // The panel page opened as a tab may not know the tab it is in: any agent tab is offered.
    expect(agentTabToView("B", null, ended)).toBe(2);
  });
});
