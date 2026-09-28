import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memorySummarizeArgs, parseSummarizeOutput, runMemorySummarize } from "../src/memory-summarize.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bt-summarize-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function script(body: string): string {
  const file = join(dir, `fake-${++n}.mjs`);
  writeFileSync(file, body);
  return file;
}

describe("memory.summarize (fake claude)", () => {
  it("runs one headless call on haiku with the system prompt file and no tools or settings", () => {
    expect(memorySummarizeArgs("C:\\t\\system-prompt.txt")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--system-prompt-file",
      "C:\\t\\system-prompt.txt",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--model",
      "haiku",
    ]);
  });

  it("parses the result and its cost; errors and garbage throw", () => {
    expect(parseSummarizeOutput('{"type":"result","is_error":false,"result":"{\\"episode\\":null}","total_cost_usd":0.0021}', "", 0)).toEqual({
      text: '{"episode":null}',
      costUsd: 0.0021,
    });
    expect(parseSummarizeOutput('{"type":"result","result":"x"}', "", 0)).toEqual({ text: "x" });
    expect(() => parseSummarizeOutput('{"type":"result","is_error":true,"result":"Not logged in"}', "", 1)).toThrow("Claude Code error: Not logged in");
    expect(() => parseSummarizeOutput("", "boom", 3)).toThrow("Claude Code exited with code 3: boom");
  });

  it("sends the prompt on stdin and the system prompt in a file (the command line has a limit), removed afterwards", async () => {
    const echo = script(`
      import { readFileSync } from "node:fs";
      let input = "";
      process.stdin.on("data", (c) => (input += c));
      process.stdin.on("end", () => {
        const args = process.argv.slice(2);
        const file = args[args.indexOf("--system-prompt-file") + 1];
        const result = JSON.stringify([file, readFileSync(file, "utf8"), input]);
        process.stdout.write(JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: 0.001 }) + "\\n");
      });`);
    const system = `rules "quoted"\nline two ${"x".repeat(40_000)}`;
    const r = await runMemorySummarize({ claudePath: process.execPath, prefixArgs: [echo], system, prompt: "Ünïcode prompt\nwith lines" });
    const [file, seenSystem, input] = JSON.parse(r.text) as string[];
    expect([seenSystem, input, r.costUsd]).toEqual([system, "Ünïcode prompt\nwith lines", 0.001]);
    expect(existsSync(dirname(file!))).toBe(false);
  });

  it("rejects on a Claude Code error and on a timeout (the process is killed)", async () => {
    const bad = script(`process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" })); process.exit(1)`);
    await expect(runMemorySummarize({ claudePath: process.execPath, prefixArgs: [bad], system: "s", prompt: "p" })).rejects.toThrow("Claude Code error: Not logged in");
    const hang = script(`setInterval(() => {}, 1000)`);
    await expect(runMemorySummarize({ claudePath: process.execPath, prefixArgs: [hang], system: "s", prompt: "p", timeoutMs: 300 })).rejects.toThrow(
      "Claude Code did not answer within 0 s",
    );
  });

  it("rejects when claude cannot be started", async () => {
    await expect(runMemorySummarize({ claudePath: join(dir, "missing.exe"), system: "s", prompt: "p" })).rejects.toThrow(/Could not start Claude Code/);
  });
});
