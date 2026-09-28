import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { safeFileName, uniqueNames } from "@noa/shared";
import { MediaFiles } from "../src/engine/media-files.js";

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});

describe("file names", () => {
  it("strips path parts and characters Windows rejects, adds an extension from the type", () => {
    expect(safeFileName("C:\\evil\\..\\a:b?.png")).toBe("a_b_.png");
    expect(safeFileName("../../x.jpg")).toBe("x.jpg");
    expect(safeFileName("photo", "image/jpeg")).toBe("photo.jpg");
    expect(safeFileName("", "video/mp4")).toBe("file.mp4");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName(`${"a".repeat(300)}.png`)).toHaveLength(120);
  });

  it("makes names unique within one batch", () => {
    expect(uniqueNames(["a.png", "A.png", "a.png", "b"])).toEqual(["a.png", "A-2.png", "a-3.png", "b"]);
  });
});

describe("MediaFiles", () => {
  it("writes blobs as data: URL downloads and returns absolute paths, with the download UI off", async () => {
    const media = new MediaFiles();
    const out = await media.materialize("s1", [
      { kind: "blob", name: "pic.png", blob: new Blob(["PNG"], { type: "image/png" }) },
      { kind: "blob", name: "pic.png", blob: new Blob(["PNG2"], { type: "image/png" }) },
    ]);
    expect(out.paths).toEqual([
      "C:\\Users\\me\\Downloads\\noa-media\\s1\\pic.png",
      "C:\\Users\\me\\Downloads\\noa-media\\s1\\pic-2.png",
    ]);
    const [d1] = chrome.downloads.items;
    expect(d1!.url).toBe(`data:image/png;base64,${btoa("PNG")}`);
    expect(chrome.downloads.uiCalls).toEqual([false, true]);
    expect(chrome.downloads.uiEnabled).toBe(true);

    await out.cleanup();
    expect(chrome.downloads.items.every((d) => d.removed && d.erased)).toBe(true);
  });

  it("downloads cloud media from the URL with the Authorization header", async () => {
    const media = new MediaFiles();
    const headers = [{ name: "Authorization", value: "Bearer bt_k" }];
    const out = await media.materialize("s2", [{ kind: "url", name: "clip.mp4", url: "https://api.test/v1/media/m1", headers }]);
    expect(out.paths).toEqual(["C:\\Users\\me\\Downloads\\noa-media\\s2\\clip.mp4"]);
    expect(chrome.downloads.items[0]).toMatchObject({ url: "https://api.test/v1/media/m1", headers });
  });

  it("falls back to fetch + data: URL when the download manager fails", async () => {
    chrome.downloads.behavior = (d) => (d.url.startsWith("https:") ? "interrupted" : "complete");
    const fetchFn = vi.fn(async () => new Response(new Blob(["VID"], { type: "video/mp4" }))) as unknown as typeof fetch;
    const media = new MediaFiles({ fetch: fetchFn });
    const out = await media.materialize("s3", [{ kind: "url", name: "clip.mp4", url: "https://api.test/v1/media/m1", headers: [{ name: "Authorization", value: "Bearer k" }] }]);
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/v1/media/m1", { headers: { Authorization: "Bearer k" } });
    expect(out.paths).toHaveLength(1);
    expect(chrome.downloads.items[1]!.url).toMatch(/^data:video\/mp4;base64,/);
  });

  it("cleans up what it wrote and re-enables the UI when a write fails", async () => {
    chrome.downloads.behavior = (d) => (d.id === 2 ? "interrupted" : "complete");
    const media = new MediaFiles();
    await expect(
      media.materialize("s4", [
        { kind: "blob", name: "a.png", blob: new Blob(["a"]) },
        { kind: "blob", name: "b.png", blob: new Blob(["b"]) },
      ]),
    ).rejects.toThrow(/failed/);
    expect(chrome.downloads.items[0]).toMatchObject({ removed: true, erased: true });
    expect(chrome.downloads.uiEnabled).toBe(true);
  });

  it("times out a download that never finishes", async () => {
    chrome.downloads.behavior = () => "hang";
    const media = new MediaFiles({ timeoutMs: 50 });
    await expect(media.materialize("s5", [{ kind: "blob", name: "a.png", blob: new Blob(["a"]) }])).rejects.toThrow(/timed out/);
  });

  it("no media: no downloads, no UI toggling", async () => {
    const out = await new MediaFiles().materialize("s6", []);
    expect(out.paths).toEqual([]);
    expect(chrome.downloads.uiCalls).toEqual([]);
  });
});
