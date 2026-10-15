/**
 * The control overlay's page script (page-indicator.ts showIndicatorInPage) in a real page: the pill, its "Limited"
 * mark, and the popover that tells the job on hover and keyboard focus.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hideIndicatorInPage, INDICATOR_MESSAGE, INDICATOR_TAG, NO_DETAILS, showIndicatorInPage, type IndicatorDetails, type IndicatorVariant } from "../src/page-indicator.js";

let browser: Browser;
let tab: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  tab = await browser.newPage({ viewport: { width: 1000, height: 700 } });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  await tab.setContent(`<!doctype html><html><body style="margin:0"><main style="padding:80px 24px"><h1>Shop</h1><button>Count</button></main></body></html>`);
});

const show = (variant: IndicatorVariant, details: IndicatorDetails) =>
  tab.evaluate(`(${showIndicatorInPage.toString()})(${JSON.stringify(INDICATOR_TAG)}, ${JSON.stringify(variant)}, ${JSON.stringify(INDICATOR_MESSAGE)}, ${JSON.stringify(details)})`);

/** What the overlay shows, read through the reference the isolated world keeps (here the page's own world). */
const view = () =>
  tab.evaluate(() => {
    const root = (window as unknown as { __noaControl: { root: ShadowRoot } }).__noaControl.root;
    const el = (sel: string) => root.querySelector(sel) as HTMLElement;
    const shown = (sel: string) => getComputedStyle(el(sel)).display !== "none" && getComputedStyle(el(sel)).visibility !== "hidden";
    const box = (sel: string) => {
      const r = el(sel).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    return {
      text: el(".text").textContent,
      mark: shown(".mark"),
      popover: shown(".pop"),
      lines: [...el(".pop").children].filter((c) => !(c as HTMLElement).hidden).map((c) => c.textContent),
      tabindex: el(".text").getAttribute("tabindex"),
      describedBy: el(".text").getAttribute("aria-describedby"),
      popRole: el(".pop").getAttribute("role"),
      popId: el(".pop").id,
      textAt: box(".text"),
      bar: shown(".bar"),
    };
  });

const DETAILS: IndicatorDetails = { job: "Compare flight prices", now: "Now: Opening kayak.com", limited: "" };

describe("the pill's popover", () => {
  it("hidden until the pointer is on the pill; then it tells the job and what the agent does now", async () => {
    await show("working", DETAILS);
    let v = await view();
    expect(v.text).toBe("Noa is working");
    expect(v.popover).toBe(false);
    expect(v.mark).toBe(false);
    await tab.mouse.move(v.textAt.x, v.textAt.y);
    v = await view();
    expect(v.popover).toBe(true);
    expect(v.lines).toEqual(["Compare flight prices", "Now: Opening kayak.com"]);
    expect(v.popRole).toBe("tooltip");
    // The pointer leaves: it goes.
    await tab.mouse.move(5, 650);
    expect((await view()).popover).toBe(false);
  });

  it("keyboard: the pill's text takes focus and is described by the popover, which shows; Escape hides it", async () => {
    await show("working", DETAILS);
    let v = await view();
    expect(v.tabindex).toBe("0");
    expect(v.describedBy).toBe(v.popId);
    // Tab from the page's own button reaches the pill's text (the overlay comes after the body).
    await tab.focus("main button");
    await tab.keyboard.press("Tab");
    v = await view();
    expect(v.popover).toBe(true);
    await tab.keyboard.press("Escape");
    expect((await view()).popover).toBe(false);
  });

  it("new details change the text in place: an open popover stays open and keeps focus", async () => {
    await show("working", DETAILS);
    await tab.focus("main button");
    await tab.keyboard.press("Tab");
    await show("working", { ...DETAILS, now: "Now: Filling in the form" });
    const v = await view();
    expect(v.popover).toBe(true);
    expect(v.lines).toEqual(["Compare flight prices", "Now: Filling in the form"]);
    const focused = await tab.evaluate(() => {
      const root = (window as unknown as { __noaControl: { root: ShadowRoot } }).__noaControl.root;
      return root.activeElement?.className;
    });
    expect(focused).toBe("text");
  });

  it("limited mode: the 'Limited' mark on the pill, what it means in the popover", async () => {
    await show("working", { ...DETAILS, limited: "Limited mode: another extension's frame on this page blocks Chrome's debugger." });
    let v = await view();
    expect(v.mark).toBe(true);
    await tab.mouse.move(v.textAt.x, v.textAt.y);
    v = await view();
    expect(v.lines).toEqual(["Compare flight prices", "Now: Opening kayak.com", "Limited mode: another extension's frame on this page blocks Chrome's debugger."]);
    await show("working", DETAILS);
    expect((await view()).mark).toBe(false);
  });

  it("nothing to tell: no popover and the text takes no focus", async () => {
    await show("needs-you", NO_DETAILS);
    const v = await view();
    expect(v.text).toBe("Noa needs you");
    await tab.mouse.move(v.textAt.x, v.textAt.y);
    const after = await view();
    expect(after.popover).toBe(false);
    expect(after.tabindex).toBeNull();
    expect(after.describedBy).toBeNull();
  });

  it("hidden with the pill while the agent clicks at a point (hideIndicatorInPage 'pill')", async () => {
    await show("working", DETAILS);
    const v = await view();
    await tab.mouse.move(v.textAt.x, v.textAt.y);
    expect((await view()).popover).toBe(true);
    await tab.evaluate(`(${hideIndicatorInPage.toString()})("pill")`);
    expect((await view()).bar).toBe(false);
    await tab.evaluate(`(${hideIndicatorInPage.toString()})(null)`);
    expect((await view()).bar).toBe(true);
  });
});
