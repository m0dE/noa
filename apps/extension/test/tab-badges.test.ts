import { describe, expect, it } from "vitest";
import { CONTROL_BADGES } from "../src/control-indicator.js";
import { TabBadges, type BadgeLook } from "../src/tab-badges.js";
import { VOICE_BADGES } from "../src/voice-session.js";

function harness() {
  const painted: [number, string | null][] = [];
  const voice = new Map<number, BadgeLook>();
  const badges = new TabBadges({
    paint: (tabId, look) => painted.push([tabId, look?.text ?? null]),
    voiceOf: (tabId) => voice.get(tabId) ?? null,
  });
  // As VoiceSessions does: its record changes, then it tells the badges.
  const setVoice = (tabId: number, look: BadgeLook | null) => {
    if (look) voice.set(tabId, look);
    else voice.delete(tabId);
    badges.voice(tabId, look);
  };
  return { badges, painted, setVoice };
}

describe("TabBadges", () => {
  it("the agent's badge shows on a tab it controls and clears when control ends", () => {
    const { badges, painted } = harness();
    badges.controlled(1, CONTROL_BADGES.working);
    badges.controlled(1, null);
    expect(painted).toEqual([
      [1, "RUN"],
      [1, null],
    ]);
  });

  it("voice wins while it has the tab; the agent's badge comes back when voice ends", () => {
    const { badges, painted, setVoice } = harness();
    setVoice(1, VOICE_BADGES.live);
    badges.controlled(1, CONTROL_BADGES.working);
    expect(painted.at(-1)).toEqual([1, "MIC"]);
    setVoice(1, null);
    expect(painted.at(-1)).toEqual([1, "RUN"]);
    badges.controlled(1, null);
    expect(painted.at(-1)).toEqual([1, null]);
  });

  it("control ending leaves a voice badge alone", () => {
    const { badges, painted, setVoice } = harness();
    badges.controlled(1, CONTROL_BADGES["needs-you"]);
    setVoice(1, VOICE_BADGES.muted);
    badges.controlled(1, null);
    expect(painted.at(-1)).toEqual([1, "MUTE"]);
  });

  it("clearing a tab it never marked paints nothing (voice's badge there stays)", () => {
    const { badges, painted } = harness();
    badges.controlled(2, null);
    expect(painted).toEqual([]);
  });

  it("a page load sets the agent's badge again unless voice has the tab", () => {
    const { badges, painted, setVoice } = harness();
    badges.controlled(1, CONTROL_BADGES.working);
    badges.controlled(2, CONTROL_BADGES.working);
    setVoice(2, VOICE_BADGES.live);
    painted.length = 0;
    badges.tabLoading(1);
    badges.tabLoading(2);
    badges.tabLoading(3);
    expect(painted).toEqual([[1, "RUN"]]);
  });
});
