// "Before you start" in the built extension: a fresh install opens the side panel under the screen (the panel inert),
// I understand saves it and the panel is usable, a reopened panel stays clear; a run launched the usual way (the
// launcher marks it understood) never sees it.
// Usage: pnpm build && node apps/extension/test/before-start.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

const { step, finish } = createSuite("before-start");

const screen = (panel) =>
  panel.evaluate(() => {
    const el = document.getElementById("before-start");
    const points = [...el.querySelectorAll(".before-start-point")].map((n) => n.textContent.replace(/\s+/g, " ").trim());
    const link = el.querySelector("a");
    return {
      shown: !el.hidden && el.getBoundingClientRect().height > 0,
      points,
      link: link?.href ?? null,
      inert: ["header", "main", "footer"].every((t) => document.querySelector(t).inert),
      focused: document.activeElement?.id ?? null,
    };
  });
const stored = (sw) => sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.disclaimerAccepted);

const fresh = await launchExtension({ name: "before-start", beforeStart: true });
try {
  const panel = await fresh.context.newPage();
  await panel.goto(`chrome-extension://${fresh.extensionId}/sidepanel.html`);
  await step("a fresh install opens the panel under Before you start, the panel inert", async () => {
    await panel.waitForSelector("#before-start:not([hidden])");
    const s = await screen(panel);
    assert.equal(s.shown, true);
    assert.equal(s.points.length, 3);
    assert.ok(s.points[0].startsWith("Noa can make mistakes."), s.points[0]);
    assert.equal(s.link, "https://noa.bot/safety");
    assert.equal(s.inert, true, "the panel behind it is inert");
    assert.equal(s.focused, "before-start-ok");
    assert.notEqual(await stored(fresh.sw), true);
    return s.points[0].slice(0, 40);
  });
  await step("I understand: saved, the screen gone, the panel usable", async () => {
    await panel.click("#before-start-ok");
    await panel.waitForSelector("#before-start", { state: "hidden" });
    await waitFor(async () => (await stored(fresh.sw)) === true, "disclaimerAccepted saved");
    const s = await screen(panel);
    assert.equal(s.inert, false);
    await panel.fill("#now-text", "typing works");
    assert.equal(await panel.inputValue("#now-text"), "typing works");
  });
  await step("the panel opened again stays clear", async () => {
    await panel.reload();
    await panel.waitForSelector("#job-groups > *", { state: "attached" });
    await panel.waitForTimeout(500);
    assert.equal((await screen(panel)).shown, false);
  });
} finally {
  await fresh.close();
}

const usual = await launchExtension({ name: "before-start-usual" });
try {
  await step("a run launched the usual way never sees the screen", async () => {
    assert.equal(await stored(usual.sw), true);
    const panel = await usual.context.newPage();
    await panel.goto(`chrome-extension://${usual.extensionId}/sidepanel.html`);
    await panel.waitForSelector("#job-groups > *", { state: "attached" });
    await panel.waitForTimeout(500);
    assert.equal((await screen(panel)).shown, false);
  });
} finally {
  await usual.close();
}
finish();
