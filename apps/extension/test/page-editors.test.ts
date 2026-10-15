/**
 * browser.type into real rich-text editors (ProseMirror, Tiptap, Lexical, Quill, Slate; bundled in
 * fixtures/editors/editors.js), in a real page (Playwright's Chromium), the way each driver does it: the debugger's
 * trusted input (Input.* through a CDP session) and the fallback's page functions. What an editor holds is read from
 * its own model (its API), and from its DOM: an empty text empties both, text typed afterwards is all it holds, and
 * text typed into a prefilled editor goes at the end. editors.e2e.mjs does the same through the built extension.
 */
import { readFileSync } from "node:fs";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageSnapshot } from "@noa/shared";
import { PAGE_MARKS, typeIntoElement, type PageDriver } from "../src/driver-common.js";
import { keyEvents } from "../src/keys.js";
import { clickInPage, insertTextInPage, pressKeyInPage } from "../src/page-input.js";
import { snapshotPage } from "../src/page-snapshot.js";
import type { PageResult } from "../src/scroll-probe.js";

const BUNDLE = readFileSync(new URL("./fixtures/editors/editors.js", import.meta.url), "utf8");
const EDITORS = ["prosemirror", "tiptap", "lexical", "quill", "slate"] as const;
const PARAGRAPHS = ["Quarterly report draft", "Numbers are still missing"];
const FULL = PARAGRAPHS.join("\n");
const ORIGIN = "http://editors.test";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "editors.js") return route.fulfill({ contentType: "text/javascript", body: BUNDLE });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>#ed{width:600px}#ed [contenteditable]{min-height:60px;white-space:pre-wrap}</style></head>
<body><div id="ed"></div><script src="/editors.js"></script>
<script>window.ed = NoaTestEditors.mount(${JSON.stringify(name)}, document.getElementById("ed"), ${JSON.stringify(PARAGRAPHS)}, "Notes");</script></body></html>`,
    });
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** Runs a page function in the page the way the drivers do (serialized), with PAGE_MARKS first. */
function run<T>(fn: (...args: never[]) => PageResult<T>, ...args: unknown[]): Promise<PageResult<T>> {
  return page.evaluate(`(${fn.toString()})(${[PAGE_MARKS, ...args].map((a) => JSON.stringify(a)).join(", ")})`) as Promise<PageResult<T>>;
}

async function unwrap<T>(p: Promise<PageResult<T>>): Promise<T> {
  const out = await p;
  if (!out.ok) throw new Error(out.error);
  return out.value;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The fallback's PageDriver: simulated input by page functions. */
const fallback = (): PageDriver => ({
  run: (fn, args) => run(fn, ...args),
  clickAt: (i, at) => unwrap(run(clickInPage, i, at)).then(() => undefined),
  insertText: (i, t) => unwrap(run(insertTextInPage, i, t)).then(() => undefined),
  backspace: () =>
    page.evaluate(`(${pressKeyInPage.toString()})(${JSON.stringify({ key: "Backspace", code: "Backspace", keyCode: 8, text: null, alt: false, ctrl: false, meta: false, shift: false })})`).then(() => undefined),
  sleep,
});

/** The debugger's PageDriver (as CdpActions): trusted mouse, text and keys through the CDP session. */
const debuggerDriver = (cdp: CDPSession): PageDriver => ({
  run: (fn, args) => run(fn, ...args),
  clickAt: async (i, at) => {
    const point =
      at ??
      ((await page.evaluate((sel) => {
        const el = document.querySelector(sel)!;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, `[${PAGE_MARKS.attr}="${i}"]`)) as { x: number; y: number });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
  },
  insertText: async (_i, text) => {
    await cdp.send("Input.insertText", { text });
  },
  backspace: async () => {
    const [down, up] = keyEvents("Backspace");
    await cdp.send("Input.dispatchKeyEvent", down as never);
    await cdp.send("Input.dispatchKeyEvent", up as never);
  },
  sleep,
});

/** The editor's own model text (paragraphs joined by "\n") and its DOM's text, once `want` holds or after 2 s. */
async function settled(want: (s: { model: string; dom: string }) => boolean): Promise<{ model: string; dom: string }> {
  const read = () =>
    page.evaluate(() => ({
      model: (window as unknown as { ed: { text(): string } }).ed.text(),
      dom: (document.querySelector("[aria-label=Notes]") as HTMLElement).innerText.replace(/[\s​﻿]+/g, " ").trim(),
    }));
  let s = await read();
  for (let i = 0; i < 20 && !want(s); i++) {
    await sleep(100);
    s = await read();
  }
  return s;
}

async function open(name: string): Promise<void> {
  await page.goto(`${ORIGIN}/${name}`);
  await page.waitForFunction(() => (window as unknown as { ed?: { text(): string } }).ed?.text().length);
}

async function type(driver: PageDriver, text: string) {
  const snap = (await page.evaluate(`(${snapshotPage.toString()})(${JSON.stringify(PAGE_MARKS)}, 8000, 300, 30)`)) as PageSnapshot;
  const editor = snap.elements.find((e) => e.name === "Notes");
  if (!editor) throw new Error("no editor in read_page");
  return typeIntoElement({ index: editor.index, text }, driver);
}

for (const via of ["debugger", "fallback"] as const) {
  describe(`real editors, ${via}`, () => {
    for (const name of EDITORS) {
      it(`${name}: an empty text empties its model and DOM; text typed after is all it holds; prefilled, text goes at the end`, async () => {
        await open(name);
        // A busy machine (slower page scripts) is when an editor's own selection restore can come after Noa's.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        const driver = via === "debugger" ? debuggerDriver(cdp) : fallback();
        try {
          expect(await type(driver, "")).toEqual({ ok: true });
          expect(await settled((s) => !s.model && !s.dom)).toEqual({ model: "", dom: "" });
          expect(await type(driver, "Fresh text")).toEqual({ ok: true });
          expect(await settled((s) => s.model === "Fresh text")).toEqual({ model: "Fresh text", dom: "Fresh text" });
          await open(name);
          expect(await type(driver, " added")).toEqual({ ok: true });
          expect(await settled((s) => s.model === `${FULL} added`)).toEqual({ model: `${FULL} added`, dom: `${FULL} added`.replace(/\n/g, " ") });
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      }, 30_000);
    }
  });
}
