// Smoke test of the built extension in Playwright's Chromium.
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/smoke.e2e.mjs [--headed]
// The helper is not needed: without one the status shows no brain (a helper registered on this
// machine is tolerated: Auto may then pick its Claude Code).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverCall, EXTENSION_ID, launchExtension, pageUi, routerUi } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { driverPage, fillSignupForm, findIndex, OTHER_PAGE } from "../../../test/fixtures/driver-page.mjs";

const site = await serveHtml((path) => (path === "/other" ? OTHER_PAGE : driverPage({ title: "Smoke fixture", heading: "Driver smoke page" })));
const { base } = site;

const { step, finish } = createSuite("smoke");
const ext = await launchExtension({ name: "smoke" });
const { context, sw, extensionId, profile } = ext;
const uploadFile = join(profile, "upload-me.txt");
writeFileSync(uploadFile, "hello upload");

try {
  await step("extension loads with the pinned ID", async () => {
    assert.equal(extensionId, EXTENSION_ID);
    const hook = await sw.evaluate(() => Object.keys(globalThis.__noa ?? {}));
    for (const k of ["driver", "runner", "localStore", "sessions", "helper", "settings"]) assert.ok(hook.includes(k), `hook has ${k}`);
    return extensionId;
  });

  await step("alarm scheduled on install", async () => {
    const alarm = await sw.evaluate(() => chrome.alarms.get("noa-run"));
    assert.equal(alarm?.periodInMinutes, 15);
    return `period ${alarm.periodInMinutes} min`;
  });

  // UI protocol requests, sent from an extension page like the side panel does.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const ui = pageUi(page);

  await step("state.get without helper or key: no brain, helper error shown", async () => {
    const { brain, settings } = await ui({ type: "state.get" });
    assert.equal(settings.brain, "auto");
    if (brain.helper) {
      // A helper is registered on this machine (a developer's own install): Auto may pick its Claude Code.
      assert.ok(brain.effective === "claude-code" || (brain.effective === null && brain.note), JSON.stringify(brain));
      return `helper ${brain.helper.version} registered on this machine: ${brain.effective ?? brain.note}`;
    }
    assert.equal(brain.effective, null);
    assert.ok(brain.note, "has a note");
    return brain.note.slice(0, 120);
  });

  await step("settings.save: partial update, secrets redacted, alarm rescheduled", async () => {
    const state = await ui({ type: "settings.save", settings: { anthropicApiKey: "sk-smoke", intervalMinutes: 30, delayMinSec: 0, delayMaxSec: 1 } });
    assert.equal(state.settings.anthropicApiKey, "set");
    // Auto prefers a connected helper's Claude Code over the key (a helper registered on this machine).
    const { effective, helper } = state.brain;
    assert.ok(effective === "claude-api" || (helper && effective === "claude-code"), `brain ${effective}`);
    const stored = await sw.evaluate(() => chrome.storage.local.get("settings"));
    assert.equal(stored.settings.anthropicApiKey, "sk-smoke");
    // The alarm follows the saved settings (storage.onChanged).
    await waitFor(async () => (await sw.evaluate(() => chrome.alarms.get("noa-run")))?.periodInMinutes === 30, "the alarm to run every 30 min");
    await ui({ type: "settings.save", settings: { anthropicApiKey: "" } });
    return "key set then cleared, interval 30";
  });

  await step("tasks.add / tasks.list with a file stored in IndexedDB", async () => {
    const { task } = await ui({
      type: "tasks.add",
      instructions: "smoke task",
      notBefore: new Date(Date.now() + 3600_000).toISOString(),
      media: [{ name: "note.txt", type: "text/plain", dataBase64: Buffer.from("hello media").toString("base64") }],
    });
    const { tasks } = await ui({ type: "tasks.list" });
    const t = tasks.find((x) => x.id === task.id);
    assert.deepEqual(t.media.map((m) => [m.name, m.size]), [["note.txt", 11]]);
    const due = await sw.evaluate(() => chrome.alarms.get("noa-due"));
    assert.ok(due, "due alarm scheduled for the task's time");
    return `${tasks.length} task(s), due alarm at ${new Date(due.scheduledTime).toISOString()}`;
  });

  await step("a job is paused on its own and resumed at its time; nothing pauses every run", async () => {
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const { task } = await ui({ type: "tasks.add", instructions: "smoke pause", notBefore: at });
    const { task: paused } = await ui({ type: "tasks.pause", id: task.id });
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "Paused by you");
    const { task: resumed } = await ui({ type: "tasks.resume", id: task.id });
    assert.deepEqual([resumed.status, resumed.notBefore], ["pending", at]);
    const state = await ui({ type: "state.get" });
    assert.equal("paused" in state, false, "the state has no pause of every run");
    assert.equal("paused" in (await sw.evaluate(() => chrome.storage.local.get("settings"))).settings, false, "the settings have no pause of every run");
    const old = await sw.evaluate((m) => globalThis.__noa.router.handle(m), { type: "schedule.pause" });
    assert.equal(old.ok, false, "schedule.pause is gone");
    await ui({ type: "tasks.delete", id: task.id });
    return "pause / resume / no global pause";
  });

  await step("the side panel: Home | Scheduled beside the search; the scheduled view lists the waiting task with Pause", async () => {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.waitForSelector("#view-list:not([hidden]) #job-groups > *", { state: "attached", timeout: 20_000 });
    const tabs = await panel.evaluate(() => [...document.querySelectorAll("#job-views [role=tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected")]));
    assert.deepEqual(tabs, [["Home", "true"], ["Scheduled", "false"]]);
    assert.equal(await panel.locator("#acct-pause").count(), 0, "no Pause scheduled runs in the account menu");
    await panel.click("#view-scheduled");
    await panel.waitForSelector('#job-groups .job-row:has-text("smoke task")', { timeout: 20_000 });
    const toggle = await panel.textContent('li:has(.job-row:has-text("smoke task")) .job-toggle');
    assert.equal(toggle, "Pause");
    const stored = await panel.evaluate(() => sessionStorage.getItem("noa.jobs.view"));
    assert.equal(stored, "scheduled");
    await panel.close();
    return "views ok";
  });

  await step("run.due with no brain records lastError and does not run", async () => {
    // Claude API mode without a key: no brain, whatever helper is installed on this machine.
    await ui({ type: "settings.save", settings: { brain: "claude-api" } });
    await ui({ type: "tasks.add", instructions: "due now" });
    const r = await ui({ type: "run.due" });
    assert.equal(r.started, true);
    await sw.evaluate(() => globalThis.__noa.runner.idle());
    const state = await ui({ type: "state.get" });
    assert.ok(state.lastError, "lastError set");
    const { tasks } = await ui({ type: "tasks.list" });
    assert.equal(tasks.find((t) => t.instructions === "due now").status, "pending");
    return state.lastError.slice(0, 120);
  });

  await step("vault via background requests, getCredential", async () => {
    const send = routerUi(sw);
    assert.deepEqual(await send({ type: "vault.unlock", passphrase: "smoke passphrase" }), { ok: true });
    await send({ type: "vault.set", site: "example.com", username: "alice", password: "pw1" });
    const cred = await sw.evaluate(() => globalThis.__noa.vault.getCredential("login.example.com"));
    assert.deepEqual(cred, { found: true, username: "alice", password: "pw1" });
    await send({ type: "vault.lock" });
    // A forgotten passphrase: a wrong one is an answer, and erasing is the way out.
    assert.deepEqual(await send({ type: "vault.unlock", passphrase: "forgotten" }), { ok: false });
    assert.deepEqual(await send({ type: "vault.reset" }), { ok: true });
    assert.deepEqual(await send({ type: "vault.list" }), { exists: false, locked: true, sites: [] });
    assert.deepEqual(await sw.evaluate(() => globalThis.__noa.vault.getCredential("login.example.com")), { found: false });
    assert.deepEqual(await send({ type: "vault.unlock", passphrase: "a new passphrase" }), { ok: true });
    await send({ type: "vault.lock" });
    return "parent-domain match ok, lock ok, wrong passphrase and reset ok";
  });

  let materializedPath = null;
  await step("media materialization writes a real file with chrome.downloads", async () => {
    const out = await sw.evaluate(async () => {
      const m = await globalThis.__noa.media.materialize("smoke-session", [
        { kind: "blob", name: "upload-me.txt", blob: new Blob(["hello upload"], { type: "text/plain" }) },
      ]);
      globalThis.__smokeMedia = m;
      return m.paths;
    });
    assert.equal(out.length, 1);
    assert.ok(existsSync(out[0]), `file exists: ${out[0]}`);
    assert.equal(readFileSync(out[0], "utf8"), "hello upload");
    materializedPath = out[0];
    return out[0];
  });

  // Driver against the fixture page, in the agent tab.
  const call = driverCall(sw);

  const counts = () =>
    sw.evaluate(async () => ({ windows: (await chrome.windows.getAll()).length, tabs: (await chrome.tabs.query({})).length }));

  await step("one-off run on an extension page opens a grouped tab next to it, same window", async () => {
    await page.bringToFront();
    const before = await counts();
    const out = await sw.evaluate(async () => {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tabId = await globalThis.__noa.agentTab.prepare("current-tab");
      const tab = await chrome.tabs.get(tabId);
      const group = tab.groupId !== -1 ? await chrome.tabGroups.get(tab.groupId) : null;
      return { activeUrl: active.url, activeIndex: active.index, activeWindow: active.windowId, tab, group };
    });
    const after = await counts();
    assert.match(out.activeUrl, /^chrome-extension:\/\//);
    assert.equal(out.tab.windowId, out.activeWindow, "same window");
    assert.equal(out.tab.index, out.activeIndex + 1, "right after the active tab");
    assert.equal(out.tab.active, true);
    assert.equal(out.group?.title, "Noa");
    // Nothing runs (prepare called directly): the idle look (control-indicator.ts).
    assert.equal(out.group?.color, "grey");
    assert.equal(after.windows, before.windows, "no new window");
    assert.equal(after.tabs, before.tabs + 1);
    return `tab ${out.tab.id} at index ${out.tab.index} in group "${out.group.title}"`;
  });

  await step("navigate runs in the agent tab", async () => {
    const before = await counts();
    const nav = await call("navigate", { url: `${base}/` });
    assert.equal(nav.title, "Smoke fixture");
    const after = await counts();
    assert.deepEqual(after, before, "no new window or tab");
    const attached = await sw.evaluate(async () => [globalThis.__noa.cdp.attachedTabId, await globalThis.__noa.agentTab.tabId()]);
    assert.equal(attached[0], attached[1], "debugger attached to the agent tab");
    return nav.url;
  });

  let snap;
  await step("readPage lists interactive elements", async () => {
    snap = await call("readPage");
    const names = snap.elements.map((e) => `${e.role}:${e.name}`);
    assert.ok(names.includes("link:Other page"), names.join(" | "));
    assert.ok(names.includes("button:Increment"));
    assert.ok(names.includes("textbox:Your name"));
    assert.ok(names.includes("textbox:Compose text"));
    assert.ok(snap.elements.some((e) => e.type === "file"), "hidden file input included");
    assert.ok(!names.some((n) => n.includes("Invisible")), "display:none button skipped");
    assert.ok(!snap.elements.some((e) => e.type === "hidden"));
    assert.equal(snap.elements.find((e) => e.role === "link").testId, "other-link");
    assert.ok(snap.text.includes("Driver smoke page"));
    return `${snap.elements.length} elements: ${names.join(", ")}`;
  });

  await step("click is a trusted click", async () => {
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    const s = await call("readPage");
    assert.match(s.text, /Count: 2/);
    return "count 2";
  });

  await step("type into input and contenteditable", async () => {
    snap = await call("readPage");
    await call("type", { index: findIndex(snap, (e) => e.name === "Your name"), text: "Ada" });
    await call("type", { index: findIndex(snap, (e) => e.name === "Compose text"), text: "Hello from Noa" });
    const s = await call("readPage");
    assert.equal(s.elements.find((e) => e.name === "Your name").value, "Ada");
    assert.ok(s.text.includes("Hello from Noa"), s.text);
    return "input value Ada, editor text set";
  });

  await step("paste and pressKey", async () => {
    await call("paste", { text: "!" });
    await call("pressKey", { key: "Control+a" });
    let s = await call("readPage");
    assert.match(s.text, /Last key: Control\+a/);
    await call("pressKey", { key: "Escape" });
    s = await call("readPage");
    assert.match(s.text, /Last key: Escape/);
    assert.ok(s.text.includes("Hello from Noa!"), "paste appended at caret");
    return "Control+a and Escape seen by the page";
  });

  await step("a form: dropdown chosen by label, checkbox set (not toggled), field replaced on retype", () => fillSignupForm(call, assert));

  await step("scroll moves the page and reports how far", async () => {
    const r = await call("scroll", { direction: "down", amount: 1 });
    const s = await call("readPage");
    const y = Number(/ScrollY: (\d+)/.exec(s.text)?.[1]);
    assert.ok(y > 300, `scrollY ${y}`);
    const page = await sw.evaluate(async () => {
      const tabId = await globalThis.__noa.agentTab.tabId();
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ h: document.documentElement.scrollHeight, view: document.documentElement.clientHeight }),
      });
      return res.result;
    });
    assert.equal(r.target, "page", JSON.stringify(r));
    assert.equal(r.moved, y, `moved ${r.moved} vs scrollY ${y}`);
    assert.equal(r.position, y);
    assert.equal(r.size, page.h);
    assert.equal(r.view, page.view);
    assert.equal(r.reason, undefined);
    return `moved ${r.moved} px, now ${r.position} of ${r.size} (view ${r.view})`;
  });

  await step("scroll at the bottom reports that nothing moved", async () => {
    const toEnd = await call("scroll", { direction: "down", amount: 20 });
    assert.ok(toEnd.moved > 0, JSON.stringify(toEnd));
    assert.ok(toEnd.position >= toEnd.size - toEnd.view - 1, `at the end: ${JSON.stringify(toEnd)}`);
    const r = await call("scroll", { direction: "down", amount: 1 });
    assert.equal(r.moved, 0, JSON.stringify(r));
    assert.equal(r.reason, "end");
    assert.equal(r.target, "page");
    const top = await call("scroll", { direction: "up", amount: 20 });
    assert.equal(top.position, 0, JSON.stringify(top));
    return `bottom at ${r.position} of ${r.size}; back to top`;
  });

  await step("upload sets files on a hidden file input", async () => {
    snap = await call("readPage");
    await call("upload", { index: findIndex(snap, (e) => e.type === "file"), paths: [uploadFile] });
    const s = await call("readPage");
    assert.match(s.text, /Files: upload-me\.txt:12/);
    const err = await call("upload", { index: findIndex(snap, (e) => e.role === "link"), paths: [uploadFile] }).catch((e) => e.message);
    assert.match(String(err), /not a file input/);
    return "upload-me.txt:12";
  });

  await step("upload works with a materialized path, which cleanup removes", async () => {
    if (!materializedPath) throw new Error("no materialized file");
    snap = await call("readPage");
    await call("upload", { index: findIndex(snap, (e) => e.type === "file"), paths: [materializedPath] });
    const s = await call("readPage");
    assert.match(s.text, /Files: \S*:12/);
    await sw.evaluate(() => globalThis.__smokeMedia.cleanup());
    assert.ok(!existsSync(materializedPath), "file removed");
    return /Files: (\S*)/.exec(s.text)?.[1];
  });

  await step("click on a stale index errors clearly", async () => {
    const err = await call("click", { index: 999 }).catch((e) => e.message);
    assert.match(String(err), /element 999 not found; call read_page again/);
  });

  await step("screenshot returns a JPEG", async () => {
    const shot = await call("screenshot");
    assert.equal(shot.mimeType, "image/jpeg");
    const buf = Buffer.from(shot.base64, "base64");
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    const out = join(tmpdir(), "noa-smoke-shot.jpg");
    writeFileSync(out, buf);
    return `${buf.length} bytes -> ${out}`;
  });

  await step("navigate by clicking a link, then currentUrl", async () => {
    snap = await call("readPage");
    await call("click", { index: findIndex(snap, (e) => e.role === "link") });
    const url = await waitFor(async () => {
      const { url } = await call("currentUrl");
      return url === `${base}/other` && url;
    }, "the link's page");
    return url;
  });

  await step("scheduled runs reuse the agent tab", async () => {
    const before = await counts();
    const [a, b] = await sw.evaluate(async () => [await globalThis.__noa.agentTab.tabId(), await globalThis.__noa.agentTab.prepare("own-tab")]);
    assert.equal(b, a);
    await call("navigate", { url: `${base}/` });
    assert.deepEqual(await counts(), before);
  });

  await step("one-off run on the user's page acts on that tab; closing it fails the next call", async () => {
    const userPage = await context.newPage();
    await userPage.goto(`${base}/other`);
    await userPage.bringToFront();
    const out = await sw.evaluate(async () => {
      const tabId = await globalThis.__noa.agentTab.prepare("current-tab");
      await globalThis.__noa.driver.ready();
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url, group: tab.groupId !== -1 ? (await chrome.tabGroups.get(tab.groupId)).title : null, groups: (await chrome.tabGroups.query({ title: "Noa" })).length };
    });
    assert.equal(out.url, `${base}/other`);
    assert.equal(out.group, "Noa");
    assert.equal(out.groups, 1, "reuses the existing Noa group");
    const snap = await call("readPage");
    assert.ok(snap.text.includes("other page"), snap.text);
    await userPage.close();
    await assert.rejects(call("readPage"), /the agent tab was closed/);
    return "user tab driven, closed-tab error readable";
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
