// A chat per browser tab, in the built extension in Playwright's Chromium: one-off runs
// started from two tabs run at the same time, each acting on its own tab (even after the
// user switched away), the side panel (the page opened as a tab) shows the job of the active tab (the jobs list
// when it has none), a chat whose tab shows a chrome:// page moves to a new tab, a run next to the Noa settings page
// takes the user along from its blank tab to the user's tab it moves to, and closing a chat's tab stops its run.
// The brain is a scripted fake installed in the service worker (no helper, no API key).
// Usage: pnpm build && node apps/extension/test/tabs.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { launchExtension, openPanelWithTabs, pageUi, sessionOf, sessionWhen } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

// /a, /b, /c: a page with a Count button (the fake agent clicks it) and its own title.
const site = await serveHtml((path) => {
  const name = path.slice(1) || "home";
  return `<!doctype html><title>Page ${name}</title><h1>Page ${name}</h1>
<button onclick="document.getElementById('n').textContent = String(++window.clicks)">Count</button>
<p>Clicks: <span id="n">0</span></p>${name === "h" ? '<label>Note <input id="note"></label>' : ""}<script>window.clicks = 0;</script>`;
});
const { base } = site;
// The same server under another host name: another site.
const other = `${base.replace("127.0.0.1", "localhost")}/a`;

const { step, finish } = createSuite("tab");
// x.com goes nowhere (a refused connection): its login address still becomes the tab's, which pauses a run (pause-rules.ts).
const ext = await launchExtension({ name: "tabs", args: ["--host-resolver-rules=MAP x.com 127.0.0.1:9"] });
const { context, sw, extensionId } = ext;

try {
  // The fake brain: each run waits for its gate, then reads its tab and clicks Count there.
  const fake = await installFakeBrain(sw, {
    gated: true,
    arg: { f: `${base}/f`, other, xLogin: "https://x.com/i/flow/login" },
    makeAct: (arg) => {
      const log = (globalThis.__turns = []);
      return async ({ browser }, name) => {
        // Task E starts on a blank tab next to the settings page: the agent moves to the user's own tab /e and works
        // there, holding the turn until the test has looked (globalThis.__goOnE).
        if (name === "task E") {
          const own = (await browser.call("browser.listTabs", {})).tabs.find((t) => t.url.endsWith("/e"));
          await browser.call("browser.switchTab", { tab: own.id });
        }
        // Tasks F: the agent opens a page in a new tab (background: the user keeps their tab) and ends needing the
        // user there (a sign-in), as a run does on a login page it has no credential for.
        if (name.startsWith("task F")) {
          const [tab] = (await browser.call("browser.openTabs", { urls: [arg.f] })).tabs;
          await browser.call("browser.switchTab", { tab: tab.id });
          log.push({ name, url: tab.url });
          return { outcome: "paused", reason: `Sign in on ${tab.url}, then tell me to continue`, byAgent: true };
        }
        // Task G: the agent opens the sign-in page in a background tab (open_tabs, never switched to) and ends needing
        // the user there, as the real agent does after get_credential finds no login.
        if (name === "task G") {
          const [tab] = (await browser.call("browser.openTabs", { urls: [arg.f] })).tabs;
          log.push({ name, url: tab.url });
          return { outcome: "paused", reason: `Please sign in on ${tab.url} in the new tab, then press Continue`, byAgent: true };
        }
        // Task X: a background tab the agent opens reaches X's login page: the runner pauses the run (pause URL).
        if (name === "task X") {
          await browser.call("browser.openTabs", { urls: [arg.xLogin] });
          await new Promise(() => {});
        }
        // Tasks H: the agent goes to another site by address from the user's page /h.
        if (name.startsWith("task H")) {
          const r = await browser.call("browser.navigate", { url: arg.other });
          log.push({ name, r });
          return `navigated: ${JSON.stringify(r)}`;
        }
        const snap = await browser.call("browser.readPage", {});
        const btn = snap.elements.find((e) => e.name === "Count");
        await browser.call("browser.click", { index: btn.index });
        log.push({ name, url: snap.url });
        if (name === "task E") await new Promise((r) => (globalThis.__goOnE = r));
        return `clicked on ${snap.title}`;
      };
    },
  });
  const bindings = () => sw.evaluate(() => globalThis.__noa.tabChats.all());

  // The side panel page as a background tab of the same window, so it follows that window's active tab.
  const {
    panel,
    pages: [pageA, pageB],
    ids: {
      panel: panelTab,
      tabs: [tabA, tabB],
      windowId,
    },
  } = await openPanelWithTabs(ext, [`${base}/a`, `${base}/b`]);
  const ui = pageUi(panel);
  const activate = (tabId) => sw.evaluate(async (t) => void (await chrome.tabs.update(t, { active: true })), tabId);
  const panelView = () =>
    panel.evaluate(() => ({
      // The job page's first message: the prompt that opened it.
      title: document.querySelector("#view-job:not([hidden]) #chat-log .ev-first .ev-user-text")?.textContent ?? null,
      // The jobs list (no job in this tab).
      empty: !document.getElementById("view-list").hidden,
      running: [...document.querySelectorAll('#view-list:not([hidden]) section[aria-labelledby="group-running"] .job-row .job-title')].map((c) => c.textContent.trim()),
    }));
  const clicks = (page) => page.evaluate(() => window.clicks);
  const turnEnded = (sessionId, turns, what) => sessionWhen(sw, sessionId, what, { until: (s) => s.turns === turns && s.endedAt });

  let a;
  let b;
  /** The chat whose tab was closed while it ran (it needs the user). */
  let closed;
  await step("tab A: the jobs list, then a one-off started there is bound to it and its job shows", async () => {
    await activate(tabA);
    await waitFor(async () => (await panelView()).empty, "the jobs list for tab A");
    a = await ui({ type: "run.adhoc", instructions: "task A", tabId: tabA });
    assert.equal((await bindings())[tabA], a.sessionId);
    await waitFor(async () => (await panelView()).title === "task A", "the panel showing task A");
    return `session ${a.sessionId} in tab ${tabA}`;
  });

  await step("switching to tab B shows the list (B has no job) with A's job running", async () => {
    await activate(tabB);
    const v = await waitFor(async () => {
      const x = await panelView();
      return x.empty && x.running.length === 1 ? x : null;
    }, "the list for tab B");
    assert.deepEqual(v.running, ["Task A"]);
    return JSON.stringify(v);
  });

  await step("tab B runs its own chat at the same time; each acts on its own tab", async () => {
    b = await ui({ type: "run.adhoc", instructions: "task B", tabId: tabB });
    await waitFor(async () => (await panelView()).title === "task B", "the panel showing task B");
    const running = await ui({ type: "state.get" });
    assert.deepEqual(running.runningSessions.map((s) => s.title).sort(), ["Task A", "Task B"]);
    assert.deepEqual(running.runningTabs[a.sessionId], [tabA]);
    assert.deepEqual(running.runningTabs[b.sessionId], [tabB]);
    // Both tabs are in the one Noa group of the window: it says two runs work there (control-indicator.ts).
    const groupOf = (t) => sw.evaluate(async (id) => {
      const tab = await chrome.tabs.get(id);
      return tab.groupId === -1 ? null : await chrome.tabGroups.get(tab.groupId).then((g) => ({ id: g.id, title: g.title, color: g.color }));
    }, t);
    const working = await waitFor(async () => {
      const g = await groupOf(tabA);
      return g?.title === "Noa · 2 working" ? g : null;
    }, "the group to say 2 working");
    assert.equal(working.color, "purple");
    assert.equal((await groupOf(tabB))?.id, working.id);
    // The user is on tab B; A's agent still acts on tab A.
    await fake.release("task A");
    await fake.release("task B");
    await waitFor(async () => (await sessionOf(sw, a.sessionId))?.outcome === "done" && (await sessionOf(sw, b.sessionId))?.outcome === "done", "both runs to end");
    await waitFor(async () => (await groupOf(tabA))?.color === "grey", "the group to go idle");
    assert.equal((await groupOf(tabA)).title, "Noa");
    const log = await sw.evaluate(() => globalThis.__turns);
    assert.equal(log.find((l) => l.name === "task A").url, `${base}/a`);
    assert.equal(log.find((l) => l.name === "task B").url, `${base}/b`);
    assert.equal(await clicks(pageA), 1);
    assert.equal(await clicks(pageB), 1);
    assert.equal((await sessionOf(sw, a.sessionId)).summary, "clicked on Page a");
    return "A clicked on /a, B on /b";
  });

  await step("the panel shows the job of the active tab", async () => {
    await activate(tabA);
    await waitFor(async () => (await panelView()).title === "task A", "tab A's chat");
    await activate(tabB);
    await waitFor(async () => (await panelView()).title === "task B", "tab B's chat");
    await activate(panelTab);
    await waitFor(async () => (await panelView()).empty, "a tab without a chat");
    return "A -> task A, B -> task B, other -> the list";
  });

  await step("the next message in tab A's chat acts on tab A again", async () => {
    await activate(tabB);
    // Sent from tab A's panel (the composer names its tab), while the user looks at B.
    const r = await ui({ type: "run.message", sessionId: a.sessionId, text: "again A", tabId: tabA });
    assert.equal(r.mode, "turn");
    await fake.release("again A");
    await waitFor(async () => (await clicks(pageA)) === 2, "a second click on tab A");
    assert.equal(await clicks(pageB), 1);
    await turnEnded(a.sessionId, 2, "turn 2 to end");
    return "clicks: A 2, B 1";
  });

  await step("run.newChat in tab B unbinds only B's chat; chat.bind binds it again and the panel shows it", async () => {
    await ui({ type: "run.newChat", sessionId: b.sessionId, tabId: tabB });
    let map = await bindings();
    assert.equal(map[tabB], undefined);
    assert.equal(map[tabA], a.sessionId);
    // The user goes back to the list (the job stays on screen until then).
    await panel.click("#job-back");
    await waitFor(async () => (await panelView()).empty, "the jobs list");
    const st = await ui({ type: "chat.bind", sessionId: b.sessionId, tabId: tabB });
    assert.equal(st.tabChats[tabB], b.sessionId);
    await waitFor(async () => (await panelView()).title === "task B", "task B back in tab B");
    map = await bindings();
    return JSON.stringify(map);
  });

  await step("the list: picking a past job opens it, bound to the active tab", async () => {
    await ui({ type: "run.newChat", sessionId: b.sessionId, tabId: tabB });
    await panel.click("#job-back");
    await waitFor(async () => (await panelView()).empty, "the jobs list");
    const row = panel.locator(`.job-row[data-key="chat:${b.sessionId}"]`);
    await row.waitFor();
    await row.click();
    const shown = await waitFor(
      () =>
        panel.evaluate(() => ({
          title: document.querySelector("#view-job:not([hidden]) #chat-log .ev-first .ev-user-text")?.textContent,
          ends: document.querySelectorAll("#chat-log .ev-end").length,
          head: document.getElementById("job-title").textContent,
        })).then((v) => (v.title === "task B" && v.ends > 0 ? v : null)),
      "task B on its page",
    );
    assert.equal(shown.head, "Task B");
    assert.equal((await bindings())[tabB], b.sessionId, "bound to the active tab");
    return JSON.stringify(shown);
  });

  await step("a chat whose tab shows a chrome:// page moves to a new tab, and the panel follows it", async () => {
    const pageC = await context.newPage();
    await pageC.goto(`${base}/c`);
    const c = await sw.evaluate(async ([u, w]) => {
      const [t] = await chrome.tabs.query({ url: u });
      if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: -1 });
      await chrome.tabs.update(t.id, { active: true });
      return t.id;
    }, [`${base}/c`, windowId]);
    const s = await ui({ type: "run.adhoc", instructions: "task C", tabId: c });
    await fake.release("task C");
    await sessionWhen(sw, s.sessionId, "task C", { until: (x) => x.outcome === "done" });
    // The tab now shows a browser page; the next turn cannot act there.
    await sw.evaluate(async (t) => void (await chrome.tabs.update(t, { url: "chrome://version/" })), c);
    await waitFor(() => sw.evaluate(async (t) => (await chrome.tabs.get(t)).url.startsWith("chrome://"), c), "chrome://version");
    await ui({ type: "run.message", sessionId: s.sessionId, text: "again C", tabId: c });
    const moved = await waitFor(async () => {
      const m = await bindings();
      const tab = Object.keys(m).find((k) => m[k] === s.sessionId);
      return tab && Number(tab) !== c ? Number(tab) : null;
    }, "the chat to move to a new tab");
    const info = await sw.evaluate(async ([n, old]) => [await chrome.tabs.get(n), await chrome.tabs.get(old)], [moved, c]);
    assert.equal(info[0].active, true);
    assert.equal(info[0].index, info[1].index + 1, "right after the old tab");
    await waitFor(async () => (await panelView()).title === "task C", "the panel following the new tab");
    await fake.release("again C");
    await turnEnded(s.sessionId, 2, "turn 2 of task C");
    return `tab ${c} (chrome://version) -> tab ${moved}`;
  });

  await step("a run next to the Noa settings page: its blank tab in front, then the user follows the agent to their own tab", async () => {
    // The user's page /e is open; they are on the settings page (Chrome keeps extensions out of it) when they ask.
    const pageE = await context.newPage();
    await pageE.goto(`${base}/e`);
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extensionId}/options.html`);
    const [e, settings] = await sw.evaluate(async ([urls, w]) => {
      const ids = [];
      for (const u of urls) {
        const [t] = await chrome.tabs.query({ url: u });
        if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: -1 });
        ids.push(t.id);
      }
      await chrome.tabs.update(ids[1], { active: true });
      return ids;
    }, [[`${base}/e`, `chrome-extension://${extensionId}/options.html`], windowId]);
    const s = await ui({ type: "run.adhoc", instructions: "task E", tabId: settings });
    // The run gets a blank tab right after the settings page, in front; the chat moves there and the panel follows.
    const blank = await waitFor(async () => {
      const m = await bindings();
      const tab = Object.keys(m).find((k) => m[k] === s.sessionId);
      return tab && Number(tab) !== settings ? Number(tab) : null;
    }, "the chat to move to the blank tab");
    const tabOf = (id) => sw.evaluate((t) => chrome.tabs.get(t), id);
    assert.deepEqual(await tabOf(blank).then((t) => ({ url: t.url, active: t.active })), { url: "about:blank", active: true });
    await waitFor(async () => (await panelView()).title === "task E", "the panel following the blank tab");
    // The agent moves to the user's tab /e: the user is taken along, the blank tab stays behind.
    await fake.release("task E");
    try {
      await waitFor(async () => (await tabOf(e)).active, "the user's tab /e in front");
      await waitFor(async () => (await clicks(pageE)) === 1, "a click on /e");
      assert.equal((await tabOf(blank)).active, false);
      const { runningTabs } = await ui({ type: "state.get" });
      assert.deepEqual(runningTabs[s.sessionId], [e, blank], "acting on /e now, the blank tab its first");
      // The panel followed the user to /e before the state said the run acts there: the pushed state puts its job back.
      await waitFor(async () => (await panelView()).title === "task E", "the panel showing the run on /e");
    } finally {
      await sw.evaluate(() => globalThis.__goOnE?.());
    }
    await sessionWhen(sw, s.sessionId, "task E", { until: (x) => x.outcome === "done" });
    assert.equal((await sw.evaluate(() => globalThis.__turns)).find((l) => l.name === "task E").url, `${base}/e`);
    // The user's tab is theirs: never in the Noa group, never closed.
    assert.equal((await tabOf(e)).groupId, -1);
    await settingsPage.close();
    return `blank tab ${blank} -> the user's tab ${e}`;
  });

  await step("a run that ends needing the user in a tab it opened: Auto tab switching brings that tab forward (off: it stays behind)", async () => {
    // The user asks from their page /g and stays there while the agent opens /f in a new tab.
    const pageG = await context.newPage();
    await pageG.goto(`${base}/g`);
    const g = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${base}/g`);
    await sw.evaluate(async (t) => void (await chrome.tabs.update(t, { active: true })), g);
    const tabOf = (id) => sw.evaluate((t) => chrome.tabs.get(t), id);
    const eventsOf = (id) => sw.evaluate(async (i) => (await globalThis.__noa.sessions.eventsOf(i)).map(({ ts, sessionId, ...e }) => e), id);
    const settle = async (name) => {
      const s = await ui({ type: "run.adhoc", instructions: name, tabId: g });
      await fake.release(name);
      const ended = await sessionWhen(sw, s.sessionId, `${name} to end`);
      assert.equal(ended.outcome, "paused", JSON.stringify(ended));
      const f = (await sw.evaluate(async (u) => chrome.tabs.query({ url: u }), `${base}/f`)).at(-1);
      assert.ok(f, "the tab the agent opened");
      return { sessionId: s.sessionId, f: f.id };
    };
    // On (the default): the tab the agent needs the user in comes to the front, and the chat says why.
    const on = await settle("task F on");
    await waitFor(async () => (await tabOf(on.f)).active, "the agent's tab /f in front after its run ended needing the user");
    assert.equal((await tabOf(g)).active, false, "the user's tab /g is behind now");
    const told = (await eventsOf(on.sessionId)).filter((e) => e.type === "auto_tab_switching");
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0].tab, /^t\d+$/);
    assert.deepEqual({ ...told[0], tab: "t?" }, { type: "auto_tab_switching", tab: "t?", url: `${base}/f`, why: "needs_you" }, JSON.stringify(told));
    const ends = (await eventsOf(on.sessionId)).map((e) => e.type);
    assert.ok(ends.indexOf("auto_tab_switching") < ends.indexOf("task_end"), `the notice before the end: ${ends.join(" ")}`);
    await sw.evaluate(async (t) => void (await chrome.tabs.remove(t)), on.f);
    await sw.evaluate(async (t) => void (await chrome.tabs.update(t, { active: true })), g);
    // Off: the user keeps their tab (the "Noa needs you" pill on it opens the chat).
    await sw.evaluate(() => globalThis.__noa.settings.save({ autoTabSwitching: false }));
    try {
      const off = await settle("task F off");
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal((await tabOf(off.f)).active, false, "the agent's tab stays behind");
      assert.equal((await tabOf(g)).active, true, "the user stays on /g");
      assert.deepEqual((await eventsOf(off.sessionId)).filter((e) => e.type === "auto_tab_switching"), []);
      await sw.evaluate(async (t) => void (await chrome.tabs.remove(t)), off.f);
    } finally {
      await sw.evaluate(() => globalThis.__noa.settings.save({ autoTabSwitching: true }));
    }
    await pageG.close();
    return `on: /f in front; off: /g kept`;
  });

  await step("a run that ends needing the user in a background tab it opened (never switched to), by its own pause or a login page: that tab comes forward", async () => {
    const pageG = await context.newPage();
    await pageG.goto(`${base}/g`);
    const g = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${base}/g`);
    const tabOf = (id) => sw.evaluate((t) => chrome.tabs.get(t), id);
    const eventsOf = (id) => sw.evaluate(async (i) => (await globalThis.__noa.sessions.eventsOf(i)).map(({ ts, sessionId, ...e }) => e), id);
    const settle = async (name, url) => {
      await sw.evaluate(async (t) => void (await chrome.tabs.update(t, { active: true })), g);
      const s = await ui({ type: "run.adhoc", instructions: name, tabId: g });
      await fake.release(name);
      const ended = await sessionWhen(sw, s.sessionId, `${name} to end`);
      assert.equal(ended.outcome, "paused", JSON.stringify(ended));
      const opened = (await sw.evaluate(async (u) => chrome.tabs.query({ url: u }), url)).at(-1);
      assert.ok(opened, `the tab the agent opened at ${url}`);
      await waitFor(async () => (await tabOf(opened.id)).active, `${name}: the tab it opened (${url}) in front after its run ended needing the user`);
      assert.equal((await tabOf(g)).active, false, "the user's tab /g is behind now");
      const told = (await eventsOf(s.sessionId)).filter((e) => e.type === "auto_tab_switching");
      assert.deepEqual(
        told.map((e) => [e.url, e.why]),
        [[url, "needs_you"]],
        JSON.stringify(told),
      );
      await sw.evaluate(async (t) => void (await chrome.tabs.remove(t)), opened.id);
      return ended.reason;
    };
    const own = await settle("task G", `${base}/f`);
    const login = await settle("task X", "https://x.com/i/flow/login");
    await pageG.close();
    return `its pause: ${own}; the login page: ${login}`;
  });

  await step("navigate to another site from a page whose form holds what the user typed: the page stays, the address opens in a new tab", async () => {
    const pageH = await context.newPage();
    await pageH.goto(`${base}/h`);
    const h = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${base}/h`);
    const run = async (name) => {
      const s = await ui({ type: "run.adhoc", instructions: name, tabId: h });
      await fake.release(name);
      await sessionWhen(sw, s.sessionId, `${name} to end`);
      return (await sw.evaluate(() => globalThis.__turns)).find((t) => t.name === name).r;
    };
    // Typed into: kept.
    await pageH.fill("#note", "half-written note");
    const kept = await run("task H typed");
    assert.match(kept.kept ?? "", /^t\d+$/, JSON.stringify(kept));
    assert.equal(kept.url, other);
    assert.equal(pageH.url(), `${base}/h`, "the user's page stays");
    assert.equal(await pageH.inputValue("#note"), "half-written note", "with what was typed");
    const opened = (await sw.evaluate(async (u) => chrome.tabs.query({ url: u }), other)).map((t) => t.id);
    assert.equal(opened.length, 1, "the address in a new tab");
    await sw.evaluate(async (ids) => chrome.tabs.remove(ids), opened);
    // Nothing typed: the tab itself goes there.
    await pageH.fill("#note", "");
    const moved = await run("task H empty");
    assert.equal(moved.kept, undefined, JSON.stringify(moved));
    await waitFor(async () => pageH.url() === other, "the user's tab on the other site");
    await pageH.close();
    return `typed: kept as ${kept.kept}, opened in ${kept.tab}; empty: navigated in place`;
  });

  await step("closing a chat's tab while it runs stops it (paused); the session stays", async () => {
    const pageD = await context.newPage();
    await pageD.goto(`${base}/d`);
    const d = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${base}/d`);
    const s = (closed = await ui({ type: "run.adhoc", instructions: "task D", tabId: d }));
    await fake.started("task D");
    await pageD.close();
    const ended = await sessionWhen(sw, s.sessionId, "task D to stop");
    assert.equal(ended.outcome, "paused");
    assert.equal(ended.reason, "The tab was closed");
    assert.equal((await bindings())[d], undefined);
    const { sessions } = await ui({ type: "sessions.list" });
    assert.ok(sessions.some((x) => x.sessionId === s.sessionId), "still in the jobs list");
    return `${ended.outcome}: ${ended.reason}`;
  });

  await step("the stopped chat under Needs you, dismissed with Delete: it moves to Recent as Dismissed and stays so", async () => {
    await activate(panelTab);
    await waitFor(async () => (await panelView()).empty, "the jobs list");
    const key = `chat:${closed.sessionId}`;
    const where = () =>
      panel.evaluate((k) => {
        const r = document.querySelector(`.job-row[data-key="${k}"]`);
        return r ? { group: r.closest("section").getAttribute("aria-labelledby"), state: r.dataset.state } : null;
      }, key);
    await waitFor(async () => (await where())?.group === "group-needs", "task D under Needs you");
    await panel.focus(`.job-row[data-key="${key}"]`);
    await panel.keyboard.press("Delete");
    await waitFor(async () => (await where())?.state === "dismissed", "task D dismissed");
    assert.equal((await where()).group, "group-recent");
    // Kept once Undo's time is over.
    const kept = await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get("jobDismissals"))).jobDismissals?.[key] ?? null, "the dismissal kept", { timeout: 15_000 });
    assert.ok(kept.needs.startsWith(`run:${closed.sessionId}:`), JSON.stringify(kept));
    // A new panel shows it the same.
    await panel.reload();
    await waitFor(async () => (await where())?.state === "dismissed", "task D still dismissed after a reload");
    return JSON.stringify(kept);
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
