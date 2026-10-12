// The agent never takes over the user's screen, in the built extension in a HEADED
// Playwright Chromium (a real window, so tab visibility is real): a one-off run starts in
// tab A, the user switches to tab B, and the run keeps working in A (reads, screenshots,
// opens and switches tabs, a second turn) while B stays the active tab the whole time.
// Screenshots of the background tab A are checked against A's real colour: prints whether
// they were real or skipped ("Screenshot skipped: the tab is in the background ...").
// The brain is a scripted fake installed in the service worker (no helper, no API key).
// Usage: pnpm build && node apps/extension/test/focus.e2e.mjs
import assert from "node:assert/strict";
import { launchExtension, openPanelWithTabs, pageUi, sessionWhen } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

// Each page fills the window with its own colour, so a screenshot shows which page it is.
const COLORS = { a: [224, 48, 48], b: [48, 80, 224], c: [48, 192, 80] };
const site = await serveHtml((path) => {
  const name = path.slice(1) || "home";
  const [r, g, b] = COLORS[name] ?? [255, 255, 255];
  return `<!doctype html><title>Page ${name}</title><body style="margin:0;height:100vh;background:rgb(${r},${g},${b})">
<h1>Page ${name}</h1><button onclick="document.getElementById('n').textContent = String(++window.clicks)">Count</button>
<p>Clicks: <span id="n">0</span></p><script>window.clicks = 0;</script></body>`;
});
const { base } = site;

const { step, finish } = createSuite("focus");
// Headed on purpose: a headless browser has no real window visibility.
const ext = await launchExtension({
  name: "focus",
  headed: true,
  // Without Playwright's flags that keep hidden tabs rendering, as in a user's Chrome.
  ignoreDefaultArgs: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
const { context, sw } = ext;

try {
  const version = context.browser()?.version() ?? (await sw.evaluate(() => navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "?"));
  console.log(`Chromium ${version} (headed)`);

  // The spy: every tabs.update({active}) / windows.update({focused}) the extension makes,
  // and every tab activation, whoever caused it.
  await sw.evaluate(() => {
    const spy = (globalThis.__spy = { takeovers: [], activated: [] });
    const tabsUpdate = chrome.tabs.update.bind(chrome.tabs);
    chrome.tabs.update = (...args) => {
      const props = typeof args[0] === "number" ? args[1] : args[0];
      if (props?.active || props?.highlighted) spy.takeovers.push({ api: "tabs.update", args: JSON.stringify(args), stack: new Error().stack });
      return tabsUpdate(...args);
    };
    const winUpdate = chrome.windows.update.bind(chrome.windows);
    chrome.windows.update = (id, props) => {
      if (props?.focused || props?.drawAttention) spy.takeovers.push({ api: "windows.update", args: JSON.stringify([id, props]), stack: new Error().stack });
      return winUpdate(id, props);
    };
    chrome.tabs.onActivated.addListener((info) => spy.activated.push(info.tabId));
  });

  // The fake brain: a turn waits for its gate, then works in the run's tab like a real agent would.
  const fake = await installFakeBrain(sw, {
    gated: true,
    arg: { colors: COLORS, base },
    makeAct: ({ colors, base }) => {
      const shots = (globalThis.__shots = []);
      /** What a screenshot shows: the page's colour (real), blank/other, or skipped (the tool's error). */
      const classify = async (call) => {
        try {
          const shot = await call();
          const bytes = Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: shot.mimeType }));
          const ctx = new OffscreenCanvas(8, 8).getContext("2d");
          ctx.drawImage(bmp, 0, 0, 8, 8);
          const d = ctx.getImageData(4, 6, 1, 1).data; // bottom middle: page background, not the heading
          const near = (c) => c.every((v, i) => Math.abs(v - d[i]) < 24);
          const page = Object.keys(colors).find((k) => near(colors[k])) ?? `other rgb(${d[0]},${d[1]},${d[2]})`;
          return { kind: "real", page, size: `${bmp.width}x${bmp.height}` };
        } catch (e) {
          return { kind: "skipped", error: String(e?.message ?? e) };
        }
      };
      return async ({ browser: b }, name) => {
        const snap = await b.call("browser.readPage", {});
        shots.push({ turn: name, of: "t1", ...(await classify(() => b.call("browser.screenshot", {}))) });
        await b.call("browser.click", { index: snap.elements.find((e) => e.name === "Count").index });
        if (name === "task A") {
          // Another tab of the run, made current: it must stay in the background too.
          await b.call("browser.openTabs", { urls: [`${base}/c`], background: false });
          shots.push({ turn: name, of: "t2", ...(await classify(() => b.call("browser.screenshot", {}))) });
          await b.call("browser.switchTab", { tab: "t1" });
          await b.call("browser.switchTab", { tab: "t2" });
          await b.call("browser.switchTab", { tab: "t1" });
          await b.call("browser.navigate", { url: `${base}/a` });
          shots.push({ turn: name, of: "t1 after navigate", ...(await classify(() => b.call("browser.screenshot", {}))) });
        }
        return `clicked on ${snap.title}`;
      };
    },
  });

  const {
    panel,
    pages: [pageA, pageB],
    ids: {
      tabs: [tabA, tabB],
      windowId,
    },
  } = await openPanelWithTabs(ext, [`${base}/a`, `${base}/b`]);
  const ui = pageUi(panel);
  const isActive = (tabId) => sw.evaluate(async (t) => (await chrome.tabs.get(t)).active, tabId);
  // The user's own tab switches: through Playwright, not the extension's spied chrome.tabs.update.
  const userSwitchesTo = async (page, tabId) => {
    await page.bringToFront();
    await waitFor(() => isActive(tabId), `tab ${tabId} to be active`, { timeout: 15_000 });
  };
  // Samples the active tab of the window every 25 ms while a turn runs.
  const watchActive = () =>
    sw.evaluate((w) => {
      const seen = (globalThis.__seen = new Set());
      globalThis.__watch = setInterval(async () => {
        const [t] = await chrome.tabs.query({ active: true, windowId: w });
        if (t) seen.add(t.id);
      }, 25);
    }, windowId);
  const stopWatch = () =>
    sw.evaluate(() => {
      clearInterval(globalThis.__watch);
      return [...globalThis.__seen];
    });
  const resetSpy = () => sw.evaluate(() => ((globalThis.__spy.takeovers = []), (globalThis.__spy.activated = [])));
  const spy = () => sw.evaluate(() => globalThis.__spy);
  const turnEnded = (sessionId, turns, what) => sessionWhen(sw, sessionId, what, { until: (s) => s.turns === turns && s.endedAt, timeout: 15_000 });

  let a;
  await step("a one-off run starts in tab A; the user switches to tab B during the run", async () => {
    await userSwitchesTo(pageA, tabA);
    a = await ui({ type: "run.adhoc", instructions: "task A", tabId: tabA });
    await fake.started("task A");
    await userSwitchesTo(pageB, tabB);
    await resetSpy();
    return `session ${a.sessionId} in tab ${tabA}`;
  });

  await step("tab B stays active for the whole run while it reads, clicks, screenshots, opens and switches tabs in A", async () => {
    await watchActive();
    await fake.release("task A");
    const s = await sessionWhen(sw, a.sessionId, "task A to end", { timeout: 15_000 });
    const seen = await stopWatch();
    const { takeovers, activated } = await spy();
    assert.equal(s.outcome, "done", s.reason);
    assert.deepEqual(takeovers.map((t) => `${t.api} ${t.args}`), [], "no tab activation / window focus by the extension");
    assert.deepEqual(activated, [], "no tab was activated");
    assert.deepEqual(seen, [tabB], "only tab B was ever the active tab");
    assert.equal(await isActive(tabB), true);
    assert.equal(await pageA.evaluate(() => location.pathname), "/a");
    return `${s.outcome}; active tab samples: ${JSON.stringify(seen)}`;
  });

  await step("the next message in A's chat, sent while the user is on B, does not bring A to the front", async () => {
    await resetSpy();
    await watchActive();
    const r = await ui({ type: "run.message", sessionId: a.sessionId, text: "again A", tabId: tabA });
    assert.equal(r.mode, "turn");
    await fake.release("again A");
    await turnEnded(a.sessionId, 2, "turn 2 to end");
    const seen = await stopWatch();
    const { takeovers, activated } = await spy();
    assert.deepEqual(takeovers.map((t) => `${t.api} ${t.args}`), []);
    assert.deepEqual(activated, []);
    assert.deepEqual(seen, [tabB]);
    assert.equal(await pageA.evaluate(() => window.clicks), 1, "clicked in tab A (reloaded by turn 1's navigate)");
    assert.equal(await pageB.evaluate(() => window.clicks), 0, "tab B was never acted on");
    return `turn 2 ended; active tab samples: ${JSON.stringify(seen)}`;
  });

  await step("screenshots of the background tabs", async () => {
    const shots = await sw.evaluate(() => globalThis.__shots);
    assert.ok(shots.length >= 4, `screenshots taken: ${shots.length}`);
    const expected = { t1: "a", t2: "c", "t1 after navigate": "a" };
    for (const s of shots) {
      if (s.kind === "real") assert.equal(s.page, expected[s.of], `a real screenshot of ${s.of} shows its page (${JSON.stringify(s)})`);
      else assert.match(s.error, /Screenshot skipped: the tab is in the background/);
    }
    const real = shots.filter((s) => s.kind === "real").length;
    console.log(`     background screenshots: ${real} real, ${shots.length - real} skipped`);
    for (const s of shots) console.log(`       ${s.turn} / ${s.of}: ${s.kind === "real" ? `real (page ${s.page}, ${s.size})` : s.error}`);
    return `${real}/${shots.length} real`;
  });

  await step("Show Tab (a user action) still brings the run's tab to the front", async () => {
    await resetSpy();
    // Show Tab is offered while a run is going: start one that waits.
    const s = await ui({ type: "run.message", sessionId: a.sessionId, text: "third", tabId: tabA });
    assert.equal(s.mode, "turn");
    await fake.started("third");
    assert.equal(await ui({ type: "agent.show", sessionId: a.sessionId }).then((x) => x.ok), true);
    await waitFor(() => isActive(tabA), "tab A to be active", { timeout: 15_000 });
    const { takeovers } = await spy();
    assert.ok(takeovers.some((t) => t.api === "tabs.update"), "Show Tab activated the tab");
    await fake.release("third");
    await turnEnded(a.sessionId, 3, "turn 3 to end");
    return "tab A shown";
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
