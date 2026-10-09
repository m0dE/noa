import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
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

  it("asks the helper to list the folder from disk", async () => {
    const asked: unknown[] = [];
    const listing = { folder: "C:\\Users\\me\\Downloads\\Noa", files: [], total: 0 };
    const files = new NoaFiles({ folder, helperList: async (p) => (asked.push(p), listing) });
    expect(await files.list({ search: " resume " })).toBe(listing);
    expect(asked).toEqual([{ folder: "C:\\Users\\me\\Downloads\\Noa", search: "resume" }]);
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

  it("finds the folder without opening the file manager", async () => {
    expect(await new NoaFolder().path()).toBe("C:\\Users\\me\\Downloads\\Noa");
    expect(chrome.downloads.shown).toEqual([]);
  });
});
