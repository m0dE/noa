import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGISTRY_KEYS, buildLauncher, buildManifest, buildShLauncher, isExtensionId, manifestDirs, parseArgs, readExtensionIdFile } from "../src/install.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-inst-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("install", () => {
  it("builds the native messaging manifest", () => {
    expect(buildManifest({ extensionId: ID, launcherPath: "C:\\Users\\me\\AppData\\Local\\noa\\host\\noa-host.cmd" })).toEqual({
      name: "com.noa.helper",
      description: "Noa local helper",
      path: "C:\\Users\\me\\AppData\\Local\\noa\\host\\noa-host.cmd",
      type: "stdio",
      allowed_origins: [`chrome-extension://${ID}/`],
    });
  });

  it("builds the .cmd launcher, optionally with env vars", () => {
    expect(buildLauncher({ nodePath: "C:\\Program Files\\nodejs\\node.exe", hostJsPath: "D:\\www\\postmore\\apps\\helper\\dist\\host.js" })).toBe(
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "D:\\www\\postmore\\apps\\helper\\dist\\host.js" %*\r\n',
    );
    expect(buildLauncher({ nodePath: "node.exe", hostJsPath: "host.js", env: { NOA_BRAIN: "scripted" } })).toBe(
      '@echo off\r\nset "NOA_BRAIN=scripted"\r\n"node.exe" "host.js" %*\r\n',
    );
  });

  it("builds the sh launcher, quoting paths and env values", () => {
    expect(buildShLauncher({ nodePath: "/opt/node/bin/node", hostJsPath: "/Users/me/repo/apps/helper/dist/host.js", env: { PATH: "/usr/bin:/bin", NOTE: "it's" } })).toBe(
      "#!/bin/sh\nexport PATH='/usr/bin:/bin'\nexport NOTE='it'\\''s'\nexec '/opt/node/bin/node' '/Users/me/repo/apps/helper/dist/host.js' \"$@\"\n",
    );
  });

  it("puts the manifest where Chrome and Chromium look on macOS and Linux", () => {
    expect(manifestDirs("darwin", "/Users/me")).toEqual([
      "/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts",
      "/Users/me/Library/Application Support/Chromium/NativeMessagingHosts",
    ]);
    expect(manifestDirs("linux", "/home/me")).toEqual(["/home/me/.config/google-chrome/NativeMessagingHosts", "/home/me/.config/chromium/NativeMessagingHosts"]);
  });

  it("registers under both Chrome and Chromium", () => {
    expect(REGISTRY_KEYS).toEqual([
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.noa.helper",
      "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.noa.helper",
    ]);
  });

  it("parses arguments", () => {
    expect(parseArgs(["--extension-id", ID])).toEqual({ uninstall: false, extensionId: ID, env: {} });
    expect(parseArgs([`--extension-id=${ID}`, "--env", "A=b=c"])).toEqual({ uninstall: false, extensionId: ID, env: { A: "b=c" } });
    expect(parseArgs(["--uninstall"]).uninstall).toBe(true);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--env", "novalue"])).toThrow(/KEY=VALUE/);
  });

  it("validates extension ids", () => {
    expect(isExtensionId(ID)).toBe(true);
    expect(isExtensionId("abc")).toBe(false);
    expect(isExtensionId("zbcdefghijklmnopabcdefghijklmnop")).toBe(false);
  });

  it("falls back to apps/extension/extension-id.txt", () => {
    expect(readExtensionIdFile(dir)).toBeNull();
    mkdirSync(join(dir, "apps", "extension"), { recursive: true });
    writeFileSync(join(dir, "apps", "extension", "extension-id.txt"), `${ID}\r\n`);
    expect(readExtensionIdFile(dir)).toBe(ID);
  });
});
