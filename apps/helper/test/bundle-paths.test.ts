// A helper built into another folder than dist/ (NOA_HELPER_DIST, e.g. apps/helper/dist-dev for e2e) must
// give Claude Code an MCP server that exists: a missing one leaves every session without its Noa tools
// ("mcp_servers":[{"name":"noa","status":"failed"}], each call "No such tool available"), so the agent
// ends its turn without reporting a result.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "..");

let outDir: string;
let home: string;
beforeAll(async () => {
  // Named like the e2e build folder, inside apps/helper as the e2e build is.
  outDir = mkdtempSync(join(HELPER, "dist-dev-probe-"));
  home = mkdtempSync(join(tmpdir(), "bt-bundle-paths-"));
  execFileSync(process.execPath, [join(HELPER, "build.mjs")], { cwd: HELPER, env: { ...process.env, NOA_HELPER_DIST: outDir }, stdio: "inherit" });
  await build({
    entryPoints: { "config-probe": join(HELPER, "test/fixtures/config-probe.ts") },
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
}, 120_000);
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("a helper bundle built outside dist/ (NOA_HELPER_DIST)", () => {
  it("points Claude Code at the mcp-server.js built beside it, and apps/helper is its root", () => {
    const out = execFileSync(process.execPath, [join(outDir, "config-probe.js")], { env: { ...process.env, NOA_HOME: home } }).toString("utf8");
    const { mcpServerPath, helperRoot } = JSON.parse(out) as { mcpServerPath: string; helperRoot: string };
    expect(mcpServerPath).toBe(join(outDir, "mcp-server.js"));
    expect(existsSync(mcpServerPath)).toBe(true);
    expect(helperRoot).toBe(HELPER);
  });
});
