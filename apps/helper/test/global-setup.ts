import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Build dist/ once so the process-level tests run the real bundles. */
export default function setup(): void {
  if (process.env.HELPER_SKIP_BUILD) return;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(process.execPath, [join(root, "build.mjs")], { cwd: root, stdio: "inherit" });
}
