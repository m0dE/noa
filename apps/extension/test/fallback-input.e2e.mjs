// The input paths of three fixes, in FALLBACK mode (a tab where another extension's frame blocks chrome.debugger, so
// page-input.ts runs through chrome.scripting with simulated events), without an agent:
//   - an empty text empties a prefilled field (search, email, textarea), and other text replaces the value;
//   - a custom dropdown (a button + a role=option list) gets its option chosen in one type call;
//   - the page behind an open modal (aria-modal with a backdrop, and a native <dialog> opened with showModal) is
//     covered: typing and clicks there fail with the covered error and reach nothing; the dialog's own field works.
// Loads the built extension plus test/fixtures/iframe-injector (as foreign-frame.e2e.mjs does). Every step checks that
// the tab really is in fallback mode.
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/fallback-input.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driverCall, launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite } from "../../../test/e2e/lib/suite.mjs";
import { findIndex } from "../../../test/fixtures/driver-page.mjs";

const injector = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "iframe-injector");

const FORMS = `<!doctype html><html><head><meta charset="utf-8"><title>Forms page</title><style>[role=listbox]{list-style:none;border:1px solid #888;padding:0;margin:0}</style></head><body>
<label>Search <input id="q" type="search" value="refund 4471"></label>
<label>Customer <input id="customer" type="email" value="jane@example.com"></label>
<label>Notes <textarea id="notes">old note</textarea></label>
<span id="size-label">Shirt size</span><button type="button" id="size" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="size-label size">Select size</button>
<ul role="listbox" id="size-list" hidden><li role="option" data-v="S">Small</li><li role="option" data-v="L">Large</li><li role="option" data-v="XL">Extra large</li></ul>
<input type="hidden" id="size-value">
<script>
const btn = document.getElementById("size"), list = document.getElementById("size-list");
btn.addEventListener("click", () => { list.hidden = !list.hidden; btn.setAttribute("aria-expanded", String(!list.hidden)); });
list.addEventListener("click", (e) => { const li = e.target.closest("[role=option]"); if (!li) return; document.getElementById("size-value").value = li.dataset.v; btn.textContent = li.textContent; list.hidden = true; btn.setAttribute("aria-expanded", "false"); });
</script></body></html>`;

/** A page with its own field and button behind an open modal; it records what reaches it behind the dialog. */
const modalPage = (kind) => `<!doctype html><html><head><meta charset="utf-8"><title>Modal page</title>
<style>.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:8}.modal{position:fixed;top:80px;left:50%;transform:translateX(-50%);width:400px;background:#fff;padding:16px;z-index:9}</style></head><body>
<label>Email for invoices <input id="behind-email" value="old@example.com"></label> <button id="behind-save">Save</button>
${kind === "native" ? '<dialog id="dlg" aria-label="Add contact">' : '<div class="backdrop"></div><div id="dlg" class="modal" role="dialog" aria-modal="true" aria-label="Add contact">'}
<label>Contact email <input id="dlg-email"></label> <button id="dlg-add">Add</button>${kind === "native" ? "</dialog>" : "</div>"}
<script>
window.__behind = [];
const dlg = document.getElementById("dlg");
for (const t of ["pointerdown", "click", "focusin", "input"]) document.addEventListener(t, (e) => { if (!dlg.contains(e.target) && !(e.target.classList && e.target.classList.contains("backdrop"))) window.__behind.push(t + ":" + (e.target.id || e.target.tagName)); }, true);
${kind === "native" ? "dlg.showModal();" : ""}
</script></body></html>`;

const PAGES = { "/forms": FORMS, "/modal-aria": modalPage("aria"), "/modal-native": modalPage("native") };
const site = await serveHtml((path) => PAGES[path] ?? "<!doctype html><title>Start</title><p>start</p>");
const { base } = site;

const { step, finish } = createSuite("fallback-input");
const ext = await launchExtension({ name: "fallback-input", extensions: [injector] });
const { context, sw } = ext;

try {
  const call = driverCall(sw);
  const inFallback = () => sw.evaluate(() => globalThis.__noa.driver.inFallback);
  const page = await context.newPage();
  await page.goto(`${base}/start`);
  await page.bringToFront();
  await sw.evaluate(() => globalThis.__noa.agentTab.prepare("current-tab"));

  /** Navigates the run's tab and reads it once the injector's frame is there (it comes at document_idle). */
  const open = async (path) => {
    await call("navigate", { url: `${base}${path}` });
    await page.waitForSelector("#foreign-extension-frame");
    const snap = await call("readPage");
    assert.equal(await inFallback(), true, "the tab is in fallback mode");
    return snap;
  };

  await step("fallback: empty text empties a prefilled field (search, email, textarea); other text replaces the value", async () => {
    const s = await open("/forms");
    const by = (name) => findIndex(s, (e) => e.name === name);
    for (const name of ["Search", "Customer", "Notes"]) await call("type", { index: by(name), text: "" });
    assert.deepEqual(await page.evaluate(() => ["q", "customer", "notes"].map((id) => document.getElementById(id).value)), ["", "", ""]);
    await call("type", { index: by("Customer"), text: "bob@example.com" });
    assert.equal(await page.evaluate(() => document.getElementById("customer").value), "bob@example.com");
    return "search, email, textarea emptied; email replaced";
  });

  await step("fallback: a custom dropdown (button + role=option list) gets its option chosen in one type call", async () => {
    const s = await call("readPage");
    const r = await call("type", { index: findIndex(s, (e) => /Shirt size/.test(e.name)), text: "Large" });
    assert.equal(r.selected, "Large");
    assert.equal(await page.evaluate(() => document.getElementById("size-value").value), "L");
    return JSON.stringify(r);
  });

  for (const kind of ["aria", "native"]) {
    await step(`fallback: the page behind an open ${kind} modal is covered: typing and clicks there fail and reach nothing; the dialog's own field works`, async () => {
      const s = await open(`/modal-${kind}`);
      const typed = await call("type", { index: findIndex(s, (e) => e.name === "Email for invoices"), text: "ap@example.com" }).catch((e) => e.message);
      assert.match(String(typed), /is behind the open dialog "Add contact"/);
      const clicked = await call("click", { index: findIndex(s, (e) => e.name === "Save") }).catch((e) => e.message);
      assert.match(String(clicked), /is behind the open dialog "Add contact"/);
      await call("type", { index: findIndex(s, (e) => e.name === "Contact email"), text: "ap@example.com" });
      const seen = await page.evaluate(() => ({ behind: window.__behind, field: document.getElementById("behind-email").value, dialog: document.getElementById("dlg-email").value }));
      assert.deepEqual(seen, { behind: [], field: "old@example.com", dialog: "ap@example.com" });
      return String(typed).replace(/^.*Error: /, "").slice(0, 70);
    });
  }
} finally {
  await ext.close();
  await site.close();
}

finish();
