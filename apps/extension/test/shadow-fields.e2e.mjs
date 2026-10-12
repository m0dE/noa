// Fields inside web components' open shadow roots (Reddit's submit form, Salesforce, many design systems):
// read_page lists them, and click, type and upload reach them. Through the debugger, in the extension (no helper).
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/shadow-fields.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { driverCall, launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite } from "../../../test/e2e/lib/suite.mjs";
import { findIndex } from "../../../test/fixtures/driver-page.mjs";

const PAGE = `<!doctype html><html><head><title>New message</title></head><body>
<h1>New message</h1>
<text-field id="subject" label="Subject"></text-field>
<attach-box></attach-box>
<div id="body" contenteditable="true" role="textbox" aria-label="Message body" style="width:400px;height:80px;border:1px solid"></div>
<script>
  window.got = {};
  customElements.define("text-field", class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<span id="lbl">' + this.getAttribute("label") + '</span><textarea aria-labelledby="lbl" required rows="1"></textarea>';
      root.querySelector("textarea").addEventListener("input", (e) => { got.subject = e.target.value; });
    }
  });
  // A component inside a component: its button and file input are two shadow roots deep.
  customElements.define("attach-box", class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<inner-attach></inner-attach>';
    }
  });
  customElements.define("inner-attach", class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<button type="button">Add link</button><input type="file" aria-label="Attach file">';
      root.querySelector("button").addEventListener("click", () => { got.clicked = (got.clicked || 0) + 1; });
      root.querySelector("input").addEventListener("change", (e) => { got.file = [...e.target.files].map((f) => f.name); });
    }
  });
</script></body></html>`;

const site = await serveHtml(() => PAGE);
const { step, finish } = createSuite("shadow-fields");
const ext = await launchExtension({ name: "shadow-fields" });
const { context, sw, profile } = ext;
const file = join(profile, "notes.txt");
writeFileSync(file, "notes");

try {
  const call = driverCall(sw);
  await call("navigate", { url: `${site.base}/` });
  const page = context.pages().find((p) => p.url().startsWith(site.base));
  const got = () => page.evaluate(() => window.got);
  const at = async (name) => findIndex(await call("readPage"), (e) => e.name === name);

  await step("read_page lists the fields in shadow roots, named by their label there, in page order", async () => {
    const snap = await call("readPage");
    const names = snap.elements.map((e) => e.name);
    assert.deepEqual(names, ["Subject", "Add link", "Attach file", "Message body"], JSON.stringify(snap.elements));
    assert.equal(snap.elements[0].role, "textbox");
    assert.equal(snap.elements[0].required, true);
    return names.join(", ");
  });

  await step("typing into the shadow field fills it (and replaces what was there)", async () => {
    await call("type", { index: await at("Subject"), text: "First try" });
    await call("type", { index: await at("Subject"), text: "Weekly sync moved to Friday" });
    assert.equal((await got()).subject, "Weekly sync moved to Friday");
    const snap = await call("readPage");
    assert.equal(snap.elements.find((e) => e.name === "Subject").value, "Weekly sync moved to Friday");
    return (await got()).subject;
  });

  await step("a button two shadow roots deep is clicked", async () => {
    await call("click", { index: await at("Add link") });
    assert.equal((await got()).clicked, 1);
    return "clicked";
  });

  await step("a file input two shadow roots deep takes the file", async () => {
    await call("upload", { index: await at("Attach file"), paths: [file] });
    assert.deepEqual((await got()).file, ["notes.txt"]);
    return (await got()).file[0];
  });

  await step("the light-DOM editor still takes text", async () => {
    await call("type", { index: await at("Message body"), text: "See you there" });
    assert.equal(await page.evaluate(() => document.getElementById("body").textContent), "See you there");
    return "typed";
  });
} finally {
  await ext.close();
  await site.close();
}
finish();
