/**
 * enteredFieldsInPage in a real page (Playwright's Chromium): which form fields count as holding what someone entered
 * (navigate keeps such a page when it would leave it for another site), and otherSite.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enteredFieldsInPage, otherSite } from "../src/page-entered.js";

const FORM = `<!doctype html><html><body>
<form role="search"><input name="q" aria-label="Search"></form>
<input type="search" name="find">
<form>
<label>Email <input name="email" type="email"></label>
<label>Name <input name="name" value="Ana"></label>
<label>Password <input name="pw" type="password"></label>
<label>Notes <textarea name="notes"></textarea></label>
<label>Country <select name="country"><option value="">Choose…</option><option>Norway</option><option>Sweden</option></select></label>
<label>Plan <select name="plan"><option>Free</option><option selected>Pro</option></select></label>
<label><input type="checkbox" name="terms"> Terms</label>
<label><input type="checkbox" name="news" checked> News</label>
<label>Shown nowhere <input name="away" style="display:none"></label>
<label>Locked <input name="locked" disabled></label>
<input type="hidden" name="token" value="t">
</form></body></html>`;

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

/** As the drivers run it: serialized. */
const entered = () => page.evaluate(`(${enteredFieldsInPage.toString()})()`) as Promise<number>;

describe("enteredFieldsInPage", () => {
  it("a page as it loaded (values and choices it came with) holds no entries", async () => {
    expect(await entered()).toBe(0);
  });

  it("counts typed text, ticked and cleared boxes and other choices, each field once", async () => {
    await page.fill("[name=email]", "kai@example.test");
    expect(await entered()).toBe(1);
    await page.fill("[name=pw]", "secret");
    await page.fill("[name=notes]", "Leave at the door");
    await page.selectOption("[name=country]", "Norway");
    await page.selectOption("[name=plan]", "Free");
    await page.check("[name=terms]");
    await page.uncheck("[name=news]");
    expect(await entered()).toBe(7);
    // A value changed and changed back is as the page loaded it.
    await page.fill("[name=name]", "Anna");
    expect(await entered()).toBe(8);
    await page.fill("[name=name]", "Ana");
    expect(await entered()).toBe(7);
  });

  it("not search boxes, hidden, disabled or emptied fields", async () => {
    await page.fill("[name=q]", "invoices");
    await page.fill("[name=find]", "invoices");
    await page.fill("[name=name]", "");
    await page.evaluate(() => {
      (document.querySelector("[name=away]") as HTMLInputElement).value = "x";
      (document.querySelector("[name=locked]") as HTMLInputElement).value = "x";
      (document.querySelector("[name=token]") as HTMLInputElement).value = "other";
    });
    expect(await entered()).toBe(0);
  });

  it("fields behind a dialog over the page still count", async () => {
    await page.fill("[name=email]", "kai@example.test");
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.setAttribute("role", "dialog");
      d.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5)";
      d.textContent = "Check your email";
      document.body.append(d);
    });
    expect(await entered()).toBe(1);
  });
});

describe("otherSite", () => {
  it("another host is another site; www. and the path do not count; pages without a host never are", () => {
    expect(otherSite("https://store.example.com/join", "https://mail.example.net/")).toBe(true);
    expect(otherSite("https://store.example.com/join", "https://help.example.com/")).toBe(true);
    expect(otherSite("https://www.example.com/a", "https://example.com/b")).toBe(false);
    expect(otherSite("http://example.com/a", "https://example.com/b?x=1")).toBe(false);
    expect(otherSite("about:blank", "https://example.com/")).toBe(false);
    expect(otherSite(undefined, "https://example.com/")).toBe(false);
  });
});
