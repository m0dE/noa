import { describe, expect, it } from "vitest";
import { canonicalJson, compareVersions, parseBrowserRelease, releaseSigningText } from "../src/browser-release.js";

const file = { name: "noa-browser-0.2.0-win32-x64.tar.gz", size: 10, sha256: "a".repeat(64) };
const release = { version: "0.2.0", released: "2026-10-01T00:00:00Z", chromium: "156.0.8078.0", platforms: { "win32-x64": { installer: { ...file, name: "Noa-Browser-0.2.0-Setup.exe" }, update: file } }, signature: "sig" };

describe("browser releases", () => {
  it("canonical JSON sorts keys at every level, so the signature does not depend on key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
    expect(releaseSigningText(release)).not.toContain("signature");
    expect(releaseSigningText({ ...release, signature: "other" })).toBe(releaseSigningText(release));
  });
  it("compares versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareVersions("1.0", "1.0.0")).toThrow();
  });
  it("parses a manifest and refuses anything malformed", () => {
    expect(parseBrowserRelease(release)).toEqual(release);
    expect(parseBrowserRelease({ ...release, version: "latest" })).toBeNull();
    expect(parseBrowserRelease({ ...release, platforms: { "amiga-68k": release.platforms["win32-x64"] } })).toBeNull();
    expect(parseBrowserRelease({ ...release, platforms: { "win32-x64": { installer: { ...file, name: "../x" }, update: file } } })).toBeNull();
    expect(parseBrowserRelease({ ...release, platforms: { "win32-x64": { installer: file, update: { ...file, sha256: "zz" } } } })).toBeNull();
    const { signature: _s, ...unsigned } = release;
    expect(parseBrowserRelease(unsigned)).toBeNull();
  });
});
