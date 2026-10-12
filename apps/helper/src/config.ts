/**
 * Helper configuration: `.env` files from the repo root and the helper
 * directory (tiny parser, no dependency), then `process.env`, which always wins.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, type HelperBrain } from "@noa/shared";
import helperPackage from "../package.json" with { type: "json" };
import { ENV } from "./env-names.js";

/** Reported in helper.hello and by the MCP server: the version in apps/helper/package.json (bundled at build time). */
export const HELPER_VERSION: string = helperPackage.version;

/**
 * The model when neither the extension nor NOA_MODEL names one: the extension setting's own
 * default, by its full id. Every run passes --model, so the user's own Claude Code default model
 * (their settings.json, /model) never decides.
 */
export const DEFAULT_CLAUDE_MODEL: string = DEFAULT_MODEL;

export interface HelperConfig {
  /** NOA_HOME, else %LOCALAPPDATA%\noa (Windows), ~/Library/Application Support/noa (macOS) or ~/.local/share/noa. */
  baseDir: string;
  logDir: string;
  runsDir: string;
  hostDir: string;
  /** helper.json: pipe name and pid of the running helper, for `mcp-server.js --attach`. */
  helperFilePath: string;
  /** Absolute path of the bundled MCP server that Claude Code spawns. */
  mcpServerPath: string;
  /** Jev key, or null when missing or blank. */
  typesafeApiKey: string | null;
  brain: HelperBrain;
  model: string;
  /**
   * NOA_THINKING: "on" or "off" forces Claude Code's extended thinking for every run (a
   * developer's override, e.g. for benchmarks). null: each run follows the extension's Reasoning
   * setting (shared/reasoning.ts; its default and the benchmark behind it are there).
   */
  thinking: boolean | null;
  /** The merged environment (.env files, then process.env). */
  env: Record<string, string | undefined>;
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

/** Later directories override earlier ones; `processEnv` overrides all. */
export function loadEnv(dirs: string[], processEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const dir of dirs) {
    const file = join(dir, ".env");
    if (!existsSync(file)) continue;
    try {
      Object.assign(merged, parseDotEnv(readFileSync(file, "utf8")));
    } catch {
      /* an unreadable .env is ignored */
    }
  }
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) merged[k] = v;
  return merged;
}

/** The folder this module runs from: apps/helper/src (tests) or the bundle's build folder (dist/, or NOA_HELPER_DIST's, e.g. dist-dev/). */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function runningFromSrc(): boolean {
  return basename(moduleDir()) === "src";
}

/** apps/helper: the parent of src/ or of the build folder, whatever the build folder is named. */
export function helperRoot(): string {
  return dirname(moduleDir());
}

/** The built mcp-server.js: beside the running bundle (the build writes every entry into one folder); from src/, dist/'s. */
function mcpServerPath(): string {
  return join(runningFromSrc() ? join(helperRoot(), "dist") : moduleDir(), "mcp-server.js");
}

export function repoRoot(): string {
  return resolve(helperRoot(), "..", "..");
}

/** The folder that holds Noa's folder when NOA_HOME is not set. */
function appDataDir(env: Record<string, string | undefined>): string {
  if (env.LOCALAPPDATA) return env.LOCALAPPDATA;
  if (process.platform === "win32") return join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** NOA_THINKING as a forced setting: "on" true, "off" false, anything else (unset) null. */
function thinkingOverride(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase();
  return v === "on" ? true : v === "off" ? false : null;
}

export function loadConfig(
  processEnv: Record<string, string | undefined> = process.env,
  opts: { dotenvDirs?: string[] } = {},
): HelperConfig {
  const root = helperRoot();
  const env = loadEnv(opts.dotenvDirs ?? [repoRoot(), root], processEnv);
  const baseDir = env[ENV.home] || join(appDataDir(env), "noa");
  const key = env[ENV.typesafeApiKey]?.trim();
  return {
    baseDir,
    logDir: join(baseDir, "logs"),
    runsDir: join(baseDir, "runs"),
    hostDir: join(baseDir, "host"),
    helperFilePath: join(baseDir, "helper.json"),
    mcpServerPath: mcpServerPath(),
    typesafeApiKey: key ? key : null,
    brain: env[ENV.brain] === "scripted" ? "scripted" : "claude",
    model: env[ENV.model]?.trim() || DEFAULT_CLAUDE_MODEL,
    thinking: thinkingOverride(env[ENV.thinking]),
    env,
  };
}
