import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FILE_READ_CHUNK_BYTES, NOA_FILE_NOTES } from "@noa/shared";
import { listFolder, noteFile, readChunk } from "../src/noa-files.js";

function folderWith(files: Record<string, number>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "noa-files-")), "Noa");
  for (const [name, minutesAgo] of Object.entries(files)) {
    const path = join(dir, ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, name);
    const t = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(path, t, t);
  }
  return dir;
}

describe("listFolder", () => {
  it("lists the files under the folder newest first, with subfolders, leaving out the README, hidden files and partial downloads", () => {
    const dir = folderWith({ "README.txt": 0, "Resume.pdf": 5, "images/logo.png": 1, ".DS_Store": 0, "big.zip.crdownload": 0, "a/b/c/d/deep.txt": 2 });
    const r = listFolder(dir);
    expect(r.folder).toBe(dir);
    expect(r.files.map((f) => f.name)).toEqual(["images/logo.png", "a/b/c/d/deep.txt", "Resume.pdf"]);
    expect(r.files[2]).toMatchObject({ path: join(dir, "Resume.pdf"), size: "Resume.pdf".length });
    expect(r.total).toBe(3);
  });

  it("keeps only the names that contain the search (any case), and cuts the list at max", () => {
    const dir = folderWith({ "Resume.pdf": 3, "old/resume-2024.pdf": 9, "photo.jpg": 1 });
    expect(listFolder(dir, { search: "RESUME" }).files.map((f) => f.name)).toEqual(["Resume.pdf", "old/resume-2024.pdf"]);
    expect(listFolder(dir, { max: 1 })).toMatchObject({ files: [{ name: "photo.jpg" }], total: 3 });
  });

  it("gives a picture's size from its header, and the note kept on each file", () => {
    const dir = folderWith({ "photos/lamp.png": 1, "notes.txt": 2 });
    const png = Buffer.alloc(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(600, 20);
    writeFileSync(join(dir, "photos", "lamp.png"), png);
    noteFile(dir, join(dir, "photos", "lamp.png"), { source: "https://shop.test/cdn/1.png", page: "https://shop.test/lamp", pageTitle: "Lamp", about: "The lamp, front", width: 1, height: 1 });
    noteFile(dir, join(dir, "notes.txt"), { about: "Meeting notes" });
    const r = listFolder(dir);
    expect(r.files.map((f) => f.name)).toEqual(["photos/lamp.png", "notes.txt"]);
    // The size is the file's own, never the note's.
    expect(r.files[0]!.meta).toEqual({ width: 800, height: 600, source: "https://shop.test/cdn/1.png", page: "https://shop.test/lamp", pageTitle: "Lamp", about: "The lamp, front" });
    expect(r.files[1]!.meta).toEqual({ about: "Meeting notes" });
  });

  it("replaces a file's note, refuses a file outside the folder, and lists a folder with a broken notes file", () => {
    const dir = folderWith({ "a.pdf": 1 });
    noteFile(dir, join(dir, "a.pdf"), { about: "first" });
    noteFile(dir, join(dir, "A.PDF"), { about: "second" });
    expect(JSON.parse(readFileSync(join(dir, NOA_FILE_NOTES), "utf8"))).toEqual({ "A.PDF": { about: "second" } });
    expect(listFolder(dir).files[0]!.meta).toEqual({ about: "second" });
    expect(() => noteFile(dir, join(dir, "..", "elsewhere.txt"), { about: "x" })).toThrow("not in the Noa folder");
    writeFileSync(join(dir, NOA_FILE_NOTES), "{ not json");
    expect(listFolder(dir).files).toEqual([expect.objectContaining({ name: "a.pdf" })]);
    expect(listFolder(dir).files[0]!.meta).toBeUndefined();
    expect(existsSync(join(dir, `${NOA_FILE_NOTES}.${process.pid}.tmp`))).toBe(false);
  });

  it("lists nothing for a folder that is not there", () => {
    expect(listFolder(join(tmpdir(), "no-such-noa-folder-xyz"))).toMatchObject({ files: [], total: 0 });
  });
});

describe("readChunk", () => {
  it("reads a file a piece at a time, never more than a chunk", () => {
    const dir = folderWith({});
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "big.bin");
    const bytes = Buffer.alloc(FILE_READ_CHUNK_BYTES + 10, 7);
    bytes[FILE_READ_CHUNK_BYTES] = 9;
    writeFileSync(path, bytes);
    const first = readChunk(path, 0, 10 * FILE_READ_CHUNK_BYTES);
    expect(first.size).toBe(bytes.length);
    expect(Buffer.from(first.dataBase64, "base64").length).toBe(FILE_READ_CHUNK_BYTES);
    const rest = Buffer.from(readChunk(path, FILE_READ_CHUNK_BYTES, FILE_READ_CHUNK_BYTES).dataBase64, "base64");
    expect([...rest]).toEqual([9, ...Array(9).fill(7)]);
    expect(readChunk(path, bytes.length, 100).dataBase64).toBe("");
    expect(() => readChunk(dir, 0, 1)).toThrow(/is not a file/);
  });
});
