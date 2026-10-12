import { describe, expect, it } from "vitest";
import { ENDPOINTING, Endpointer, utteranceEnd } from "../../src/voice/endpointing.js";

const FRAME = 20;
/** "s" = a speech frame, "." = a quiet one, each `ms` long. */
const frames = (...parts: [string, number][]) => parts.flatMap(([c, ms]) => Array.from({ length: Math.round(ms / FRAME) }, () => c === "s"));

describe("utteranceEnd", () => {
  it("ends an utterance after ENDPOINTING.endPauseMs of quiet following enough speech", () => {
    const f = frames([".", 400], ["s", 900], [".", ENDPOINTING.endPauseMs + 200]);
    const at = utteranceEnd(f, FRAME);
    // The frame on which the pause reached endPauseMs.
    expect(at).toBe(Math.round((400 + 900 + ENDPOINTING.endPauseMs) / FRAME));
  });

  it("a short pause between words does not end it", () => {
    expect(utteranceEnd(frames(["s", 600], [".", ENDPOINTING.endPauseMs - 100], ["s", 400]), FRAME)).toBeNull();
    const f = frames(["s", 600], [".", 300], ["s", 400], [".", ENDPOINTING.endPauseMs]);
    expect(utteranceEnd(f, FRAME)).toBe(f.length);
  });

  it("a click or cough shorter than ENDPOINTING.minSpeechMs is not an utterance", () => {
    expect(utteranceEnd(frames([".", 200], ["s", ENDPOINTING.minSpeechMs - 60], [".", 3000]), FRAME)).toBeNull();
  });

  it("nothing but quiet has no end", () => {
    expect(utteranceEnd(frames([".", 5000]), FRAME)).toBeNull();
    expect(utteranceEnd([], FRAME)).toBeNull();
  });

  it("takes other settings", () => {
    const f = frames(["s", 300], [".", 400]);
    expect(utteranceEnd(f, FRAME, { endPauseMs: 400, minSpeechMs: 300 })).toBe(f.length);
    expect(utteranceEnd(f, FRAME, { endPauseMs: 420, minSpeechMs: 300 })).toBeNull();
  });
});

describe("Endpointer: utteranceEnd over a stream of frames", () => {
  it("says when speech starts, how long it has lasted, and when the utterance ends; then starts over", () => {
    const e = new Endpointer(FRAME);
    const signals: string[] = [];
    const run = (f: boolean[]) => {
      for (const s of f) {
        const sig = e.push(s);
        if (sig) signals.push(sig);
      }
    };
    run(frames([".", 200], ["s", 500]));
    expect(signals).toEqual(["start"]);
    expect(e.speechMs).toBe(500);
    run(frames([".", ENDPOINTING.endPauseMs]));
    expect(signals).toEqual(["start", "end"]);
    expect(e.speechMs).toBe(0);
    run(frames(["s", 300], [".", ENDPOINTING.endPauseMs]));
    expect(signals).toEqual(["start", "end", "start", "end"]);
  });

  it("a blip that never reaches minSpeechMs starts nothing and ends nothing", () => {
    const e = new Endpointer(FRAME);
    const signals = frames(["s", 60], [".", 3000]).map((s) => e.push(s)).filter(Boolean);
    expect(signals).toEqual([]);
  });

  it("reset drops the utterance in progress", () => {
    const e = new Endpointer(FRAME);
    frames(["s", 400]).forEach((s) => e.push(s));
    e.reset();
    expect(frames([".", ENDPOINTING.endPauseMs]).map((s) => e.push(s)).filter(Boolean)).toEqual([]);
  });
});
