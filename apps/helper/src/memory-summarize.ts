/**
 * memory.summarize: the extension's background memory writer (packages/shared/src/memory-writer.ts) on Claude
 * Code. One headless `claude -p` call on the cheapest model, with the writer's system prompt in a file of its own (its
 * size is the caller's; the command line has a limit) and the conversation's prompt on stdin, no tools, no settings
 * and nothing saved (isolatedClaudeArgs), on the user's own Claude Code login (claudeEnv). Its JSON result gives the model's answer and what the call cost.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, MEMORY_SUMMARIZE_TIMEOUT_MS, MEMORY_WRITER_CLAUDE_CODE_MODEL, type HelperMethods } from "@noa/shared";
import { claudeEnv, isolatedClaudeArgs, killTree } from "./claude-process.js";

export type SummarizeResult = HelperMethods["memory.summarize"]["result"];

/** How much of Claude Code's output an error message quotes. */
const ERROR_DETAIL_CHARS = 300;

export function memorySummarizeArgs(systemFile: string, model = MEMORY_WRITER_CLAUDE_CODE_MODEL): string[] {
  return ["-p", "--output-format", "json", "--system-prompt-file", systemFile, ...isolatedClaudeArgs(model)];
}

/** Reads `claude -p --output-format json` output: the answer and its cost, or throws with why it failed. */
export function parseSummarizeOutput(stdout: string, stderr: string, code: number | null): SummarizeResult {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!j || typeof j !== "object" || !("result" in j)) continue;
    const r = j as { result?: unknown; is_error?: unknown; subtype?: unknown; total_cost_usd?: unknown };
    const text = String(r.result ?? "");
    if (r.is_error) throw new Error(`Claude Code error: ${text.slice(0, ERROR_DETAIL_CHARS) || String(r.subtype)}`);
    return { text, ...(typeof r.total_cost_usd === "number" ? { costUsd: r.total_cost_usd } : {}) };
  }
  const detail = (stderr.trim() || stdout.trim()).slice(0, ERROR_DETAIL_CHARS);
  throw new Error(`Claude Code exited with code ${code}${detail ? `: ${detail}` : ""}`);
}

export function runMemorySummarize(opts: {
  claudePath: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
  model?: string;
  /** Extra leading args (tests run a fake claude script with node). */
  prefixArgs?: string[];
  cwd?: string;
}): Promise<SummarizeResult> {
  return new Promise<SummarizeResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const promptDir = mkdtempSync(join(tmpdir(), "noa-memory-"));
    const systemFile = join(promptDir, "system-prompt.txt");
    writeFileSync(systemFile, opts.system, "utf8");
    // Once no process holds it open: on "close" (which follows a failed start too; on a timeout, finish comes
    // before the killed process is gone). A file left in the temp folder harms nothing; a throw here would end the helper.
    const removePromptDir = () => {
      try {
        rmSync(promptDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* see above */
      }
    };
    const finish = (fn: () => SummarizeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(fn());
      } catch (e) {
        reject(e instanceof Error ? e : new Error(errorMessage(e)));
      }
    };
    const timeoutMs = opts.timeoutMs ?? MEMORY_SUMMARIZE_TIMEOUT_MS;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.claudePath, [...(opts.prefixArgs ?? []), ...memorySummarizeArgs(systemFile, opts.model)], {
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: claudeEnv(),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
    } catch (e) {
      removePromptDir();
      reject(new Error(`Could not start Claude Code: ${errorMessage(e)}`));
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish(() => {
        throw new Error(`Claude Code did not answer within ${Math.round(timeoutMs / 1000)} s`);
      });
    }, timeoutMs);
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    // A process that exits before reading its input breaks the pipe: its exit code says what happened.
    child.stdin!.on("error", () => {});
    child.on("error", (e) =>
      finish(() => {
        throw new Error(`Could not start Claude Code: ${e.message}`);
      }),
    );
    child.on("close", (code) => {
      finish(() => parseSummarizeOutput(stdout, stderr, code));
      removePromptDir();
    });
    child.stdin!.end(opts.prompt, "utf8");
  });
}
