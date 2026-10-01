import { describe, expect, it } from "vitest";
import { BARGE_IN_MS, EchoGate, INITIAL_COUPLING, REPLAY_MS } from "../../src/voice/echo-gate.js";

const RATE = 24_000;
/** 100 ms of noise at RMS about `level`. */
const chunk = (level: number) => Float32Array.from({ length: RATE / 10 }, (_, i) => (i % 2 ? level : -level));
const silent = (a: Float32Array[]) => a.every((c) => c.every((x) => x === 0));

describe("EchoGate: the narrator's own voice heard back never reaches turn detection", () => {
  it("nothing plays: the microphone goes out as it is", () => {
    const g = new EchoGate(RATE);
    const mic = chunk(0.1);
    expect(g.push(mic, 0)).toEqual({ send: [mic], opened: false });
  });

  it("while it plays, its echo (quieter than the margin over what plays) goes out as silence, however long", () => {
    const g = new EchoGate(RATE);
    for (let i = 0; i < 50; i++) {
      const r = g.push(chunk(0.1 * 0.15), 0.1);
      expect(r.opened).toBe(false);
      expect(silent(r.send)).toBe(true);
    }
  });

  it("the user talking over it for BARGE_IN_MS goes out, the audio just before first (their first words)", () => {
    const g = new EchoGate(RATE);
    for (let i = 0; i < 10; i++) g.push(chunk(0.1 * 0.05), 0.1);
    const loud = Math.ceil(BARGE_IN_MS / 100);
    let out: { send: Float32Array[]; opened: boolean } | null = null;
    for (let i = 0; i < loud; i++) out = g.push(chunk(0.2), 0.1);
    expect(out!.opened).toBe(true);
    expect(out!.send.length).toBe(REPLAY_MS / 100);
    expect(out!.send.at(-1)![0]).toBeCloseTo(-0.2);
    // Then everything, until the narrator is quiet.
    const next = chunk(0.01);
    expect(g.push(next, 0.1)).toEqual({ send: [next], opened: false });
  });

  it("a short loud burst (a cough, a click) over it does not go out", () => {
    const g = new EchoGate(RATE);
    const r1 = g.push(chunk(0.3), 0.1);
    const r2 = g.push(chunk(0.01), 0.1);
    expect([r1.opened, r2.opened, silent([...r1.send, ...r2.send])]).toEqual([false, false, true]);
  });

  it("learns the echo it hears: in a room that echoes more, its louder syllables still do not count as the user", () => {
    const g = new EchoGate(RATE);
    // Echo at 0.25 of what plays (under the first guess's margin, INITIAL_COUPLING * 3): learned as it plays.
    expect(0.25).toBeLessThan(INITIAL_COUPLING * 3);
    for (let i = 0; i < 20; i++) g.push(chunk(0.1 * 0.25), 0.1);
    // Then syllables at 0.5 of it, over the first guess's margin but not over the learned one's.
    let opened = false;
    for (let i = 0; i < 10; i++) opened ||= g.push(chunk(0.1 * 0.5), 0.1).opened;
    expect(opened).toBe(false);
  });

  it("the narrator's pauses between sentences keep it closed (its echo trails off)", () => {
    const g = new EchoGate(RATE);
    g.push(chunk(0.01), 0.1);
    const r = g.push(chunk(0.02), 0);
    expect(silent(r.send)).toBe(true);
  });
});
