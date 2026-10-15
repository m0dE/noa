/**
 * The page behind an open modal dialog, in real Chromium. Clicks and typing by number reached it although a person
 * could not: a click on the page's search box landed on the dialog's backdrop, and typing then focused the box from
 * script and filled it (an aria-modal dialog), or emptied an inert field (a <dialog> opened with showModal). read_page
 * marks such elements covered, and coverInPage (which clicking and typing check first) names the dialog in the way.
 * A dialog that leaves the page reachable, modal or not, covers nothing.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coveredText, type PageSnapshot } from "@noa/shared";
import { CdpActions } from "../src/cdp-actions.js";
import type { Cdp } from "../src/cdp.js";
import { PAGE_MARKS } from "../src/driver-common.js";
import { coverInPage } from "../src/page-cover.js";
import { snapshotPage } from "../src/page-snapshot.js";

const PAGE = `<h1>Billing</h1><input id="search" type="search" placeholder="Search invoices"><button id="save">Save</button>
<div style="height: 3000px"></div><button id="far">Download all</button>`;
const FIELDS = `<h2 id="t">Add billing contact</h2><label>Email <input id="email"></label><button id="add">Add</button>`;
const BOX = "position: fixed; top: 200px; left: 300px; width: 300px; background: white; z-index: 9";

const cases = {
  native: `${PAGE}<dialog id="dlg" aria-labelledby="t">${FIELDS}</dialog><script>dlg.showModal()</script>`,
  aria: `${PAGE}<div style="position: fixed; inset: 0; background: #0005; z-index: 8"></div><div id="dlg" role="dialog" aria-modal="true" aria-labelledby="t" style="${BOX}">${FIELDS}</div>`,
  // aria-modal, but nothing over the page: a person can click it.
  ariaOpen: `${PAGE}<div id="dlg" role="dialog" aria-modal="true" aria-labelledby="t" style="${BOX}">${FIELDS}</div>`,
  // A non-modal panel (no aria-modal), e.g. a popover or chat widget.
  popover: `${PAGE}<div id="dlg" role="dialog" aria-labelledby="t" style="${BOX}">${FIELDS}</div>`,
};

let browser: Browser;
let tab: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  tab = await browser.newPage({ viewport: { width: 1200, height: 800 } });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const snapshot = () => tab.evaluate(`(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30)`) as Promise<PageSnapshot>;
/**
 * coverInPage before a click, its cover alone; the free point it gives at the center of the element's part in the
 * window as null (nothing over its center), so a point elsewhere says something lies over the center.
 */
const cover = (index: number) =>
  tab.evaluate(`(() => {
    const out = (${coverInPage.toString()})(${JSON.stringify(PAGE_MARKS)}, ${index}, "click");
    if (!out.ok) return out;
    const c = out.value.cover;
    const n = ${JSON.stringify(String(index))};
    const el = document.querySelector("[${PAGE_MARKS.attr}='" + n + "']") || (window[${JSON.stringify(PAGE_MARKS.shadow)}] || []).find((m) => m.getAttribute(${JSON.stringify(PAGE_MARKS.attr)}) === n);
    const r = el.getBoundingClientRect();
    const cx = (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2;
    const cy = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
    const center = c && typeof c === "object" && "x" in c && Math.abs(c.x - cx) < 0.5 && Math.abs(c.y - cy) < 0.5;
    return { ok: true, value: center ? null : c };
  })()`);
const covered = (snap: PageSnapshot) => snap.elements.filter((e) => e.covered).map((e) => e.name);
const indexOf = (snap: PageSnapshot, name: string) => snap.elements.find((e) => e.name === name)!.index;

describe("the page behind an open modal dialog", () => {
  it("a <dialog> opened with showModal: the whole page behind it is covered, in view or not; its own fields are not", async () => {
    await tab.setContent(cases.native);
    const snap = await snapshot();
    expect(covered(snap)).toEqual(["Search invoices", "Save", "Download all"]);
    expect(snap.elements.filter((e) => e.inDialog).map((e) => [e.name, e.covered])).toEqual([
      ["Email", undefined],
      ["Add", undefined],
    ]);
    expect(await cover(indexOf(snap, "Search invoices"))).toEqual({ ok: true, value: "Add billing contact" });
    expect(await cover(indexOf(snap, "Download all"))).toEqual({ ok: true, value: "Add billing contact" });
    expect(await cover(indexOf(snap, "Email"))).toEqual({ ok: true, value: null });
  });

  it("an aria-modal dialog with a backdrop over the page: the page is covered, the dialog is not", async () => {
    await tab.setContent(cases.aria);
    const snap = await snapshot();
    expect(covered(snap)).toEqual(["Search invoices", "Save", "Download all"]);
    expect(await cover(indexOf(snap, "Save"))).toEqual({ ok: true, value: "Add billing contact" });
    expect(await cover(indexOf(snap, "Add"))).toEqual({ ok: true, value: null });
  });

  it("an aria-modal dialog that leaves the page reachable covers nothing", async () => {
    await tab.setContent(cases.ariaOpen);
    const snap = await snapshot();
    expect(covered(snap)).toEqual([]);
    expect(await cover(indexOf(snap, "Search invoices"))).toEqual({ ok: true, value: null });
  });

  it("a non-modal dialog (no aria-modal) never covers the page", async () => {
    await tab.setContent(cases.popover);
    const snap = await snapshot();
    expect(covered(snap)).toEqual([]);
    expect(snap.elements.filter((e) => e.inDialog).map((e) => e.name)).toEqual(["Email", "Add"]);
    expect(await cover(indexOf(snap, "Save"))).toEqual({ ok: true, value: null });
  });

  it("after the dialog closes nothing is covered", async () => {
    await tab.setContent(cases.native);
    await tab.evaluate(() => (document.getElementById("dlg") as HTMLDialogElement).close());
    const snap = await snapshot();
    expect(covered(snap)).toEqual([]);
    expect(await cover(indexOf(snap, "Save"))).toEqual({ ok: true, value: null });
  });

  it("a dropdown the dialog opens in a layer outside it (a portal) stays usable", async () => {
    await tab.setContent(
      `${cases.aria}<div role="listbox" style="position: fixed; top: 420px; left: 300px; background: white; z-index: 10"><div role="option" tabindex="0">Finance</div></div>`,
    );
    const snap = await snapshot();
    expect(snap.elements.find((e) => e.name === "Finance")!.covered).toBeUndefined();
    expect(await cover(indexOf(snap, "Finance"))).toEqual({ ok: true, value: null });
  });

  it("a second modal over the first covers the first one's fields, and its own are usable", async () => {
    await tab.setContent(
      `${cases.native}<dialog id="discard"><p>Discard the contact?</p><button>Discard</button><button>Keep editing</button></dialog><script>discard.showModal()</script>`,
    );
    const snap = await snapshot();
    expect(covered(snap)).toEqual(["Search invoices", "Save", "Download all", "Email", "Add"]);
    expect(await cover(indexOf(snap, "Email"))).toEqual({ ok: true, value: "" });
    expect(await cover(indexOf(snap, "Keep editing"))).toEqual({ ok: true, value: null });
  });

  it("a checkbox drawn by its label (the input itself hidden under it) is not taken for covered", async () => {
    await tab.setContent(
      `${cases.aria.replace(FIELDS, `${FIELDS}<label id="l" style="position: relative; display: inline-block; width: 20px; height: 20px"><input type="checkbox" aria-label="Primary" style="position: absolute; inset: 0; opacity: 0; z-index: -1"><span style="position: absolute; inset: 0; background: #ccc"></span></label>`)}`,
    );
    const snap = await snapshot();
    expect(snap.elements.find((e) => e.name === "Primary")!.covered).toBeUndefined();
    expect(await cover(indexOf(snap, "Primary"))).toEqual({ ok: true, value: null });
  });
});

describe("clicking and typing by number behind an open modal dialog (CdpActions over the debugger, as the agent does)", () => {
  /** CdpActions on this page's CDP session, after the snapshot that numbers the elements; the page records its clicks. */
  async function setup(html: string) {
    await tab.setContent(html);
    await tab.evaluate(() => {
      const w = window as unknown as { clicks: string[] };
      w.clicks = [];
      document.addEventListener("click", (e) => w.clicks.push((e.target as HTMLElement).id || (e.target as HTMLElement).tagName), true);
    });
    const session = await tab.context().newCDPSession(tab);
    const cdp = { sendTo: (_tabId: number, method: string, params: Record<string, unknown> = {}) => session.send(method as never, params as never) } as unknown as Cdp;
    return { actions: new CdpActions(cdp, async () => {}), snap: await snapshot() };
  }
  const state = () =>
    tab.evaluate(() => ({
      search: (document.getElementById("search") as HTMLInputElement).value,
      email: (document.getElementById("email") as HTMLInputElement).value,
      clicks: (window as unknown as { clicks: string[] }).clicks,
    }));

  for (const kind of ["native", "aria"] as const) {
    it(`${kind}: typing into a field behind it, or clicking a button there, fails and leaves the page as it was`, async () => {
      const { actions, snap } = await setup(cases[kind].replace('placeholder="Search invoices"', 'placeholder="Search invoices" value="march"'));
      const search = indexOf(snap, "Search invoices");
      await expect(actions.type(1, { index: search, text: "ap@globex.com" })).rejects.toThrow(coveredText(search, "Add billing contact"));
      await expect(actions.click(1, { index: indexOf(snap, "Save") })).rejects.toThrow(/is behind the open dialog "Add billing contact"/);
      expect(await state()).toEqual({ search: "march", email: "", clicks: [] });
      // The dialog's own field takes the text.
      await actions.type(1, { index: indexOf(snap, "Email"), text: "ap@globex.com" });
      expect((await state()).email).toBe("ap@globex.com");
    });
  }

  it("a non-modal dialog: the page's field and button work as before", async () => {
    const { actions, snap } = await setup(cases.popover);
    await actions.type(1, { index: indexOf(snap, "Search invoices"), text: "march" });
    await actions.click(1, { index: indexOf(snap, "Save") });
    const s = await state();
    expect(s.search).toBe("march");
    expect(s.clicks).toContain("save");
  });
});
