// The UI pages without the background: the side panel, options and microphone pages bundled on
// their own (the background may be mid-refactor) with their static files, served from a local server.
import { build } from "esbuild";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENTRIES = { sidepanel: "src/sidepanel/sidepanel.ts", options: "src/options/options.ts", "mic-permission": "src/voice/mic-permission.ts", "pcm-worklet": "src/voice/pcm-worklet.ts" };
const STATIC = ["sidepanel.html", "options.html", "ui.css", "sidepanel.css", "voice.css", "options.css", "mic-permission.html", "mic-permission.css", "icons"];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

/** Bundles and serves the UI pages. Returns { out (the build directory), base (the server's URL), close }. */
export async function serveUi() {
  const out = mkdtempSync(join(tmpdir(), "noa-ui-"));
  const common = { bundle: true, platform: "browser", target: "chrome120", format: "esm", logLevel: "warning" };
  for (const [name, entry] of Object.entries(ENTRIES)) await build({ ...common, entryPoints: [join(root, entry)], outfile: join(out, `${name}.js`) });
  for (const f of STATIC) cpSync(join(root, "static", f), join(out, f), { recursive: true });

  const server = createServer((req, res) => {
    try {
      const file = join(out, new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "sidepanel.html");
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const close = () => {
    server.close();
    rmSync(out, { recursive: true, force: true });
  };
  return { out, base: `http://127.0.0.1:${server.address().port}`, close };
}
