import { describe, expect, it } from "vitest";
import { scaledSize, SCREENSHOT_MAX_WIDTH, shrinkScreenshot } from "../src/screenshot-size.js";

describe("screenshot size", () => {
  it("scales wider screenshots to SCREENSHOT_MAX_WIDTH, keeping the aspect ratio", () => {
    expect(SCREENSHOT_MAX_WIDTH).toBe(1280);
    expect(scaledSize(2560, 1600)).toEqual({ width: 1280, height: 800 });
    expect(scaledSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(scaledSize(1280, 720)).toBeNull();
    expect(scaledSize(800, 600)).toBeNull();
  });

  it("leaves the screenshot as it is where it cannot be decoded", async () => {
    const shot = { base64: "Q0RQ", mimeType: "image/jpeg" as const };
    expect(await shrinkScreenshot(shot)).toBe(shot);
  });
});
