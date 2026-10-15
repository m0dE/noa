/**
 * read_page in real Chromium: what a button declares it opens (aria-haspopup, aria-expanded), which the approval gate
 * lets through as only showing choices, and the post, dialog or labelled section each element is in (contexts),
 * which the approval card shows as what the action acts on.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS } from "../src/driver-common.js";
import { snapshotPage } from "../src/page-snapshot.js";

const PAGE = `<main>
<article data-testid="tweet"><div>Carla @carla</div><p>Our tide tables now cover every harbour on the coast.</p>
  <div role="group"><button aria-label="0 reposts. Repost" aria-haspopup="menu" aria-expanded="false">0</button>
  <button aria-label="Like">Like</button><button aria-haspopup="true">More</button><button aria-haspopup="nonsense">Odd</button></div></article>
<article><p>Second post by Dan</p><button aria-label="Like">Like</button></article>
<section aria-label="Who to follow"><button>Follow</button></section>
<button id="loose">Settings</button>
</main>`;

let browser: Browser;
let tab: Page;
let snap: PageSnapshot;

beforeAll(async () => {
  browser = await chromium.launch();
  tab = await browser.newPage();
  await tab.setContent(PAGE);
  snap = await tab.evaluate(([fn, marks]) => new Function(`return (${fn})`)()(marks, 8000, 300, 50, 160, 60), [snapshotPage.toString(), PAGE_MARKS] as const);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const find = (name: string, nth = 0) => snap.elements.filter((e) => e.name === name)[nth]!;

describe("read_page: popups and contexts", () => {
  it("says what a button opens and whether it is open; ignores values that are not a popup", () => {
    expect(find("0 reposts. Repost")).toMatchObject({ popup: "menu", expanded: false });
    expect(find("More")).toMatchObject({ popup: "menu" });
    expect(find("Odd")).not.toHaveProperty("popup");
    expect(find("Like")).not.toHaveProperty("popup");
    expect(find("Like")).not.toHaveProperty("expanded");
  });

  it("names the post or labelled section each element is in, once per container", () => {
    const repost = find("0 reposts. Repost");
    expect(snap.contexts![repost.context!]).toMatch(/^Carla @carla Our tide tables now cover every harbour/);
    expect(find("Like").context).toBe(repost.context);
    expect(snap.contexts![find("Like", 1).context!]).toBe("Second post by Dan Like");
    expect(snap.contexts![find("Follow").context!]).toBe("Who to follow: Follow");
    expect(find("Settings")).not.toHaveProperty("context");
    expect(snap.contexts).toHaveLength(3);
  });
});
