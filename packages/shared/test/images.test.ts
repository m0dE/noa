import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, GenerateImageRequest, parseSettings, toolsFor } from "../src/index.js";

describe("image generation settings", () => {
  it("is on with GPT Image 2 by default; an unknown model falls back to it", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ imageGeneration: true, imageModel: "gpt-image-2" });
    expect(parseSettings({ imageGeneration: false, imageModel: "dall-e-3" })).toMatchObject({ imageGeneration: false, imageModel: "gpt-image-2" });
  });

  it("offers generate_image unless it is turned off", () => {
    expect(toolsFor()).toContain("generate_image");
    expect(toolsFor({ images: true })).toContain("generate_image");
    expect(toolsFor({ images: false })).not.toContain("generate_image");
    expect(toolsFor({ images: false })).toContain("upload");
  });

  it("takes only the models the server prices", () => {
    expect(GenerateImageRequest.safeParse({ prompt: "a cat", model: "gpt-image-1-mini" }).success).toBe(true);
    expect(GenerateImageRequest.safeParse({ prompt: "a cat", model: "dall-e-3" }).success).toBe(false);
  });
});
