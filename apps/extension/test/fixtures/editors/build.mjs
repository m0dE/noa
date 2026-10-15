// Rebuilds editors.js and THIRD_PARTY_LICENSES.txt from entry.js: installs the pinned versions below in a temporary
// directory (npm, needs the network; nothing is added to the repo's dependencies), bundles them with esbuild (one copy
// of each dependency, minified), and collects the license of every package that ends up in the bundle.
// Usage: node apps/extension/test/fixtures/editors/build.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED = [
  "prosemirror-model@1.25.12",
  "prosemirror-state@1.4.4",
  "prosemirror-view@1.42.6",
  "prosemirror-schema-basic@1.2.5",
  "prosemirror-example-setup@1.2.3",
  "@tiptap/core@3.31.4",
  "@tiptap/pm@3.31.4",
  "@tiptap/starter-kit@3.31.4",
  "lexical@0.52.0",
  "@lexical/rich-text@0.52.0",
  "quill@2.0.3",
  "slate@0.133.7",
  "slate-dom@0.133.6",
  "slate-react@0.133.8",
  "react@19.3.0",
  "react-dom@19.3.0",
  "esbuild@0.28.2",
];

/** Slate's packages ship without a license file: the one of its repository (github.com/ianstormtaylor/slate, License.md). */
const SLATE_LICENSE = `The MIT License

Copyright (c) 2016-2023, Ian Storm Taylor (https://ianstormtaylor.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "noa-editors-"));
try {
  writeFileSync(join(tmp, "package.json"), '{ "private": true }\n');
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--save-exact", ...PINNED], { cwd: tmp, stdio: "inherit" });
  // Bundled from the temporary directory, so its node_modules is what the imports resolve to.
  copyFileSync(join(here, "entry.js"), join(tmp, "entry.js"));
  const { build } = await import(pathToFileURL(join(tmp, "node_modules", "esbuild", "lib", "main.js")).href);
  const out = await build({
    entryPoints: [join(tmp, "entry.js")],
    bundle: true,
    minify: true,
    format: "iife",
    legalComments: "none",
    loader: { ".css": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
    target: "chrome120",
    metafile: true,
    outfile: join(here, "editors.js"),
  });
  // Every package with code in the bundle, and its license.
  const packages = new Set();
  for (const [file, { bytesInOutput }] of Object.entries(Object.values(out.metafile.outputs)[0].inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
    if (m && bytesInOutput > 0) packages.add(m[1]);
  }
  const notices = [...packages].sort().map((name) => {
    const dir = join(tmp, "node_modules", name);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = file && existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim() : /^slate(-|$)/.test(name) ? SLATE_LICENSE : null;
    if (!text) throw new Error(`${name} has no license file: add its license to build.mjs`);
    return `${name}@${pkg.version} (${pkg.license})\n\n${text}\n`;
  });
  writeFileSync(join(here, "THIRD_PARTY_LICENSES.txt"), `Licenses of the packages bundled in editors.js.\n\n${notices.join("\n" + "-".repeat(78) + "\n\n")}`);
  console.log(`editors.js: ${packages.size} packages: ${[...packages].sort().join(", ")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
