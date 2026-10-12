/**
 * Claude Code self-test: one tiny headless call that proves claude.exe starts,
 * is signed in, and can answer. Cached in memory and on disk (a passing
 * result is reused for SELF_TEST_TTL_MS so every helper start does not spend
 * a model call).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage, type HelperBrain, type HelperInfo } from "@noa/shared";
import { CLAUDE_NOT_FOUND, claudeEnv, isolatedClaudeArgs, killTree } from "./claude-process.js";

export type SelfTestResult = NonNullable<HelperInfo["selfTest"]>;

export const SELF_TEST_TIMEOUT_MS = 60_000;
export const SELF_TEST_TTL_MS = 12 * 60 * 60_000;
/** The self-test only proves Claude Code starts, is signed in and answers: the cheapest model alias does. */
export const SELF_TEST_MODEL = "haiku";

export function selfTestArgs(model = SELF_TEST_MODEL): string[] {
  return ["-p", "Reply with exactly: OK", "--output-format", "json", ...isolatedClaudeArgs(model)];
}

/** Reads `claude -p --output-format json` output. */
export function parseSelfTestOutput(stdout: string, stderr: string, code: number | null): { ok: boolean; error?: string } {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j && typeof j === "object" && "result" in j) {
      const r = j as { result?: unknown; is_error?: unknown; subtype?: unknown };
      const text = String(r.result ?? "");
      if (r.is_error) return { ok: false, error: `Claude Code error: ${text.slice(0, 300) || String(r.subtype)}` };
      if (/\bOK\b/.test(text)) return { ok: true };
      return { ok: false, error: `Unexpected reply: ${text.slice(0, 200)}` };
    }
  }
  const detail = (stderr.trim() || stdout.trim()).slice(0, 300);
  return { ok: false, error: `Claude Code exited with code ${code}${detail ? `: ${detail}` : ""}` };
}

export async function runSelfTest(opts: {
  claudePath: string;
  timeoutMs?: number;
  model?: string;
  /** Extra leading args (tests run a fake claude script with node). */
  prefixArgs?: string[];
  cwd?: string;
}): Promise<SelfTestResult> {
  const started = Date.now();
  const done = (r: { ok: boolean; error?: string }): SelfTestResult => {
    const out: SelfTestResult = { ok: r.ok, ms: Date.now() - started, at: new Date().toISOString() };
    if (r.error) out.error = r.error;
    return out;
  };
  return new Promise<SelfTestResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(done(r));
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.claudePath, [...(opts.prefixArgs ?? []), ...selfTestArgs(opts.model)], {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: claudeEnv(),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
    } catch (e) {
      resolve(done({ ok: false, error: `Could not start Claude Code: ${errorMessage(e)}` }));
      return;
    }
    const timeoutMs = opts.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, error: `Self-test timed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) => finish({ ok: false, error: `Could not start Claude Code: ${e.message}` }));
    child.on("close", (code) => finish(parseSelfTestOutput(stdout, stderr, code)));
  });
}

/** Runs the self-test at most once at a time and caches the result (memory + disk). */
export class SelfTestCache {
  private result: SelfTestResult | undefined;
  private running: Promise<SelfTestResult> | null = null;

  constructor(
    private readonly opts: {
      /** "scripted": always ok, nothing cached on disk. */
      brain: HelperBrain;
      /** null: Claude Code not found. */
      claudePath: string | null;
      cacheFile: string | null;
      run?: (claudePath: string) => Promise<SelfTestResult>;
      now?: () => number;
    },
  ) {
    this.result = this.loadDisk();
  }

  get cached(): SelfTestResult | undefined {
    return this.result;
  }

  /** The cached result, or a fresh run when there is none (or force). */
  async get(force = false): Promise<SelfTestResult> {
    if (!force && this.result) return this.result;
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async runOnce(): Promise<SelfTestResult> {
    const path = this.opts.claudePath;
    let r: SelfTestResult;
    if (this.opts.brain === "scripted") r = { ok: true, ms: 0, at: new Date().toISOString() };
    else if (!path) r = { ok: false, error: CLAUDE_NOT_FOUND, ms: 0, at: new Date().toISOString() };
    else r = await (this.opts.run ?? ((p) => runSelfTest({ claudePath: p })))(path);
    this.result = r;
    this.saveDisk(r);
    return r;
  }

  private loadDisk(): SelfTestResult | undefined {
    const file = this.opts.cacheFile;
    if (!file || this.opts.brain === "scripted" || !this.opts.claudePath || !existsSync(file)) return undefined;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as { claudePath?: string; result?: SelfTestResult };
      const r = j.result;
      const now = (this.opts.now ?? Date.now)();
      if (j.claudePath === this.opts.claudePath && r?.ok && now - Date.parse(r.at) < SELF_TEST_TTL_MS) return r;
    } catch {
      /* ignore a broken cache */
    }
    return undefined;
  }

  private saveDisk(r: SelfTestResult): void {
    const file = this.opts.cacheFile;
    if (!file || this.opts.brain === "scripted") return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ claudePath: this.opts.claudePath, result: r }, null, 2));
    } catch {
      /* best effort */
    }
  }
}
