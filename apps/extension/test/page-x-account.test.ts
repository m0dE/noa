/**
 * browser.clickXAccountEntry in a real page (Playwright's Chromium) on the fake X (test/fixtures/fake-x), whose
 * account menu flips like the real one: personal "Switch to @h" cells first, then, flipMs later, new nodes with only
 * the delegates' "Act as" cells shown. The page function (page-x-account.ts) runs the way the debugger runs it; the
 * real-press fallback runs through CdpActions over a CDP session. Nothing but the target's personal entry is ever
 * clicked or pressed: the fake X records every delegate switch, and none may happen.
 */
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Cdp } from "../src/cdp.js";
import { CdpActions } from "../src/cdp-actions.js";
import { xAccountEntryInPage, xHandleParam, type XEntryMode, type XEntryStep } from "../src/page-x-account.js";
import type { PageResult } from "../src/scroll-probe.js";

interface FakeXServer {
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  delegateClicks(): { by: string; handle: string }[];
  setMenuFlipMs(ms: number): void;
}

const SERVER = new URL("../../../test/fixtures/fake-x/server.mjs", import.meta.url).href;

let fakeX: FakeXServer;
let base: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let session: CDPSession;

beforeAll(async () => {
  const { createFakeX } = (await import(SERVER)) as { createFakeX: () => FakeXServer };
  fakeX = createFakeX();
  base = `https://127.0.0.1:${await fakeX.listen(0)}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await fakeX?.close();
});

beforeEach(async () => {
  await context?.close();
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
  session = await context.newCDPSession(page);
  fakeX.setMenuFlipMs(1000);
  await page.goto(`${base}/home`);
});

const run = (handle: string, waitMs: number, mode: XEntryMode = "click") =>
  page.evaluate(`(${xAccountEntryInPage.toString()})(${JSON.stringify(handle)}, ${waitMs}, ${JSON.stringify(mode)})`) as Promise<PageResult<XEntryStep>>;
const openMenu = () => page.evaluate(() => document.getElementById("acct-btn")!.click());
const signedInAs = () => page.locator("#acct-btn").innerText();
const delegateShown = () => page.locator('[aria-label="Act as"]').first().isVisible();

describe("xAccountEntryInPage", () => {
  it("clicks the personal entry the moment the menu opens, before X flips it", async () => {
    fakeX.setMenuFlipMs(300);
    await openMenu();
    expect(await run("@beta", 3000)).toEqual({ ok: true, value: { clicked: true } });
    await page.waitForURL(/\/home$/);
    await expect.poll(signedInAs).toMatch(/@beta/);
    expect(fakeX.delegateClicks()).toEqual([]);
  });

  it("waits for a menu that opens later (a mutation, not a timer), then clicks at once", async () => {
    await page.evaluate(() => setTimeout(() => document.getElementById("acct-btn")!.click(), 200));
    expect(await run("gamma", 3000)).toEqual({ ok: true, value: { clicked: true } });
    await expect.poll(signedInAs).toMatch(/@gamma/);
  });

  it("the menu flipped to its delegate view: nothing is clicked, not the hidden personal cell and never an \"Act as\"", async () => {
    fakeX.setMenuFlipMs(0);
    await openMenu();
    await expect.poll(delegateShown).toBe(true);
    const r = await run("@beta", 500);
    expect(r).toEqual({ ok: true, value: { clicked: false, reason: expect.stringMatching(/only delegate accounts/) } });
    // A delegate's own handle is not a personal entry either.
    expect(await run("@delta", 0)).toMatchObject({ value: { clicked: false } });
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe("/home");
    expect(await signedInAs()).toMatch(/@alpha/);
    expect(fakeX.delegateClicks()).toEqual([]);
  });

  it("an account the menu does not list, a closed menu, and cells outside the menu: nothing is clicked", async () => {
    expect(await run("@beta", 0)).toEqual({ ok: true, value: { clicked: false, reason: "the account menu is not open" } });
    // A "Switch to @beta" cell on the page itself (not in the account menu) is never the entry.
    await page.evaluate(() => {
      const fake = document.createElement("button");
      fake.setAttribute("data-testid", "UserCell");
      fake.setAttribute("aria-label", "Switch to @beta");
      fake.textContent = "Beta @beta";
      fake.onclick = () => (document.title = "clicked outside the menu");
      document.querySelector("main")!.prepend(fake);
    });
    expect(await run("@beta", 0)).toMatchObject({ value: { clicked: false } });
    await openMenu();
    expect(await run("@nobody", 1000)).toEqual({ ok: true, value: { clicked: false, reason: "the account menu does not list @nobody" } });
    expect(await page.title()).not.toBe("clicked outside the menu");
  });

  it("refuses a cell that says \"Act as\", whatever its label claims", async () => {
    await openMenu();
    // A menu cell dressed as the entry but naming a delegate: skipped, and the real entry is gone.
    await page.evaluate(() => {
      const real = document.querySelector('[aria-label="Switch to @beta"]')!;
      const odd = real.cloneNode(true) as HTMLElement;
      odd.textContent = "Act as Beta @beta";
      odd.onclick = () => (location.href = "/i/delegate/switch?to=%40beta");
      real.replaceWith(odd);
    });
    expect(await run("@beta", 0)).toMatchObject({ value: { clicked: false } });
    await page.waitForTimeout(200);
    expect(fakeX.delegateClicks()).toEqual([]);
  });

  it("checks the handle it is given", () => {
    expect(xHandleParam("beta")).toBe("@beta");
    expect(() => xHandleParam('beta"); alert(1); ("')).toThrow(/X handle/);
    expect(() => xHandleParam("")).toThrow(/X handle/);
  });
});

describe("the real-press fallback (CdpActions over the debugger)", () => {
  /** CdpActions on this page's CDP session; `before` runs in the page right before a command of that name is sent. */
  function actions(before: Record<string, (params: Record<string, unknown>) => Promise<void> | void> = {}): CdpActions {
    const cdp = {
      sendTo: async (_tabId: number, method: string, params: Record<string, unknown> = {}) => {
        await before[method]?.(params);
        return session.send(method as never, params as never);
      },
    } as unknown as Cdp;
    return new CdpActions(cdp, async () => {});
  }
  /** X re-renders the menu: the entry's node is replaced by a delegate's "Act as" cell at the same place. */
  const replaceEntryWithDelegate = () =>
    page.evaluate(() => {
      const real = document.querySelector('[aria-label="Switch to @beta"]');
      if (!real) return;
      const cell = real.cloneNode(true) as HTMLElement;
      cell.setAttribute("aria-label", "Act as");
      cell.textContent = "Delta @delta";
      cell.addEventListener("click", () => (location.href = "/i/delegate/switch?to=%40delta"));
      real.replaceWith(cell);
    });

  it("presses the entry's node for real and switches", async () => {
    await openMenu();
    expect(await actions().clickXAccountEntry(1, { handle: "@beta", waitMs: 1000, press: true })).toEqual({ clicked: true });
    await expect.poll(signedInAs).toMatch(/@beta/);
    expect(fakeX.delegateClicks()).toEqual([]);
  });

  it("X replaced the node before the press: \"not found\", nothing pressed", async () => {
    await openMenu();
    let replaced = false;
    const cdp = actions({
      "DOM.resolveNode": async () => {
        if (!replaced) await replaceEntryWithDelegate();
        replaced = true;
      },
    });
    const r = await cdp.clickXAccountEntry(1, { handle: "@beta", waitMs: 1000, press: true });
    expect(r).toEqual({ clicked: false, reason: expect.stringMatching(/^not found: X replaced the @beta entry/) });
    await page.waitForTimeout(300);
    expect(fakeX.delegateClicks()).toEqual([]);
    expect(await signedInAs()).toMatch(/@alpha/);
  });

  it("X replaced the node between the last check and the press: the press lands on the delegate cell and reaches nothing", async () => {
    await openMenu();
    let replaced = false;
    const cdp = actions({
      "Input.dispatchMouseEvent": async (p) => {
        if (p.type !== "mouseMoved" || replaced) return;
        replaced = true;
        await replaceEntryWithDelegate();
      },
    });
    const r = await cdp.clickXAccountEntry(1, { handle: "@beta", waitMs: 1000, press: true });
    expect(r).toMatchObject({ clicked: false });
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe("/home");
    expect(fakeX.delegateClicks()).toEqual([]);
    // The guard is gone after the press: the page takes clicks again.
    expect(await page.evaluate(() => (window as unknown as Record<symbol, unknown>)[Symbol.for("noa.xAccountEntryGuard")])).toBeUndefined();
  });

  it("a press that comes after the guard expired (not the press that was checked) reaches nothing, the entry neither", async () => {
    await openMenu();
    const cdp = actions({
      "Input.dispatchMouseEvent": async (p) => {
        if (p.type === "mouseMoved") await page.evaluate(() => ((window as unknown as Record<symbol, { expired: boolean }>)[Symbol.for("noa.xAccountEntryGuard")]!.expired = true));
      },
    });
    expect(await cdp.clickXAccountEntry(1, { handle: "@beta", waitMs: 1000, press: true })).toMatchObject({ clicked: false });
    await page.waitForTimeout(300);
    expect(await signedInAs()).toMatch(/@alpha/);
    expect(await page.evaluate(() => (window as unknown as Record<symbol, unknown>)[Symbol.for("noa.xAccountEntryGuard")])).toBeUndefined();
  });
});
