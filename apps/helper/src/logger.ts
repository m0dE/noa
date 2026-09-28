/**
 * File logging. Nothing in the helper may write to stdout (it carries native
 * messaging frames), so every diagnostic goes here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SecretRedactor } from "@noa/core";

export const LIVE_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Most lines one tail() returns. */
export const LIVE_LOG_TAIL_MAX_LINES = 5000;
/**
 * Most UTF-8 bytes one tail() returns. JSON escaping at most doubles them
 * (quotes, backslashes), which keeps getLog answers under native messaging's
 * 1 MB cap. Bytes, not characters: Korean or emoji text takes 3-4 bytes each.
 */
export const LIVE_LOG_TAIL_MAX_BYTES = 400_000;

/** Combined human-readable log, one line per event, tailed by the options page. */
export class LiveLog {
  readonly path: string;

  constructor(
    readonly dir: string,
    private readonly maxBytes = LIVE_LOG_MAX_BYTES,
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "live.log");
  }

  write(line: string): void {
    const clean = line.replace(/\r?\n/g, " | ");
    try {
      this.rotateIfNeeded();
      appendFileSync(this.path, `${new Date().toISOString()} ${clean}\n`);
    } catch {
      /* logging must never crash the helper */
    }
  }

  tail(lines: number): string {
    if (!existsSync(this.path)) return "";
    const n = Math.max(0, Math.min(Math.floor(lines) || 0, LIVE_LOG_TAIL_MAX_LINES));
    const all = readFileSync(this.path, "utf8").split("\n");
    if (all[all.length - 1] === "") all.pop();
    const text = n === 0 ? "" : all.slice(-n).join("\n");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= LIVE_LOG_TAIL_MAX_BYTES) return text;
    // Cut by bytes, then start at the next whole line (the cut may split a line, even a character).
    const cut = bytes.subarray(bytes.length - LIVE_LOG_TAIL_MAX_BYTES).toString("utf8");
    return cut.slice(cut.indexOf("\n") + 1);
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path) || statSync(this.path).size < this.maxBytes) return;
    const old = this.path + ".1";
    rmSync(old, { force: true });
    renameSync(this.path, old);
  }
}

/** Short one-line summary of an event (an AgentEvent, or a run log record) for live.log. */
export function summarize(event: { readonly type?: unknown }, max = 300): string {
  const { type, ...rest } = event;
  let body: string;
  try {
    body = JSON.stringify(rest);
  } catch {
    body = String(rest);
  }
  if (body.length > max) body = body.slice(0, max) + "...";
  return `${String(type ?? "event")} ${body}`;
}

export type EventLogger = (event: Record<string, unknown>) => void;

/** Per-run JSONL log (`runs/<task>-<stamp>/log.jsonl`), mirrored to live.log. */
export class RunLog {
  constructor(
    readonly path: string,
    private readonly live: LiveLog | null,
    private readonly taskId: string,
    /** Passwords the session's agent was given: never written to either log. */
    private readonly secrets: SecretRedactor = new SecretRedactor(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  event(raw: Record<string, unknown>): void {
    const event = this.secrets.redact(raw);
    const record = { ts: new Date().toISOString(), taskId: this.taskId, ...event };
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n");
    } catch {
      /* ignore */
    }
    this.live?.write(`${this.taskId} ${summarize(event)}`);
  }
}

/** Safety net: route console.* to the live log so nothing reaches stdout. */
export function redirectConsole(live: LiveLog): void {
  const to =
    (level: string) =>
    (...args: unknown[]) =>
      live.write(`console.${level} ${args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")}`);
  console.log = to("log");
  console.info = to("info");
  console.warn = to("warn");
  console.error = to("error");
  console.debug = to("debug");
  console.trace = to("trace");
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
