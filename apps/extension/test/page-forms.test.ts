/**
 * The page functions for forms, in a real page (Playwright's Chromium): what read_page shows of
 * each field (value, options, checked, required, validation), dropdowns chosen by label or value,
 * checkboxes set rather than toggled, and typing that replaces a value and never lands in the
 * field that had the focus before.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS } from "../src/driver-common.js";
import { checkStateInPage, insertTextInPage, prepareTypingInPage, selectOptionInPage, setCheckedInPage, typeTargetInPage } from "../src/page-input.js";
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

const snapshot = () => page.evaluate(`(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30)`) as Promise<PageSnapshot>;
const byName = (snap: PageSnapshot, name: string) => {
  const el = snap.elements.find((e) => e.name === name);
  if (!el) throw new Error(`no element "${name}" in ${snap.elements.map((e) => e.name).join(", ")}`);
  return el;
};
const events = () => page.evaluate(() => (window as unknown as { events: string[] }).events.splice(0));

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
    expect(await run(typeTargetInPage, await countryIndex())).toEqual({ ok: true, value: "select" });
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
    expect(await run(typeTargetInPage, byName(snap, "I agree to the terms").index)).toMatchObject({ ok: false, error: expect.stringMatching(/set it with checked/) });
    expect(await run(typeTargetInPage, byName(snap, "Create account").index)).toMatchObject({ ok: false, error: expect.stringMatching(/takes no text/) });
    expect(await page.isChecked("input[name=terms]")).toBe(false);
  });
});

describe("typing replaces a field's value, and only goes where the click put the focus", () => {
  /** What the drivers do for a field (the real click is left out: the element is focused by prepareTypingInPage). */
  async function typeInto(name: string, text: string) {
    const index = byName(await snapshot(), name).index;
    expect(await run(typeTargetInPage, index)).toEqual({ ok: true, value: "field" });
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

  it("an element whose click focuses no field: the field focused before is left alone, and nothing is typed", async () => {
    await typeInto("Job title", "Head of Research");
    await page.focus("input[name=jobTitle]");
    const wrapper = byName(await snapshot(), "Pick a date").index;
    // It drops the focus first, so a click that focuses nothing leaves no field focused ...
    expect(await run(typeTargetInPage, wrapper)).toEqual({ ok: true, value: "other" });
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    // ... and typing stops there instead of going into Job title.
    expect(await run(prepareTypingInPage, wrapper)).toMatchObject({ ok: false, error: expect.stringMatching(/did not focus a text field/) });
    expect(await page.inputValue("input[name=jobTitle]")).toBe("Head of Research");
  });
});
