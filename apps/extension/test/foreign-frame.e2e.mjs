// Pages that contain another extension's frame (e.g. Streak inside Gmail).
// Chrome refuses chrome.debugger for such a tab: attach and every command fail
// with "Cannot access a chrome-extension:// URL of different extension". The
// driver must switch that tab to its fallback (chrome.scripting +
// captureVisibleTab) and keep the debugger for clean pages.
//
// Loads the built extension plus test/fixtures/iframe-injector, which appends
// its own chrome-extension:// iframe to every page (unless <meta name="no-inject">).
// A run in such a tab tells the user: its chat's limited-mode notice (which extension, what it means, the fix), the
// pill's "Limited" mark and its popover, the toolbar button's tooltip.
// Usage: pnpm --filter @noa/extension build && node apps/extension/test/foreign-frame.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driverCall, launchExtension, routerUi, sessionWhen } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { driverPage, fillSignupForm, findIndex, OTHER_PAGE } from "../../../test/fixtures/driver-page.mjs";

/** Width and height from a JPEG's frame header. */
function jpegSize(buf) {
  for (let i = 2; i < buf.length; ) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

const injector = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "iframe-injector");
const shots = join(dirname(fileURLToPath(import.meta.url)), "ui", "screenshots", "e2e");
mkdirSync(shots, { recursive: true });
/** The fallback note, naming the extension whose frame is on the page (the injector's id: it has no fixed key). */
const noteFor = (id) =>
  `(Using fallback mode: the frame of another extension (id ${id}; chrome://extensions/?id=${id} shows which) on this page blocks Chrome's debugger. Clicks and typing are simulated.)`;

/** The driver page; unless `clean`, the injector adds its frame (after `delay` ms). */
const fixture = ({ clean = false, delay = 0 } = {}) =>
  driverPage({
    title: clean ? "Clean page" : "Foreign frame page",
    heading: `${clean ? "Clean" : "Mail"} fixture`,
    head: `${clean ? '<meta name="no-inject">' : ""}${delay ? `<meta name="inject-delay" content="${delay}">` : ""}`,
  });
/** A heavy page: usable at once, but its load event waits HEAVY_LOAD_MS for a slow resource (like Gmail's). */
const HEAVY_LOAD_MS = 3500;
const heavy = driverPage({ title: "Heavy mail page", heading: "Heavy fixture", head: '<img src="/slow" width="1" height="1" alt="">' });
const PAGES = { "/other": OTHER_PAGE, "/clean": fixture({ clean: true }), "/late": fixture({ delay: 1500 }), "/heavy": heavy };
const site = await serveHtml((path) => (path === "/slow" ? new Promise((r) => setTimeout(() => r(""), HEAVY_LOAD_MS)) : (PAGES[path] ?? fixture())));
const { base } = site;

const { step, finish } = createSuite("foreign-frame");
const ext = await launchExtension({ name: "foreign", extensions: [injector] });
const { context, sw, profile } = ext;
const uploadFile = join(profile, "upload-me.txt");
writeFileSync(uploadFile, "hello upload");

try {
  const call = driverCall(sw);
  const mode = () =>
    sw.evaluate(async () => ({
      fallback: globalThis.__noa.driver.inFallback,
      attached: globalThis.__noa.cdp.attachedTabId,
      tab: await globalThis.__noa.agentTab.tabId(),
    }));

  const page = await context.newPage();
  await page.goto(`${base}/clean`);
  await page.bringToFront();

  await step("clean page: the run's tab is driven through the debugger", async () => {
    await sw.evaluate(() => globalThis.__noa.agentTab.prepare("current-tab"));
    const snap = await call("readPage");
    assert.equal(snap.title, "Clean page");
    assert.equal(snap.note, undefined);
    const m = await mode();
    assert.equal(m.fallback, false);
    assert.equal(m.attached, m.tab);
    return `${snap.elements.length} elements`;
  });

  await step("reproduction: chrome.debugger refuses a tab with another extension's frame", async () => {
    const other = await context.newPage();
    await other.goto(`${base}/`);
    await other.waitForSelector("#foreign-extension-frame");
    const err = await sw.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      try {
        await chrome.debugger.attach({ tabId: tab.id }, "1.3");
        return "attached";
      } catch (e) {
        return e.message;
      }
    }, `${base}/`);
    await other.close();
    assert.equal(err, "Cannot access a chrome-extension:// URL of different extension");
    return err;
  });

  let snap;
  await step("navigate onto the page with the foreign frame switches to fallback, with the note once", async () => {
    const nav = await call("navigate", { url: `${base}/` });
    assert.equal(nav.title, "Foreign frame page");
    await page.waitForSelector("#foreign-extension-frame");
    const injectorId = /^chrome-extension:\/\/([a-p]{32})\//.exec(await page.$eval("#foreign-extension-frame", (f) => f.src))?.[1];
    assert.ok(injectorId);
    assert.equal(nav.note, noteFor(injectorId));
    // After a navigation the debugger is tried again; it is refused again here.
    snap = await call("readPage");
    assert.equal(snap.note, undefined, "note only once");
    assert.equal((await mode()).fallback, true);
    return nav.url;
  });

  await step("readPage in fallback lists the page's elements, not the foreign frame's", async () => {
    snap = await call("readPage");
    const names = snap.elements.map((e) => `${e.role}:${e.name}`);
    assert.ok(names.includes("link:Other page"), names.join(" | "));
    assert.ok(names.includes("button:Increment"));
    assert.ok(names.includes("textbox:Your name"));
    assert.ok(names.includes("textbox:Compose text"));
    assert.ok(!names.some((n) => n.includes("Foreign extension")));
    assert.ok(snap.text.includes("Mail fixture"));
    return `${snap.elements.length} elements`;
  });

  await step("screenshot in fallback returns a JPEG", async () => {
    const shot = await call("screenshot");
    assert.equal(shot.mimeType, "image/jpeg");
    const buf = Buffer.from(shot.base64, "base64");
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    const out = join(tmpdir(), "noa-foreign-shot.jpg");
    writeFileSync(out, buf);
    return `${buf.length} bytes -> ${out}`;
  });

  await step("fallback: the control overlay is on the page, yet not in read_page or the agent's screenshot, and a click still reaches the page", async () => {
    const tabId = (await mode()).tab;
    await sw.evaluate((t) => globalThis.__noa.pageIndicators.show(t, "working"), tabId);
    const pill = await sw.evaluate(async (t) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t },
        func: () => {
          const r = window.__noaControl?.root.querySelector(".pill")?.getBoundingClientRect();
          return r ? { x: r.x + 4, y: r.y + r.height / 2 } : null;
        },
      });
      return res?.result ?? null;
    }, tabId);
    assert.ok(pill, "the overlay is on the page");
    const read = await call("readPage");
    assert.doesNotMatch(read.text, /Noa/);
    assert.ok(!read.elements.some((e) => /Stop|Noa/.test(`${e.name} ${e.text ?? ""}`)));
    const shot = await call("screenshot");
    /** The colour at the pill's place in an image, measured in the page. */
    const colourAt = (base64, mime) =>
      page.evaluate(
        async ([src, at]) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement("canvas");
          [c.width, c.height] = [img.width, img.height];
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          const k = img.width / innerWidth;
          return [...g.getImageData(Math.round(at.x * k), Math.round(at.y * k), 1, 1).data.slice(0, 3)];
        },
        [`data:${mime};base64,${base64}`, pill],
      );
    const PILL = [30, 27, 58];
    const near = (rgb) => rgb.every((v, i) => Math.abs(v - PILL[i]) < 40);
    const agent = await colourAt(shot.base64, shot.mimeType);
    const user = await colourAt((await page.screenshot()).toString("base64"), "image/png");
    assert.ok(!near(agent), `the agent's screenshot shows the pill: ${agent}`);
    assert.ok(near(user), `the user's view lacks the pill: ${user}`);
    const before = await page.evaluate(() => document.querySelector("#count")?.textContent ?? null);
    const inc = (await call("readPage")).elements.find((e) => e.name === "Increment");
    await call("click", { index: inc.index });
    const after = await page.evaluate(() => document.querySelector("#count")?.textContent ?? null);
    assert.notEqual(after, before, "the click reached the page");
    // The next steps count their own clicks.
    await page.evaluate(() => {
      window.clicks = 0;
      document.querySelector("#count").textContent = "0";
    });
    assert.equal(await page.evaluate(() => document.querySelector("noa-control").hasAttribute("data-busy")), false, "the pill is back");
    await sw.evaluate((t) => globalThis.__noa.pageIndicators.remove(t), tabId);
    assert.equal(await page.evaluate(() => document.querySelector("noa-control")), null);
    // Chrome allows two captureVisibleTab calls a second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); the next step takes one.
    await new Promise((r) => setTimeout(r, 1000));
    return `pill at (${Math.round(pill.x)}, ${Math.round(pill.y)}): agent ${agent}, user ${user}; count ${before} -> ${after}`;
  });

  await step("a screenshot of a wide window is scaled to 1280 px wide", async () => {
    await page.setViewportSize({ width: 2400, height: 1300 });
    const shot = await call("screenshot");
    await page.setViewportSize({ width: 1280, height: 720 });
    const buf = Buffer.from(shot.base64, "base64");
    const size = jpegSize(buf);
    assert.equal(size.width, 1280, JSON.stringify(size));
    assert.equal(size.height, Math.round((1300 * 1280) / 2400));
    return `${size.width}x${size.height}, ${Math.round(buf.length / 1024)} KB`;
  });

  await step("click in fallback runs the page's handler (untrusted)", async () => {
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    const s = await call("readPage");
    assert.match(s.text, /Count: 2 trusted: false/);
    return "count 2";
  });

  await step("type in fallback fills an input and a contenteditable editor", async () => {
    snap = await call("readPage");
    await call("type", { index: findIndex(snap, (e) => e.name === "Your name"), text: "Ada" });
    await call("type", { index: findIndex(snap, (e) => e.name === "Compose text"), text: "Hello from Noa" });
    const s = await call("readPage");
    assert.equal(s.elements.find((e) => e.name === "Your name").value, "Ada");
    assert.ok(s.text.includes("Hello from Noa"), s.text);
    return "input value Ada, editor text set";
  });

  await step("paste and pressKey in fallback", async () => {
    await call("paste", { text: "!" });
    let s = await call("readPage");
    assert.ok(s.text.includes("Hello from Noa!"), "paste appended at caret");
    await call("pressKey", { key: "Control+a" });
    s = await call("readPage");
    assert.match(s.text, /Last key: Control\+a/);
    await call("pressKey", { key: "Escape" });
    s = await call("readPage");
    assert.match(s.text, /Last key: Escape/);
    return "Control+a and Escape seen by the page";
  });

  await step("Enter in a form input submits the form in fallback", async () => {
    snap = await call("readPage");
    await call("click", { index: findIndex(snap, (e) => e.name === "Your name") });
    await call("pressKey", { key: "Enter" });
    const s = await call("readPage");
    assert.match(s.text, /Submitted: Ada/);
    return "submitted";
  });

  await step("a form in fallback: dropdown chosen by label, checkbox set (not toggled), field replaced on retype", () => fillSignupForm(call, assert));

  await step("scroll in fallback moves the page and reports how far", async () => {
    const r = await call("scroll", { direction: "down", amount: 1 });
    const s = await call("readPage");
    const y = Number(/ScrollY: (\d+)/.exec(s.text)?.[1]);
    assert.ok(y > 300, `scrollY ${y}`);
    assert.equal(r.target, "page", JSON.stringify(r));
    assert.equal(r.moved, y);
    assert.equal(r.position, y);
    await call("scroll", { direction: "down", amount: 20 });
    const end = await call("scroll", { direction: "down", amount: 1 });
    assert.equal(end.moved, 0, JSON.stringify(end));
    assert.equal(end.reason, "end");
    await call("scroll", { direction: "up", amount: 20 });
    return `scrollY ${y}, then at the bottom: ${end.position} of ${end.size}`;
  });

  await step("upload in fallback fails with a clear reason", async () => {
    snap = await call("readPage");
    const err = await call("upload", { index: findIndex(snap, (e) => e.type === "file"), paths: [uploadFile] }).catch((e) => e.message);
    assert.match(String(err), /upload is not possible on this page because another extension/);
    return String(err).slice(0, 90);
  });

  await step("clicking a link in fallback navigates", async () => {
    snap = await call("readPage");
    await call("click", { index: findIndex(snap, (e) => e.role === "link") });
    await page.waitForURL(`${base}/other`);
    assert.equal((await call("currentUrl")).url, `${base}/other`);
    return `${base}/other`;
  });

  await step("navigate to a clean page returns to the debugger (trusted clicks)", async () => {
    const nav = await call("navigate", { url: `${base}/clean` });
    assert.equal(nav.title, "Clean page");
    snap = await call("readPage");
    const m = await mode();
    assert.equal(m.fallback, false);
    assert.equal(m.attached, m.tab);
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    const s = await call("readPage");
    assert.match(s.text, /Count: 1 trusted: true/);
    assert.equal(s.note, undefined);
    return "debugger attached, isTrusted true";
  });

  await step("a frame injected after attach: next call falls back without a second note", async () => {
    await call("navigate", { url: `${base}/late` });
    await page.waitForSelector("#foreign-extension-frame");
    const s = await call("readPage");
    assert.equal(s.title, "Foreign frame page");
    assert.equal(s.note, undefined, "note already shown for this tab");
    assert.equal((await mode()).fallback, true);
    await call("click", { index: findIndex(s, (e) => e.testId === "incButton") });
    assert.match((await call("readPage")).text, /Count: 1 trusted: false/);
    return "fell back after target_closed";
  });

  await step("navigate in fallback mode to a heavy page returns once it is usable, not after its load event", async () => {
    assert.equal((await mode()).fallback, true);
    const times = [];
    for (const path of ["/heavy", "/", "/heavy"]) {
      const started = Date.now();
      const nav = await call("navigate", { url: `${base}${path}` });
      times.push(Date.now() - started);
      assert.equal(nav.url, `${base}${path}`);
    }
    const snap = await call("readPage");
    assert.equal(snap.title, "Heavy mail page");
    assert.ok(snap.elements.some((e) => e.name === "Increment"), "the page is usable");
    // Still in fallback (the page has the other extension's frame again): no debugger attach for Chrome to drop.
    assert.equal((await mode()).fallback, true);
    assert.ok(times[0] < HEAVY_LOAD_MS && times[2] < HEAVY_LOAD_MS, `navigate took ${times.join(", ")} ms; the load event comes after ${HEAVY_LOAD_MS} ms`);
    return `navigate times (heavy, light, heavy): ${times.join(", ")} ms`;
  });

  await step("a run in a tab in limited mode: its chat says so (which extension, the fix), the pill says 'Limited' and its popover why", async () => {
    const fake = await installFakeBrain(sw, {
      gated: true,
      makeAct: () => async ({ browser, onEvent }) => {
        onEvent({ type: "tool_call", id: "c1", name: "read_page", args: {} });
        await browser.call("browser.readPage", {});
        // Holds the run (still acting) until the test lets it end.
        await new Promise((r) => (globalThis.__endLimited = r));
        return "read";
      },
    });
    const tabId = (await mode()).tab;
    const injectorId = /^chrome-extension:\/\/([a-p]{32})\//.exec(await page.$eval("#foreign-extension-frame", (f) => f.src))?.[1];
    const run = await routerUi(sw)({ type: "run.adhoc", instructions: "Summarize my inbox", tabId });
    await fake.release("Summarize my inbox");
    const told = await waitFor(
      () => sw.evaluate(async (id) => (await globalThis.__noa.sessions.eventsOf(id)).filter((e) => e.type === "limited_mode").map(({ ts, sessionId, ...e }) => e), run.sessionId).then((l) => (l.length ? l : null)),
      "the chat's limited-mode notice",
    );
    assert.deepEqual(told, [{ type: "limited_mode", tab: "t1", url: `${base}/heavy`, extensionId: injectorId }]);

    /** The pill's mark and popover, as the extension's isolated world sees them. */
    const pill = () =>
      sw.evaluate(async (t) => {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: t },
          func: () => {
            const root = window.__noaControl?.root;
            const mark = root?.querySelector(".mark");
            const pop = root?.querySelector(".pop");
            const text = root?.querySelector(".text")?.getBoundingClientRect();
            if (!mark || !pop || !text) return null;
            return {
              mark: getComputedStyle(mark).display !== "none" ? mark.textContent : null,
              popover: getComputedStyle(pop).display !== "none" ? [...pop.children].filter((c) => !c.hidden).map((c) => c.textContent) : null,
              at: { x: text.x + text.width / 2, y: text.y + text.height / 2 },
            };
          },
        });
        return res?.result ?? null;
      }, tabId);
    const shown = await waitFor(async () => {
      const p = await pill();
      return p?.mark ? p : null;
    }, "the pill's Limited mark");
    assert.equal(shown.mark, "Limited");
    // The limited-mode flag and the step ("Now: …") reach the tooltip from separate events: wait for the whole text.
    const expected = "Noa is working in this tab: Summarize my inbox · Now: Reading the page · Limited mode: another extension blocks Chrome's debugger here";
    let tooltip = "";
    await waitFor(async () => {
      tooltip = await sw.evaluate((t) => chrome.action.getTitle({ tabId: t }), tabId);
      return tooltip === expected ? tooltip : null;
    }, "the tooltip").catch(() => null);
    assert.equal(tooltip, expected);
    await page.mouse.move(shown.at.x, shown.at.y);
    const open = await waitFor(async () => (await pill())?.popover, "the popover");
    assert.equal(open[0], "Summarize my inbox");
    assert.equal(open[1], "Now: Reading the page");
    assert.match(open[2], /^Limited mode: another extension's frame on this page blocks Chrome's debugger\. .*simulated.*can't upload files/);
    await page.screenshot({ path: join(shots, "limited-pill-popover.png") });
    await page.mouse.move(5, 600);

    // The side panel (as a tab): the run's chat shows the notice in the thread, with the other extension's page.
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 720 });
    await panel.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
    // A panel shows the working job of its window's tab; else the list, where the job is opened.
    const notice = panel.locator(".ev-limited");
    const row = panel.locator("button.job-row:visible", { hasText: "Summarize my inbox" });
    await notice.or(row).first().waitFor({ timeout: 15_000 });
    if (!(await notice.isVisible())) await row.first().click();
    await notice.waitFor({ timeout: 15_000 });
    const text = await notice.innerText();
    assert.match(text, /^Limited mode in tab t1 on 127\.0\.0\.1:\d+\n/);
    assert.ok(text.includes(`Another extension (id ${injectorId}) has a frame on this page that blocks Chrome's debugger.`), text);
    assert.equal(await notice.locator("button").innerText(), "Open that extension");
    // Not folded into the steps: a child of the thread itself.
    assert.equal(await notice.evaluate((el) => el.closest(".ev-steps")), null);
    await panel.screenshot({ path: join(shots, "limited-sidepanel.png") });
    // Its button opens the other extension's page in Chrome (where it is turned off, or its site access changed).
    const settings = `chrome://extensions/?id=${injectorId}`;
    await notice.locator("button").click();
    await waitFor(() => sw.evaluate(async (url) => (await chrome.tabs.query({})).some((t) => (t.pendingUrl || t.url) === url), settings), "the other extension's page");
    await sw.evaluate(async (url) => {
      for (const t of await chrome.tabs.query({})) if ((t.pendingUrl || t.url) === url) await chrome.tabs.remove(t.id);
    }, settings);
    await panel.close();

    await sw.evaluate(() => globalThis.__endLimited());
    await sessionWhen(sw, run.sessionId, "the run to end");
    return `${JSON.stringify(told[0])}; pill ${shown.mark}; popover ${JSON.stringify(open)}`;
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
