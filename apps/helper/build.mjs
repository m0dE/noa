// Bundles the helper entry points into dist/. Everything (MCP SDK, Jev SDK,
// shared contracts, core) is bundled so dist/ runs with plain `node`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: {
    host: join(root, "src/host.ts"),
    "mcp-server": join(root, "src/mcp-server.ts"),
    install: join(root, "src/install.ts"),
  },
  // NOA_HELPER_DIST: build elsewhere (e.g. apps/helper/dist-dev for e2e), leaving dist/ (the installed helper runs it) alone.
  outdir: process.env.NOA_HELPER_DIST ? resolve(process.env.NOA_HELPER_DIST) : join(root, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Node 20: the oldest the helper installer (apps/web/public/helper/install.sh) accepts; the helper tests pass on it.
  target: "node20",
  sourcemap: true,
  logLevel: "warning",
  banner: {
    js: 'import { createRequire as __btCreateRequire } from "node:module"; const require = __btCreateRequire(import.meta.url);',
  },
});
