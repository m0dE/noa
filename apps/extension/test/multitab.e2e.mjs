// Multi-tab check of the built extension in Playwright's Chromium: opens 5 local
// pages in parallel tabs, reads them all at once without activating them,
// switches, screenshots a background tab (left in the background), closes, and compares the wall time
// with the one-tab way (navigate + read_page, page after page).
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/multitab.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { driverCall, launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, sleep } from "../../../test/e2e/lib/suite.mjs";

/** Polls until check() is true (at most 5 s). */
async function waitForValue(check) {
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(100)) if (await check()) return;
  throw new Error("timed out");
}

const PAGES = 5;
/** Server latency per page, like a real site (Gmail takes far longer). */
const PAGE_DELAY_MS = 400;

/** The web-app pages: server latency, then the time the page's script takes to draw its content. */
const APP_SERVER_MS = 1000;
const APP_DRAW_MS = 1200;

/** Forms submitted on the page a button opens in a new tab (like X's "Generate with Grok"). */
const submitted = [];
const site = await serveHtml(async (path) => {
  if (path === "/compose") {
    return `<!doctype html><title>Compose</title><h1>Compose</h1><button onclick="window.open('/generate', '_blank')">Generate with Grok</button>`;
  }
  if (path.startsWith("/generated")) {
    submitted.push(new URL(path, "http://x").searchParams.get("prompt"));
    return `<!doctype html><title>Generated</title><h1>Here is your image</h1>`;
  }
  if (path.startsWith("/generate")) {
    return `<!doctype html><title>Generate image</title><h1>Generate an image</h1><form action="/generated" method="get"><label>Prompt <input name="prompt"></label><button>Generate</button></form>`;
  }
  // A web app like X: the server answers late (the tab is loading), then the page draws its content later still.
  const app = /^\/app\/(\d+)/.exec(path);
  if (app) {
    await sleep(APP_SERVER_MS);
    const n = app[1];
    return `<!doctype html><title></title><div id="root"><svg width="40" height="40"></svg></div><script>
      setTimeout(() => { document.title = "Profile ${n}"; document.getElementById("root").innerHTML = '<h1>Profile ${n}</h1><p>Posts of account ${n}: 1,234 posts, joined 2019.</p><a href="#posts">Posts</a><a href="#replies">Replies</a><button>Follow</button>'; }, ${APP_DRAW_MS});
    </script>`;
  }
  // A web app that never draws (its content never comes).
  if (path === "/stuck-app") return `<!doctype html><title></title><div id="root"><svg width="40" height="40"></svg></div>`;
  const m = /^\/mail\/(\d+)/.exec(path);
  if (!m) {
    const links = Array.from({ length: PAGES }, (_, i) => `<li><a href="/mail/${i + 1}">Message ${i + 1}</a></li>`).join("");
    return `<!doctype html><title>Inbox</title><h1>Search results</h1><ul>${links}</ul>`;
  }
  await sleep(PAGE_DELAY_MS);
  const n = m[1];
  return `<!doctype html><title>Message ${n}</title><h1>Message ${n}</h1><p>Body of message ${n}: the invoice number is INV-${n}00.</p>
      <button onclick="document.title='clicked ${n}'">Reply</button>`;
});
const { base } = site;
const urls = Array.from({ length: PAGES }, (_, i) => `${base}/mail/${i + 1}`);

const { step, finish } = createSuite("multi-tab");
const ext = await launchExtension({ name: "multitab" });
const { context, sw } = ext;

try {
  const call = driverCall(sw);
  const evalSw = (fn, arg) => sw.evaluate(fn, arg);

  const userPage = await context.newPage();
  await userPage.goto(`${base}/`);
  await userPage.bringToFront();
  const mainTab = await evalSw(async () => {
    const id = await globalThis.__noa.agentTab.prepare("current-tab");
    await globalThis.__noa.driver.ready();
    return id;
  });
  const tabCount = () => evalSw(async () => (await chrome.tabs.query({})).length);
  const baseTabs = await tabCount();

  let sequentialMs = 0;
  await step(`sequential: navigate + read_page for ${PAGES} pages in one tab`, async () => {
    const t0 = Date.now();
    for (const url of urls) {
      await call("navigate", { url });
      const snap = await call("readPage");
      assert.match(snap.text, /the invoice number is INV-\d00/);
    }
    sequentialMs = Date.now() - t0;
    await call("navigate", { url: `${base}/` });
    return `${sequentialMs} ms`;
  });

  let parallelMs = 0;
  let opened;
  await step(`parallel: open_tabs(${PAGES}) + one multi-tab read`, async () => {
    const t0 = Date.now();
    opened = await call("openTabs", { urls });
    const snaps = await evalSw(
      (ids) => Promise.all(ids.map((tab) => globalThis.__noa.driver.readPage({ tab }))),
      opened.tabs.map((t) => t.id),
    );
    parallelMs = Date.now() - t0;
    assert.deepEqual(
      opened.tabs.map((t) => [t.id, t.title, t.current, t.error ?? null]),
      urls.map((_, i) => [`t${i + 2}`, `Message ${i + 1}`, false, null]),
    );
    snaps.forEach((s, i) => assert.ok(s.text.includes(`INV-${i + 1}00`), `tab t${i + 2} text: ${s.text}`));
    return `${parallelMs} ms`;
  });

  await step("reading did not activate the tabs; all are in the Noa group; several tabs attached", async () => {
    const out = await evalSw(async (main) => {
      const bt = globalThis.__noa;
      const ids = await bt.agentTab.tabIds();
      const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      const groups = await Promise.all(tabs.map((t) => (t.groupId === -1 ? null : chrome.tabGroups.get(t.groupId).then((g) => g.title))));
      return { mainActive: (await chrome.tabs.get(main)).active, active: tabs.filter((t) => t.active).map((t) => t.id), groups, attached: bt.cdp.attachedTabs.length, windows: new Set(tabs.map((t) => t.windowId)).size };
    }, mainTab);
    assert.equal(out.mainActive, true);
    assert.deepEqual(out.active, [mainTab]);
    assert.ok(out.groups.every((g) => g === "Noa"), JSON.stringify(out.groups));
    assert.equal(out.windows, 1, "all in the agent's window");
    assert.equal(out.attached, PAGES + 1);
    return `${out.attached} tabs attached, only the main tab active`;
  });

  await step("switch_tab: later calls act on that tab", async () => {
    const info = await call("switchTab", { tab: "t4" });
    assert.equal(info.id, "t4");
    assert.equal(info.title, "Message 3");
    const snap = await call("readPage");
    assert.ok(snap.text.includes("INV-300"));
    const reply = snap.elements.find((e) => e.name === "Reply");
    await call("click", { index: reply.index });
    assert.equal(await evalSw(async () => (await chrome.tabs.get(await globalThis.__noa.agentTab.tabId())).title), "clicked 3");
    return "clicked Reply in t4";
  });

  await step("screenshot of a background current tab leaves it in the background", async () => {
    await userPage.bringToFront(); // the user looks at the main tab again
    await call("switchTab", { tab: "t5" });
    const before = await evalSw(async () => (await chrome.tabs.get(await globalThis.__noa.agentTab.tabId())).active);
    const shot = await call("screenshot");
    const after = await evalSw(async () => (await chrome.tabs.get(await globalThis.__noa.agentTab.tabId())).active);
    assert.equal(before, false);
    assert.equal(after, false, "the agent never brings its tab to the front");
    assert.ok(shot.base64.length > 1000, "non-empty image");
    return `${shot.base64.length} base64 chars`;
  });

  await step("close_tabs and list_tabs", async () => {
    const r = await call("closeTabs", { tabs: ["t2", "t5"] });
    assert.deepEqual(r.closed.sort(), ["t2", "t5"]);
    assert.deepEqual(r.tabs.map((t) => [t.id, t.current]), [["t1", true], ["t3", false], ["t4", false], ["t6", false]]);
    await assert.rejects(call("closeTabs", { tabs: ["t1"] }), /never closed/);
    assert.equal(await tabCount(), baseTabs + PAGES - 2);
    return "t2, t5 closed; current fell back to t1";
  });

  await step("run end closes the opened tabs but not the user's tab", async () => {
    const n = await evalSw(() => globalThis.__noa.driver.closeOpenedTabs());
    assert.equal(n, PAGES - 2);
    assert.equal(await tabCount(), baseTabs);
    const main = await evalSw((id) => chrome.tabs.get(id).then((t) => t.url), mainTab);
    assert.equal(main, `${base}/`);
    const attached = await evalSw(async () => {
      await globalThis.__noa.driver.ready();
      return globalThis.__noa.cdp.attachedTabs;
    });
    assert.deepEqual(attached, [mainTab]);
    return "main tab kept, debugger only on it";
  });

  await step("a button that opens a new tab: the tab joins the run, a result says so, and the agent works in it", async () => {
    // A turn is running in slot 0 (only then does a page's new tab join the run).
    await evalSw(() => globalThis.__noa.slots.take(0, "e2e-newtab"));
    await call("navigate", { url: `${base}/compose` });
    const before = await tabCount();
    let snap = await call("readPage");
    const button = snap.elements.find((e) => e.name === "Generate with Grok");
    const click = await call("click", { index: button.index });
    // The page opens the tab after the click: the note comes with that result or the next one.
    let note = click.note;
    const t0 = Date.now();
    while (!note && Date.now() - t0 < 3000) note = (await call("readPage")).note;
    assert.match(note ?? "", /^A new tab opened from the page: (t\d+) "[^"]*" http:\/\/127\.0\.0\.1:\d+\/generate\. Your current tab is still the one you were in: use switch_tab t\d+/, note);
    const id = /switch_tab (t\d+)/.exec(note)[1];
    assert.equal(await tabCount(), before + 1);
    const listed = await call("listTabs");
    assert.ok(listed.tabs.some((t) => t.id === id), JSON.stringify(listed.tabs));
    await call("switchTab", { tab: id });
    snap = await call("readPage");
    assert.equal(snap.title, "Generate image");
    await call("type", { index: snap.elements.find((e) => e.name === "Prompt").index, text: "a red fox" });
    snap = await call("readPage");
    await call("click", { index: snap.elements.find((e) => e.name === "Generate").index });
    await waitForValue(() => submitted.length > 0);
    assert.deepEqual(submitted, ["a red fox"]);
    const shot = await call("screenshot");
    assert.equal(shot.mimeType, "image/jpeg");
    await evalSw(() => globalThis.__noa.slots.release(0, "e2e-newtab", { keepTabs: false }));
    await sleep(300);
    // A tab the page opened stays when the run ends (it may hold what the user wanted).
    assert.equal(await tabCount(), before + 1);
    return `${id} joined the run; form filled and sent there; screenshot ${shot.base64.length} chars`;
  });

  await step("read_page on tabs still loading or drawing waits for their content (never reads an empty page); a page that never draws says it is still loading", async () => {
    // Tabs opened without waiting for them, as when a message from the user cut open_tabs short.
    const apps = [1, 2, 3, 4].map((n) => `${base}/app/${n}`);
    const t0 = Date.now();
    const created = await evalSw((u) => globalThis.__noa.agentTab.open(u, { current: false }), apps);
    const snaps = await evalSw((ids) => Promise.all(ids.map((tab) => globalThis.__noa.driver.readPage({ tab }))), created.map((t) => t.id));
    const ms = Date.now() - t0;
    snaps.forEach((snap, i) => {
      assert.match(snap.text, new RegExp(`Posts of account ${i + 1}`), JSON.stringify(snap).slice(0, 300));
      assert.ok(snap.elements.length >= 3, `tab ${created[i].id}: ${snap.elements.length} elements`);
      assert.equal(snap.note, undefined);
    });
    assert.ok(ms >= APP_SERVER_MS + APP_DRAW_MS - 200, `${ms} ms`);
    const stuck = await evalSw((u) => globalThis.__noa.agentTab.open([u], { current: false }), `${base}/stuck-app`);
    const s0 = Date.now();
    const empty = await evalSw((tab) => globalThis.__noa.driver.readPage({ tab }), stuck[0].id);
    const gaveUpMs = Date.now() - s0;
    assert.match(empty.note ?? "", /Page still loading: after \d+(\.\d)? s it still shows next to nothing \(0 elements/, JSON.stringify(empty).slice(0, 300));
    assert.ok(gaveUpMs < 10_000, `${gaveUpMs} ms`);
    await evalSw(() => globalThis.__noa.driver.closeOpenedTabs());
    return `4 tabs read with content after ${ms} ms (server ${APP_SERVER_MS} ms + drawing ${APP_DRAW_MS} ms); the stuck app said "still loading" after ${gaveUpMs} ms`;
  });

  console.log(
    `\nTiming for ${PAGES} pages (${PAGE_DELAY_MS} ms server latency each):\n` +
      `  sequential navigate + read_page: ${sequentialMs} ms\n` +
      `  open_tabs + one multi-tab read:  ${parallelMs} ms` +
      (parallelMs ? `  (${(sequentialMs / parallelMs).toFixed(1)}x faster, and 2 tool calls instead of ${PAGES * 2})` : ""),
  );
} finally {
  await ext.close();
  await site.close();
}

finish();
