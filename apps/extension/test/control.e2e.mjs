// Which tabs Noa controls, in the built extension in Playwright's Chromium (control-indicator.ts):
// the tab group's title and colour while a run acts, waits for an approval, ends paused for the user, and after;
// the toolbar badge; the page overlay (glow + pill) while it acts and gone after; the overlay never in the agent's
// read_page or screenshots; the pill's Stop stops the run and its Open opens the chat's side panel; the setting
// turns the overlay off. The brain is a scripted fake in the service worker (no helper, no API key).
// Usage: pnpm build && node apps/extension/test/control.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The reason a run the user stopped ends with (packages/shared/src/events.ts USER_STOP_REASON).
const USER_STOP_REASON = "Stopped by the user";
import { launchExtension, routerUi, sessionWhen } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

const shots = join(dirname(fileURLToPath(import.meta.url)), "ui", "screenshots", "e2e");
mkdirSync(shots, { recursive: true });

// A white page with its content on the left: the pill's place (top center) is plain white.
const site = await serveHtml(
  (path) => `<!doctype html><title>Shop ${path}</title><style>body{margin:0;background:#fff;font:16px sans-serif}main{padding:80px 24px}</style>
<main><h1>Shop ${path}</h1><button onclick="window.clicks++">Count</button><p>Plain page text.</p></main><script>window.clicks = 0;</script>`,
);
const { base } = site;

const { step, finish } = createSuite("control");
const ext = await launchExtension({ name: "control" });
const { context, sw } = ext;
const ui = routerUi(sw);

try {
  // Each turn waits at its gate, then does what its name says.
  const fake = await installFakeBrain(sw, {
    gated: true,
    makeAct: () => {
      const seen = (globalThis.__seen = {});
      return async ({ browser }, name) => {
        if (name.startsWith("look")) {
          seen.snap = await browser.call("browser.readPage", {});
          seen.shot = await browser.call("browser.screenshot", {});
          // Holds the run (still acting) until the test lets it end.
          await new Promise((r) => (globalThis.__endLook = r));
          return "looked";
        }
        if (name.startsWith("pause")) return { outcome: "paused", reason: "Log in to the shop, then tell me to go on", summary: "needs a login" };
        if (name.startsWith("click")) {
          const snap = await browser.call("browser.readPage", {});
          await browser.call("browser.click", { index: snap.elements.find((e) => e.name === "Count").index });
          return "clicked";
        }
        // "wait": stays until stopped.
        await new Promise(() => {});
      };
    },
  });

  const page = await context.newPage();
  await page.goto(`${base}/a`);
  await page.bringToFront();
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/a`);

  /** The tab's group (title, colour), badge, tooltip, and the overlay element as the page sees it. */
  const view = async () => {
    const chromeSide = await sw.evaluate(async (t) => {
      const tab = await chrome.tabs.get(t);
      const group = tab.groupId === -1 ? null : await chrome.tabGroups.get(tab.groupId);
      return {
        group: group && { title: group.title, color: group.color },
        badge: await chrome.action.getBadgeText({ tabId: t }),
        tooltip: await chrome.action.getTitle({ tabId: t }),
      };
    }, tabId);
    const overlay = await page.evaluate(() => {
      const host = document.querySelector("noa-control");
      return host ? { variant: host.getAttribute("data-variant"), inBody: document.body.contains(host), open: host.shadowRoot !== null } : null;
    });
    return { ...chromeSide, overlay };
  };
  /** The pill's button as the extension's isolated world sees it (the shadow root is closed to the page). */
  const pillButton = () =>
    sw.evaluate(async (t) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t },
        func: () => {
          const root = window.__noaControl?.root;
          const b = root?.querySelector("button");
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const pill = root.querySelector(".pill").getBoundingClientRect();
          // A point of the pill's own background: its left padding, before the dot.
          return { text: b.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2, pillX: pill.x + 4, pillY: pill.y + pill.height / 2 };
        },
      });
      return res?.result ?? null;
    }, tabId);
  /** Whether an image (base64 JPEG/PNG) is dark at a point of the page (CSS px), measured in the page. */
  const darkIn = async (base64, mime, at) =>
    page.evaluate(
      async ([src, viewW, at]) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const scale = img.width / viewW;
        const [r, gg, b] = g.getImageData(Math.round(at.x * scale), Math.round(at.y * scale), 1, 1).data;
        return { dark: r + gg + b < 300, rgb: [r, gg, b], size: [img.width, img.height] };
      },
      [`data:${mime};base64,${base64}`, await page.evaluate(() => innerWidth), at],
    );

  let look;
  await step("before any run: no badge, no overlay", async () => {
    const v = await view();
    assert.equal(v.badge, "");
    assert.equal(v.overlay, null);
    return JSON.stringify(v);
  });

  await step("a run acting in the tab: group 'Noa · working' in purple, RUN badge with its tooltip, the overlay outside the page's body", async () => {
    look = await ui({ type: "run.adhoc", instructions: "look", tabId });
    await fake.started("look");
    const v = await waitFor(async () => {
      const x = await view();
      return x.group?.title === "Noa · working" && x.overlay ? x : null;
    }, "the working look");
    assert.deepEqual(v.group, { title: "Noa · working", color: "purple" });
    assert.equal(v.badge, "RUN");
    assert.equal(v.tooltip, "Noa is working in this tab");
    assert.deepEqual(v.overlay, { variant: "working", inBody: false, open: false });
    assert.equal((await pillButton())?.text, "Stop");
    await page.screenshot({ path: join(shots, "control-working.png") });
    return JSON.stringify(v);
  });

  await step("the agent's read_page and screenshot never show the overlay (the page's own screenshot does)", async () => {
    await fake.release("look");
    const seen = await waitFor(() => sw.evaluate(() => (globalThis.__seen.shot ? globalThis.__seen : null)), "the agent's read and screenshot", {
      // A screenshot may take up to 10 s on a busy machine (driver.ts BACKGROUND_SHOT_TIMEOUT_MS).
      timeout: 30_000,
    });
    assert.doesNotMatch(seen.snap.text, /Noa/);
    assert.ok(!seen.snap.elements.some((e) => /Stop|Noa/.test(`${e.name} ${e.text ?? ""}`)), JSON.stringify(seen.snap.elements));
    assert.deepEqual(
      seen.snap.elements.map((e) => e.name),
      ["Count"],
    );
    const pill = await pillButton();
    const at = { x: pill.pillX, y: pill.pillY };
    const agent = await darkIn(seen.shot.base64, seen.shot.mimeType, at);
    assert.equal(agent.dark, false, `the agent's screenshot at the pill's place: ${JSON.stringify(agent)}`);
    writeFileSync(join(shots, "control-agent-screenshot.jpg"), Buffer.from(seen.shot.base64, "base64"));
    const user = await darkIn((await page.screenshot()).toString("base64"), "image/png", at);
    assert.equal(user.dark, true, `the user's view at the pill's place: ${JSON.stringify(user)}`);
    // Put back after the capture.
    assert.equal((await pillButton())?.text, "Stop");
    assert.equal(await page.evaluate(() => document.querySelector("noa-control").hasAttribute("hidden")), false);
    return `at the pill (${Math.round(at.x)}, ${Math.round(at.y)}): agent's screenshot ${JSON.stringify(agent.rgb)}, the user's view ${JSON.stringify(user.rgb)}`;
  });

  await step("the run ends: group 'Noa' in grey, no badge, no overlay", async () => {
    await sw.evaluate(() => globalThis.__endLook());
    await sessionWhen(sw, look.sessionId, "the look run to end");
    const v = await waitFor(async () => {
      const x = await view();
      return x.group?.title === "Noa" && !x.overlay ? x : null;
    }, "the idle look");
    assert.deepEqual(v.group, { title: "Noa", color: "grey" });
    assert.equal(v.badge, "");
    assert.equal(v.tooltip, "Noa");
    return JSON.stringify(v);
  });

  await step("the overlay comes back on the page the agent navigates to, and is gone after", async () => {
    const r = await ui({ type: "run.adhoc", instructions: "wait nav", tabId });
    await fake.started("wait nav");
    await waitFor(async () => (await view()).overlay, "the overlay");
    await page.goto(`${base}/b`);
    const v = await waitFor(async () => {
      const x = await view();
      return x.overlay?.variant === "working" ? x : null;
    }, "the overlay on the new page");
    assert.equal(v.badge, "RUN");
    await ui({ type: "run.stop", sessionId: r.sessionId });
    await sessionWhen(sw, r.sessionId, "the run to stop");
    await waitFor(async () => !(await view()).overlay, "the overlay to go");
    return JSON.stringify(v);
  });

  await step("the pill's Stop (a real click on the page) stops that run", async () => {
    const r = await ui({ type: "run.adhoc", instructions: "wait", tabId });
    await fake.started("wait");
    const button = await waitFor(pillButton, "the pill's Stop");
    assert.equal(button.text, "Stop");
    await fake.release("wait");
    await page.mouse.click(button.x, button.y);
    const s = await sessionWhen(sw, r.sessionId, "the run to stop");
    assert.equal(s.outcome, "paused");
    assert.equal(s.reason, USER_STOP_REASON);
    assert.equal(await page.evaluate(() => window.clicks), 0, "the click never reached the page");
    const v = await waitFor(async () => {
      const x = await view();
      return x.group?.title === "Noa" && !x.overlay ? x : null;
    }, "the idle look after Stop");
    assert.equal(v.badge, "");
    return `${s.outcome}: ${s.reason}`;
  });

  await step("waiting for an approval: 'Noa · needs you' in yellow, ! badge, the pill says Open; answered, it works on", async () => {
    await sw.evaluate(() => globalThis.__noa.settings.save({ automationLevel: "ask_all" }));
    const r = await ui({ type: "run.adhoc", instructions: "click", tabId });
    await fake.release("click");
    const v = await waitFor(async () => {
      const x = await view();
      return x.group?.title === "Noa · needs you" && x.overlay?.variant === "needs-you" ? x : null;
    }, "the needs-you look");
    assert.deepEqual(v.group, { title: "Noa · needs you", color: "yellow" });
    assert.equal(v.badge, "!");
    assert.equal(v.tooltip, "Noa needs you in this tab");
    assert.equal((await pillButton())?.text, "Open");
    await page.screenshot({ path: join(shots, "control-needs-you.png") });
    const waiting = await sw.evaluate(async (id) => (await globalThis.__noa.sessions.eventsOf(id)).filter((e) => e.type === "approval_request").map((e) => e.request.id), r.sessionId);
    await ui({ type: "approval.answer", sessionId: r.sessionId, id: waiting.at(-1), answer: "allow_once" });
    const s = await sessionWhen(sw, r.sessionId, "the click run to end");
    assert.equal(s.outcome, "done");
    await waitFor(async () => (await view()).group?.title === "Noa", "the idle look");
    await sw.evaluate(() => globalThis.__noa.settings.save({ automationLevel: "ask_consequential" }));
    return JSON.stringify(v);
  });

  await step("a run that ended paused for the user keeps saying 'needs you'; the pill's Open opens the chat's side panel and clears it", async () => {
    const r = await ui({ type: "run.adhoc", instructions: "pause", tabId });
    await fake.release("pause");
    const s = await sessionWhen(sw, r.sessionId, "the run to pause");
    assert.equal(s.outcome, "paused");
    const v = await waitFor(async () => {
      const x = await view();
      return x.group?.title === "Noa · needs you" && x.overlay?.variant === "needs-you" ? x : null;
    }, "the needs-you look after the run");
    assert.equal(v.badge, "!");
    const button = await pillButton();
    assert.equal(button.text, "Open");
    const panels = () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).map((c) => c.documentUrl));
    const before = await panels();
    await page.mouse.click(button.x, button.y);
    const after = await waitFor(async () => {
      const p = await panels();
      return p.length > before.length ? p : null;
    }, "the side panel to open");
    // The window's side panel (one per window; it shows the chat of the tab in front).
    assert.ok(after.some((u) => u.endsWith("/sidepanel.html")), JSON.stringify(after));
    const idle = await waitFor(async () => {
      const x = await view();
      return x.group?.title === "Noa" && !x.overlay ? x : null;
    }, "the idle look after Open");
    return `panels ${JSON.stringify(after)}; ${JSON.stringify(idle)}`;
  });

  await step("with the overlay setting off: group and badge still show, the page has no overlay", async () => {
    await sw.evaluate(() => globalThis.__noa.settings.save({ showControlOverlay: false }));
    const r = await ui({ type: "run.adhoc", instructions: "wait off", tabId });
    await fake.started("wait off");
    const v = await waitFor(async () => {
      const x = await view();
      return x.group?.title === "Noa · working" ? x : null;
    }, "the working look");
    assert.equal(v.badge, "RUN");
    assert.equal(v.overlay, null);
    await sw.evaluate(() => globalThis.__noa.settings.save({ showControlOverlay: true }));
    await waitFor(async () => (await view()).overlay?.variant === "working", "the overlay once the setting is on");
    await ui({ type: "run.stop", sessionId: r.sessionId });
    await sessionWhen(sw, r.sessionId, "the run to stop");
    await waitFor(async () => !(await view()).overlay, "the overlay to go");
    return JSON.stringify(v);
  });

  await step("a group the user renamed keeps its name; its colour still shows the state", async () => {
    await sw.evaluate(async (t) => chrome.tabGroups.update((await chrome.tabs.get(t)).groupId, { title: "My bot tabs" }), tabId);
    const r = await ui({ type: "run.adhoc", instructions: "wait renamed", tabId });
    await fake.started("wait renamed");
    const v = await waitFor(async () => {
      const x = await view();
      return x.group?.color === "purple" ? x : null;
    }, "the working colour");
    assert.equal(v.group.title, "My bot tabs");
    await ui({ type: "run.stop", sessionId: r.sessionId });
    await sessionWhen(sw, r.sessionId, "the run to stop");
    const idle = await waitFor(async () => {
      const x = await view();
      return x.group?.color === "grey" ? x : null;
    }, "the idle colour");
    assert.equal(idle.group.title, "My bot tabs");
    return JSON.stringify(idle.group);
  });
} catch (err) {
  console.log(`FAIL setup - ${err.stack ?? err.message}`);
} finally {
  await ext.close();
  await site.close();
}
finish();
