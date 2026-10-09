import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FILE_READ_CHUNK_BYTES } from "@noa/shared";
import { listFolder, readChunk } from "../src/noa-files.js";

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
