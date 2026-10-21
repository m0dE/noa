/**
 * read_page on a page with more controls than MAX_SNAPSHOT_ELEMENTS: the Cloudflare DNS records page (Oct 13) had
 * hundreds of rows, and its "Add record" dialog is mounted at the end of <body>. Cut in page order, the list was the
 * table's first 300 controls and none of the dialog's, so neither Jev nor the model could pick its Type, Name or Cancel.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS } from "../src/driver-common.js";
import { snapshotPage } from "../src/page-snapshot.js";

const rows = Array.from({ length: 400 }, (_, i) => `<tr><td><a href="/r/${i}">record${i}.example.com</a></td><td><button>Edit</button></td></tr>`);
const DIALOG = `<div role="dialog" aria-modal="true" style="position: fixed; top: 20px; left: 20px; background: white">
<h2>Add record</h2><label>Type <select><option>A</option><option>CNAME</option></select></label>
<label>Name <input placeholder="Use @ for root"></label><button>Save</button><button>Cancel</button></div>`;
const page = (dialog: boolean, n = 400) =>
  `<!doctype html><html><head><title>DNS</title></head><body><input type="search" placeholder="Search"><table>${rows.slice(0, n).join("")}</table>${dialog ? DIALOG : ""}</body></html>`;

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

describe("snapshotPage: more controls than the cap", () => {
  it("keeps an open dialog's controls, then those in view, numbered in page order", async () => {
    await tab.setContent(page(true));
    const snap = await snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.elements).toHaveLength(300);
    const dialog = snap.elements.filter((e) => e.inDialog);
    expect(dialog.map((e) => e.name)).toEqual(["Type", "Name", "Save", "Cancel"]);
    expect(snap.elements.map((e) => e.index)).toEqual(snap.elements.map((_, i) => i));
    // The dialog comes last in the page, so it is numbered last; what is in view is kept before what is not.
    expect(snap.elements.at(-1)!.name).toBe("Cancel");
    expect(snap.elements.filter((e) => e.inViewport).length).toBeGreaterThan(20);
    // Its numbers are the ones the click helpers look up.
    const marked = await tab.evaluate((attr) => document.querySelector(`[${attr}="${299}"]`)?.textContent, PAGE_MARKS.attr);
    expect(marked).toBe("Cancel");
  });

  it("without a dialog, keeps the controls in view before offscreen ones", async () => {
    await tab.setContent(page(false));
    await tab.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const snap = await snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.elements.some((e) => e.name === "record399.example.com")).toBe(true);
    expect(snap.elements.find((e) => e.name === "record399.example.com")!.inViewport).toBe(true);
  });

  it("leaves out a closed dialog's controls (display: none), and keeps those in view", async () => {
    await tab.setContent(page(true));
    await tab.evaluate(() => ((document.querySelector('[role="dialog"]') as HTMLElement).style.display = "none"));
    const snap = await snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.elements.filter((e) => e.inDialog)).toEqual([]);
    expect(snap.elements[0]!.name).toBe("Search");
    expect(snap.elements.filter((e) => e.inViewport).length).toBeGreaterThan(20);
  });

  it("keeps the options of a dropdown open from the dialog, mounted after it, those scrolled out of its list too", async () => {
    // Live (Oct 19): Cloudflare's record Type list (Base UI) is mounted at the end of <body>, outside the dialog, and
    // its last options were scrolled out of the list and the window: the cut dropped TXT and URI, and the agent could
    // not pick TXT by number. The table's rows in view took their place.
    const types = ["A", "AAAA", "CAA", "CERT", "CNAME", "DNSKEY", "DS", "HTTPS", "LOC", "MX", "NAPTR", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "TXT", "URI"];
    const listbox = `<div role="listbox" id="types" style="position: fixed; top: 120px; left: 20px; height: 700px; overflow-y: auto; background: white">${types.map((t) => `<div role="option" style="height: 40px">${t}</div>`).join("")}</div>`;
    await tab.setContent(
      page(true).replace("<label>Type <select><option>A</option><option>CNAME</option></select></label>", '<span id="tl">Type</span><button role="combobox" aria-labelledby="tl" aria-haspopup="listbox" aria-expanded="true" aria-controls="types">A</button>') +
        listbox,
    );
    const snap = await snapshot();
    expect(snap.truncated).toBe(true);
    const options = snap.elements.filter((e) => e.role === "option");
    expect(options.map((e) => e.name)).toEqual(types);
    expect(options.find((e) => e.name === "URI")!.inViewport).toBe(false);
  });

  it("an expanded accordion's panel is no popup: its controls out of view are cut like the rest", async () => {
    const panel = `<div id="faq">${Array.from({ length: 40 }, (_, i) => `<a href="/faq/${i}">Answer ${i}</a>`).join("")}</div>`;
    await tab.setContent(page(false) + `<button aria-expanded="true" aria-controls="faq">Questions</button>${panel}`);
    const snap = await snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.elements.some((e) => e.name === "Answer 39")).toBe(false);
  });

  it("a page within the cap lists every control in page order, as before", async () => {
    await tab.setContent(page(true, 100));
    const snap = await snapshot();
    expect(snap.truncated).toBe(false);
    // The search box, two per row, and the dialog's four.
    expect(snap.elements).toHaveLength(1 + 100 * 2 + 4);
    expect(snap.elements.map((e) => e.name).slice(0, 3)).toEqual(["Search", "record0.example.com", "Edit"]);
    expect(snap.elements.slice(-4).map((e) => e.name)).toEqual(["Type", "Name", "Save", "Cancel"]);
  });
});
