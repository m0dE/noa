// The helper's code id: a hash of every file esbuild bundles into the helper (its sources, packages/core and
// packages/shared, and the dependencies it pulls in). The helper build embeds it, and so does the extension build,
// as the id it expects: a helper built from other code than the extension is out of date (settings-patch.ts says so).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** 12 hex characters; the same for the same bundled files, wherever the repo is. */
export async function helperCodeId() {
  const r = await build({
    entryPoints: [join(root, "src/host.ts"), join(root, "src/mcp-server.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    metafile: true,
    logLevel: "silent",
    // Input paths in the metafile are relative to this folder, whatever the current directory.
    absWorkingDir: root,
    outdir: join(root, ".code-id"),
  });
  const hash = createHash("sha256");
  // Paths relative to the helper, in one order, so the id does not depend on where the repo is.
  for (const input of Object.keys(r.metafile.inputs).sort()) {
    hash.update(input.replaceAll("\\", "/"));
    hash.update("\0");
    // Line endings as committed: a Windows checkout may have CRLF where the release machine has LF.
    hash.update(readFileSync(join(root, input), "utf8").replaceAll("\r\n", "\n"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}
