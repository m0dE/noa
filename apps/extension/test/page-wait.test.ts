/**
 * wait_for's page function (page-wait.ts) in a real page (Playwright's Chromium), run the way the debugger runs
 * it (serialized, awaited): it answers as soon as the page changes to meet a condition, not on a timer.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WaitCondition } from "@noa/shared";
import { waitInPage, type PageWait, type PageWaitArgs } from "../src/page-wait.js";
import type { PageResult } from "../src/scroll-probe.js";

const HTML = `<!doctype html><html><head><title>Builder</title><style>.gone{display:none}</style></head><body>
<main><h1>Deploys</h1><p id="status">Building version 2...</p>
<button id="deploy" disabled>Deploy again</button><div id="toast" class="gone">Saved</div><span aria-label="Spinner" id="spin">...</span></main>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  await page.setContent(HTML);
});

/** One slice in the page, as the debugger runs it; `later` runs in the page right after it started. */
async function slice(until: WaitCondition[], opts: { timeoutMs?: number; baseline?: string | null; later?: string } = {}): Promise<{ r: PageResult<PageWait>; ms: number }> {
  const args: PageWaitArgs = { until, timeoutMs: opts.timeoutMs ?? 3000, baseline: opts.baseline ?? null, settleMs: 300, minGapMs: 50, pollMs: [100, 1000] };
  const started = Date.now();
  const run = page.evaluate(`(${waitInPage.toString()})(${JSON.stringify(args)})`) as Promise<PageResult<PageWait>>;
  if (opts.later) await page.evaluate(opts.later);
  const r = await run;
  return { r, ms: Date.now() - started };
}

const met = (r: PageResult<PageWait>) => (r.ok ? r.value.met : r.error);

describe("waitInPage", () => {
  it("text appears: answers when the page shows it (any of several conditions; case and spacing aside)", async () => {
    const { r, ms } = await slice([{ kind: "text_appears", text: "build failed" }, { kind: "text_appears", text: "version 2   IS LIVE" }], {
      later: "setTimeout(() => { document.getElementById('status').textContent = 'Deployed: version 2 is live'; }, 200)",
    });
    expect(met(r)).toBe(1);
    expect(ms).toBeLessThan(1500);
  });

  it("text gone, only inside a selector", async () => {
    const { r } = await slice([{ kind: "text_gone", text: "Building", selector: "#status" }], { later: "setTimeout(() => { document.getElementById('status').textContent = 'Done'; }, 150)" });
    expect(met(r)).toBe(0);
    // Elsewhere on the page it does not count.
    const none = await slice([{ kind: "text_appears", text: "Deploys", selector: "#status" }], { timeoutMs: 400 });
    expect(met(none.r)).toBeNull();
  });

  it("an element by its label becomes enabled; one by selector becomes visible through a class change", async () => {
    const enabled = await slice([{ kind: "element", text: "Deploy again", state: "enabled" }], { later: "setTimeout(() => document.getElementById('deploy').removeAttribute('disabled'), 150)" });
    expect(met(enabled.r)).toBe(0);
    const shown = await slice([{ kind: "element", selector: "#toast" }], { later: "setTimeout(() => document.getElementById('toast').className = '', 150)" });
    expect(met(shown.r)).toBe(0);
    const hidden = await slice([{ kind: "element", text: "Spinner", state: "hidden" }], { later: "setTimeout(() => document.getElementById('spin').remove(), 150)" });
    expect(met(hidden.r)).toBe(0);
  });

  it("page changed: only once the page differs from the baseline and has stopped changing", async () => {
    const first = await slice([{ kind: "page_changed" }], { timeoutMs: 400 });
    expect(met(first.r)).toBeNull();
    const baseline = first.r.ok ? first.r.value.fingerprint : "";
    expect(baseline).not.toBe("");
    const { r, ms } = await slice([{ kind: "page_changed" }], {
      baseline,
      later: "let n = 0; const t = setInterval(() => { document.getElementById('status').textContent = 'step ' + (++n); if (n === 5) clearInterval(t); }, 100)",
    });
    expect(met(r)).toBe(0);
    // Five changes 100 ms apart, then 300 ms quiet.
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r.ok && r.value.fingerprint).toBe(baseline);
  });

  it("nothing happens: answers none after its time, with the page's fingerprint", async () => {
    const { r, ms } = await slice([{ kind: "text_appears", text: "never" }], { timeoutMs: 500 });
    expect(r).toMatchObject({ ok: true, value: { met: null } });
    expect(ms).toBeGreaterThanOrEqual(450);
  });

  it("the URL changes (a single-page app): answers at once so the driver checks url_matches", async () => {
    const { r, ms } = await slice([{ kind: "url_matches", text: "/done" }], { later: "setTimeout(() => history.pushState({}, '', '#/done'), 100)" });
    expect(met(r)).toBeNull();
    expect(ms).toBeLessThan(1500);
  });

  it("a bad selector is an error; a new slice stops one still running", async () => {
    expect(met((await slice([{ kind: "element", selector: "#[" }])).r)).toBe('selector "#[" is not a valid CSS selector');
    const args = (timeoutMs: number): PageWaitArgs => ({ until: [{ kind: "text_appears", text: "never" }], timeoutMs, baseline: null, settleMs: 300, minGapMs: 50, pollMs: [100, 1000] });
    const started = Date.now();
    const old = page.evaluate(`(${waitInPage.toString()})(${JSON.stringify(args(10_000))})`);
    await page.evaluate(`(${waitInPage.toString()})(${JSON.stringify(args(100))})`);
    expect(await old).toMatchObject({ ok: true, value: { met: null } });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
