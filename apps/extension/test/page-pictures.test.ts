/**
 * In real Chromium: the snapshot's pictures (read_page's list, which save_file takes by address): largest first, the
 * srcset's largest address, a lazy page's data-src, alt text or the figure's caption, the link a picture is in; icons,
 * hidden pictures and data: addresses are left out.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { formatSnapshot } from "@noa/core";
import { snapshotExpression } from "../src/page-snapshot.js";

let browser: Browser;
let page: Page;

/** A PNG of w x h (one color): its header is what the browser needs to know its size. */
async function png(w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w!;
      c.height = h!;
      c.getContext("2d")!.fillRect(0, 0, w!, h!);
      return c.toDataURL("image/png").split(",")[1]!;
    },
    [w, h],
  );
  return Buffer.from(b64, "base64");
}

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const sizes: Record<string, [number, number]> = { "/blank.gif": [1, 1], "/hero.png": [1200, 900], "/hero-2x.png": [2400, 1800], "/side.png": [400, 300], "/icon.png": [16, 16], "/lazy.png": [600, 600], "/hidden.png": [500, 500] };
  const pngs: Record<string, Buffer> = {};
  await page.goto("about:blank");
  for (const [path, [w, h]] of Object.entries(sizes)) pngs[path] = await png(w, h);
  await page.route("http://pics.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (pngs[path]) return route.fulfill({ contentType: "image/png", body: pngs[path] });
    return route.fulfill({
      contentType: "text/html",
      body: `<h1>Lamp</h1>
        <figure><img src="/hero.png" srcset="/hero.png 1200w, /hero-2x.png 2400w" style="width:600px;height:450px"><figcaption>Main photo</figcaption></figure>
        <a href="/products/side"><img src="/side.png" alt="Side view" width="200" height="150"></a>
        <img src="/icon.png" alt="cart" width="16" height="16">
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/lazy.png" alt="Lazy one" width="100" height="100">
        <img src="/blank.gif" data-src="/lazy-2.png" alt="Lazy two" width="90" height="90">
        <img src="/hidden.png" alt="Hidden" width="300" height="300" style="display:none">`,
    });
  });
});
afterAll(async () => {
  await browser?.close();
});

describe("the page's pictures", () => {
  it("are listed largest first with their best address, text, size and link; icons, hidden ones and data: are not", async () => {
    await page.goto("http://pics.test/products/lamp");
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    const snap = (await page.evaluate(snapshotExpression())) as PageSnapshot;
    expect(snap.pictures).toEqual([
      { url: "http://pics.test/hero-2x.png", text: "Main photo", width: 2400, height: 1800, shownWidth: 600, shownHeight: 450 },
      { url: "http://pics.test/side.png", text: "Side view", width: 400, height: 300, shownWidth: 200, shownHeight: 150, link: "http://pics.test/products/side" },
      { url: "http://pics.test/lazy.png", text: "Lazy one", width: 0, height: 0, shownWidth: 100, shownHeight: 100 },
      // A placeholder of its own (a real address) is not the picture either.
      { url: "http://pics.test/lazy-2.png", text: "Lazy two", width: 0, height: 0, shownWidth: 90, shownHeight: 90 },
    ]);
    const text = formatSnapshot(snap);
    expect(text).toContain("--- pictures on this page, largest first (save_file with a picture's address as url keeps it) ---");
    expect(text).toContain('- "Side view" (400x300 px, shown 200x150) http://pics.test/side.png [links to http://pics.test/products/side]');
    expect(text).toContain('- "Lazy one" (size unknown, shown 100x100) http://pics.test/lazy.png');
  });

  it("a page without pictures has none", async () => {
    await page.setContent("<p>Just text</p>");
    expect(((await page.evaluate(snapshotExpression())) as PageSnapshot).pictures).toBeUndefined();
  });
});
