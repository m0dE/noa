// The agent's memory in the UI harness: Settings > Memory (entries by kind, task history grouped by task with its
// records by key, search, edit, delete, delete a task's memory, the switches, Forget everything, the question after
// signing in to another account, episodes by date with "Show more", a fact given at every turn and one with what it
// said before, the user's own records by key, the Episodes and Records switches off) at 360, 420 and 1280 px in light and dark, and in the side panel the chat's
// "Remembered" notes with Undo (one saved after the chat that replaced another entry), the composer menu's Memory switch (off for a chat shows a badge; a new chat carries
// the choice) and the TODO tab's "Add this computer's memory to <account>?".
import { eventually, shown } from "./checks.mjs";

const SCHEMES = ["light", "dark"];
/** Settings > Memory is checked at a phone-like width too (the options page opens in a tab of any size). */
export const MEMORY_OPT_SIZES = [
  { w: 360, h: 900 },
  { w: 420, h: 900 },
  { w: 1280, h: 1000 },
];

const iso = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const DAY = 24 * 60;
const chat = (title) => ({ kind: "chat", sessionId: "s-mem", title });

const INBOX = "Answer each new message in the shared inbox";
const inbox = (e) => ({ kind: "task", scope: "task", taskKey: "tk2", taskTitle: INBOX, source: { kind: "task", title: INBOX }, ...e });

/**
 * What the agent keeps: every kind, a long text, a long site name, an entry never used, a task's run notes, and a
 * task that works through many things with its records by key (examples only: two addresses and an ID).
 */
export function memoryEntries() {
  return [
    { id: "m1", kind: "preference", subject: "Sign-off", text: "Sign emails “— Jae” with no other closing line.", scope: "global", source: chat("Reply to Jordan"), learnedAt: iso(-9 * DAY), updatedAt: iso(-9 * DAY), lastUsedAt: iso(-60) },
    { id: "m2", kind: "preference", subject: "Posting hours", text: "Never post on X before 8am in the user's time zone.", scope: "global", source: { kind: "user" }, learnedAt: iso(-20 * DAY), updatedAt: iso(-20 * DAY) },
    { id: "m3", kind: "account", subject: "Work email", text: "admin@runhq.io is the work email: Google account /u/2 (https://mail.google.com/mail/u/2/).", scope: "global", source: chat("Check my work inbox"), learnedAt: iso(-3 * DAY), updatedAt: iso(-3 * DAY), lastUsedAt: iso(-30), pinned: true },
    { id: "m4", kind: "account", subject: "@mecharoyalecom", text: "The X account for the game Mecha Royale; switch to it for game posts.", scope: "global", source: chat("Post the patch notes"), learnedAt: iso(-5 * DAY), updatedAt: iso(-2 * DAY) },
    {
      id: "m5", kind: "person", subject: "Paul Lee", text: "The user's accountant (paul@leeandco.example).", scope: "global", source: chat("Send the invoices"), learnedAt: iso(-12 * DAY), updatedAt: iso(-12 * DAY),
      history: [{ subject: "Tom Kim", text: "The user's accountant until the firm closed (tom@kimtax.example).", since: iso(-400 * DAY), until: iso(-12 * DAY) }],
    },
    { id: "m6", kind: "playbook", subject: "Compose", text: "Press C to open a new message; the send button is at the bottom left of the draft, not in the toolbar.", scope: "domain", domain: "mail.google.com", source: chat("Reply to Jordan"), learnedAt: iso(-9 * DAY), updatedAt: iso(-DAY), lastUsedAt: iso(-60) },
    { id: "m7", kind: "playbook", subject: "Sign-in", text: "Asks to sign in again each morning: pause and ask the user.", scope: "domain", domain: "partner-portal.enterprise-billing.example.co.uk", source: chat("Download the invoice"), learnedAt: iso(-4 * DAY), updatedAt: iso(-4 * DAY) },
    { id: "m8", kind: "task", subject: "Run note", text: "Posted the tip about the new arena map. Next: the ranked season.", scope: "task", taskKey: "tk1", taskTitle: "Post one tip about Mecha Royale on X", source: { kind: "task", title: "Post one tip about Mecha Royale on X" }, learnedAt: iso(-DAY), updatedAt: iso(-DAY) },
    { id: "m9", kind: "task", subject: "Run note", text: "Posted the tip about daily quests.", scope: "task", taskKey: "tk1", taskTitle: "Post one tip about Mecha Royale on X", source: { kind: "task", title: "Post one tip about Mecha Royale on X" }, learnedAt: iso(-2 * DAY), updatedAt: iso(-2 * DAY) },
    inbox({ id: "m10", subject: "Run note", text: "Answered 4 messages; 2 wait for the user.", learnedAt: iso(-180), updatedAt: iso(-180) }),
    inbox({
      id: "r1", subject: "Ada.Lee@example.com", key: "ada.lee@example.com", text: "Prefers email over calls; writes about the March invoice.",
      notes: [{ at: iso(-3 * DAY), text: "Resent the March invoice." }, { at: iso(-200), text: "Asked for a receipt too; sent it." }],
      learnedAt: iso(-9 * DAY), updatedAt: iso(-200), lastUsedAt: iso(-190),
    }),
    inbox({ id: "r2", subject: "sam.ortiz@example.com", key: "sam.ortiz@example.com", text: "Books the offsite; wants dates confirmed a week ahead.", learnedAt: iso(-4 * DAY), updatedAt: iso(-4 * DAY) }),
    inbox({ id: "r3", subject: "#48213", key: "48213", text: "Refund asked on the 20th; sent on the 22nd.", learnedAt: iso(-6 * DAY), updatedAt: iso(-5 * DAY) }),
    ...episodes(),
    ...userRecords(),
  ];
}

/** The user's own records, filed by key in chats (not a task's): examples only, a ticket and an order. */
export function userRecords() {
  return [
    {
      id: "u1", kind: "record", scope: "global", subject: "Ticket #7731", key: "ticket 7731", text: "The printer on floor 3 jams on duplex jobs; IT asked for photos.",
      notes: [{ at: iso(-4 * DAY), text: "Sent the photos to IT." }, { at: iso(-DAY), text: "Technician booked for Thursday." }],
      source: chat("Follow up on the printer ticket"), learnedAt: iso(-6 * DAY), updatedAt: iso(-DAY),
    },
    { id: "u2", kind: "record", scope: "global", subject: "Order 114-2290", key: "order 114-2290", text: "Standing desk; delivery moved to Oct 3.", source: chat("Where is my desk?"), learnedAt: iso(-3 * DAY), updatedAt: iso(-3 * DAY) },
  ];
}

const episode = (e) => ({ kind: "episode", scope: "global", learnedAt: e.at, updatedAt: e.at, ...e });

/** Episodes (a dated summary of each chat and run), with the sites and things they involve: examples only. */
export function episodes() {
  return [
    episode({ id: "e1", subject: "Replied to Jordan about the contract", text: "Drafted and sent the renewal reply from the work inbox; Jordan asked for the signed PDF by Friday.", source: chat("Reply to Jordan"), at: iso(-2 * DAY), entities: ["mail.google.com", "Jordan Lee", "admin@runhq.io"] }),
    episode({
      id: "e2", subject: "Posted the arena map tip", text: "Posted one tip on X from @mecharoyalecom about the new arena map.", source: { kind: "task", title: "Post one tip about Mecha Royale on X" },
      taskTitle: "Post one tip about Mecha Royale on X", at: iso(-DAY), entities: ["x.com", "@mecharoyalecom"],
    }),
    episode({ id: "e3", subject: "Refund for order HM4K2ZQ9", text: "Found the order on the partner portal and asked for the refund; waiting for approval.", source: chat("Refund the broken headset"), at: iso(-8 * DAY), lastUsedAt: iso(-60), entities: ["partner-portal.enterprise-billing.example.co.uk", "HM4K2ZQ9"] }),
  ];
}

/** More episodes than one page of them in Settings: examples only, one a day. */
export function manyEpisodes(n = 45) {
  return Array.from({ length: n }, (_, i) =>
    episode({ id: `ep${i}`, subject: `Checked the work inbox (${i + 1})`, text: "Nothing needed a reply.", source: chat("Check my work inbox"), at: iso(-(i + 10) * DAY), entities: ["mail.google.com"] }),
  );
}

/** A task with many records (more than one page of them in Settings): examples only, numbered items. */
export function manyRecords(n = 120) {
  const title = "Check every open order on the shop dashboard and update its status";
  return Array.from({ length: n }, (_, i) => ({
    id: `q${i}`, kind: "task", scope: "task", taskKey: "tk3", taskTitle: title, source: { kind: "task", title },
    subject: `#${50000 + i}`, key: String(50000 + i), text: `Status checked; ${i % 3 ? "shipped" : "waiting for stock"}.`,
    learnedAt: iso(-10 * DAY + i), updatedAt: iso(-10 * DAY + i),
  }));
}

const requests = (p, type) => p.evaluate((t) => window.__requests.filter((r) => r.type === t), type);

/** Nothing in a memory box reaches past it (text, buttons, the editor), at this width. */
const clippedInBoxes = (p) =>
  p.evaluate(() => {
    const out = [];
    for (const box of document.querySelectorAll("#panel-memory .box")) {
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll("button, input, select, textarea, .mem-text, .mem-subject, .mem-where, .mem-meta, .mem-when, .mem-chip, .mem-history li")) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right > b.right + 0.5 || r.left < b.left - 0.5) out.push(`${el.className || el.tagName} ${el.textContent.slice(0, 30)}`);
      }
    }
    return out;
  });

async function openMemory(h, size, scheme, edit = (d) => ((d.memory = memoryEntries()), (d.memorySync = { state: "on", lastSyncAt: iso(-5) }))) {
  const p = await h.openOptions(size, scheme, "ok", "#memory", edit);
  await p.waitForSelector("#memory-kinds .mem-kind");
  return p;
}

/** Settings > Memory at every size and scheme, then its interactions once. */
export async function runMemoryOptions(h) {
  for (const scheme of SCHEMES) {
    for (const size of MEMORY_OPT_SIZES) {
      if (h.want("options-memory", size, scheme)) {
        const p = await openMemory(h, size, scheme);
        await p.waitForSelector("#memory-kinds .mem-entry");
        await h.optChecks(p, `memory ${size.w} ${scheme}`, [
          ["the Memory tab is shown", async () => (await p.getAttribute("#tab-memory", "aria-selected")) === "true" && (await shown(p, "#panel-memory"))],
          ["seven kinds in order", async () => (await p.$$eval(".mem-kind", (els) => els.map((e) => e.dataset.kind).join())) === "preference,account,person,playbook,task,episode,record"],
          ["every entry listed", async () => (await p.locator(".mem-entry").count()) === 18],
          ["counts per kind", async () => (await p.$$eval(".mem-kind-head .mem-count", (els) => els.map((e) => e.textContent).join())) === "2,2,1,2,6,3,2"],
          ["the user's records are their own group, newest first, with their dated notes", async () =>
            (await p.$$eval('.mem-kind[data-kind="record"] .mem-records .mem-entry', (els) => els.map((e) => e.dataset.id).join())) === "u1,u2" &&
            /Technician booked for Thursday\./.test(await p.textContent('.mem-entry[data-id="u1"] .mem-notes')) &&
            (await p.textContent('.mem-kind[data-kind="record"] .mem-kind-head b')).startsWith("Records (by key)")],
          ["a record has Edit and Delete, no pin", async () => (await p.$$eval('.mem-entry[data-id="u1"] .mem-actions > *', (els) => els.map((e) => e.textContent).join())) === "Edit,Delete"],
          ["says what the agent is given each turn", async () => /only the memory relevant to it, plus the facts you set to “Always give”/.test(await p.textContent("#panel-memory .mem-relevance"))],
          ["episodes newest first, in their own group", async () =>
            (await p.$$eval('.mem-kind[data-kind="episode"] .mem-entry', (els) => els.map((e) => e.dataset.id).join())) === "e2,e1,e3" && (await p.locator('.mem-kind[data-kind="task"] .mem-entry[data-id^="e"]').count()) === 0],
          ["an episode shows its date, its chips and its task", async () =>
            /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/.test(await p.textContent('.mem-entry[data-id="e2"] .mem-when')) &&
            (await p.$$eval('.mem-entry[data-id="e2"] .mem-chip', (els) => els.map((e) => e.textContent).join())) === "x.com,@mecharoyalecom" &&
            (await p.textContent('.mem-entry[data-id="e2"] .mem-meta')) === "from “Post one tip about Mecha Royale on X”"],
          ["an episode has Delete, not Edit", async () => (await p.$$eval('.mem-entry[data-id="e1"] button', (els) => els.map((e) => e.textContent).join())) === "Delete"],
          ["a pinned fact is listed first, set to Always give", async () =>
            (await p.$$eval('.mem-kind[data-kind="account"] .mem-entry', (els) => els.map((e) => e.dataset.id).join())) === "m3,m4" && (await p.inputValue("#memory-pin-m3")) === "pinned" && (await p.inputValue("#memory-pin-m4")) === "relevant"],
          ["only facts have the pin control", async () => (await p.locator(".mem-pin").count()) === 7],
          ["a fact shows what it said before", async () =>
            /^Before: Tom Kim: The user's accountant until the firm closed \(tom@kimtax\.example\)\. \(until [A-Z][a-z]{2} \d{1,2}(, \d{4})?\)$/.test(await p.textContent('.mem-entry[data-id="m5"] .mem-history li'))],
          ["memory and every kind on", async () => (await p.isChecked("#memory-on")) && (await p.$$eval(".mem-kind input[role=switch]", (els) => els.every((e) => e.checked)))],
          ["a playbook says its site", async () => (await p.textContent('.mem-entry[data-id="m6"] .mem-where')) === "mail.google.com"],
          ["task history grouped by task, newest first, collapsed, with counts", async () =>
            JSON.stringify(await p.$$eval(".mem-task", (els) => els.map((e) => [e.dataset.task, e.open, e.querySelector(".mem-task-head .mem-count").textContent]))) ===
            JSON.stringify([["tk2", false, "1 run note · 3 records"], ["tk1", false, "2 run notes"]])],
          ["the search box shows", async () => shown(p, "#memory-search")],
          ["where it came from and when it was used", async () => /^Learned .* · used .* · from “Reply to Jordan”$/.test(await p.textContent('.mem-entry[data-id="m1"] .mem-meta'))],
          ["never used says so", async () => /not used yet · added by you$/.test(await p.textContent('.mem-entry[data-id="m2"] .mem-meta'))],
          ["no empty note", async () => !(await shown(p, "#memory-empty"))],
          ["says it syncs with the account", async () => /^Synced with your account, last /.test(await p.textContent("#memory-sync"))],
          ["nothing clipped", async () => (await clippedInBoxes(p)).length === 0],
          ["Edit, Delete and the pin named for readers", async () => (await p.getAttribute('.mem-entry[data-id="m5"] button', "aria-label")) === "Edit Paul Lee" && (await p.getAttribute("#memory-pin-m5", "aria-label")) === "When to give Paul Lee"],
        ]);
        await h.optShot(p, "options-memory", size, scheme);
        await p.ctx.close();
      }
      if (size.w === 420 && h.want("options-memory-empty", size, scheme)) {
        const p = await openMemory(h, size, scheme, (d) => ((d.memory = []), (d.memorySync = { state: "no-plan" })));
        await h.optChecks(p, `memory empty ${scheme}`, [
          ["says it is kept on this computer only, and how to sync it", async () => /^Kept on this computer only\. With a paid plan it syncs/.test(await p.textContent("#memory-sync"))],
          ["says nothing is kept yet", async () => eventually(() => shown(p, "#memory-empty"))],
          ["each kind says nothing yet", async () => (await p.locator(".mem-none").allTextContents()).every((t) => t === "Nothing yet.")],
        ]);
        await h.optShot(p, "options-memory-empty", size, scheme);
        await p.ctx.close();
      }
      if (size.w === 420 && h.want("options-memory-episodes-off", size, scheme)) {
        const p = await openMemory(h, size, scheme, (d) => ((d.memory = memoryEntries()), (d.memorySync = { state: "on", lastSyncAt: iso(-5) }), (d.state.settings.memoryKindsOff = ["episode", "record"])));
        await h.optChecks(p, `memory episodes off ${scheme}`, [
          ["the Episodes switch is off", async () => !(await p.isChecked("#memory-kind-episode"))],
          ["and says none are written or given", async () => (await p.textContent("#memory-kind-episode-hint")) === "Off: no episodes are written after chats and runs, and none are given to the agent"],
          ["what is kept stays listed", async () => (await p.locator('.mem-kind[data-kind="episode"] .mem-entry').count()) === 3],
          ["the Records switch is off and says none are filed or given", async () =>
            !(await p.isChecked("#memory-kind-record")) && (await p.textContent("#memory-kind-record-hint")) === "Off: records are neither filed nor given to the agent"],
          ["nothing clipped", async () => (await clippedInBoxes(p)).length === 0],
        ]);
        await h.optShot(p, "options-memory-episodes-off", size, scheme);
        await p.ctx.close();
      }
      if (size.w === 420 && h.want("options-memory-ask", size, scheme)) {
        const p = await openMemory(h, size, scheme, (d) => ((d.memory = memoryEntries()), (d.memorySync = { state: "ask", account: "bob@example.com" })));
        await h.optChecks(p, `memory ask ${scheme}`, [
          ["asks whether to add this computer's memory", async () => /^Add this computer's memory to bob@example\.com\? Nothing is sent until you choose\.$/.test(await p.textContent("#memory-sync"))],
          ["with Keep separate and Add", async () => (await p.$$eval("#memory-sync-actions button", (els) => els.map((e) => e.textContent).join())) === "Keep separate,Add"],
          ["and what each means", async () => /Keep separate: it stays on this computer only/.test(await p.textContent("#memory-sync-actions .mem-sync-hint"))],
          ["nothing clipped", async () => (await clippedInBoxes(p)).length === 0],
        ]);
        await h.optShot(p, "options-memory-ask", size, scheme);
        await p.ctx.close();
      }
    }
  }
  for (const flow of MEMORY_FLOWS) if (h.want(flow.name, flow.size, flow.scheme)) await flow.run(h);
}

const MEMORY_FLOWS = [
  // Edit (and a refused edit), delete, a kind's switch, pausing memory, and Forget everything asked twice.
  {
    name: "options-memory-edit",
    size: { w: 360 },
    scheme: "light",
    async run(h) {
      const size = { w: 360, h: 900 };
      const p = await openMemory(h, size, "light");
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      await p.click('.mem-entry[data-id="m5"] button:has-text("Edit")');
      await p.waitForSelector("#memory-edit-text-m5");
      check("the editor has the entry", (await p.inputValue("#memory-edit-subject-m5")) === "Paul Lee" && /accountant/.test(await p.inputValue("#memory-edit-text-m5")));
      check("the subject field has the focus", await p.evaluate(() => document.activeElement?.id === "memory-edit-subject-m5"));
      check("the editor fits", (await clippedInBoxes(p)).length === 0);
      // A refused edit (it looks like a secret) says why and keeps the editor.
      await p.evaluate(() => (window.__refuse = { "memory.edit": "Not saved: it contains what looks like a password, PIN or one-time code." }));
      await p.fill("#memory-edit-text-m5", "PIN: 4821");
      await p.click('.mem-entry.editing button:has-text("Save")');
      check("a refusal shows in the editor", await eventually(async () => /one-time code/.test((await p.textContent(".mem-problem")) ?? "")));
      await h.optShot(p, "options-memory-edit", size, "light");
      await p.evaluate(() => (window.__refuse = {}));
      await p.fill("#memory-edit-text-m5", "The user's accountant since 2020.");
      await p.click('.mem-entry.editing button:has-text("Save")');
      check("saved: the row shows the new text", await eventually(async () => (await p.textContent('.mem-entry[data-id="m5"] .mem-text')) === "The user's accountant since 2020."));
      check("the edit was sent", (await requests(p, "memory.edit")).some((r) => r.id === "m5" && r.subject === "Paul Lee" && /since 2020/.test(r.text)));

      await p.click('.mem-entry[data-id="m7"] .mem-delete');
      check("delete removes the row", await eventually(async () => (await p.locator('.mem-entry[data-id="m7"]').count()) === 0));
      check("and says so", /Deleted “Sign-in”/.test(await p.textContent("#memory-msg")));

      await p.click('label[for="memory-kind-person"]');
      check("a kind's switch saves the kinds that are off", await eventually(async () => (await requests(p, "settings.save")).some((r) => JSON.stringify(r.settings.memoryKindsOff) === '["person"]')));
      check("the kind says it is off", await eventually(async () => /^Off:/.test(await p.textContent("#memory-kind-person-hint"))));
      check("its switch keeps the focus", await p.evaluate(() => document.activeElement?.id === "memory-kind-person"));

      await p.click('label[for="memory-on"]');
      check("Use memory off pauses it", await eventually(async () => (await requests(p, "settings.save")).some((r) => r.settings.memoryPaused === true)));
      check("paused says what it means", await eventually(() => shown(p, "#memory-paused-note")));
      await h.optShot(p, "options-memory-paused", size, "light");

      await p.click("#memory-forget");
      check("Forget everything asks first", /Forget all 17 memories\? This can't be undone\./.test(await p.textContent("#memory-forget-question")));
      check("nothing forgotten yet", (await requests(p, "memory.clear")).length === 0);
      await h.optShot(p, "options-memory-forget", size, "light");
      await p.click("#memory-forget-cancel");
      check("Cancel leaves it", (await p.textContent("#memory-forget")) === "Forget everything" && (await p.locator(".mem-entry").count()) === 17);
      await p.click("#memory-forget");
      await p.click("#memory-forget");
      check("confirmed: everything forgotten", await eventually(async () => (await requests(p, "memory.clear")).length === 1 && (await p.locator(".mem-entry").count()) === 0));
      check("the empty note shows", await eventually(() => shown(p, "#memory-empty")));
      await h.optChecks(p, "memory flows", checks);
      await p.ctx.close();
    },
  },
  // A task's records: open its group, its dated notes, Show more, search, edit a record, delete the task's memory.
  {
    name: "options-memory-tasks",
    size: { w: 420 },
    scheme: "light",
    async run(h) {
      const size = { w: 420, h: 900 };
      const p = await openMemory(h, size, "light", (d) => ((d.memory = [...memoryEntries(), ...manyRecords()]), (d.memorySync = { state: "on", lastSyncAt: iso(-5) })));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      await p.click('.mem-task[data-task="tk2"] > summary');
      await p.waitForSelector('.mem-task[data-task="tk2"][open] .mem-entry[data-id="r1"]');
      check("an open task lists its run notes, then its records", (await p.$$eval('.mem-task[data-task="tk2"] .mem-sub', (els) => els.map((e) => e.textContent).join())) === "Run notes,Records by key");
      check("records newest first", (await p.$$eval('.mem-task[data-task="tk2"] .mem-records .mem-entry', (els) => els.map((e) => e.dataset.id).join())) === "r1,r2,r3");
      check("a record shows its dated notes", /Asked for a receipt too; sent it\./.test(await p.textContent('.mem-entry[data-id="r1"] .mem-notes')));
      check("nothing clipped", (await clippedInBoxes(p)).length === 0);
      await h.optShot(p, "options-memory-task-open", size, "light");

      await p.click('.mem-task[data-task="tk3"] > summary');
      await p.waitForSelector('.mem-task[data-task="tk3"][open] .mem-more');
      check("a long task shows one page of records", (await p.locator('.mem-task[data-task="tk3"] .mem-records .mem-entry').count()) === 50);
      check("and says how many more there are", (await p.textContent('.mem-task[data-task="tk3"] .mem-more')) === "Show 50 more of 70");
      await p.click('.mem-task[data-task="tk3"] .mem-more');
      check("Show more adds a page", await eventually(async () => (await p.locator('.mem-task[data-task="tk3"] .mem-records .mem-entry').count()) === 100));
      check("the group stays open", await p.evaluate(() => document.querySelector('.mem-task[data-task="tk3"]').open));

      await p.fill("#memory-search", "ADA lee");
      check("search narrows to what matches, case aside", await eventually(async () => (await p.textContent("#memory-found")) === "1 match"));
      check("the task with the match opens", await p.evaluate(() => document.querySelector('.mem-task[data-task="tk2"]').open && !document.querySelector('.mem-task[data-task="tk1"]')));
      check("other kinds say no matches", (await p.locator(".mem-none").allTextContents()).every((t) => t === "No matches."));
      check("the task's delete still counts all it keeps", (await p.textContent('.mem-task[data-task="tk2"] .mem-task-delete')) === "Delete this task's memory");
      await h.optShot(p, "options-memory-search", size, "light");
      await p.fill("#memory-search", "");
      check("clearing the search lists everything again", await eventually(async () => (await p.locator(".mem-task").count()) === 3));

      await p.click('.mem-entry[data-id="r2"] button:has-text("Edit")');
      await p.fill("#memory-edit-text-r2", "Books the offsite; confirm dates two weeks ahead.");
      await p.click('.mem-entry.editing button:has-text("Save")');
      check("a record is edited like any entry", await eventually(async () => (await requests(p, "memory.edit")).some((r) => r.id === "r2" && /two weeks/.test(r.text))));

      await p.click('.mem-task[data-task="tk2"] .mem-task-delete');
      check("deleting a task's memory asks first", /^Delete everything this task keeps \(4 entries\)\? This can't be undone\.$/.test(await p.textContent('.mem-task[data-task="tk2"] .mem-question')));
      check("nothing deleted yet", (await requests(p, "memory.deleteTask")).length === 0);
      await h.optShot(p, "options-memory-task-delete", size, "light");
      await p.click('.mem-task[data-task="tk2"] .mem-task-delete');
      check("confirmed: the task's memory goes", await eventually(async () => (await requests(p, "memory.deleteTask")).some((r) => r.taskKey === "tk2") && (await p.locator('.mem-task[data-task="tk2"]').count()) === 0));
      check("and says so", /^Deleted 4 entries of “Answer each new message/.test(await p.textContent("#memory-msg")));
      check("other tasks stay", (await p.locator(".mem-task").count()) === 2);
      await h.optChecks(p, "memory task flows", checks);
      await p.ctx.close();
    },
  },
  // A fact set to "Always give" (and back), episodes a page at a time, deleting one, and searching their sites.
  {
    name: "options-memory-episodes",
    size: { w: 420 },
    scheme: "light",
    async run(h) {
      const size = { w: 420, h: 900 };
      const p = await openMemory(h, size, "light", (d) => ((d.memory = [...memoryEntries(), ...manyEpisodes()]), (d.memorySync = { state: "on", lastSyncAt: iso(-5) })));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      const episodeRows = () => p.locator('.mem-kind[data-kind="episode"] .mem-entry').count();
      const accountOrder = () => p.$$eval('.mem-kind[data-kind="account"] .mem-entry', (els) => els.map((e) => e.dataset.id).join());

      await p.selectOption("#memory-pin-m1", "pinned");
      check("Always give sends the pin", await eventually(async () => (await requests(p, "memory.pin")).some((r) => r.id === "m1" && r.pinned === true)));
      check("and says so", await eventually(async () => /“Sign-off” is given at every turn\./.test(await p.textContent("#memory-msg"))));
      check("the fact stays set to Always give", await eventually(async () => (await p.inputValue("#memory-pin-m1")) === "pinned"));
      await p.selectOption("#memory-pin-m3", "relevant");
      check("Only when relevant unpins it", await eventually(async () => (await requests(p, "memory.pin")).some((r) => r.id === "m3" && r.pinned === false)));
      check("then it is listed by date", await eventually(async () => (await accountOrder()) === "m3,m4" && (await p.inputValue("#memory-pin-m3")) === "relevant"));

      check("a long list of episodes shows one page", (await episodeRows()) === 20);
      check("and says how many more there are", (await p.textContent('.mem-kind[data-kind="episode"] .mem-more')) === "Show 20 more of 28");
      await h.optShot(p, "options-memory-episodes-more", size, "light");
      await p.click('.mem-kind[data-kind="episode"] .mem-more');
      check("Show more adds a page", await eventually(async () => (await episodeRows()) === 40));
      await p.click('.mem-kind[data-kind="episode"] .mem-more');
      check("then the rest, without the button", await eventually(async () => (await episodeRows()) === 48 && (await p.locator('.mem-kind[data-kind="episode"] .mem-more').count()) === 0));

      await p.click('.mem-entry[data-id="e3"] .mem-delete');
      check("an episode is deleted", await eventually(async () => (await requests(p, "memory.delete")).some((r) => r.id === "e3") && (await p.locator('.mem-entry[data-id="e3"]').count()) === 0));
      await p.fill("#memory-search", "@mecharoyalecom x.com");
      check("search matches an episode's sites and things", await eventually(async () => (await p.$$eval('.mem-kind[data-kind="episode"] .mem-entry', (els) => els.map((e) => e.dataset.id).join())) === "e2"));
      await p.fill("#memory-search", "");
      check("nothing clipped", (await clippedInBoxes(p)).length === 0);
      await h.optChecks(p, "memory episodes and pins", checks);
      await p.ctx.close();
    },
  },
  // Signed in to another account: Add sends this computer's memory there; then it says it syncs.
  {
    name: "options-memory-ask-add",
    size: { w: 420 },
    scheme: "light",
    async run(h) {
      const p = await openMemory(h, { w: 420, h: 900 }, "light", (d) => ((d.memory = memoryEntries()), (d.memorySync = { state: "ask", account: "bob@example.com" })));
      await p.click("#memory-sync-add");
      await h.optChecks(p, "memory ask add", [
        ["Add answers the question", async () => eventually(async () => (await requests(p, "memory.syncChoice")).some((r) => r.add === true))],
        ["then it syncs", async () => eventually(async () => /^Synced with your account/.test(await p.textContent("#memory-sync")))],
        ["and the buttons go", async () => eventually(async () => !(await shown(p, "#memory-sync-actions")))],
      ]);
      await p.ctx.close();
    },
  },
];

/** The chat's memory notes and the composer's Memory switch, at each panel size and scheme. */
export const MEMORY_PANEL_CASES = [
  {
    names: ["panel-memory", "panel-memory-undone", "panel-memory-menu", "panel-memory-off"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const entries = memoryEntries();
      const p = await openPanel(ctx, "idle", "#chat-log .ev-memory", {
        edit: (d) => {
          const conv = {
            sessionId: "s-mem", source: "adhoc", title: "Check my work inbox", instructions: "Check my work inbox and tell me what needs a reply",
            brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: iso(-2), firstStartedAt: iso(-2), endedAt: iso(0), outcome: "done", summary: "Checked the work inbox",
          };
          const ev = (m, e) => ({ ...e, ts: iso(m), sessionId: "s-mem" });
          const work = entries.find((e) => e.id === "m3");
          const compose = entries.find((e) => e.id === "m6");
          d.sessions.unshift(conv);
          d.eventsBySession["s-mem"] = [
            ev(-2, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
            ev(-2, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://mail.google.com/mail/u/2/" } }),
            ev(-2, { type: "tool_result", id: "1", name: "navigate", text: "Navigated to https://mail.google.com/mail/u/2/\nTitle: Inbox - admin@runhq.io - Gmail" }),
            ev(-1, { type: "tool_call", id: "2", name: "remember", args: { kind: "account", subject: work.subject, text: work.text } }),
            ev(-1, { type: "memory", changeId: "c1", before: null, after: work }),
            ev(-1, { type: "tool_result", id: "2", name: "remember", text: "Remembered [m3] Work email. The user sees it in the chat with Undo." }),
            ev(-1, { type: "memory", changeId: "c2", before: { ...compose, text: "The send button is in the toolbar." }, after: compose }),
            ev(0, { type: "assistant_text", text: "Two emails need a reply: **Jordan Lee** (contract renewal, by Friday) and **Sam Ortiz** (offsite dates)." }),
            ev(0, { type: "task_end", outcome: "done", summary: conv.summary }),
          ];
          d.state.tabChats = { 1: "s-mem" };
          d.memory = entries;
        },
      });
      const notes = () =>
        p.evaluate(() =>
          [...document.querySelectorAll("#chat-log .ev-memory")].map((n) => {
            const line = n.querySelector(".mem-line");
            const kids = [...line.children].filter((k) => k.getBoundingClientRect().width);
            const tops = kids.map((k) => k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2);
            return {
              line: line.textContent,
              oneLine: Math.max(...tops) - Math.min(...tops) < 4,
              inside: n.scrollWidth <= n.clientWidth + 1 && n.getBoundingClientRect().right <= document.getElementById("chat-log").getBoundingClientRect().right + 1,
              buttons: [...n.querySelectorAll("button")].map((b) => b.textContent),
              undone: n.classList.contains("undone"),
              title: line.title,
            };
          }),
        );
      const got = await notes();
      if (got.length !== 2) fail(`memory notes: ${got.length}`);
      if (!got[0]?.line.startsWith("Remembered:Work email· admin@runhq.io")) fail(`remembered line "${got[0]?.line}"`);
      if (!got[1]?.line.startsWith("Updated memory:Compose· Press C")) fail(`updated line "${got[1]?.line}"`);
      if (!got.every((n) => n.oneLine && n.inside)) fail(`memory note layout ${JSON.stringify(got)}`);
      if (!got.every((n) => n.buttons.join() === "Undo")) fail(`memory note buttons ${JSON.stringify(got.map((n) => n.buttons))}`);
      if (!/^Accounts\nWork email: admin@runhq.io/.test(got[0]?.title ?? "") || !/Was: The send button is in the toolbar\.$/.test(got[1]?.title ?? "")) fail("memory note tooltips");
      await checkLayout(p, `memory ${label}`);
      await shoot(p, "panel-memory", size, scheme);

      // Undo: the change is undone (the background pushes memory_undone) and the note says so, with Redo.
      await p.click("#chat-log .ev-memory .mem-undo");
      await p.waitForSelector("#chat-log .ev-memory.undone");
      const sent = (await requests(p, "memory.undo"))[0];
      if (sent?.sessionId !== "s-mem" || sent.changeId !== "c1") fail(`undo sent ${JSON.stringify(sent)}`);
      const [u] = await notes();
      if (!u.undone || u.buttons.join() !== "Redo" || !u.line.startsWith("Undone:")) fail(`undone note ${JSON.stringify(u)}`);
      if ((await p.textContent("#chat-log .ev-memory.undone .mem-note")) !== "Not kept.") fail("undone note text");
      await checkLayout(p, `memory-undone ${label}`);
      await shoot(p, "panel-memory-undone", size, scheme);

      // Redo: the change is made again (memory_redone) and the note is back, with Undo.
      await p.click("#chat-log .ev-memory .mem-redo");
      await p.waitForFunction(() => !document.querySelector("#chat-log .ev-memory.undone"));
      if ((await requests(p, "memory.redo"))[0]?.changeId !== "c1") fail("redo not sent");
      const [r] = await notes();
      if (r.undone || r.buttons.join() !== "Undo" || !r.line.startsWith("Remembered:")) fail(`redone note ${JSON.stringify(r)}`);
      await p.click("#chat-log .ev-memory .mem-undo");
      await p.waitForSelector("#chat-log .ev-memory.undone");

      // The composer's menu: Memory on for this chat; turning it off tells the background and shows the badge.
      await p.click("#now-model");
      await p.waitForSelector("#model-menu .mm-memory");
      const item = () => p.evaluate(() => {
        const b = document.querySelector("#model-menu .mm-memory");
        return { checked: b.getAttribute("aria-checked"), hint: b.querySelector(".mm-hint").textContent, disabled: b.disabled };
      });
      const before = await item();
      if (before.checked !== "true" || before.disabled) fail(`menu switch ${JSON.stringify(before)}`);
      await p.click("#model-menu .mm-memory");
      const off = await eventually(async () => (await item()).checked === "false");
      if (!off || (await item()).hint !== "Off in this chat") fail(`menu switch after click ${JSON.stringify(await item())}`);
      const setOff = (await requests(p, "chat.setMemory"))[0];
      if (setOff?.sessionId !== "s-mem" || setOff.on !== false) fail(`chat.setMemory ${JSON.stringify(setOff)}`);
      await checkLayout(p, `memory-menu ${label}`);
      await shoot(p, "panel-memory-menu", size, scheme);
      await p.keyboard.press("Escape");
      if (!(await eventually(() => shown(p, "#now-memory-off")))) fail("no memory-off badge");
      await checkLayout(p, `memory-off ${label}`);
      await shoot(p, "panel-memory-off", size, scheme);
      // The badge turns memory back on.
      await p.click("#now-memory-off");
      if (!(await eventually(async () => (await requests(p, "chat.setMemory")).some((r) => r.on === true)))) fail("badge did not turn memory on");
      if (!(await eventually(async () => !(await shown(p, "#now-memory-off"))))) fail("badge still shown");

      // A new job (tab 2 has none: the list): the choice waits for its first message, which carries it.
      await p.evaluate(() => window.__activateTab(2));
      await p.waitForSelector("#view-list:not([hidden])");
      await p.click("#now-model");
      await p.click("#model-menu .mm-memory");
      if ((await item()).hint !== "Off for this new chat") fail(`new chat hint ${(await item()).hint}`);
      await p.keyboard.press("Escape");
      await p.fill("#now-text", "What's on my calendar today?");
      await p.press("#now-text", "Enter");
      const adhoc = await eventually(async () => (await requests(p, "run.adhoc")).some((r) => r.memoryOff === true));
      if (!adhoc) fail(`new chat did not carry memory off ${JSON.stringify(await requests(p, "run.adhoc"))}`);
      reportErrors(p, `memory ${label}`);
      await p.close();
    },
  },
  // A fact the background writer saved after the chat, replacing an entry of another subject: it says both, with Undo.
  {
    names: ["panel-memory-auto", "panel-memory-auto-undone"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const paul = memoryEntries().find((e) => e.id === "m5");
      const tom = { ...paul, id: "m11", subject: "Tom Kim", text: "The user's accountant (tom@kimtax.example).", history: undefined };
      const p = await openPanel(ctx, "idle", "#chat-log .ev-memory", {
        edit: (d) => {
          const conv = {
            sessionId: "s-auto", source: "adhoc", title: "Send the invoices", instructions: "Send the September invoices to my new accountant, Paul Lee",
            brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: iso(-3), firstStartedAt: iso(-3), endedAt: iso(-1), outcome: "done", summary: "Sent the invoices to Paul Lee",
          };
          const ev = (m, e) => ({ ...e, ts: iso(m), sessionId: "s-auto" });
          d.sessions.unshift(conv);
          d.eventsBySession["s-auto"] = [
            ev(-3, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
            ev(-1, { type: "assistant_text", text: "Sent the three September invoices to **Paul Lee** (paul@leeandco.example)." }),
            ev(-1, { type: "task_end", outcome: "done", summary: conv.summary }),
            ev(0, { type: "memory", changeId: "c-auto", before: null, after: paul, replaced: tom, auto: true }),
          ];
          d.state.tabChats = { 1: "s-auto" };
          d.memory = [paul];
        },
      });
      const note = () =>
        p.evaluate(() => {
          const n = document.querySelector("#chat-log .ev-memory");
          const line = n.querySelector(".mem-line");
          const kids = [...line.children].filter((k) => k.getBoundingClientRect().width);
          const tops = kids.map((k) => k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2);
          return {
            label: line.querySelector(".mem-label").textContent,
            subject: line.querySelector(".mem-subject").textContent,
            replaced: line.querySelector(".mem-replaced")?.textContent ?? null,
            oneLine: Math.max(...tops) - Math.min(...tops) < 4,
            inside: n.scrollWidth <= n.clientWidth + 1 && n.getBoundingClientRect().right <= document.getElementById("chat-log").getBoundingClientRect().right + 1,
            buttons: [...n.querySelectorAll("button")].map((b) => b.textContent).join(),
            title: line.title,
            undone: n.classList.contains("undone"),
            after: n.querySelector(".mem-note")?.textContent ?? null,
          };
        });
      const got = await note();
      if (got.label !== "Remembered after this chat:" || got.subject !== "Paul Lee") fail(`auto note line ${JSON.stringify(got)}`);
      if (got.replaced !== "replaced “Tom Kim”") fail(`auto note replaced "${got.replaced}"`);
      if (!got.oneLine || !got.inside) fail(`auto note layout ${JSON.stringify(got)}`);
      if (got.buttons !== "Undo") fail(`auto note buttons "${got.buttons}"`);
      if (!/\n\nReplaced Tom Kim: The user's accountant \(tom@kimtax\.example\)\.$/.test(got.title)) fail(`auto note tooltip "${got.title}"`);
      await checkLayout(p, `memory-auto ${label}`);
      await shoot(p, "panel-memory-auto", size, scheme);

      await p.click("#chat-log .ev-memory .mem-undo");
      await p.waitForSelector("#chat-log .ev-memory.undone");
      if ((await requests(p, "memory.undo"))[0]?.changeId !== "c-auto") fail("auto note undo not sent");
      const u = await note();
      if (u.buttons !== "Redo" || u.after !== "Not kept. “Tom Kim” is back.") fail(`auto note undone ${JSON.stringify(u)}`);
      await checkLayout(p, `memory-auto-undone ${label}`);
      await shoot(p, "panel-memory-auto-undone", size, scheme);
      reportErrors(p, `memory-auto ${label}`);
      await p.close();
    },
  },
  // Signed in to another account than this computer's memory was synced with: the TODO tab asks what to do with it.
  {
    names: ["panel-memory-ask"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "account", undefined, { edit: (d) => (d.state = { ...d.state, memoryQuestion: { account: "ada.lovelace@example.com" } }) });
      await p.waitForSelector("#view-list:not([hidden]) #memory-ask:not([hidden])");
      const card = await p.evaluate(() => ({
        text: document.getElementById("memory-ask-text").textContent,
        hint: document.getElementById("memory-ask-hint").textContent,
        buttons: [...document.querySelectorAll("#memory-ask button")].map((b) => b.textContent).join(),
      }));
      if (card.text !== "Add this computer's memory to ada.lovelace@example.com?") fail(`memory question "${card.text}"`);
      if (!/^What the agent learned on this computer goes to that account/.test(card.hint)) fail(`memory question hint "${card.hint}"`);
      if (card.buttons !== "Keep separate,Add") fail(`memory question buttons ${card.buttons}`);
      await checkLayout(p, `memory-ask ${label}`);
      await shoot(p, "panel-memory-ask", size, scheme);
      await p.click("#memory-ask-keep");
      if (!(await eventually(async () => (await requests(p, "memory.syncChoice")).some((r) => r.add === false)))) fail("Keep separate not sent");
      if (!(await eventually(async () => !(await shown(p, "#memory-ask"))))) fail("memory question still shown after the answer");
      if (!(await eventually(async () => /stays separate from ada\.lovelace@example\.com/.test(await p.textContent("#now-notice"))))) fail("no word after Keep separate");
      reportErrors(p, `memory-ask ${label}`);
      await p.close();
    },
  },
];
