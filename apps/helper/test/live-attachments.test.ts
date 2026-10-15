/**
 * Live check (real Claude Code, one session, uses your subscription): pictures the user attached reach Claude Code
 * through dist/host.js, one with the first message and one with a follow-up. The extension's side sends each in
 * pieces (helper.putAttachment), helper.runTask / helper.continueSession name it, the helper puts it in the session's
 * attachments folder and sends it to Claude Code as an image block in that message. Claude Code has no Read (nor any
 * built-in tool): it must see both without one, and call none.
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

type Rgb = [number, number, number];
const RED: Rgb = [220, 20, 20];
const BLUE: Rgb = [20, 40, 220];
const GREEN: Rgb = [20, 170, 40];
const YELLOW: Rgb = [240, 220, 20];

/** A PNG, left half one color and right half another. */
function halvesPng(left: Rgb, right: Rgb, width = 96, height = 64): Buffer {
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
      rows.set(x < width / 2 ? left : right, at);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

describe.runIf(process.env.NOA_LIVE_CLAUDE_ATTACH === "1")("live Claude Code: attached pictures", () => {
  it("Claude Code, which has no Read, sees a picture sent with the first message and one sent with a follow-up", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: home };
    delete env[ENV.brain];
    const x = new FakeX({ account: "alice", url: "https://example.com/" });
    const { child, ext } = startHost({ env, browser: (m: BrowserMethod, p) => x.handle(m, p as never) });
    const config = { maxToolCalls: 10, maxTaskMinutes: 4, jevEnabled: false, jevThreshold: 0.8, isRetry: false, model: process.env.NOA_LIVE_MODEL ?? "claude-sonnet-5" };
    try {
      const info = await ext.call("helper.hello", {}, { timeoutMs: 90_000 });
      expect(info.selfTest?.ok).toBe(true);
      const first = halvesPng(RED, BLUE);
      const firstRef = { id: "a1", name: "halves.png", type: "image/png", size: first.length, kind: "image" as const, width: 96, height: 64 };
      await ext.call("helper.putAttachment", { sessionId: "LIVE-ATT", id: "a1", offset: 0, dataBase64: first.toString("base64") }, { timeoutMs: 10_000 });
      let started = Date.now();
      const result = await ext.call(
        "helper.runTask",
        {
          sessionId: "LIVE-ATT",
          task: {
            id: "T-ATT",
            account: null,
            instructions:
              "No browsing is needed. Look at the attached picture: which color fills its left half and which its right half? " +
              'Call task_complete with the summary exactly "left=<color> right=<color>".',
          },
          mediaPaths: [],
          config,
          attachments: [{ ref: firstRef, fresh: true }],
        },
        { timeoutMs: 5 * 60_000 },
      );
      console.log("first", JSON.stringify(result), `${Math.round((Date.now() - started) / 1000)} s`);
      expect(result.outcome).toBe("done");
      expect(result.summary?.toLowerCase()).toMatch(/left=red right=blue/);

      const second = halvesPng(GREEN, YELLOW);
      await ext.call("helper.putAttachment", { sessionId: "LIVE-ATT", id: "a2", offset: 0, dataBase64: second.toString("base64") }, { timeoutMs: 10_000 });
      started = Date.now();
      const next = await ext.call(
        "helper.continueSession",
        {
          sessionId: "LIVE-ATT",
          text: 'Same question for the picture I attached now. Call task_complete with the summary exactly "left=<color> right=<color>".',
          config,
          attachments: [
            { ref: firstRef, fresh: false },
            { ref: { ...firstRef, id: "a2", name: "second.png", size: second.length }, fresh: true },
          ],
        },
        { timeoutMs: 5 * 60_000 },
      );
      console.log("follow-up", JSON.stringify(next), `${Math.round((Date.now() - started) / 1000)} s`);
      expect(next.outcome).toBe("done");
      expect(next.summary?.toLowerCase()).toMatch(/left=green right=yellow/);

      const logged = readFileSync(next.logPath!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const lines = logged.filter((e) => e.type === "claude").map((e) => e.event);
      // Claude Code was offered none of its own tools, and called none.
      const init = lines.find((e) => e.type === "system" && e.subtype === "init");
      expect(init.tools.filter((t: string) => !t.startsWith("mcp__"))).toEqual([]);
      const own = lines.flatMap((e) => (e.type === "assistant" && Array.isArray(e.message?.content) ? e.message.content : [])).filter((b: { type: string; name?: string }) => b.type === "tool_use" && !b.name!.startsWith("mcp__"));
      expect(own).toEqual([]);
      // Each picture went with its own message, as an image block.
      const replays = lines.filter((e) => e.type === "user" && e.isReplay && Array.isArray(e.message?.content));
      expect(replays.map((e) => e.message.content.filter((b: { type: string }) => b.type === "image").length)).toEqual([1, 1]);
    } finally {
      child.kill();
    }
  }, 10 * 60_000);
});
