import { describe, expect, it } from "vitest";
import { elapsedText, HEARING, isMuteKey, MUTE_KEY, notListeningCaption, NOT_HERE_TEXT, remoteBarView, startingText, VoiceActivity, voiceBarView, type VoiceBarInput } from "../../src/voice/voice-bar-view.js";
import { boxLook, type HandsFreeLook } from "../../src/sidepanel/voice-input.js";

const base: VoiceBarInput = { phase: "listening", hearing: false, muted: false, engine: "realtime", elapsedMs: 42_000, where: null, elsewhere: false };
const view = (patch: Partial<VoiceBarInput>) => voiceBarView({ ...base, ...patch });

describe("the voice strip: it only tells", () => {
  it("'Voice on' and each phase's state word, the time on, the meter, the announcement; the hint in the tooltip", () => {
    const rows = (["starting", "listening", "sending", "working", "speaking"] as const).map((phase) => {
      const v = view({ phase });
      return [phase, v.label, v.status, v.time, v.meter, v.announce, v.hint];
    });
    expect(rows).toEqual([
      ["starting", "Voice starting", "Opening the mic…", null, false, "Voice starting: Opening the mic…", "Not listening yet: wait for the sound, then talk"],
      ["listening", "Voice on", "Listening", "0:42", true, "Voice on: Listening", "Realtime voice · Just talk · say “stop” to end"],
      ["sending", "Voice on", "Sending", "0:42", true, "Voice on: Sending", "Realtime voice · Say “cancel” or press Esc to take it back"],
      ["working", "Voice on", "Agent working", "0:42", true, "Voice on: Agent working", "Realtime voice · Still listening: talk to add to the task"],
      ["speaking", "Voice on", "Speaking", "0:42", false, "Voice on: Speaking", "Realtime voice · Esc stops it, or just talk"],
    ]);
    // No links on its own tab: the controls are in the composer.
    expect(view({}).links).toBeNull();
  });

  it("names the tab it runs for, on that tab too ('Voice on · Inbox'); the announcement stays short", () => {
    const v = view({ where: { title: "Inbox (3) - Gmail", url: "https://mail.google.com/" } });
    expect([v.label, v.status, v.announce]).toEqual(["Voice on · Inbox (3) - Gmail", "Listening", "Voice on: Listening"]);
    expect(view({ where: { title: null, url: "https://mail.google.com/u/0/" } }).label).toBe("Voice on · mail.google.com");
  });

  it("a voice on the microphone reads 'Hearing you' while listening or working, but is announced as the state it is in", () => {
    const listening = view({ hearing: true });
    expect([listening.state, listening.status, listening.announce]).toEqual(["hearing", "Hearing you", "Voice on: Listening"]);
    const working = view({ phase: "working", hearing: true });
    expect([working.state, working.status, working.announce]).toEqual(["hearing", "Hearing you", "Voice on: Agent working"]);
    expect(view({ phase: "speaking", hearing: true }).state).toBe("speaking");
    expect(view({ phase: "sending", hearing: true }).state).toBe("sending");
  });

  it("reconnecting after a dropped connection says so (the session goes on), also while the new one's audio is not in yet", () => {
    expect(view({ reconnecting: true, phase: "working" })).toMatchObject({ state: "reconnecting", status: "Reconnecting…", time: "0:42", meter: false, announce: "Voice on: Reconnecting…" });
    expect(view({ reconnecting: true, phase: "starting" })).toMatchObject({ state: "reconnecting", status: "Reconnecting…", mute: null });
  });

  it("starting, it says it does not listen yet and what it waits on; slow, that it is still at it", () => {
    const where = { title: "Inbox", url: null };
    expect(view({ phase: "starting", step: "connecting", where })).toMatchObject({ state: "starting", label: "Voice starting · Inbox", status: "Connecting…", meter: false, time: null, mute: null });
    expect(view({ phase: "starting", step: "connecting", slow: true }).status).toBe("Still connecting…");
    expect(view({ phase: "starting", step: "microphone", slow: true }).status).toBe("Still opening the mic…");
    // Muted while it starts: still starting (it is not on yet).
    expect(view({ phase: "starting", muted: true }).state).toBe("starting");
    expect([notListeningCaption("connecting"), notListeningCaption("microphone", true), notListeningCaption("reconnecting")]).toEqual([
      "Not listening yet · connecting…",
      "Not listening yet · still opening the mic…",
      "Not listening · reconnecting…",
    ]);
    expect(startingText("microphone")).toBe("Opening the mic…");
  });

  it("names the engine (once chosen) in the tooltip", () => {
    expect(view({ engine: "standard" }).hint).toMatch(/^Nova-3 voice · /);
    expect(view({ engine: null }).hint).toMatch(/^Voice · /);
  });

  it("on another tab it names the tab it listens in, with Go to tab and Use voice here (the mic here ends it: no Turn off)", () => {
    const v = view({ phase: "speaking", where: { title: "Inbox (3) - Gmail", url: null }, elsewhere: true });
    expect(v).toMatchObject({ state: "elsewhere", label: "Voice on · Inbox (3) - Gmail", status: "", time: "0:42", links: { turnOff: false }, announce: "Voice on · Inbox (3) - Gmail" });
    expect(view({ elsewhere: true }).label).toBe("Voice on · another tab");
  });

  it("in another window's panel: where voice is on, Go to tab, Use voice here and Turn off, nothing live", () => {
    expect(remoteBarView({ where: { title: "Shop A", url: null }, engine: "standard" })).toEqual({
      state: "elsewhere",
      label: "Voice on · Shop A",
      status: "",
      time: null,
      hint: `Nova-3 voice · ${NOT_HERE_TEXT}`,
      meter: false,
      announce: "Voice on · Shop A",
      links: { turnOff: true },
      muted: false,
      mute: null,
    });
    expect(remoteBarView({ where: null, engine: null })).toMatchObject({ label: "Voice on · another tab", hint: `Voice · ${NOT_HERE_TEXT}` });
  });

  it("formats the time on", () => {
    expect([0, 999, 7_000, 754_000, 3_723_000, -5].map(elapsedText)).toEqual(["0:00", "0:00", "0:07", "12:34", "1:02:03", "0:00"]);
  });
});

describe("the voice strip and the composer's Mute: muted", () => {
  const MUTE = { pressed: false, label: "Mute the microphone · Alt+M" };
  const UNMUTE = { pressed: true, label: "Unmute the microphone · Alt+M" };

  it("offers Mute (with its key) once the session runs, not while it starts", () => {
    expect(view({}).mute).toEqual(MUTE);
    expect(view({ phase: "speaking" }).mute).toEqual(MUTE);
    expect(view({ phase: "starting" }).mute).toBeNull();
    expect(view({ phase: "starting", muted: true })).toMatchObject({ state: "starting", mute: null, muted: true });
  });

  it("muted while listening or working: 'Muted', no meter, no 'Hearing you', the hint says updates still come", () => {
    const listening = view({ muted: true, hearing: true });
    expect(listening).toMatchObject({ state: "muted", status: "Muted", meter: false, announce: "Voice on: Muted", muted: true, mute: UNMUTE });
    expect(listening.hint).toBe("Realtime voice · Microphone off · Unmute to talk");
    expect(view({ phase: "working", muted: true })).toMatchObject({ state: "muted", status: "Muted", hint: "Realtime voice · Agent working · updates are still said" });
  });

  it("muted while a line is said or a message waits: that state, its hint without talking", () => {
    expect(view({ phase: "speaking", muted: true })).toMatchObject({ state: "speaking", status: "Speaking", muted: true, mute: UNMUTE, hint: "Realtime voice · Esc stops it · microphone muted" });
    expect(view({ phase: "sending", muted: true })).toMatchObject({ state: "sending", meter: false, muted: true, hint: "Realtime voice · Press Esc to take it back" });
  });

  it("on another tab: says it is muted, Mute still in the composer", () => {
    expect(view({ muted: true, elsewhere: true })).toMatchObject({ state: "elsewhere", status: "Muted", meter: false, muted: true, mute: UNMUTE });
    expect(view({ elsewhere: true }).mute).toEqual(MUTE);
  });

  it("in another window's panel: says it is muted; no Mute there (the panel running it has the microphone)", () => {
    expect(remoteBarView({ where: { title: "Shop A", url: null }, engine: "realtime", muted: true })).toMatchObject({ status: "Muted", muted: true, mute: null });
  });

  it("Alt+M by the key's position (Alt on a Mac types µ), nothing else", () => {
    const key = (patch: Partial<Parameters<typeof isMuteKey>[0]>) => isMuteKey({ code: MUTE_KEY.code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...patch });
    expect(key({})).toBe(true);
    expect([key({ altKey: false }), key({ ctrlKey: true }), key({ metaKey: true }), key({ shiftKey: true }), key({ code: "KeyN" })]).toEqual([false, false, false, false, false]);
  });
});

describe("VoiceActivity", () => {
  it("hears a voice at the meter level for a little while after it, not the quiet in between", () => {
    const a = new VoiceActivity();
    expect(a.hearing(0)).toBe(false);
    a.push(HEARING.level - 0.1, 100);
    expect(a.hearing(100)).toBe(false);
    a.push(HEARING.level, 200);
    expect(a.hearing(200)).toBe(true);
    a.push(0.05, 300);
    expect(a.hearing(200 + HEARING.holdMs - 1)).toBe(true);
    expect(a.hearing(200 + HEARING.holdMs)).toBe(false);
    a.push(0.9, 1000);
    a.reset();
    expect(a.hearing(1000)).toBe(false);
  });
});

describe("the box under a session (voice-input.ts boxLook)", () => {
  const look = (patch: Partial<HandsFreeLook>): HandsFreeLook => ({ orb: true, caption: "", phase: "listening", elsewhere: false, listening: true, muted: false, mute: null, ...patch });

  it("says it listens only while it does: not while it starts or reconnects; muted and other tabs as before", () => {
    expect([boxLook(null), boxLook(look({})), boxLook(look({ listening: false, phase: "opening" })), boxLook(look({ muted: true, listening: false })), boxLook(look({ elsewhere: true }))]).toEqual([
      "off",
      "listening",
      "starting",
      "muted",
      "off",
    ]);
  });
});
