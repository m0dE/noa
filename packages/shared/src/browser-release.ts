/**
 * Noa Browser releases: the manifest the release pipeline publishes (R2, served at
 * https://noa.bot/download/browser/latest.json by apps/web), the download pages read, and the app's
 * updater (apps/browser/src/update.ts) checks. The manifest is signed with the release key (Ed25519);
 * the app accepts an update only when the signature verifies with the public key built into it, and
 * the file's SHA-256 matches. See docs/BROWSER.md, "Releases and updates".
 */

/** The platforms a release is built for (chromium.json's keys). */
export const BROWSER_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"] as const;
export type BrowserPlatform = (typeof BROWSER_PLATFORMS)[number];

export interface ReleaseFile {
  /** The file name; its URL is <base>/browser/<version>/<name>. */
  name: string;
  size: number;
  /** Hex. */
  sha256: string;
}

export interface PlatformRelease {
  /** What a person downloads: the .dmg, the Setup .exe, the .deb. */
  installer: ReleaseFile;
  /** What the app's updater downloads: the app itself, as a .tar.gz (on macOS the signed Noa Browser.app). */
  update: ReleaseFile;
  /**
   * How the installer is signed, for the download page: "developer-id" (macOS, notarized), "adhoc" (macOS: opens
   * after the user allows it once), "authenticode" (Windows), "none" (Windows SmartScreen warns; a .deb).
   */
  signing?: "developer-id" | "adhoc" | "authenticode" | "none";
}

export interface BrowserRelease {
  /** Semver of apps/browser/package.json. */
  version: string;
  /** ISO time. */
  released: string;
  /** The Chromium version the release runs on. */
  chromium: string;
  platforms: Partial<Record<BrowserPlatform, PlatformRelease>>;
}

export interface SignedBrowserRelease extends BrowserRelease {
  /** Ed25519 signature, base64, of canonicalJson(the release without this field). */
  signature: string;
}

/** Where releases live under the download origin. */
export const BROWSER_RELEASE_PREFIX = "browser";
export const BROWSER_MANIFEST_NAME = "latest.json";
export const releaseFileKey = (version: string, name: string) => `${BROWSER_RELEASE_PREFIX}/${version}/${name}`;

/** JSON with object keys sorted at every level: what the signature covers. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The bytes the signature covers. */
export function releaseSigningText(r: BrowserRelease | SignedBrowserRelease): string {
  const { signature: _s, ...rest } = r as SignedBrowserRelease;
  return canonicalJson(rest);
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** a < b: -1, equal: 0, a > b: 1. A pre-release sorts before its release. Throws on a non-semver. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isFile(f: unknown): f is ReleaseFile {
  const x = f as ReleaseFile;
  return !!x && typeof x.name === "string" && FILE_NAME.test(x.name) && Number.isSafeInteger(x.size) && x.size > 0 && typeof x.sha256 === "string" && HEX64.test(x.sha256);
}

/** A SignedBrowserRelease from untrusted JSON (shape only: the signature is checked by the caller), or null. */
export function parseBrowserRelease(json: unknown): SignedBrowserRelease | null {
  const r = json as SignedBrowserRelease;
  if (!r || typeof r !== "object" || typeof r.version !== "string" || !SEMVER.test(r.version)) return null;
  if (typeof r.released !== "string" || typeof r.chromium !== "string" || typeof r.signature !== "string") return null;
  if (!r.platforms || typeof r.platforms !== "object") return null;
  for (const [k, p] of Object.entries(r.platforms)) {
    if (!(BROWSER_PLATFORMS as readonly string[]).includes(k)) return null;
    if (!p || !isFile(p.installer) || !isFile(p.update)) return null;
    if (p.signing !== undefined && !["developer-id", "adhoc", "authenticode", "none"].includes(p.signing)) return null;
  }
  return r;
}
