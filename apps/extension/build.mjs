// Bundles the extension into dist/: background.js, options.js, sidepanel.js, the voice pages, static files and icons.
import { build } from "esbuild";
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
// Output to the repo root so Chrome's "Load unpacked" points at <repo>/dist.
// NOA_DIST: build elsewhere (a work-in-progress build that must not replace the dist/ Chrome loads).
const dist = process.env.NOA_DIST ? resolve(process.env.NOA_DIST) : join(root, "..", "..", "dist");
// Built in a staging folder and swapped in only when complete, so a failed
// build never leaves the loaded extension half-written.
const staging = `${dist}.building`;
const iconDir = join(root, "static", "icons");

rmSync(staging, { recursive: true, force: true });
// The icons are made from brand/logo.svg by scripts/make-icons.mjs and committed.
for (const size of [16, 32, 48, 128]) {
  const file = join(iconDir, `icon${size}.png`);
  if (!existsSync(file)) throw new Error(`${file} is missing (node scripts/make-icons.mjs makes the icons from brand/logo.svg)`);
}

// Build-time config: env NOA_GOOGLE_CLIENT_ID, else config.json { "googleClientId": "..." }
// (gitignored; see config.example.json). Empty = Log In asks the account server (GET /v1/config) for it.
function readConfig() {
  const file = join(root, "config.json");
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`apps/extension/config.json is not valid JSON: ${err.message}`);
    }
  }
  return { googleClientId: String(process.env.NOA_GOOGLE_CLIENT_ID ?? fromFile.googleClientId ?? "").trim() };
}
const config = readConfig();
if (!config.googleClientId) console.log("[build] no Google client ID: sign-in will use the account server's (see apps/extension/README.md)");

const common = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  format: "esm",
  sourcemap: false,
  minify: false,
  // keepNames would wrap functions in __name(), which breaks the page snapshot
  // function that is serialized with Function.prototype.toString.
  keepNames: false,
  logLevel: "info",
  define: { __NOA_GOOGLE_CLIENT_ID__: JSON.stringify(config.googleClientId) },
};
await build({
  ...common,
  entryPoints: {
    background: join(root, "src/background.ts"),
    options: join(root, "src/options/options.ts"),
    sidepanel: join(root, "src/sidepanel/sidepanel.ts"),
    // Voice input: the microphone permission page and the PCM capture worklet.
    "mic-permission": join(root, "src/voice/mic-permission.ts"),
    "pcm-worklet": join(root, "src/voice/pcm-worklet.ts"),
  },
  outdir: staging,
});
cpSync(join(root, "static"), staging, { recursive: true });
rmSync(dist, { recursive: true, force: true });
renameSync(staging, dist);

