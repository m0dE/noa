import { describe, expect, it, vi } from "vitest";
import { EARCON_NOTES, EARCON_SHAPE, Earcons, type EarconContext } from "../../src/voice/earcons.js";

/** An AudioContext that records the notes scheduled on it. */
function fakeContext(state = "running") {
  const notes: { hz: number; start: number; stop: number; peak: number }[] = [];
  const resume = vi.fn(async () => undefined);
  const ctx: EarconContext = {
    currentTime: 1,
    state,
    destination: {},
    resume,
    createOscillator() {
      const note = { hz: 0, start: 0, stop: 0, peak: 0 };
      notes.push(note);
      return {
        type: "",
        frequency: { setValueAtTime: (v: number) => (note.hz = v) },
        connect: () => undefined,
        start: (t: number) => void (note.start = t),
        stop: (t: number) => void (note.stop = t),
      };
    },
    createGain() {
      const note = () => notes.at(-1)!;
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: (v: number) => void (note().peak = Math.max(note().peak, v)),
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
      };
    },
  };
  return { ctx, notes, resume };
}

describe("earcons", () => {
  it("start rises, stop falls: two short, soft notes one after the other", () => {
    const { ctx, notes } = fakeContext();
    const e = new Earcons(() => ctx);
    e.play("start");
    expect(notes.map((n) => n.hz)).toEqual([...EARCON_NOTES.start]);
    expect(notes[0]!.hz).toBeLessThan(notes[1]!.hz);
    expect(notes[1]!.start).toBeGreaterThan(notes[0]!.start);
    for (const n of notes) {
      expect(n.peak).toBeLessThanOrEqual(0.1);
      expect(n.stop - n.start).toBeLessThan(0.15);
    }
    notes.length = 0;
    e.play("stop");
    expect(notes[0]!.hz).toBeGreaterThan(notes[1]!.hz);
    expect(EARCON_SHAPE.peak).toBeLessThanOrEqual(0.1);
  });

  it("makes one audio context and wakes it when it is suspended", () => {
    const { ctx, resume } = fakeContext("suspended");
    const create = vi.fn(() => ctx);
    const e = new Earcons(create);
    e.play("start");
    e.play("stop");
    expect(create).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalled();
  });

  it("without audio it says why and goes on", () => {
    const log = vi.fn();
    const e = new Earcons(() => {
      throw new Error("no audio device");
    }, log);
    expect(() => e.play("start")).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/earcon start failed: .*no audio device/));
  });
});
