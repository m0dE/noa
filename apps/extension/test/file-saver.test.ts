import { describe, expect, it } from "vitest";
import { SAVE_FILE_MAX_BYTES, type CloudFile } from "@noa/shared";
import { FileSaver, lastDownloadFinder, savedName, type FileSaverDeps, type SaverDownloadsLike } from "../src/engine/file-saver.js";

const NOA = "C:\\Users\\me\\Downloads\\Noa";

/** The cloud's answer for a stored file. */
const stored = (name: string, folder: string): CloudFile => ({ id: `c-${name}`, name, folder, contentType: "", size: 1, createdAt: "2026-10-20T00:00:00.000Z" });

function saver(over: Partial<FileSaverDeps> = {}) {
  const written: { rel: string; text: string; type: string }[] = [];
  const cloud: { name: string; folder: string; type: string }[] = [];
  const deps: FileSaverDeps = {
    fetch: async () => new Response(new Blob(["%PDF-1.4"], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf" } }),
    writeLocal: async (rel, blob) => {
      written.push({ rel, text: await blob.text(), type: blob.type });
      return `C:\\Users\\me\\Downloads\\${rel.replace(/\//g, "\\")}`;
    },
    cloud: async (blob, name, folder) => (cloud.push({ name, folder, type: blob.type }), { saved: true, file: stored(name, folder) }),
    folder: async () => NOA,
    ...over,
  };
  return { s: new FileSaver(deps), written, cloud };
}

describe("FileSaver", () => {
  it("saves a link's file in the Noa folder and the cloud, in the folder asked for", async () => {
    const { s, written, cloud } = saver();
    const r = await s.save({ url: "https://console.neon.tech/api/invoices/NEON-2026-09.pdf", folder: "Invoices/2026" }, {});
    expect(r).toEqual({
      path: `${NOA}\\Invoices 2026\\NEON-2026-09.pdf`,
      local: true,
      name: "NEON-2026-09.pdf",
      folder: "Invoices 2026",
      size: 8,
      contentType: "application/pdf",
      cloud: "saved",
      meta: { source: "https://console.neon.tech/api/invoices/NEON-2026-09.pdf" },
    });
    expect(written).toEqual([{ rel: "Noa/Invoices 2026/NEON-2026-09.pdf", text: "%PDF-1.4", type: "application/pdf" }]);
    expect(cloud).toEqual([{ name: "NEON-2026-09.pdf", folder: "Invoices 2026", type: "application/pdf" }]);
  });

  it("keeps what is known with both copies: the picture's size, its address, the open page and the note", async () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x20, 0, 0, 2, 0x58]);
    const notes: { path: string; meta: unknown }[] = [];
    const metas: unknown[] = [];
    const { s } = saver({
      fetch: async () => new Response(new Blob([png], { type: "image/png" }), { headers: { "Content-Type": "image/png" } }),
      cloud: async (_b, n, f, meta) => (metas.push(meta), { saved: true, file: stored(n, f) }),
      note: async (path, meta) => void notes.push({ path, meta }),
    });
    const page = async () => ({ url: "https://shop.test/lamp", title: "Lamp – Shop" });
    const r = await s.save({ url: "https://shop.test/cdn/7f3a.png", name: "lamp.png", folder: "products", about: "The lamp from the front" }, { page });
    const meta = { width: 800, height: 600, source: "https://shop.test/cdn/7f3a.png", page: "https://shop.test/lamp", pageTitle: "Lamp – Shop", about: "The lamp from the front" };
    expect(r.meta).toEqual(meta);
    expect(notes).toEqual([{ path: `${NOA}\\products\\lamp.png`, meta }]);
    expect(metas).toEqual([meta]);
    // A file from this computer was not found on the open page; a failing note never fails the save.
    const { s: s2 } = saver({ readLocal: async () => new Blob(["x"], { type: "text/plain" }), note: async () => Promise.reject(new Error("old helper")) });
    expect((await s2.save({ path: "C:\\x\\a.txt", about: "a note" }, { page })).meta).toEqual({ about: "a note" });
  });

  it("names text by its extension, and gives a name without one the type's", async () => {
    const { s, written } = saver();
    expect((await s.save({ text: "a,b\n1,2", name: "usage.csv" }, {})).contentType).toBe("text/csv");
    expect((await s.save({ text: "hello", name: "notes" }, {})).name).toBe("notes.txt");
    expect(written.map((w) => w.rel)).toEqual(["Noa/usage.csv", "Noa/notes.txt"]);
    expect(savedName("bad:name?.pdf", "x", "application/pdf")).toBe("bad_name_.pdf");
  });

  it("keeps a screenshot of the tab in images", async () => {
    const { s, written } = saver();
    const r = await s.save({ screenshot: true, name: "dashboard" }, { screenshot: async () => ({ base64: btoa("jpg"), mimeType: "image/jpeg" }) });
    expect(r).toMatchObject({ name: "dashboard.jpg", folder: "images", contentType: "image/jpeg", size: 3 });
    expect(written[0]!.rel).toBe("Noa/images/dashboard.jpg");
  });

  it("a file in the Noa folder at that place already is not copied again; another one is", async () => {
    const reads: string[] = [];
    const { s, written, cloud } = saver({ readLocal: async (p) => (reads.push(p), new Blob(["png"])) });
    const here = `${NOA}\\images\\logo.png`;
    expect(await s.save({ path: here, folder: "images" }, {})).toMatchObject({ path: here, name: "logo.png", contentType: "image/png", cloud: "saved" });
    expect(written).toEqual([]);
    await s.save({ path: here, folder: "brand" }, {});
    expect(written.map((w) => w.rel)).toEqual(["Noa/brand/logo.png"]);
    expect(reads).toEqual([here, here]);
    expect(cloud.map((c) => c.folder)).toEqual(["images", "brand"]);
    await expect(saver().s.save({ path: here }, {})).rejects.toThrow(/only with Noa's helper/);
  });

  it("the browser's last download: read from disk; fetched again when only its http address works; else says why", async () => {
    const download = { filename: "C:\\Users\\me\\Downloads\\usage.csv", url: "blob:https://site.test/1", mime: "text/csv" };
    const { s, written } = saver({ lastDownload: async () => download, readLocal: async () => new Blob(["a,b"]) });
    expect(await s.save({ download: true, folder: "documents" }, {})).toMatchObject({ name: "usage.csv", contentType: "text/csv", size: 3 });
    expect(written[0]!.rel).toBe("Noa/documents/usage.csv");

    const fetched = saver({ lastDownload: async () => ({ ...download, url: "https://site.test/usage.csv" }), readLocal: async () => Promise.reject(new Error("no helper")) });
    expect((await fetched.s.save({ download: true }, {})).size).toBe(8);
    await expect(saver({ lastDownload: async () => download }).s.save({ download: true }, {})).rejects.toThrow(/made by the page itself, and only Noa's helper can read it/);
    await expect(saver({ lastDownload: async () => null }).s.save({ download: true }, {})).rejects.toThrow(/has not downloaded a file in the last 15 minutes/);
  });

  it("Storage: this computer keeps it here only; cloud keeps it there only, at the path upload downloads it to", async () => {
    const local = saver({ where: async () => "local" });
    const r = await local.s.save({ text: "hi", name: "a.txt" }, {});
    expect(r).toMatchObject({ cloud: "off", local: true, path: `${NOA}\\a.txt` });
    expect(local.written).toHaveLength(1);
    expect(local.cloud).toEqual([]);

    const notes: string[] = [];
    const cloudOnly = saver({ where: async () => "cloud", cloudPath: async (f) => `${NOA}\\${f.folder}\\${f.name}`, note: async (p) => void notes.push(p) });
    const c = await cloudOnly.s.save({ text: "hi", name: "a.txt", folder: "notes", about: "a note" }, {});
    expect(c).toMatchObject({ cloud: "saved", local: false, path: `${NOA}\\notes\\a.txt`, name: "a.txt" });
    expect(cloudOnly.written).toEqual([]);
    expect(cloudOnly.cloud).toEqual([{ name: "a.txt", folder: "notes", type: "text/plain" }]);
    // No note here: nothing is here (the cloud row keeps it).
    expect(notes).toEqual([]);
  });

  it("Storage: cloud, when the cloud cannot take it, keeps it here instead and says why; a file already here stays", async () => {
    for (const cloud of [async () => ({ saved: false as const, why: "no-plan" as const }), async () => Promise.reject(new Error("Your cloud files are full"))]) {
      const t = saver({ where: async () => "cloud", cloudPath: async () => "unused", cloud });
      const r = await t.s.save({ text: "hi", name: "a.txt" }, {});
      expect(r).toMatchObject({ local: true, path: `${NOA}\\a.txt` });
      expect(r.cloud).not.toBe("saved");
      expect(t.written).toHaveLength(1);
    }
    const here = `${NOA}\\images\\logo.png`;
    const t = saver({ where: async () => "cloud", cloudPath: async () => "unused", readLocal: async () => new Blob(["png"]) });
    expect(await t.s.save({ path: here, folder: "images" }, {})).toMatchObject({ local: true, path: here, cloud: "saved" });
    expect(t.written).toEqual([]);
  });

  it("says when the cloud has no copy, and why; the local copy is kept anyway", async () => {
    expect((await saver({ cloud: async () => ({ saved: false, why: "no-plan" }) }).s.save({ text: "x", name: "a.txt" }, {})).cloud).toBe("no-plan");
    expect((await saver({ cloud: async () => ({ saved: false, why: "signed-out" }) }).s.save({ text: "x", name: "a.txt" }, {})).cloud).toBe("signed-out");
    const failed = await saver({ cloud: async () => Promise.reject(new Error("Your cloud files are full")) }).s.save({ text: "x", name: "a.txt" }, {});
    expect(failed).toMatchObject({ cloud: "failed", cloudError: "Your cloud files are full", path: `${NOA}\\a.txt` });
    // An older account server took it in the top folder.
    expect((await saver({ cloud: async () => ({ saved: true, file: stored("a.txt", ""), folder: "" }) }).s.save({ text: "x", name: "a.txt", folder: "notes" }, {})).cloudFolder).toBe("");
  });

  it("refuses what is not a file: a failed request, a web page instead of the file, a blob: link, one too large", async () => {
    const page = saver({ fetch: async () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }) });
    await expect(page.s.save({ url: "https://site.test/invoice.pdf" }, {})).rejects.toThrow(/gave a web page, not a file/);
    await expect(saver({ fetch: async () => new Response("no", { status: 403 }) }).s.save({ url: "https://site.test/a.pdf" }, {})).rejects.toThrow(/answered 403 \(sign in there first/);
    await expect(saver().s.save({ url: "blob:https://site.test/1" }, {})).rejects.toThrow(/click its Download button/);
    const big = saver({ fetch: async () => new Response("x", { headers: { "Content-Length": String(SAVE_FILE_MAX_BYTES + 1) } }) });
    await expect(big.s.save({ url: "https://site.test/a.zip" }, {})).rejects.toThrow(/save_file keeps files up to 25 MB/);
  });
});

describe("lastDownloadFinder", () => {
  it("is the newest finished download of the last 15 minutes that is still there and not Noa's own", async () => {
    const now = Date.parse("2026-10-03T12:00:00.000Z");
    const items = [
      { id: 1, filename: "/d/Noa/x.pdf", state: "complete", byExtensionId: "noa", endTime: "2026-10-03T11:59:00.000Z", url: "data:x" },
      { id: 2, filename: "/d/gone.csv", state: "complete", exists: false, endTime: "2026-10-03T11:58:00.000Z", url: "https://a.test/g" },
      { id: 3, filename: "/d/usage.csv", state: "complete", endTime: "2026-10-03T11:50:00.000Z", url: "blob:https://a.test/1", finalUrl: "blob:https://a.test/1", mime: "text/csv" },
    ];
    const dl = { search: async () => items } as unknown as SaverDownloadsLike;
    expect(await lastDownloadFinder(dl, "noa", () => now)()).toEqual({ filename: "/d/usage.csv", url: "blob:https://a.test/1", mime: "text/csv" });
    expect(await lastDownloadFinder(dl, "noa", () => now + 20 * 60_000)()).toBeNull();
  });
});
