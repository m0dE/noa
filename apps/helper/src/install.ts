/**
 * Registers the helper as a Chrome native messaging host.
 *
 *   node dist/install.js --extension-id <id> [--env KEY=VALUE ...]
 *   node dist/install.js --uninstall
 *
 * Windows: writes %LOCALAPPDATA%\noa\host\com.noa.helper.json
 * and noa-host.cmd, then points HKCU\Software\Google\Chrome\... and
 * HKCU\Software\Chromium\... NativeMessagingHosts\com.noa.helper at
 * the manifest.
 * macOS and Linux: writes the noa-host.sh launcher to the host folder
 * and com.noa.helper.json to Chrome's and Chromium's per-user
 * NativeMessagingHosts folders.
 * This is a CLI, so printing to stdout is fine here.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, NATIVE_HOST_NAME } from "@noa/shared";
import { loadConfig, repoRoot } from "./config.js";

export const REGISTRY_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
];
export const LAUNCHER_NAME = "noa-host.cmd";
export const SH_LAUNCHER_NAME = "noa-host.sh";
export const MANIFEST_NAME = `${NATIVE_HOST_NAME}.json`;

export function isExtensionId(id: string): boolean {
  return /^[a-p]{32}$/.test(id);
}

export function buildManifest(opts: { extensionId: string; launcherPath: string }) {
  return {
    name: NATIVE_HOST_NAME,
    description: "Noa local helper",
    path: opts.launcherPath,
    type: "stdio" as const,
    allowed_origins: [`chrome-extension://${opts.extensionId}/`],
  };
}

export function buildLauncher(opts: { nodePath: string; hostJsPath: string; env?: Record<string, string> }): string {
  const lines = ["@echo off"];
  for (const [k, v] of Object.entries(opts.env ?? {})) lines.push(`set "${k}=${v}"`);
  lines.push(`"${opts.nodePath}" "${opts.hostJsPath}" %*`);
  return lines.join("\r\n") + "\r\n";
}

/** A single-quoted sh word. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The sh launcher (macOS, Linux). Chrome started from the Dock or a desktop
 * menu has a bare PATH, so the installer's PATH goes in too: the helper finds
 * `claude` through it.
 */
export function buildShLauncher(opts: { nodePath: string; hostJsPath: string; env?: Record<string, string> }): string {
  const lines = ["#!/bin/sh"];
  for (const [k, v] of Object.entries(opts.env ?? {})) lines.push(`export ${k}=${shQuote(v)}`);
  lines.push(`exec ${shQuote(opts.nodePath)} ${shQuote(opts.hostJsPath)} "$@"`);
  return lines.join("\n") + "\n";
}

/** Chrome's and Chromium's per-user NativeMessagingHosts folders (macOS, Linux). */
export function manifestDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "darwin") {
    const support = posix.join(home, "Library", "Application Support");
    return [posix.join(support, "Google", "Chrome", "NativeMessagingHosts"), posix.join(support, "Chromium", "NativeMessagingHosts")];
  }
  return [posix.join(home, ".config", "google-chrome", "NativeMessagingHosts"), posix.join(home, ".config", "chromium", "NativeMessagingHosts")];
}

export interface InstallArgs {
  uninstall: boolean;
  extensionId: string | null;
  env: Record<string, string>;
}

export function parseArgs(argv: string[]): InstallArgs {
  const out: InstallArgs = { uninstall: false, extensionId: null, env: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--uninstall") out.uninstall = true;
    else if (a === "--extension-id") out.extensionId = argv[++i] ?? null;
    else if (a.startsWith("--extension-id=")) out.extensionId = a.slice("--extension-id=".length);
    else if (a === "--env") {
      const kv = argv[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new Error(`--env expects KEY=VALUE, got "${kv}"`);
      out.env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** apps/extension/extension-id.txt, relative to the repo root. */
export function readExtensionIdFile(root: string): string | null {
  const file = join(root, "apps", "extension", "extension-id.txt");
  if (!existsSync(file)) return null;
  const id = readFileSync(file, "utf8").trim();
  return id || null;
}

function reg(args: string[]): void {
  execFileSync("reg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
}

function install(args: InstallArgs): void {
  const extensionId = args.extensionId ?? readExtensionIdFile(repoRoot());
  if (!extensionId) throw new Error("no extension id: pass --extension-id <id> or create apps/extension/extension-id.txt");
  if (!isExtensionId(extensionId)) throw new Error(`"${extensionId}" is not a Chrome extension id (32 letters a-p)`);
  const hostJsPath = join(dirname(fileURLToPath(import.meta.url)), "host.js");
  if (!existsSync(hostJsPath)) throw new Error(`${hostJsPath} not found; run the build first`);

  const { hostDir } = loadConfig();
  mkdirSync(hostDir, { recursive: true });
  console.log(`Registered ${NATIVE_HOST_NAME} for chrome-extension://${extensionId}/`);
  if (process.platform === "win32") {
    const launcherPath = join(hostDir, LAUNCHER_NAME);
    const manifestPath = join(hostDir, MANIFEST_NAME);
    writeFileSync(launcherPath, buildLauncher({ nodePath: process.execPath, hostJsPath, env: args.env }));
    writeFileSync(manifestPath, JSON.stringify(buildManifest({ extensionId, launcherPath }), null, 2));
    for (const key of REGISTRY_KEYS) reg(["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
    console.log(`  manifest: ${manifestPath}`);
    console.log(`  launcher: ${launcherPath}`);
    for (const key of REGISTRY_KEYS) console.log(`  registry: ${key}`);
    return;
  }
  const launcherPath = join(hostDir, SH_LAUNCHER_NAME);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...args.env };
  writeFileSync(launcherPath, buildShLauncher({ nodePath: process.execPath, hostJsPath, env }));
  chmodSync(launcherPath, 0o755);
  console.log(`  launcher: ${launcherPath}`);
  const manifest = JSON.stringify(buildManifest({ extensionId, launcherPath }), null, 2);
  for (const dir of manifestDirs(process.platform, homedir())) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST_NAME), manifest);
    console.log(`  manifest: ${join(dir, MANIFEST_NAME)}`);
  }
}

function uninstall(): void {
  if (process.platform === "win32") {
    for (const key of REGISTRY_KEYS) {
      try {
        reg(["delete", key, "/f"]);
        console.log(`Removed ${key}`);
      } catch {
        console.log(`Not present: ${key}`);
      }
    }
  } else {
    for (const dir of manifestDirs(process.platform, homedir())) {
      rmSync(join(dir, MANIFEST_NAME), { force: true });
      console.log(`Removed ${join(dir, MANIFEST_NAME)}`);
    }
  }
  const { hostDir } = loadConfig();
  rmSync(join(hostDir, LAUNCHER_NAME), { force: true });
  rmSync(join(hostDir, SH_LAUNCHER_NAME), { force: true });
  rmSync(join(hostDir, MANIFEST_NAME), { force: true });
  console.log(`Removed host files from ${hostDir}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.uninstall) uninstall();
  else install(args);
}

// Run only as the entry point (tests import the pure functions).
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const self = fileURLToPath(import.meta.url);
if (entry && (process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self)) {
  try {
    main();
  } catch (e) {
    console.error(`install failed: ${errorMessage(e)}`);
    process.exit(1);
  }
}
