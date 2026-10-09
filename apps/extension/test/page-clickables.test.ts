/**
 * read_page and things a page made clickable with a script instead of HTML: like the CrazyGames
 * Developer Portal's My Games table (Oct 1), whose rows open the game on a click but are plain <tr>s
 * styled cursor: pointer. Without them in the snapshot no tool could click the row.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS } from "../src/driver-common.js";
import { snapshotPage } from "../src/page-snapshot.js";

const GAMES = `<!doctype html><html><head><title>My Games</title>
<style>.row { cursor: pointer } .card { cursor: pointer; padding: 8px } button { cursor: pointer }</style></head><body>
<a href="/submit">Submit a game</a>
<table><thead><tr><th>Game</th><th>Game status</th></tr></thead><tbody>
<tr class="row" onclick="document.title = 'opened mecha'"><td><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><span>Mecha Royale</span></td><td><span>Draft</span></td></tr>
<tr class="row" onclick="document.title = 'opened other'"><td><span>Other Game</span></td><td><span>Published</span></td></tr>
</tbody></table>
<div class="card"><button>Only a wrapper</button></div>
<p>Plain text, not clickable</p>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(GAMES);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const snapshot = () => page.evaluate(`(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30)`) as Promise<PageSnapshot>;

describe("snapshotPage: script-made clickables", () => {
  it("lists a table row styled cursor: pointer once, as the row, and clicking its mark opens it", async () => {
    const snap = await snapshot();
    const rows = snap.elements.filter((e) => /Mecha Royale/.test(e.name));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tag: "tr", role: "row" });
    expect(snap.elements.some((e) => /Other Game/.test(e.name))).toBe(true);
    await page.click(`[${PAGE_MARKS.attr}="${rows[0]!.index}"]`);
    expect(await page.title()).toBe("opened mecha");
  });

  it("leaves out a pointer wrapper around a control already listed, and plain text", async () => {
    const snap = await snapshot();
    expect(snap.elements.filter((e) => /Only a wrapper/.test(e.name))).toHaveLength(1);
    expect(snap.elements.find((e) => /Only a wrapper/.test(e.name))!.tag).toBe("button");
    expect(snap.elements.some((e) => /Plain text/.test(e.name))).toBe(false);
  });
});
