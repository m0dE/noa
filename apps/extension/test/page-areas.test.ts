/**
 * In real Chromium: the snapshot's scrollable areas (a list that draws only the rows in view, scrolled to the middle),
 * the box a scroll inside an element steps by, and which fields search as you type.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS } from "../src/driver-common.js";
import { scrollViewInPage, searchFieldInPage } from "../src/page-input.js";
import { snapshotExpression } from "../src/page-snapshot.js";
import type { PageResult } from "../src/scroll-probe.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
});
afterAll(async () => {
  await browser?.close();
});

const NAMES = Array.from({ length: 20 }, (_, i) => `Team ${String.fromCharCode(65 + i)}`);
const LIST = `<div role="dialog" aria-modal="true" style="position:fixed;top:20px;left:20px;width:300px;background:#fff">
  <b>Teams</b><div id="list" style="height:180px;overflow-y:auto;position:relative"><div style="height:${NAMES.length * 30}px"></div></div></div>
  <script>
  const list = document.getElementById("list");
  const names = ${JSON.stringify(NAMES)};
  const draw = () => {
    list.querySelectorAll(".row").forEach((r) => r.remove());
    const first = Math.floor(list.scrollTop / 30);
    for (let i = first; i < Math.min(names.length, first + 6); i++) {
      const r = document.createElement("div"); r.className = "row"; r.tabIndex = 0; r.textContent = names[i];
      r.style.cssText = "position:absolute;left:0;right:0;height:30px;top:" + i * 30 + "px";
      list.append(r);
    }
  };
  list.addEventListener("scroll", draw);
  list.scrollTop = 270;
  draw();
  </script>`;

const snapshot = () => page.evaluate(snapshotExpression()) as Promise<PageSnapshot>;

describe("scrollable areas", () => {
  it("a list scrolled to its middle is reported with what it shows and what is hidden, with a number", async () => {
    await page.setContent(LIST);
    const snap = await snapshot();
    expect(snap.areas).toHaveLength(1);
    const area = snap.areas![0]!;
    expect(area).toMatchObject({ label: "Teams", first: "Team J", last: "Team O", height: 180, above: 270, below: 150, inDialog: true });
    expect(area.index).toBeGreaterThanOrEqual(snap.elements.length);
    // A scroll inside it steps by its own height, not the window's.
    const view = (await page.evaluate(`(${scrollViewInPage.toString()})(${JSON.stringify(PAGE_MARKS)}, ${area.index})`)) as PageResult<{ stepH: number; h: number }>;
    expect(view).toMatchObject({ ok: true, value: { stepH: 180, h: 800 } });
  });

  it("a page whose boxes show all they hold has none", async () => {
    await page.setContent(`<div style="height:180px;overflow-y:auto"><p>one</p><p>two</p></div><button>OK</button>`);
    expect((await snapshot()).areas).toBeUndefined();
  });
});

describe("searchFieldInPage", () => {
  const fields = `<input id="a" type="search"><div role="search"><input id="b"></div><input id="c" placeholder="Filter accounts">
    <label>Search <input id="d"></label><input id="e" aria-autocomplete="list"><input id="f" placeholder="Email"><input id="g" name="first_name">`;
  it("is true for search fields by HTML or label, false for other fields", async () => {
    await page.setContent(fields);
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    await page.evaluate((list) => list.forEach((id, i) => document.getElementById(id)!.setAttribute("data-noa-index", String(i))), ids);
    const answers: Record<string, boolean> = {};
    for (const [i, id] of ids.entries()) {
      const r = (await page.evaluate(`(${searchFieldInPage.toString()})(${JSON.stringify(PAGE_MARKS)}, ${i})`)) as PageResult<boolean>;
      answers[id] = r.ok && r.value;
    }
    expect(answers).toEqual({ a: true, b: true, c: true, d: true, e: true, f: false, g: false });
  });
});
