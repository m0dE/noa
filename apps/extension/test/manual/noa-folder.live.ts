/**
 * Live: does the real agent find and use the files in the user's Noa folder ("local storage")? The helper with
 * headless Claude Code on this machine's login, on a fake job application page with a file input; the Noa folder is a
 * temp folder with a resume in it, listed the way the extension lists it (files.list). The user asks for the resume
 * "from my local storage" without naming a path. Prints every tool call and whether the resume was uploaded.
 *
 *   pnpm --filter @noa/helper build
 *   cd apps/extension && NOA_LIVE=1 npx vitest run --config test/manual/live.config.ts noa-folder
 *
 * NOA_LIVE_REQUEST: the user's words. NOA_LIVE_RUNS: how many runs (default 1). NOA_LIVE_OUT: a file for the log.
 * NOA_LIVE_WHERE=cloud: the resume is only in the account's cloud files (a fake account), not on this computer; the
 * extension's NoaFiles lists both and downloads a cloud file into the folder when the agent uploads it.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { BrowserMethod, ElementInfo, PageSnapshot } from "@noa/shared";
import { startHost } from "../../../helper/test/support/host-process.js";
import { ENV } from "../../../helper/src/env-names.js";
import { listFolder } from "../../../helper/src/noa-files.js";
import { NoaFiles } from "../../src/engine/noa-folder.js";

const LIVE = process.env.NOA_LIVE === "1";
const REQUEST = process.env.NOA_LIVE_REQUEST ?? "Apply to this job for me. Use my resume from my local storage.";
const RUNS = Number(process.env.NOA_LIVE_RUNS ?? 1);
const IN_CLOUD = process.env.NOA_LIVE_WHERE === "cloud";
const RESUME = "Jaeyun Resume 2026.pdf";
const URL = "https://jobs.example.com/apply/senior-engineer";

function log(line: string): void {
  console.log(line);
  if (process.env.NOA_LIVE_OUT) appendFileSync(process.env.NOA_LIVE_OUT, line + "\n");
}

function page(uploaded: string[]): PageSnapshot {
  const el = (e: Omit<ElementInfo, "inViewport">) => ({ ...e, inViewport: true }) as ElementInfo;
  const elements = [
    el({ index: 1, tag: "input", role: "textbox", name: "Full name" }),
    el({ index: 2, tag: "input", role: "textbox", name: "Email" }),
    el({ index: 3, tag: "input", role: "button", name: "Resume (PDF)", type: "file" } as never),
    el({ index: 4, tag: "button", role: "button", name: "Submit application" }),
  ];
  const text = ["Senior Engineer at Example", "Apply", "Full name", "Email", `Resume (PDF): ${uploaded.length ? uploaded.join(", ") : "no file chosen"}`, "Submit application"].join("\n");
  return { url: URL, title: "Apply: Senior Engineer - Example Jobs", text, elements, truncated: false };
}

async function run(n: number): Promise<{ uploaded: string[]; tools: string[] }> {
  const folder = mkdtempSync(join(tmpdir(), "noa-folder-live-"));
  const noa = join(folder, "Noa");
  mkdirSync(join(noa, "images"), { recursive: true });
  writeFileSync(join(noa, "README.txt"), "This is your Noa folder.");
  if (!IN_CLOUD) writeFileSync(join(noa, RESUME), "%PDF-1.4\n% resume\n");
  const cloudFiles = IN_CLOUD
    ? [
        { id: "f1", name: RESUME, folder: "" as const, contentType: "application/pdf", size: 18, createdAt: "2026-09-30T10:00:00.000Z" },
        { id: "f2", name: "banner.png", folder: "images" as const, contentType: "image/png", size: 3, createdAt: "2026-09-29T10:00:00.000Z" },
      ]
    : [];
  const files = new NoaFiles({
    folder: { path: async () => noa },
    helperList: async (p) => listFolder(p.folder, p.search ? { search: p.search } : {}),
    cloud: {
      list: async () => ({ files: cloudFiles, usedBytes: 21, quotaBytes: 2 ** 31, locked: false }),
      download: async (_file, path) => {
        writeFileSync(path, "%PDF-1.4\n% resume\n");
        return path;
      },
    },
  });
  writeFileSync(join(noa, "headshot.jpg"), "jpeg");
  writeFileSync(join(noa, "images", "store-icon.png"), "png");
  const uploaded: string[] = [];
  const tools: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: mkdtempSync(join(tmpdir(), "noa-live-folder-home-")) };
  delete env[ENV.brain];
  const browser = async (m: BrowserMethod, params: unknown): Promise<unknown> => {
    const p = params as Record<string, any>;
    switch (m as string) {
      case "browser.navigate":
        return { url: URL, title: page(uploaded).title };
      case "browser.readPage":
        return page(uploaded);
      case "browser.screenshot":
        return { base64: btoa("fake-jpeg"), mimeType: "image/jpeg" };
      case "browser.upload":
        uploaded.push(...(await files.fetch(p.paths as string[])));
        return { ok: true, via: "input" };
      case "browser.currentUrl":
        return { url: URL };
      case "browser.listTabs":
        return { tabs: [{ id: "t1", url: URL, title: page(uploaded).title, current: true }] };
      case "files.list":
        return files.list(p);
      default:
        return { ok: true };
    }
  };
  const host = startHost({
    env,
    methods: ["browser.navigate", "browser.readPage", "browser.screenshot", "browser.click", "browser.type", "browser.paste", "browser.pressKey", "browser.scroll", "browser.upload", "browser.currentUrl", "browser.listTabs", "files.list" as BrowserMethod],
    browser,
    onEvent: ({ event: e }) => {
      if (e.type === "tool_call") {
        tools.push(e.name);
        log(`#${n} tool: ${e.name} ${JSON.stringify(e.args).slice(0, 200)}`);
      }
      if (e.type === "tool_result" && (e as { isError?: boolean }).isError) log(`#${n}   error: ${String((e as { text?: string }).text).slice(0, 300)}`);
      if (e.type === "assistant_text") log(`#${n} text: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`);
      if (e.type === "task_end") log(`#${n} end: ${e.outcome} ${JSON.stringify(e).slice(0, 300)}`);
    },
  });
  try {
    await host.ext.call("helper.hello", {}, { timeoutMs: 120_000 });
    await host.ext.call(
      "helper.runTask",
      {
        sessionId: `LIVE-FOLDER-${n}`,
        task: { id: `T-LIVE-FOLDER-${n}`, instructions: REQUEST, account: null, userTab: { url: URL, title: page([]).title, access: "here" } },
        mediaPaths: [],
        config: { maxToolCalls: 25, maxTaskMinutes: 5, jevEnabled: false, jevThreshold: 0.8, isRetry: false },
      },
      { timeoutMs: 6 * 60_000 },
    );
  } finally {
    host.child.stdin.end();
    setTimeout(() => host.child.exitCode === null && host.child.kill(), 1_000);
  }
  log(`#${n} uploaded: ${JSON.stringify(uploaded)}`);
  return { uploaded, tools };
}

test.skipIf(!LIVE)("the agent finds the resume in the Noa folder and uploads it", async () => {
  let ok = 0;
  for (let n = 1; n <= RUNS; n++) {
    const r = await run(n);
    if (r.uploaded.some((p) => p.endsWith(RESUME) && existsSync(p))) ok++;
  }
  log(`uploaded the resume in ${ok}/${RUNS} runs`);
  expect(ok).toBe(RUNS);
});
