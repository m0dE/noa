// Visual harness for the side panel and options page, without the real background.
// Bundles only the UI entry points, serves them from a local static server, injects
// a `chrome` stub with canned data, and takes screenshots in light and dark mode.
//
// Usage: node apps/extension/test/ui/harness.mjs [--headed] [--only=<substring>]
// --only matches the screenshot file name, e.g. --only=panel-list-480-dark or --only=composer.
// Exits non-zero on page errors or layout problems (composer not flush, overlap, clipping, wrapped bars).
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSpeechLikeWav } from "../../../../test/fixtures/voice/speech-wav.mjs";
import { serveUi } from "./harness/build.mjs";
import { createChecks } from "./harness/checks.mjs";
import { OPT_SIZES, OPTION_CASES, OPTION_FLOWS } from "./harness/options-cases.mjs";
import { PANEL_CASES, panelHelpers, SIZES } from "./harness/panel-cases.mjs";
import { TODO_CASES } from "./harness/todo-cases.mjs";
import { LIST_CASES } from "./harness/list-cases.mjs";
import { ATTACHMENT_CASES } from "./harness/attachment-cases.mjs";
import { MEMORY_PANEL_CASES, runMemoryOptions } from "./harness/memory-cases.mjs";
import { renderThumbnail } from "./harness/scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes("--headed");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const SCHEMES = ["light", "dark"];

const ui = await serveUi();
const browser = await chromium.launch({
  headless: !headed,
  // Voice input: Chrome's fake microphone plays speech-like audio; prompts are answered Allow.
  // 10 s looped: talking, a short pause, talking, then 3.5 s quiet (long enough for hands-free voice to end an utterance and send it).
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${writeSpeechLikeWav(join(ui.out, "speech.wav"), { seconds: 10 })}`,
  ],
});
await renderThumbnail(browser);
const h = createChecks({ browser, base: ui.base, only, shots: join(here, "screenshots") });

// The side panel, at each size and scheme.
for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: scheme, deviceScaleFactor: 1 });
    const label = `${size.w} ${scheme}`;
    const t = { ...h, ...panelHelpers(label, h.problem), ctx, size, scheme, label };
    for (const c of [...PANEL_CASES, ...TODO_CASES, ...MEMORY_PANEL_CASES, ...LIST_CASES, ...ATTACHMENT_CASES]) if (c.when ? c.when(t) : h.wantAny(c.names, size, scheme)) await c.run(t);
    await ctx.close();
  }
}

// The options page: each case at each size and scheme, then the interactions.
for (const scheme of SCHEMES) {
  for (const size of OPT_SIZES) {
    for (const [name, kind, hash, edit, checks] of OPTION_CASES) {
      if (!h.want(name, size, scheme)) continue;
      const page = await h.openOptions(size, scheme, kind, hash, edit);
      await h.optChecks(page, `${name} ${size.w} ${scheme}`, checks(page));
      await h.optShot(page, name, size, scheme);
      await page.ctx.close();
    }
  }
}
for (const flow of OPTION_FLOWS) if (h.want(flow.name, flow.size, flow.scheme)) await flow.run(h);
// Settings > Memory: its own sizes (360 too) and flows.
await runMemoryOptions(h);

await browser.close();
ui.close();
console.log(`${h.taken.length} screenshots in ${h.shots}`);
if (h.failures()) {
  console.error(`${h.failures()} problem(s) found, see above`);
  process.exitCode = 1;
}
