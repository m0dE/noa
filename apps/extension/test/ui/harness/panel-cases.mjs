// The side panel cases of the UI harness: each { names (its screenshots), run(t) } runs when --only
// matches one of its names (or `when(t)` says so) at every panel size and colour scheme. `t` has the
// size's browser context and label, the checks (checks.mjs) and the panel helpers below.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installChromeStub, installVoiceFakes } from "./chrome-stub.mjs";
import { EMAIL_ANSWER, scenario, SHORTCUT_LABEL, SUGGESTION, thumbnail, VOICE_SHORTCUT_LABEL } from "./scenarios.mjs";
import { RAW_SECRET } from "./raw-scenario.mjs";

export const SIZES = [
  { w: 360, h: 800 },
  { w: 480, h: 900 },
];

/** A follow-up suggestion near the longest allowed (MAX_SUGGESTION_CHARS). */
const LONG_SUGGESTION = "Reply to Jordan and Sam that I'll sign the lease on Thursday and call on Friday";

const LONG_TEXT = [
  "Post the launch thread on X from @noa:",
  "1. We just shipped Noa 0.2",
  "2. It runs your todo list in the browser, on a schedule",
  "3. Try it: add a task, close the laptop lid, and it still posts on time.",
  "4. Link to the blog post",
  "5. Thank the beta testers",
  "6. Pin the thread",
  "7. Reply to the first comment",
  "8. Like the replies from people we follow",
  "9. Tell me when it is done",
].join("\n");

/** Checks shared by the panel cases, for the size and scheme `label`; problems go to `problem`. */
export function panelHelpers(label, problem) {
  const fail = (what) => problem(`${what} (${label})`);
  /** The job page's "⋯" menu: its items (opened, then closed again unless `keep`). */
  const menuItems = async (p, keep = false) => {
    await p.click("#job-menu summary");
    await p.waitForSelector("#job-menu[open] #job-menu-pop button");
    const items = await p.evaluate(() => [...document.querySelectorAll("#job-menu-pop button")].map((b) => ({ label: b.textContent, title: b.title })));
    if (items.some((i) => !i.title)) fail(`a menu item without a tooltip: ${JSON.stringify(items)}`);
    if (!keep) await p.evaluate(() => (document.getElementById("job-menu").open = false));
    return items.map((i) => i.label);
  };
  const expectMenu = async (p, want, what) => {
    const got = (await menuItems(p)).join(" | ");
    if (got !== want.join(" | ")) fail(`${what}: menu "${got}", want "${want.join(" | ")}"`);
  };
  /** Picks a menu item. */
  const pick = async (p, label) => {
    if (!(await p.evaluate(() => document.getElementById("job-menu").open))) await p.click("#job-menu summary");
    await p.locator("#job-menu-pop button", { hasText: label }).first().click();
  };
  /** The list's groups: [label, row keys][]. */
  const groups = (p) =>
    p.evaluate(() => [...document.querySelectorAll(".job-group")].map((g) => [g.querySelector(".group-head").firstChild.textContent, [...g.querySelectorAll(".job-row")].map((r) => r.dataset.key)]));
  /** Every status chip explains itself. */
  const expectChipHints = async (p, what) => {
    const bare = await p.evaluate(() => [...document.querySelectorAll(".chip")].filter((c) => c.offsetParent && !c.title && !c.closest(".ev-jev")).map((c) => c.textContent));
    if (bare.length) fail(`${what}: chips without a tooltip: ${bare.join(", ")}`);
  };
  /**
   * The chat's first message (the prompt or task that opened it, the first thing in the log): its text, its origin
   * label, its files line, the time under it, the brain chip right after it; null when the chat has none.
   */
  const firstMessage = (p) =>
    p.evaluate(() => {
      const wrap = document.querySelector("#chat-log > .ev-opening");
      const b = wrap?.querySelector(".ev-first");
      if (!b) return null;
      return {
        first: wrap === document.getElementById("chat-log").firstElementChild,
        text: b.querySelector(".ev-user-text, :scope.screen > span")?.textContent ?? null,
        screen: b.classList.contains("screen"),
        origin: b.querySelector(".ev-origin")?.textContent ?? null,
        files: b.querySelector(".ev-files")?.textContent ?? null,
        when: wrap.querySelector(".ev-when")?.textContent ?? null,
        role: b.getAttribute("role"),
        tabIndex: b.tabIndex,
        head: wrap.nextElementSibling?.classList.contains("ev-head") ? wrap.nextElementSibling.textContent : null,
        // The old header block is gone, and each brain's start line is left to the chip.
        header: !!document.querySelector("#chat-title, #chat-meta, #chat-conv"),
        startLines: [...document.querySelectorAll("#chat-log .ev-status")].filter((e) => /^(Claude Code started|Claude API \(|Noa AI \()/i.test(e.textContent)).length,
      };
    });
  /** Waits until the chat's first message starts with `text`. */
  const waitFirst = (p, text) => p.waitForFunction((t) => document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent.startsWith(t), text);
  return { fail, menuItems, expectMenu, pick, groups, expectChipHints, firstMessage, waitFirst };
}

export const PANEL_CASES = [
  // Idle: the panel opens on the jobs list (the name and the avatar over it, no tabs); the composer starts a new job.
  {
    names: ["panel-list-idle", "panel-composer-long", "panel-model-menu", "panel-composer-files"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle");
      const head = await p.evaluate(() => ({
        brand: document.getElementById("brand").textContent,
        acct: !!document.querySelector("#list-head #acct"),
        jobHead: document.getElementById("job-head").hidden,
        old: !!document.querySelector("[role=tablist]:not(#job-views), #tab-chat, #tab-todo, #tab-history, .chat-bar, #chat-new"),
        search: document.getElementById("job-search").placeholder,
        status: document.getElementById("status").hidden,
      }));
      if (head.brand !== "Noa" || !head.acct || !head.jobHead || head.old || head.search !== "Search jobs" || !head.status) fail(`list header ${JSON.stringify(head)}`);
      await checkLayout(p, `idle ${label}`);
      await shoot(p, "panel-list-idle", size, scheme);
      if (want("panel-composer-long", size, scheme)) {
        await p.click("#now-text");
        await p.keyboard.insertText(LONG_TEXT);
        await checkLayout(p, `composer-long ${label}`);
        await shoot(p, "panel-composer-long", size, scheme);
        await p.fill("#now-text", "");
      }
      if (want("panel-model-menu", size, scheme)) {
        const chip = p.locator("#now-model");
        if ((await chip.textContent()).trim() !== "Sonnet 5 · Jev") fail(`model chip shows "${(await chip.textContent()).trim()}"`);
        await chip.click();
        await p.waitForSelector("#model-menu:not([hidden])");
        await checkLayout(p, `model-menu ${label}`);
        // Each model says how fast and how costly it is, from the shared catalog (modelHint).
        const hints = await p.evaluate(() => [...document.querySelectorAll(".mm-item[role=menuitemradio]")].map((b) => [b.querySelector(".mm-label")?.textContent, b.querySelector(".mm-hint")?.textContent]));
        const wanted = [
          ["Sonnet 5", "Faster · default price"],
          ["Opus 5.5", "Thinks first, slower · 2× price"],
          ["Fable 5.1", "Thinks first, slower · 5× price"],
          ["Haiku 4.5", "Faster · ½ price"],
        ];
        if (JSON.stringify(hints) !== JSON.stringify(wanted)) fail(`model menu hints ${JSON.stringify(hints)}`);
        // Each hint stays inside the menu and clear of the check mark.
        const spill = await p.evaluate(() => {
          const menu = document.getElementById("model-menu").getBoundingClientRect();
          return [...document.querySelectorAll(".mm-item[role=menuitemradio] .mm-hint")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              const mark = el.closest(".mm-item").querySelector(".mm-check")?.getBoundingClientRect();
              return r.right > menu.right - 4 || el.scrollWidth > el.clientWidth || (mark && r.right > mark.left);
            })
            .map((el) => el.textContent);
        });
        if (spill.length) fail(`model menu hints spill over: ${JSON.stringify(spill)}`);
        await shoot(p, "panel-model-menu", size, scheme);
        // Keyboard: Escape closes and returns focus to the chip.
        await p.keyboard.press("Escape");
        const escaped = await p.evaluate(() => document.getElementById("model-menu").hidden && document.activeElement?.id === "now-model");
        // Arrow keys open it again; pick Opus with the keyboard.
        await p.keyboard.press("ArrowDown");
        await p.keyboard.press("ArrowDown");
        await p.keyboard.press("Enter");
        await p.waitForFunction(() => document.getElementById("now-model-label").textContent === "Opus 5.5 · Jev");
        const saved = await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.anthropicModel === "claude-opus-5-5"));
        // Click outside closes.
        await chip.click();
        await p.locator("#brand").click();
        const outside = await p.evaluate(() => document.getElementById("model-menu").hidden);
        // Thorough reasoning: a switch like Jev's, saved with the settings.
        await chip.click();
        await p.click("#model-menu .mm-reasoning");
        const thorough = await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.reasoning === "thorough"));
        if (!escaped || !saved || !outside || !thorough) fail(`model menu behaviour: escape=${escaped} saved=${saved} outside=${outside} thorough=${thorough}`);
      }
      if (want("panel-composer-files", size, scheme)) {
        await p.setInputFiles("#now-files", [
          { name: "week38-photo-of-the-week-final.jpg", mimeType: "image/jpeg", buffer: Buffer.from(thumbnail, "base64") },
          { name: "caption.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
        ]);
        await p.waitForFunction(() => document.querySelectorAll("#now-files-list .att-chip:not(.preparing)").length === 2);
        await p.click("#now-text");
        await p.keyboard.insertText("Post the photo of the week with this caption");
        await checkLayout(p, `composer-files ${label}`);
        await shoot(p, "panel-composer-files", size, scheme);
      }
      reportErrors(p, `idle ${label}`);
      await p.close();
    },
  },
  // An empty box: the placeholder says what Enter does; Send looks usable; with no jobs yet the list shows the
  // shortcut. Enter starts "look at this page" in this tab, and its job opens with it as a quiet user turn. The
  // shortcut's push focuses the box in the view shown; Set a shortcut opens Chrome's page when none is set.
  {
    names: ["panel-empty-send", "panel-empty-send-sent", "panel-restricted", "panel-empty-noshortcut"],
    async run({ ctx, size, scheme, label, fail, firstMessage, openPanel, backToList, shoot, checkLayout, reportErrors }) {
      const SCREEN = "Figure out what to do based on the current screen";
      const p = await openPanel(ctx, "nojobs", ".jobs-empty .shortcut-hint");
      const look = await p.evaluate(() => {
        const t = document.getElementById("now-text");
        const b = document.getElementById("now-submit");
        return {
          placeholder: t.placeholder,
          focused: document.activeElement === t,
          opacity: getComputedStyle(b).opacity,
          title: b.title,
          hint: document.querySelector(".jobs-empty .shortcut-hint")?.textContent,
          hello: window.__portSent.some((m) => m.type === "panel.hello" && m.windowId === 1),
        };
      });
      if (look.placeholder !== "Start a new job…") fail(`empty send: placeholder "${look.placeholder}"`);
      if (!look.focused) fail("empty send: the box is not focused when the panel opens");
      if (look.opacity !== "1") fail(`empty send: Send looks unavailable (opacity ${look.opacity})`);
      if (!/look at this page/.test(look.title)) fail(`empty send: Send tooltip "${look.title}"`);
      // Both keys, briefly: open, and talk.
      if (look.hint !== `${SHORTCUT_LABEL} to open · ${VOICE_SHORTCUT_LABEL} to talk`) fail(`empty send: shortcut hint "${look.hint}"`);
      if (!look.hello) fail("empty send: the panel did not tell the background its window");
      // The placeholder is one line at this width (measured with the box's font).
      const oneLine = await p.evaluate((text) => {
        const t = document.getElementById("now-text");
        const cs = getComputedStyle(t);
        const c = document.createElement("canvas").getContext("2d");
        c.font = `${cs.fontSize} ${cs.fontFamily}`;
        return c.measureText(text).width <= t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      }, SCREEN);
      if (!oneLine) fail("empty send: the placeholder wraps");
      await checkLayout(p, `empty send ${label}`);
      await shoot(p, "panel-empty-send", size, scheme);

      await p.click("#now-text");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc" && r.screen === true));
      const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.adhoc" && r.screen));
      if (req.instructions !== "" || req.tabId !== 1) fail(`empty send: request ${JSON.stringify(req)}`);
      await p.waitForSelector("#view-job:not([hidden]) #chat-log .ev-user.screen");
      const push = (e) => p.evaluate((ev) => window.__push({ type: "event", event: { ...ev, ts: new Date().toISOString(), sessionId: "s-new" } }), e);
      await push({ type: "tool_call", id: "1", name: "screenshot", args: {} });
      await push({ type: "tool_result", id: "1", name: "screenshot", thumbnail });
      await push({ type: "tool_call", id: "2", name: "read_page", args: {} });
      await push({ type: "tool_result", id: "2", name: "read_page", text: "URL: http://127.0.0.1/signup/check-email" });
      await push({
        type: "assistant_text",
        text: "The page says a verification link was sent to **test@example.com**. I'll open that mailbox in a new tab, find the email and click the link.",
      });
      await push({ type: "tool_call", id: "3", name: "open_tabs", args: { urls: ["http://127.0.0.1/mail"] } });
      await p.waitForSelector("#chat-log .ev-text");
      // The empty send is the job's first message, in its own quiet look; the page's title says it too.
      const turn = await p.evaluate(() => ({ text: document.querySelector("#chat-log .ev-user.screen")?.textContent, users: document.querySelectorAll("#chat-log .ev-user").length, title: document.getElementById("job-title").textContent }));
      const first = await firstMessage(p);
      if (turn.text !== SCREEN || turn.users !== 1 || !first?.first || !first.screen || first.text !== SCREEN || first.header || !first.when) fail(`empty send: user turn ${JSON.stringify({ turn, first })}`);
      if (turn.title !== SCREEN) fail(`empty send: the job's title "${turn.title}"`);
      await checkLayout(p, `empty send sent ${label}`);
      await shoot(p, "panel-empty-send-sent", size, scheme);

      // Chrome keeps extensions out of the user's page: one quiet line, the run goes on.
      await push({ type: "status", text: "Chrome doesn't let extensions see this page; Noa will work in other tabs" });
      await p.waitForFunction(() => document.querySelector("#chat-log")?.textContent.includes("Chrome doesn't let extensions see this page"));
      const line = await p.evaluate(() => {
        const el = [...document.querySelectorAll("#chat-log *")].reverse().find((e) => e.children.length === 0 && e.textContent.includes("Chrome doesn't let extensions"));
        return { cls: el?.className, err: !!el?.closest(".ev-error") };
      });
      if (!line.cls || line.err) fail(`restricted: not a quiet line ${JSON.stringify(line)}`);
      await checkLayout(p, `restricted ${label}`);
      await shoot(p, "panel-restricted", size, scheme);

      // The keyboard shortcut's push: the cursor in the box, on the job's page and on the list alike.
      await p.focus("#job-back");
      await p.evaluate(() => window.__push({ type: "panel.focus" }));
      if ((await p.evaluate(() => document.activeElement?.id)) !== "now-text" || !(await p.isVisible("#view-job"))) fail("shortcut focus on a job's page");
      await backToList(p);
      await p.focus("#job-search");
      await p.evaluate(() => window.__push({ type: "panel.focus" }));
      if ((await p.evaluate(() => document.activeElement?.id)) !== "now-text" || !(await p.isVisible("#view-list"))) fail("shortcut focus on the list");
      // The page's focus is reported with the text in the box (the shortcut recreates the panel from there when it lacks the focus).
      if (!(await p.evaluate(() => window.__portSent.some((m) => m.type === "panel.document")))) fail("page focus not reported");
      reportErrors(p, `empty send ${label}`);
      await p.close();

      // No key assigned (another extension has it): the empty list links to Chrome's shortcut settings instead.
      const n = await openPanel(ctx, "noshortcut", ".jobs-empty .shortcut-hint", { edit: (d) => (d.sessions.splice(0), d.tasks.splice(0)) });
      const hint = await n.evaluate(() => document.querySelector(".jobs-empty .shortcut-hint").textContent);
      if (hint !== "Set a keyboard shortcut to open Noa at any time.") fail(`no shortcut: hint "${hint}"`);
      await n.click(".jobs-empty .shortcut-link");
      if (!(await n.evaluate(() => window.__created.includes("chrome://extensions/shortcuts")))) fail("no shortcut: the link did not open chrome://extensions/shortcuts");
      await shoot(n, "panel-empty-noshortcut", size, scheme);
      reportErrors(n, `no shortcut ${label}`);
      await n.close();
    },
  },
  // Older panels kept their last tab (and links may carry #todo or #history): every one opens the list, and is forgotten.
  {
    when: ({ size, scheme, only }) => size.w === 360 && scheme === "light" && !only,
    async run({ ctx, label, fail, openPanel, reportErrors }) {
      const p = await openPanel(ctx, "idle");
      for (const [key, value, hash] of [["tab", "tasks", ""], ["noa.panel.tab", "history", "#history"], ["noa.panel.tab", "todo", "#todo"]]) {
        await p.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
        // (A hash alone does not load the page again: a reload does.)
        await p.goto(`${new URL(p.url()).origin}/sidepanel.html${hash}`);
        await p.reload();
        await p.waitForSelector("#view-list:not([hidden]) #job-groups > *");
        const got = await p.evaluate(() => ({ job: !document.getElementById("view-job").hidden, kept: localStorage.getItem("tab") ?? localStorage.getItem("noa.panel.tab"), hash: location.hash }));
        if (got.job || got.kept !== null || got.hash) fail(`saved tab "${value}" ${hash}: ${JSON.stringify(got)}`);
      }
      reportErrors(p, `old tabs ${label}`);
      await p.close();
    },
  },
  // No jobs yet: the list says how to start one (and the shortcuts), and nothing else.
  {
    names: ["panel-list-empty"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "nojobs", ".jobs-empty");
      const got = await p.evaluate(() => ({ title: document.querySelector(".jobs-empty .empty-title")?.textContent, groups: document.querySelectorAll(".job-group").length, text: document.querySelector(".jobs-empty").textContent }));
      if (got.title !== "No jobs yet" || got.groups || !/every day at 9/.test(got.text)) fail(`empty list ${JSON.stringify(got)}`);
      await checkLayout(p, `list empty ${label}`);
      await shoot(p, "panel-list-empty", size, scheme);
      reportErrors(p, `list empty ${label}`);
      await p.close();
    },
  },
  // The list with every group (Needs you, Running, Upcoming soonest first, Recent newest first), one line per job;
  // the keyboard moves through it (from the search field too); a job opens on its page (its conversation, its "⋯"
  // menu); back gives the list as it was left (the search, the scroll, the row); a finished job opened here is bound
  // to this tab.
  {
    names: ["panel-list", "panel-list-search", "panel-model-running", "panel-chat-running", "panel-job-menu", "panel-job-opened"],
    async run({ ctx, size, scheme, label, fail, want, groups, expectMenu, pick, firstMessage, openPanel, backToList, shoot, checkLayout, reportErrors, shots, taken }) {
      const page = await openPanel(ctx, "ok");
      const g = await groups(page);
      const layout = [
        ["Needs you", ["task:t5", "chat:s-3"]],
        ["Running", ["task:t2"]],
        ["Upcoming", ["task:t3", "task:t4", "task:t1"]],
        ["Recent", ["task:t6", "task:t7"]],
      ];
      if (JSON.stringify(g) !== JSON.stringify(layout)) fail(`list groups ${JSON.stringify(g)}`);
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll(".job-row")].map((r) => ({
          key: r.dataset.key,
          title: r.querySelector(".job-title").textContent,
          meta: r.querySelector(".job-meta")?.textContent ?? "",
          when: r.querySelector(".job-when").textContent,
          aria: r.getAttribute("aria-label"),
          icon: r.querySelector(".job-icon").title,
          oneLine: r.querySelector(".job-title").scrollHeight <= r.querySelector(".job-title").clientHeight + 1,
        })),
      );
      const row = (key) => rows.find((r) => r.key === key);
      if (row("task:t5")?.meta !== "Needs a one-time code sent by SMS" || row("chat:s-3")?.meta !== "Needs you to pick dates") fail(`needs-you rows ${JSON.stringify(rows.slice(0, 2))}`);
      if (row("task:t2")?.when !== "now" || row("task:t3")?.when !== "Due now" || !/^Retries /.test(row("task:t4")?.when ?? "") || !/^Daily at 9:00 AM and 6:00 PM$/.test(row("task:t1")?.meta ?? "")) fail(`scheduled rows ${JSON.stringify(rows)}`);
      if (row("task:t6")?.meta !== "x.com" || !/ago$/.test(row("task:t6")?.when ?? "")) fail(`recent row ${JSON.stringify(row("task:t6"))}`);
      if (!rows.every((r) => r.aria?.startsWith(r.title) && r.icon && r.oneLine)) fail(`row names, icons or lines ${JSON.stringify(rows)}`);
      if (rows.some((r) => /\d \d|\*/.test(r.meta))) fail(`raw cron in a row: ${JSON.stringify(rows)}`);
      await checkLayout(page, `list ${label}`);
      await shoot(page, "panel-list", size, scheme);

      // The keyboard: Down from the search field to the first row, on through the groups, End, Home, Up back to the search.
      await page.focus("#job-search");
      const focusKey = () => page.evaluate(() => document.activeElement?.dataset?.key ?? document.activeElement?.id);
      const keys = [];
      for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "End", "Home", "ArrowUp"]) {
        await page.keyboard.press(k);
        keys.push(await focusKey());
      }
      if (keys.join() !== "task:t5,chat:s-3,task:t2,task:t7,task:t5,job-search") fail(`list keys moved ${keys.join()}`);

      // Search: every word in a title, request or site; the groups keep their order; a short panel scrolls.
      await page.setViewportSize({ width: size.w, height: 420 });
      await page.fill("#job-search", "post");
      const found = await groups(page);
      if (JSON.stringify(found) !== JSON.stringify([["Running", ["task:t2"]], ["Upcoming", ["task:t3", "task:t4"]], ["Recent", ["task:t6", "task:t7"]]])) fail(`search "post" ${JSON.stringify(found)}`);
      await checkLayout(page, `list search ${label}`);
      await shoot(page, "panel-list-search", size, scheme);
      await page.evaluate(() => (document.getElementById("view-list").scrollTop = 60));
      const scrolled = await page.evaluate(() => document.getElementById("view-list").scrollTop);

      // Enter opens the running job: its page, the box to type in, the view said to screen readers.
      await page.focus('.job-row[data-key="task:t2"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector("#view-job:not([hidden]) #chat-log .ev-tool", { state: "attached" });
      await page.setViewportSize({ width: size.w, height: size.h });
      const opened = await page.evaluate(() => ({
        title: document.getElementById("job-title").textContent,
        sub: document.getElementById("job-sub").textContent,
        said: document.getElementById("view-announce").textContent,
        focus: document.activeElement?.id,
        list: document.getElementById("view-list").hidden && document.getElementById("list-head").hidden,
        composer: !document.getElementById("composer").hidden,
      }));
      // The task's title leads with the account it posts as (jobs.ts distinctTitle).
      if (!opened.title.startsWith("@noa · Post the launch thread") || opened.sub !== "Running" || !opened.said.startsWith("Job: @noa · Post the launch") || opened.focus !== "now-text" || !opened.list || !opened.composer) fail(`opened job ${JSON.stringify(opened)}`);
      if (want("panel-model-running", size, scheme)) {
        // The running task keeps its model: the chip shows it but does not open.
        const chip = page.locator("#now-model");
        const disabled = await chip.isDisabled();
        await chip.click({ force: true });
        const closed = await page.evaluate(() => document.getElementById("model-menu").hidden);
        if (!disabled || !closed) fail("model chip usable while running");
        await page.locator("#composer").screenshot({ path: join(shots, `panel-model-running-${size.w}-${scheme}.png`) });
        taken.push(join(shots, `panel-model-running-${size.w}-${scheme}.png`));
      }
      // One steps group unfolded, with one long result open.
      await page.locator("details.ev-result").first().evaluate((d) => {
        d.open = true;
        d.closest("details.ev-steps").open = true;
      });
      await page.locator("#chat-log").evaluate((l) => (l.scrollTop = l.scrollHeight));
      await checkLayout(page, `chat ${label}`);
      await shoot(page, "panel-chat-running", size, scheme);
      // Its menu: what a running task can do here.
      await expectMenu(page, ["Pause", "Raw"], "running job");
      await page.click("#job-menu summary");
      await checkLayout(page, `job menu ${label}`);
      await shoot(page, "panel-job-menu", size, scheme);
      await page.keyboard.press("Escape");
      // It runs in the tab the user is on: no row to go to it.
      if (await page.isVisible("#job-agent-tab")) fail("the agent's tab row shows while the user is on that tab");

      // Back ("‹", or Esc on the page): the list as it was left, the opened row focused.
      await page.setViewportSize({ width: size.w, height: 420 });
      await page.focus("#job-back");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#view-list:not([hidden])");
      const back = await page.evaluate(() => ({ query: document.getElementById("job-search").value, top: document.getElementById("view-list").scrollTop, focus: document.activeElement?.dataset?.key, said: document.getElementById("view-announce").textContent }));
      if (back.query !== "post" || Math.abs(back.top - scrolled) > 1 || back.focus !== "task:t2" || back.said !== "Jobs") fail(`back to the list ${JSON.stringify({ ...back, scrolled })}`);
      await page.setViewportSize({ width: size.w, height: size.h });

      // A finished job opens here, bound to this tab; the box goes on with it.
      await page.click('.job-row[data-key="task:t6"]');
      await page.waitForSelector("#view-job:not([hidden]) #chat-log .ev-first");
      const done = await page.evaluate(() => ({
        title: document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent,
        bind: window.__requests.filter((r) => r.type === "chat.bind").at(-1),
        placeholder: document.getElementById("now-text").placeholder,
      }));
      const first = await firstMessage(page);
      if (done.title !== "Post 'good morning' on X" || done.bind?.sessionId !== "s-2" || done.bind?.tabId !== 1 || done.placeholder !== "Message Noa…" || !first?.first) fail(`finished job opened ${JSON.stringify(done)}`);
      await expectMenu(page, ["Raw", "Delete"], "finished task");
      await checkLayout(page, `job opened ${label}`);
      await shoot(page, "panel-job-opened", size, scheme);
      await backToList(page);
      reportErrors(page, `list ${label}`);
      await page.close();
    },
  },
  // Task details: a job's first message (a task run's instructions, or a past chat's prompt), and the request of a
  // task that never ran, open a sheet with everything known.
  {
    names: ["panel-first-task", "panel-details-chat", "panel-details-focus", "panel-details-todo", "panel-first-long", "panel-details-message"],
    async run({ ctx, size, scheme, label, fail, want, firstMessage, waitFirst, openPanel, openJob, shoot, checkLayout, reportErrors, base, shots, taken }) {
      const p = await openPanel(ctx, "details", ".ev-tool");
      const known = scenario("details");
      await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      const sheet = () =>
        p.evaluate(() => {
          const d = document.querySelector("dialog.sheet[open]");
          if (!d) return null;
          const r = d.getBoundingClientRect();
          return {
            heading: d.querySelector("h2").textContent,
            text: d.querySelector(".sheet-text")?.textContent ?? null,
            links: [...d.querySelectorAll(".sheet-text a")].map((a) => ({ href: a.href, blank: a.target === "_blank", rel: a.rel })),
            fields: Object.fromEntries([...d.querySelectorAll(".sheet-fields dt")].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])),
            files: [...d.querySelectorAll(".sheet-files li > span:first-child")].map((f) => f.textContent),
            buttons: [...d.querySelectorAll("button")].map((b) => b.textContent),
            focus: document.activeElement?.textContent,
            inView: r.left >= 0 && r.right <= window.innerWidth + 0.5 && r.top >= 0 && r.bottom <= window.innerHeight + 0.5,
            sideways: [...d.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis").map((el) => el.className || el.tagName),
          };
        });
      const checkSheet = (got, what) => {
        if (!got) return fail(`${what}: no sheet`);
        if (!got.inView) fail(`${what}: sheet off screen`);
        if (got.sideways.length) fail(`${what}: scrolls sideways: ${got.sideways.join(", ")}`);
        if (got.focus !== "Close") fail(`${what}: focus on "${got.focus}", not Close`);
      };

      // Chat: the task run opens with its instructions as the first message, labelled with where they came from.
      const first = await firstMessage(p);
      if (!first?.first || first.origin !== "Scheduled run" || first.text !== known.state.running.title || !first.when || first.header || first.head !== "Claude API · claude-sonnet-5 · Jev on") fail(`task run's first message ${JSON.stringify(first)}`);
      await checkLayout(p, `details-task-run ${label}`);
      await shoot(p, "panel-first-task", size, scheme);
      // It is reachable by keyboard (Tab from the job's menu) and shows a focus ring.
      await p.focus("#job-menu summary");
      await p.keyboard.press("Tab");
      const ring = await p.evaluate(() => {
        const t = document.activeElement;
        return { first: t.classList.contains("ev-first"), role: t.getAttribute("role"), visible: t.matches(":focus-visible"), outline: getComputedStyle(t).outlineStyle };
      });
      if (!ring.first || ring.role !== "button" || !ring.visible || ring.outline === "none") fail(`first message focus ${JSON.stringify(ring)}`);
      await shoot(p, "panel-details-focus", size, scheme);
      await p.keyboard.press("Enter");
      await p.waitForSelector("dialog.sheet[open]");
      const chat = await sheet();
      checkSheet(chat, "details from chat");
      const t2 = known.tasks[0];
      if (chat.heading !== "Task details" || chat.text !== t2.instructions) fail(`chat details text ${JSON.stringify(chat.text)}`);
      if (chat.links.length !== 2 || chat.links.some((l) => !l.blank || !/noopener/.test(l.rel)) || chat.links[1].href !== "https://noa.example.com/pricing") fail(`chat details links ${JSON.stringify(chat.links)}`);
      for (const [k, v] of [["Status", "running"], ["Account", "@noa"], ["Source", "Scheduled in this browser"], ["Attempts", "1"], ["Task id", "t2"], ["Run id", "s-live"], ["Last run by", "Claude API · claude-sonnet-5 · Jev on"]]) {
        if (chat.fields[k] !== v) fail(`chat details ${k}: ${chat.fields[k]}`);
      }
      if (!chat.fields.Created || !chat.fields.Updated) fail("chat details: no times");
      if (chat.files.join() !== "launch-banner-final-v3.png,thread.txt") fail(`chat details files ${chat.files}`);
      if (chat.buttons.join(" | ") !== "Close | Copy instructions") fail(`chat details buttons ${chat.buttons.join(" | ")}`);
      await shoot(p, "panel-details-chat", size, scheme);
      // Copy instructions puts the full text on the clipboard.
      await p.locator("dialog.sheet button", { hasText: "Copy instructions" }).click();
      await p.waitForFunction(() => document.querySelector("dialog.sheet .msg")?.textContent);
      // The Windows clipboard reads line breaks back as CRLF.
      const copied = (await p.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
      if (copied !== t2.instructions) fail(`copied ${JSON.stringify(copied)}`);
      // Esc closes and focus goes back to the title.
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if (!(await p.evaluate(() => document.activeElement?.classList.contains("ev-first")))) fail("Esc did not return focus to the first message");
      // A task that never ran: its page shows its request, which opens the same sheet (a click on the backdrop closes it).
      await openJob(p, "task:t1");
      await p.click("#chat-log .job-intro .ev-first");
      await p.waitForSelector("dialog.sheet[open]");
      const todo = await sheet();
      checkSheet(todo, "details from todo");
      if (todo.text !== known.tasks[1].instructions) fail(`todo details text ${JSON.stringify(todo.text)}`);
      for (const [k, v] of [["Status", "scheduled"], ["Repeats", "Daily at 9:00 AM and 6:00 PM"], ["Attempts", "0"], ["Task id", "t1"]]) {
        if (todo.fields[k] !== v) fail(`todo details ${k}: ${todo.fields[k]}`);
      }
      if (!todo.fields["Next run"]) fail("todo details: no Next run");
      if (todo.files.join() !== "thank-you.gif") fail(`todo details files ${todo.files}`);
      await shoot(p, "panel-details-todo", size, scheme);
      await p.mouse.click(size.w / 2, 8);
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if (!(await p.evaluate(() => document.activeElement?.closest(".job-intro")))) fail("backdrop click did not return focus to the task's request");

      // A past one-off chat opens with the whole message typed as its first bubble (a long, multi-line prompt,
      // wrapped); the bubble opens its details.
      await openJob(p, "chat:s-3");
      await waitFirst(p, "Find the cheapest flight");
      const lisbonFirst = await firstMessage(p);
      if (lisbonFirst.text !== known.sessions.find((x) => x.sessionId === "s-3").instructions || lisbonFirst.origin !== null) fail(`past chat's first message ${JSON.stringify(lisbonFirst)}`);
      const wraps = await p.evaluate(() => {
        const b = document.querySelector("#chat-log .ev-first").getBoundingClientRect();
        return { lines: Math.round(b.height / 20), inside: b.right <= document.getElementById("chat-log").getBoundingClientRect().right + 0.5 };
      });
      if (wraps.lines < 3 || !wraps.inside) fail(`long prompt not wrapped in the bubble ${JSON.stringify(wraps)}`);
      await checkLayout(p, `details-long-prompt ${label}`);
      await shoot(p, "panel-first-long", size, scheme);
      await p.focus("#chat-log .ev-first");
      await p.keyboard.press("Enter");
      await p.waitForSelector("dialog.sheet[open]");
      const msg = await sheet();
      checkSheet(msg, "details of a chat message");
      const lisbon = known.sessions.find((x) => x.sessionId === "s-3");
      if (msg.heading !== "Chat message" || msg.text !== lisbon.instructions || msg.fields.Source !== "Chat message" || msg.fields["Last pause reason"] !== "Needs you to pick dates") fail(`message details ${JSON.stringify(msg)}`);
      await shoot(p, "panel-details-message", size, scheme);
      await p.locator("dialog.sheet button", { hasText: "Close" }).click();
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if (!(await p.evaluate(() => document.activeElement?.classList.contains("ev-first")))) fail("Close did not return focus to the first message");
      reportErrors(p, `details ${label}`);
      await p.close();
    },
  },
  // A new chat with a long, multi-line prompt and two files: the prompt as typed is the first message (wrapped, with
  // its files), then the brain chip; the brain's start line is not repeated; the bubble opens the message's details.
  {
    names: ["panel-first-files", "panel-first-files-details"],
    async run({ ctx, size, scheme, label, fail, firstMessage, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle");
      await p.setInputFiles("#now-files", [
        { name: "week38-photo-of-the-week-final.jpg", mimeType: "image/jpeg", buffer: Buffer.from(thumbnail, "base64") },
        { name: "caption.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
      ]);
      await p.waitForFunction(() => document.querySelectorAll("#now-files-list .att-chip:not(.preparing)").length === 2);
      await p.click("#now-text");
      await p.keyboard.insertText(LONG_TEXT);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc"));
      await p.waitForSelector("#chat-log .ev-first");
      const push = (e) => p.evaluate((ev) => window.__push({ type: "event", event: { ...ev, ts: new Date().toISOString(), sessionId: "s-new" } }), e);
      await push({ type: "status", text: "Claude API (claude-sonnet-5) with Jev" });
      await push({ type: "assistant_text", text: "I'll open X, check the account, then write the thread with the photo." });
      await push({ type: "tool_call", id: "1", name: "navigate", args: { url: "https://x.com/compose/post" } });
      await p.waitForSelector("#chat-log .ev-first .ev-attachments");
      const first = await firstMessage(p);
      const sentFiles = await p.evaluate(() => document.querySelectorAll("#chat-log .ev-first .att-sent").length);
      if (!first.first || first.text !== LONG_TEXT || sentFiles !== 2 || first.origin !== null || !first.when || first.header) fail(`first message with files ${JSON.stringify({ ...first, sentFiles })}`);
      if (first.head !== "Claude API · claude-sonnet-5 · Jev on" || first.startLines !== 0) fail(`brain shown more than once ${JSON.stringify(first)}`);
      const box = await p.evaluate(() => {
        const b = document.querySelector("#chat-log .ev-first").getBoundingClientRect();
        const log = document.getElementById("chat-log").getBoundingClientRect();
        // A long message shows its first lines, with Show all for the rest.
        const text = document.querySelector("#chat-log .ev-first .ev-user-text");
        return { cut: text.dataset.cut === "true" && document.querySelector("#chat-log .ev-first .ev-more")?.textContent === "Show all", short: b.height < 260, inside: b.left >= log.left && b.right <= log.right + 0.5 };
      });
      if (!box.cut || !box.short || !box.inside) fail(`long prompt bubble ${JSON.stringify(box)}`);
      await checkLayout(p, `first-files ${label}`);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await shoot(p, "panel-first-files", size, scheme);
      // A click on the bubble opens the message's details, with the whole message.
      await p.click("#chat-log .ev-first");
      await p.waitForSelector("dialog.sheet[open]");
      const sheet = await p.evaluate(() => ({ heading: document.querySelector("dialog.sheet h2").textContent, text: document.querySelector("dialog.sheet .sheet-text")?.textContent }));
      if (sheet.heading !== "Chat message" || sheet.text !== LONG_TEXT) fail(`first message details ${JSON.stringify(sheet)}`);
      await shoot(p, "panel-first-files-details", size, scheme);
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if (!(await p.evaluate(() => document.activeElement?.classList.contains("ev-first")))) fail("Esc did not return focus to the first message");
      // Selecting text in the bubble (to copy it) does not open the sheet.
      // (The text, below the files strip: along its first line.)
      const b = await p.locator("#chat-log .ev-first .ev-user-text").boundingBox();
      const y = b.y + 10;
      await p.mouse.move(b.x + 14, y);
      await p.mouse.down();
      await p.mouse.move(b.x + b.width - 14, y, { steps: 5 });
      await p.mouse.up();
      const picked = await p.evaluate(() => ({ selected: String(getSelection()), sheet: !!document.querySelector("dialog.sheet") }));
      if (!picked.selected || picked.sheet) fail(`selecting the first message's text ${JSON.stringify(picked)}`);
      reportErrors(p, `first-files ${label}`);
      await p.close();
    },
  },
  // A conversation: two turns in one thread, each opened by the user's bubble (the first is the prompt, with its time
  // and the brain chip under it); the composer talks to it. Back on the list the box starts a new job, and the tab's
  // old chat is closed (its agent session and tabs: the tab has a new chat).
  {
    names: ["panel-conversation", "panel-conversation-list", "panel-conversation-menu"],
    async run({ ctx, size, scheme, label, fail, expectMenu, firstMessage, want, openPanel, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "conversation", "#chat-log .ev-user");
      const composer = () =>
        p.evaluate(() => ({
          placeholder: document.getElementById("now-text").placeholder,
          submit: document.getElementById("now-submit").textContent,
          attach: !document.getElementById("now-attach").hidden,
          stop: !document.getElementById("now-stop").hidden,
        }));
      const CHAT = { placeholder: "Message Noa…", submit: "Send", attach: true, stop: false };
      const NEW = { placeholder: "Start a new job…", submit: "Send", attach: true, stop: false };
      const expectComposer = async (want, what) => {
        const got = await composer();
        if (JSON.stringify(got) !== JSON.stringify(want)) fail(`composer ${what}: ${JSON.stringify(got)}`);
      };
      // The conversation ended a minute ago: its page shows it and the composer talks to it.
      await p.waitForFunction(() => document.getElementById("now-text").placeholder === "Message Noa…");
      const view = await p.evaluate(() => ({
        bubbles: [...document.querySelectorAll("#chat-log .ev-user")].map((b) => b.textContent),
        ends: document.querySelectorAll("#chat-log .ev-end").length,
        // Who picked the turn's elements (Jev or Claude) is for the Raw view: nowhere in the chat.
        picks: [...document.querySelectorAll("#chat-log *")].filter((e) => !e.children.length && /element pick/.test(e.textContent)).length,
        heads: document.querySelectorAll("#chat-log .ev-head").length,
        // The second bubble opens the second turn: right after the first turn's end card.
        order: [...document.querySelectorAll("#chat-log > *")].map((e) => e.className).join(" ").includes("ev-end ev-user"),
        sub: document.getElementById("job-sub").textContent,
      }));
      const conv = scenario("conversation").sessions[0];
      if (JSON.stringify(view.bubbles) !== JSON.stringify([conv.title, "Now like the first reply to it"]) || view.ends !== 2 || !view.order) fail(`thread ${JSON.stringify(view)}`);
      if (view.sub !== "Done · 1 min ago") fail(`subtitle "${view.sub}"`);
      const first = await firstMessage(p);
      if (!first?.first || first.text !== conv.title || first.origin !== null || first.role !== "button" || first.tabIndex !== 0 || first.header) fail(`first message ${JSON.stringify(first)}`);
      // The first turn's start: the time under the prompt (not the latest turn's).
      const started = new Date(conv.firstStartedAt);
      const hm = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
      if (!first.when?.endsWith(hm)) fail(`first message time "${first.when}", want ${hm}`);
      // The brain shows once: the chip under the prompt; the brain's own start line is not repeated.
      if (first.head !== "Claude Code · claude-sonnet-5 · Jev on" || view.heads !== 1 || first.startLines !== 0) fail(`brain shown more than once ${JSON.stringify({ first, heads: view.heads })}`);
      if (view.picks !== 0) fail(`Jev's picks in the chat ${JSON.stringify(view)}`);
      // An ended chat: schedule its request, Raw, Rename, Delete (the agent has no tab now).
      await expectMenu(p, ["Schedule", "Raw", "Rename", "Delete"], "ended conversation");
      await expectComposer(CHAT, "not in conversation mode");
      await checkLayout(p, `conversation ${label}`);
      await shoot(p, "panel-conversation", size, scheme);
      if (want("panel-conversation-menu", size, scheme)) {
        await p.click("#job-menu summary");
        await shoot(p, "panel-conversation-menu", size, scheme);
        await p.keyboard.press("Escape");
      }

      // A message goes to the same conversation.
      await p.click("#now-text");
      await p.keyboard.insertText("And retweet it");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
      if (sent.sessionId !== "s-conv" || sent.text !== "And retweet it") fail(`message sent ${JSON.stringify(sent)}`);

      // Back on the list: the box starts a new job ("look at this page" when empty).
      await backToList(p);
      await expectComposer(NEW, "still in the conversation on the list");
      await checkLayout(p, `conversation-list ${label}`);
      await shoot(p, "panel-conversation-list", size, scheme);
      // The next text starts a new job in this tab; the tab's old chat is over.
      await p.click("#now-text");
      await p.keyboard.insertText("Post gm");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc" && r.instructions === "Post gm"));
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.newChat"));
      const closed = await p.evaluate(() => window.__requests.find((r) => r.type === "run.newChat"));
      if (closed?.sessionId !== "s-conv" || "tabId" in closed) fail(`the old chat closed with ${JSON.stringify(closed)}`);
      await p.waitForSelector("#view-job:not([hidden])");
      if ((await p.textContent("#job-title")) !== "Post gm") fail(`the new job's page shows "${await p.textContent("#job-title")}"`);
      reportErrors(p, `conversation ${label}`);
      await p.close();
    },
  },
  // Scheduling from the chat (schedule_task): the card (one line, View, Undo), the task's job it opens, the card once
  // undone, and on Free the refusal's card with Choose a plan.
  {
    names: ["panel-scheduled", "panel-scheduled-job", "panel-scheduled-undone", "panel-scheduled-free"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const card = (p) =>
        p.evaluate(() => {
          const c = document.querySelector("#chat-log .ev-scheduled");
          if (!c) return null;
          const line = c.querySelector(".sched-line");
          const r = line.getBoundingClientRect();
          return {
            line: line.textContent,
            lines: Math.round(r.height / parseFloat(getComputedStyle(line).lineHeight)),
            taskW: line.querySelector(".sched-task").getBoundingClientRect().width,
            inside: c.scrollWidth <= c.clientWidth + 1 && c.getBoundingClientRect().right <= document.getElementById("chat-log").getBoundingClientRect().right + 1,
            buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
            undone: c.classList.contains("undone"),
            title: line.title,
          };
        });
      if (want("panel-scheduled", size, scheme) || want("panel-scheduled-job", size, scheme) || want("panel-scheduled-undone", size, scheme)) {
        const p = await openPanel(ctx, "scheduled", "#chat-log .ev-scheduled");
        const c = await card(p);
        // Three hours from now, in the browser's words ("today at 6:45 PM", or "tomorrow at ..." late at night).
        const TASK = "Open https://shop.example.com/orders/48213 and tell me whether order #48213 has shipped yet; if it has, give me the carrier and tracking number.";
        // The first line is clipped at 120 characters (the tooltip holds it all); CSS ellipsizes what does not fit.
        if (!c?.line.startsWith(`Scheduled:${TASK.slice(0, 119)}…· Once, `) || !/Once, (today|tomorrow) at \d/.test(c.line)) fail(`card line "${c?.line}"`);
        // One line where it fits (480); at 360 the schedule may take a second line so the task stays readable.
        if (!c || c.lines > (size.w >= 480 ? 1 : 2) || c.taskW < 100 || !c.inside) fail(`card layout ${JSON.stringify(c)}`);
        if (c?.buttons.join(" | ") !== "View | Undo") fail(`card buttons ${c?.buttons.join(" | ")}`);
        if (!c?.title.includes("tracking number")) fail("card tooltip does not hold the whole task");
        // The card sits in the thread after the user's request, before the agent's reply.
        const order = await p.evaluate(() => [...document.querySelectorAll("#chat-log > *")].map((e) => e.className.split(" ")[0]).join(" "));
        if (!/ev-user .*ev-scheduled .*ev-text/.test(order)) fail(`card out of order: ${order}`);
        await checkLayout(p, `scheduled ${label}`);
        await shoot(p, "panel-scheduled", size, scheme);

        // View: the task's job, waiting for its time.
        await p.click("#chat-log .sched-view");
        await p.waitForFunction(() => !document.getElementById("view-job").hidden && document.querySelector("#chat-log .job-intro"));
        const job = await p.evaluate(() => ({ title: document.getElementById("job-title").textContent, sub: document.getElementById("job-sub").textContent, intro: document.querySelector("#chat-log .job-intro .ev-user-text")?.textContent }));
        if (!job.title.startsWith("Open https://shop.example.com/orders/48213") || !/^Once · (today|tomorrow) /.test(job.sub) || !job.intro?.includes("tracking number")) fail(`View opened ${JSON.stringify(job)}`);
        await checkLayout(p, `scheduled-job ${label}`);
        await shoot(p, "panel-scheduled-job", size, scheme);

        // Back in the chat: Undo.
        await openJob(p, "chat:s-sched");
        // Undo: the task is deleted, and the card says so (no buttons left).
        await p.click("#chat-log .sched-undo");
        await p.waitForSelector("#chat-log .ev-scheduled.undone");
        const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "chat.undoScheduled"));
        if (sent?.sessionId !== "s-sched" || sent.taskId !== "t-sched") fail(`undo sent ${JSON.stringify(sent)}`);
        const u = await card(p);
        if (!u.undone || u.buttons.length || !u.line.startsWith("Undone:")) fail(`undone card ${JSON.stringify(u)}`);
        await checkLayout(p, `scheduled-undone ${label}`);
        await shoot(p, "panel-scheduled-undone", size, scheme);
        reportErrors(p, `scheduled ${label}`);
        await p.close();
      }
      if (want("panel-scheduled-free", size, scheme)) {
        const p = await openPanel(ctx, "scheduled-free", "#chat-log .ev-error");
        const got = await p.evaluate(() => ({
          msg: [...document.querySelectorAll("#chat-log .ev-error .err-msg")].map((e) => e.textContent),
          fixes: [...document.querySelectorAll("#chat-log .ev-error .err-fix")].map((b) => b.textContent),
          cards: document.querySelectorAll("#chat-log .ev-scheduled").length,
        }));
        if (JSON.stringify(got) !== JSON.stringify({ msg: ["Scheduling needs a paid plan."], fixes: ["Choose a plan"], cards: 0 })) fail(`Free refusal ${JSON.stringify(got)}`);
        await checkLayout(p, `scheduled-free ${label}`);
        await shoot(p, "panel-scheduled-free", size, scheme);
        await p.click("#chat-log [data-fix=plans]");
        await p.waitForFunction(() => window.__created.includes("https://app.noa.bot/billing") || window.__opened.includes("https://app.noa.bot/billing"));
        reportErrors(p, `scheduled-free ${label}`);
        await p.close();
      }
    },
  },
  // The TODO tools from a calendar: a Changed card (a task this chat scheduled, moved without asking) and a Cancelled
  // card (a task the user made, after its approval), each with View and Undo; Undo on the Cancelled card sends
  // its change id and the card says the task is back.
  {
    names: ["panel-todo-changed", "panel-todo-changed-undone"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      if (!want("panel-todo-changed", size, scheme) && !want("panel-todo-changed-undone", size, scheme)) return;
      const cards = (p) =>
        p.evaluate(() =>
          [...document.querySelectorAll("#chat-log .ev-scheduled")].map((c) => {
            const line = c.querySelector(".sched-line");
            return {
              change: c.dataset.change ?? "scheduled",
              label: c.querySelector(".sched-label").textContent,
              task: c.querySelector(".sched-task").textContent,
              lines: Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)),
              inside: c.scrollWidth <= c.clientWidth + 1 && c.getBoundingClientRect().right <= document.getElementById("chat-log").getBoundingClientRect().right + 1,
              buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
              note: c.querySelector(".sched-note:not([hidden])")?.textContent ?? "",
            };
          }),
        );
      const p = await openPanel(ctx, "todo-changes", "#chat-log .ev-scheduled[data-change=cancelled]");
      const got = await cards(p);
      const want3 = [
        ["scheduled", "Scheduled:"],
        ["updated", "Changed:"],
        ["cancelled", "Cancelled:"],
      ];
      if (JSON.stringify(got.map((c) => [c.change, c.label])) !== JSON.stringify(want3)) fail(`cards ${JSON.stringify(got)}`);
      for (const c of got) {
        if (c.buttons.join(" | ") !== "View | Undo") fail(`${c.change} buttons ${c.buttons.join(" | ")}`);
        if (c.lines > (size.w >= 480 ? 1 : 2) || !c.inside) fail(`${c.change} layout ${JSON.stringify(c)}`);
      }
      if (!got[2]?.task.startsWith("Dentist appointment")) fail(`cancelled card task "${got[2]?.task}"`);
      // The approval the cancel waited for sits before its card, answered.
      const order = await p.evaluate(() => [...document.querySelectorAll("#chat-log > *")].map((e) => e.className.split(" ")[0]).join(" "));
      if (!/ev-approval .*ev-scheduled .*ev-text/.test(order)) fail(`approval and card out of order: ${order}`);
      await checkLayout(p, `todo-changed ${label}`);
      await shoot(p, "panel-todo-changed", size, scheme);

      // Undo on the Cancelled card: its change id goes to the background, and the card says the task is back.
      await p.click("#chat-log .ev-scheduled[data-change=cancelled] .sched-undo");
      await p.waitForSelector("#chat-log .ev-scheduled[data-change=cancelled].undone");
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "chat.undoTaskChange"));
      if (sent?.sessionId !== "s-todo" || sent.changeId !== "c-cancel") fail(`undo sent ${JSON.stringify(sent)}`);
      const after = (await cards(p))[2];
      if (after?.label !== "Undone:" || after.buttons.length || after.note !== "Scheduled again.") fail(`undone card ${JSON.stringify(after)}`);
      // The other cards keep their buttons.
      if ((await cards(p)).slice(0, 2).some((c) => c.buttons.length !== 2)) fail("undo changed another card");
      await checkLayout(p, `todo-changed-undone ${label}`);
      await shoot(p, "panel-todo-changed-undone", size, scheme);
      reportErrors(p, `todo-changed ${label}`);
      await p.close();
    },
  },
  // An action waiting for the user's OK (automation level "Ask before posting, sending or paying"): the approval card
  // with what, where, why and the exact text, answered by a click (Allow once) or a key (Alt+N denies); an earlier
  // allowed one keeps one quiet line.
  {
    names: ["panel-approval", "panel-approval-allowed", "panel-approval-denied", "panel-autonomy-full"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const card = (p) =>
        p.evaluate((wide) => {
          const cards = [...document.querySelectorAll("#chat-log .ev-approval")];
          const log = document.getElementById("chat-log").getBoundingClientRect();
          return cards.map((c) => ({
            state: c.dataset.state,
            head: c.querySelector(".appr-head").textContent,
            action: c.querySelector(".appr-action").textContent,
            text: c.querySelector(".appr-text")?.textContent ?? null,
            buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
            inside: c.scrollWidth <= c.clientWidth + 1 && c.getBoundingClientRect().right <= log.right + 1,
            buttonsOneRow: new Set([...c.querySelectorAll(".appr-actions button")].map((b) => Math.round(b.getBoundingClientRect().top))).size <= (wide ? 1 : 2),
          }));
        }, size.w >= 480);
      const sent = (p) => p.evaluate(() => window.__requests.filter((r) => r.type === "approval.answer"));
      if (want("panel-approval", size, scheme) || want("panel-approval-allowed", size, scheme)) {
        const p = await openPanel(ctx, "approval", "#chat-log .ev-approval[data-state=pending]");
        const [earlier, now] = await card(p);
        if (earlier?.state !== "allowed" || earlier.head !== "Allowed once" || earlier.buttons.length) fail(`earlier card ${JSON.stringify(earlier)}`);
        if (now?.state !== "pending" || now.head !== "Waiting for your OK" || now.action !== 'Click "Post" on x.com · publishes') fail(`card ${JSON.stringify(now)}`);
        if (!now?.text?.startsWith("We just shipped Noa 0.3") || !now.text.includes("\n\nhttps://")) fail(`card text ${JSON.stringify(now?.text)}`);
        if (now?.buttons.join(" | ") !== "Allow once | Allow for this task | Deny") fail(`buttons ${now?.buttons.join(" | ")}`);
        if (!now?.inside || !now.buttonsOneRow) fail(`card layout ${JSON.stringify(now)}`);
        const titles = await p.evaluate(() => [...document.querySelectorAll("#chat-log .ev-approval[data-state=pending] button")].map((b) => b.title));
        if (titles.join(" | ") !== "Allow once (Alt+Y) | Allow for this task (Alt+T) | Deny (Alt+N)") fail(`shortcut titles ${titles.join(" | ")}`);
        if (await p.isVisible("#autonomy-warning")) fail("the Full autonomy warning shows at the default level");
        await checkLayout(p, `approval ${label}`);
        await shoot(p, "panel-approval", size, scheme);
        await p.click("#chat-log .ev-approval[data-state=pending] button[data-answer=allow_once]");
        await p.waitForSelector("#chat-log .ev-approval:last-of-type[data-state=allowed]");
        const got = await sent(p);
        if (got.length !== 1 || got[0].sessionId !== "s-appr" || got[0].id !== "ap-2" || got[0].answer !== "allow_once") fail(`answer sent ${JSON.stringify(got)}`);
        const after = (await card(p))[1];
        if (after?.head !== "Allowed once" || after.buttons.length) fail(`allowed card ${JSON.stringify(after)}`);
        await checkLayout(p, `approval-allowed ${label}`);
        await shoot(p, "panel-approval-allowed", size, scheme);
        reportErrors(p, `approval ${label}`);
        await p.close();
      }
      if (want("panel-approval-denied", size, scheme)) {
        const p = await openPanel(ctx, "approval", "#chat-log .ev-approval[data-state=pending]");
        // The key works while the message box has the focus.
        await p.focus("#now-text");
        await p.keyboard.press("Alt+KeyN");
        await p.waitForSelector("#chat-log .ev-approval:last-of-type[data-state=refused]");
        const got = await sent(p);
        if (got.length !== 1 || got[0].answer !== "deny") fail(`Alt+N sent ${JSON.stringify(got)}`);
        const typed = await p.inputValue("#now-text");
        if (typed) fail(`Alt+N typed into the message box: ${JSON.stringify(typed)}`);
        const after = (await card(p))[1];
        if (after?.head !== "Denied" || after.buttons.length) fail(`denied card ${JSON.stringify(after)}`);
        await checkLayout(p, `approval-denied ${label}`);
        await shoot(p, "panel-approval-denied", size, scheme);
        reportErrors(p, `approval-denied ${label}`);
        await p.close();
      }
      // Full autonomy: one short red line under the status, as long as it is on, with what it means as its tooltip;
      // Change opens Settings > Permission.
      if (want("panel-autonomy-full", size, scheme)) {
        const p = await openPanel(ctx, "idle", undefined, { edit: (d) => (d.state.settings.automationLevel = "full") });
        const w = await p.evaluate(() => {
          const el = document.getElementById("autonomy-warning");
          const r = el.getBoundingClientRect();
          return { shown: !el.hidden && r.height > 0, text: el.textContent.replace(/\s+/g, " ").trim(), title: el.title, oneLine: r.height < 40, inside: r.right <= innerWidth + 0.5 };
        });
        if (!w.shown || w.text !== "Permission: Full autonomy (change) ✕" || !/^Never asks, in chats and scheduled jobs\. The agent can post, send, pay and delete/.test(w.title) || !w.oneLine || !w.inside) fail(`autonomy warning ${JSON.stringify(w)}`);
        await checkLayout(p, `autonomy ${label}`);
        await shoot(p, "panel-autonomy-full", size, scheme);
        await p.click("#autonomy-warning-change");
        await p.waitForFunction(() => [...(window.__created ?? []), ...(window.__opened ?? [])].some((u) => u.endsWith("options.html#permission")));
        // ✕ hides it; it stays hidden while full autonomy stays on.
        const setLevel = (level) => p.evaluate((l) => { const st = window.__data.state; window.__push({ type: "state", state: { ...st, rev: (st.rev ?? 0) + 1, settings: { ...st.settings, automationLevel: l } } }); }, level);
        await p.click("#autonomy-warning-close");
        await p.waitForSelector("#autonomy-warning", { state: "hidden" });
        await setLevel("full");
        await p.waitForTimeout(100);
        if (await p.isVisible("#autonomy-warning")) fail("the closed autonomy warning came back while full autonomy stayed on");
        // Off, then on again: it shows again.
        await setLevel("ask_consequential");
        await p.waitForSelector("#autonomy-warning", { state: "hidden" });
        await setLevel("full");
        await p.waitForSelector("#autonomy-warning", { state: "visible" });
        reportErrors(p, `autonomy ${label}`);
        await p.close();
      }
    },
  },
  // A question answered in the chat, with Markdown: the latest turn at the bottom, the older one scrolled to the top.
  {
    names: ["panel-chat-answer", "panel-chat-answer-top"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "answer", "#chat-log .ev-user");
      await checkLayout(p, `answer ${label}`);
      await p.waitForTimeout(200);
      const pos = await p.evaluate(() => {
        const l = document.getElementById("chat-log");
        return { top: l.scrollTop, h: l.scrollHeight, c: l.clientHeight, last: l.lastElementChild?.className };
      });
      if (pos.top + pos.c < pos.h - 2) fail(`answer: chat not scrolled to the bottom ${JSON.stringify(pos)}`);
      await shoot(p, "panel-chat-answer", size, scheme);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await shoot(p, "panel-chat-answer-top", size, scheme);
      reportErrors(p, `answer ${label}`);
      await p.close();
    },
  },
  // Streaming: the answer arrives as text deltas and grows in place (no raw ** while a bold is half written);
  // its final text replaces it without a second copy; the turn then ends with a one-line summary.
  {
    names: ["panel-chat-streaming", "panel-chat-streamed"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "streaming", "#chat-log .ev-user");
      const push = (e) => p.evaluate((ev) => window.__push({ type: "event", event: { ...ev, ts: new Date().toISOString(), sessionId: "s-ans" } }), e);
      const id = "msg_live01:1";
      const cut = EMAIL_ANSWER.indexOf("Jordan Lee") + "Jordan Le".length;
      const pieces = (from, to, n) => Array.from({ length: n }, (_, k) => EMAIL_ANSWER.slice(from + Math.floor(((to - from) * k) / n), from + Math.floor(((to - from) * (k + 1)) / n)));
      for (const t of pieces(0, cut, 8)) {
        await push({ type: "assistant_text_delta", id, text: t });
        await p.waitForTimeout(30);
      }
      await p.waitForFunction(() => document.querySelector("#chat-log .ev-text.streaming")?.textContent.includes("Jordan Le"));
      const mid = await p.evaluate(() => {
        const el = document.querySelector("#chat-log .ev-text.streaming");
        return { raw: el.textContent.includes("**"), strong: [...el.querySelectorAll("strong")].map((s) => s.textContent), heading: el.querySelector("h3")?.textContent };
      });
      if (mid.raw || !mid.strong.includes("Jordan Le") || mid.heading !== "Needs a reply") fail(`streaming: half-written Markdown ${JSON.stringify(mid)}`);
      await checkLayout(p, `streaming ${label}`);
      await shoot(p, "panel-chat-streaming", size, scheme);
      for (const t of pieces(cut, EMAIL_ANSWER.length, 6)) await push({ type: "assistant_text_delta", id, text: t });
      await p.waitForFunction(() => document.querySelector("#chat-log .ev-text.streaming")?.textContent.includes("Jordan and Sam?"));
      await push({ type: "assistant_text", text: EMAIL_ANSWER, id });
      await push({ type: "tool_call", id: "7", name: "task_complete", args: { summary: "Summarized 4 unread emails" } });
      await push({ type: "tool_result", id: "7", name: "task_complete", text: "Task marked complete." });
      await push({ type: "task_end", outcome: "done", summary: "Summarized 4 unread emails" });
      await p.waitForSelector("#chat-log .ev-end:last-child");
      const end = await p.evaluate((sid) => ({
        copies: [...document.querySelectorAll("#chat-log .ev-text")].filter((e) => e.textContent.includes("4 unread emails")).length,
        live: document.querySelectorAll("#chat-log .streaming").length,
        same: document.querySelector(`#chat-log .ev-text[data-stream="${sid}"]`)?.textContent.includes("Want me to draft replies"),
        outcome: document.querySelector("#chat-log > .ev-end:last-child .ev-outcome")?.textContent,
      }), id);
      if (end.copies !== 1 || end.live !== 0 || !end.same || end.outcome !== "doneSummarized 4 unread emails") fail(`streaming: after the final text ${JSON.stringify(end)}`);
      await checkLayout(p, `streamed ${label}`);
      await shoot(p, "panel-chat-streamed", size, scheme);
      reportErrors(p, `streaming ${label}`);
      await p.close();
    },
  },
  // The agent's follow-up suggestion: faded in the empty box exactly where typing starts, with a Tab hint; typing its
  // start keeps the rest showing; Tab takes it into the box (not sent); anything else hides it and Tab moves the focus;
  // Esc dismisses it; an empty Enter still looks at the page; sending clears it; voice hides it; the list never shows it.
  {
    names: ["panel-suggest", "panel-suggest-typed", "panel-suggest-accepted", "panel-suggest-long"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, backToList, shoot, checkLayout, reportErrors, base }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      const box = (p) =>
        p.evaluate(() => {
          const t = document.getElementById("now-text");
          const g = document.getElementById("now-ghost");
          const desc = t.getAttribute("aria-describedby");
          return {
            value: t.value,
            placeholder: t.placeholder,
            ghost: g.hidden ? null : g.querySelector(".now-ghost-rest").textContent,
            key: g.hidden ? null : g.querySelector(".now-ghost-key").textContent,
            described: desc ? document.getElementById(desc).textContent : null,
            focused: document.activeElement === t,
            caretAtEnd: t.selectionStart === t.value.length && t.selectionEnd === t.value.length,
          };
        });
      const expectBox = async (p, want, what) => {
        const got = await box(p);
        const bad = Object.entries(want).filter(([k, v]) => got[k] !== v);
        if (bad.length) fail(`suggestion ${what}: ${bad.map(([k, v]) => `${k} ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`).join("; ")}`);
      };
      const sent = (p) => p.evaluate(() => window.__requests.filter((r) => r.type === "run.message" || r.type === "run.adhoc"));
      const focusBox = (p) => p.evaluate(() => document.getElementById("now-text").focus());
      const voiceIs = (p, states) => p.waitForFunction((s) => s.includes(document.querySelector(".voice-mic").dataset.state), states);

      /**
       * The box drawn two ways must match pixel for pixel (caret hidden): `a` and `b` are each the text in the box
       * and CSS for that drawing. A one-pixel shift of `b` must show up, or the check would prove nothing.
       */
      const sameDrawing = async (p, what, a, b) => {
        const caret = await p.addStyleTag({ content: "#now-text { caret-color: transparent !important; }" });
        const rect = () => p.evaluate(() => JSON.parse(JSON.stringify(document.getElementById("now-text").getBoundingClientRect())));
        const draw = async ({ value, css }, dx = [0]) => {
          await p.evaluate((val) => {
            const t = document.getElementById("now-text");
            t.value = val;
            t.dispatchEvent(new Event("input"));
          }, value);
          const style = await p.addStyleTag({ content: css });
          const r = await rect();
          const shots = [];
          for (const x of dx) shots.push(await p.screenshot({ clip: { x: Math.round(r.x) + x, y: Math.round(r.y), width: Math.floor(r.width) - 2, height: Math.floor(r.height) }, animations: "disabled" }));
          await style.evaluate((n) => n.remove());
          return shots;
        };
        const [first] = await draw(a);
        const [second, shifted] = await draw(b, [0, 1]);
        await caret.evaluate((n) => n.remove());
        await p.evaluate(() => {
          const t = document.getElementById("now-text");
          t.value = "";
          t.dispatchEvent(new Event("input"));
        });
        const diff = await p.evaluate(
          async (shots) => {
            const load = (b64) =>
              new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = `data:image/png;base64,${b64}`;
              });
            const pixels = (img) => {
              const cv = document.createElement("canvas");
              cv.width = img.width;
              cv.height = img.height;
              const x = cv.getContext("2d");
              x.drawImage(img, 0, 0);
              return x.getImageData(0, 0, img.width, img.height).data;
            };
            const [u0, v0, w0] = (await Promise.all(shots.map(load))).map(pixels);
            const differ = (u, v) => {
              if (u.length !== v.length) return Infinity;
              let n = 0;
              for (let i = 0; i < u.length; i += 4) if (Math.abs(u[i] - v[i]) + Math.abs(u[i + 1] - v[i + 1]) + Math.abs(u[i + 2] - v[i + 2]) > 24) n++;
              return n;
            };
            return { same: differ(u0, v0), shifted: differ(u0, w0) };
          },
          [first, second, shifted].map((x) => x.toString("base64")),
        );
        if (diff.same !== 0) fail(`suggestion ${what}: ${diff.same} pixels differ`);
        if (diff.shifted < 20) fail(`suggestion ${what}: the check cannot see a 1 px shift (${diff.shifted} pixels)`);
      };
      /** The box alone, as the user types into it. */
      const BOX_ONLY = ".now-ghost { visibility: hidden !important; }";
      /** Only the suggestion's faded rest drawn in the text colour (Tab hint hidden). */
      const REST_AS_TEXT = ".now-ghost-rest { color: var(--text) !important; } .now-ghost-key { visibility: hidden !important; }";
      /** The faded rest continues the typed text exactly where typing would: typed + rest look like the whole typed out. */
      const expectAligned = (p, full, typed, what) => sameDrawing(p, `${what}: the faded text is not where typed text goes`, { value: full, css: BOX_ONLY }, { value: typed, css: REST_AS_TEXT });
      /**
       * The overlay lays out the typed part exactly as the box does (so the rest starts right after the cursor), also
       * when a half-typed word ends a line: the box's own text vs the overlay's typed part drawn in its place.
       */
      const expectTypedAligned = (p, typed, what) =>
        sameDrawing(
          p,
          `${what}: the overlay does not lay out the typed text like the box`,
          { value: typed, css: BOX_ONLY },
          { value: typed, css: "#now-text { color: transparent !important; } .now-ghost-typed { color: var(--text) !important; } .now-ghost-rest, .now-ghost-key { visibility: hidden !important; }" },
        );

      const p = await openPanel(ctx, "suggest", "#chat-log .ev-end", { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
      await p.waitForSelector("#now-ghost:not([hidden])");
      const described = `Suggestion: “${SUGGESTION}”. Press Tab to use it.`;
      await expectBox(p, { value: "", ghost: SUGGESTION, key: "Tab", placeholder: "", described }, "in the empty box");
      await expectAligned(p, SUGGESTION, "", "empty box");
      await expectAligned(p, SUGGESTION, "Reply to Jor", "typed start");
      await expectTypedAligned(p, "Reply to Jor", "typed start");
      await focusBox(p);
      await checkLayout(p, `suggest ${label}`);
      await shoot(p, "panel-suggest", size, scheme);

      // Typing its start (any case) keeps the rest showing after the typed text.
      await p.keyboard.type("reply to");
      await expectBox(p, { value: "reply to", ghost: SUGGESTION.slice("reply to".length), key: "Tab", described }, "after typing its start");
      await checkLayout(p, `suggest-typed ${label}`);
      await shoot(p, "panel-suggest-typed", size, scheme);

      // Tab completes it in the box, cursor at the end, nothing sent.
      await p.keyboard.press("Tab");
      await expectBox(p, { value: `reply to${SUGGESTION.slice(8)}`, ghost: null, focused: true, caretAtEnd: true, described: null }, "after Tab");
      if ((await sent(p)).length) fail(`suggestion: Tab sent ${JSON.stringify(await sent(p))}`);
      await checkLayout(p, `suggest-accepted ${label}`);
      await shoot(p, "panel-suggest-accepted", size, scheme);

      // Anything else hides it, and Tab then moves the focus as usual; an emptied box shows it again.
      await p.fill("#now-text", "Forward it");
      await expectBox(p, { ghost: null, placeholder: "Message Noa…", described: null }, "after other text");
      await p.keyboard.press("Tab");
      if ((await box(p)).focused) fail("suggestion: with other text typed, Tab did not move the focus");
      await p.fill("#now-text", "");
      await expectBox(p, { ghost: SUGGESTION }, "after emptying the box");

      // Hands-free voice (the mic, on Standard) hides it while it writes into the box; ending it before anything was
      // sent restores the empty box, and the suggestion.
      await p.click("#now-actions .voice-mic");
      await voiceIs(p, ["handsfree"]);
      await expectBox(p, { ghost: null }, "while voice starts");
      await p.waitForFunction(() => document.getElementById("now-text").value.length > 0, null, { timeout: 15_000 });
      await expectBox(p, { ghost: null }, "with the words in the box");
      await p.click("#now-actions .voice-mic");
      await voiceIs(p, ["idle"]);
      await expectBox(p, { value: "", ghost: SUGGESTION }, "after voice ended");

      // Under the list the box never offers it (it starts a new job); back on the job it does.
      await backToList(p);
      await expectBox(p, { ghost: null, described: null }, "under the list");
      await openJob(p, "chat:s-ans");
      await p.waitForSelector("#chat-log .ev-end");
      await expectBox(p, { ghost: SUGGESTION }, "back on the job");

      // Esc dismisses it for this turn: the placeholder is back, Tab moves the focus, an empty Enter looks at the page.
      await focusBox(p);
      await p.keyboard.press("Escape");
      await expectBox(p, { value: "", ghost: null, placeholder: "Message Noa…", described: null }, "after Esc");
      await p.keyboard.press("Tab");
      if ((await box(p)).focused) fail("suggestion: after Esc, Tab did not move the focus");
      await focusBox(p);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const afterEsc = (await sent(p)).at(-1);
      if (afterEsc?.sessionId !== "s-ans" || afterEsc?.text !== "" || afterEsc?.screen !== true) fail(`suggestion: empty Enter after Esc sent ${JSON.stringify(afterEsc)}`);
      reportErrors(p, `suggest ${label}`);
      await p.close();

      // With it showing, an empty Enter still looks at the page (the suggestion is never sent by itself); sending clears it.
      const q = await openPanel(ctx, "suggest", "#chat-log .ev-end");
      await q.waitForSelector("#now-ghost:not([hidden])");
      await focusBox(q);
      await q.keyboard.press("Enter");
      await q.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const screen = (await sent(q)).at(-1);
      if (screen?.sessionId !== "s-ans" || screen?.text !== "" || screen?.screen !== true) fail(`suggestion: empty Enter with it shown sent ${JSON.stringify(screen)}`);
      await expectBox(q, { value: "", ghost: null }, "after an empty send");
      reportErrors(q, `suggest-empty-send ${label}`);
      await q.close();

      // Tab, then Enter: the suggestion goes out as the typed message.
      const r = await openPanel(ctx, "suggest", "#chat-log .ev-end");
      await r.waitForSelector("#now-ghost:not([hidden])");
      await focusBox(r);
      await r.keyboard.press("Tab");
      await r.keyboard.press("Enter");
      await r.waitForFunction(() => window.__requests.some((m) => m.type === "run.message"));
      const took = (await sent(r)).at(-1);
      if (took?.sessionId !== "s-ans" || took?.text !== SUGGESTION || took?.screen) fail(`suggestion: Tab, Enter sent ${JSON.stringify(took)}`);
      await expectBox(r, { value: "", ghost: null }, "after sending it");
      reportErrors(r, `suggest-send ${label}`);
      await r.close();

      // The longest suggestion (MAX_SUGGESTION_CHARS) wraps like typed text would, also with a typed start across the wrap.
      const l = await openPanel(ctx, "suggest", "#chat-log .ev-end");
      await l.evaluate((text) => {
        const s = window.__data.sessions.find((x) => x.sessionId === "s-ans");
        window.__push({ type: "session", session: { ...s, endedAt: new Date(Date.now() + 1000).toISOString(), suggestion: text } });
      }, LONG_SUGGESTION);
      await l.waitForFunction((t) => document.querySelector("#now-ghost .now-ghost-rest")?.textContent === t, LONG_SUGGESTION);
      const lines = await l.evaluate(() => Math.round((document.getElementById("now-ghost").getBoundingClientRect().height - 8) / 20));
      if (lines < 2) fail(`suggestion: the longest one did not wrap (${lines} line)`);
      await expectAligned(l, LONG_SUGGESTION, "", "longest, empty box");
      await expectAligned(l, LONG_SUGGESTION, LONG_SUGGESTION.slice(0, 20), "longest, typed start");
      // A half-typed word at the end of a line stays there (as in the box); the rest goes on after it.
      for (const n of [52, 55, 58]) await expectTypedAligned(l, LONG_SUGGESTION.slice(0, n), `longest, ${n} typed`);
      await focusBox(l);
      await checkLayout(l, `suggest-long ${label}`);
      await shoot(l, "panel-suggest-long", size, scheme);
      reportErrors(l, `suggest-long ${label}`);
      await l.close();
    },
  },
  // Two tasks at once, each in its own tab: both under Running; this tab's job opens here; the other's page says it
  // runs in another tab (the row under the header: its title and site, View switches there) and is not bound here;
  // Pause stops only it.
  {
    names: ["panel-parallel", "panel-parallel-elsewhere"],
    async run({ ctx, size, scheme, label, fail, groups, expectMenu, pick, firstMessage, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "parallel", undefined, { edit: (d) => (d.tabUrls = { 2: "https://news.ycombinator.com/" }) });
      const running = (await groups(p)).find(([g]) => g === "Running")?.[1] ?? [];
      if (running.join() !== "task:t3,task:t2") fail(`Running ${JSON.stringify(running)}`);
      await checkLayout(p, `parallel ${label}`);
      await shoot(p, "panel-parallel", size, scheme);
      // This tab's run: no "in another tab" line.
      await openJob(p, "task:t2");
      await p.waitForSelector("#chat-log .ev-first");
      if (!(await p.locator("#chat-log .ev-first .ev-user-text").textContent()).startsWith("Post the launch")) fail("tab 1's job does not show its run");
      if (await p.isVisible("#job-agent-tab")) fail("tab 1's own run offers to view its tab");
      // The other tab's run: its page, where it runs, and nothing bound here.
      const binds = await p.evaluate(() => window.__requests.filter((r) => r.type === "chat.bind").length);
      await openJob(p, "task:t3");
      await p.waitForFunction(() => document.getElementById("chat-log").textContent.includes("Opening the doc"));
      await p.waitForFunction(() => document.querySelector("#job-agent-tab:not([hidden]) .job-tab-name")?.textContent === "Hacker News");
      const other = await firstMessage(p);
      if (other?.origin !== "Scheduled run" || other.startLines !== 0 || other.head !== "Claude API · claude-sonnet-5 · Jev on") fail(`tab 2's first message ${JSON.stringify(other)}`);
      if ((await p.evaluate(() => window.__requests.filter((r) => r.type === "chat.bind").length)) !== binds) fail("a job running in another tab was bound here");
      const row = await p.evaluate(() => {
        const r = document.getElementById("job-agent-tab");
        const view = r.querySelector("button");
        return {
          lead: r.querySelector(".job-tab-lead").textContent,
          host: r.querySelector(".job-tab-host").textContent,
          view: view.textContent,
          label: view.getAttribute("aria-label"),
          said: document.getElementById("job-agent-tab-said").textContent,
          under: r.previousElementSibling === null && document.getElementById("job-head").getBoundingClientRect().bottom <= r.getBoundingClientRect().top + 1,
        };
      });
      if (row.lead !== "Working in" || row.host !== "news.ycombinator.com" || row.view !== "View" || row.label !== "View the agent's tab: Hacker News" || row.said !== "Working in Hacker News. View shows it." || !row.under) fail(`agent tab row ${JSON.stringify(row)}`);
      await checkLayout(p, `parallel-elsewhere ${label}`);
      await shoot(p, "panel-parallel-elsewhere", size, scheme);
      // View, by keyboard: that tab.
      await p.focus("#job-agent-tab button");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tab.focus"));
      const focus = await p.evaluate(() => window.__requests.find((r) => r.type === "tab.focus"));
      if (focus?.tabId !== 2) fail(`View sent ${JSON.stringify(focus)}`);
      // The menu and the composer act on this job's run; Pause (and Stop) stop only it.
      await expectMenu(p, ["Pause", "Raw"], "the other tab's run");
      await pick(p, "Pause");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.stop"));
      const pause = await p.evaluate(() => window.__requests.find((r) => r.type === "run.stop"));
      if (pause.sessionId !== "s-par2") fail(`Pause sent ${JSON.stringify(pause)}`);
      await p.click("#now-stop");
      await p.waitForFunction(() => window.__requests.filter((r) => r.type === "run.stop").length === 2);
      const stop = await p.evaluate(() => window.__requests.filter((r) => r.type === "run.stop").at(-1));
      if (stop.sessionId !== "s-par2") fail(`Stop sent ${JSON.stringify(stop)}`);
      reportErrors(p, `parallel ${label}`);
      await p.close();
    },
  },
  // A chat per tab (the window's panel, following its active tab): tab 1's own job shows while it is active, tab 2 (no
  // chat) shows the list; a job started in tab 2 is tab 2's.
  {
    names: ["panel-follow-a", "panel-follow-b", "panel-follow-b-started"],
    async run({ ctx, size, scheme, label, fail, groups, expectMenu, firstMessage, waitFirst, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "tabs", "#chat-log .ev-tool");
      const view = () =>
        p.evaluate(() => ({
          title: document.querySelector("#view-job:not([hidden]) #chat-log .ev-first .ev-user-text")?.textContent ?? null,
          list: !document.getElementById("view-list").hidden,
          placeholder: document.getElementById("now-text").placeholder,
          stop: !document.getElementById("now-stop").hidden,
        }));
      const a = await view();
      if (!a.title?.startsWith("Summarize this pull request") || a.list || !a.stop) fail(`tab A ${JSON.stringify(a)}`);
      await expectMenu(p, ["Pause", "Schedule", "Raw", "Rename"], "tab A");
      await checkLayout(p, `tabs-a ${label}`);
      await shoot(p, "panel-follow-a", size, scheme);
      // The user switches to tab 2: it has no chat, so the list, with tab 1's job under Running.
      await p.evaluate(() => window.__activateTab(2));
      await p.waitForSelector("#view-list:not([hidden])");
      const b = await view();
      const run = (await groups(p)).find(([g]) => g === "Running")?.[1];
      if (b.title !== null || b.stop || b.placeholder !== "Start a new job…" || !run?.includes("chat:s-live")) fail(`tab B ${JSON.stringify({ ...b, run })}`);
      await checkLayout(p, `tabs-b ${label}`);
      await shoot(p, "panel-follow-b", size, scheme);
      // A task typed in tab 2 starts there, and its job opens.
      await p.click("#now-text");
      await p.keyboard.insertText("Translate this page's intro to French");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc"));
      const started = await p.evaluate(() => window.__requests.find((r) => r.type === "run.adhoc"));
      if (started.tabId !== 2) fail(`run.adhoc from tab 2 sent ${JSON.stringify(started)}`);
      // A fresh chat: the prompt as typed is its first message, with the time under it.
      await waitFirst(p, "Translate");
      const fresh = await firstMessage(p);
      if (!fresh.first || fresh.text !== "Translate this page's intro to French" || fresh.origin !== null || !/^\d\d:\d\d$/.test(fresh.when ?? "") || fresh.header) fail(`fresh chat's first message ${JSON.stringify(fresh)}`);
      await checkLayout(p, `tabs-b-started ${label}`);
      await shoot(p, "panel-follow-b-started", size, scheme);
      // Back to tab 1: its job shows again.
      await p.evaluate(() => window.__activateTab(1));
      await waitFirst(p, "Summarize this pull request");
      reportErrors(p, `tabs ${label}`);
      await p.close();
    },
  },
  // Signed out: the list has this browser's jobs; the avatar's menu offers Log in (its progress above the box) and
  // Settings; Schedule says scheduling needs an account, with Log in.
  {
    names: ["panel-signedout", "panel-signedout-noclient", "panel-schedule-signedout"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, openJob, pick, shoot, checkLayout, reportErrors }) {
      for (const kind of ["loggedout", "loggedout-noclient"]) {
        const name = kind === "loggedout" ? "panel-signedout" : "panel-signedout-noclient";
        if (!want(name, size, scheme) && !(kind === "loggedout" && want("panel-schedule-signedout", size, scheme))) continue;
        const p = await openPanel(ctx, kind);
        const look = await p.evaluate(() => ({
          rows: document.querySelectorAll(".job-row").length,
          composer: !document.getElementById("composer").hidden,
          acct: (() => { const d = document.getElementById("acct"); const shown = (sel) => getComputedStyle(d.querySelector(sel)).display !== "none"; return !d.hidden && !d.hasAttribute("data-signed-in") && shown(".acct-anon") && shown("#acct-login") && shown("#acct-open-settings") && !shown("#acct-signout") && !shown(".acct-who"); })(),
        }));
        if (!look.rows || !look.composer) fail(`signed out list ${JSON.stringify(look)}`);
        if (!look.acct) fail("signed-out account menu should show the person icon with Log in and Settings only");
        await checkLayout(p, `${kind} ${label}`);
        await p.click("#acct-btn");
        await p.click("#acct-login");
        if (kind === "loggedout-noclient") {
          await p.waitForFunction(() => document.querySelector("#now-notice:not([hidden])")?.textContent.includes("Google sign-in isn't available"));
          if (await p.evaluate(() => window.__requests.some((r) => r.type === "account.signIn"))) fail("sign-in requested without a client ID");
          await shoot(p, name, size, scheme);
        } else {
          await shoot(p, name, size, scheme);
          await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.signIn"));
          await p.waitForSelector("#acct[data-signed-in]");
          // Signed in: the account's list is loaded again.
          await p.waitForFunction(() => window.__requests.filter((r) => r.type === "tasks.list").length >= 2);
        }
        reportErrors(p, `${kind} ${label}`);
        await p.close();
      }
      if (want("panel-schedule-signedout", size, scheme)) {
        const p = await openPanel(ctx, "loggedout", undefined, { edit: (d) => (d.sessions.find((x) => x.sessionId === "s-3").instructions = "Find the cheapest flight to Lisbon next weekend") });
        await openJob(p, "chat:s-3");
        await pick(p, "Schedule");
        await p.waitForSelector("dialog.schedule-sheet[open]");
        const gate = await p.evaluate(() => ({ text: document.querySelector("dialog.schedule-sheet").innerText, btn: document.getElementById("sched-gate-btn")?.textContent, fields: !!document.querySelector("dialog.schedule-sheet .sch") }));
        if (!/Log in to schedule/.test(gate.text) || gate.btn !== "Log in" || gate.fields) fail(`signed-out Schedule ${JSON.stringify(gate)}`);
        await shoot(p, "panel-schedule-signedout", size, scheme);
        await p.click("#sched-gate-btn");
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.signIn"));
        reportErrors(p, `schedule signed out ${label}`);
        await p.close();
      }
    },
  },
  // Signed in: the account's jobs, the offer to move this browser's tasks, the avatar menu, Noa AI in the chip.
  {
    names: ["panel-list-account", "panel-account-menu", "panel-model-menu-hosted"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, openJob, menuItems, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "account");
      if (!(await p.locator("#migrate").isVisible())) fail("no offer to move local tasks");
      if ((await p.locator("#migrate-go").textContent()) !== "Move 3 tasks to your account") fail(`migrate button "${await p.locator("#migrate-go").textContent()}"`);
      if ((await p.getAttribute("#brand", "title")) !== "Working with Noa AI + Jev") fail(`brand tooltip "${await p.getAttribute("#brand", "title")}"`);
      await checkLayout(p, `account list ${label}`);
      await shoot(p, "panel-list-account", size, scheme);
      // The account's queue: a paused task resumes there (tasks.retry) and can be cancelled; never "Run again".
      await openJob(p, "task:t5");
      const items = await menuItems(p);
      if (items.join(" | ") !== "Run now | Resume | Edit schedule | Cancel | Delete") fail(`account paused task menu ${items.join(" | ")}`);
      await backToList(p);
      await p.click("#migrate-go");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.migrate"));
      await p.waitForSelector("#migrate", { state: "hidden" });
      if (want("panel-account-menu", size, scheme)) {
        await p.click("#acct-btn");
        await p.waitForSelector("#acct[open] .acct-pop");
        const pop = await p.evaluate(() => {
          const r = document.querySelector("#acct .acct-pop").getBoundingClientRect();
          return { left: r.left, right: r.right, email: document.querySelector("#acct .acct-email").textContent, plan: document.querySelector("#acct .acct-plan").textContent };
        });
        if (pop.left < 0 || pop.right > size.w) fail(`account menu off screen ${JSON.stringify(pop)}`);
        if (pop.email !== "ada.lovelace@example.com" || pop.plan !== "Plus plan · $14.21 usage credit") fail(`account menu ${JSON.stringify(pop)}`);
        await shoot(p, "panel-account-menu", size, scheme);
        await p.click("#acct-signout");
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.signOut"));
        await p.waitForSelector("#acct:not([data-signed-in])");
      }
      if (want("panel-model-menu-hosted", size, scheme)) {
        const q = await openPanel(ctx, "account");
        await q.click("#now-model");
        await q.waitForSelector("#model-menu:not([hidden])");
        const menu = await q.evaluate(() => ({
          head: document.querySelector(".mm-head").textContent,
          credit: document.querySelector(".mm-credit")?.textContent,
          models: [...document.querySelectorAll(".mm-item[role=menuitemradio]")].length,
          jev: document.querySelector(".mm-jev").disabled,
          reasoning: document.querySelector(".mm-reasoning")?.getAttribute("aria-checked"),
          reasoningHint: document.querySelector(".mm-reasoning .mm-hint")?.textContent,
        }));
        if (menu.head !== "Noa AI model" || menu.credit !== "$14.21 usage credit left" || menu.models !== 4 || menu.jev || menu.reasoning !== "false" || menu.reasoningHint !== "Off: thinks only when stuck")
          fail(`hosted model menu ${JSON.stringify(menu)}`);
        await checkLayout(q, `model-menu-hosted ${label}`);
        await shoot(q, "panel-model-menu-hosted", size, scheme);
        reportErrors(q, `model-menu-hosted ${label}`);
        await q.close();
      }
      reportErrors(p, `account ${label}`);
      await p.close();
    },
  },
  // Signed in on Free: the TODO list is a paid feature. The list has the chats (they stay free) and none of the
  // account's tasks; Schedule says what the plan lacks, with Get a plan; subscribing brings the tasks into the list.
  {
    names: ["panel-todo-locked", "panel-schedule-locked"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, openJob, pick, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "todo-locked", undefined, { edit: (d) => (d.sessions.find((x) => x.sessionId === "s-3").instructions = "Find the cheapest flight to Lisbon next weekend") });
      const keys = () => p.evaluate(() => [...document.querySelectorAll(".job-row")].map((r) => r.dataset.key));
      const locked = await keys();
      // Only chats and runs whose tasks the list does not have: no waiting task of the account.
      if (locked.some((k) => ["task:t1", "task:t3", "task:t4", "task:t5"].includes(k)) || !locked.includes("chat:s-3")) fail(`locked list ${JSON.stringify(locked)}`);
      // The account-wide condition, once, with its fix: the kept jobs that wait cannot run on this plan.
      await p.waitForSelector("#status:not([hidden])");
      const strip = await p.evaluate(() => ({ text: document.getElementById("status-text").textContent, action: document.getElementById("status-action").textContent, kind: document.getElementById("status-action").dataset.action }));
      if (strip.text !== "4 scheduled jobs won't run on your plan" || strip.action !== "Choose a plan" || strip.kind !== "plans") fail(`locked strip ${JSON.stringify(strip)}`);
      await checkLayout(p, `todo-locked ${label}`);
      await shoot(p, "panel-todo-locked", size, scheme);
      // The account menu says what Free lacks.
      const plan = await p.evaluate(() => document.querySelector("#acct .acct-plan").textContent);
      if (plan !== "Free plan, no TODO list · $0.00 usage credit") fail(`account menu plan "${plan}"`);
      // Schedule on a chat: what the plan lacks, and Get a plan (the dashboard's Billing page, in a new tab).
      await openJob(p, "chat:s-3");
      await pick(p, "Schedule");
      await p.waitForSelector("dialog.schedule-sheet[open]");
      const gate = await p.evaluate(() => ({ text: document.querySelector("dialog.schedule-sheet").innerText, btn: document.getElementById("sched-gate-btn")?.textContent }));
      if (!/TODO needs a paid plan/.test(gate.text) || !/run on schedule/.test(gate.text) || gate.btn !== "Get a plan") fail(`locked Schedule ${JSON.stringify(gate)}`);
      await checkLayout(p, `schedule-locked ${label}`);
      await shoot(p, "panel-schedule-locked", size, scheme);
      await p.click("#sched-gate-btn");
      await p.waitForFunction(() => window.__created.includes("https://app.noa.bot/billing"));
      // Back in the panel, the account is refreshed.
      const forced = () => p.evaluate(() => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length);
      const before = await forced();
      await p.evaluate(() => {
        dispatchEvent(new Event("blur"));
        dispatchEvent(new Event("focus"));
      });
      await p.waitForFunction((n) => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length === n + 1, before);
      // Subscribing (the plan arrives with the next state): the same tasks come back into the list.
      await backToList(p);
      await p.evaluate(() => {
        window.__data.tasksLocked = false;
        const s = window.__data.state;
        window.__push({ type: "state", state: { ...s, account: { ...s.account, plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } } } });
      });
      await p.waitForSelector('.job-row[data-key="task:t1"]');
      reportErrors(p, `todo-locked ${label}`);
      await p.close();
    },
  },
  // Out of usage credit: the status line says so with Top up; the paused run's card has Top up too. Every one opens the dashboard's Billing page.
  {
    names: ["panel-out-of-credit"],
    async run({ ctx, size, scheme, label, fail, openPanel, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "hosted-out", "#chat-log .ev-end");
      const st = await p.evaluate(() => ({ text: document.getElementById("status-text").textContent, action: document.getElementById("status-action").textContent, chip: document.getElementById("now-model-label").textContent }));
      if (st.text !== "You're out of usage credit" || st.action !== "Top up" || st.chip !== "Out of usage credit") fail(`out of credit status ${JSON.stringify(st)}`);
      if ((await p.locator("#chat-log [data-fix=topup]").textContent()) !== "Top up") fail("no Top up in the paused run's error card");
      // Shown once: the end card keeps its outcome and Continue, not a second copy of the reason.
      const once = await p.evaluate(() => ({ cards: document.querySelectorAll("#chat-log .ev-error").length, summary: document.querySelector("#chat-log .ev-end .ev-summary")?.textContent ?? null }));
      if (once.cards !== 1 || once.summary !== null) fail(`out of credit shown more than once ${JSON.stringify(once)}`);
      await checkLayout(p, `out-of-credit ${label}`);
      await shoot(p, "panel-out-of-credit", size, scheme);
      await p.click("#chat-log [data-fix=topup]");
      await p.click("#status-action");
      // Plan & billing in the account menu (over the list).
      await backToList(p);
      await p.click("#acct-btn");
      await p.click("#acct-billing");
      // The model menu's Top up...
      await p.click("#now-model");
      await p.locator("#model-menu .mm-item", { hasText: "Top up" }).click();
      const opened = await p.evaluate(() => ({ created: window.__created, opened: window.__opened }));
      const billing = "https://app.noa.bot/billing";
      if (JSON.stringify(opened.created) !== JSON.stringify([billing, billing, billing, billing]) || opened.opened.length) fail(`Top up / Plan & billing opened ${JSON.stringify(opened)}`);
      reportErrors(p, `out-of-credit ${label}`);
      await p.close();
    },
  },
  // Failed turns: one error card each (plain line, a second line, the fix, Details), never repeated by the end card.
  {
    names: ["panel-error-hosted", "panel-error-helper", "panel-error-ratelimit", "panel-error-unknown"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const expected = {
        "err-hosted": { msg: "Noa AI is unavailable right now.", fixes: ["Use your own Claude"], retry: "Retry" },
        "err-helper": { msg: "Local Claude Code isn't connected.", fixes: ["Set up Claude Code", "Use Noa AI"], retry: "Retry" },
        "err-ratelimit": { msg: "Too many requests right now.", fixes: [], retry: "Retry" },
        "err-unknown": { msg: "Something went wrong.", fixes: [], retry: "Retry" },
      };
      for (const [kind, want1] of Object.entries(expected)) {
        const name = `panel-error-${kind.slice(4)}`;
        if (!want(name, size, scheme)) continue;
        const p = await openPanel(ctx, kind, "#chat-log .ev-end");
        const got = await p.evaluate(() => {
          const log = document.getElementById("chat-log");
          const cards = [...log.querySelectorAll(".ev-error")];
          return {
            cards: cards.length,
            msg: cards[0]?.querySelector(".err-msg")?.textContent,
            fixes: [...log.querySelectorAll(".err-fix")].map((b) => b.textContent),
            retry: log.querySelector(".ev-continue")?.textContent,
            summary: log.querySelector(".ev-end .ev-summary")?.textContent ?? null,
            text: log.textContent,
          };
        });
        if (got.cards !== 1) fail(`${kind}: ${got.cards} error cards`);
        if (got.msg !== want1.msg) fail(`${kind}: message "${got.msg}"`);
        if (got.fixes.join(" | ") !== want1.fixes.join(" | ")) fail(`${kind}: fixes ${got.fixes.join(" | ")}`);
        if (got.retry !== want1.retry) fail(`${kind}: continue button "${got.retry}"`);
        if (got.summary !== null) fail(`${kind}: the end card repeats the error: "${got.summary}"`);
        if (/HTTP \d|invalid_request_error|rate_limit_error/.test(got.text.replace(/Details[\s\S]*$/, ""))) fail(`${kind}: technical text outside Details`);
        if (kind === "err-unknown") {
          // Details opens on demand, with the technical text to copy.
          await p.click("#chat-log .err-details > summary");
          const tech = await p.textContent("#chat-log .err-tech pre");
          if (!/prompt is too long/.test(tech)) fail(`${kind}: details "${tech}"`);
        }
        if (kind === "err-hosted") {
          await p.click("#chat-log [data-fix=own-claude]");
          const opened = await p.evaluate(() => window.__created.at(-1) ?? window.__opened.at(-1) ?? null);
          if (!/options\.html#ai$/.test(String(opened))) fail(`${kind}: Use your own Claude opened ${opened}`);
        }
        await checkLayout(p, `${kind} ${label}`);
        await shoot(p, name, size, scheme);
        reportErrors(p, `${kind} ${label}`);
        await p.close();
      }
    },
  },
  // The composer: Auto will not move a Claude Code chat to paid Noa AI; the refusal says so with both ways out.
  {
    names: ["panel-error-auto-switch"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "err-helper", "#chat-log .ev-end");
      await p.evaluate(() => (window.__refuse = { "run.message": "Local Claude Code is not available, and Auto does not move this chat to Noa AI on its own" }));
      await p.fill("#now-text", "and reply to the first comment");
      await p.click("#now-submit");
      await p.waitForSelector("#now-notice .ev-error");
      const got = await p.evaluate(() => ({
        msg: document.querySelector("#now-notice .err-msg")?.textContent,
        hint: document.querySelector("#now-notice .err-hint")?.textContent,
        fixes: [...document.querySelectorAll("#now-notice .err-fix")].map((b) => b.textContent),
        box: document.getElementById("now-text").value,
      }));
      if (got.msg !== "Local Claude Code isn't connected." || got.fixes.join(" | ") !== "Set up Claude Code | Use Noa AI") fail(`auto switch refusal ${JSON.stringify(got)}`);
      if (got.box !== "and reply to the first comment") fail("the refused message did not go back into the box");
      await checkLayout(p, `auto-switch ${label}`);
      await shoot(p, "panel-error-auto-switch", size, scheme);
      await p.click("#now-notice [data-fix=use-hosted]");
      const saved = await p.evaluate(() => window.__requests.find((r) => r.type === "settings.save")?.settings);
      if (saved?.brain !== "noa") fail(`Use Noa AI saved ${JSON.stringify(saved)}`);
      reportErrors(p, `auto-switch ${label}`);
      await p.close();
    },
  },
  // Warning states: no AI set up; the old pause of every run not converted yet. The strip under the header says so with its fix, over the list and a job.
  {
    names: ["panel-nobrain", "panel-model-menu-nojev"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "nobrain");
      const st = await p.evaluate(() => ({ shown: !document.getElementById("status").hidden, tone: document.getElementById("status").dataset.tone, action: document.getElementById("status-action").textContent }));
      if (!st.shown || st.tone !== "bad" || !st.action) fail(`no-AI strip ${JSON.stringify(st)}`);
      await checkLayout(p, `nobrain ${label}`);
      await shoot(p, "panel-nobrain", size, scheme);
      if (want("panel-model-menu-nojev", size, scheme)) {
        // No Jev key anywhere: the Jev row is disabled with a hint.
        await p.click("#now-model");
        await p.waitForSelector("#model-menu:not([hidden])");
        if (!(await p.locator(".mm-jev").isDisabled())) fail("Jev row enabled without a key");
        await checkLayout(p, `model-menu-nojev ${label}`);
        await shoot(p, "panel-model-menu-nojev", size, scheme);
        await p.keyboard.press("Escape");
      }
      reportErrors(p, `nobrain ${label}`);
      await p.close();
    },
  },
  {
    names: ["panel-pause-migration"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "pause-migration");
      const st = await p.evaluate(() => ({ text: document.getElementById("status-text").textContent, title: document.getElementById("status-text").title, action: document.getElementById("status-action").textContent }));
      if (st.text !== "Your account's jobs wait until each is paused" || !st.title.endsWith("Not done yet: HTTP 404: not found") || st.action !== "Retry") fail(`pause-migration strip ${JSON.stringify(st)}`);
      // Nothing pauses every run from the account menu any more.
      if (await p.locator("#acct-pause").count()) fail("the account menu still pauses every scheduled run");
      await checkLayout(p, `pause-migration ${label}`);
      await shoot(p, "panel-pause-migration", size, scheme);
      await openJob(p, "task:t6");
      if (!(await p.isVisible("#status-action"))) fail("the strip is gone on a job's page");
      await p.click("#status-action");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "pause.migrate"));
      reportErrors(p, `pause-migration ${label}`);
      await p.close();
    },
  },
  // Stopped by the user after typing the post: the next message continues that conversation.
  {
    names: ["panel-continue", "panel-continue-note", "panel-continue-newtask", "panel-continue-task-menu", "panel-continue-past-chat"],
    async run({ ctx, size, scheme, label, fail, want, only, openPanel, openJob, backToList, pick, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "stopped", "#chat-log .ev-tool");
      const data = scenario("stopped");
      const ended = data.sessions[0];
      await p.evaluate((s) => {
        window.__push({ type: "event", event: { type: "task_end", outcome: "paused", reason: "stopped by user", ts: s.endedAt, sessionId: s.sessionId } });
        window.__push({ type: "session", session: s });
      }, ended);
      await p.evaluate((st) => window.__push({ type: "state", state: st }), { ...data.state, running: null });
      await p.waitForSelector(".ev-continue");
      const mode = () =>
        p.evaluate(() => ({
          placeholder: document.getElementById("now-text").placeholder,
          submit: document.getElementById("now-submit").textContent,
          attach: !document.getElementById("now-attach").hidden,
        }));
      const expectMode = async (want, what) => {
        const got = await mode();
        if (got.placeholder !== want.placeholder || got.submit !== want.submit || got.attach !== want.attach) fail(`composer ${what}: ${JSON.stringify(got)}`);
      };
      const CHAT = { placeholder: "Message Noa…", submit: "Send", attach: true };
      const NEW = { placeholder: "Start a new job…", submit: "Send", attach: true };
      const lastMessage = () => p.evaluate(() => window.__requests.filter((r) => r.type === "run.message").at(-1) ?? null);
      await expectMode(CHAT, "not talking to the stopped conversation");
      await checkLayout(p, `continue ${label}`);
      await shoot(p, "panel-continue", size, scheme);

      // The card's Continue goes on right away (the box is empty, so no note is sent along).
      await p.click(".ev-continue");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.continue"));
      const cardCont = await p.evaluate(() => window.__requests.filter((r) => r.type === "run.continue").at(-1));
      if (cardCont?.sessionId !== "s-stop" || "text" in cardCont || (await lastMessage())) fail(`card Continue sent ${JSON.stringify(cardCont)}`);
      await p.click("#now-text");

      // A note, sent with Enter: the next turn of the same conversation.
      await p.keyboard.insertText("It's already typed, just press Post");
      await checkLayout(p, `continue-note ${label}`);
      await shoot(p, "panel-continue-note", size, scheme);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const req = await lastMessage();
      if (req?.sessionId !== "s-stop" || req?.text !== "It's already typed, just press Post") fail(`composer sent ${JSON.stringify(req)}`);

      // Back on the list the box starts a new job.
      await backToList(p);
      await expectMode(NEW, "still in the conversation on the list");
      await checkLayout(p, `continue-newtask ${label}`);
      await shoot(p, "panel-continue-newtask", size, scheme);

      // A past stopped chat (under Needs you) opens with Continue, and the composer talks to it.
      if (want("panel-continue-past-chat", size, scheme)) {
        await openJob(p, "chat:s-3");
        await p.waitForSelector("#chat-log .ev-continue");
        if (!(await p.locator("#chat-log .ev-first .ev-user-text").textContent()).includes("cheapest flight")) fail("the list's row did not open the run");
        await expectMode(CHAT, "not talking to a past stopped run opened from the list");
        if ((await p.evaluate(() => document.activeElement?.id)) !== "now-text") fail("opening from the list did not focus the box");
        await checkLayout(p, `continue-past-chat ${label}`);
        await shoot(p, "panel-continue-past-chat", size, scheme);
      }

      // A paused task: its menu's Resume goes on from its latest run.
      await openJob(p, "task:t5");
      await p.click("#job-menu summary");
      await shoot(p, "panel-continue-task-menu", size, scheme);
      await pick(p, "Resume");
      await p.waitForFunction(() => window.__requests.filter((r) => r.type === "run.continue").length >= 2);
      const cont = await p.evaluate(() => window.__requests.filter((r) => r.type === "run.continue").at(-1));
      if (cont?.sessionId !== "s-5") fail(`Resume sent ${JSON.stringify(cont)}`);
      reportErrors(p, `continue ${label}`);
      await p.close();
    },
  },
  // Voice: the mic left of Send (locked on Free) starts hands-free voice on the engine picked in Settings, as the
  // voice shortcut does, and ends it; the microphone permission asked in a tab.
  {
    names: ["panel-voice-locked", "panel-voice-idle", "panel-voice-mic-standard", "panel-voice-mic-realtime", "panel-voice-permission"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors, base }) {
      // The microphone is allowed (a grant for the origin replaces earlier ones, e.g. the clipboard's above).
      await ctx.grantPermissions(["microphone"], { origin: base });
      const mic = "#now-actions .voice-mic";
      const voiceState = (p) => p.getAttribute(mic, "data-state");
      /** Waits for the mic's state; on timeout says what the panel shows instead. */
      const waitVoice = (p, state) =>
        p.waitForFunction((st) => document.querySelector(".voice-mic").dataset.state === st, state).catch(async (err) => {
          const seen = await p.evaluate(() => ({ state: document.querySelector(".voice-mic").dataset.state, tip: document.querySelector("#now-notice").textContent }));
          throw new Error(`waiting for voice "${state}": ${JSON.stringify(seen)} (${err.message.split("\n")[0]})`);
        });
      const waitPill = (p, phase) =>
        p.waitForFunction((w) => document.querySelector("#voice-bar:not([hidden])")?.dataset.phase === w, phase, { timeout: 15_000 });
      const orbCheck = (p) =>
        p.evaluate(() => {
          const orb = document.querySelector(".voice-orb");
          const comp = document.getElementById("composer").getBoundingClientRect();
          const r = orb.querySelector(".voice-orb-stack").getBoundingClientRect();
          const box = document.getElementById("now-text").getBoundingClientRect();
          const out = [];
          if (orb.hidden) out.push("orb hidden");
          if (r.bottom > comp.top) out.push(`orb reaches the input (${Math.round(r.bottom)} > ${Math.round(comp.top)})`);
          if (Math.abs(r.left + r.width / 2 - window.innerWidth / 2) > 1) out.push("orb not centred");
          if (getComputedStyle(orb).pointerEvents !== "none") out.push("orb takes clicks");
          // The input stays above the veil.
          if (document.elementFromPoint(box.left + 10, box.top + box.height / 2)?.id !== "now-text") out.push("the veil covers the input");
          return out;
        });
      const listeningReported = (p) => p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.listening").at(-1)?.listening);

      // Free plan: a lock; the tooltip and a click explain, "Choose a plan" opens the dashboard's Billing page.
      {
        const p = await openPanel(ctx, "free");
        if ((await voiceState(p)) !== "locked") fail(`free plan mic ${await voiceState(p)}`);
        if ((await p.getAttribute(mic, "title")) !== "Voice needs the Plus or Pro plan") fail(`locked tooltip "${await p.getAttribute(mic, "title")}"`);
        await p.click(mic);
        await p.waitForSelector("#now-notice:not([hidden])");
        const tipText = await p.textContent("#now-notice");
        if (!/Voice needs the Plus or Pro plan/.test(tipText) || !/Choose a plan/.test(tipText)) fail(`locked tip "${tipText}"`);
        if (await p.evaluate(() => !document.querySelector("#voice-bar").hidden)) fail("the locked mic started hands-free");
        await checkLayout(p, `voice-locked ${label}`);
        await shoot(p, "panel-voice-locked", size, scheme);
        await p.click("#now-notice .notice-action");
        await p.waitForFunction(() => window.__created.includes("https://app.noa.bot/billing"));
        // The voice shortcut while locked points at the mic and says why, with Choose a plan.
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        const locked = await p.evaluate(() => ({ nudge: document.querySelector(".voice-mic").classList.contains("nudge"), tip: document.querySelector("#now-notice:not([hidden])")?.textContent ?? "" }));
        if (!locked.nudge || !/Voice needs/.test(locked.tip) || !/Choose a plan/.test(locked.tip)) fail(`locked voice shortcut ${JSON.stringify(locked)}`);
        reportErrors(p, `voice-locked ${label}`);
        await p.close();
      }

      // Paid plan: the mic is ready, its tooltip names the voice shortcut (both do the same).
      if (want("panel-voice-idle", size, scheme)) {
        const p = await openPanel(ctx, "account");
        if ((await voiceState(p)) !== "idle") fail(`paid plan mic ${await voiceState(p)}`);
        if ((await p.getAttribute(mic, "title")) !== `Voice mode · ${VOICE_SHORTCUT_LABEL}`) fail(`mic tooltip "${await p.getAttribute(mic, "title")}"`);
        await checkLayout(p, `voice-idle ${label}`);
        await shoot(p, "panel-voice-idle", size, scheme);
        reportErrors(p, `voice-idle ${label}`);
        await p.close();
      }

      // Standard picked in Settings: the mic starts hands-free on Standard (the orb, the words streaming into the box),
      // never the old one-shot dictation; pressed again it ends the session and the box is as it was.
      if (want("panel-voice-mic-standard", size, scheme)) {
        const p = await openPanel(ctx, "account", undefined, { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        await p.click(mic);
        await waitPill(p, "listening");
        await waitVoice(p, "handsfree");
        if ((await p.getAttribute(mic, "title")) !== `End voice mode · ${VOICE_SHORTCUT_LABEL}`) fail(`mic tooltip while on "${await p.getAttribute(mic, "title")}"`);
        if ((await listeningReported(p)) !== true) fail("the mic's hands-free not reported to the background");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.realtime"))) fail("Standard asked for the realtime relay");
        const problems = await orbCheck(p);
        if (problems.length) fail(`hands-free orb: ${problems.join("; ")}`);
        if ((await p.textContent(".voice-caption")) !== "Hands-free: say what to do · “stop” to end") fail(`orb caption "${await p.textContent(".voice-caption")}"`);
        await p.waitForFunction(() => document.getElementById("now-text").value.length > 0, null, { timeout: 15_000 });
        if (!(await p.evaluate(() => document.activeElement === document.getElementById("now-text")))) fail("the box lost the cursor");
        await checkLayout(p, `voice-mic-standard ${label}`);
        await shoot(p, "panel-voice-mic-standard", size, scheme);
        await p.click(mic);
        await waitVoice(p, "idle");
        if (await p.evaluate(() => !document.querySelector("#voice-bar").hidden)) fail("the mic did not end hands-free");
        if (!(await p.evaluate(() => document.querySelector(".voice-orb").hidden))) fail("orb still shown after stopping");
        if ((await listeningReported(p)) !== false) fail("the end not reported to the background");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "run.message" || r.type === "run.adhoc"))) fail("ending hands-free sent the words");
        if ((await p.inputValue("#now-text")) !== "") fail(`the box kept "${await p.inputValue("#now-text")}"`);
        reportErrors(p, `voice-mic-standard ${label}`);
        await p.close();
      }

      // Realtime (the default): the mic opens the narrator's session through the relay; pressed again it closes it.
      if (want("panel-voice-mic-realtime", size, scheme)) {
        const p = await openPanel(ctx, "account", undefined, { init: [installVoiceFakes] });
        await p.click(mic);
        await waitPill(p, "listening");
        await waitVoice(p, "handsfree");
        const rt = await p.evaluate(() => ({ first: window.__rt?.sent[0]?.type, transcription: window.__rt?.sent[0]?.session?.audio?.input?.transcription }));
        if (rt.first !== "session.update" || rt.transcription?.model !== "gpt-transcribe") fail(`the mic's Realtime session ${JSON.stringify(rt)}`);
        if (!(await p.evaluate(() => window.__requests.some((r) => r.type === "voice.realtime")))) fail("the mic did not ask for the realtime relay");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.transcribe"))) fail("Realtime used Standard's transcription");
        await checkLayout(p, `voice-mic-realtime ${label}`);
        await shoot(p, "panel-voice-mic-realtime", size, scheme);
        await p.click(mic);
        await waitVoice(p, "idle");
        await p.waitForFunction(() => window.__rt.closedWith === 1000);
        if ((await p.inputValue("#now-text")) !== "") fail(`Realtime wrote "${await p.inputValue("#now-text")}" into the box`);
        reportErrors(p, `voice-mic-realtime ${label}`);
        await p.close();
      }

      // No microphone permission yet: the mic opens the permission page and says so.
      if (want("panel-voice-permission", size, scheme)) {
        const p = await ctx.newPage();
        const errors = [];
        p.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
        await p.addInitScript(() => {
          const query = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (d) =>
            d.name === "microphone" ? Promise.resolve({ state: "prompt", addEventListener() {}, removeEventListener() {} }) : query(d);
        });
        await p.addInitScript(installChromeStub, scenario("account"));
        await p.goto(`${base}/sidepanel.html`);
        await p.waitForSelector("#job-groups > *", { state: "attached" });
        p.errors = errors;
        await p.click(mic);
        await p.waitForSelector("#now-notice:not([hidden])");
        if (!(await p.evaluate(() => window.__created.some((u) => u.endsWith("/mic-permission.html"))))) fail("the permission page did not open");
        if (!/Allow the microphone/.test(await p.textContent("#now-notice"))) fail(`permission tip "${await p.textContent("#now-notice")}"`);
        await waitVoice(p, "idle");
        await checkLayout(p, `voice-permission ${label}`);
        await shoot(p, "panel-voice-permission", size, scheme);
        reportErrors(p, `voice-permission ${label}`);
        await p.close();
      }
    },
  },
  // The voice strip (voice-bar.ts) while the fake microphone hears a voice: one line, "Voice on · <its tab>" (the tab's
  // name cut short when narrow) and "Hearing you", the
  // time on, a small meter, no buttons; the controls in the composer row (the mic, filled in the live colour, ends voice;
  // Mute next to it); the box glowing with "Listening… just talk"; the background told the tab (its toolbar badge) and,
  // when the mic ends it by keyboard, that it ended (the badge goes). With reduced motion nothing pulses.
  {
    names: ["panel-voicebar-hearing", "panel-voicebar-reduced"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base, want }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      for (const reduced of [false, true]) {
        const name = reduced ? "panel-voicebar-reduced" : "panel-voicebar-hearing";
        if (!want(name, size, scheme)) continue;
        const p = await openPanel(ctx, "account", undefined, { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        if (reduced) await p.emulateMedia({ reducedMotion: "reduce" });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p
          .waitForFunction(() => document.getElementById("voice-bar").dataset.state === "hearing", null, { timeout: 15_000 })
          .catch(async () => fail(`${name}: never "hearing" (${await p.evaluate(() => document.getElementById("voice-bar").dataset.state)})`));
        const look = await p.evaluate(() => {
          const bar = document.getElementById("voice-bar");
          const mic = document.querySelector("#now-actions .voice-mic");
          const mute = document.querySelector("#now-actions .voice-mute");
          const anim = (el, pseudo) => getComputedStyle(el, pseudo).animationName;
          return {
            label: bar.querySelector(".vb-label").textContent,
            status: bar.querySelector(".vb-status").textContent,
            time: bar.querySelector(".vb-time").textContent,
            hint: bar.title,
            live: bar.querySelector("[aria-live=polite]").textContent,
            region: [bar.getAttribute("role"), bar.getAttribute("aria-label")],
            buttons: [...bar.querySelectorAll("button")].filter((b) => b.offsetParent).length,
            height: bar.getBoundingClientRect().height,
            meter: !bar.querySelector(".vb-meter").hidden,
            placeholder: document.getElementById("now-text").placeholder,
            glow: document.body.classList.contains("voice-live") && getComputedStyle(document.querySelector(".now")).boxShadow !== "none",
            micTitle: mic.title,
            micPressed: mic.getAttribute("aria-pressed"),
            micFill: getComputedStyle(mic).backgroundColor,
            micText: mic.textContent,
            mics: document.querySelectorAll(".now-bar svg.mic").length,
            mute: mute && !mute.hidden ? [mute.getAttribute("aria-pressed"), mute.getAttribute("aria-label"), mute.textContent] : null,
            anims: [anim(bar.querySelector(".vb-dot")), anim(mic, "::before"), anim(document.querySelector(".now"))],
            reported: window.__portSent.filter((m) => m.type === "panel.listening").at(-1),
          };
        });
        const want2 = (ok, what) => ok || fail(`${name} ${label}: ${what} ${JSON.stringify(look)}`);
        want2(look.label === "Voice on · Inbox (1) - ada.lovelace@ex…" && look.status === "Hearing you" && look.live === "Voice on: Listening", "state word / announcement");
        want2(/^0:0\d$/.test(look.time), "time on");
        want2(look.hint === "Standard voice · Just talk · say “stop” to end", "tooltip");
        want2(look.region[0] === "region" && look.region[1] === "Voice status", "strip region");
        want2(look.buttons === 0 && look.height <= 30, "a slim strip without buttons");
        want2(look.meter, "meter");
        want2(look.placeholder === "Listening… just talk" && look.glow, "listening box");
        want2(look.micTitle === `End voice mode · ${VOICE_SHORTCUT_LABEL}` && look.micPressed === "true", "mic ends voice");
        want2(look.micFill !== "rgba(0, 0, 0, 0)" && look.micText === "Voice" && look.mics === 1, "Voice filled, still \"Voice\", one mic icon");
        want2(JSON.stringify(look.mute) === JSON.stringify(["false", "Mute the microphone · Alt+M", "Mute"]), "Mute in the composer");
        want2(look.reported?.listening === true && look.reported?.tabId === 1, "listening reported with the tab (badge)");
        const still = look.anims.every((a) => a === "none");
        want2(reduced ? still : look.anims.join() === "vb-breathe,vb-mic-ring,vb-glow", reduced ? "something pulses with reduced motion" : "no pulse");
        await checkLayout(p, `${name} ${label}`);
        await shoot(p, name, size, scheme);
        // The mic by keyboard ends it: the background hears it (the badge goes), the box is as before.
        await p.focus("#now-actions .voice-mic");
        await p.keyboard.press("Enter");
        await p.waitForFunction(() => document.getElementById("voice-bar").hidden, null, { timeout: 5000 }).catch(() => fail(`${name} ${label}: Enter on the mic did not end it`));
        const after = await p.evaluate(() => ({
          reported: window.__portSent.filter((m) => m.type === "panel.listening").at(-1),
          mic: document.querySelector("#now-actions .voice-mic").dataset.state,
          mute: !document.querySelector("#now-actions .voice-mute").hidden,
          placeholder: document.getElementById("now-text").placeholder,
          glow: document.body.classList.contains("voice-live"),
        }));
        if (after.reported?.listening !== false || after.reported?.tabId !== undefined || after.mic !== "idle" || after.mute || after.placeholder === "Listening… just talk" || after.glow)
          fail(`${name} ${label}: after the mic ended it ${JSON.stringify(after)}`);
        reportErrors(p, `${name} ${label}`);
        await p.close();
      }
    },
  },
  // Hands-free voice (the voice shortcut): the orb and the status strip while listening, "Sending…" with the utterance
  // in the box (Standard), the strip while the agent works (the task's Stop and the voice controls apart in the
  // composer row), a spoken line with Interrupt in the composer; Realtime's one-time cost notice, the narrator
  // speaking, its send_to_agent starting a task with one acknowledgement, and one message per request: what the
  // narrator understood, with the user's words for it folded under it ("Word for word"); what was said but led to no
  // request is not shown; Realtime unavailable says so and offers Standard (it never switches by itself); a dropped
  // connection shows "Reconnecting…"; on another tab, the note goes with the message as its context.
  {
    names: [
      "panel-handsfree-listening",
      "panel-handsfree-sending",
      "panel-handsfree-speaking",
      "panel-handsfree-working",
      "panel-handsfree-cost",
      "panel-handsfree-narrator",
      "panel-handsfree-heard",
      "panel-handsfree-unavailable",
      "panel-handsfree-reconnecting",
      "panel-handsfree-elsewhere",
      "panel-handsfree-elsewhere-heard",
    ],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base, want }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      const phase = (p) => p.evaluate(() => (document.querySelector("#voice-bar:not([hidden])") ? document.querySelector("#voice-bar").dataset.phase : "off"));
      /** Waits for the hands-free phase; on timeout says what the panel shows instead. */
      const waitPhase = (p, wanted, timeout = 20_000) =>
        p.waitForFunction((w) => document.querySelector("#voice-bar:not([hidden])")?.dataset.phase === w, wanted, { timeout }).catch(async (err) => {
          const seen = await p.evaluate(() => ({
            phase: document.querySelector("#voice-bar")?.dataset.phase,
            hidden: document.querySelector("#voice-bar")?.hidden,
            bar: document.querySelector("#voice-bar .vb-status")?.textContent,
            tip: document.querySelector("#now-notice:not([hidden])")?.textContent,
          }));
          throw new Error(`waiting for hands-free "${wanted}": ${JSON.stringify(seen)} (${err.message.split("\n")[0]})`);
        });
      const barTitle = (p) => p.textContent("#voice-bar .vb-status");
      /** The state word, allowing for the fake microphone's voice ("Hearing you" while listening or working). */
      const barSays = async (p, ...words) => words.includes(await barTitle(p));
      /**
       * The strip: full width right under the tabs, above the orb's veil, one slim line, its words not cut, no buttons
       * (on its own tab); a polite live line saying the state. The composer row: every voice control and the task's
       * Stop in view, none overlapping, none cut, each with a name.
       */
      const barCheck = (p) =>
        p.evaluate(() => {
          const bar = document.getElementById("voice-bar");
          const r = bar.getBoundingClientRect();
          const top = document.querySelector("header.top").getBoundingClientRect();
          const out = [];
          if (bar.hidden) out.push("bar hidden");
          if (Math.abs(r.top - top.bottom) > 1) out.push(`bar not right under the tabs (${Math.round(r.top)} vs ${Math.round(top.bottom)})`);
          if (r.left !== 0 || Math.abs(r.width - window.innerWidth) > 1) out.push("bar not full width");
          if (r.height > 30) out.push(`bar not one slim line (${Math.round(r.height)})`);
          if ([...bar.querySelectorAll("button")].some((b) => b.offsetParent)) out.push("buttons in the strip");
          const text = bar.querySelector(".vb-text");
          if (text.scrollWidth > text.clientWidth + 1) out.push("the strip's words are cut");
          if (!bar.querySelector("[aria-live=polite]")?.textContent) out.push("no live line");
          const row = document.querySelector(".now-bar").getBoundingClientRect();
          const tools = [...document.querySelectorAll(".now-bar button, .now-bar [role=button]")].filter((b) => b.offsetParent);
          const boxes = tools.map((b) => [b, b.getBoundingClientRect()]);
          for (const [b, x] of boxes) {
            const name = b.id || b.className;
            if (x.left < row.left - 5 || x.right > row.right + 0.5) out.push(`${name} cut`);
            if (!(b.getAttribute("aria-label") || b.textContent.trim())) out.push(`${name} has no name`);
          }
          for (let i = 1; i < boxes.length; i++) if (boxes[i][1].left < boxes[i - 1][1].right - 0.5) out.push(`${boxes[i][0].className} overlaps ${boxes[i - 1][0].className}`);
          return out;
        });
      /** The background's state with `session` running in tab 1 (pushed as the runner would). */
      const pushRunning = (p, session) =>
        p.evaluate((s) => {
          const st = window.__data.state;
          window.__push({ type: "state", state: { ...st, running: s, runningSessions: [s], tabChats: { 1: s.sessionId }, runningTabs: { [s.sessionId]: [1] } } });
        }, session);
      const newSession = (title) => ({ sessionId: "s-new", source: "adhoc", title, instructions: title, brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: new Date().toISOString() });
      const spokenLast = (p) => p.evaluate(() => window.__spoken.at(-1));

      // Standard: listening -> sending -> the task starts -> a line is said -> working -> the result is said -> stopped.
      if (["listening", "sending", "speaking", "working"].some((n) => want(`panel-handsfree-${n}`, size, scheme))) {
        const p = await openPanel(ctx, "account", undefined, { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        await p.evaluate(() => (window.__ttsHold = true));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        if (!(await barSays(p, "Listening", "Hearing you"))) fail(`listening bar "${await barTitle(p)}"`);
        if (!(await p.evaluate(() => !document.querySelector(".voice-orb").hidden))) fail("no orb while hands-free listens");
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "handsfree") fail("the mic does not show hands-free");
        if (!(await p.evaluate(() => window.__portSent.some((m) => m.type === "panel.listening" && m.listening === true)))) fail("hands-free not reported to the background");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.realtime"))) fail("Standard asked for the realtime relay");
        await checkLayout(p, `handsfree-listening ${label}`);
        const pl = await barCheck(p);
        if (pl.length) fail(`listening bar: ${pl.join("; ")}`);
        await shoot(p, "panel-handsfree-listening", size, scheme);

        // The fake microphone talks, then pauses: the utterance waits in "Sending…" with its words in the box.
        await waitPhase(p, "sending", 25_000);
        if ((await barTitle(p)) !== "Sending") fail(`sending bar "${await barTitle(p)}"`);
        if (!/^Open Gmail/.test(await p.inputValue("#now-text"))) fail(`sending: box "${await p.inputValue("#now-text")}"`);
        await shoot(p, "panel-handsfree-sending", size, scheme);
        // It goes to the chat of the tab the session started in (none yet: a new one there), marked as spoken.
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"), null, { timeout: 5000 });
        const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
        if (!/^Open Gmail/.test(req.text) || req.voice !== true || req.tabId !== 1 || req.sessionId !== undefined) fail(`hands-free sent ${JSON.stringify(req)}`);
        const sent = req.text;
        await p.waitForSelector("#chat-log .ev-first.voice .ev-voice", { state: "attached" });

        // The task runs: its short plan is said (playing in the chat), then the bar says it works.
        await pushRunning(p, newSession(sent));
        await p.evaluate(() =>
          window.__push({ type: "event", event: { type: "assistant_text", text: "I'll open Gmail and read your newest email. Starting now.", ts: new Date().toISOString(), sessionId: "s-new" } }),
        );
        await waitPhase(p, "speaking");
        if ((await spokenLast(p)) !== "I'll open Gmail and read your newest email.") fail(`said "${await spokenLast(p)}"`);
        const playing = await p.evaluate(() => [...document.querySelectorAll("#chat-log .ev-spoken.playing .ev-spoken-text")].map((e) => e.textContent));
        if (playing.join(" | ") !== "I'll open Gmail and read your newest email.") fail(`playing in the chat: ${JSON.stringify(playing)}`);
        if (await p.evaluate(() => document.querySelector(".hf-caption, .voice-tip"))) fail("a floating caption or tip is still drawn");
        if ((await barTitle(p)) !== "Speaking") fail(`speaking bar "${await barTitle(p)}"`);
        if (await p.evaluate(() => document.querySelector("#now-actions .voice-interrupt").hidden)) fail("no Interrupt in the composer while speaking");
        const sl = await barCheck(p);
        if (sl.length) fail(`speaking: ${sl.join("; ")}`);
        if (!(await p.evaluate(() => document.querySelector(".voice-orb").hidden))) fail("the orb still covers the chat after sending");
        await checkLayout(p, `handsfree-speaking ${label}`);
        await shoot(p, "panel-handsfree-speaking", size, scheme);
        await p.evaluate(() => window.__ttsRelease());
        await waitPhase(p, "working");
        if (!(await barSays(p, "Agent working", "Hearing you"))) fail(`working bar "${await barTitle(p)}"`);
        // The task's Stop and the mic that ends voice: two different buttons, named apart.
        const stops = await p.evaluate(() => ({
          task: [!document.getElementById("now-stop").hidden, document.getElementById("now-stop").title, !!document.querySelector("#now-stop svg")],
          voice: document.querySelector("#now-actions .voice-mic").title,
          interrupt: !document.querySelector("#now-actions .voice-interrupt").hidden,
        }));
        if (JSON.stringify(stops.task) !== JSON.stringify([true, "Stop the task", true]) || !/^End voice/.test(stops.voice) || stops.interrupt) fail(`the two stops ${JSON.stringify(stops)}`);
        // Said: the line is kept in its chat (compact: the agent's text above starts with it), no longer playing.
        await p.waitForFunction(() => document.querySelector("#chat-log .ev-spoken:not(.live)"));
        const kept = await p.evaluate(() => ({
          asked: window.__requests.filter((r) => r.type === "voice.spoken").map((r) => [r.sessionId, r.text]),
          shown: [...document.querySelectorAll("#chat-log .ev-spoken")].map((e) => [e.className, e.textContent]),
        }));
        if (JSON.stringify(kept.asked) !== JSON.stringify([["s-new", "I'll open Gmail and read your newest email."]]) || kept.shown.length !== 1 || !/echo/.test(kept.shown[0][0]) || /playing|live/.test(kept.shown[0][0]))
          fail(`kept spoken line ${JSON.stringify(kept)}`);
        await p.evaluate(() => {
          const ev = (e) => window.__push({ type: "event", event: { ...e, ts: new Date().toISOString(), sessionId: "s-new" } });
          ev({ type: "tool_call", id: "1", name: "navigate", args: { url: "https://mail.google.com/mail/u/0/#inbox" } });
          ev({ type: "tool_result", id: "1", name: "navigate", text: "Opened https://mail.google.com/mail/u/0/#inbox (title: Inbox)" });
        });
        await waitPhase(p, "speaking");
        if ((await spokenLast(p)) !== "Opening mail.google.com") fail(`milestone "${await spokenLast(p)}"`);
        await p.evaluate(() => window.__ttsRelease());
        await waitPhase(p, "working");
        const wl = await barCheck(p);
        if (wl.length) fail(`working bar: ${wl.join("; ")}`);
        await checkLayout(p, `handsfree-working ${label}`);
        await shoot(p, "panel-handsfree-working", size, scheme);

        // The result is said in the agent's own spoken words, not the long answer.
        await p.evaluate(() => (window.__ttsHold = false));
        await p.evaluate(() => {
          const at = new Date().toISOString();
          window.__push({ type: "event", event: { type: "assistant_text", text: "You have **1 new email** from Sarah: dinner moved to 8.", ts: at, sessionId: "s-new" } });
          window.__push({ type: "event", event: { type: "task_end", outcome: "done", summary: "Read the newest email", spoken: "Sarah says dinner moved to eight.", ts: at, sessionId: "s-new" } });
        });
        await p.waitForFunction(() => window.__spoken.at(-1) === "Sarah says dinner moved to eight.");
        // The result is kept as a full spoken line; the milestone, which repeats a tool row, is not kept.
        await p.waitForFunction(() => [...document.querySelectorAll("#chat-log .ev-spoken:not(.live) .ev-spoken-text")].some((e) => e.textContent === "Sarah says dinner moved to eight."));
        const lines = await p.evaluate(() => [...document.querySelectorAll("#chat-log .ev-spoken")].map((e) => [e.classList.contains("echo"), e.textContent]));
        if (JSON.stringify(lines) !== JSON.stringify([[true, "I'll open Gmail and read your newest email."], [false, "Sarah says dinner moved to eight."]])) fail(`spoken lines in the chat ${JSON.stringify(lines)}`);
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.spoken" && /^Opening/.test(r.text)))) fail("a milestone was kept in the chat");
        if (await p.evaluate(() => window.__spoken.some((l) => /\*\*/.test(l)))) fail("a Markdown answer was read out");

        // The shortcut again ends it: the strip goes, the background hears the mic is off.
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        if ((await p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.listening").at(-1)?.listening)) !== false) fail("hands-free end not reported to the background");
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "idle") fail("the mic still shows hands-free");
        reportErrors(p, `handsfree ${label}`);
        await p.close();
      }

      // Realtime: the cost notice the first time, the narrator talking (caption), and its send_to_agent starting a task.
      if (["cost", "narrator", "heard", "elsewhere-heard"].some((n) => want(`panel-handsfree-${n}`, size, scheme))) {
        const p = await openPanel(ctx, "account", undefined, { edit: (d) => (d.state.settings.realtimeCostNoticed = false), init: [installVoiceFakes] });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        await p.waitForSelector("#now-notice:not([hidden])");
        const tip = await p.textContent("#now-notice:not([hidden])");
        if (!/^Realtime voice uses about 6¢ of usage credit a minute\. Standard costs much less\.Voice settings×$/.test(tip)) fail(`cost notice "${tip}"`);
        if (!(await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.realtimeCostNoticed === true)))) fail("the cost notice is not remembered");
        const rt = await p.evaluate(() => ({ protocols: window.__rt.protocols, sent: window.__rt.sent.map((e) => e.type), first: window.__rt.sent[0] }));
        if (JSON.stringify(rt.protocols) !== JSON.stringify(["noa", "bt.tok"])) fail(`subprotocols ${JSON.stringify(rt.protocols)}`);
        if (rt.first?.type !== "session.update" || rt.first.session.model !== undefined) fail(`first event ${JSON.stringify(rt.first)?.slice(0, 120)}; sent ${rt.sent.slice(0, 5)}`);
        if (!(await p.evaluate(() => !document.querySelector("#voice-bar").hidden))) fail("the cost notice took the bar's place");
        await checkLayout(p, `handsfree-cost ${label}`);
        await shoot(p, "panel-handsfree-cost", size, scheme);
        await p.click("#now-notice:not([hidden]) .notice-close");

        // The narrator says hello: its words under the orb while its audio plays.
        await p.evaluate(() => {
          const pcm = btoa(String.fromCharCode(...new Uint8Array(24_000 * 2 * 1.5)));
          window.__rt.emit({ type: "response.created", response: { id: "r1" } });
          window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Hi! What should I do?" });
          window.__rt.emit({ type: "response.output_audio.delta", item_id: "a1", response_id: "r1", delta: pcm });
        });
        await waitPhase(p, "speaking");
        if ((await p.textContent(".voice-caption")) !== "Hi! What should I do?") fail(`narrator caption "${await p.textContent(".voice-caption")}"`);
        await shoot(p, "panel-handsfree-narrator", size, scheme);

        /**
         * A turn of the user's (input item `id`): its words, then the narrator's reply, which says `reply` aloud (it
         * answered) or nothing (the words are part of what comes next).
         */
        const turn = (id, words, reply) =>
          p.evaluate(
            ([id, words, reply]) => {
              window.__rt.emit({ type: "input_audio_buffer.speech_started", item_id: id });
              window.__rt.emit({ type: "input_audio_buffer.speech_stopped", item_id: id });
              window.__rt.emit({ type: "input_audio_buffer.committed", item_id: id, previous_item_id: null });
              window.__rt.emit({ type: "response.created", response: { id: `r_${id}` } });
              window.__rt.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: words });
              if (reply) {
                window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: `a_${id}`, delta: reply });
                window.__rt.emit({ type: "response.output_audio.delta", item_id: `a_${id}`, response_id: `r_${id}`, delta: btoa(String.fromCharCode(...new Uint8Array(4800))) });
              }
              window.__rt.emit({ type: "response.done", response: { id: `r_${id}`, status: "completed", output: [] } });
            },
            [id, words, reply ?? null],
          );
        // Thinking aloud before asking (input item in0, a silent reply): there is no chat yet, and nothing goes out.
        await p.evaluate(() => window.__rt.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } }));
        const early = "Hmm, one sec, let me think.";
        await turn("in0", early, null);
        await p.waitForTimeout(50);
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.heard" || r.type === "run.message"))) fail("words went out before any request");

        // The user asks (input item in1): their words, then the narrator calls send_to_agent before saying anything, and
        // the request goes out at once as a new task with every part of their speech since (word for word): no sending
        // window, nothing written into the box.
        const heardText = "Could you check what Sarah wrote me?";
        await p.evaluate((t) => {
          window.__rt.emit({ type: "input_audio_buffer.speech_started", item_id: "in1" });
          window.__rt.emit({ type: "input_audio_buffer.speech_stopped", item_id: "in1" });
          window.__rt.emit({ type: "input_audio_buffer.committed", item_id: "in1", previous_item_id: null });
          window.__rt.emit({ type: "response.created", response: { id: "r2" } });
          window.__rt.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "in1", content_index: 0, transcript: t });
          window.__rt.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Open Gmail and read my newest email" }) });
        }, heardText);
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"), null, { timeout: 500 }).catch(() => fail("send_to_agent was not sent at once"));
        const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
        if (req.text !== "Open Gmail and read my newest email" || req.voice !== true || req.tabId !== 1 || JSON.stringify(req.heard) !== JSON.stringify([early, heardText]))
          fail(`send_to_agent sent ${JSON.stringify(req)}`);
        if ((await phase(p)) === "sending") fail("a Realtime request waited in a sending window");
        const sent = req.text;
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.item?.type === "function_call_output"));
        const output = await p.evaluate(() => window.__rt.sent.find((e) => e.item?.type === "function_call_output")?.item.output);
        if (output !== "Started. Your updates on it will follow.") fail(`tool output "${output}"`);
        // One short acknowledgement once that reply is done (it said nothing), and no other reply.
        const replies = () => p.evaluate(() => window.__rt.sent.filter((e) => e.type === "response.create"));
        if ((await replies()).length) fail("a reply was asked for while the narrator's reply was still being made");
        await p.evaluate(() => window.__rt.emit({ type: "response.done", response: { id: "r2", status: "completed", output: [] } }));
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "response.create"));
        const ack = await replies();
        if (ack.length !== 1 || !/one very short acknowledgement/.test(ack[0].response?.instructions ?? "")) fail(`acknowledgement ${JSON.stringify(ack)}`);
        await p.evaluate(() => {
          const pcm = btoa(String.fromCharCode(...new Uint8Array(24_000 * 2 * 0.5)));
          window.__rt.emit({ type: "response.created", response: { id: "r3" } });
          window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a3", delta: "On it." });
          window.__rt.emit({ type: "response.output_audio.delta", item_id: "a3", response_id: "r3", delta: pcm });
          window.__rt.emit({ type: "response.done", response: { id: "r3", status: "completed", output: [] } });
        });
        if ((await p.inputValue("#now-text")) !== "") fail(`Realtime wrote "${await p.inputValue("#now-text")}" into the box`);

        // The chat: one message, the request as understood; the words folded under it ("Word for word"), both parts.
        await pushRunning(p, { ...newSession(sent), voice: true, heard: [early, heardText] });
        await p.waitForFunction((t) => document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent === t, sent, { timeout: 5000 }).catch(() => undefined);
        await p.click("#chat-log .ev-opening .ev-words > summary").catch(() => fail("no Word for word under the first message"));
        const bubble = await p.evaluate(() => ({
          first: document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent,
          voice: !!document.querySelector("#chat-log .ev-first .ev-voice"),
          words: document.querySelector("#chat-log .ev-opening .ev-words-text")?.textContent,
          open: document.querySelector("#chat-log .ev-opening .ev-words")?.open,
          users: document.querySelectorAll("#chat-log .ev-user").length,
          heardLines: document.querySelectorAll("#chat-log .ev-heard").length,
        }));
        if (bubble.first !== sent || !bubble.voice || bubble.words !== `${early} · ${heardText}` || !bubble.open || bubble.users !== 1 || bubble.heardLines) fail(`the request in the chat ${JSON.stringify(bubble)}`);
        await checkLayout(p, `handsfree-heard ${label}`);
        await shoot(p, "panel-handsfree-heard", size, scheme);
        if ((await replies()).length !== 1) fail(`more than one reply for the turn: ${JSON.stringify(await replies())}`);

        // Small talk while the agent works, answered aloud (short, capped) and passed on to no one: kept for the record
        // (voice.heard), never shown in the chat, no message.
        await turn("in2", "Okay, thanks.", "Sure! I'm here whenever you need me, just tell me what else to do.");
        // While the agent works, that long reply is never heard: it is made again, capped, and that one is said.
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "response.create" && e.response?.max_output_tokens === 80), null, { timeout: 5000 }).catch(() => fail("small talk while working was not made short"));
        await p.evaluate(() => {
          window.__rt.emit({ type: "response.created", response: { id: "r_short" } });
          window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a_short", delta: "Sure." });
          window.__rt.emit({ type: "response.output_audio.delta", item_id: "a_short", response_id: "r_short", delta: btoa(String.fromCharCode(...new Uint8Array(4800))) });
          window.__rt.emit({ type: "response.done", response: { id: "r_short", status: "completed", output: [] } });
        });
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "voice.heard"), null, { timeout: 5000 }).catch(() => fail("words that led to no request were not kept"));
        const aside = await p.evaluate(() => ({
          kept: window.__requests.filter((r) => r.type === "voice.heard").map((r) => [r.sessionId, r.text]),
          users: document.querySelectorAll("#chat-log .ev-user").length,
          heardLines: document.querySelectorAll("#chat-log .ev-heard").length,
          sent: window.__requests.filter((r) => r.type === "run.message").length,
        }));
        if (JSON.stringify(aside.kept) !== JSON.stringify([["s-new", "Okay, thanks."]]) || aside.users !== 1 || aside.heardLines || aside.sent !== 1) fail(`small talk ${JSON.stringify(aside)}`);

        // The user looks at another tab and asks (the report on 81df820): the request goes out with the note naming
        // both tabs as its context; the chat shows their words once with the request under them, never the note, and
        // never the request as a bubble of its own.
        // (This panel is a page of its own: it shows the active tab, as the user switching to tab 2.)
        await p.evaluate(() => window.__activateTab(2));
        await p.waitForSelector("#voice-bar[data-state=elsewhere]", { timeout: 5000 }).catch(() => fail("the bar does not say the user looks at another tab"));
        const away = { words: "So, yeah, forget that for now, and look at the invoices from Acme instead.", request: "Forget that. Find the invoices from Acme." };
        await p.evaluate((a) => {
          window.__rt.emit({ type: "input_audio_buffer.speech_started", item_id: "in4" });
          window.__rt.emit({ type: "input_audio_buffer.speech_stopped", item_id: "in4" });
          window.__rt.emit({ type: "input_audio_buffer.committed", item_id: "in4", previous_item_id: null });
          window.__rt.emit({ type: "response.created", response: { id: "r_in4" } });
          window.__rt.emit({ type: "response.function_call_arguments.done", call_id: "c4", name: "send_to_agent", arguments: JSON.stringify({ text: a.request }) });
          window.__rt.emit({ type: "response.done", response: { id: "r_in4", status: "completed", output: [] } });
          // The words after the call (it waits for them).
          window.__rt.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "in4", content_index: 0, transcript: a.words });
        }, away);
        await p.waitForFunction(() => window.__requests.filter((r) => r.type === "run.message").length === 2, null, { timeout: 5000 }).catch(() => undefined);
        const awayReq = await p.evaluate(() => window.__requests.filter((r) => r.type === "run.message")[1]);
        if (awayReq?.text !== away.request || awayReq.sessionId !== "s-new" || JSON.stringify(awayReq.heard) !== JSON.stringify([away.words]) || !/^The user is looking at another tab: .+\. You work in .+\.$/.test(awayReq.context ?? ""))
          fail(`asked on another tab, sent ${JSON.stringify(awayReq)}`);
        // Back on the session's tab. The background keeps the message as it was sent (user_message) with its words: one
        // bubble, the request, its words folded under it; never the note, never two bubbles.
        await p.evaluate(() => window.__activateTab(1));
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state !== "elsewhere" && !!document.querySelector("#chat-log .ev-first"), null, { timeout: 5000 }).catch(() => undefined);
        await p.evaluate((r) => window.__push({ type: "event", event: { type: "user_message", text: r.text, voice: true, heard: r.heard, ts: new Date().toISOString(), sessionId: "s-new" } }), awayReq);
        await p.waitForFunction((t) => [...document.querySelectorAll("#chat-log .ev-said .ev-user-text")].some((e) => e.textContent === t), away.request, { timeout: 5000 }).catch(() => undefined);
        const awayChat = await p.evaluate(() => ({
          bubbles: [...document.querySelectorAll("#chat-log .ev-user")].map((e) => e.textContent),
          words: [...document.querySelectorAll("#chat-log .ev-said .ev-words-text")].map((e) => e.textContent),
        }));
        const awayBubbles = awayChat.bubbles.filter((t) => t !== sent);
        if (JSON.stringify(awayBubbles) !== JSON.stringify([away.request]) || JSON.stringify(awayChat.words) !== JSON.stringify([away.words]) || awayChat.bubbles.some((t) => t.includes("looking at another tab")))
          fail(`asked on another tab, the chat shows ${JSON.stringify(awayChat)}`);
        const acks = (await replies()).filter((r) => /acknowledgement/.test(r.response?.instructions ?? ""));
        if (acks.length !== 2) fail(`not one acknowledgement for the request asked on another tab: ${JSON.stringify(acks)}`);
        await checkLayout(p, `handsfree-elsewhere-heard ${label}`);
        await shoot(p, "panel-handsfree-elsewhere-heard", size, scheme);

        // The chat's events reach the narrator as notes; the result asks it to reply.
        await p.evaluate(() =>
          window.__push({ type: "event", event: { type: "task_end", outcome: "done", summary: "Read the newest email", spoken: "Sarah says dinner moved to eight.", ts: new Date().toISOString(), sessionId: "s-new" } }),
        );
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "conversation.item.create" && /Sarah says dinner moved to eight/.test(e.item?.content?.[0]?.text ?? "")));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => window.__rt.closedWith === 1000);
        reportErrors(p, `handsfree-realtime ${label}`);
        await p.close();
      }

      // The window's side panel, started on tab 1: the session belongs to tab 1. The panel stays on screen on every tab
      // and follows the active tab (__activateTab): on another tab the bar still names tab 1 (Go to tab, Use voice
      // here), and what is said there goes to tab 1's chat with a note naming both tabs; closing its tab ends it. Then
      // another panel's session (another window's) seen from this one: the notice, nothing live; Use voice here waits
      // for it to end.
      if (want("panel-handsfree-elsewhere", size, scheme)) {
        const p = await openPanel(ctx, "voice-chat", "#chat-log .ev-end", { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        const own = await p.evaluate(() => window.__portSent.find((m) => m.type === "panel.hello")?.panel);
        if (!own) fail("the panel's hello names no panel id");
        /** The user switches to tab `tab`. */
        const look = (tab) => p.evaluate((t) => window.__activateTab(t), tab);
        /** The background's word on the session (`panel`: the page running it; default this one). */
        const session = (s) =>
          p.evaluate((v) => window.__push({ type: "voice.session", session: v }), s === null ? null : { tabId: 1, windowId: 1, panel: own, engine: "standard", viewing: 1, ...s });
        const lastListening = () => p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.listening").at(-1));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        const reported = await lastListening();
        if (reported.listening !== true || reported.tabId !== 1 || reported.engine !== "standard") fail(`session reported ${JSON.stringify(reported)}`);
        await session({ viewing: 1 });
        const here = await p.evaluate(() => document.querySelector("#voice-bar .vb-label").textContent);
        if (here !== "Voice on · Inbox (1) - ada.lovelace@ex…") fail(`the bar on its own tab names it: "${here}"`);
        // A tab its chat lives in is the session's own: the plain bar there. Here the chat moved to the tab its
        // task works in (as a run started from an extension page does), and the user looks at that tab.
        const home = await p.evaluate(() => window.__data.state);
        await p.evaluate(() => {
          const st = window.__data.state;
          window.__push({ type: "state", state: { ...st, tabChats: { 3: "s-voice" }, runningTabs: { "s-voice": [3] } } });
        });
        await look(3);
        await p.waitForTimeout(100);
        if (await p.evaluate(() => document.getElementById("voice-bar").dataset.state === "elsewhere")) fail("the tab the chat moved to counts as another tab");
        await p.evaluate((st) => window.__push({ type: "state", state: st }), home);
        await look(1);
        // The user switches to tab 2 (the panel stays on screen): the bar still names tab 1.
        await look(2);
        await p.waitForFunction(() => document.querySelector("#voice-bar[data-state=elsewhere] .vb-label")?.textContent.startsWith("Voice on · Inbox (1)"));
        const away = await p.evaluate(() => ({
          label: document.querySelector("#voice-bar .vb-label").textContent,
          off: !!document.querySelector("#voice-bar .vb-off").offsetParent,
          mute: !document.querySelector("#now-actions .voice-mute").hidden,
          go: !!document.querySelector("#voice-bar .vb-go").offsetParent,
          use: !!document.querySelector("#voice-bar .vb-use").offsetParent,
          orb: !document.querySelector(".voice-orb").hidden,
          live: document.body.classList.contains("voice-live"),
        }));
        if (away.label !== "Voice on · Inbox (1) - ada.lovelace@ex…" || !away.go || !away.use || away.off || !away.mute || away.orb || away.live) fail(`bar on another tab ${JSON.stringify(away)}`);
        await checkLayout(p, `handsfree-elsewhere ${label}`);
        await shoot(p, "panel-handsfree-elsewhere", size, scheme);
        // Said while tab 2 is in front: it goes to tab 1's chat as said, with the note naming both tabs as its context
        // (the agent gets it; the chat shows the words alone).
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"), null, { timeout: 30_000 });
        const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
        const note = "The user is looking at another tab: Hacker News. You work in Inbox (1) - ada.lovelace@example.com - Gmail.";
        if (req.sessionId !== "s-voice" || req.tabId !== undefined || req.voice !== true || !/^Open Gmail/.test(req.text) || req.text.includes("looking at another tab") || req.context !== note)
          fail(`said on another tab, sent ${JSON.stringify(req)}`);
        if ((await p.inputValue("#now-text")) !== "") fail(`the box got "${await p.inputValue("#now-text")}" while the user looked at another tab`);
        // Go to tab asks for the session's tab (the stub then makes it the active tab); back there, the plain bar.
        await p.click("#voice-bar .vb-go");
        if (!(await p.evaluate(() => window.__requests.some((r) => r.type === "tab.focus" && r.tabId === 1)))) fail("Go to tab did not ask for tab 1");
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state !== "elsewhere");
        // Use voice here (on another tab) moves the session there, and says so.
        await look(2);
        await p.waitForSelector("#voice-bar[data-state=elsewhere]");
        await p.click("#voice-bar .vb-use");
        await p.waitForFunction(() => !document.querySelector("#voice-bar").hidden && document.getElementById("voice-bar").dataset.state !== "elsewhere");
        if ((await p.textContent("#now-notice .notice-text")) !== "Hands-free moved to this tab.") fail(`moved note "${await p.textContent("#now-notice")}"`);
        if ((await lastListening()).tabId !== 2) fail(`the move is not reported ${JSON.stringify(await lastListening())}`);
        await session({ tabId: 2, viewing: 2 });
        await checkLayout(p, `handsfree-moved ${label}`);
        // Closing another tab changes nothing; closing its tab ends it, with a note.
        await p.evaluate(() => window.__closeTab(1));
        if (await p.evaluate(() => document.querySelector("#voice-bar").hidden)) fail("closing another tab ended hands-free");
        await p.evaluate(() => window.__closeTab(2));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        if ((await p.textContent("#now-notice .notice-text")) !== "Hands-free stopped: its tab was closed.") fail(`tab closed note "${await p.textContent("#now-notice")}"`);
        if ((await lastListening()).listening !== false) fail("the end is not reported to the background");
        await session(null);
        // The voice key while the user looks at another tab ends it (it never moves it).
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        await look(4);
        await p.waitForSelector("#voice-bar[data-state=elsewhere]");
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "idle") fail("the voice key on another tab did not end hands-free");
        await session(null);

        // Another panel's session (another window's panel runs it, for tab 5): this panel shows where, with nothing live.
        await look(1);
        await session({ tabId: 5, panel: "another-window", viewing: 1 });
        await p.waitForFunction(() => document.querySelector("#voice-bar[data-state=elsewhere] .vb-label")?.textContent === "Voice on · Tab 5");
        const remote = await p.evaluate(() => ({
          detail: document.getElementById("voice-bar").title,
          meter: !!document.querySelector("#voice-bar .vb-meter").offsetParent,
          go: !!document.querySelector("#voice-bar .vb-go").offsetParent,
          use: !!document.querySelector("#voice-bar .vb-use").offsetParent,
          stop: !!document.querySelector("#voice-bar .vb-off").offsetParent,
          mic: document.querySelector("#now-actions .voice-mic").dataset.state,
          live: document.body.classList.contains("voice-live"),
          placeholder: document.getElementById("now-text").placeholder,
        }));
        if (remote.detail !== "Standard voice · Listening in another window" || remote.meter || !remote.go || !remote.use || !remote.stop || remote.mic !== "idle" || remote.live || /Listening/i.test(remote.placeholder))
          fail(`another tab's session ${JSON.stringify(remote)}`);
        await checkLayout(p, `handsfree-remote ${label}`);
        await shoot(p, "panel-handsfree-remote", size, scheme);
        const voiceStops = () => p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.voiceStop").length);
        await p.click("#voice-bar .vb-off");
        if ((await voiceStops()) !== 1) fail("Turn off did not ask the background to end it");
        // Use voice here: ends it there, and starts here only once it ended.
        await p.click("#voice-bar .vb-use");
        if ((await voiceStops()) !== 2) fail("Use voice here did not ask the background to end it");
        await p.waitForTimeout(200);
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "idle") fail("Use voice here started before the other session ended");
        await session(null);
        await waitPhase(p, "listening");
        const moved = await lastListening();
        // In the tab this panel shows (not tab 5), on the engine it ran on there.
        if (moved.listening !== true || typeof moved.tabId !== "number" || moved.tabId === 5 || moved.engine !== "standard") fail(`Use voice here reported ${JSON.stringify(moved)}`);
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        reportErrors(p, `handsfree-elsewhere ${label}`);
        await p.close();
      }

      // Realtime unavailable on the server: nothing starts (never Standard by itself); the notice says why and offers
      // Standard for this once.
      if (want("panel-handsfree-unavailable", size, scheme)) {
        const p = await openPanel(ctx, "account", undefined, { init: [installVoiceFakes, () => (window.__rtMode = "unavailable")] });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForSelector("#now-notice:not([hidden])");
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden, null, { timeout: 5000 }).catch(() => fail("voice went on without Realtime"));
        const note = await p.evaluate(() => ({
          text: document.querySelector("#now-notice .notice-text")?.textContent,
          level: document.getElementById("now-notice").dataset.level,
          actions: [...document.querySelectorAll("#now-notice .notice-action")].map((b) => b.textContent),
          transcribed: window.__requests.some((r) => r.type === "voice.transcribe"),
          saved: window.__requests.some((r) => r.type === "settings.save" && "voiceEngine" in r.settings),
        }));
        if (note.text !== "Realtime voice is unavailable on the server right now." || note.level !== "error" || JSON.stringify(note.actions) !== JSON.stringify(["Use Standard voice"]) || note.transcribed || note.saved)
          fail(`unavailable note ${JSON.stringify(note)}`);
        await checkLayout(p, `handsfree-unavailable ${label}`);
        await shoot(p, "panel-handsfree-unavailable", size, scheme);
        // The user's choice: Standard, this once (Settings unchanged).
        await p.click("#now-notice .notice-action");
        await waitPhase(p, "listening");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && "voiceEngine" in r.settings))) fail("Use Standard voice changed Settings");
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        reportErrors(p, `handsfree-unavailable ${label}`);
        await p.close();
      }

      // The Realtime connection drops mid-session: the strip says "Reconnecting…" while a new one is made, taking the
      // place of the old one on the server (takeover); the chat and the session go on.
      if (want("panel-handsfree-reconnecting", size, scheme)) {
        const p = await openPanel(ctx, "account", undefined, { init: [installVoiceFakes] });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        // The next connection opens but is not ready yet (so the strip can be seen), then the relay drops this one.
        await p.evaluate(() => {
          window.__rtMode = "hold";
          window.__rt.drop(1011);
        });
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state === "reconnecting", null, { timeout: 5000 }).catch(() => fail("no Reconnecting… in the strip"));
        const rc = await p.evaluate(() => ({
          status: document.querySelector("#voice-bar .vb-status").textContent,
          url: window.__rt.url,
          notice: document.querySelector("#now-notice:not([hidden])")?.textContent ?? null,
          mic: document.querySelector("#now-actions .voice-mic").dataset.state,
        }));
        if (rc.status !== "Reconnecting…" || !/[?&]takeover=1/.test(rc.url) || rc.notice || rc.mic !== "handsfree") fail(`reconnecting ${JSON.stringify(rc)}`);
        const rl = await barCheck(p);
        if (rl.length) fail(`reconnecting: ${rl.join("; ")}`);
        await checkLayout(p, `handsfree-reconnecting ${label}`);
        await shoot(p, "panel-handsfree-reconnecting", size, scheme);
        // Ready: the session goes on.
        await p.evaluate(() => window.__rt.emit({ type: "session.created", event_id: "ev2", session: { type: "realtime", model: "gpt-realtime-2.1" } }));
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state !== "reconnecting", null, { timeout: 5000 }).catch(() => fail("still reconnecting once ready"));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        reportErrors(p, `handsfree-reconnecting ${label}`);
        await p.close();
      }
    },
  },
  // Hands-free muted (the composer's Mute, Alt+M): the strip in grey with "Muted", no meter; Mute pressed; the box
  // without the glow and "Listening…"; the mic still, in grey; the background told (the MUTE badge). Realtime stops
  // streaming the microphone (no input_audio_buffer.append: no input audio billed) and clears the server's buffer; the
  // narrator is told, and still speaks (Interrupt, Mute, the mic and Send in one row, narrow too). While the agent works
  // the hint says updates are still said. Alt+M unmutes: the stream starts again.
  {
    names: ["panel-handsfree-muted", "panel-handsfree-muted-speaking", "panel-handsfree-muted-working"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      const p = await openPanel(ctx, "account", undefined, { init: [installVoiceFakes] });
      const appends = () => p.evaluate(() => window.__rt?.sent.filter((e) => e.type === "input_audio_buffer.append").length ?? 0);
      await p.evaluate(() => window.__push({ type: "panel.voice" }));
      await p.waitForFunction(() => document.querySelector("#voice-bar:not([hidden])")?.dataset.phase === "listening", null, { timeout: 20_000 });
      // The fake microphone streams to the narrator.
      await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "input_audio_buffer.append"), null, { timeout: 10_000 });
      await p.click("#now-actions .voice-mute");
      const look = () =>
        p.evaluate(() => {
          const bar = document.getElementById("voice-bar");
          const mute = document.querySelector("#now-actions .voice-mute");
          const mic = document.querySelector("#now-actions .voice-mic");
          const row = document.querySelector(".now-bar").getBoundingClientRect();
          const out = [];
          const shown = [...document.querySelectorAll(".now-bar button")].filter((b) => b.offsetParent).map((b) => [b.className, b.getBoundingClientRect()]);
          for (const [name, x] of shown) if (x.left < row.left - 5 || x.right > row.right + 0.5) out.push(`${name} cut`);
          for (let i = 1; i < shown.length; i++) if (shown[i][1].left < shown[i - 1][1].right - 0.5) out.push(`${shown[i][0]} overlaps ${shown[i - 1][0]}`);
          if (bar.getBoundingClientRect().height > 30) out.push(`strip not one line (${Math.round(bar.getBoundingClientRect().height)})`);
          return {
            state: bar.dataset.state,
            muted: bar.dataset.muted ?? null,
            title: bar.querySelector(".vb-status").textContent,
            detail: bar.title,
            meter: !bar.querySelector(".vb-meter").hidden,
            pressed: mute.getAttribute("aria-pressed"),
            label: mute.getAttribute("aria-label"),
            text: mute.textContent,
            tooltip: mute.title,
            live: bar.querySelector("[aria-live=polite]").textContent,
            barBg: getComputedStyle(bar).backgroundColor,
            ring: getComputedStyle(bar.querySelector(".vb-dot")).animationName,
            placeholder: document.getElementById("now-text").placeholder,
            glow: document.body.classList.contains("voice-live"),
            micMuted: mic.dataset.muted ?? null,
            micRing: getComputedStyle(mic, "::before").animationName,
            orb: document.querySelector(".voice-orb").hidden ? null : { muted: document.querySelector(".voice-orb").dataset.muted ?? null, caption: document.querySelector(".voice-caption").textContent, halo: getComputedStyle(document.querySelector(".voice-orb-halo")).animationName },
            reported: window.__portSent.filter((x) => x.type === "panel.listening").at(-1),
            layout: out,
          };
        });
      const want = (ok, what, seen) => ok || fail(`muted ${label}: ${what} ${JSON.stringify(seen)}`);
      const muted = await look();
      want(muted.state === "muted" && muted.muted === "true" && muted.title === "Muted" && muted.live === "Voice on: Muted", "state", muted);
      want(muted.detail === "Realtime voice · Microphone off · Unmute to talk", "tooltip", muted);
      want(!muted.meter && muted.ring === "none", "meter or ring", muted);
      want(muted.pressed === "true" && muted.label === "Unmute the microphone · Alt+M" && muted.text === "Unmute" && muted.tooltip === muted.label, "Mute button", muted);
      want(!/200, 35, 63|196, 42, 68/.test(muted.barBg), "the bar is still red", muted);
      want(/muted/i.test(muted.placeholder) && !muted.glow, "box", muted);
      want(muted.micMuted === "true" && muted.micRing === "none", "mic button", muted);
      want(muted.orb?.muted === "true" && muted.orb.caption === "Microphone muted · Unmute to talk" && muted.orb.halo === "none", "orb", muted);
      want(muted.reported?.listening === true && muted.reported?.muted === true, "reported (badge)", muted);
      want(!muted.layout.length, "layout", muted);
      // Nothing more goes out, the server's buffer was cleared, and the narrator knows.
      const sentAtMute = await p.evaluate(() => window.__rt.sent.map((e) => e.type));
      const clearAt = sentAtMute.lastIndexOf("input_audio_buffer.clear");
      want(clearAt > sentAtMute.lastIndexOf("input_audio_buffer.append"), "buffer not cleared after the last audio", sentAtMute.slice(-5));
      const before = await appends();
      await p.waitForTimeout(1200);
      want((await appends()) === before, "audio streamed while muted", { before, after: await appends() });
      want(await p.evaluate(() => window.__rt.sent.some((e) => e.type === "conversation.item.create" && /muted their microphone/.test(e.item?.content?.[0]?.text ?? ""))), "narrator not told", null);
      await checkLayout(p, `handsfree-muted ${label}`);
      await shoot(p, "panel-handsfree-muted", size, scheme);

      // The narrator still speaks: Speaking, with Interrupt, Mute (still pressed), the mic and Send in one row.
      await p.evaluate(() => {
        // 3 s of audio, in two deltas (one big spread would overflow the call stack).
        const pcm = btoa(String.fromCharCode(...new Uint8Array(24_000 * 2 * 1.5)));
        window.__rt.emit({ type: "response.created", response: { id: "r1" } });
        window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Still here. Tell me when you're ready." });
        for (let i = 0; i < 2; i++) window.__rt.emit({ type: "response.output_audio.delta", item_id: "a1", response_id: "r1", delta: pcm });
      });
      await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state === "speaking", null, { timeout: 5000 });
      const speaking = await look();
      want(speaking.muted === "true" && speaking.pressed === "true" && /Esc or Interrupt stops it · microphone muted$/.test(speaking.detail), "speaking while muted", speaking);
      want(await p.evaluate(() => !document.querySelector("#now-actions .voice-interrupt").hidden), "no Interrupt in the composer", speaking);
      want(!speaking.layout.length, "speaking layout", speaking);
      await checkLayout(p, `handsfree-muted-speaking ${label}`);
      await shoot(p, "panel-handsfree-muted-speaking", size, scheme);
      await p.click("#now-actions .voice-interrupt");
      await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state === "muted", null, { timeout: 5000 });

      // A task runs: the hint says its updates are still said.
      await p.evaluate(() => {
        const s = { sessionId: "s-new", source: "adhoc", title: "Read my email", instructions: "Read my email", brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: new Date().toISOString() };
        const st = window.__data.state;
        window.__push({ type: "state", state: { ...st, running: s, runningSessions: [s], tabChats: { 1: s.sessionId }, runningTabs: { [s.sessionId]: [1] } } });
      });
      await p.waitForFunction(() => document.getElementById("voice-bar").dataset.phase === "working", null, { timeout: 5000 });
      const working = await look();
      want(working.state === "muted" && /Agent working · updates are still said$/.test(working.detail), "working while muted", working);
      want(await p.evaluate(() => !document.getElementById("now-stop").hidden), "no task Stop while it works", working);
      await checkLayout(p, `handsfree-muted-working ${label}`);
      await shoot(p, "panel-handsfree-muted-working", size, scheme);

      // Alt+M unmutes: the strip is live again and the microphone streams.
      await p.keyboard.press("Alt+KeyM");
      const unmuted = await look();
      want(unmuted.muted === null && unmuted.pressed === "false" && unmuted.state !== "muted" && unmuted.reported?.muted === undefined, "Alt+M did not unmute", unmuted);
      const at = await appends();
      await p.waitForFunction((n) => window.__rt.sent.filter((e) => e.type === "input_audio_buffer.append").length > n, at, { timeout: 5000 }).catch(() => fail(`unmuted ${label}: no audio streamed`));
      await p.evaluate(() => window.__push({ type: "panel.voice" }));
      await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
      reportErrors(p, `handsfree-muted ${label}`);
      await p.close();
    },
  },
  // Voice in the chat: messages the user spoke carry a mic; what was said aloud is part of the thread, quieter than the
  // answer (the one that repeats the text above it compact), and stays when the chat is opened again.
  {
    names: ["panel-voice-chat"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "voice-chat", "#chat-log .ev-end");
      const got = await p.evaluate(() => ({
        first: document.querySelector("#chat-log .ev-first")?.classList.contains("voice") && !!document.querySelector("#chat-log .ev-first .ev-voice"),
        users: [...document.querySelectorAll("#chat-log .ev-user:not(.ev-first)")].map((e) => [e.classList.contains("voice"), e.textContent]),
        spoken: [...document.querySelectorAll("#chat-log .ev-spoken")].map((e) => [e.classList.contains("echo"), e.textContent]),
        order: [...document.querySelectorAll("#chat-log > *")].map((e) => e.className.split(" ")[0]).join(" "),
      }));
      if (!got.first) fail("voice chat: the first message has no mic");
      if (JSON.stringify(got.users) !== JSON.stringify([[true, "Tell her yes and archive it"], [false, "sign it Ada"]])) fail(`voice chat: user messages ${JSON.stringify(got.users)}`);
      const want = [
        [true, "I'll open Gmail and read your newest email."],
        [false, "Sarah says Friday's dinner moved to eight. She wants a yes by Thursday."],
        [false, "Done: I said yes and archived it. Anything else?"],
      ];
      if (JSON.stringify(got.spoken) !== JSON.stringify(want)) fail(`voice chat: spoken lines ${JSON.stringify(got.spoken)}`);
      if (!/^ev-opening ev-head ev-text ev-spoken ev-steps ev-text ev-end ev-spoken ev-user ev-user ev-steps ev-end ev-spoken$/.test(got.order)) fail(`voice chat: order ${got.order}`);
      // Quieter than the answer: smaller type than the agent's text, and the compact one on one line.
      const style = await p.evaluate(() => {
        const px = (el) => parseFloat(getComputedStyle(el).fontSize);
        const echo = document.querySelector("#chat-log .ev-spoken.echo");
        return { spoken: px(document.querySelector("#chat-log .ev-spoken:not(.echo)")), text: px(document.querySelector("#chat-log .ev-text")), echoH: echo.getBoundingClientRect().height, echoLine: parseFloat(getComputedStyle(echo).lineHeight) };
      });
      if (!(style.spoken < style.text) || style.echoH > style.echoLine + 8) fail(`voice chat: styles ${JSON.stringify(style)}`);
      await checkLayout(p, `voice-chat ${label}`);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await shoot(p, "panel-voice-chat", size, scheme);
      reportErrors(p, `voice-chat ${label}`);
      await p.close();
    },
  },
  // Raw: a three-turn voice conversation (Standard, then Realtime) with its timings, in place of the log.
  {
    names: ["panel-raw", "panel-raw-turn", "panel-raw-realtime"],
    async run({ ctx, size, scheme, label, fail, openPanel, menuItems, pick, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "raw", "#chat-log .ev-end");
      if (!(await menuItems(p)).includes("Raw")) fail("raw: no Raw in the job's menu");
      await pick(p, "Raw");
      await p.waitForSelector("#chat-raw .raw-turn");
      const got = await p.evaluate(() => {
        const raw = document.getElementById("chat-raw");
        const body = raw.querySelector(".raw-body");
        const b = body.getBoundingClientRect();
        return {
          logHidden: document.getElementById("chat-log").hidden,
          rawShown: !raw.hidden && raw.getBoundingClientRect().height > 200,
          tiles: [...raw.querySelectorAll(".raw-stat-label")].map((e) => e.textContent),
          tileTitles: [...raw.querySelectorAll(".raw-stat")].every((e) => e.title),
          slowest: raw.querySelectorAll(".raw-slowest li").length,
          turns: [...raw.querySelectorAll(".raw-turn-title")].map((e) => e.textContent),
          rels: [...raw.querySelectorAll(".raw-rel")].map((e) => e.textContent),
          slow: raw.querySelectorAll(".raw-row.slow").length,
          errors: raw.querySelectorAll(".raw-row.error").length,
          labels: [...raw.querySelectorAll(".raw-label")].map((e) => e.textContent),
          wide: [...raw.querySelectorAll(".raw-row, .raw-stat, .raw-summary")].filter((e) => e.getBoundingClientRect().right > b.right + 0.5).length,
          scrollsX: body.scrollWidth > body.clientWidth + 1,
          text: raw.textContent,
        };
      });
      if (!got.logHidden || !got.rawShown) fail(`raw: not shown in place of the log ${JSON.stringify({ logHidden: got.logHidden, rawShown: got.rawShown })}`);
      if (!(await menuItems(p)).includes("Close raw")) fail("raw: the menu does not offer Close raw while it is open");
      // The Realtime narrator's own tile follows speech to agent (trace-report.ts, "Narrator").
      const tiles = ["Total", "First response", "Speech → agent", "Narrator", "Model", "Tools", "Voice", "Other", "Tokens"];
      if (JSON.stringify(got.tiles) !== JSON.stringify(tiles)) fail(`raw: summary tiles ${JSON.stringify(got.tiles)}`);
      if (!got.tileTitles) fail("raw: a summary tile without its explanation");
      if (got.slowest !== 5) fail(`raw: ${got.slowest} slowest items`);
      if (got.turns.length !== 3 || !/^Turn 1 · .* · done · first response/.test(got.turns[0]) || !/paused/.test(got.turns[2])) fail(`raw: turns ${JSON.stringify(got.turns)}`);
      if (!got.rels.length || got.rels.some((r) => !/^[+-]\d+\.\d\d s$/.test(r))) fail(`raw: relative times ${got.rels.slice(0, 5)}`);
      if (got.slow < 3) fail(`raw: only ${got.slow} slow rows`);
      if (got.errors < 1) fail("raw: the failed screenshot is not marked");
      for (const want of [
        "Voice: end of speech → transcript",
        "Voice: sending window",
        "Voice: Realtime connected",
        "Voice: narrator reply (to speech)",
        "Voice: your words transcribed",
        "Claude Code process ready",
        "Model call",
        "act step 1 · Jev type 0.97",
        "Browser navigate",
        "Voice: barge-in (cut the line off)",
        "Voice: line said",
      ]) {
        if (!got.labels.includes(want)) fail(`raw: no "${want}" row`);
      }
      if (got.wide || got.scrollsX) fail(`raw: ${got.wide} items wider than the view, scrolls sideways: ${got.scrollsX}`);
      if (got.text.includes(RAW_SECRET)) fail("raw: a secret is shown");
      await checkLayout(p, `raw ${label}`);
      await shoot(p, "panel-raw", size, scheme);

      // Copy: the timeline as text (the page's clipboard, stubbed: the system clipboard is left alone in tests).
      await p.evaluate(() => {
        window.__copied = null;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => void (window.__copied = t) } });
      });
      await p.click(".raw-copy");
      const copied = await (await p.waitForFunction(() => window.__copied)).jsonValue();
      if (!/^Noa trace · /.test(copied) || !copied.includes("SUMMARY") || !copied.includes("TURN 3") || copied.includes(RAW_SECRET)) fail(`raw: copied text ${copied.slice(0, 200)}`);
      if (!(await p.textContent(".raw-copy")).includes("Copied")) fail("raw: Copy does not say it copied");

      // Download .json: a valid, redacted export with the environment.
      const [download] = await Promise.all([p.waitForEvent("download"), p.click(".raw-save")]);
      const name = download.suggestedFilename();
      if (!/^noa-trace-s-raw-\d{8}-\d{4}\.json$/.test(name)) fail(`raw: download name ${name}`);
      const json = await readFile(await download.path(), "utf8");
      let doc = null;
      try {
        doc = JSON.parse(json);
      } catch (err) {
        fail(`raw: download is not JSON (${err})`);
      }
      if (doc) {
        if (doc.format !== "noa.trace" || doc.turns?.length !== 3) fail(`raw: export ${doc.format} with ${doc.turns?.length} turns`);
        if (!doc.env?.extensionVersion || !doc.env?.helper?.version || !doc.env?.voice?.engine || !doc.env?.os) fail(`raw: export env ${JSON.stringify(doc.env)}`);
        if (json.includes(RAW_SECRET)) fail("raw: the export carries a secret");
        if (!doc.summary?.slowest?.length || !doc.summary?.tokens?.in) fail("raw: export summary incomplete");
      }

      // The turns below: each title stays on top while its rows scroll under it.
      await p.evaluate(() => document.querySelector('#chat-raw .raw-turn[data-turn="2"]').scrollIntoView());
      await shoot(p, "panel-raw-turn", size, scheme);
      await p.evaluate(() => document.querySelector('#chat-raw .raw-turn[data-turn="3"]').scrollIntoView());
      await shoot(p, "panel-raw-realtime", size, scheme);

      // Back to chat: the log again.
      await p.click(".raw-back");
      const back = await p.evaluate(() => ({ log: !document.getElementById("chat-log").hidden, raw: document.getElementById("chat-raw").hidden }));
      if (!back.log || !back.raw) fail(`raw: back to chat ${JSON.stringify(back)}`);
      // The menu says Raw again (it said Close raw while it was open).
      if (!(await menuItems(p)).includes("Raw")) fail("raw: the menu still says Close raw");
      await checkLayout(p, `raw back ${label}`);
      reportErrors(p, `raw ${label}`);
      await p.close();
    },
  },
  // The microphone permission page (opened in a tab): asking, allowed, blocked.
  {
    names: ["mic-page-asking", "mic-page-granted", "mic-page-denied"],
    async run({ ctx, size, scheme, fail, want, shoot, base }) {
      for (const [name, setup] of [
        ["mic-page-asking", () => (navigator.mediaDevices.getUserMedia = () => new Promise(() => {}))],
        ["mic-page-granted", () => {}],
        ["mic-page-denied", () => (navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")))],
      ]) {
        if (!want(name, size, scheme)) continue;
        const p = await ctx.newPage();
        const errors = [];
        p.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
        await p.addInitScript(setup);
        await p.addInitScript(() => {
          const query = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (d) => (d.name === "microphone" ? Promise.resolve({ state: "prompt" }) : query(d));
          window.chrome = { tabs: { getCurrent: async () => ({ id: 5 }), remove: async () => {} } };
        });
        await p.goto(`${base}/mic-permission.html`);
        const expected = name.replace("mic-page-", "");
        await p.waitForFunction((st) => document.body.dataset.state === st, expected);
        if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${name}: horizontal scroll`);
        if (errors.length) fail(`${name}: ${errors.join("; ")}`);
        await shoot(p, name, size, scheme);
        await p.close();
      }
    },
  },
];
