import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionSettings, GenerateImageRequest, GenerateImageResponse } from "@noa/shared";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { imageFileBase, ImageGenerator, IMAGES_OFF, NOT_ON_SERVER, NOT_SIGNED_IN } from "../src/engine/image-generator.js";
import { ApiRequestError, NotSignedInError } from "../src/http-client.js";

const PNG_B64 = "iVBORw0KGgo=";
const PREVIEW = { base64: "/9j/preview", mimeType: "image/jpeg" };

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});

function generator(
  answer: (req: GenerateImageRequest) => GenerateImageResponse | Promise<GenerateImageResponse>,
  settings: Pick<ExtensionSettings, "imageGeneration" | "imageModel"> = { imageGeneration: true, imageModel: "gpt-image-2" },
) {
  const sent: { req: GenerateImageRequest; opts: { sessionId?: string } }[] = [];
  const g = new ImageGenerator({
    settings: async () => settings,
    generate: async (req, opts) => {
      sent.push({ req, opts });
      return answer(req);
    },
    preview: async () => PREVIEW,
  });
  return { g, sent };
}

const made = (req: GenerateImageRequest): GenerateImageResponse => ({
  base64: PNG_B64,
  mimeType: "image/png",
  size: req.size ?? "1024x1024",
  quality: req.quality ?? "medium",
  model: req.model ?? "gpt-image-2",
  chargedCents: 6.86,
});

describe("imageFileBase", () => {
  it("names the file after the name given, else the description's first words", () => {
    expect(imageFileBase("Store Icon.png", "whatever")).toBe("store-icon");
    expect(imageFileBase(undefined, "A flat app icon: a friendly, rounded letter N on a violet gradient")).toBe("a-flat-app-icon-a-friendly-rounded-letter-n-on-a-violet");
    expect(imageFileBase("  ", "Café au lait ☕")).toBe("café-au-lait");
    expect(imageFileBase(undefined, "!!!")).toBe("image");
  });
});

describe("ImageGenerator", () => {
  it("saves the picture in Downloads/Noa/images with the download UI off, and answers its path and preview", async () => {
    const { g, sent } = generator(made);
    const r = await g.generate({ prompt: "A violet icon", name: "store-icon", size: "1536x1024", quality: "high", transparent: true }, "s1");
    expect(sent).toEqual([{ req: { prompt: "A violet icon", model: "gpt-image-2", size: "1536x1024", quality: "high", transparent: true }, opts: { sessionId: "s1" } }]);
    expect(r).toEqual({ path: "C:\\Users\\me\\Downloads\\Noa\\images\\store-icon.png", preview: PREVIEW, size: "1536x1024", quality: "high", chargedCents: 6.86 });
    const [file] = chrome.downloads.items;
    expect(file!.url).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(chrome.downloads.uiCalls).toEqual([false, true]);
    // The file is the user's: it stays.
    expect(file!.removed).toBe(false);
  });

  it("uses the model picked in Settings, and makes nothing when image generation is off", async () => {
    const mini = generator(made, { imageGeneration: true, imageModel: "gpt-image-1-mini" });
    await mini.g.generate({ prompt: "a cat" }, null);
    expect(mini.sent[0]!.req.model).toBe("gpt-image-1-mini");

    const off = generator(made, { imageGeneration: false, imageModel: "gpt-image-2" });
    await expect(off.g.generate({ prompt: "a cat" }, "s1")).rejects.toThrow(IMAGES_OFF);
    expect(off.sent).toHaveLength(0);
    expect(chrome.downloads.items).toHaveLength(1);
  });

  it("says what the user must do when signed out, and when the server has no image generation", async () => {
    await expect(generator(() => Promise.reject(new NotSignedInError())).g.generate({ prompt: "a cat" }, null)).rejects.toThrow(NOT_SIGNED_IN);
    await expect(generator(() => Promise.reject(new ApiRequestError(404, "404 Not Found"))).g.generate({ prompt: "a cat" }, null)).rejects.toThrow(NOT_ON_SERVER);
    const credit = new ApiRequestError(402, "You are out of Noa usage credit. Buy a top-up or upgrade your plan to continue.");
    await expect(generator(() => Promise.reject(credit)).g.generate({ prompt: "a cat" }, null)).rejects.toThrow(/out of Noa usage credit/);
    expect(chrome.downloads.items).toHaveLength(0);
  });

  it("copies the saved picture to the account's cloud images under its saved name; a failed copy only logs", async () => {
    const kept: { name: string; folder: string; type: string; bytes: number }[] = [];
    const errors: unknown[] = [];
    let fail = false;
    const g = new ImageGenerator({
      settings: async () => ({ imageGeneration: true, imageModel: "gpt-image-2" }),
      generate: async (req) => made(req),
      preview: async () => PREVIEW,
      keepInCloud: async (png, name, folder) => {
        if (fail) throw new ApiRequestError(413, "Your cloud files are full");
        kept.push({ name, folder, type: png.type, bytes: png.size });
        return true;
      },
      onCloudError: (err) => errors.push(err),
    });
    const r = await g.generate({ prompt: "a cat", name: "cat" }, null);
    await Promise.resolve();
    expect(kept).toEqual([{ name: "cat.png", folder: "images", type: "image/png", bytes: 8 }]);
    expect(r.path).toMatch(/cat\.png$/);

    fail = true;
    const again = await g.generate({ prompt: "a cat", name: "cat" }, null);
    expect(again.path).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
  });
});
