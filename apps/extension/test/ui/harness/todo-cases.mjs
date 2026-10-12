// The Schedule sheet's cases of the UI harness (a job's "⋯" > Schedule / Edit schedule, schedule-sheet.ts) with its
// schedule section (packages/shared ui/schedule-fields.ts): One time | Repeat (radios; each shows only its own
// fields), once, daily at two times, weekly Mon/Wed/Fri, monthly on the first Monday, a custom cron, an end date, and
// editing repeating and one-time tasks (switching modes). Each is screenshotted (the sheet itself) at every panel size
// and scheme, and checks what the sheet sends.
import { join } from "node:path";

/** "YYYY-MM-DD" `days` from today, in this machine's zone (the browser's too). */
function dateIn(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The requests of `type` the page sent. */
const sent = (p, type) => p.evaluate((t) => window.__requests.filter((r) => r.type === t), type);

/** Nothing in the sheet reaches past it: no clipped control at this width. */
async function checkForm(p, fail, what) {
  const out = await p.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push("horizontal page scroll");
    const boxes = [...document.querySelectorAll("dialog.schedule-sheet[open] .sheet-body")];
    for (const box of boxes) {
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll("input, select, textarea, button, label, .sch-first")) {
        const r = el.getBoundingClientRect();
        if (!r.width || el.closest("[hidden]")) continue;
        if (r.right > b.right + 0.5 || r.left < b.left - 0.5) problems.push(`${el.id || el.className || el.tagName} clipped (${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(b.left)}-${Math.round(b.right)})`);
      }
    }
    // Every control has a name a screen reader says.
    for (const el of document.querySelectorAll("dialog.schedule-sheet input, dialog.schedule-sheet select, dialog.schedule-sheet textarea, dialog.schedule-sheet button")) {
      if (el.closest("[hidden]") || !el.getBoundingClientRect().width) continue;
      const named = el.getAttribute("aria-label") || el.labels?.length || el.getAttribute("aria-labelledby") || el.textContent.trim();
      if (!named) problems.push(`unnamed ${el.tagName.toLowerCase()} ${el.id || el.className}`);
    }
    return problems;
  });
  if (out.length) fail(`${what}: ${out.join("; ")}`);
}

/** The chat whose request the Schedule cases schedule (its first message: what a new task would do). */
const LISBON = "Find the cheapest flight to Lisbon next weekend";

/** The line under the rule: its first run, or what to fix. */
const firstRun = (p) => p.locator("#sched-first").textContent();

/** The chosen mode and what shows: One time shows only Scheduled at; Repeat only the rule. No summary line. */
async function checkMode(p, fail, mode, what) {
  const got = await p.evaluate(() => ({
    once: document.getElementById("sched-mode-once").checked,
    repeat: document.getElementById("sched-mode-repeat").checked,
    when: !!document.getElementById("sched-when").getBoundingClientRect().height,
    rule: !!document.getElementById("sched-rule").getBoundingClientRect().height,
    summary: document.querySelectorAll(".sch-summary").length,
  }));
  const want = mode === "once" ? { once: true, repeat: false, when: true, rule: false, summary: 0 } : { once: false, repeat: true, when: false, rule: true, summary: 0 };
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${what}: mode ${mode} shows ${JSON.stringify(got)}`);
}

export const TODO_CASES = [
  {
    names: [
      "panel-schedule-once",
      "panel-schedule-daily",
      "panel-schedule-weekly",
      "panel-schedule-monthly",
      "panel-schedule-custom",
      "panel-schedule-end",
      "panel-schedule-edit",
      "panel-schedule-edit-once",
    ],
    async run({ ctx, size, scheme, label, fail, want, openPanel, openJob, pick, shoot, checkLayout, reportErrors, shots, taken }) {
      const lisbon = (d) => (d.sessions.find((x) => x.sessionId === "s-3").instructions = LISBON);
      const p = await openPanel(ctx, "ok", undefined, { edit: lisbon });
      /** The whole sheet: a viewport tall enough to show all of it, for the shot only. */
      const shootForm = async (name) => {
        if (!want(name, size, scheme)) return;
        const sheet = p.locator("dialog.schedule-sheet[open]");
        await p.setViewportSize({ width: size.w, height: Math.max(size.h, 1400) });
        const file = join(shots, `${name}-${size.w}-${scheme}.png`);
        await sheet.screenshot({ path: file, animations: "disabled" });
        taken.push(file);
        await p.setViewportSize({ width: size.w, height: size.h });
      };
      /** Opens the Schedule sheet of the Lisbon chat (its request becomes the new task). */
      const openForm = async () => {
        if (await p.isVisible("dialog.schedule-sheet[open]")) await p.click("dialog.schedule-sheet button:has-text('Cancel')");
        await openJob(p, "chat:s-3");
        await pick(p, "Schedule");
        await p.waitForSelector("dialog.schedule-sheet[open]");
        const look = await p.evaluate(() => ({ head: document.getElementById("sched-title").textContent, request: document.querySelector(".sched-request")?.textContent, save: document.getElementById("sched-save").textContent }));
        if (look.head !== "Schedule" || look.request !== "Find the cheapest flight to Lisbon next weekend" || look.save !== "Schedule") fail(`Schedule sheet ${JSON.stringify(look)}`);
      };
      const repeatOn = async () => {
        await p.getByRole("radio", { name: "Repeat", exact: true }).check();
        await checkMode(p, fail, "repeat", "Repeat");
      };
      /** Submits and returns what tasks.add (or tasks.update) sent. */
      const submit = async (type = "tasks.add") => {
        const before = (await sent(p, type)).length;
        await p.click("#sched-save");
        await p.waitForFunction(([t, n]) => window.__requests.filter((r) => r.type === t).length > n, [type, before]);
        return (await sent(p, type)).at(-1);
      };
      await checkLayout(p, `schedule ${label}`);

      // One time (the default): only Scheduled at; empty is as soon as possible.
      await openForm();
      await checkMode(p, fail, "once", "new task");
      if ((await p.textContent("#sched-when-hint")) !== "Empty: as soon as possible") fail(`empty schedule hint "${await p.textContent("#sched-when-hint")}"`);
      await p.fill("#sched-date", dateIn(3));
      await p.fill("#sched-time", "15:00");
      // The modes are one radio group: arrows switch them, the focus shows, and each keeps its values.
      await p.focus("#sched-mode-once");
      await p.keyboard.press("ArrowRight");
      await checkMode(p, fail, "repeat", "ArrowRight");
      const ring = await p.evaluate(() => getComputedStyle(document.activeElement.nextElementSibling).outlineStyle);
      if ((await p.evaluate(() => document.activeElement?.id)) !== "sched-mode-repeat" || ring === "none") fail(`the focused mode shows no focus (${ring})`);
      await p.keyboard.press("ArrowLeft");
      await checkMode(p, fail, "once", "ArrowLeft");
      if ((await p.inputValue("#sched-date")) !== dateIn(3) || (await p.inputValue("#sched-time")) !== "15:00") fail("switching back to One time lost Scheduled at");
      await checkForm(p, fail, `once ${label}`);
      await shootForm("panel-schedule-once");
      const once = await submit();
      if (once.repeat || once.notBefore !== new Date(`${dateIn(3)}T15:00`).toISOString() || once.instructions !== LISBON || "account" in once) {
        fail(`one-off sent ${JSON.stringify(once)}`);
      }
      // Saved: the new task's job opens (waiting for its time).
      await p.waitForFunction(() => !document.querySelector("dialog.schedule-sheet") && document.querySelector("#chat-log .job-intro"));
      if (!(await p.textContent("#job-title")).startsWith("Find the cheapest flight")) fail(`after Schedule the page shows "${await p.textContent("#job-title")}"`);

      // Daily at two times.
      await openForm();
      await repeatOn();
      await p.click(".sch-add");
      await p.locator(".sch-time input").nth(1).fill("18:30");
      if (!/^First run: /.test(await firstRun(p))) fail(`daily first run "${await firstRun(p)}"`);
      await checkForm(p, fail, `daily ${label}`);
      await shootForm("panel-schedule-daily");
      const daily = await submit();
      if (daily.repeat?.cron !== "0 9 * * *\n30 18 * * *" || !daily.repeat.tz || daily.notBefore) fail(`daily sent ${JSON.stringify(daily)}`);

      // Weekly on Mon, Wed and Fri: Mon is picked for a Monday start; the chips are toggle buttons.
      await openForm();
      await repeatOn();
      await p.selectOption("#sched-freq", "weekly");
      const pressed = () => p.evaluate(() => [...document.querySelectorAll(".sch-day[aria-pressed=true]")].map((b) => b.textContent));
      for (const day of ["Monday", "Wednesday", "Friday"]) if (!(await pressed()).includes(day.slice(0, 2))) await p.getByRole("button", { name: day, exact: true }).click();
      for (const day of await pressed()) if (!["Mo", "We", "Fr"].includes(day)) await p.locator(".sch-day", { hasText: day }).click();
      if ((await pressed()).join() !== "Mo,We,Fr" || !/^First run: /.test(await firstRun(p))) fail(`weekly ${await pressed()} "${await firstRun(p)}"`);
      await checkForm(p, fail, `weekly ${label}`);
      await shootForm("panel-schedule-weekly");
      const weekly = await submit();
      if (weekly.repeat?.cron !== "0 9 * * 1,3,5") fail(`weekly sent ${JSON.stringify(weekly)}`);

      // Monthly on the first Monday, every 2 months.
      await openForm();
      await repeatOn();
      await p.selectOption("#sched-freq", "monthly");
      await p.fill("#sched-every", "2");
      await p.selectOption("#sched-nth", "1");
      await p.selectOption("#sched-nth-day", "1");
      if (!(await p.locator("#sched-by-weekday").isChecked())) fail("picking a weekday did not pick its way of saying the day");
      if (!/^First run: /.test(await firstRun(p))) fail(`monthly first run "${await firstRun(p)}"`);
      await checkForm(p, fail, `monthly ${label}`);
      await shootForm("panel-schedule-monthly");
      const monthly = await submit();
      if (monthly.repeat?.cron !== "0 9 * * 1#1" || monthly.repeat.interval?.every !== 2 || monthly.repeat.interval.unit !== "month" || !monthly.repeat.start) {
        fail(`monthly sent ${JSON.stringify(monthly)}`);
      }

      // Custom: the cron is described as it is typed; a bad one says why and is not sent.
      await openForm();
      await repeatOn();
      await p.selectOption("#sched-freq", "custom");
      if ((await p.inputValue("#sched-cron")) !== "0 9 * * *") fail(`Custom did not start from the rule so far: "${await p.inputValue("#sched-cron")}"`);
      await p.fill("#sched-cron", "0 9 * *");
      if (!/has 4 fields/.test(await p.textContent("#sched-cron-text")) || (await p.getAttribute("#sched-cron", "aria-invalid")) !== "true") fail("a bad cron is not flagged");
      await p.click("#sched-save");
      if ((await p.evaluate(() => document.activeElement?.id)) !== "sched-cron" || !/has 4 fields/.test(await p.textContent("#sched-msg"))) fail("submitting a bad cron did not say why and focus it");
      await p.fill("#sched-cron", "*/30 9-17 * * 1-5");
      if ((await p.textContent("#sched-cron-text")) !== "Every weekday, 18 times a day, 9:00 AM to 5:30 PM") fail(`custom text "${await p.textContent("#sched-cron-text")}"`);
      await checkForm(p, fail, `custom ${label}`);
      await shootForm("panel-schedule-custom");
      const custom = await submit();
      if (custom.repeat?.cron !== "*/30 9-17 * * 1-5") fail(`custom sent ${JSON.stringify(custom)}`);

      // Ends on a date (and the error when it is before the start). The rule starts from the One time date and time;
      // saving Repeat sends only the rule (Starts and the rule give the first run).
      await openForm();
      await p.fill("#sched-date", dateIn(2));
      await p.fill("#sched-time", "08:00");
      await repeatOn();
      if ((await p.inputValue("#sched-start")) !== dateIn(2) || (await p.inputValue(".sch-time input")) !== "08:00") fail("the rule did not start from Scheduled at");
      await p.selectOption("#sched-ends", "on");
      await p.fill("#sched-end-date", dateIn(1));
      if ((await firstRun(p)) !== "The end date is before the start date" || (await p.getAttribute("#sched-first", "data-tone")) !== "bad") fail(`end before start "${await firstRun(p)}"`);
      await p.fill("#sched-end-date", `${new Date().getFullYear()}-12-31`);
      if (!/^First run: /.test(await firstRun(p))) fail(`end first run "${await firstRun(p)}"`);
      await checkForm(p, fail, `end ${label}`);
      await shootForm("panel-schedule-end");
      const ending = await submit();
      if (ending.repeat?.end !== `${new Date().getFullYear()}-12-31` || ending.repeat.start !== dateIn(2) || "notBefore" in ending) fail(`end sent ${JSON.stringify(ending)}`);

      // Edit schedule: the task's schedule as it is; Save sends the change (the request stays as it is).
      const editJob = async (key) => {
        if (await p.isVisible("dialog.schedule-sheet[open]")) await p.click("dialog.schedule-sheet button:has-text('Cancel')");
        await openJob(p, key);
        await pick(p, "Edit schedule");
        await p.waitForSelector("dialog.schedule-sheet[open]");
      };
      await editJob("task:t1");
      const edit = await p.evaluate(() => ({
        title: document.getElementById("sched-title").textContent,
        submit: document.getElementById("sched-save").textContent,
        text: document.querySelector(".sched-request").textContent,
        repeat: document.getElementById("sched-mode-repeat").checked,
        freq: document.getElementById("sched-freq").value,
        times: [...document.querySelectorAll(".sch-time input")].map((i) => i.value),
      }));
      if (edit.title !== "Edit schedule" || edit.submit !== "Save" || !edit.text.startsWith("Reply to new mentions") || !edit.repeat || edit.freq !== "daily" || edit.times.join() !== "09:00,18:00") {
        fail(`edit sheet ${JSON.stringify(edit)}`);
      }
      await checkMode(p, fail, "repeat", "edit a repeating task");
      await checkForm(p, fail, `edit ${label}`);
      await shootForm("panel-schedule-edit");
      await p.locator(".sch-time input").nth(1).fill("17:00");
      const saved = await submit("tasks.update");
      if (saved.id !== "t1" || saved.patch.repeat?.cron !== "0 9,17 * * *" || saved.patch.notBefore !== null || "instructions" in saved.patch) fail(`edit sent ${JSON.stringify(saved)}`);
      await p.waitForFunction(() => !document.querySelector("dialog.schedule-sheet"));
      if (!(await p.evaluate(() => document.activeElement?.closest("#job-menu")))) fail("Save did not return the focus to the job's menu");
      const editRow = editJob;
      // A repeating task made One time: Scheduled at holds its next run; saving drops the rule.
      await editRow("task:t1");
      const shownAt = await p.evaluate(() => [document.getElementById("sched-date").value, document.getElementById("sched-time").value]);
      await p.getByRole("radio", { name: "One time", exact: true }).check();
      await checkMode(p, fail, "once", "repeating task to One time");
      const once2 = await submit("tasks.update");
      if (once2.patch.repeat !== null || once2.patch.notBefore !== new Date(`${shownAt[0]}T${shownAt[1]}`).toISOString() || !shownAt[0]) fail(`to One time sent ${JSON.stringify(once2)} (shown ${shownAt})`);

      // A one-time task opens in One time; made Repeat, it sends only the rule.
      await editRow("task:t3");
      await checkMode(p, fail, "once", "edit a one-time task");
      if ((await p.inputValue("#sched-date")) || (await p.inputValue("#sched-time"))) fail("an as-soon-as-possible task opened with a Scheduled at");
      await shootForm("panel-schedule-edit-once");
      await repeatOn();
      const toRepeat = await submit("tasks.update");
      if (toRepeat.id !== "t3" || toRepeat.patch.notBefore !== null || toRepeat.patch.repeat?.cron !== "0 9 * * *") fail(`to Repeat sent ${JSON.stringify(toRepeat)}`);
      reportErrors(p, `schedule ${label}`);
      await p.close();
    },
  },
  // A task stored with the old { dailyAt } rule (before the store migrates it): no errors anywhere it shows (its row,
  // its page, its details, Edit schedule).
  {
    names: ["panel-todo-legacy"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, pick, shoot, reportErrors }) {
      const legacy = (d) => {
        const t = d.tasks.find((x) => x.id === "t1");
        Object.assign(t, { repeat: { dailyAt: ["07:15", "21:00"] } });
      };
      const p = await openPanel(ctx, "ok", undefined, { edit: legacy });
      const meta = await p.textContent('.job-row[data-key="task:t1"] .job-meta');
      if (!meta.startsWith("Daily at 7:15 AM and 9:00 PM")) fail(`legacy row says "${meta}"`);
      await openJob(p, "task:t1");
      if (!(await p.textContent("#job-sub")).startsWith("Daily at 7:15 AM and 9:00 PM")) fail(`legacy subtitle "${await p.textContent("#job-sub")}"`);
      // Details (its request), then Edit schedule: each shows the rule.
      await p.click("#chat-log .job-intro .ev-first");
      await p.waitForSelector("dialog.sheet[open]");
      const repeats = await p.evaluate(() => [...document.querySelectorAll("dialog.sheet[open] dt")].find((d) => d.textContent === "Repeats")?.nextElementSibling?.textContent ?? null);
      if (!repeats?.startsWith("Daily at 7:15 AM and 9:00 PM")) fail(`legacy details Repeats: ${repeats}`);
      await p.keyboard.press("Escape");
      await pick(p, "Edit schedule");
      await p.waitForSelector("dialog.schedule-sheet[open]");
      const times = await p.evaluate(() => [...document.querySelectorAll(".sch-time input")].map((i) => i.value).join());
      if (times !== "07:15,21:00") fail(`legacy edit times ${times}`);
      await shoot(p, "panel-todo-legacy", size, scheme);
      reportErrors(p, `todo legacy ${label}`);
      await p.close();
    },
  },
  // A repeating task's details: its previous runs (date and the start of each output), opening to the whole output
  // and note, "Show all" for the rest, and the summary of older runs; nothing overflows the sheet.
  {
    names: ["panel-todo-runs"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, shoot, reportErrors }) {
      const outputs = [
        "We just shipped scheduled tasks that remember every earlier run, so a daily post never repeats itself. Set it once, it keeps going.",
        "Roadmap: shared TODO lists for teams are next. Everyone sees what the agent did and what it will do tomorrow.",
        "New: the agent reads your account's profile before it writes, so every post sounds like you and says something true.",
      ];
      const runs = Array.from({ length: 14 }, (_, i) => ({
        id: `r${i}`,
        kind: "task",
        subject: "Run note",
        text: i === 1 ? "(no note)" : `Posted about ${["scheduled tasks", "the roadmap", "grounded posts"][i % 3]}. Next: a customer story.`,
        ...(i === 13 ? {} : { output: outputs[i % 3] }),
        scope: "task",
        taskKey: "s01SERIES",
        source: { kind: "task" },
        learnedAt: new Date(Date.UTC(2026, 8, 26, 18 - i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 8, 26, 18 - i)).toISOString(),
      }));
      const summary = { id: "rs", kind: "task", subject: "Earlier runs", text: "57 earlier runs, 2026-07-01 to 2026-09-20. Frequent words (runs): ship (31), roadmap (12), agent (9)", scope: "task", taskKey: "s01SERIES", source: { kind: "task" }, learnedAt: "2026-07-01T09:00:00.000Z", updatedAt: "2026-09-20T09:00:00.000Z" };
      const edit = (d) => Object.assign(d, { taskRuns: [...runs, summary], taskRunsFor: "Reply to new mentions" });
      const p = await openPanel(ctx, "ok", undefined, { edit });
      await openJob(p, "task:t1");
      await p.click("#chat-log .job-intro .ev-first");
      await p.waitForSelector("dialog.sheet[open] .sheet-runs");
      const head = await p.locator("dialog.sheet[open] .sheet-runs > summary").textContent();
      if (head !== "Previous runs · 14") fail(`runs heading "${head}"`);
      await p.locator("dialog.sheet[open] .sheet-runs > summary").click();
      const shown = await p.locator("dialog.sheet[open] .sheet-runs .run").count();
      if (shown !== 10) fail(`${shown} runs listed before Show all`);
      await p.locator("dialog.sheet[open] .sheet-runs .run > summary").first().click();
      const first = await p.locator("dialog.sheet[open] .sheet-runs .run[open]").innerText();
      if (!first.includes(outputs[0]) || !first.includes("Note: Posted about scheduled tasks")) fail(`first run opened to "${first}"`);
      await p.locator("dialog.sheet[open] .sheet-runs .run > summary").nth(1).click();
      const outputOnly = await p.locator("dialog.sheet[open] .sheet-runs .run[open]").nth(1).innerText();
      if (outputOnly.includes("(no note)")) fail("an output-only run shows its placeholder note");
      await p.getByRole("button", { name: "Show all 14" }).click();
      if ((await p.locator("dialog.sheet[open] .sheet-runs .run").count()) !== 14) fail("Show all did not list every run");
      const older = await p.locator("dialog.sheet[open] .sheet-runs .sheet-note").textContent();
      if (!older?.startsWith("Older: 57 earlier runs")) fail(`older runs note "${older}"`);
      const overflow = await p.evaluate(() => {
        const body = document.querySelector("dialog.sheet[open] .sheet-body");
        return body.scrollWidth - body.clientWidth;
      });
      if (overflow > 1) fail(`the sheet scrolls sideways by ${overflow}px`);
      await shoot(p, "panel-todo-runs", size, scheme);
      reportErrors(p, `todo runs ${label}`);
      await p.close();
    },
  },
];
