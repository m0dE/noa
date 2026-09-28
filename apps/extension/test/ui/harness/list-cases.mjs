// The jobs list with chat titles (jobs.ts, job-list.ts) and a job renamed from its page (job-page.ts): the UI harness
// cases, run like PANEL_CASES at each panel size and scheme.

export const LIST_CASES = [
  // Chats titled by the title model, a chat running in another tab, a TODO task with its run, as one list; each row
  // names itself for screen readers; the running one's page says where it runs (and is not bound here); a finished
  // chat opens bound to this tab and the box goes on with it.
  {
    names: ["panel-list-titles", "panel-list-titles-opened"],
    async run({ ctx, size, scheme, label, fail, groups, openPanel, openJob, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent");
      const g = await groups(p);
      const want = [
        ["Needs you", ["task:t5", "chat:s-r3"]],
        ["Running", ["chat:s-r1", "task:t2"]],
        ["Upcoming", ["task:t3", "task:t4", "task:t1"]],
      ];
      if (JSON.stringify(g.slice(0, 3)) !== JSON.stringify(want)) fail(`titles: groups ${JSON.stringify(g)}`);
      const recent = g.find(([name]) => name === "Recent")?.[1] ?? [];
      // Newest first; the TODO run is its task's job (t6), shown once.
      if (recent.slice(0, 4).join() !== "chat:s-r2,task:t6,task:t7,chat:s-r4" || recent.filter((k) => k === "task:t6").length !== 1) fail(`titles: Recent ${JSON.stringify(recent)}`);
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll(".job-row")].map((b) => ({
          key: b.dataset.key,
          title: b.querySelector(".job-title").textContent,
          meta: b.querySelector(".job-meta")?.textContent ?? "",
          when: b.querySelector(".job-when").textContent,
          aria: b.getAttribute("aria-label"),
        })),
      );
      const row = (key) => rows.find((r) => r.key === key);
      if (row("chat:s-r1")?.title !== "Schedule 3x daily X posts" || row("chat:s-r1")?.when !== "now") fail(`titles: running row ${JSON.stringify(row("chat:s-r1"))}`);
      const web = row("chat:s-r2");
      if (web?.title !== "Check Chrome Web Store emails" || web.when !== "12 min ago" || web.meta !== "mail.google.com" || web.aria !== "Check Chrome Web Store emails, Done, 12 min ago, mail.google.com") fail(`titles: row ${JSON.stringify(web)}`);
      if (row("chat:s-r3")?.meta !== "Needs you to pick dates") fail(`titles: needs-you row ${JSON.stringify(row("chat:s-r3"))}`);
      await checkLayout(p, `titles ${label}`);
      await shoot(p, "panel-list-titles", size, scheme);

      // A finished chat, by keyboard: bound to this tab; a message goes on with it.
      await p.focus('.job-row[data-key="chat:s-r2"]');
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector("#chat-log")?.textContent.includes("Two new emails"));
      const bind = await p.evaluate(() => window.__requests.find((r) => r.type === "chat.bind"));
      if (bind?.sessionId !== "s-r2" || bind.tabId !== 1) fail(`titles: opened with ${JSON.stringify(bind)}`);
      if ((await p.textContent("#job-title")) !== "Check Chrome Web Store emails") fail(`titles: page title "${await p.textContent("#job-title")}"`);
      await checkLayout(p, `titles opened ${label}`);
      await shoot(p, "panel-list-titles-opened", size, scheme);
      await p.click("#now-text");
      await p.keyboard.insertText("Reply to the review team and thank them");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message" && r.text?.startsWith("Reply to the review team")));
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message" && r.text?.startsWith("Reply to the review team")));
      if (sent.sessionId !== "s-r2") fail(`titles: the message went to ${sent.sessionId ?? "a new job"}`);
      await backToList(p);

      // The running chat of tab 2: its page offers its tab (View goes there), nothing is bound here.
      await openJob(p, "chat:s-r1");
      await p.waitForSelector("#job-agent-tab:not([hidden])");
      await p.click("#job-agent-tab button");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tab.focus"));
      if ((await p.evaluate(() => window.__requests.find((r) => r.type === "tab.focus").tabId)) !== 2) fail("titles: View did not go to tab 2");
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "chat.bind" && r.sessionId === "s-r1"))) fail("titles: a chat running in tab 2 was bound here");
      reportErrors(p, `titles ${label}`);
      await p.close();
    },
  },
  // Rename from the job's "⋯": the title becomes a box (Escape keeps the name, Enter saves); the list shows the new
  // name. A TODO task's job has no Rename (it is named by its task).
  {
    names: ["panel-job-rename"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, menuItems, pick, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent");
      await openJob(p, "task:t6");
      if ((await menuItems(p)).includes("Rename")) fail("rename: a TODO task's job offers Rename");
      await backToList(p);
      await openJob(p, "chat:s-r2");
      // Escape keeps the title.
      await pick(p, "Rename");
      await p.waitForSelector("input.job-rename");
      await p.keyboard.insertText("Nope");
      await p.keyboard.press("Escape");
      const kept = await p.evaluate(() => ({ title: document.getElementById("job-title").textContent, box: !!document.querySelector("input.job-rename"), focus: document.activeElement?.id }));
      if (kept.title !== "Check Chrome Web Store emails" || kept.box || kept.focus !== "job-title") fail(`rename: Escape left ${JSON.stringify(kept)}`);
      // Enter saves.
      await pick(p, "Rename");
      await p.waitForSelector("input.job-rename");
      await p.keyboard.press("Control+A");
      await p.keyboard.insertText("Web Store review emails");
      await checkLayout(p, `rename ${label}`);
      await shoot(p, "panel-job-rename", size, scheme);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.getElementById("job-title")?.textContent === "Web Store review emails");
      const req = await p.evaluate(() => window.__requests.filter((r) => r.type === "session.rename"));
      if (req.length !== 1 || req[0].sessionId !== "s-r2" || req[0].title !== "Web Store review emails") fail(`rename: requests ${JSON.stringify(req)}`);
      await backToList(p);
      const title = await p.textContent('.job-row[data-key="chat:s-r2"] .job-title');
      if (title !== "Web Store review emails") fail(`rename: the list says "${title}"`);
      reportErrors(p, `rename ${label}`);
      await p.close();
    },
  },
  // A repeating task that ran three times is one job: its page says how its runs went (each count opens the list
  // filtered), its instructions (Edit, Edit schedule), "Earlier runs (2)" closed, then the latest run's conversation.
  // Open, the list has the runs by day, newest first; one picked shows its conversation in the page's place ("‹ Runs"
  // and Escape go back, on its row). Delete asks first, then deletes the task's rows and runs.
  {
    names: ["panel-job-series", "panel-job-series-open", "panel-job-series-run", "panel-job-delete"],
    async run({ ctx, size, scheme, label, fail, groups, expectMenu, pick, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "series");
      const g = await groups(p);
      if (JSON.stringify(g) !== JSON.stringify([["Upcoming", ["task:tip1"]], ["Recent", ["task:t9"]]])) fail(`series: list ${JSON.stringify(g)}`);
      const meta = await p.textContent('.job-row[data-key="task:tip1"] .job-meta');
      if (meta !== "Daily at 9:00 AM") fail(`series: row meta "${meta}"`);
      await openJob(p, "task:tip1");
      await p.waitForSelector("#chat-log .job-runs-toggle");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tasks.series" && r.seriesId === "tip1"));
      const page = await p.evaluate(() => ({
        sub: document.getElementById("job-sub").textContent,
        stats: document.querySelector("#chat-log .job-stats").textContent,
        toggle: [document.querySelector("#chat-log .job-runs-toggle").textContent, document.querySelector("#chat-log .job-runs-toggle").getAttribute("aria-expanded")],
        rows: document.querySelectorAll("#chat-log .run-row").length,
        instr: document.querySelector("#chat-log .job-instr-text")?.textContent,
        edit: [...document.querySelectorAll("#chat-log .job-instr-actions button")].map((b) => b.textContent),
        latest: document.querySelector("#chat-log .job-runs-head.latest")?.textContent,
        opening: document.querySelector("#chat-log > .ev-opening .ev-user-text")?.textContent,
        end: document.querySelector("#chat-log > .ev-end .ev-summary")?.textContent,
      }));
      // The next run is the next 9:00 (in words inside the line: "next tomorrow 9:00 AM").
      if (!/^Daily at 9:00 AM · next (today|tomorrow) 9:00 AM$/.test(page.sub)) fail(`series: subtitle "${page.sub}"`);
      if (page.stats !== "3 runs · 2 done · 1 failed" || JSON.stringify(page.toggle) !== JSON.stringify(["Earlier runs (2)›", "false"]) || page.rows !== 0) fail(`series: closed runs ${JSON.stringify(page)}`);
      if (!page.instr?.startsWith("Post a short tip") || page.edit.join() !== "Edit schedule,Edit") fail(`series: instructions ${JSON.stringify(page)}`);
      if (!page.latest?.startsWith("Latest run · ") || !page.opening?.startsWith("Post a short tip") || page.end !== "Posted: Ctrl+. opens Noa from any tab") fail(`series: latest run ${JSON.stringify(page)}`);
      await expectMenu(p, ["Run now", "Pause", "Edit schedule", "Raw", "Delete"], "series");
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await checkLayout(p, `series ${label}`);
      await shoot(p, "panel-job-series", size, scheme);

      // "1 failed" opens the list on the failed runs; All shows both, newest first, under their days.
      await p.click('#chat-log .job-stats button[data-filter="failed"]');
      await p.waitForSelector('#chat-log .run-filter[data-filter="failed"][aria-pressed="true"]');
      const failedOnly = await p.evaluate(() => ({ keys: [...document.querySelectorAll("#chat-log .run-row")].map((r) => r.dataset.key), focus: document.activeElement?.dataset.filter }));
      if (failedOnly.keys.join() !== "r-tip2" || failedOnly.focus !== "failed") fail(`series: failed filter ${JSON.stringify(failedOnly)}`);
      await p.click('#chat-log .run-filter[data-filter="all"]');
      const open = await p.evaluate(() => ({
        expanded: document.querySelector("#chat-log .job-runs-toggle").getAttribute("aria-expanded"),
        days: [...document.querySelectorAll("#chat-log .run-day-head")].map((d) => d.textContent),
        rows: [...document.querySelectorAll("#chat-log .run-row")].map((r) => [r.dataset.key, r.querySelector(".run-line").textContent, r.getAttribute("aria-label")]),
      }));
      // Each run on its own day ("Yesterday", or its date when that was longer ago).
      if (open.expanded !== "true" || open.days.length !== 2 || !open.days[0] || open.days[0] === open.days[1]) fail(`series: days ${JSON.stringify(open)}`);
      if (JSON.stringify(open.rows.map(([k, l]) => [k, l])) !== JSON.stringify([["r-tip2", "X asked to confirm the login"], ["r-tip1", "Posted: Ctrl+, talks to it"]]) || !/^\S.* \d+:\d\d [AP]M, Failed, X asked to confirm the login$/.test(open.rows[0][2])) fail(`series: rows ${JSON.stringify(open.rows)}`);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await checkLayout(p, `series open ${label}`);
      await shoot(p, "panel-job-series-open", size, scheme);

      // The failed run: its conversation in the page's place, loaded then; Escape goes back to its row.
      await p.click('#chat-log .run-row[data-key="r-tip2"]');
      await p.waitForSelector("#chat-log .job-run-bar");
      await p.waitForFunction(() => document.querySelector("#chat-log")?.textContent.includes("X asked to confirm the login") && document.querySelector("#chat-log > .ev-end"));
      const run = await p.evaluate(() => ({
        bar: document.querySelector("#chat-log .job-run-bar").textContent,
        focus: document.activeElement?.classList.contains("job-run-back"),
        runs: !!document.querySelector("#chat-log .job-runs, #chat-log .job-instr"),
        loads: window.__requests.filter((r) => r.type === "sessions.events").map((r) => r.sessionId),
      }));
      if (!/Runs.*Failed$/.test(run.bar) || !run.focus || run.runs || !run.loads.includes("r-tip2")) fail(`series: a run picked ${JSON.stringify(run)}`);
      await checkLayout(p, `series run ${label}`);
      await shoot(p, "panel-job-series-run", size, scheme);
      await p.keyboard.press("Escape");
      await p.waitForSelector("#chat-log .job-runs-panel");
      const back = await p.evaluate(() => ({ key: document.activeElement?.dataset.key, list: !document.getElementById("view-job").hidden, end: document.querySelector("#chat-log > .ev-end .ev-summary")?.textContent }));
      if (back.key !== "r-tip2" || !back.list || back.end !== "Posted: Ctrl+. opens Noa from any tab") fail(`series: back from a run ${JSON.stringify(back)}`);

      // Delete: asked first in the menu (Keep goes back), then every row and run of it goes, and the list shows again.
      await pick(p, "Delete");
      await p.waitForSelector("#job-menu-pop .menu-note");
      await shoot(p, "panel-job-delete", size, scheme);
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "tasks.delete" || r.type === "session.delete"))) fail("series: Delete deleted before it was confirmed");
      await p.click('#job-menu-pop [data-action="delete-confirm"]');
      await p.waitForSelector("#view-list:not([hidden])");
      const gone = await p.evaluate(() => ({ tasks: window.__requests.filter((r) => r.type === "tasks.delete").map((r) => r.id), runs: window.__requests.filter((r) => r.type === "session.delete").map((r) => r.sessionId) }));
      if (gone.tasks.sort().join() !== "tip1,tip2,tip3" || gone.runs.sort().join() !== "r-tip1,r-tip2,r-tip3") fail(`series: deleted ${JSON.stringify(gone)}`);
      reportErrors(p, `series ${label}`);
      await p.close();
    },
  },
  // The same job after 300 runs (the account's; this browser keeps the last three conversations): the page opens
  // with the counts known so far, the list shows 50 runs at a time (never all), 7 failed in a row for one reason are
  // one row that opens to them, filters, Show more (older rows from tasks.series as needed), and a run known only by
  // its task row says what it did.
  {
    names: ["panel-job-series-long", "panel-job-series-long-fold", "panel-job-series-long-failed", "panel-job-series-row-run"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "series-long");
      await openJob(p, "task:tip1");
      await p.waitForFunction(() => /\+ runs/.test(document.querySelector("#chat-log .job-stats")?.textContent ?? ""));
      const closed = await p.evaluate(() => ({
        stats: document.querySelector("#chat-log .job-stats").textContent,
        toggle: document.querySelector("#chat-log .job-runs-toggle").textContent,
        cut: document.querySelector("#chat-log .job-instr-text").dataset.cut,
        more: document.querySelector("#chat-log .job-instr-more")?.textContent,
        series: window.__requests.filter((r) => r.type === "tasks.series").map((r) => r.cursor ?? null),
      }));
      // The list's 100 rows and the first page of the series (200): 200 runs known, more to come.
      if (!/^200\+ runs · \d+ done · \d+ failed$/.test(closed.stats) || closed.toggle !== "Earlier runs (199+)›" || JSON.stringify(closed.series) !== "[null]") fail(`long: closed ${JSON.stringify(closed)}`);
      if (closed.cut !== "true" || closed.more !== "Show all") fail(`long: instructions not cut ${JSON.stringify(closed)}`);
      await p.click("#chat-log .job-instr-more");
      if ((await p.getAttribute("#chat-log .job-instr-text", "data-cut")) !== "false" || (await p.getAttribute("#chat-log .job-instr-more", "aria-expanded")) !== "true") fail("long: Show all did not show the instructions");
      await p.click("#chat-log .job-instr-more");
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await checkLayout(p, `long ${label}`);
      await shoot(p, "panel-job-series-long", size, scheme);

      // Open: fast, and only the first page is in the page.
      const ms = await p.evaluate(() => {
        const t0 = performance.now();
        document.querySelector("#chat-log .job-runs-toggle").click();
        return performance.now() - t0;
      });
      const page = await p.evaluate(() => ({
        runs: document.querySelectorAll("#chat-log .run-row[data-key]").length,
        folds: [...document.querySelectorAll("#chat-log .run-fold-head")].map((f) => [f.querySelector(".run-count").textContent, f.querySelector(".run-line").textContent, f.getAttribute("aria-expanded")]),
        more: document.querySelector("#chat-log .run-more")?.textContent,
        stuck: getComputedStyle(document.querySelector("#chat-log .run-day-head")).position,
      }));
      if (ms > 250) fail(`long: opening the list took ${Math.round(ms)} ms`);
      if (page.runs !== 50 || page.more !== "Show more" || page.stuck !== "sticky") fail(`long: first page ${JSON.stringify(page)}`);
      if (JSON.stringify(page.folds) !== JSON.stringify([["7 runs", "I couldn't switch X to @getbnty: the account menu did not list it", "false"]])) fail(`long: folds ${JSON.stringify(page.folds)}`);
      // The fold opens to its 7 runs (by keyboard).
      await p.focus("#chat-log .run-fold-head");
      await p.keyboard.press("Enter");
      const fold = await p.evaluate(() => ({ expanded: document.querySelector("#chat-log .run-fold-head").getAttribute("aria-expanded"), shown: [...document.querySelectorAll("#chat-log .run-fold-list:not([hidden]) .run-row")].length }));
      if (fold.expanded !== "true" || fold.shown !== 7) fail(`long: fold ${JSON.stringify(fold)}`);
      await p.evaluate(() => document.querySelector("#chat-log .run-fold-head").scrollIntoView({ block: "center" }));
      await checkLayout(p, `long fold ${label}`);
      await shoot(p, "panel-job-series-long-fold", size, scheme);

      // Failed: only failed runs; Show more adds 50, loading older rows once the known ones run out.
      await p.click('#chat-log .run-filter[data-filter="failed"]');
      const failed = await p.evaluate(() => [...document.querySelectorAll("#chat-log .run-list > li > .run-row, #chat-log .run-fold-list .run-row")].every((r) => r.querySelector(".job-icon").dataset.state === "failed"));
      if (!failed) fail("long: Failed shows other runs");
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await checkLayout(p, `long failed ${label}`);
      await shoot(p, "panel-job-series-long-failed", size, scheme);
      await p.click('#chat-log .run-filter[data-filter="all"]');
      await p.click("#chat-log .run-more");
      await p.waitForFunction(() => document.querySelectorAll("#chat-log .run-row[data-key]").length === 100);
      for (let i = 0; i < 3; i++) {
        await p.click("#chat-log .run-more");
        await p.waitForFunction((n) => document.querySelectorAll("#chat-log .run-row[data-key]").length === n, 150 + 50 * i);
      }
      const all = await p.evaluate(() => ({ series: window.__requests.filter((r) => r.type === "tasks.series").map((r) => r.cursor ?? null), stats: document.querySelector("#chat-log .job-stats").textContent, toggle: document.querySelector("#chat-log .job-runs-toggle").textContent, more: document.querySelector("#chat-log .run-more")?.textContent ?? null }));
      if (all.series.length !== 2 || all.series[1] === null || !/^300 runs · /.test(all.stats) || all.toggle !== "Earlier runs (299)›" || all.more !== "Show 49 more") fail(`long: after Show more ${JSON.stringify(all)}`);

      // A run known only by its task row: what it did, and where.
      await p.click('#chat-log .run-row[data-key="task:h40"]');
      await p.waitForSelector("#chat-log .job-run-gone");
      const gone = await p.evaluate(() => ({ said: document.querySelector("#chat-log .job-run-said")?.textContent, url: document.querySelector("#chat-log .job-run-url")?.getAttribute("href"), note: document.querySelector("#chat-log .job-run-note")?.textContent }));
      if (!gone.said?.startsWith("Posted: ") || !gone.url?.startsWith("https://x.com/noa/status/") || !/isn't kept in this browser/.test(gone.note ?? "")) fail(`long: a run known by its row ${JSON.stringify(gone)}`);
      await checkLayout(p, `long row run ${label}`);
      await shoot(p, "panel-job-series-row-run", size, scheme);
      await p.click("#chat-log .job-run-back");
      await p.waitForFunction(() => document.activeElement?.dataset.key === "task:h40");
      reportErrors(p, `long ${label}`);
      await p.close();
    },
  },
  // The instructions of a scheduled job, edited in place: Edit opens a box (Escape cancels, nothing sent); an empty
  // text says why it cannot be saved; Ctrl+Enter saves the waiting row's instructions as the user's own, the page shows
  // them with "Saved"; Edit schedule opens the schedule sheet.
  {
    names: ["panel-job-instructions-edit", "panel-job-instructions-saved"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "series");
      await openJob(p, "task:tip1");
      await p.waitForSelector("#chat-log .job-instr-edit");
      await p.click("#chat-log .job-instr-edit");
      await p.waitForSelector("#chat-log textarea.job-instr-box");
      if (!(await p.evaluate(() => document.activeElement?.classList.contains("job-instr-box") && document.activeElement.value.startsWith("Post a short tip")))) fail("instructions: the box did not take the focus with the text");
      await p.keyboard.press("Escape");
      const cancelled = await p.evaluate(() => ({ box: !!document.querySelector("#chat-log textarea.job-instr-box"), focus: document.activeElement?.classList.contains("job-instr-edit"), page: !document.getElementById("view-job").hidden }));
      if (cancelled.box || !cancelled.focus || !cancelled.page) fail(`instructions: Escape ${JSON.stringify(cancelled)}`);
      await p.click("#chat-log .job-instr-edit");
      await p.fill("#chat-log textarea.job-instr-box", "   ");
      await p.click('#chat-log .job-instr-editor button:has-text("Save")');
      if ((await p.textContent("#chat-log .job-instr-msg")) !== "Write what the job should do.") fail("instructions: an empty text was not refused");
      const NEW = "Post a short tip about one keyboard shortcut on X from @noa.\nOne shortcut per post, never one posted in the last two weeks.";
      await p.fill("#chat-log textarea.job-instr-box", NEW);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await checkLayout(p, `instructions edit ${label}`);
      await shoot(p, "panel-job-instructions-edit", size, scheme);
      await p.keyboard.press("Control+Enter");
      await p.waitForFunction((t) => document.querySelector("#chat-log .job-instr-text")?.textContent === t, NEW);
      const saved = await p.evaluate(() => ({ req: window.__requests.filter((r) => r.type === "tasks.update"), msg: document.querySelector("#chat-log .job-instr-saved")?.textContent, focus: document.activeElement?.classList.contains("job-instr-edit") }));
      if (JSON.stringify(saved.req) !== JSON.stringify([{ type: "tasks.update", id: "tip3", patch: { instructions: NEW, agentAuthored: false } }]) || saved.msg !== "Saved. The next run uses them." || !saved.focus) fail(`instructions: saved ${JSON.stringify(saved)}`);
      await checkLayout(p, `instructions saved ${label}`);
      await shoot(p, "panel-job-instructions-saved", size, scheme);
      await p.click('#chat-log .job-instr-actions button:has-text("Edit schedule")');
      await p.waitForSelector("dialog.schedule-sheet[open]");
      reportErrors(p, `instructions ${label}`);
      await p.close();
    },
  },
  // A scheduled run that paused because nobody was there to approve its Post: its page shows the card alone (no
  // "Pausing:" line, no "needs you" end, no Jev lines: those are for Raw) with Allow & continue and Don't (Alt+Y,
  // Alt+N); its long instructions open the thread as a compact "Scheduled run" bubble (Show all). Alt+Y decides it.
  {
    names: ["panel-approval-paused", "panel-approval-paused-allowed"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "approval-paused");
      await openJob(p, "task:t-post");
      await p.waitForSelector('#chat-log .ev-approval[data-decidable="true"]');
      const page = await p.evaluate(() => {
        const card = document.querySelector("#chat-log .ev-approval");
        const text = document.querySelector("#chat-log > .ev-opening .ev-user-text");
        return {
          cards: document.querySelectorAll("#chat-log .ev-approval").length,
          head: card.querySelector(".appr-head").textContent,
          action: card.querySelector(".appr-action").textContent,
          buttons: [...card.querySelectorAll("button")].map((b) => [b.textContent, b.title]),
          note: card.querySelector(".appr-note")?.textContent,
          ends: document.querySelectorAll("#chat-log .ev-end").length,
          pausing: [...document.querySelectorAll("#chat-log .ev-status")].filter((s) => /Pausing:|element pick/.test(s.textContent)).length,
          jev: document.querySelectorAll("#chat-log .ev-jev").length,
          refusals: [...document.querySelectorAll("#chat-log > *")].filter((e) => !e.closest(".ev-approval") && /did not approve/.test(e.textContent)).length,
          cut: text?.dataset.cut,
          lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)),
          more: document.querySelector("#chat-log > .ev-opening .ev-more")?.textContent,
        };
      });
      if (page.cards !== 1 || page.head !== "Paused for your OK" || page.action !== 'Click "Post" as @noa on x.com · publishes') fail(`paused: card ${JSON.stringify(page)}`);
      if (JSON.stringify(page.buttons) !== JSON.stringify([["Allow & continue", "Allow & continue (Alt+Y)"], ["Don't", "Don't (Alt+N)"]]) || !page.note?.startsWith("The run stopped here")) fail(`paused: answers ${JSON.stringify(page)}`);
      if (page.ends || page.pausing || page.jev || page.refusals) fail(`paused: repeats the card ${JSON.stringify(page)}`);
      if (page.cut !== "true" || page.lines !== 1 || page.more !== "Show all") fail(`paused: the scheduled run's bubble ${JSON.stringify(page)}`);
      // Show all opens the instructions in place (not the details sheet).
      await p.click("#chat-log > .ev-opening .ev-more");
      const shown = await p.evaluate(() => ({ cut: document.querySelector("#chat-log > .ev-opening .ev-user-text").dataset.cut, sheet: !!document.querySelector("dialog[open]") }));
      if (shown.cut !== "false" || shown.sheet) fail(`paused: Show all ${JSON.stringify(shown)}`);
      await p.click("#chat-log > .ev-opening .ev-more");
      await checkLayout(p, `paused ${label}`);
      await shoot(p, "panel-approval-paused", size, scheme);
      // Alt+Y, from the message box: Allow & continue.
      await p.focus("#now-text");
      await p.keyboard.press("Alt+KeyY");
      await p.waitForSelector("#chat-log .ev-approval[data-state=allowed]");
      const sent = await p.evaluate(() => window.__requests.filter((r) => r.type === "approval.answer"));
      if (sent.length !== 1 || sent[0].sessionId !== "s-paused" || sent[0].id !== "ap-p" || sent[0].answer !== "allow_once") fail(`paused: Alt+Y sent ${JSON.stringify(sent)}`);
      const after = await p.evaluate(() => ({ head: document.querySelector("#chat-log .ev-approval .appr-head").textContent, buttons: document.querySelectorAll("#chat-log .ev-approval button").length }));
      if (after.head !== "Allowed once" || after.buttons) fail(`paused: after Allow ${JSON.stringify(after)}`);
      await checkLayout(p, `paused allowed ${label}`);
      await shoot(p, "panel-approval-paused-allowed", size, scheme);
      reportErrors(p, `paused ${label}`);
      await p.close();
    },
  },
  // Dismissing jobs (job-dismiss.ts): Dismiss all on Needs you, Undo; ✕ on a row (on hover) moves a need to Recent
  // as Dismissed with Undo above the box; Delete on a focused row does the same and the focus goes on; nothing is kept
  // until Undo's time is over or the panel goes away (then jobs.dismiss); a Recent row dismissed leaves the list, and
  // a search still finds it.
  {
    names: ["panel-list-dismiss-hover", "panel-list-dismiss-undo"],
    async run({ ctx, size, scheme, label, fail, groups, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent");
      const needs = async () => (await groups(p)).find(([g]) => g === "Needs you")?.[1] ?? [];
      const recent = async () => (await groups(p)).find(([g]) => g === "Recent")?.[1] ?? [];
      const sent = () => p.evaluate(() => window.__requests.filter((r) => r.type === "jobs.dismiss").map((r) => r.dismissals));
      if ((await needs()).join() !== "task:t5,chat:s-r3") fail(`dismiss: Needs you ${JSON.stringify(await needs())}`);

      // Dismiss all, then Undo: both back, nothing kept.
      await p.click("#job-groups .group-action");
      if ((await needs()).length) fail("dismiss: Dismiss all left rows under Needs you");
      await p.waitForSelector('#now-notice:not([hidden]) >> text=Dismissed 2 jobs');
      await p.click('#now-notice button:has-text("Undo")');
      await p.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="group-needs"] .job-row').length === 2);

      // ✕ on hover.
      await p.hover('.job-row[data-key="chat:s-r3"]');
      const x = await p.evaluate(() => {
        const b = document.querySelector('button.job-dismiss[data-key="chat:s-r3"]');
        return { opacity: getComputedStyle(b).opacity, label: b.getAttribute("aria-label"), key: document.querySelector('.job-row[data-key="chat:s-r3"]').getAttribute("aria-keyshortcuts") };
      });
      if (x.opacity !== "1" || x.label !== "Dismiss Find cheap flights to Lisbon" || x.key !== "Delete") fail(`dismiss: the row's ✕ ${JSON.stringify(x)}`);
      if (await p.evaluate(() => getComputedStyle(document.querySelector('button.job-dismiss[data-key="task:t5"]')).opacity) !== "0") fail("dismiss: ✕ shows on a row not hovered");
      if (await p.$('button.job-dismiss[data-key="task:t3"]')) fail("dismiss: an upcoming job has ✕");
      await checkLayout(p, `dismiss-hover ${label}`);
      await shoot(p, "panel-list-dismiss-hover", size, scheme);
      await p.click('button.job-dismiss[data-key="chat:s-r3"]');
      const moved = await p.evaluate(() => {
        const r = document.querySelector('.job-row[data-key="chat:s-r3"]');
        return { group: r.closest(".job-group").querySelector(".group-head").firstChild.textContent, state: r.dataset.state, meta: r.querySelector(".job-meta")?.textContent, notice: document.querySelector("#now-notice .notice-text")?.textContent };
      });
      if (JSON.stringify(moved) !== JSON.stringify({ group: "Recent", state: "dismissed", meta: "Needs you to pick dates", notice: "Dismissed “Find cheap flights to Lisbon”" })) fail(`dismiss: ✕ ${JSON.stringify(moved)}`);
      if ((await sent()).length) fail("dismiss: kept before Undo's time was over");
      await p.mouse.move(0, 0);
      await checkLayout(p, `dismiss-undo ${label}`);
      await shoot(p, "panel-list-dismiss-undo", size, scheme);

      // Delete on the focused row: the one before is kept now, the focus goes to the next row.
      await p.focus('.job-row[data-key="task:t5"]');
      await p.keyboard.press("Delete");
      const after = await p.evaluate(() => ({ focus: document.activeElement?.dataset?.key ?? null, needs: document.querySelector('section[aria-labelledby="group-needs"]') !== null }));
      if (after.needs || after.focus !== "chat:s-r1") fail(`dismiss: after Delete ${JSON.stringify(after)}`);
      const first = await sent();
      if (first.length !== 1 || !first[0]["chat:s-r3"]?.needs?.startsWith("run:s-r3:")) fail(`dismiss: kept ${JSON.stringify(first)}`);
      // The panel going away keeps what waits.
      await p.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await p.waitForFunction(() => window.__requests.filter((r) => r.type === "jobs.dismiss").length === 2);
      const second = (await sent())[1];
      if (!second["task:t5"]?.needs?.startsWith("task:t5:")) fail(`dismiss: Delete kept ${JSON.stringify(second)}`);

      // A Recent job dismissed leaves the list; a search finds it.
      await p.focus('.job-row[data-key="chat:s-r2"]');
      await p.keyboard.press("Backspace");
      if ((await recent()).includes("chat:s-r2")) fail("dismiss: a Recent job put away is still listed");
      await p.fill("#job-search", "chrome web store");
      await p.waitForFunction(() => !!document.querySelector('.job-row[data-key="chat:s-r2"]'));
      reportErrors(p, `dismiss ${label}`);
      await p.close();
    },
  },
  // The two views: Home (Needs you, Running, Upcoming cut to its soonest 3 with "All scheduled (N) →", Recent) and
  // Scheduled (every scheduled job, soonest first, paused last, each with Pause or Resume), switched by a segmented
  // control beside the search (a tablist: Left and Right); the search filters the view shown; the panel keeps the view.
  {
    names: ["panel-home", "panel-scheduled", "panel-scheduled-search"],
    async run({ ctx, size, scheme, label, fail, groups, openPanel, openJob, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "views");
      const bar = await p.evaluate(() => {
        const tabs = [...document.querySelectorAll("#job-views [role=tab]")];
        const search = document.getElementById("job-search").getBoundingClientRect();
        const seg = document.getElementById("job-views").getBoundingClientRect();
        return {
          role: document.getElementById("job-views").getAttribute("role"),
          tabs: tabs.map((t) => [t.textContent, t.getAttribute("aria-selected"), t.tabIndex]),
          panel: document.getElementById("job-groups").getAttribute("aria-labelledby"),
          searchWidth: Math.round(search.width),
          sameLine: Math.abs((search.top + search.bottom) / 2 - (seg.top + seg.bottom) / 2) <= 2,
        };
      });
      if (bar.role !== "tablist" || JSON.stringify(bar.tabs) !== JSON.stringify([["Home", "true", 0], ["Scheduled", "false", -1]]) || bar.panel !== "view-home") fail(`views: the switch ${JSON.stringify(bar)}`);
      if (!bar.sameLine || bar.searchWidth < (size.w <= 360 ? 150 : 250)) fail(`views: the bar ${JSON.stringify(bar)}`);

      // Home: every group; Upcoming its soonest 3 and the way to the rest; the job paused by the user is not here, the
      // one paused after failures needs the user.
      const home = await groups(p);
      const names = home.map(([n]) => n).join();
      const upcoming = home.find(([n]) => n === "Upcoming")?.[1] ?? [];
      const needs = home.find(([n]) => n === "Needs you")?.[1] ?? [];
      if (names !== "Needs you,Running,Upcoming,Recent" || upcoming.length !== 3 || !needs.includes("task:t11") || home.some(([, keys]) => keys.includes("task:t10"))) fail(`views: Home ${JSON.stringify(home)}`);
      const all = await p.evaluate(() => ({ text: document.querySelector(".all-scheduled")?.textContent, count: document.querySelector("#group-scheduled .count")?.textContent }));
      if (all.text !== "All scheduled (8) →" || all.count !== "5") fail(`views: Upcoming's way to the rest ${JSON.stringify(all)}`);
      await checkLayout(p, `home ${label}`);
      await shoot(p, "panel-home", size, scheme);

      // "All scheduled": the Scheduled view, its tab selected; soonest first, the paused ones last with Resume.
      await p.click(".all-scheduled");
      await p.waitForSelector('#view-scheduled[aria-selected="true"]');
      const sched = await groups(p);
      const next = sched.find(([n]) => n === "Next runs")?.[1] ?? [];
      if (JSON.stringify(sched.map(([n]) => n)) !== JSON.stringify(["Next runs", "Paused"]) || next.length !== 6 || next.includes("task:t2") || JSON.stringify(sched[1][1]) !== JSON.stringify(["task:t11", "task:t10"])) fail(`views: Scheduled ${JSON.stringify(sched)}`);
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll("#job-groups li")].map((li) => ({
          key: li.querySelector(".job-row").dataset.key,
          meta: li.querySelector(".job-meta")?.textContent ?? "",
          when: li.querySelector(".job-when").textContent,
          toggle: li.querySelector(".job-toggle")?.textContent ?? null,
          toggleName: li.querySelector(".job-toggle")?.getAttribute("aria-label") ?? null,
        })),
      );
      const row = (k) => rows.find((r) => r.key === k);
      if (row("task:t10")?.toggle !== "Resume" || row("task:t10")?.when !== "Paused" || row("task:t1")?.toggle !== "Pause" || !/^Daily at /.test(row("task:t1")?.meta ?? "") || row("task:t9")?.meta !== "Once" || row("task:t5")?.toggle !== null) fail(`views: Scheduled rows ${JSON.stringify(rows)}`);
      if (!/^Once · Paused after 3 failed runs/.test(row("task:t11")?.meta ?? "") && !/Paused after 3 failed runs/.test(row("task:t11")?.meta ?? "")) fail(`views: failing row ${JSON.stringify(row("task:t11"))}`);
      if (!row("task:t1")?.toggleName?.startsWith("Pause ")) fail(`views: toggle name ${JSON.stringify(row("task:t1"))}`);
      await checkLayout(p, `scheduled ${label}`);
      await shoot(p, "panel-scheduled", size, scheme);

      // Pause on a row: the job moves to the paused ones, with Resume.
      await p.click('li:has(.job-row[data-key="task:t1"]) .job-toggle');
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tasks.pause" && r.id === "t1"));
      await p.waitForFunction(() => document.querySelector('#group-paused')?.closest("section")?.querySelector('.job-row[data-key="task:t1"]'));
      if ((await p.textContent('li:has(.job-row[data-key="task:t1"]) .job-toggle')) !== "Resume") fail("views: a paused row offers no Resume");
      await p.click('li:has(.job-row[data-key="task:t1"]) .job-toggle');
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tasks.resume" && r.id === "t1"));

      // The keyboard: Left and Right move between the views, which show at once.
      await p.focus("#view-scheduled");
      await p.keyboard.press("ArrowLeft");
      const left = await p.evaluate(() => ({ focus: document.activeElement?.id, home: document.getElementById("view-home").getAttribute("aria-selected") }));
      await p.keyboard.press("ArrowRight");
      const right = await p.evaluate(() => ({ focus: document.activeElement?.id, sched: document.getElementById("view-scheduled").getAttribute("aria-selected") }));
      if (left.focus !== "view-home" || left.home !== "true" || right.focus !== "view-scheduled" || right.sched !== "true") fail(`views: arrows ${JSON.stringify({ left, right })}`);

      // The search filters the view shown.
      await p.fill("#job-search", "tip");
      const found = await groups(p);
      if (JSON.stringify(found) !== JSON.stringify([["Paused", ["task:t10"]]])) fail(`views: search "tip" in Scheduled ${JSON.stringify(found)}`);
      await checkLayout(p, `scheduled search ${label}`);
      await shoot(p, "panel-scheduled-search", size, scheme);
      await p.fill("#job-search", "");

      // The panel keeps the view: back from a job, and in its session storage.
      await openJob(p, "task:t9");
      await backToList(p);
      const kept = await p.evaluate(() => ({ sel: document.getElementById("view-scheduled").getAttribute("aria-selected"), stored: sessionStorage.getItem("noa.jobs.view") }));
      if (kept.sel !== "true" || kept.stored !== "scheduled") fail(`views: kept ${JSON.stringify(kept)}`);
      reportErrors(p, `views ${label}`);
      await p.close();
    },
  },
];
