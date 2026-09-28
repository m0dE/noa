/**
 * Live check (real Claude Code, one session, uses your subscription): a picture the user attached reaches Claude
 * Code through dist/host.js. The extension's side sends it in pieces (helper.putAttachment), helper.runTask names it,
 * the helper puts it in the session's attachments folder, and Claude Code looks at it with its Read tool. Claude is
 * also asked to Read the run folder's MCP config, one level up: that must be refused (Read is allowed only in the
 * attachments folder, its working directory; dontAsk refuses the rest).
 * Runs only with NOA_LIVE_CLAUDE_ATTACH=1 (after `pnpm build`):
 *   NOA_LIVE_CLAUDE_ATTACH=1 pnpm --filter @noa/helper test live-attachments
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { type BrowserMethod } from "@noa/shared";
import { ENV } from "../src/env-names.js";
import { FakeX } from "./fake-x.js";
import { startHost } from "./support/host-process.js";

const home = mkdtempSync(join(tmpdir(), "noa-live-attach-"));
// Claude Code may still be exiting (its working directory is in there): retry for a while.
afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }));

/** A PNG, left half red and right half blue. */
function redBluePng(width = 96, height = 64): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rows.set(x < width / 2 ? [220, 20, 20] : [20, 40, 220], at);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

describe.runIf(process.env.NOA_LIVE_CLAUDE_ATTACH === "1")("live Claude Code: an attached picture", () => {
  it("Claude Code sees the picture with Read, and cannot read outside the attachments folder", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: home };
    delete env[ENV.brain];
    const x = new FakeX({ account: "alice", url: "https://example.com/" });
    const { child, ext } = startHost({ env, browser: (m: BrowserMethod, p) => x.handle(m, p as never) });
    try {
      const info = await ext.call("helper.hello", {}, { timeoutMs: 90_000 });
      expect(info.selfTest?.ok).toBe(true);
      const png = redBluePng();
      await ext.call("helper.putAttachment", { sessionId: "LIVE-ATT", id: "a1", offset: 0, dataBase64: png.toString("base64") }, { timeoutMs: 10_000 });
      const started = Date.now();
      const result = await ext.call(
        "helper.runTask",
        {
          sessionId: "LIVE-ATT",
          task: {
            id: "T-ATT",
            account: null,
            instructions:
              "No browsing is needed. 1) Look at the attached picture and say which color fills its left half and which its right half. " +
              "2) Then try once to Read the file ../mcp-config.json and say whether you could read it. " +
              'Call task_complete with the summary exactly "left=<color> right=<color> config=<read|refused>".',
          },
          mediaPaths: [],
          config: { maxToolCalls: 10, maxTaskMinutes: 4, jevEnabled: false, jevThreshold: 0.8, isRetry: false, model: "claude-sonnet-5" },
          attachments: [{ ref: { id: "a1", name: "halves.png", type: "image/png", size: png.length, kind: "image", width: 96, height: 64 }, fresh: true }],
        },
        { timeoutMs: 5 * 60_000 },
      );
      console.log("result", JSON.stringify(result), `${Math.round((Date.now() - started) / 1000)} s`);
      const logged = readFileSync(result.logPath!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      // Claude Code's own tool calls and their results, from its stream-json lines.
      const blocks = logged.filter((e) => e.type === "claude").flatMap((e) => (Array.isArray(e.event?.message?.content) ? e.event.message.content : []));
      const reads = blocks.filter((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "Read");
      const results = new Map(blocks.filter((b: { type: string }) => b.type === "tool_result").map((b: { tool_use_id: string; is_error?: boolean; content: unknown }) => [b.tool_use_id, b]));
      for (const r of reads) console.log("Read", JSON.stringify(r.input), "->", JSON.stringify(results.get(r.id)).slice(0, 300));
      expect(result.outcome).toBe("done");
      expect(result.summary?.toLowerCase()).toMatch(/left=red right=blue/);
      const image = reads.find((r: { input: { file_path?: string } }) => /halves\.png$/.test(r.input.file_path ?? ""));
      expect(image, "Claude Code read the picture").toBeDefined();
      expect((results.get(image.id) as { is_error?: boolean }).is_error).not.toBe(true);
      const config = reads.find((r: { input: { file_path?: string } }) => /mcp-config\.json$/.test(r.input.file_path ?? ""));
      if (config) expect((results.get(config.id) as { is_error?: boolean }).is_error, "Reading outside the attachments folder is refused").toBe(true);
      expect(result.summary?.toLowerCase()).toMatch(/config=refused/);
    } finally {
      child.kill();
    }
  }, 6 * 60_000);
});
