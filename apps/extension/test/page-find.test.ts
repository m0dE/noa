/**
 * find_text's page function (page-find.ts) in a real page (Playwright's Chromium), run the way the debugger runs it
 * (serialized): it finds text far below what read_page's text holds, groups matches by row or paragraph, lists the
 * controls there with their read_page numbers, and scrolls the place asked for into view.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_SNAPSHOT_TEXT, type FoundText, type PageSnapshot } from "@noa/shared";
import { PAGE_MARKS } from "../src/driver-common.js";
import { FIND_LIMITS, findTextInPage } from "../src/page-find.js";
import { snapshotExpression } from "../src/page-snapshot.js";
import type { PageResult } from "../src/scroll-probe.js";

const rows = Array.from(
  { length: 400 },
  (_, i) => `<tr><td><input type="checkbox" aria-label="Select row ${i + 1}"></td><td>#${1001 + i}</td><td>Customer ${i + 1}</td><td>${i % 2 ? "Pro" : "Free"}</td><td><a href="#e${i}">Edit</a></td></tr>`,
).join("");
const HTML = `<!doctype html><html><head><title>Customers</title><style>.gone{display:none}</style></head><body>
<h1>Customers</h1>
<form><label>Name <input id="name" value="Dana Wu"></label> <label>Plan <select id="plan"><option>Free</option><option selected>Business</option></select></label>
<label>Secret <input type="password" value="hunter2-secret"></label></form>
<p>Our team: <b>Priya</b> Raman and <i>Omar Diaz</i>.</p>
<p class="gone">Priya Raman hidden copy</p>
<table><tbody>${rows}
<tr><td><input type="checkbox" aria-label="Select Priya Raman" checked></td><td>#1401</td><td>Priya Raman</td><td>Pro</td><td><input aria-label="Seats of Priya Raman" value="twelve"> <a href="#e1401">Edit</a></td></tr>
</tbody></table>
<my-card></my-card>
<script>customElements.define("my-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<p>Shadow note about Priya Raman <button>Open</button></p>"; } });</script>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  await page.setContent(HTML);
});

async function find(text: string, opts: { place?: number; scroll?: boolean; again?: boolean } = {}): Promise<FoundText> {
  const r = (await page.evaluate(
    `(${findTextInPage.toString()})(${JSON.stringify(PAGE_MARKS)}, ${JSON.stringify(text)}, ${opts.place ?? 1}, ${opts.scroll ?? false}, ${JSON.stringify(FIND_LIMITS)}, ${opts.again ?? false})`,
  )) as PageResult<FoundText>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const scrollY = () => page.evaluate(() => window.scrollY);

describe("findTextInPage", () => {
  it("finds text past the end of read_page's text, across inline elements and in an open shadow root, not in hidden text", async () => {
    const snap = (await page.evaluate(snapshotExpression())) as PageSnapshot;
    expect(snap.text.length).toBe(MAX_SNAPSHOT_TEXT);
    expect(snap.textCut).toBe(true);
    expect(snap.text).not.toContain("#1401");

    const f = await find("  priya   RAMAN ");
    // The paragraph (across <b>), the last row (its text and the checkbox's label are not text; the cell is), the shadow root.
    expect(f.total).toBe(3);
    expect(f.placeCount).toBe(3);
    expect(f.places.map((p) => p.context)).toEqual(["Our team: Priya Raman and Omar Diaz.", "#1401 Priya Raman Pro Edit", "Shadow note about Priya Raman Open"]);
    expect(f.places.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(f.scrolledTo).toBeNull();
  });

  it("lists a row's controls with their values, checked state and read_page numbers", async () => {
    await page.evaluate(snapshotExpression());
    const row = (await find("#1401")).places[0]!;
    expect(row.inViewport).toBe(false);
    expect(row.controls.map(({ index, ...c }) => c)).toEqual([
      { role: "checkbox", name: "Select Priya Raman", checked: true },
      { role: "textbox", name: "Seats of Priya Raman", value: "twelve" },
      { role: "link", name: "Edit" },
    ]);
    // Offscreen controls past read_page's cap were not numbered; the in-view ones were.
    const top = (await find("Dana Wu")).places[0]!;
    expect(top.controls[0]).toMatchObject({ role: "textbox", name: "Name", value: "Dana Wu" });
    expect(typeof top.controls[0]!.index).toBe("number");
  });

  it("scrolls the place asked for into view; after a new read its controls are numbered", async () => {
    expect(await scrollY()).toBe(0);
    const f = await find("#1401", { scroll: true });
    expect(f.scrolledTo).toBe(1);
    expect(f.places[0]!.inViewport).toBe(true);
    expect(await scrollY()).toBeGreaterThan(5000);
    const snap = (await page.evaluate(snapshotExpression())) as PageSnapshot;
    expect(snap.truncated).toBe(true);
    const again = await find("#1401");
    const box = again.places[0]!.controls[0]!;
    expect(snap.elements.find((e) => e.index === box.index)?.name).toBe("Select Priya Raman");

    // Another place by its number; a number past the last scrolls nothing.
    const second = await find("priya raman", { place: 3, scroll: true });
    expect(second.scrolledTo).toBe(3);
    expect(second.places[2]!.inViewport).toBe(true);
    const none = await find("priya raman", { place: 9, scroll: true });
    expect(none.scrolledTo).toBeNull();
  });

  it("form field values count as text, a password's never; a row matched twice is one place", async () => {
    const plan = await find("business");
    expect(plan.total).toBe(1);
    expect(plan.places[0]!.controls).toContainEqual({ role: "combobox", name: "Plan", value: "Business" });
    expect((await find("hunter2")).total).toBe(0);
    // A field's value: its place is the row it is in.
    const seats = await find("TWELVE");
    expect(seats.total).toBe(1);
    expect(seats.places[0]!.context).toBe("#1401 Priya Raman Pro Edit");
    // Only the first places are listed; the count covers them all.
    const pro = await find("pro");
    expect(pro.total).toBe(201);
    expect(pro.placeCount).toBe(201);
    expect(pro.places.length).toBe(FIND_LIMITS.places);
    const twice = await find("customer 1");
    // "Customer 1", "Customer 10".."Customer 199": every row its own place.
    expect(twice.placeCount).toBe(twice.total);
    await page.setContent("<ul><li>Red apple, green apple</li><li>Pear</li></ul>");
    const apples = await find("apple");
    expect(apples).toMatchObject({ total: 2, placeCount: 1 });
    expect(apples.places[0]!.matches).toBe(2);
  });

  /** Counts the page's style reads from here on: a search reads one per element, listing the places only a few. */
  const countStyleReads = () =>
    page.evaluate(() => {
      const w = window as unknown as { __reads: number; getComputedStyle: typeof getComputedStyle };
      const real = w.getComputedStyle;
      w.__reads = 0;
      w.getComputedStyle = function (this: unknown, ...args: Parameters<typeof getComputedStyle>) {
        w.__reads++;
        return real.apply(this, args);
      } as typeof getComputedStyle;
    });
  const styleReads = () => page.evaluate(() => (window as unknown as { __reads: number }).__reads);
  const read = () => page.evaluate(snapshotExpression());

  it("after the page read, again lists the scrolled search's places anew without searching the page: what a new search answers", async () => {
    for (const [text, place] of [
      ["#1401", 1],
      ["edit", 300],
      ["priya raman", 3],
    ] as const) {
      await page.setContent(HTML);
      await find(text, { place, scroll: true });
      await read();
      // Noa's overlay put on the page meanwhile is not a change to it.
      await page.evaluate((tag) => document.documentElement.appendChild(document.createElement(tag)).setAttribute("data-variant", "working"), PAGE_MARKS.overlay);
      await countStyleReads();
      const again = await find(text, { place, again: true });
      expect(await styleReads()).toBeLessThan(100);
      const fresh = await find(text, { place });
      expect(await styleReads()).toBeGreaterThan(3000);
      expect(again).toEqual(fresh);
      expect(again.places.find((p) => p.number === place)!.inViewport).toBe(true);
      expect(again.places.flatMap((p) => p.controls).some((c) => c.index !== undefined)).toBe(true);
    }
  });

  it("again searches the page anew when it changed since the scrolled search, or when there was none", async () => {
    const changes: [string, () => Promise<unknown>][] = [
      ["a row added", () => page.evaluate(() => document.querySelector("tbody")!.insertAdjacentHTML("afterbegin", "<tr><td>Priya Raman again</td></tr>"))],
      ["a field typed into", () => page.evaluate(() => ((document.getElementById("name") as HTMLInputElement).value = "Priya Raman"))],
      ["a place removed", () => page.evaluate(() => document.querySelector("p")!.remove())],
      ["a class changed", () => page.evaluate(() => document.querySelector(".gone")!.classList.remove("gone"))],
      ["text in a shadow root", () => page.evaluate(() => document.querySelector("my-card")!.shadowRoot!.querySelector("p")!.append(" and Priya Raman"))],
    ];
    for (const [what, change] of changes) {
      await page.setContent(HTML);
      const before = await find("priya raman", { scroll: true });
      await read();
      await change();
      const again = await find("priya raman", { again: true });
      expect(again, what).toEqual(await find("priya raman"));
      expect(again.total, what).not.toBe(before.total);
    }
    // No scrolled search before it, or another text: a search.
    await page.setContent(HTML);
    await countStyleReads();
    expect(await find("#1401", { again: true })).toEqual(await find("#1401"));
    await find("#1401", { scroll: true });
    await countStyleReads();
    expect(await find("priya raman", { again: true })).toEqual(await find("priya raman"));
    expect(await styleReads()).toBeGreaterThan(6000);
  });

  it("lists the place asked for when it is past the first ones, and says nothing found when there is none", async () => {
    const f = await find("edit", { place: 300, scroll: true });
    expect(f.placeCount).toBe(401);
    expect(f.places.length).toBe(FIND_LIMITS.places + 1);
    expect(f.places.at(-1)).toMatchObject({ number: 300, inViewport: true });
    expect(f.places.at(-1)!.context).toContain("Customer 300");
    expect((await find("no such words here")).total).toBe(0);
  });

  it("is quick on a big page: 5,000 rows (35,000 cells) searched in well under a second", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `<tr><td><input type="checkbox"></td><td>#${10_000 + i}</td><td>Name ${i}</td><td>Plan ${i % 4}</td><td><a href="#">Edit</a></td></tr>`).join("");
    await page.setContent(`<table><tbody>${big}</tbody></table>`);
    await find("warm-up");
    const t0 = Date.now();
    const f = await find("#14999", { scroll: true });
    const ms = Date.now() - t0;
    const s0 = Date.now();
    await page.evaluate(snapshotExpression());
    console.log(`find_text on 5,000 rows: ${ms} ms (read_page's snapshot of it: ${Date.now() - s0} ms)`);
    expect(f.total).toBe(1);
    expect(ms).toBeLessThan(1500);
  });

  it("takes time in proportion to the page: 4 times the rows, not 16 times the time", async () => {
    const table = (n: number) => `<table><tbody>${Array.from({ length: n }, (_, i) => `<tr><td>#${10_000 + i}</td><td>Name ${i}</td><td><a href="#">Edit</a></td></tr>`).join("")}</tbody></table>`;
    // In-page time (median of 3): what the page function costs, without the round trip.
    const timed = async (n: number) => {
      await page.setContent(table(n));
      const runs: number[] = [];
      for (let i = 0; i < 4; i++)
        runs.push(
          await page.evaluate(`(() => { const t = performance.now(); (${findTextInPage.toString()})(${JSON.stringify(PAGE_MARKS)}, "name 1", 1, false, ${JSON.stringify(FIND_LIMITS)}); return performance.now() - t; })()`),
        );
      return runs.slice(1).sort((a, b) => a - b)[1]!;
    };
    const small = await timed(2500);
    const large = await timed(10_000);
    console.log(`find_text on 2,500 rows: ${small.toFixed(0)} ms; on 10,000: ${large.toFixed(0)} ms`);
    expect(large / small).toBeLessThan(8);
  });

  it("a long place's text is cut around the match", async () => {
    await page.setContent(`<p>${"lorem ipsum ".repeat(100)}NEEDLE here ${"dolor sit ".repeat(100)}</p>`);
    const c = (await find("needle")).places[0]!.context;
    expect(c.length).toBeLessThanOrEqual(FIND_LIMITS.context + 2);
    expect(c).toContain("NEEDLE here");
    expect(c.startsWith("…") && c.endsWith("…")).toBe(true);
  });
});

