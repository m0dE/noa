/**
 * Something that is not a modal dialog lying over the element a click is for, in real Chromium: an address
 * suggestion list left open over the form's submit button, a fixed header over a link at the top of the page, a
 * toast over part of a button. The click landed on what lay on top (picking one of the list's suggestions) and was
 * reported as done. coverInPage (which clicking and typing check first, in both drivers) now finds a point of the
 * element a click reaches, or fails naming what covers it. Also modals the first check missed: an aria-modal dialog
 * inside an open shadow root, and a modal stacked inside another one.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { coveredText, INPUT_BLOCKED_TEXT, overlaidText, type PageSnapshot } from "@noa/shared";
import { CdpActions } from "../src/cdp-actions.js";
import type { Cdp } from "../src/cdp.js";
import { PAGE_MARKS } from "../src/driver-common.js";
import { FallbackDriver } from "../src/fallback-driver.js";
import { coverInPage } from "../src/page-cover.js";
import { showIndicatorInPage } from "../src/page-indicator.js";
import { snapshotPage } from "../src/page-snapshot.js";

const ADDRESSES = ["41 Harbor Rd, Vancouver, WA 98660", "41 Harbour Ave, North Vancouver, BC", "410 Harbour Street, Vancouver, BC"];
/** A checkout form: the address field's suggestions open below it, over the Place order button, until one is picked or Escape. */
const AUTOCOMPLETE = `<style>body{margin:24px;font-family:sans-serif}.wrap{position:relative}#suggest{position:absolute;top:100%;left:0;width:420px;margin:0;padding:0;list-style:none;background:#fff;border:1px solid #888;z-index:5}#suggest li{padding:8px}</style>
<form onsubmit="event.preventDefault(); window.submitted = addr.value"><label for="addr">Delivery address</label>
<div class="wrap"><input id="addr" autocomplete="off" role="combobox" aria-controls="suggest" style="width:400px">
<ul id="suggest" role="listbox" aria-label="Address suggestions" hidden></ul></div>
<label for="notes">Delivery notes</label><input id="notes">
<button id="place">Place order</button></form>
<script>
addr.addEventListener("input", () => { suggest.innerHTML = ${JSON.stringify(ADDRESSES)}.map((a) => '<li role="option">' + a + "</li>").join(""); suggest.hidden = false; });
suggest.addEventListener("mousedown", (e) => { const li = e.target.closest("[role=option]"); if (!li) return; e.preventDefault(); addr.value = li.textContent; suggest.hidden = true; });
addr.addEventListener("keydown", (e) => { if (e.key === "Escape") suggest.hidden = true; });
</script>`;
/** A fixed header over the top of the page, where a link sits (a page that does not leave room for its header). */
const STICKY = `<style>body{margin:0;font-family:sans-serif}header{position:fixed;top:0;left:0;right:0;height:90px;padding-left:400px;box-sizing:border-box;background:#123;color:#fff;z-index:3}</style>
<header aria-label="Site header"><b>Acme</b> Docs</header><a id="top" href="#x" style="display:inline-block;margin:30px 0 0 40px">Getting started</a>
<div style="height:2000px"></div><a id="mid" href="#y">Further reading</a><div style="height:2000px"></div>`;
/** A toast over the right part of a button at the bottom of the page (it cannot scroll from under it). */
const TOAST = `<style>body{margin:0;font-family:sans-serif}#toast{position:fixed;right:0;bottom:0;width:1060px;height:60px;background:#333;color:#fff;z-index:4}</style>
<div style="height:1500px"></div><button id="save" style="width:300px;height:40px;margin:0 0 10px 0">Save changes</button>
<div id="toast" role="status">Draft saved a moment ago</div>`;
/** A cookie banner fixed to the bottom of the window, over the page's last buttons. */
const BANNER = `<style>body{margin:0 24px;font-family:sans-serif}#cookies{position:fixed;left:0;right:0;bottom:0;height:180px;background:#222;color:#eee;z-index:9}</style>
<div style="height:1500px"></div><p>Was this helpful? <button id="yes">Yes</button><button id="no">No</button></p>
<div id="cookies"><p>We use cookies to keep you signed in and to measure how the site is used.</p><button id="accept" style="position:absolute;right:20px;top:20px">Accept all</button></div>`;
/** A web component whose modal dialog (aria-modal, with a backdrop) lives in its open shadow root. */
const SHADOW_MODAL = `<button id="save">Save</button><input id="search" aria-label="Search">
<confirm-dialog></confirm-dialog>
<script>
customElements.define("confirm-dialog", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<div style="position:fixed;inset:0;background:#0006;z-index:8"></div><div role="dialog" aria-modal="true" aria-labelledby="t" style="position:fixed;top:200px;left:300px;width:300px;background:#fff;z-index:9"><h2 id="t">Discard changes?</h2><button id="discard">Discard</button><button id="keep">Keep editing</button></div>';
  }
});
</script>`;
/** A modal with a second modal opened from it, rendered inside it (its own backdrop over the first one). */
const NESTED = `<button id="page">Page button</button>
<div style="position:fixed;inset:0;background:#0004;z-index:8"></div>
<div id="outer" role="dialog" aria-modal="true" aria-label="Edit profile" style="position:fixed;top:100px;left:200px;width:500px;height:400px;background:#fff;z-index:9">
  <label>Display name <input id="name"></label><button id="delete">Delete account</button>
  <div style="position:fixed;inset:0;background:#0006;z-index:10"></div>
  <div id="inner" role="alertdialog" aria-modal="true" aria-label="Delete your account?" style="position:fixed;top:600px;left:250px;width:300px;background:#fff;z-index:11">
    <button id="confirm">Delete</button><button id="cancel">Cancel</button>
  </div>
</div>`;

let browser: Browser;
let tab: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  tab = await browser.newPage({ viewport: { width: 1200, height: 800 } });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
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
const indexOf = (snap: PageSnapshot, name: string) => snap.elements.find((e) => e.name === name)!.index;

/** The page, numbered by a snapshot, recording what each click reached (its id, else its text). */
async function load(html: string): Promise<void> {
  await tab.setContent(html);
  await tab.evaluate(() => {
    // setContent keeps the window: what the previous page left there goes.
    const w = window as unknown as { clicks: string[]; submitted?: string };
    w.clicks = [];
    delete w.submitted;
    document.addEventListener("click", (e) => {
      const t = e.composedPath()[0] as HTMLElement;
      w.clicks.push(t.id || (t.textContent ?? "").trim().slice(0, 30));
    }, true);
  });
}
const clicks = () => tab.evaluate(() => (window as unknown as { clicks: string[] }).clicks);

/** Both drivers, as the agent's clicks and typing go: CdpActions over the debugger, and FallbackDriver through chrome.scripting. */
const drivers = {
  cdp: async () => {
    const session = await tab.context().newCDPSession(tab);
    const cdp = { sendTo: (_tabId: number, method: string, params: Record<string, unknown> = {}) => session.send(method as never, params as never) } as unknown as Cdp;
    return new CdpActions(cdp, async () => {});
  },
  fallback: async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      scripting: {
        executeScript: async ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [
          { result: await tab.evaluate(`(${func.toString()})(...${JSON.stringify(args)})`) },
        ],
      },
    };
    return new FallbackDriver({ sleep: async () => {} });
  },
};

describe("coverInPage: what lies over the element where a click would land", () => {
  it("an open suggestion list over the submit button: covered everywhere, by the list, where a click picks a suggestion", async () => {
    await load(AUTOCOMPLETE);
    await tab.locator("#addr").pressSequentially("41 Harbour Street");
    const snap = await snapshot();
    expect(await cover(indexOf(snap, "Place order"))).toEqual({
      ok: true,
      value: { over: 'the list "Address suggestions"', lands: `option ${JSON.stringify(ADDRESSES[0])}`, list: true },
    });
    // Closed: nothing over it.
    await tab.keyboard.press("Escape");
    expect(await cover(indexOf(snap, "Place order"))).toEqual({ ok: true, value: null });
  });

  it("a fixed header over a link at the top of the page: covered (it cannot scroll from under it); a link further down is not", async () => {
    await load(STICKY);
    const snap = await snapshot();
    expect(await cover(indexOf(snap, "Getting started"))).toEqual({ ok: true, value: { over: 'the header "Site header"', lands: 'text "Acme Docs"', list: false } });
    expect(await cover(indexOf(snap, "Further reading"))).toEqual({ ok: true, value: null });
  });

  it("a toast over part of a button: a point of the button that a click reaches", async () => {
    await load(TOAST);
    const snap = await snapshot();
    const out = (await cover(indexOf(snap, "Save changes"))) as { ok: true; value: { x: number; y: number } };
    expect(out.ok).toBe(true);
    // Left of the toast (it starts at x 140), within the button.
    expect(out.value.x).toBeLessThan(140);
    expect(await tab.evaluate(([x, y]) => document.elementFromPoint(x!, y!)!.id, [out.value.x, out.value.y])).toBe("save");
  });

  it("a cookie banner over the page's last buttons: named by its text, and where a click lands", async () => {
    await load(BANNER);
    const snap = await snapshot();
    expect(await cover(indexOf(snap, "Yes"))).toEqual({
      ok: true,
      value: { over: 'the fixed element "We use cookies to keep you signed in and to measure how the"', lands: 'text "We use cookies to keep you signed in and to measure how the"', list: false },
    });
  });

  it("an aria-modal dialog inside an open shadow root covers the page, and read_page marks it so", async () => {
    await load(SHADOW_MODAL);
    const snap = await snapshot();
    expect(snap.elements.filter((e) => e.covered).map((e) => e.name)).toEqual(["Save", "Search"]);
    expect(await cover(indexOf(snap, "Save"))).toEqual({ ok: true, value: "Discard changes?" });
    expect(await cover(indexOf(snap, "Keep editing"))).toEqual({ ok: true, value: null });
  });

  it("a modal stacked inside another one: the topmost covers the first one's fields and names itself; its own buttons are usable", async () => {
    await load(NESTED);
    const snap = await snapshot();
    expect(snap.elements.filter((e) => e.covered).map((e) => e.name)).toEqual(["Page button", "Display name", "Delete account"]);
    expect(await cover(indexOf(snap, "Delete account"))).toEqual({ ok: true, value: "Delete your account?" });
    expect(await cover(indexOf(snap, "Page button"))).toEqual({ ok: true, value: "Delete your account?" });
    expect(await cover(indexOf(snap, "Cancel"))).toEqual({ ok: true, value: null });
  });
});

describe("what is not a modal's cover (review of the cover check, 2026-10-13)", () => {
  it("a chat launcher over Save inside the dialog: covered by the launcher, never 'behind' the element's own dialog", async () => {
    await load(`<button>Page button</button><div style="position:fixed;inset:0;background:#0006"></div>
<div role="dialog" aria-modal="true" aria-label="Edit profile" style="position:fixed;left:300px;top:200px;width:400px;height:250px;background:#fff">
  <input aria-label="Name" value="Ann"><button id="save" style="position:absolute;right:10px;bottom:10px;width:80px;height:30px">Save</button></div>
<div style="position:fixed;left:600px;top:400px;width:120px;height:80px;background:#06f;z-index:9" aria-label="Chat with us">chat</div>`);
    const snap = await snapshot();
    expect(snap.elements.find((e) => e.name === "Save")!.covered).toBeUndefined();
    expect(snap.elements.find((e) => e.name === "Page button")!.covered).toBe(true);
    expect(await cover(indexOf(snap, "Save"))).toEqual({ ok: true, value: { over: 'the element "Chat with us"', lands: 'text "chat"', list: false } });
    const driver = await drivers.cdp();
    await expect(driver.click(1, { index: indexOf(snap, "Save") })).rejects.toThrow(/^element \d+ is covered by the element "Chat with us"/);
    expect(await clicks()).toEqual([]);
  });

  it("a fixed header while a cookie dialog without a backdrop is open: covered by the header, not by the dialog", async () => {
    await load(`<div style="height:3000px"><header style="position:fixed;top:0;left:0;right:0;height:60px;background:#eee;z-index:5">Site header</header>
<div style="padding-top:20px"><a href="#a" style="display:inline-block;height:30px">Under the header</a></div><div style="margin-top:150px"><button>Search</button></div>
<div style="margin-top:1500px"><button>Far below</button></div></div>
<div role="dialog" aria-modal="true" aria-label="This website uses cookies" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#fff;z-index:10"><button>Allow all</button></div>`);
    const snap = await snapshot();
    // The dialog leaves the page usable: nothing is behind it, in view or not.
    expect(snap.elements.filter((e) => e.covered).map((e) => e.name)).toEqual([]);
    expect(await cover(indexOf(snap, "Under the header"))).toEqual({ ok: true, value: { over: 'the header "Site header"', lands: 'text "Site header"', list: false } });
    expect(await cover(indexOf(snap, "Search"))).toEqual({ ok: true, value: null });
  });

  it("an off-canvas menu kept aside with a transform (aria-modal, not in the window) is not an open dialog", async () => {
    await load(`<nav role="dialog" aria-modal="true" aria-label="Main menu" style="position:fixed;top:0;left:0;width:300px;height:100%;transform:translateX(-100%);background:#fff"><a href="#">Home</a></nav>
<div style="height:3000px"><button style="margin-top:300px">Checkout</button></div>`);
    const snap = await snapshot();
    expect(snap.elements.find((e) => e.name === "Checkout")!.covered).toBeUndefined();
    expect(await cover(indexOf(snap, "Checkout"))).toEqual({ ok: true, value: null });
  });

  it("Noa's own control pill (top center) is not part of the page: nothing under it is covered", async () => {
    await load(`<div style="text-align:center;padding-top:12px"><button style="width:120px;height:24px">Top tab</button></div>
<div role="dialog" aria-modal="true" aria-label="Chat" style="position:fixed;right:0;bottom:0;width:300px;height:200px;background:#eee"><button>Send</button></div>`);
    await tab.evaluate(
      `(${showIndicatorInPage.toString()})(${JSON.stringify(PAGE_MARKS.overlay)}, "working", { stop: "Stop", open: "Open" }, { job: "Book flights to Rome", now: "", limited: "" })`,
    );
    const snap = await snapshot();
    expect(snap.elements.filter((e) => e.covered).map((e) => e.name)).toEqual([]);
    expect(await cover(indexOf(snap, "Top tab"))).toEqual({ ok: true, value: null });
  });

  it("controls out of view behind a dialog are covered only when a backdrop covers the page, not by a count of controls", async () => {
    // A dialog with no backdrop over a page whose only control in view happens to be under it: the rest is usable.
    await load(`<button style="position:absolute;top:300px;left:400px">Under</button><div style="height:3000px"></div><button>Far below</button>
<div role="dialog" aria-modal="true" aria-label="Notice" style="position:fixed;top:280px;left:350px;width:300px;height:100px;background:#fff"><button>Got it</button></div>`);
    let snap = await snapshot();
    expect(snap.elements.filter((e) => e.covered).map((e) => e.name)).toEqual(["Under"]);
    // With a backdrop: everything behind it, in view or not.
    await load(`<button>Top</button><div style="height:3000px"></div><button>Far below</button><div style="position:fixed;inset:0;background:#0006"></div>
<div role="dialog" aria-modal="true" aria-label="Notice" style="position:fixed;top:280px;left:350px;width:300px;height:100px;background:#fff"><button>Got it</button></div>`);
    snap = await snapshot();
    expect(snap.elements.filter((e) => e.covered).map((e) => e.name)).toEqual(["Top", "Far below"]);
  });

  it("a combobox's unnamed suggestion list is named after its field", async () => {
    await load(`<label for="dept">Department</label><div style="position:relative"><input id="dept" role="combobox" aria-controls="dept-list" value="Eng">
<ul id="dept-list" role="listbox" style="position:absolute;top:100%;left:0;margin:0;padding:0;width:300px;background:#fff;z-index:2"><li role="option">Engineering</li><li role="option">Engineering Management</li></ul></div>
<button>Place order</button>`);
    const snap = await snapshot();
    expect(await cover(indexOf(snap, "Place order"))).toEqual({ ok: true, value: { over: 'the list "Department"', lands: 'option "Engineering"', list: true } });
  });
});

for (const [name, make] of Object.entries(drivers)) {
  describe(`clicking and typing by number with something over the element (${name})`, () => {
    it("the submit button under an open suggestion list: fails naming the list; no suggestion picked, nothing submitted", async () => {
      await load(AUTOCOMPLETE);
      await tab.locator("#addr").pressSequentially("41 Harbour Street");
      const snap = await snapshot();
      const driver = await make();
      const place = indexOf(snap, "Place order");
      const expected = overlaidText(place, { over: 'the list "Address suggestions"', lands: `option ${JSON.stringify(ADDRESSES[0])}`, list: true });
      await expect(driver.click(1, { index: place })).rejects.toThrow(expected);
      // Typing into the field under the list clicks it first: refused too.
      const notes = indexOf(snap, "Delivery notes");
      await expect(driver.type(1, { index: notes, text: "Leave at the door" })).rejects.toThrow(/^element \d+ is covered by the list "Address suggestions"/);
      expect(await tab.evaluate(() => ({ addr: (document.getElementById("addr") as HTMLInputElement).value, notes: (document.getElementById("notes") as HTMLInputElement).value, submitted: (window as unknown as { submitted?: string }).submitted }))).toEqual({
        addr: "41 Harbour Street",
        notes: "",
        submitted: undefined,
      });
      expect(await clicks()).toEqual([]);
      // Once the list is closed, the same click places the order.
      await tab.keyboard.press("Escape");
      await driver.click(1, { index: place });
      expect(await tab.evaluate(() => (window as unknown as { submitted?: string }).submitted)).toBe("41 Harbour Street");
    });

    it("Place order under a field's open listbox: fails naming the list after its field; no option picked, nothing submitted", async () => {
      // Live (fallback, 2026-10-13): the click went straight to the button under the open list, and the form was sent
      // with an empty department.
      await load(`<form onsubmit="event.preventDefault(); window.submitted = dept.value"><label for="dept">Department</label>
<div style="position:relative"><input id="dept" role="combobox" aria-controls="dept-list" value="Eng">
<ul id="dept-list" role="listbox" style="position:absolute;top:100%;left:0;margin:0;padding:0;width:300px;background:#fff;z-index:2"><li role="option">Engineering</li><li role="option">Engineering Management</li></ul></div>
<button id="place">Place order</button></form>`);
      const snap = await snapshot();
      const driver = await make();
      const place = indexOf(snap, "Place order");
      await expect(driver.click(1, { index: place })).rejects.toThrow(overlaidText(place, { over: 'the list "Department"', lands: 'option "Engineering"', list: true }));
      expect(await clicks()).toEqual([]);
      expect(await tab.evaluate(() => (window as unknown as { submitted?: string }).submitted)).toBeUndefined();
    });

    it("a link under a fixed header: fails naming the header, and the link is not followed", async () => {
      await load(STICKY);
      const snap = await snapshot();
      const driver = await make();
      const link = indexOf(snap, "Getting started");
      await expect(driver.click(1, { index: link })).rejects.toThrow(/^element \d+ is covered by the header "Site header": a click there would land on its text "Acme Docs"/);
      expect(await clicks()).toEqual([]);
      expect(tab.url()).not.toContain("#x");
      await driver.click(1, { index: indexOf(snap, "Further reading") });
      expect(await clicks()).toEqual(["mid"]);
    });

    it("a button partly under a toast: clicked at a free point; the toast gets nothing", async () => {
      await load(TOAST);
      const snap = await snapshot();
      const driver = await make();
      await driver.click(1, { index: indexOf(snap, "Save changes") });
      expect(await clicks()).toEqual(["save"]);
    });

    it("the page behind a shadow-root modal: fails as behind the dialog", async () => {
      await load(SHADOW_MODAL);
      const snap = await snapshot();
      const driver = await make();
      const save = indexOf(snap, "Save");
      await expect(driver.click(1, { index: save })).rejects.toThrow(coveredText(save, "Discard changes?"));
      expect(await clicks()).toEqual([]);
    });
  });
}

describe("the click's input check, armed with the cover check (debugger)", () => {
  /** CdpActions over a real CDP session, recording its Runtime.evaluate calls. */
  async function counted() {
    const session = await tab.context().newCDPSession(tab);
    const evaluates: string[] = [];
    const cdp = {
      sendTo: (_tabId: number, method: string, params: Record<string, unknown> = {}) => {
        if (method === "Runtime.evaluate") evaluates.push(String(params.expression));
        return session.send(method as never, params as never);
      },
    } as unknown as Cdp;
    return { session, evaluates, driver: new CdpActions(cdp, async () => {}) };
  }

  it("a click the page gets, on a button in view: two scripts (the cover check, which arms the input check, and its read), and it lands", async () => {
    await load(`<button id="save">Save changes</button>`);
    const snap = await snapshot();
    const { evaluates, driver } = await counted();
    await driver.click(1, { index: indexOf(snap, "Save changes") });
    expect(await clicks()).toEqual(["save"]);
    expect(evaluates.map((e) => /^\(function (\w+)/.exec(e)?.[1] ?? "read")).toEqual(["coverInPage", "read"]);
  });

  it("a button scrolled into view is aimed at again, once the page had its moment to answer the scroll, and the click lands", async () => {
    await load(TOAST);
    const snap = await snapshot();
    const { evaluates, driver } = await counted();
    await driver.click(1, { index: indexOf(snap, "Save changes") });
    expect(await clicks()).toEqual(["save"]);
    expect(evaluates.map((e) => /^\(function (\w+)/.exec(e)?.[1] ?? "read")).toEqual(["coverInPage", "coverInPage", "read"]);
  });

  it("input held outside the page (Chrome ignores the tab's input): the click fails with the input-blocked error", async () => {
    await load(TOAST);
    const snap = await snapshot();
    const { session, driver } = await counted();
    await session.send("Input.setIgnoreInputEvents", { ignore: true });
    try {
      await expect(driver.click(1, { index: indexOf(snap, "Save changes") })).rejects.toThrow(INPUT_BLOCKED_TEXT);
      expect(await clicks()).toEqual([]);
    } finally {
      await session.send("Input.setIgnoreInputEvents", { ignore: false });
    }
    await driver.click(1, { index: indexOf(snap, "Save changes") });
    expect(await clicks()).toEqual(["save"]);
  });
});

/**
 * A dropdown whose options the page moves in answer to the scroll that brought one into view. The click was measured
 * in the same moment as that scroll, before the page moved it, and landed on another option (live on Cloudflare's
 * dashboard, 2026-10-19: TXT chose TLSA, MX chose DNSKEY, five tries on one record type; there the page behind the
 * dialog scrolled too, and the list, placed against it, was put back a frame later). Here a scroll arrow (as Base UI's
 * Select can show) pushes the options a row lower once the list is scrolled down.
 */
const TYPES = ["A", "AAAA", "CAA", "CERT", "CNAME", "DNSKEY", "DS", "HTTPS", "LOC", "MX", "NAPTR", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "TXT", "URI"];
const SHIFTING_LIST = `<style>body{margin:0;font-family:sans-serif}#pop{position:fixed;top:60px;left:20px;width:200px;height:240px;display:flex;flex-direction:column;background:#fff;border:1px solid #888}
#up{height:32px;flex:none}#types{flex:1;overflow-y:auto;margin:0;padding:0;list-style:none}[role=option]{height:32px;line-height:32px}</style>
<span id="type-label">Type</span>
<button id="type" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="types" aria-labelledby="type-label type">A</button>
<div id="pop" hidden><div id="up" hidden>▲</div><ul id="types" role="listbox" aria-labelledby="type-label">${TYPES.map((t) => `<li role="option" aria-selected="${t === "A"}">${t}</li>`).join("")}</ul></div>
<script>
{
const trigger = document.getElementById("type"), pop = document.getElementById("pop"), list = document.getElementById("types"), up = document.getElementById("up");
trigger.addEventListener("click", () => { pop.hidden = false; trigger.setAttribute("aria-expanded", "true"); });
// The page's answer to a scroll: the arrow shows while the list is scrolled down, over the options' first row.
list.addEventListener("scroll", () => { up.hidden = list.scrollTop === 0; });
list.addEventListener("click", (e) => {
  const o = e.target.closest("[role=option]");
  if (!o) return;
  for (const x of list.children) x.setAttribute("aria-selected", String(x === o));
  trigger.textContent = o.textContent;
  pop.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
});
}
</script>`;

for (const [name, make] of Object.entries({
  cdp: async () => {
    const session = await tab.context().newCDPSession(tab);
    const cdp = { sendTo: (_tabId: number, method: string, params: Record<string, unknown> = {}) => session.send(method as never, params as never) } as unknown as Cdp;
    return new CdpActions(cdp, (ms) => new Promise((r) => setTimeout(r, ms)));
  },
  fallback: async () => {
    await drivers.fallback();
    return new FallbackDriver({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  },
})) {
  describe(`an option the list moves when it is scrolled into view (${name})`, () => {
    const chosen = () => tab.evaluate(() => document.getElementById("type")!.textContent);

    it("clicked by number: the option clicked is chosen, not its neighbour", async () => {
      for (const want of ["TXT", "NS", "MX", "URI"]) {
        await load(SHIFTING_LIST);
        await tab.click("#type");
        const snap = await snapshot();
        const driver = await make();
        await driver.click(1, { index: indexOf(snap, want) });
        expect(await chosen()).toBe(want);
      }
    });

    it("typed into the dropdown: the option named is chosen", async () => {
      for (const want of ["TXT", "NS", "MX"]) {
        await load(SHIFTING_LIST);
        const snap = await snapshot();
        const driver = await make();
        await expect(driver.type(1, { index: indexOf(snap, "Type A"), text: want })).resolves.toMatchObject({ selected: want });
        expect(await chosen()).toBe(want);
      }
    });
  });
}
