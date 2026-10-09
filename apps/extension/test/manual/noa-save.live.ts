/**
 * Live: does the real agent keep files in the user's Noa folder and cloud files (save_file)? The helper with headless
 * Claude Code on this machine's login, on a fake billing page with an invoice PDF link; the extension's FileSaver
 * saves into a temp Noa folder and a fake account's cloud files. Two requests by default:
 *   asked: "Download my September invoice from this page and keep it in my cloud storage." (it must be saved)
 *   unasked: "Find my September invoice on this page. I'll need it for my taxes." (saving it is the agent's call)
 *   export: "Export my usage as CSV and keep it in my files." (the page's Export button makes the file itself: the agent
 *     clicks it, then saves the browser's last download, which the helper's side reads from disk)
 * Prints every tool call and what was saved where.
 *
 *   pnpm --filter @noa/helper build
 *   cd apps/extension && NOA_LIVE=1 npx vitest run --config test/manual/live.config.ts noa-save
 *
 * NOA_LIVE_REQUEST: one request instead of both. NOA_LIVE_RUNS: runs per request (default 1). NOA_LIVE_OUT: a log file.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { BrowserMethod, ElementInfo, PageSnapshot } from "@noa/shared";
import { startHost } from "../../../helper/test/support/host-process.js";
import { ENV } from "../../../helper/src/env-names.js";

const LIVE = process.env.NOA_LIVE === "1";
const RUNS = Number(process.env.NOA_LIVE_RUNS ?? 1);
const ASKED = "Download my September invoice from this page and keep it in my cloud storage.";
const UNASKED = "Find my September invoice on this page. I'll need it for my taxes.";
const EXPORT = "Export my usage as CSV and keep it in my files.";
const REQUESTS = process.env.NOA_LIVE_REQUEST ? [process.env.NOA_LIVE_REQUEST] : [ASKED, UNASKED, EXPORT];
const URL = "https://console.neon.tech/app/billing";
const INVOICE_URL = "https://console.neon.tech/api/invoices/NEON-2026-09.pdf";

function log(line: string): void {
  console.log(line);
  if (process.env.NOA_LIVE_OUT) appendFileSync(process.env.NOA_LIVE_OUT, line + "\n");
}

function page(): PageSnapshot {
  const el = (e: Omit<ElementInfo, "inViewport">) => ({ ...e, inViewport: true }) as ElementInfo;
  const elements = [
    el({ index: 1, tag: "a", role: "link", name: "Download invoice NEON-2026-09 (PDF)", href: INVOICE_URL } as never),
    el({ index: 2, tag: "a", role: "link", name: "Download invoice NEON-2026-08 (PDF)", href: INVOICE_URL.replace("09", "08") } as never),
    el({ index: 3, tag: "button", role: "button", name: "Export usage (CSV)" }),
  ];
  const text = ["Billing", "Invoices", `NEON-2026-09 — September 2026 — $170.39 — Paid — Download (PDF): ${INVOICE_URL}`, `NEON-2026-08 — August 2026 — $151.02 — Paid — Download (PDF): ${INVOICE_URL.replace("09", "08")}`].join("\n");
  return { url: URL, title: "Billing - Neon Console", text, elements, truncated: false };
}

/** The extension's files.save for this run; null until the extension serves it. */
interface RunCtx {
  noa: string;
  cloud: { name: string; folder: string; size: number }[];
  /** The browser's last download (the Export button's file). */
  download: { filename: string; url: string } | null;
}
type SaveHandler = (params: Record<string, unknown>, ctx: RunCtx) => Promise<unknown>;

async function loadSaver(): Promise<SaveHandler | null> {
  try {
    const mod = (await import("../../src/engine/file-saver.js")) as typeof import("../../src/engine/file-saver.js");
    return async (params, ctx) => {
      const saver = new mod.FileSaver({
        fetch: async (url) => {
          if (!String(url).includes("NEON-2026-0")) return new Response("not found", { status: 404 });
          return new Response(new Blob(["%PDF-1.4\n% invoice\n"], { type: "application/pdf" }), { status: 200, headers: { "Content-Type": "application/pdf" } });
        },
        writeLocal: async (rel, blob) => {
          // rel is under the download folder: "Noa/<folder>/<name>".
          const path = join(dirname(ctx.noa), ...rel.split("/"));
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
          return path;
        },
        cloud: async (blob, name, folder) => {
          ctx.cloud.push({ name, folder, size: blob.size });
          return { saved: true };
        },
        readLocal: async (path) => new Blob([readFileSync(path)]),
        lastDownload: async () => ctx.download,
        folder: async () => ctx.noa,
      });
      return saver.save(params as never, {});
    };
  } catch {
    return null;
  }
}

async function run(n: number, request: string): Promise<{ saved: unknown[]; cloud: { name: string; folder: string; size: number }[] }> {
  const noa = join(mkdtempSync(join(tmpdir(), "noa-save-live-")), "Noa");
  mkdirSync(noa, { recursive: true });
  const saved: unknown[] = [];
  const cloud: { name: string; folder: string; size: number }[] = [];
  const ctx: RunCtx = { noa, cloud, download: null };
  const save = await loadSaver();
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: mkdtempSync(join(tmpdir(), "noa-live-save-home-")) };
  delete env[ENV.brain];
  const browser = async (m: BrowserMethod, params: unknown): Promise<unknown> => {
    const p = params as Record<string, unknown>;
    switch (m as string) {
      case "browser.navigate":
        return { url: String(p.url), title: page().title };
      case "browser.readPage":
        return page();
      case "browser.screenshot":
        return { base64: btoa("fake-jpeg"), mimeType: "image/jpeg" };
      case "browser.click": {
        // Export usage: the page makes the CSV itself (a blob: download), into the download folder.
        if (p.index === 3) {
          const filename = join(dirname(noa), "neon-usage-2026-09.csv");
          writeFileSync(filename, "project,compute_cu_hrs,storage_gb\nnoa-prod,412,18.2\nnoa-staging,31,1.1\n");
          ctx.download = { filename, url: "blob:https://console.neon.tech/6f1c" };
        }
        return { ok: true };
      }
      case "browser.currentUrl":
        return { url: URL };
      case "browser.listTabs":
        return { tabs: [{ id: "t1", url: URL, title: page().title, current: true }] };
      case "files.list":
        return { folder: noa, files: [], total: 0 };
      case "files.save": {
        if (!save) throw new Error("Not available in this test browser: files.save");
        const r = await save(p, ctx);
        saved.push(r);
        return r;
      }
      default:
        return { ok: true };
    }
  };
  const host = startHost({
    env,
    methods: ["browser.navigate", "browser.readPage", "browser.screenshot", "browser.click", "browser.type", "browser.paste", "browser.pressKey", "browser.scroll", "browser.upload", "browser.currentUrl", "browser.listTabs", "files.list" as BrowserMethod, "files.save" as BrowserMethod],
    browser,
    onEvent: ({ event: e }) => {
      if (e.type === "tool_call") log(`#${n} tool: ${e.name} ${JSON.stringify(e.args).slice(0, 220)}`);
      if (e.type === "tool_result" && (e as { isError?: boolean }).isError) log(`#${n}   error: ${String((e as { text?: string }).text).slice(0, 300)}`);
      if (e.type === "assistant_text") log(`#${n} text: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`);
      if (e.type === "task_end") log(`#${n} end: ${JSON.stringify(e).slice(0, 300)}`);
    },
  });
  try {
    await host.ext.call("helper.hello", {}, { timeoutMs: 120_000 });
    await host.ext.call(
      "helper.runTask",
      {
        sessionId: `LIVE-SAVE-${n}`,
        task: { id: `T-LIVE-SAVE-${n}`, instructions: request, account: null, userTab: { url: URL, title: page().title, access: "here" } },
        mediaPaths: [],
        config: { maxToolCalls: 20, maxTaskMinutes: 5, jevEnabled: false, jevThreshold: 0.8, isRetry: false },
      },
      { timeoutMs: 6 * 60_000 },
    );
  } finally {
    host.child.stdin.end();
    setTimeout(() => host.child.exitCode === null && host.child.kill(), 1_000);
  }
  log(`#${n} saved: ${JSON.stringify(saved)} cloud: ${JSON.stringify(cloud)}`);
  return { saved, cloud };
}

test.skipIf(!LIVE)("the agent keeps the invoice in the Noa folder and the cloud files", async () => {
  const kept: Record<string, number> = {};
  let n = 0;
  for (const request of REQUESTS) {
    kept[request] = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await run(++n, request);
      if (r.cloud.some((c) => (request === EXPORT ? /usage.*\.csv$/i : /NEON-2026-09|invoice/i).test(c.name))) kept[request]!++;
    }
    log(`"${request}": kept in the cloud in ${kept[request]}/${RUNS} runs`);
  }
  // Asked to keep it: every run must. Not asked: the agent's own call, reported only.
  for (const asked of [ASKED, EXPORT]) if (REQUESTS.includes(asked)) expect(kept[asked]).toBe(RUNS);
});
