/**
 * Fields inside web components' open shadow roots, in a real page (Playwright's Chromium): read_page lists them
 * where their component is, and the page functions of both drivers reach them by number and see their focus.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS } from "../src/driver-common.js";
import { clickInPage, insertTextInPage, prepareTypingInPage, typeTargetInPage } from "../src/page-input.js";
import { snapshotPage } from "../src/page-snapshot.js";
import type { PageResult } from "../src/scroll-probe.js";

const PAGE = `<!doctype html><html><head><title>Ticket</title></head><body>
<label for="email">Email</label><input id="email">
<labeled-input label="Summary"></labeled-input>
<labeled-input label="Hidden one" style="display:none"></labeled-input>
<button>Submit ticket</button>
<script>
  customElements.define("labeled-input", class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<label for="f">' + this.getAttribute("label") + '</label><input id="f" required>';
    }
  });
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
  await page.setContent(PAGE);
});

function run<T>(fn: (...args: never[]) => PageResult<T>, ...args: unknown[]): Promise<PageResult<T>> {
  return page.evaluate(`(${fn.toString()})(${[PAGE_MARKS, ...args].map((a) => JSON.stringify(a)).join(", ")})`) as Promise<PageResult<T>>;
}

const snapshot = () => page.evaluate(`(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30)`) as Promise<PageSnapshot>;
const shadowValue = () => page.evaluate(() => document.querySelector("labeled-input")!.shadowRoot!.querySelector("input")!.value);

describe("fields in shadow roots", () => {
  it("read_page lists a visible one where its component is, named by its label in the shadow root", async () => {
    const snap = await snapshot();
    expect(snap.elements.map((e) => e.name)).toEqual(["Email", "Summary", "Submit ticket"]);
    expect(snap.elements[1]).toMatchObject({ role: "textbox", tag: "input", required: true });
  });

  it("is clicked, focused and typed into by number, replacing its value", async () => {
    const i = (await snapshot()).elements.find((e) => e.name === "Summary")!.index;
    expect(await run(typeTargetInPage, i)).toEqual({ ok: true, value: "field" });
    expect(await run(clickInPage, i)).toEqual({ ok: true, value: true });
    expect(await run(prepareTypingInPage, i)).toEqual({ ok: true, value: true });
    expect(await run(insertTextInPage, i, "Printer offline")).toEqual({ ok: true, value: true });
    expect(await shadowValue()).toBe("Printer offline");
    // A paste goes to the focus, which is inside the shadow root.
    expect(await run(prepareTypingInPage, i)).toEqual({ ok: true, value: true });
    expect(await run(insertTextInPage, null, "Scanner jammed")).toEqual({ ok: true, value: true });
    expect(await shadowValue()).toBe("Scanner jammed");
  });

  it("a number from before the component re-rendered is not found, and the next read_page numbers it again", async () => {
    const i = (await snapshot()).elements.find((e) => e.name === "Summary")!.index;
    await page.evaluate(() => {
      const root = document.querySelector("labeled-input")!.shadowRoot!;
      root.innerHTML = '<label for="f">Summary</label><input id="f">';
    });
    expect(await run(clickInPage, i)).toEqual({ ok: false, error: `element ${i} not found; call read_page again` });
    const again = (await snapshot()).elements.find((e) => e.name === "Summary")!.index;
    expect(await run(clickInPage, again)).toEqual({ ok: true, value: true });
  });
});
