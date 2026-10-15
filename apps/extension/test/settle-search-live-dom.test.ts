/**
 * In real Chromium, through the debugger: typing waits for what the page fetches because of it. A search field that
 * searches only once the typing has stopped for a moment (a debounce longer than the usual settle time) has its
 * results on the page when browser.type answers; an ordinary field costs no more than before. Times are printed.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cdp, type DebuggerTransport } from "../src/cdp.js";
import { CdpActions } from "../src/cdp-actions.js";
import { PAGE_MARKS } from "../src/driver-common.js";

const TAB = 1;
const DEBOUNCE_MS = 600;
const SERVER_MS = 500;

const PAGE = `<!doctype html><body>
<label>Full name <input id="name"></label>
<input id="filter" placeholder="Filter teams">
<input id="search" type="search" aria-label="Search accounts"><div id="results"></div>
<script>
let timer;
document.getElementById("search").addEventListener("input", (e) => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const hits = await (await fetch("/api?q=" + encodeURIComponent(e.target.value))).json();
    document.getElementById("results").textContent = hits.join(", ");
  }, ${DEBOUNCE_MS});
});
</script></body>`;

let server: http.Server;
let browser: Browser;
let page: Page;
let session: CDPSession;
let actions: CdpActions;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api")) return void setTimeout(() => res.end(JSON.stringify(["Larkspur Tea"])), SERVER_MS);
    res.setHeader("Content-Type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  browser = await chromium.launch();
  page = await browser.newPage();
  session = await page.context().newCDPSession(page);
  const transport: DebuggerTransport = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: (_tabId, method, params) => session.send(method as never, params as never) as Promise<unknown>,
  };
  const cdp = new Cdp(transport);
  for (const ev of ["Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed"]) {
    session.on(ev as never, (params: unknown) => cdp.handleEvent({ tabId: TAB }, ev, params));
  }
  actions = new CdpActions(cdp, (ms) => new Promise((r) => setTimeout(r, ms)));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await page.evaluate((attr) => ["name", "filter", "search"].forEach((id, i) => document.getElementById(id)!.setAttribute(attr, String(i))), PAGE_MARKS.attr);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

const timeType = async (index: number, text: string) => {
  const t0 = Date.now();
  const r = await actions.type(TAB, { index, text, settleMs: 300 });
  return { ms: Date.now() - t0, r };
};

describe("typing waits for a debounced search", () => {
  it("an ordinary field: about the settle time", async () => {
    const { ms, r } = await timeType(0, "Priya Raman");
    console.log(`ordinary field: ${ms} ms`);
    expect(r.settled).toBe(true);
    expect(ms).toBeLessThan(700);
  });

  it("a search field the page searches only after a pause: its results are there when type answers", async () => {
    const { ms } = await timeType(2, "lark");
    console.log(`debounced search (${DEBOUNCE_MS} ms + server ${SERVER_MS} ms): ${ms} ms`);
    expect(await page.textContent("#results")).toBe("Larkspur Tea");
  });

  it("a filter field that sends nothing: at most the start window", async () => {
    const { ms } = await timeType(1, "core");
    console.log(`filter field, no request: ${ms} ms`);
    expect(ms).toBeLessThan(1700);
  });
});
