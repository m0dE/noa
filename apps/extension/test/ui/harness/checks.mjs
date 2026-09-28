// What the UI harness checks and records: screenshots, page errors, the panel's layout, the options
// page's checks, and the count of problems found (the harness exits non-zero when there are any).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installChromeStub } from "./chrome-stub.mjs";
import { scenario, tabJobKey } from "./scenarios.mjs";

/** Visible to the user: laid out, and not inside a hidden element or a closed reveal. */
export const shownJs = (sel) => {
  const el = document.querySelector(sel);
  if (!el || !el.getClientRects().length) return false;
  for (let n = el; n; n = n.parentElement) {
    if (n.hidden || n.inert) return false;
    if (n.classList?.contains("reveal") && !n.classList.contains("open")) return false;
  }
  return true;
};
export const shown = (page, sel) => page.evaluate(shownJs, sel);

/** Polls `ok` until it holds or `ms` pass, and says whether it held (for UI that updates after a request is answered). */
export async function eventually(ok, ms = 2000) {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 25))) {
    if (await ok()) return true;
    if (Date.now() > end) return false;
  }
}

/**
 * The harness's checks for pages of `base` in `browser`. `only`: a substring of the screenshot file
 * names to limit the run to (--only); `shots`: where screenshots go.
 */
export function createChecks({ browser, base, only, shots }) {
  mkdirSync(shots, { recursive: true });
  const taken = [];
  let failures = 0;
  /** A problem found: printed, and counted. */
  const problem = (...message) => {
    console.error(...message);
    failures++;
  };
  /** True when --only is unset or matches the screenshot file name for this size and scheme. */
  const want = (name, size, scheme) => !only || `${name}-${size.w}-${scheme}`.includes(only);
  const wantAny = (names, size, scheme) => names.some((n) => want(n, size, scheme));

  async function shoot(page, name, size, scheme) {
    if (!want(name, size, scheme)) return;
    const file = join(shots, `${name}-${size.w}-${scheme}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    taken.push(file);
  }

  /**
   * Opens the side panel on a scenario; `opts.edit` changes its canned data, `opts.init` are more init scripts (e.g.
   * installVoiceFakes). The panel opens on the jobs list; `opts.job` opens a job's page first: a job key, or "tab" for
   * the job of the conversation the panel's tab has (bound to tab 1, or running there). Without `opts.job`, a
   * `waitFor` in the conversation (#chat-log, .ev-*) opens the tab's job, anything else waits on the list.
   */
  async function openPanel(ctx, kind, waitFor = "#job-groups > *", opts = {}) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const data = scenario(kind);
    opts.edit?.(data);
    for (const init of opts.init ?? []) await page.addInitScript(init);
    await page.addInitScript(installChromeStub, data);
    await page.goto(`${base}/sidepanel.html${opts.search ?? ""}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const job = opts.job ?? (/#chat-log|\.ev-/.test(waitFor) ? "tab" : null);
    try {
      await page.waitForSelector("#job-groups > *", { state: "attached" });
      if (job) await openJob(page, job === "tab" ? tabJobKey(data) : job);
      // "attached": rows inside a folded steps group are in the log but not visible.
      await page.waitForSelector(waitFor, { state: "attached" });
    } catch (err) {
      console.error(`panel did not load (${kind}):`, errors);
      throw err;
    }
    page.errors = errors;
    return page;
  }

  /** Opens a job's page from the list (its row), and waits for the page. */
  async function openJob(page, key) {
    if (!(await page.isVisible("#view-list"))) await backToList(page);
    const row = page.locator(`.job-row[data-key="${key}"]`);
    // A scheduled job Home's Upcoming leaves out (it shows the soonest 3) is in the Scheduled view.
    if (!(await row.count()) && !(await page.locator("#job-search").inputValue())) await page.click("#view-scheduled");
    await row.click();
    await page.waitForSelector("#view-job:not([hidden])");
  }

  /** Back to the list ("‹"). */
  async function backToList(page) {
    await page.click("#job-back");
    await page.waitForSelector("#view-list:not([hidden])");
  }

  function reportErrors(page, label) {
    if (page.errors.length) problem(`page errors (${label}):`, page.errors);
  }

  /** The composer sits flush at the bottom, nothing overlaps it, nothing in it is clipped. */
  async function checkLayout(page, label) {
    const problems = await page.evaluate(() => {
      const out = [];
      const comp = document.getElementById("composer");
      const main = document.querySelector("main");
      if (document.documentElement.scrollWidth > window.innerWidth) out.push("horizontal page scroll");
      // The header stays on one line, inside the panel.
      const one = (sel, what) => {
        const row = document.querySelector(sel);
        if (!row || !row.offsetParent) return;
        const r = row.getBoundingClientRect();
        const kids = [...row.children].filter((k) => k.getBoundingClientRect().width);
        const mid = kids.map((k) => k.getBoundingClientRect()).map((b) => (b.top + b.bottom) / 2);
        for (const [i, k] of kids.entries()) {
          const b = k.getBoundingClientRect();
          if (Math.abs(mid[i] - mid[0]) > 2) out.push(`${what}: ${k.id || k.className} is not on the header's line`);
          if (b.right > r.right + 0.5 || b.left < r.left - 0.5) out.push(`${what}: ${k.id || k.className} clipped`);
        }
      };
      one("#list-head", "list header");
      one("#job-head", "job header");
      // The view switch and the search share one line; the search stays wide enough to type in.
      one("#view-list:not([hidden]) .list-bar", "list bar");
      const search = document.querySelector("#view-list:not([hidden]) #job-search");
      if (search && search.offsetParent && search.getBoundingClientRect().width < 96) out.push(`search field only ${Math.round(search.getBoundingClientRect().width)}px wide`);
      // Rows are one tight line (a quiet second line at most), nothing spilling sideways.
      for (const row of document.querySelectorAll("#view-list:not([hidden]) .job-row")) {
        const r = row.getBoundingClientRect();
        if (r.height > 46) out.push(`row ${row.dataset.key} is ${Math.round(r.height)}px tall`);
        if (row.scrollWidth > row.clientWidth + 1) out.push(`row ${row.dataset.key} spills sideways`);
      }
      // The composer is under both views.
      if (comp.hidden) out.push("composer hidden");
      if (comp.hidden) return out;
      const c = comp.getBoundingClientRect();
      if (Math.abs(c.bottom - window.innerHeight) > 1) out.push(`composer bottom ${c.bottom} != viewport ${window.innerHeight}`);
      if (main.getBoundingClientRect().bottom > c.top + 1) out.push("main overlaps the composer");
      for (const el of comp.querySelectorAll("button, input:not([type=file]), label, textarea")) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right > c.right + 0.5 || r.left < c.left - 0.5) out.push(`#${el.id} clipped horizontally`);
      }
      // The model chip sits on one row with the other controls.
      const bar = comp.querySelector(".now-bar").getBoundingClientRect();
      for (const el of comp.querySelectorAll(".now-bar > *:not([hidden])")) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5)) out.push(`${el.id || el.className} wraps out of the control row`);
      }
      // Notices sit in the layout directly above the box: never floating, never over the
      // text box or any of its controls, never over each other.
      const form = document.getElementById("now-form");
      const f = form.getBoundingClientRect();
      const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      const name = (el) => el.id || el.className;
      const notes = [...document.querySelectorAll("#now-notices > *")].filter((el) => !el.hidden && el.getBoundingClientRect().height);
      const controls = [document.getElementById("now-text"), ...form.querySelectorAll("button, label, [role=button]")].filter((el) => el.getBoundingClientRect().width);
      for (const [i, n] of notes.entries()) {
        const r = n.getBoundingClientRect();
        const pos = getComputedStyle(n).position;
        if (pos === "absolute" || pos === "fixed") out.push(`${name(n)} floats (position: ${pos})`);
        if (r.bottom > f.top + 0.5) out.push(`${name(n)} reaches into the input box (${Math.round(r.bottom)} > ${Math.round(f.top)})`);
        if (r.left < c.left - 0.5 || r.right > c.right + 0.5) out.push(`${name(n)} clipped horizontally`);
        for (const el of controls) if (hit(r, el.getBoundingClientRect())) out.push(`${name(n)} covers ${name(el)}`);
        for (const other of notes.slice(i + 1)) if (hit(r, other.getBoundingClientRect())) out.push(`${name(n)} overlaps ${name(other)}`);
      }
      if (document.querySelectorAll("#now-notice:not([hidden])").length > 1) out.push("more than one notice shown");
      const menu = document.getElementById("model-menu");
      if (!menu.hidden) {
        const m = menu.getBoundingClientRect();
        if (m.left < 0 || m.right > window.innerWidth || m.top < 0) out.push("model menu off screen");
      }
      return out;
    });
    if (!problems.length) return;
    problem(`layout (${label}):`, problems);
  }

  /** Opens options.html (with a hash) on a scenario; `edit` changes the canned data first, `init` are more init scripts. */
  async function openOptions(size, scheme, kind, hash = "", edit = () => {}, init = []) {
    // Reduced motion: reveals open and close at once (options.css honours it), so checks need no settling time.
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: scheme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const data = scenario(kind);
    edit(data);
    for (const script of init) await page.addInitScript(script);
    await page.addInitScript(installChromeStub, data);
    await page.goto(`${base}/options.html${hash}`);
    await page.waitForSelector("#helper-headline:not(:empty)", { state: "attached" });
    page.errors = errors;
    page.ctx = ctx;
    return page;
  }

  async function optChecks(page, label, checks) {
    const problems = [];
    for (const [what, ok] of checks) if (!(await ok())) problems.push(what);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) problems.push("horizontal page scroll");
    if (page.errors.length) problems.push(`page errors: ${page.errors.join("; ")}`);
    if (problems.length) {
      problem(`options (${label}):`, problems);
    }
  }

  async function optShot(page, name, size, scheme) {
    const file = join(shots, `${name}-${size.w}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    taken.push(file);
  }

  return {
    base,
    shots,
    taken,
    only,
    problem,
    failures: () => failures,
    want,
    wantAny,
    shoot,
    openPanel,
    openJob,
    backToList,
    reportErrors,
    checkLayout,
    openOptions,
    optChecks,
    optShot,
  };
}
