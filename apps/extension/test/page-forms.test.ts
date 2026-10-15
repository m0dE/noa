/**
 * The page functions for forms, in a real page (Playwright's Chromium): what read_page shows of
 * each field (value, options, checked, required, validation), dropdowns chosen by label or value,
 * checkboxes set rather than toggled, and typing that replaces a value and never lands in the
 * field that had the focus before. Custom dropdowns (ARIA comboboxes) get their option clicked.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS, typeIntoElement, type TypeTarget } from "../src/driver-common.js";
import { clickInPage, insertTextInPage, prepareTypingInPage, pressKeyInPage, selectOptionInPage, setCheckedInPage, typedTextInPage } from "../src/page-input.js";
import { checkStateInPage, coverInPage } from "../src/page-cover.js";
import { listOptionInPage, optionChosenInPage, suggestionsInPage } from "../src/page-listbox.js";
import { snapshotPage } from "../src/page-snapshot.js";
import type { PageResult } from "../src/scroll-probe.js";

/** Like the benchmark's signup form: fields inside their labels, a select, radios, a required checkbox. */
const FORM = `<!doctype html><html><head><title>Sign up</title></head><body>
<form id="f" onsubmit="event.preventDefault(); document.title = 'submitted'">
<label>First name<input type="text" name="firstName" required></label>
<label>Job title<input type="text" name="jobTitle" required></label>
<label>Work email<input type="email" name="email" required></label>
<label>Country<select name="country" required><option value="">Select…</option><option value="au">Australia</option><option value="uk">United Kingdom</option><option value="us">United States</option><option value="ie" disabled>Ireland</option></select></label>
<fieldset><legend>Team size</legend><label><input type="radio" name="team" value="1-10" required> 1-10</label><label><input type="radio" name="team" value="11-50" required> 11-50</label></fieldset>
<label id="terms-label"><input type="checkbox" name="terms" value="yes" required> I agree to the terms</label>
<div id="news" role="switch" aria-checked="false" tabindex="0" onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))">Newsletter</div>
<input type="text" name="promo" aria-label="Promo code" aria-invalid="true" aria-errormessage="promo-err"><span id="promo-err">That code has expired</span>
<div id="wrapper" tabindex="0">Pick a date</div>
<button type="submit">Create account</button>
</form>
<script>
window.events = [];
for (const type of ["input", "change"]) document.addEventListener(type, (e) => window.events.push(type + ":" + (e.target.name || e.target.id)), true);
</script></body></html>`;

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
  await page.setContent(FORM);
});

/** Runs a page function in the page the way the drivers do (serialized), with PAGE_MARKS first. */
function run<T>(fn: (...args: never[]) => PageResult<T>, ...args: unknown[]): Promise<PageResult<T>> {
  return page.evaluate(`(${fn.toString()})(${[PAGE_MARKS, ...args].map((a) => JSON.stringify(a)).join(", ")})`) as Promise<PageResult<T>>;
}

/** What typing into element `index` means: coverInPage's target, answered as typeTargetInPage did before it was merged in. */
async function typeTarget(index: number): Promise<PageResult<TypeTarget | undefined>> {
  const out = await run(coverInPage, index, "type");
  return out.ok ? { ok: true, value: out.value.target } : out;
}

const snapshot = () => page.evaluate(`(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30)`) as Promise<PageSnapshot>;
const byName = (snap: PageSnapshot, name: string) => {
  const el = snap.elements.find((e) => e.name === name);
  if (!el) throw new Error(`no element "${name}" in ${snap.elements.map((e) => e.name).join(", ")}`);
  return el;
};
const events = () => page.evaluate(() => (window as unknown as { events: string[] }).events.splice(0));
/** The fallback driver's Backspace key, in the page (pressKeyInPage). */
const backspace = () =>
  page
    .evaluate(`(${pressKeyInPage.toString()})(${JSON.stringify({ key: "Backspace", code: "Backspace", keyCode: 8, text: null, alt: false, ctrl: false, meta: false, shift: false })})`)
    .then(() => undefined);

describe("read_page: each field's state", () => {
  it("a control inside its label is named by the label's own text (not the dropdown's options)", async () => {
    const snap = await snapshot();
    expect(byName(snap, "Country")).toMatchObject({ role: "combobox", options: ["Australia", "United Kingdom", "United States", "Ireland"], required: true });
    expect(byName(snap, "Country").value).toBeUndefined();
    expect(byName(snap, "Job title")).toMatchObject({ role: "textbox", required: true });
  });

  it("checkboxes, radio buttons and switches say whether they are checked", async () => {
    let snap = await snapshot();
    expect(byName(snap, "I agree to the terms")).toMatchObject({ role: "checkbox", checked: false, value: "yes", required: true });
    expect(byName(snap, "11-50")).toMatchObject({ role: "radio", checked: false, value: "11-50" });
    expect(byName(snap, "Newsletter")).toMatchObject({ role: "switch", checked: false });
    await page.check("input[name=terms]");
    await page.check("input[value='11-50']");
    snap = await snapshot();
    expect(byName(snap, "I agree to the terms").checked).toBe(true);
    expect(byName(snap, "11-50").checked).toBe(true);
    expect(byName(snap, "1-10").checked).toBe(false);
  });

  it("an empty form is not all invalid; a wrong value is, with the page's message; after a submit, the missing fields are", async () => {
    let snap = await snapshot();
    expect(snap.elements.filter((e) => e.invalid)).toEqual([expect.objectContaining({ name: "Promo code", invalid: "That code has expired" })]);
    await page.fill("input[name=email]", "ada");
    snap = await snapshot();
    expect(byName(snap, "Work email").invalid).toMatch(/@/);
    expect(byName(snap, "First name").invalid).toBeUndefined();
    // A submit the browser blocked (the page stays): now every missing field says why.
    await page.click("button[type=submit]");
    snap = await snapshot();
    expect(await page.title()).toBe("Sign up");
    expect(byName(snap, "First name").invalid).toBeTruthy();
    expect(byName(snap, "Country").invalid).toBeTruthy();
    expect(byName(snap, "I agree to the terms").invalid).toBeTruthy();
  });
});

describe("dropdowns: the option is chosen by label or value", () => {
  const countryIndex = async () => byName(await snapshot(), "Country").index;

  it("by label (case and spacing ignored), by value, or by the one label that contains it; input and change fire", async () => {
    const i = await countryIndex();
    for (const [text, label] of [
      ["united  KINGDOM", "United Kingdom"],
      ["us", "United States"],
      ["austral", "Australia"],
      ["kingdom", "United Kingdom"],
    ] as const) {
      expect(await run(selectOptionInPage, i, text)).toEqual({ ok: true, value: label });
    }
    expect(await page.inputValue("select")).toBe("uk");
    expect(await events()).toContain("change:country");
    expect(byName(await snapshot(), "Country").value).toBe("United Kingdom");
  });

  it("an ambiguous or unknown name, or a disabled option, is an error that lists the options; nothing changes", async () => {
    const i = await countryIndex();
    const ambiguous = await run(selectOptionInPage, i, "United");
    expect(ambiguous).toMatchObject({ ok: false });
    expect(!ambiguous.ok && ambiguous.error).toMatch(/matches several options.*"United Kingdom", "United States"/);
    const unknown = await run(selectOptionInPage, i, "France");
    expect(!unknown.ok && unknown.error).toMatch(/matches no option.*"Australia"/);
    expect((await run(selectOptionInPage, i, "Ireland")).ok).toBe(false);
    expect(await page.inputValue("select")).toBe("");
  });

  it("typing into a dropdown is choosing: typeTargetInPage says so without touching it", async () => {
    expect(await typeTarget(await countryIndex())).toEqual({ ok: true, value: "select" });
  });
});

describe("checkboxes: set, not toggled", () => {
  it("reads the state of a checkbox, a radio button, an ARIA switch; other elements are not checkable", async () => {
    const snap = await snapshot();
    expect(await run(checkStateInPage, byName(snap, "I agree to the terms").index)).toEqual({ ok: true, value: { checkable: true, checked: false, radio: false } });
    expect(await run(checkStateInPage, byName(snap, "11-50").index)).toEqual({ ok: true, value: { checkable: true, checked: false, radio: true } });
    expect(await run(checkStateInPage, byName(snap, "Newsletter").index)).toEqual({ ok: true, value: { checkable: true, checked: false, radio: false } });
    expect(await run(checkStateInPage, byName(snap, "Job title").index)).toEqual({ ok: true, value: { checkable: false, checked: false, radio: false } });
  });

  it("setCheckedInPage sets the state, fires input and change, and leaves a box that already is so alone", async () => {
    const snap = await snapshot();
    const terms = byName(snap, "I agree to the terms").index;
    expect(await run(setCheckedInPage, terms, true)).toEqual({ ok: true, value: true });
    expect(await events()).toEqual(["input:terms", "change:terms"]);
    expect(await run(setCheckedInPage, terms, true)).toEqual({ ok: true, value: true });
    expect(await events()).toEqual([]);
    expect(await page.isChecked("input[name=terms]")).toBe(true);
    expect(await run(setCheckedInPage, byName(snap, "Newsletter").index, true)).toEqual({ ok: true, value: true });
  });

  it("typing into a checkbox or a button is refused before anything happens", async () => {
    const snap = await snapshot();
    expect(await typeTarget(byName(snap, "I agree to the terms").index)).toMatchObject({ ok: false, error: expect.stringMatching(/set it with checked/) });
    expect(await typeTarget(byName(snap, "Create account").index)).toMatchObject({ ok: false, error: expect.stringMatching(/takes no text/) });
    expect(await page.isChecked("input[name=terms]")).toBe(false);
  });
});

describe("typing replaces a field's value, and only goes where the click put the focus", () => {
  /** What the drivers do for a field (the real click is left out: the element is focused by prepareTypingInPage). */
  async function typeInto(name: string, text: string) {
    const index = byName(await snapshot(), name).index;
    expect(await typeTarget(index)).toEqual({ ok: true, value: "field" });
    expect(await run(prepareTypingInPage, index)).toEqual({ ok: true, value: true });
    expect(await run(insertTextInPage, index, text)).toEqual({ ok: true, value: true });
  }

  it("a second type into a field replaces its value instead of appending to it", async () => {
    await typeInto("Job title", "Head of Research");
    await typeInto("Job title", "Head of Research");
    expect(await page.inputValue("input[name=jobTitle]")).toBe("Head of Research");
  });

  it("an email field (no text selection) is emptied first, the way frameworks notice", async () => {
    await typeInto("Work email", "old@example.com");
    await events();
    await typeInto("Work email", "ada.lovelace@example.com");
    expect(await page.inputValue("input[name=email]")).toBe("ada.lovelace@example.com");
    expect(await events()).toContain("input:email");
  });

  it("an empty text empties a prefilled field, a text and an email field, with the input events frameworks listen to", async () => {
    await typeInto("Job title", "Head of Research");
    await typeInto("Work email", "old@example.com");
    await events();
    for (const name of ["Job title", "Work email"]) {
      const index = byName(await snapshot(), name).index;
      expect(await run(prepareTypingInPage, index, true)).toEqual({ ok: true, value: true });
      expect(await run(insertTextInPage, index, "")).toEqual({ ok: true, value: true });
    }
    expect(await page.inputValue("input[name=jobTitle]")).toBe("");
    expect(await page.inputValue("input[name=email]")).toBe("");
    expect(await events()).toEqual(expect.arrayContaining(["input:jobTitle", "input:email"]));
    // Already empty: emptying it again succeeds and leaves it empty.
    const index = byName(await snapshot(), "Job title").index;
    expect(await run(prepareTypingInPage, index, true)).toEqual({ ok: true, value: true });
    expect(await run(insertTextInPage, index, "")).toEqual({ ok: true, value: true });
    expect(await page.inputValue("input[name=jobTitle]")).toBe("");
  });

  it("with the debugger, the empty text (Input.insertText) replaces the selected value of a field, a textarea and a rich editor", async () => {
    await page.setContent(`<input name="q" aria-label="Search" value="refund 4471"><textarea name="bio" aria-label="Bio">line one
line two</textarea><div contenteditable="true" role="textbox" aria-label="Notes"><p>Hello <b>world</b></p><p>again</p></div>`);
    const cdp = await page.context().newCDPSession(page);
    for (const name of ["Search", "Bio", "Notes"]) {
      const index = byName(await snapshot(), name).index;
      expect(await run(prepareTypingInPage, index, true)).toEqual({ ok: true, value: true });
      await cdp.send("Input.insertText", { text: "" });
    }
    expect(await page.inputValue("input[name=q]")).toBe("");
    expect(await page.inputValue("textarea[name=bio]")).toBe("");
    expect(await page.evaluate(() => document.querySelector("[contenteditable]")!.textContent)).toBe("");
    await cdp.detach();
  });

  it("text into a rich editor still goes at the end; only an empty text selects all of it", async () => {
    await page.setContent(`<div contenteditable="true" role="textbox" aria-label="Notes">Hello</div>`);
    const index = byName(await snapshot(), "Notes").index;
    expect(await run(prepareTypingInPage, index, false)).toEqual({ ok: true, value: true });
    expect(await run(insertTextInPage, index, " there")).toEqual({ ok: true, value: true });
    expect(await page.evaluate(() => document.querySelector("[contenteditable]")!.textContent)).toBe("Hello there");
    expect(await run(prepareTypingInPage, index, true)).toEqual({ ok: true, value: true });
    expect(await run(insertTextInPage, index, "")).toEqual({ ok: true, value: true });
    expect(await page.evaluate(() => document.querySelector("[contenteditable]")!.textContent)).toBe("");
  });

  it("an element whose click focuses no field: the field focused before is left alone, and nothing is typed", async () => {
    await typeInto("Job title", "Head of Research");
    await page.focus("input[name=jobTitle]");
    const wrapper = byName(await snapshot(), "Pick a date").index;
    // It drops the focus first, so a click that focuses nothing leaves no field focused ...
    expect(await typeTarget(wrapper)).toEqual({ ok: true, value: "other" });
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    // ... and typing stops there instead of going into Job title.
    expect(await run(prepareTypingInPage, wrapper)).toMatchObject({ ok: false, error: expect.stringMatching(/did not focus a text field/) });
    expect(await page.inputValue("input[name=jobTitle]")).toBe("Head of Research");
  });
});

/** Custom dropdowns: a button that shows its listbox a moment after the click, one whose popup the page adds at the end of the body, and comboboxes that hold a text field. */
const CUSTOM = `<!doctype html><html><head><title>Order</title><style>[role=option]{padding:4px}</style></head><body>
<span id="size-label">Shirt size</span>
<button type="button" id="size" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="size-list" aria-labelledby="size-label">Select size</button>
<ul role="listbox" id="size-list" hidden></ul><input type="hidden" id="size-value">
<button type="button" id="color" aria-haspopup="listbox" aria-label="Color">Pick a color</button>
<div role="combobox" aria-label="City" id="city-wrap"><input id="city" aria-label="City search"></div>
<input role="combobox" aria-label="Department" id="dept">
<script>{
const btn = document.getElementById("size"), list = document.getElementById("size-list");
window.sizeClicks = 0;
btn.addEventListener("click", () => {
  window.sizeClicks++;
  const open = list.hidden;
  btn.setAttribute("aria-expanded", String(open));
  if (!open) return void (list.hidden = true);
  // Rendered after a short delay, as many component libraries do.
  setTimeout(() => {
    list.innerHTML = ["Small", "Medium", "Large", "Extra large"].map((o) => '<li role="option">' + o + "</li>").join("") + '<li role="option" aria-disabled="true">Huge</li>';
    list.hidden = false;
  }, 250);
});
list.addEventListener("click", (e) => {
  const li = e.target.closest("[role=option]");
  document.getElementById("size-value").value = li.textContent;
  btn.textContent = li.textContent;
  btn.setAttribute("aria-expanded", "false");
  list.hidden = true;
});
const color = document.getElementById("color");
color.addEventListener("click", () => {
  const pop = document.createElement("div");
  pop.setAttribute("role", "listbox");
  pop.innerHTML = '<div role="option">Red</div><div role="option">Dark red</div><div role="option">Blue</div><div role="option">Dark blue</div>';
  pop.addEventListener("click", (e) => { color.textContent = e.target.textContent; pop.remove(); });
  document.body.append(pop);
});
}</script></body></html>`;

describe("custom dropdowns: typing chooses the option from the list the click opens", () => {
  beforeEach(async () => {
    await page.setContent(CUSTOM);
  });

  /** browser.type as the fallback driver does it, in the page. */
  async function type(name: string, text: string) {
    const index = byName(await snapshot(), name).index;
    return typeIntoElement(
      { index, text },
      {
        run: (fn, args) => run(fn, ...args),
        clickAt: (i, at) => unwrap(run(clickInPage, i, at)).then(() => undefined),
        insertText: (i, t) => unwrap(run(insertTextInPage, i, t)).then(() => undefined),
        backspace,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
    );
  }
  async function unwrap<T>(p: Promise<PageResult<T>>): Promise<T> {
    const out = await p;
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }

  it("a button combobox and a button with a listbox popup are dropdowns; a combobox holding or being a text field is typed into", async () => {
    const snap = await snapshot();
    expect(await typeTarget(byName(snap, "Shirt size").index)).toEqual({ ok: true, value: "listbox" });
    expect(await typeTarget(byName(snap, "Color").index)).toEqual({ ok: true, value: "listbox" });
    expect(await typeTarget(byName(snap, "Department").index)).toEqual({ ok: true, value: "field" });
    expect((await typeTarget(byName(snap, "City").index)).ok).toBe(true);
    expect(await typeTarget(byName(snap, "City").index)).not.toEqual({ ok: true, value: "listbox" });
  });

  it("opens it, waits for its options, and clicks the one the text names (exactly, else the one it starts with)", async () => {
    expect(await type("Shirt size", "large")).toEqual({ ok: true, selected: "Large" });
    expect(await page.inputValue("#size-value")).toBe("Large");
    expect(await type("Shirt size", "extra")).toEqual({ ok: true, selected: "Extra large" });
    expect(await page.inputValue("#size-value")).toBe("Extra large");
  });

  it("a popup the page adds elsewhere (not tied by aria-controls) is found too", async () => {
    expect(await type("Color", "blue")).toEqual({ ok: true, selected: "Blue" });
    expect(await page.textContent("#color")).toBe("Blue");
  });

  it("an open dropdown is not clicked closed first", async () => {
    await page.click("#size");
    await page.waitForSelector("#size-list [role=option]");
    expect(await type("Shirt size", "Medium")).toEqual({ ok: true, selected: "Medium" });
    expect(await page.evaluate(() => (window as unknown as { sizeClicks: number }).sizeClicks)).toBe(1);
  });

  it("an unknown, ambiguous or disabled option is an error that lists the options; nothing is chosen", async () => {
    await expect(type("Shirt size", "Huge")).rejects.toThrow(/"Huge" matches no option of dropdown \d+; its options: "Small", "Medium", "Large", "Extra large"$/);
    await page.setContent(CUSTOM);
    await expect(type("Color", "dark")).rejects.toThrow(/"dark" matches several options of dropdown \d+; its options that match: "Dark red", "Dark blue"$/);
    expect(await page.inputValue("#size-value")).toBe("");
  });

  it("another list the page showed before the click (not tied to the dropdown) is never used, even with the same option", async () => {
    // Its own list shows `delay` ms after the click, at the end of the body; a "Recent" list is shown all along.
    const portal = (delay: number) => `<ul role="listbox" aria-label="Recent"><li role="option" onclick="window.picked='recent'">Canada</li></ul>
<button id="dd" aria-haspopup="listbox" aria-label="Country">Choose</button>
<script>
dd.onclick = () => setTimeout(() => {
  const ul = document.createElement("ul"); ul.setAttribute("role", "listbox");
  for (const c of ["Brazil", "Canada"]) { const li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = c; li.onclick = () => { window.picked = "dropdown"; dd.textContent = c; ul.remove(); }; ul.append(li); }
  document.body.append(ul);
}, ${delay});
</script>`;
    await page.setContent(portal(300));
    expect(await type("Country", "Canada")).toEqual({ ok: true, selected: "Canada" });
    expect(await page.evaluate(() => (window as unknown as { picked: string }).picked)).toBe("dropdown");
    // Its own list never shows in time: an error, without the other list's options, and nothing picked.
    await page.setContent(portal(5000));
    await page.evaluate(() => delete (window as unknown as { picked?: string }).picked);
    await expect(type("Country", "Canada")).rejects.toThrow(/showed no options \(role=option\) of its own when clicked/);
    expect(await page.evaluate(() => (window as unknown as { picked?: string }).picked)).toBeUndefined();
  });

  it("an option selected already is not clicked (a multi-select would unselect it)", async () => {
    await page.setContent(`<button id="dd" aria-haspopup="listbox" aria-controls="lb" aria-label="Tags">Tags: Red</button>
<ul id="lb" role="listbox" aria-multiselectable="true" hidden><li role="option" aria-selected="true">Red</li><li role="option" aria-selected="false">Blue</li></ul>
<script>
dd.onclick = () => { lb.hidden = !lb.hidden; };
for (const li of lb.children) li.onclick = () => li.setAttribute("aria-selected", li.getAttribute("aria-selected") === "true" ? "false" : "true");
</script>`);
    expect(await type("Tags", "Red")).toEqual({ ok: true, selected: "Red" });
    expect(await page.getAttribute("#lb li:first-child", "aria-selected")).toBe("true");
    expect(await type("Tags", "Blue")).toEqual({ ok: true, selected: "Blue" });
    expect(await page.getAttribute("#lb li:last-child", "aria-selected")).toBe("true");
  });

  it("a click the page does not show as a choice (no aria-selected, the dropdown's text unchanged) is an error, not a success", async () => {
    await page.setContent(`<button id="dd" aria-haspopup="listbox" aria-controls="lb" aria-label="Size">Size</button>
<ul id="lb" role="listbox" hidden><li role="option">S</li><li role="option">M</li></ul>
<script>dd.onclick = () => { lb.hidden = false; };</script>`);
    await expect(type("Size", "M")).rejects.toThrow(/clicked option "M" of dropdown \d+, but the page does not show it chosen .*the dropdown shows "Size"/);
  });

  it("a list shown already counts as open without aria-expanded: it is not clicked closed", async () => {
    await page.setContent(`<button id="dd" aria-haspopup="listbox" aria-controls="lb" aria-label="Size">Size</button>
<ul id="lb" role="listbox"><li role="option">S</li><li role="option">M</li></ul>
<script>window.clicks = 0; dd.onclick = () => { window.clicks++; lb.hidden = !lb.hidden; }; for (const li of lb.children) li.onclick = () => (dd.textContent = li.textContent);</script>`);
    expect(await type("Size", "M")).toEqual({ ok: true, selected: "M" });
    expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(0);
  });

  it("emptying is read back: an editor that refuses the deletion is an error, one that takes it is emptied", async () => {
    // Locked puts its content back after any change, as an editor that renders from its own model does.
    await page.setContent(`<div contenteditable="true" aria-label="Locked"><p>keep me</p></div>
<div contenteditable="true" aria-label="Notes"><p>first</p><p>second</p></div>
<script>{ const el = document.querySelector("[aria-label=Locked]"); const html = el.innerHTML;
new MutationObserver(() => { if (el.innerHTML !== html) el.innerHTML = html; }).observe(el, { childList: true, subtree: true, characterData: true }); }</script>`);
    await expect(type("Locked", "")).rejects.toThrow(/still holds "keep me" after its whole text was selected and deleted/);
    expect(await page.textContent("[aria-label=Locked]")).toBe("keep me");
    expect(await type("Notes", "")).toEqual({ ok: true });
    expect(await page.evaluate(() => document.querySelector("[aria-label=Notes]")!.textContent)).toBe("");
  });

  it("the option's new element number is cleared by the next read_page", async () => {
    await type("Shirt size", "Small");
    await page.click("#size");
    await page.waitForSelector("#size-list [role=option]");
    const snap = await snapshot();
    const numbers = snap.elements.map((e) => e.index);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(byName(snap, "Small").role).toBe("option");
  });
});

/**
 * Text fields that suggest values as you type: an ARIA 1.2 combobox (aria-activedescendant), one whose suggestions
 * come from the server after a delay, one that takes only a value picked from its list (it clears typed text on
 * blur), a search box, and a plain field. Each sets its hidden value only when a suggestion is chosen.
 */
const SUGGESTING = `<!doctype html><html><head><title>Register</title><style>
[role=listbox]{list-style:none;margin:0;padding:0;position:absolute;background:#fff;border:1px solid #888;width:240px;z-index:2}
[role=option]{padding:4px}.wrap{position:relative;margin:6px 0}</style></head><body>
<form id="f" onsubmit="event.preventDefault(); document.title = 'submitted'">
<div class="wrap"><input id="airport" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="airport-list" aria-label="Departure airport"><ul role="listbox" id="airport-list" hidden></ul><input type="hidden" id="airport-value"></div>
<div class="wrap"><input id="hotel" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="hotel-list" aria-label="Hotel"><ul role="listbox" id="hotel-list" hidden></ul><input type="hidden" id="hotel-value"></div>
<div class="wrap"><input id="company" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="company-list" aria-label="Company"><ul role="listbox" id="company-list" hidden></ul><input type="hidden" id="company-value"></div>
<div class="wrap"><input id="nick" aria-label="Nickname"></div>
<button type="submit">Register</button>
</form>
<form role="search" id="s" onsubmit="event.preventDefault(); document.title = 'searched ' + this.q.value">
<div class="wrap"><input id="q" name="q" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="q-list" aria-label="Search sessions"><ul role="listbox" id="q-list" hidden></ul><input type="hidden" id="q-value"></div>
</form>
<script>{
function combobox(id, source, { strict = false } = {}) {
  const input = document.getElementById(id), list = document.getElementById(id + "-list"), hidden = document.getElementById(id + "-value");
  let items = [], active = -1, seq = 0;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
  const render = () => {
    list.innerHTML = items.map((d, i) => '<li role="option" id="' + id + '-o' + i + '">' + d + "</li>").join("");
    list.hidden = !items.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
  };
  const choose = (i) => { input.value = items[i]; hidden.value = items[i]; close(); window.chosen.push(id + ":" + items[i]); };
  input.addEventListener("input", async () => {
    const mine = ++seq;
    hidden.value = "";
    const found = await source(input.value.trim().toLowerCase());
    if (mine === seq) { items = found; active = -1; render(); }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = (active + 1) % items.length; input.setAttribute("aria-activedescendant", id + "-o" + active); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", (e) => { const li = e.target.closest("[role=option]"); if (li) { e.preventDefault(); choose([...list.children].indexOf(li)); } });
  list.addEventListener("click", (e) => { const li = e.target.closest("[role=option]"); if (li && !hidden.value) choose([...list.children].indexOf(li)); });
  input.addEventListener("blur", () => { if (strict && !hidden.value) input.value = ""; });
}
window.chosen = [];
const local = (all) => (q) => all.filter((d) => d.toLowerCase().includes(q));
combobox("airport", local(["London City (LCY)", "London Gatwick (LGW)", "London Heathrow (LHR)", "Lisbon (LIS)"]));
// As if searched on the server: the list comes after a delay.
combobox("hotel", (q) => new Promise((r) => setTimeout(() => r(["Harbour View Hotel", "Harbour View Suites", "Harbourside Inn"].filter((d) => d.toLowerCase().includes(q))), 600)));
combobox("company", local(["Acme Robotics", "Acme Robotics GmbH", "Acme Rocketry"]), { strict: true });
combobox("q", local(["WebAssembly", "WebAssembly at the edge"]));
}</script></body></html>`;

const chosen = () => page.evaluate(() => (window as unknown as { chosen: string[] }).chosen);

describe("text fields that suggest values: typing a suggestion's exact label chooses it, as a person picks it", () => {
  beforeEach(async () => {
    await page.setContent(SUGGESTING);
  });
  /** browser.type as the fallback driver does it, in the page. */
  async function type(name: string, text: string) {
    const index = byName(await snapshot(), name).index;
    return typeIntoElement(
      { index, text },
      {
        run: (fn, args) => run(fn, ...args),
        clickAt: (i, at) => unwrapped(run(clickInPage, i, at)).then(() => undefined),
        insertText: (i, t) => unwrapped(run(insertTextInPage, i, t)).then(() => undefined),
        backspace,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
    );
  }
  async function unwrapped<T>(p: Promise<PageResult<T>>): Promise<T> {
    const out = await p;
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }
  const value = (id: string) => page.inputValue(`#${id}-value`);

  it("an ARIA combobox: the suggestion whose label is the text (case ignored) is clicked, and its list closes", async () => {
    expect(await type("Departure airport", "london gatwick (lgw)")).toEqual({ ok: true, selected: "London Gatwick (LGW)" });
    expect(await value("airport")).toBe("London Gatwick (LGW)");
    expect(await page.isVisible("#airport-list")).toBe(false);
  });

  it("when no suggestion is the text, none is chosen: the result lists those shown, and the field holds the typed text", async () => {
    expect(await type("Departure airport", "London")).toEqual({ ok: true, suggestions: ["London City (LCY)", "London Gatwick (LGW)", "London Heathrow (LHR)"] });
    expect(await value("airport")).toBe("");
    expect(await page.inputValue("#airport")).toBe("London");
    expect(await chosen()).toEqual([]);
  });

  it("suggestions that load from the server after a delay are waited for", async () => {
    expect(await type("Hotel", "Harbour View Hotel")).toEqual({ ok: true, selected: "Harbour View Hotel" });
    expect(await value("hotel")).toBe("Harbour View Hotel");
  });

  it("a field that takes only a value from its list gets the exact one, not a longer one that starts with the text", async () => {
    expect(await type("Company", "Acme Robotics")).toEqual({ ok: true, selected: "Acme Robotics" });
    expect(await value("company")).toBe("Acme Robotics");
  });

  it("a search box never gets a suggestion chosen or listed, even one that is the text: Enter searches what was typed", async () => {
    expect(await type("Search sessions", "WebAssembly")).toEqual({ ok: true });
    expect(await value("q")).toBe("");
    expect(await page.inputValue("#q")).toBe("WebAssembly");
    expect(await chosen()).toEqual([]);
  });

  it("a field that suggests nothing is typed into without waiting: one page call more, of a few milliseconds", async () => {
    const index = byName(await snapshot(), "Nickname").index;
    const started = performance.now();
    for (let i = 0; i < 20; i++) expect(await run(suggestionsInPage, index, "Dee")).toEqual({ ok: true, value: { kind: "none" } });
    expect((performance.now() - started) / 20).toBeLessThan(25);
    expect(await type("Nickname", "Dee")).toEqual({ ok: true });
    expect(await page.inputValue("#nick")).toBe("Dee");
  });

  it("an emptied field gets no suggestion chosen", async () => {
    await type("Departure airport", "London");
    expect(await type("Departure airport", "")).toEqual({ ok: true });
    expect(await value("airport")).toBe("");
  });
});
