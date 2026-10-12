// upload on the places sites take files besides a plain <input type=file>: a dropzone with a hidden input
// (react-dropzone, e.g. CrazyGames' "Upload files"), a drop zone with no input at all, an editor that takes a
// dropped image (Slack, Gmail, Notion), and an editor that only takes a pasted one (a chat box). All through the
// debugger, in the extension (no helper, no other browser).
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/upload-targets.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { driverCall, launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { findIndex } from "../../../test/fixtures/driver-page.mjs";

const PAGE = `<!doctype html><html><head><title>Upload targets</title></head><body>
<h1>Upload targets</h1>
<div id="dz" role="button" tabindex="0" aria-label="Game files dropzone" style="width:300px;height:80px;border:1px dashed">Drop game files
  <input type="file" multiple style="display:none"></div>
<div id="drop" role="button" tabindex="0" aria-label="Drop only zone" style="width:300px;height:80px;border:1px dashed">Drop here</div>
<div id="dropEd" contenteditable="true" aria-label="Drop editor" style="width:300px;height:80px;border:1px solid"></div>
<div id="pasteEd" contenteditable="true" aria-label="Paste editor" style="width:300px;height:80px;border:1px solid"></div>
<p id="plain">Just text</p><a href="#nowhere">A link</a>
<script>
  window.got = {};
  const note = (id, files) => { got[id] = [...files].map((f) => f.name + ":" + f.size + ":" + f.type); };
  const dz = document.getElementById("dz"), input = dz.querySelector("input");
  input.addEventListener("change", () => note("dz", input.files));
  dz.addEventListener("click", () => input.click());
  for (const id of ["dz", "drop", "dropEd"]) {
    const el = document.getElementById(id);
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", (e) => { e.preventDefault(); note(id, e.dataTransfer.files); });
  }
  document.getElementById("pasteEd").addEventListener("paste", (e) => {
    if (!e.clipboardData.files.length) return;
    e.preventDefault(); note("pasteEd", e.clipboardData.files);
  });
</script></body></html>`;

const site = await serveHtml(() => PAGE);
const { step, finish } = createSuite("upload-targets");
const ext = await launchExtension({ name: "upload-targets" });
const { context, sw, profile } = ext;
// A 1x1 PNG, like a screenshot the user attached.
const png = join(profile, "shot.png");
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const zip = join(profile, "game.zip");
writeFileSync(zip, "PK fake zip with index.html");

try {
  const call = driverCall(sw);
  await call("navigate", { url: `${site.base}/` });
  const page = await waitFor(() => context.pages().find((p) => p.url().startsWith(site.base)), "agent tab page");
  const got = () => page.evaluate(() => window.got);
  const at = async (name) => findIndex(await call("readPage"), (e) => e.name === name);

  await step("dropzone with a hidden input takes the files", async () => {
    await call("upload", { index: findIndex(await call("readPage"), (e) => e.type === "file"), paths: [zip] });
    assert.deepEqual((await got()).dz, ["game.zip:27:application/zip"]);
    return (await got()).dz[0];
  });

  await step("the dropzone itself (no input index) takes a drop", async () => {
    await page.evaluate(() => delete window.got.dz);
    assert.equal((await call("upload", { index: await at("Game files dropzone"), paths: [zip] })).via, "drop");
    assert.deepEqual((await got()).dz, ["game.zip:27:application/zip"]);
    return (await got()).dz[0];
  });

  await step("a drop zone with no input takes a drop", async () => {
    assert.equal((await call("upload", { index: await at("Drop only zone"), paths: [png, zip] })).via, "drop");
    assert.deepEqual((await got()).drop, ["shot.png:70:image/png", "game.zip:27:application/zip"]);
    return (await got()).drop.join(", ");
  });

  await step("an editor that takes dropped images gets the image", async () => {
    assert.equal((await call("upload", { index: await at("Drop editor"), paths: [png] })).via, "drop");
    assert.deepEqual((await got()).dropEd, ["shot.png:70:image/png"]);
    return (await got()).dropEd[0];
  });

  await step("an editor that only takes pasted images gets it pasted", async () => {
    assert.equal((await call("upload", { index: await at("Paste editor"), paths: [png] })).via, "paste");
    assert.deepEqual((await got()).pasteEd, ["shot.png:70:image/png"]);
    return (await got()).pasteEd[0];
  });

  await step("an element that takes no files says so, and the tab stays put", async () => {
    const err = await call("upload", { index: await at("A link"), paths: [png] }).catch((e) => e.message);
    assert.match(String(err), /took neither/);
    assert.ok(page.url().startsWith(site.base), `still on the page, not the file: ${page.url()}`);
    return String(err).replace(/^driver\.upload: /, "");
  });
} finally {
  await ext.close();
  await site.close();
}
finish();
