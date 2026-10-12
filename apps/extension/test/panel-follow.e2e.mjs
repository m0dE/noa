// One side panel per window whose content follows the active tab, in the built extension in a HEADED Playwright
// Chromium (a real window: the panel's visibility is real). Owner's request: "show extension in all tabs when the
// extension is open. what differs is the content inside."
//
// Checked: the manifest's side panel is on by default; the toolbar button opens it once for the window; switching
// tabs keeps the same panel page on screen; a tab with a job (its chat) shows that job, a tab without one shows the
// list when the job on screen was the tab left behind's, and a job the user opened that belongs to no tab (a
// scheduled task) stays; a new job started from the composer is bound to the tab in front. (Voice's strip and Go to
// tab across tabs: hands-free-tabs.e2e.mjs.)
//
// The toolbar button is clicked with CDP's Extensions.triggerAction. The real side panel is read through
// chrome.extension.getViews() from an extension tab. No OS-level keystrokes are sent.
// Usage: pnpm build && node apps/extension/test/panel-follow.e2e.mjs
import assert from "node:assert/strict";
import { holdAlarmRuns, launchExtension, routerUi, sessionWhen } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

const TASK_A = "Summarize tab A";
const REPLY = "Scripted answer";
const SCHEDULED = "Water the plants tomorrow";
const STARTED_IN_C = "Started from tab C";
const site = await serveHtml((path) => `<!doctype html><title>Page ${path}</title><body><h1>${path}</h1></body>`);
const { step, finish } = createSuite("panel-follow");
const ext = await launchExtension({ name: "panel-follow", headed: true });
const { context, sw, extensionId } = ext;

try {
  const A = `${site.base}/a`;
  const B = `${site.base}/b`;
  const C = `${site.base}/c`;
  const HOST = `chrome-extension://${extensionId}/mic-permission.html`;
  const cdp = await context.browser().newBrowserCDPSession();
  const ui = routerUi(sw);
  await holdAlarmRuns(sw);
  await installFakeBrain(sw, { makeAct: (reply) => async () => reply, arg: REPLY });

  const pages = {};
  for (const [name, url] of Object.entries({ a: A, b: B, c: C })) {
    pages[name] = await context.newPage();
    await pages[name].goto(url);
  }
  // The probe's extension tab, in the same window, behind the others.
  const host = await context.newPage();
  await host.goto(HOST);
  const tabOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0], url);
  const { id: tabA, windowId } = await tabOf(A);
  const tabB = (await tabOf(B)).id;
  const tabC = (await tabOf(C)).id;
  await sw.evaluate(async ([urls, w]) => {
    for (const u of urls) {
      const [t] = await chrome.tabs.query({ url: u });
      if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: -1 });
    }
  }, [[B, C, HOST], windowId]);

  // Tab A has a chat (a job): run from tab A, bound to it.
  const { sessionId } = await ui({ type: "run.adhoc", instructions: TASK_A, tabId: tabA });
  await sessionWhen(sw, sessionId, "tab A's run to end");
  // A scheduled task: a job that belongs to no tab.
  await ui({ type: "tasks.add", instructions: SCHEDULED, notBefore: new Date(Date.now() + 86_400_000).toISOString() });

  /** The window's side panel pages: whether each shows, its view (list or job), the job's title and chat, a mark. */
  const panels = () =>
    host.evaluate(() =>
      chrome.extension
        .getViews()
        .filter((v) => v.location.pathname === "/sidepanel.html")
        .map((v) => {
          const d = v.document;
          return {
            visible: d.visibilityState === "visible",
            view: d.getElementById("view-job").hidden ? "list" : "job",
            title: d.getElementById("view-job").hidden ? null : (d.querySelector("#job-head h1, #job-title")?.textContent ?? null),
            chat: d.getElementById("chat-log").textContent,
            rows: [...d.querySelectorAll(".job-row .job-title")].map((t) => t.textContent),
            mark: v.__mark ?? null,
          };
        }),
    );
  const onlyPanel = async () => {
    const all = await panels();
    assert.equal(all.length, 1, `one side panel page: ${JSON.stringify(all)}`);
    return all[0];
  };
  /** Runs `what` in the side panel page. */
  const inPanel = (what, arg) =>
    host.evaluate(
      ([what, arg]) => {
        const v = chrome.extension.getViews().find((x) => x.location.pathname === "/sidepanel.html");
        if (!v) throw new Error("no side panel");
        const d = v.document;
        if (what === "mark") v.__mark = arg;
        else if (what === "open") [...d.querySelectorAll(".job-row")].find((r) => r.querySelector(".job-title").textContent === arg).click();
        else if (what === "send") {
          const t = d.getElementById("now-text");
          t.value = arg;
          t.dispatchEvent(new v.Event("input", { bubbles: true }));
          d.getElementById("now-form").requestSubmit();
        }
        return true;
      },
      [what, arg],
    );
  const activate = async (name, tab) => {
    await sw.evaluate((t) => chrome.tabs.update(t, { active: true }), tab);
    await pages[name].bringToFront();
  };
  const shows = (what, test) =>
    waitFor(async () => {
      const [p] = await panels();
      return p && test(p) ? p : null;
    }, what);

  await step("the manifest's side panel is on by default, one page for the window", async () => {
    const def = await sw.evaluate(() => chrome.sidePanel.getOptions({}));
    assert.deepEqual(def, { enabled: true, path: "sidepanel.html" });
    const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
    assert.equal(behavior.openPanelOnActionClick, true);
    return JSON.stringify({ def, behavior });
  });

  await step("the toolbar button on tab B (no job) opens the window's panel, on the list", async () => {
    await activate("b", tabB);
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: targetInfos.find((t) => t.url === B).targetId });
    const p = await shows("the side panel on the list, with tab A's job listed", (x) => x.visible && x.view === "list" && x.rows.includes(TASK_A));
    await inPanel("mark", "the page");
    return JSON.stringify({ view: p.view, rows: p.rows });
  });

  await step("switching to tab A: the same panel stays on screen and shows tab A's job", async () => {
    await activate("a", tabA);
    const p = await shows("tab A's job", (x) => x.view === "job" && x.chat.includes(REPLY));
    assert.equal(p.visible, true);
    assert.equal((await onlyPanel()).mark, "the page", "the same panel page");
    return JSON.stringify({ view: p.view, title: p.title });
  });

  await step("switching to tab B: still on screen; tab A's job stays with tab A (the list)", async () => {
    await activate("b", tabB);
    const p = await shows("the list", (x) => x.view === "list");
    assert.equal(p.visible, true);
    assert.equal(p.mark, "the page");
    return JSON.stringify({ view: p.view });
  });

  await step("a job the user opens that belongs to no tab (a scheduled task) stays on screen on a tab without a job; a tab with one shows its own", async () => {
    await inPanel("open", SCHEDULED);
    await shows("the scheduled task's page", (x) => x.view === "job" && !x.chat.includes(REPLY));
    await activate("c", tabC);
    // Given time to follow, it stays: the task is no tab's.
    await new Promise((r) => setTimeout(r, 800));
    const kept = await onlyPanel();
    assert.equal(kept.view, "job", JSON.stringify(kept));
    assert.ok(!kept.chat.includes(REPLY), JSON.stringify(kept));
    await activate("a", tabA);
    const own = await shows("tab A's job again", (x) => x.view === "job" && x.chat.includes(REPLY));
    assert.equal(own.mark, "the page");
    return JSON.stringify({ onC: kept.view, onA: own.title });
  });

  await step("a new job started from the composer on tab C is bound to tab C, and follows it", async () => {
    await activate("c", tabC);
    await shows("the list on tab C", (x) => x.view === "list");
    await inPanel("send", STARTED_IN_C);
    const started = await waitFor(() => sw.evaluate((t) => globalThis.__noa.tabChats.get(t), tabC), "the new chat bound to tab C", { timeout: 15_000 });
    await sessionWhen(sw, started, "tab C's run to end");
    await shows("tab C's job", (x) => x.view === "job" && x.chat.includes(STARTED_IN_C));
    await activate("b", tabB);
    await shows("the list on tab B", (x) => x.view === "list");
    await activate("c", tabC);
    const p = await shows("tab C's job again", (x) => x.view === "job" && x.chat.includes(STARTED_IN_C));
    assert.equal(p.mark, "the page");
    assert.equal((await onlyPanel()).visible, true);
    return started;
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
