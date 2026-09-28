/**
 * The background's record of the hands-free session: every panel is told where it runs and which tab the user looks
 * at, the toolbar badges follow (live on its tab, grey on the tab looked at instead), and a restarted worker keeps it.
 */
import { describe, expect, it, vi } from "vitest";
import { VOICE_BADGES, VoiceSessions, type VoiceSessionDeps, type VoiceSessionInfo } from "../src/voice-session.js";

const A = 11;
const B = 12;
const C = 21;
const WIN = 1;
const WIN2 = 2;
const inA: VoiceSessionInfo = { tabId: A, windowId: WIN, panel: "pa", engine: "realtime" };

function setup(opts: { stored?: unknown; alive?: boolean } = {}) {
  const broadcast = vi.fn();
  const badge = vi.fn();
  const saved: unknown[] = [];
  const deps: VoiceSessionDeps = {
    broadcast,
    badge,
    storage: { load: async () => opts.stored, save: async (v) => void saved.push(v) },
    alive: async () => opts.alive ?? true,
  };
  const vs = new VoiceSessions(deps);
  return { vs, broadcast, badge, saved };
}

describe("VoiceSessions: one session, told to every panel", () => {
  it("says where it runs and which tab the user looks at, only when that changes", async () => {
    const { vs, broadcast } = setup();
    await vs.ready;
    vs.seed([{ tabId: A, windowId: WIN }], WIN);
    broadcast.mockClear();
    vs.set(inA);
    expect(broadcast.mock.calls).toEqual([[{ ...inA, viewing: A }]]);
    // The user switches to tab B: A's panel is hidden now, and learns it.
    vs.tabActivated(B, WIN);
    expect(broadcast.mock.calls.at(-1)).toEqual([{ ...inA, viewing: B }]);
    // The same again: nothing new.
    vs.tabActivated(B, WIN);
    vs.set({ ...inA });
    expect(broadcast).toHaveBeenCalledTimes(2);
    vs.set(null);
    expect(broadcast.mock.calls.at(-1)).toEqual([null]);
    // Tabs switched with no session: nothing to tell.
    vs.tabActivated(A, WIN);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it("the tab looked at is the active tab of the focused window; the focus leaving Chrome changes nothing", async () => {
    const { vs } = setup();
    await vs.ready;
    vs.seed([{ tabId: A, windowId: WIN }, { tabId: C, windowId: WIN2 }], WIN);
    vs.set(inA);
    vs.windowFocused(WIN2);
    expect(vs.view()?.viewing).toBe(C);
    vs.windowFocused(-1);
    expect(vs.view()?.viewing).toBe(C);
    vs.windowRemoved(WIN2);
    // No focused window known: the session's own window.
    expect(vs.view()?.viewing).toBe(A);
  });

  it("the seed at start does not undo what the events said meanwhile", async () => {
    const { vs } = setup();
    await vs.ready;
    vs.tabActivated(B, WIN);
    vs.windowFocused(WIN);
    vs.seed([{ tabId: A, windowId: WIN }], WIN2);
    vs.set(inA);
    expect(vs.view()?.viewing).toBe(B);
  });
});

describe("VoiceSessions: the toolbar badges", () => {
  it("live on the session's tab; grey on the tab the user looks at instead, moved as they switch, set again when it loads", async () => {
    const { vs, badge } = setup();
    await vs.ready;
    vs.seed([{ tabId: A, windowId: WIN }], WIN);
    vs.set(inA);
    expect(badge.mock.calls).toEqual([[A, "live"]]);
    vs.tabActivated(B, WIN);
    expect(badge.mock.calls.at(-1)).toEqual([B, "elsewhere"]);
    // Chrome clears a tab's badge when it loads a page: set again, only on tabs that have one.
    badge.mockClear();
    vs.tabLoading(B);
    vs.tabLoading(99);
    expect(badge.mock.calls).toEqual([[B, "elsewhere"]]);
    // Another window's tab now: the grey badge moves there.
    vs.seed([{ tabId: C, windowId: WIN2 }], null);
    badge.mockClear();
    vs.windowFocused(WIN2);
    expect(badge.mock.calls).toEqual([
      [B, null],
      [C, "elsewhere"],
    ]);
    // Back to the first window (tab B in front there), then to the session's tab: no grey badge.
    badge.mockClear();
    vs.windowFocused(WIN);
    vs.tabActivated(A, WIN);
    expect(badge.mock.calls).toEqual([
      [C, null],
      [B, "elsewhere"],
      [B, null],
    ]);
  });

  it("moved to another tab (use this tab), the live badge goes with it; over, every badge goes", async () => {
    const { vs, badge } = setup();
    await vs.ready;
    vs.seed([{ tabId: B, windowId: WIN }], WIN);
    vs.set(inA);
    expect(badge.mock.calls).toEqual([
      [A, "live"],
      [B, "elsewhere"],
    ]);
    badge.mockClear();
    vs.set({ ...inA, tabId: B });
    // B's grey badge becomes the live one; A's goes.
    expect(badge.mock.calls).toEqual([
      [A, null],
      [B, "live"],
    ]);
    badge.mockClear();
    vs.set(null);
    expect(badge.mock.calls).toEqual([[B, null]]);
  });

  it("muted: the badges say MUTE in grey (its tab, and the tab looked at instead); unmuted, MIC again", async () => {
    const { vs, badge, broadcast } = setup();
    await vs.ready;
    vs.seed([{ tabId: A, windowId: WIN }], WIN);
    vs.set(inA);
    badge.mockClear();
    vs.set({ ...inA, muted: true });
    expect(badge.mock.calls).toEqual([[A, "muted"]]);
    // Every panel learns it (another tab's bar says it is muted).
    expect(broadcast.mock.calls.at(-1)).toEqual([{ ...inA, muted: true, viewing: A }]);
    vs.tabActivated(B, WIN);
    expect(badge.mock.calls.at(-1)).toEqual([B, "elsewhere-muted"]);
    badge.mockClear();
    vs.set(inA);
    expect(badge.mock.calls).toEqual([
      [A, "live"],
      [B, "elsewhere"],
    ]);
    expect(VOICE_BADGES.muted).toMatchObject({ text: "MUTE", color: VOICE_BADGES.elsewhere.color });
    expect(VOICE_BADGES["elsewhere-muted"]).toMatchObject({ text: "MUTE", color: VOICE_BADGES.elsewhere.color, title: expect.stringMatching(/muted/) });
  });

  it("a closed tab is forgotten (Chrome dropped its badge with it)", async () => {
    const { vs, badge } = setup();
    await vs.ready;
    vs.seed([{ tabId: B, windowId: WIN }], WIN);
    vs.set(inA);
    badge.mockClear();
    vs.tabRemoved(B);
    expect(badge).not.toHaveBeenCalled();
    expect(vs.view()?.viewing).toBeNull();
  });
});

describe("VoiceSessions: a restarted service worker", () => {
  it("keeps the session and the badges it set", async () => {
    const { vs, saved } = setup();
    await vs.ready;
    vs.seed([{ tabId: B, windowId: WIN }], WIN);
    vs.set(inA);
    expect(saved.at(-1)).toEqual({ session: inA, badges: [[A, "live"], [B, "elsewhere"]] });
  });

  it("keeps a muted session muted, with its badges", async () => {
    const { vs } = setup({ stored: { session: { ...inA, muted: true }, badges: [[A, "muted"]] } });
    await vs.ready;
    expect(vs.view()).toEqual({ ...inA, muted: true, viewing: null });
  });

  it("knows the kept session before its panel says so again, when that panel is still open", async () => {
    const { vs, broadcast } = setup({ stored: { session: inA, badges: [[A, "live"]] } });
    await vs.ready;
    expect(vs.view()).toEqual({ ...inA, viewing: null });
    expect(broadcast.mock.calls.at(-1)).toEqual([{ ...inA, viewing: null }]);
  });

  it("drops a kept session whose panel is gone, and clears the badges it had set", async () => {
    const { vs, badge } = setup({ stored: { session: inA, badges: [[A, "live"], [B, "elsewhere"]] }, alive: false });
    await vs.ready;
    expect(vs.view()).toBeNull();
    expect(badge.mock.calls).toEqual([
      [A, null],
      [B, null],
    ]);
  });

  it("a panel's report before the kept one was read wins", async () => {
    const { vs } = setup({ stored: { session: inA, badges: [] } });
    vs.set(null);
    await vs.ready;
    expect(vs.view()).toBeNull();
  });
});
