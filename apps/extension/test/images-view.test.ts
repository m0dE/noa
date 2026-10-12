import { describe, expect, it } from "vitest";
import { imagesView } from "../src/options/images-view.js";
import type { AccountView } from "../src/ui-protocol.js";

const signedIn = { signedIn: true } as AccountView;

describe("imagesView", () => {
  it("lists the models, with what the picked one is for", () => {
    const v = imagesView({ settings: { imageGeneration: true, imageModel: "gpt-image-1-mini" }, account: signedIn });
    expect(v).toMatchObject({ on: true, model: "gpt-image-1-mini", note: null });
    expect(v.options.map((o) => o.label)).toEqual(["GPT Image 2", "GPT Image 1 Mini"]);
    expect(v.modelHint).toMatch(/2 cents/);
  });

  it("says to sign in while it is on and nobody is signed in; nothing while it is off", () => {
    expect(imagesView({ settings: { imageGeneration: true, imageModel: "gpt-image-2" }, account: undefined }).note).toMatch(/Sign in/);
    expect(imagesView({ settings: { imageGeneration: false, imageModel: "gpt-image-2" }, account: undefined })).toMatchObject({ on: false, note: null });
  });
});
