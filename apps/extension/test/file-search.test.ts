import { describe, expect, it } from "vitest";
import type { NoaFile } from "@noa/shared";
import { searchFiles } from "../src/engine/file-search.js";

const NOW = new Date("2026-10-20T12:00:00Z");
let n = 0;
const file = (name: string, modified: string, meta?: NoaFile["meta"]): NoaFile => ({ path: `/Noa/${name}`, name, size: 1000 + n++, modified, ...(meta ? { meta } : {}) });
const names = (hits: { file: NoaFile }[]) => hits.map((h) => h.file.name);

const mug = file("IMG_3302.png", "2026-05-01T10:00:00Z", { width: 800, height: 600, about: "Stoneware coffee mug, front view" });
const lamp = file("products/aldo-lamp.png", "2026-09-01T10:00:00Z", { about: "Walnut desk lamp, main product photo", pageTitle: "Aldo task lamp", page: "https://gallery.test/aldo" });
const logo = file("brand/logo.png", "2026-10-01T10:00:00Z", { about: "Northwood Lighting primary logo", source: "https://brandkit.test/download?asset=3121" });
const invSep = file("invoices/INV-2207.pdf", "2026-10-02T10:00:00Z", { about: "Neon invoice for September 2026" });
const invAug = file("invoices/INV-2181.pdf", "2026-09-03T10:00:00Z", { about: "Neon invoice for August 2026" });
const resume = file("Resume 2026.pdf", "2026-10-15T10:00:00Z");
const all = [mug, lamp, logo, invSep, invAug, resume];

describe("searchFiles", () => {
  it("finds a file by the words of its note, page and site, not only its name", () => {
    expect(names(searchFiles(all, "stoneware mug", { now: NOW }))).toEqual(["IMG_3302.png"]);
    expect(names(searchFiles(all, "the lamp from gallery.test", { now: NOW }))[0]).toBe("products/aldo-lamp.png");
    expect(names(searchFiles(all, "Northwood logo", { now: NOW }))).toEqual(["brand/logo.png"]);
  });

  it("an identifier or a part of a name finds it as written", () => {
    expect(names(searchFiles(all, "INV-2207", { now: NOW }))[0]).toBe("invoices/INV-2207.pdf");
    expect(names(searchFiles(all, "resume", { now: NOW }))).toEqual(["Resume 2026.pdf"]);
  });

  it("meaning finds what no word does, at its bar; a file found two ways ranks first", () => {
    const semantic = new Map([[mug, 0.72], [lamp, 0.46]]);
    expect(names(searchFiles(all, "a cup for coffee", { now: NOW, semantic }))).toEqual(["IMG_3302.png"]);
    // Words and meaning both find the August invoice; words alone the September one.
    const both = searchFiles(all, "invoice August", { now: NOW, semantic: new Map([[invAug, 0.8]]) });
    expect(names(both)[0]).toBe("invoices/INV-2181.pdf");
  });

  it("a named time keeps that period's files; latest and first order them", () => {
    expect(names(searchFiles(all, "invoices from last week", { now: NOW }))).toEqual([]);
    expect(names(searchFiles(all, "files from this month", { now: NOW }))).toEqual(["Resume 2026.pdf", "invoices/INV-2207.pdf", "brand/logo.png"]);
    expect(names(searchFiles(all, "the latest Neon invoice", { now: NOW }))[0]).toBe("invoices/INV-2207.pdf");
    expect(names(searchFiles(all, "the first Neon invoice", { now: NOW }))[0]).toBe("invoices/INV-2181.pdf");
  });

  it("recency breaks ties (the newer of equal matches first) but never lifts a weaker match", () => {
    const old = file("photos/beach-2024.jpg", "2024-07-01T00:00:00Z", { about: "beach sunset" });
    const recent = file("photos/beach-2026.jpg", "2026-07-01T00:00:00Z", { about: "beach sunset" });
    expect(names(searchFiles([old, recent], "beach sunset", { now: NOW }))).toEqual(["photos/beach-2026.jpg", "photos/beach-2024.jpg"]);
    // Found by name, words and meaning, the old one stays above a newer file found by meaning alone.
    const strong = file("contracts/lease-signed.pdf", "2025-01-01T00:00:00Z", { about: "signed lease" });
    const weak = file("misc/scan-114.pdf", "2026-10-19T00:00:00Z");
    const r = searchFiles([strong, weak], "signed lease", { now: NOW, semantic: new Map([[strong, 0.8], [weak, 0.55]]) });
    expect(names(r)).toEqual(["contracts/lease-signed.pdf", "misc/scan-114.pdf"]);
  });

  it("finds nothing for what no file is about", () => {
    expect(searchFiles(all, "passport scan", { now: NOW })).toEqual([]);
  });

  it("ranks 5,000 files quickly", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      file(`photos/IMG_${i}.jpg`, new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(), { about: `photo ${i % 50} of product line ${i % 7}`, pageTitle: `Shop page ${i % 300}` }),
    );
    many.push(mug);
    const t0 = performance.now();
    const r = searchFiles(many, "stoneware mug", { now: NOW });
    const ms = performance.now() - t0;
    expect(names(r)[0]).toBe("IMG_3302.png");
    expect(ms).toBeLessThan(500);
  });
});
