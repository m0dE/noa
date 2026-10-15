import { describe, expect, it } from "vitest";
import { micError } from "../../src/voice/mic-errors.js";

const dom = (message: string, name: string) => new DOMException(message, name);

describe("micError: getUserMedia's failures in plain words, with what to do", () => {
  it("names the microphone and the fix for each kind", () => {
    expect(micError(dom("Requested device not found", "NotFoundError"))).toMatchObject({ kind: "no-mic", detail: "NotFoundError: Requested device not found" });
    expect(micError(dom("Constraints could not be satisfied", "OverconstrainedError")).kind).toBe("no-mic");
    expect(micError(dom("Permission denied", "NotAllowedError")).message).toMatch(/^Chrome is blocking the microphone for Noa\. .*set Microphone to Allow/);
    expect(micError(dom("Permission denied by system", "NotAllowedError")).message).toMatch(/^Your computer is not letting Chrome use the microphone/);
    expect(micError(dom("Could not start audio source", "NotReadableError")).message).toMatch(/another app may be using it/);
    expect(micError(new Error("odd")).message).toBe("The microphone could not open. Try again.");
  });
  it("every message says it is the microphone, never Chrome's words", () => {
    for (const name of ["NotFoundError", "NotAllowedError", "NotReadableError", "AbortError", "TypeError"]) {
      const e = micError(dom("Requested device not found", name));
      expect(e.message).toMatch(/microphone/i);
      expect(e.message).not.toContain("Requested device");
    }
  });
});
