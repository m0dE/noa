// browser.type and browser.pressKey on real rich-text editors (ProseMirror, Tiptap, Lexical, Quill, Slate), through the
// built extension, in both drivers: the debugger (a page without another extension's frame) and the fallback
// (test/fixtures/iframe-injector adds its frame, which blocks chrome.debugger). Each editor starts with two paragraphs.
// What the editor holds is read from its own model (its API), and from its DOM. For each:
//   - real keystrokes (Playwright's, trusted) change its model: the page works;
//   - an empty text empties it, model and DOM, and the result says ok;
//   - text typed into it afterwards is all it holds;
//   - keys pressed then (Backspace, Enter, a character) edit it;
//   - text typed into the prefilled editor goes at the end.
// The editors are bundled in test/fixtures/editors/editors.js (built by build.sh there, one copy of each dependency).
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/editors.e2e.mjs [--headed] [--only <editor>] [--json <file>]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driverCall, launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { findIndex } from "../../../test/fixtures/driver-page.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const injector = join(fixtures, "iframe-injector");
const bundle = readFileSync(join(fixtures, "editors", "editors.js"));

const EDITORS = ["prosemirror", "tiptap", "lexical", "quill", "slate"];
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const only = arg("--only");
const jsonOut = arg("--json");
const PARAGRAPHS = ["Quarterly report draft", "Numbers are still missing"];
const FULL = PARAGRAPHS.join("\n");
const LABEL = "Notes";

/** An editor's page; with `clean`, the injector leaves it alone (the debugger drives it), else it adds its frame. */
const editorPage = (name, clean) => `<!doctype html><html><head><meta charset="utf-8">${clean ? '<meta name="no-inject">' : ""}<title>${name} editor</title>
<style>#ed{border:1px solid #888;padding:4px;width:600px}#ed [contenteditable]{outline:none;min-height:60px;white-space:pre-wrap}</style></head><body>
<h1>${name}</h1><div id="ed"></div>
<script src="/editors.js"></script>
<script>window.ed = NoaTestEditors.mount(${JSON.stringify(name)}, document.getElementById("ed"), ${JSON.stringify(PARAGRAPHS)}, ${JSON.stringify(LABEL)});</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/editors.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(bundle);
  }
  const [, name, mode] = url.pathname.split("/");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(EDITORS.includes(name) ? editorPage(name, mode === "cdp") : "<!doctype html><title>Start</title><p>start</p>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const { step, finish } = createSuite("editors");
const ext = await launchExtension({ name: "editors", extensions: [injector] });
const { context, sw } = ext;
/** What each step saw, one row per editor and driver (--json). */
const rows = [];

try {
  const call = driverCall(sw);
  const inFallback = () => sw.evaluate(() => globalThis.__noa.driver.inFallback);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/start`);
  await page.bringToFront();
  await sw.evaluate(() => globalThis.__noa.agentTab.prepare("current-tab"));

  /** The editor's own model text (its API; paragraphs joined by "\n"), and its editable element's text. */
  const state = () =>
    page.evaluate((label) => {
      const el = document.querySelector(`[aria-label="${label}"]`);
      return { model: window.ed.text(), dom: el.innerText.replace(/[\s​﻿]+/g, " ").trim() };
    }, LABEL);
  /** The state once `want` holds (an editor may render a moment later), or as it is after 2 s. */
  const settled = (want) => waitFor(async () => ((s) => (want(s) ? s : null))(await state()), "the editor's text", { timeout: 2000 }).catch(() => state());
  const domOf = (model) => model.replace(/\s+/g, " ").trim();
  /** The editor's number from read_page. */
  const editorIndex = async () => findIndex(await call("readPage"), (e) => e.name === LABEL);
  /** A driver call's result, or its error's message. */
  const outcome = (p) => p.then((r) => r, (e) => ({ error: e.message.replace(/^.*?Error: /, "").slice(0, 200) }));

  /** Opens the editor's page in the run's tab, in the mode asked for; returns the editor's element number. */
  const open = async (name, mode) => {
    errors.length = 0;
    await call("navigate", { url: `${base}/${name}/${mode}` });
    if (mode === "fb") await page.waitForSelector("#foreign-extension-frame");
    await waitFor(() => page.evaluate(() => !!window.ed && window.ed.text().length > 0), `${name} mounted`);
    const index = await editorIndex();
    assert.equal(await inFallback(), mode === "fb", `the tab is ${mode === "fb" ? "in fallback mode" : "driven by the debugger"}`);
    return index;
  };

  for (const name of EDITORS.filter((e) => !only || e === only)) {
    await step(`${name}: real keystrokes change its own model (the page works)`, async () => {
      await open(name, "cdp");
      await page.click(`[aria-label="${LABEL}"] >> text=${PARAGRAPHS[1]}`);
      await page.keyboard.press("End");
      await page.keyboard.type(" X");
      const s = await settled((s) => s.model.endsWith(" X"));
      assert.equal(s.model, `${FULL} X`);
      assert.deepEqual(errors, []);
      return JSON.stringify(s.model);
    });
    for (const mode of ["cdp", "fb"]) {
      const row = { editor: name, driver: mode === "cdp" ? "debugger" : "fallback" };
      rows.push(row);
      await step(`${name} (${row.driver}): an empty text empties model and DOM; text typed after is all it holds; keys edit it`, async () => {
        row.empty = await outcome(call("type", { index: await open(name, mode), text: "" }));
        Object.assign(row.empty, await settled((s) => !s.model && !s.dom));
        // Its number may change once emptied: read again.
        row.fresh = await outcome(call("type", { index: await editorIndex(), text: "Fresh text" }));
        Object.assign(row.fresh, await settled((s) => s.model === "Fresh text" && s.dom === "Fresh text"));
        for (const key of ["Backspace", "Enter", "x"]) await call("pressKey", { key });
        row.keys = await settled((s) => s.model === "Fresh tex\nx");
        row.pageErrors = [...errors];
        assert.deepEqual(row.empty, { ok: true, model: "", dom: "" }, "emptied");
        assert.deepEqual(row.fresh, { ok: true, model: "Fresh text", dom: "Fresh text" }, "typed after");
        assert.deepEqual(row.keys, { model: "Fresh tex\nx", dom: "Fresh tex x" }, "keys");
        assert.deepEqual(errors, []);
        return `emptied; "Fresh text" typed; keys: ${JSON.stringify(row.keys.model)}`;
      });
      await step(`${name} (${row.driver}): text typed into it prefilled goes at the end`, async () => {
        row.append = await outcome(call("type", { index: await open(name, mode), text: " added" }));
        Object.assign(row.append, await settled((s) => s.model === `${FULL} added`));
        assert.deepEqual(row.append, { ok: true, model: `${FULL} added`, dom: domOf(`${FULL} added`) });
        assert.deepEqual(errors, []);
        return JSON.stringify(row.append.model);
      });
    }
  }
} finally {
  await ext.close();
  server.close();
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
}

finish();
