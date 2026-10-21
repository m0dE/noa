import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { LIST_NEWEST_FILES, LOCAL_SEARCH_MAX } from "@noa/shared";
import { NoaFiles, NoaFolder, README_TEXT } from "../src/engine/noa-folder.js";

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});

describe("NoaFolder", () => {
  it("writes the README into Downloads/Noa once and shows it in the file manager, with the download UI off", async () => {
    const folder = new NoaFolder();
    expect(await folder.open()).toBe("C:\\Users\\me\\Downloads\\Noa");
    expect(chrome.downloads.items).toHaveLength(1);
    const [readme] = chrome.downloads.items;
    expect(readme!.filename).toBe("C:\\Users\\me\\Downloads\\Noa\\README.txt");
    expect(decodeURIComponent(readme!.url.replace(/^data:text\/plain;charset=utf-8,/, ""))).toBe(README_TEXT);
    expect(chrome.downloads.shown).toEqual([readme!.id]);
    expect(chrome.downloads.uiCalls).toEqual([false, true]);

    // Again: the same README, not a second one.
    await folder.open();
    expect(chrome.downloads.items).toHaveLength(1);
    expect(chrome.downloads.shown).toEqual([readme!.id, readme!.id]);
  });

  it("writes the README again when the file was deleted or the download history cleared", async () => {
    const folder = new NoaFolder();
    await folder.open();
    chrome.downloads.items[0]!.removed = true;
    await folder.open();
    expect(chrome.downloads.items).toHaveLength(2);
    chrome.downloads.items[1]!.erased = true;
    await folder.open();
    expect(chrome.downloads.items).toHaveLength(3);
    expect(chrome.downloads.shown).toEqual([1, 2, 3]);
  });

  it("says why when the folder cannot be written", async () => {
    chrome.downloads.behavior = () => "interrupted";
    await expect(new NoaFolder().open()).rejects.toThrow(/Could not create the Noa folder in Downloads: .*SERVER_FORBIDDEN/);
    expect(chrome.downloads.shown).toEqual([]);
    expect(chrome.downloads.uiEnabled).toBe(true);
  });
});

describe("NoaFiles", () => {
  const folder = { path: async () => "C:\\Users\\me\\Downloads\\Noa" };

  it("asks the helper to list the folder from disk: the newest page of it, or all of it ranked for a search", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const asked: unknown[] = [];
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `${dir}\\f${i}.txt`,
      name: `f${i}.txt`,
      size: 1,
      modified: new Date(Date.UTC(2026, 9, 1) - i * 3_600_000).toISOString(),
    }));
    files[35] = { ...files[35]!, path: `${dir}\\Resume 2026.pdf`, name: "Resume 2026.pdf" };
    const listing = { folder: dir, files, total: 40 };
    const noa = new NoaFiles({ folder, helperList: async (p) => (asked.push(p), structuredClone(listing)), downloads: { search: async () => [] } });
    const page = await noa.list({});
    expect(page.files.map((f) => f.name)).toEqual(files.slice(0, LIST_NEWEST_FILES).map((f) => f.name));
    expect(page.total).toBe(40);
    const found = await noa.list({ search: " resume " });
    expect(found.files.map((f) => f.name)).toEqual(["Resume 2026.pdf"]);
    expect(found).toMatchObject({ total: 1, searched: { meaning: false } });
    expect(asked).toEqual([{ folder: dir }, { folder: dir, max: LOCAL_SEARCH_MAX }]);
  });

  it("a search fuses the account's meaning scores with words, for local and cloud files; the cloud list is reused until it changes", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const cloudFile = (id: string, name: string, about: string, createdAt: string) => ({ id, name, folder: "", contentType: "image/png", size: 10, createdAt, meta: { about } });
    let lists = 0;
    const searched: string[] = [];
    const noa = new NoaFiles({
      folder: { path: async () => dir },
      helperList: async () => ({ folder: dir, files: [{ path: `${dir}\\IMG_1.png`, name: "IMG_1.png", size: 1, modified: "2026-10-01T00:00:00.000Z" }], total: 1 }),
      downloads: { search: async () => [] },
      cloud: {
        list: async () => (lists++, { files: [cloudFile("c1", "IMG_7.png", "stoneware mug, front", "2026-09-01T00:00:00.000Z"), cloudFile("c2", "IMG_8.png", "walnut desk lamp", "2026-09-02T00:00:00.000Z")], usedBytes: 20, quotaBytes: 100, locked: false }),
        download: async () => "unused",
        search: async (q) => (searched.push(q), { model: "m", hits: [{ id: "c1", score: 0.71 }, { id: "c2", score: 0.41 }], pending: 2 }),
      },
    });
    const r = await noa.list({ search: "a coffee cup" });
    // "coffee cup" shares no word with any file: the meaning search alone finds the mug, not the lamp (0.41 < 0.5).
    expect(r.files.map((f) => f.name)).toEqual(["IMG_7.png"]);
    expect(r).toMatchObject({ total: 1, searched: { meaning: true, pending: 2 } });
    expect(searched).toEqual(["a coffee cup"]);
    await noa.list({});
    expect(lists).toBe(1);
    noa.cloudChanged();
    await noa.list({});
    expect(lists).toBe(2);
  });

  it("without the helper, lists the files Chrome saved in the folder that are still there, once each, and says it is partial", async () => {
    const logs: string[] = [];
    const items = [
      { id: 1, filename: "C:\\Users\\me\\Downloads\\Noa\\README.txt", state: "complete", exists: true, fileSize: 80, endTime: "2026-10-01T00:00:00.000Z" },
      { id: 2, filename: "C:\\Users\\me\\Downloads\\Noa\\images\\logo.png", state: "complete", exists: true, fileSize: 900, endTime: "2026-10-02T00:00:00.000Z" },
      { id: 3, filename: "C:\\Users\\me\\Downloads\\Noa\\images\\logo.png", state: "complete", exists: true, fileSize: 900, endTime: "2026-09-02T00:00:00.000Z" },
      { id: 4, filename: "C:\\Users\\me\\Downloads\\Noa\\gone.pdf", state: "complete", exists: false },
      { id: 5, filename: "C:\\Users\\me\\Downloads\\other.pdf", state: "complete", exists: true },
      { id: 6, filename: "C:\\Users\\me\\Downloads\\Noa\\Resume.pdf", state: "complete", exists: true, fileSize: 4000, endTime: "2026-09-20T00:00:00.000Z" },
    ];
    const files = new NoaFiles({
      folder,
      helperList: async () => {
        throw new Error("Helper not installed");
      },
      downloads: { search: async () => items },
      log: (m) => logs.push(m),
    });
    expect(await files.list({})).toEqual({
      folder: "C:\\Users\\me\\Downloads\\Noa",
      files: [
        { path: items[1]!.filename, name: "images/logo.png", size: 900, modified: "2026-10-02T00:00:00.000Z" },
        { path: items[5]!.filename, name: "Resume.pdf", size: 4000, modified: "2026-09-20T00:00:00.000Z" },
      ],
      total: 2,
      partial: true,
    });
    expect((await files.list({ search: "RES" })).files.map((f) => f.name)).toEqual(["Resume.pdf"]);
    expect(logs[0]).toMatch(/Helper not installed/);
  });

  it("signed in, lists the cloud files that are not here, and downloads one into the folder when it is uploaded", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const here = { path: `${dir}\\Resume.pdf`, name: "Resume.pdf", size: 10, modified: "2026-09-01T00:00:00.000Z" };
    const cloud = [
      { id: "c1", name: "resume.pdf", folder: "" as const, contentType: "application/pdf", size: 10, createdAt: "2026-09-02T00:00:00.000Z" },
      { id: "c2", name: "banner.png", folder: "images" as const, contentType: "image/png", size: 2048, createdAt: "2026-09-30T00:00:00.000Z" },
      { id: "c3", name: "notes.txt", folder: "" as const, contentType: "text/plain", size: 5, createdAt: "2026-08-01T00:00:00.000Z" },
    ];
    const downloads: [string, string][] = [];
    const files = new NoaFiles({
      folder,
      helperList: async (p) => ({ folder: dir, files: p.search ? [] : [here], total: p.search ? 0 : 1 }),
      cloud: {
        list: async () => ({ files: cloud, usedBytes: 0, quotaBytes: 1, locked: false }),
        download: async (f, path) => (downloads.push([f.id, path]), path.replace("banner", "banner (1)")),
      },
    });
    const r = await files.list({});
    // resume.pdf is here already: listed once, as the file here.
    expect(r.files.map((f) => [f.name, !!f.cloud])).toEqual([["images/banner.png", true], ["Resume.pdf", false], ["notes.txt", true]]);
    expect(r.files[0]).toMatchObject({ path: `${dir}\\images\\banner.png`, size: 2048, modified: "2026-09-30T00:00:00.000Z" });
    expect(r.total).toBe(3);
    expect((await files.list({ search: "NOTES" })).files.map((f) => f.name)).toEqual(["notes.txt"]);

    const banner = r.files[0]!.path;
    expect(await files.fetch([here.path, banner])).toEqual([here.path, `${dir}\\images\\banner (1).png`]);
    // Once: a second upload of it uses the copy already saved.
    expect(await files.fetch([banner])).toEqual([`${dir}\\images\\banner (1).png`]);
    expect(downloads).toEqual([["c2", banner]]);
  });

  it("lists the folder alone when the cloud files cannot be loaded, and says why a download failed", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const logs: string[] = [];
    let fail = true;
    const files = new NoaFiles({
      folder,
      helperList: async () => ({ folder: dir, files: [], total: 0 }),
      cloud: {
        list: async () => {
          if (fail) throw new Error("offline");
          return { files: [{ id: "c1", name: "a.pdf", folder: "", contentType: "application/pdf", size: 1, createdAt: "2026-09-02T00:00:00.000Z" }], usedBytes: 0, quotaBytes: 1, locked: true };
        },
        download: async () => {
          throw new Error("403");
        },
      },
      log: (m) => logs.push(m),
    });
    expect(await files.list({})).toEqual({ folder: dir, files: [], total: 0 });
    expect(logs).toEqual(["list_files without the cloud files: offline"]);
    fail = false;
    const [a] = (await files.list({})).files;
    await expect(files.fetch([a!.path])).rejects.toThrow("Could not download a.pdf from the user's cloud files: 403");
  });

  it("adds what is known about each file: where Chrome downloaded it from (not Noa's own downloads) and the cloud copy's notes", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const listing = {
      folder: dir,
      files: [
        { path: `${dir}\\IMG_1.png`, name: "IMG_1.png", size: 10, modified: "2026-10-03T00:00:00.000Z", meta: { width: 800, height: 600 } },
        { path: `${dir}\\products\\lamp.png`, name: "products/lamp.png", size: 10, modified: "2026-10-02T00:00:00.000Z" },
        { path: `${dir}\\cloud-copy.png`, name: "cloud-copy.png", size: 10, modified: "2026-10-01T00:00:00.000Z" },
      ],
      total: 3,
    };
    const downloads = [
      { id: 1, filename: `${dir}\\IMG_1.png`, state: "complete", url: "https://cdn.test/a.png", referrer: "https://shop.test/item" },
      { id: 2, filename: `${dir}\\cloud-copy.png`, state: "complete", url: "https://api.noa.test/v1/files/f1", byExtensionId: "noa-id" },
    ];
    const cloudFile = (id: string, name: string, folder: string, meta?: object) => ({ id, name, folder, contentType: "image/png", size: 10, createdAt: "2026-09-01T00:00:00.000Z", ...(meta ? { meta } : {}) });
    const files = new NoaFiles({
      folder: { path: async () => dir },
      helperList: async () => structuredClone(listing),
      downloads: { search: async () => downloads },
      cloud: {
        list: async () => ({
          files: [cloudFile("c1", "lamp.png", "products", { width: 1200, height: 900, about: "The lamp" }), cloudFile("c2", "mug.png", "", { about: "A mug" })],
          usedBytes: 20,
          quotaBytes: 100,
          locked: false,
        }),
        download: async () => "unused",
      },
    });
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: "noa-id" } };
    try {
      const r = await files.list({});
      expect(r.files.map((f) => [f.name, f.meta])).toEqual([
        ["IMG_1.png", { source: "https://cdn.test/a.png", page: "https://shop.test/item", width: 800, height: 600 }],
        ["products/lamp.png", { width: 1200, height: 900, about: "The lamp" }],
        ["cloud-copy.png", undefined],
        ["mug.png", { about: "A mug" }],
      ]);
    } finally {
      delete (globalThis as { chrome?: unknown }).chrome;
    }
  });

  it("view_file: reads the picture (a cloud one downloaded first) and shows it smaller; says when it is not a picture", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const read: string[] = [];
    const files = new NoaFiles({
      folder: { path: async () => dir },
      helperList: async () => ({ folder: dir, files: [], total: 0 }),
      downloads: { search: async () => [] },
      cloud: {
        list: async () => ({ files: [{ id: "c1", name: "mug.png", folder: "", contentType: "image/png", size: 4, createdAt: "2026-09-01T00:00:00.000Z" }], usedBytes: 4, quotaBytes: 100, locked: false }),
        download: async () => `${dir}\\mug (1).png`,
      },
      read: async (p) => (read.push(p), new Blob([p.endsWith(".png") ? "png!" : "text"])),
      shrink: async (b) => ((await b.text()) === "png!" ? { base64: "AAAA", mimeType: "image/jpeg", width: 1600, height: 1200 } : Promise.reject(new Error("decode"))),
    });
    await files.list({});
    expect(await files.view({ path: `${dir}\\mug.png` })).toEqual({ image: { base64: "AAAA", mimeType: "image/jpeg" }, width: 1600, height: 1200, size: 4 });
    expect(read).toEqual([`${dir}\\mug (1).png`]);
    await expect(files.view({ path: `${dir}\\notes.txt` })).rejects.toThrow("is not a picture that can be shown");
    await expect(new NoaFiles({ folder: { path: async () => dir }, helperList: async () => ({ folder: dir, files: [], total: 0 }) }).view({ path: "x" })).rejects.toThrow("helper");
  });

  it("a search that finds a cloud file the reused listing lacks (stored elsewhere just now) reads the listing again", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const stored = [{ id: "old", name: "a.png", folder: "", contentType: "image/png", size: 1, createdAt: "2026-10-01T00:00:00.000Z" }];
    let lists = 0;
    const noa = new NoaFiles({
      folder: { path: async () => dir },
      helperList: async () => ({ folder: dir, files: [], total: 0 }),
      downloads: { search: async () => [] },
      cloud: {
        list: async () => (lists++, { files: structuredClone(stored), usedBytes: 1, quotaBytes: 100, locked: false }),
        download: async () => "unused",
        search: async () => ({ model: "m", hits: [{ id: "new", score: 0.8 }], pending: 0 }),
      },
    });
    await noa.list({});
    stored.push({ id: "new", name: "IMG_9.png", folder: "", contentType: "image/png", size: 1, createdAt: "2026-10-20T00:00:00.000Z", meta: { about: "teapot" } } as never);
    const r = await noa.list({ search: "something to brew tea in" });
    expect(r.files.map((f) => f.name)).toEqual(["IMG_9.png"]);
    expect(lists).toBe(2);
  });

  it("adopt: a file just stored in the cloud only gets its path in the folder, and upload downloads it there first", async () => {
    const dir = "C:\\Users\\me\\Downloads\\Noa";
    const downloaded: string[] = [];
    const noa = new NoaFiles({
      folder: { path: async () => dir },
      helperList: async () => ({ folder: dir, files: [], total: 0 }),
      cloud: { list: async () => null, download: async (f, p) => (downloaded.push(f.id), p) },
    });
    const path = await noa.adopt({ id: "c9", name: "INV-2207.pdf", folder: "invoices", contentType: "application/pdf", size: 9, createdAt: "2026-10-20T00:00:00.000Z" });
    expect(path).toBe(`${dir}\\invoices\\INV-2207.pdf`);
    expect(await noa.fetch([path])).toEqual([path]);
    expect(downloaded).toEqual(["c9"]);
  });

  it("finds the folder without opening the file manager", async () => {
    expect(await new NoaFolder().path()).toBe("C:\\Users\\me\\Downloads\\Noa");
    expect(chrome.downloads.shown).toEqual([]);
  });
});
