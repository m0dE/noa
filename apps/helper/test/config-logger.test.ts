import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadEnv, parseDotEnv } from "../src/config.js";
import { SecretRedactor } from "@noa/core";
import { DEFAULT_MODEL } from "@noa/shared";
import { LiveLog, LIVE_LOG_TAIL_MAX_BYTES, RunLog } from "../src/logger.js";
import { encodeNativeMessage, MAX_NATIVE_OUT } from "../src/native-framing.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config", () => {
  it("parses .env text: comments, quotes, export prefix, blank lines", () => {
    const env = parseDotEnv("# c\nA=1\nexport B=\"two words\"\nC='x=y'\n\nD = spaced \nbad line\n");
    expect(env).toEqual({ A: "1", B: "two words", C: "x=y", D: "spaced" });
  });

  it("merges .env files in order, and process env wins even when empty", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, ".env"), "X=from-a\nY=from-a\n");
    writeFileSync(join(b, ".env"), "Y=from-b\nZ=from-b\n");
    const env = loadEnv([a, b, join(dir, "missing")], { Z: "" });
    expect(env).toEqual({ X: "from-a", Y: "from-b", Z: "" });
  });

  it("derives paths, brain and Jev key from env", () => {
    const cfg = loadConfig({ NOA_HOME: dir, TYPESAFE_API_KEY: "  ", NOA_BRAIN: "scripted" }, { dotenvDirs: [] });
    expect(cfg.baseDir).toBe(dir);
    expect(cfg.logDir).toBe(join(dir, "logs"));
    expect(cfg.runsDir).toBe(join(dir, "runs"));
    expect(cfg.typesafeApiKey).toBeNull();
    expect(cfg.brain).toBe("scripted");
    // The same model the extension's setting defaults to, by its full id (Claude Code's "sonnet" alias may name another).
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(cfg.mcpServerPath.endsWith(join("dist", "mcp-server.js"))).toBe(true);
    const withKey = loadConfig({ NOA_HOME: dir, TYPESAFE_API_KEY: "k", NOA_MODEL: "opus" }, { dotenvDirs: [] });
    expect(withKey.typesafeApiKey).toBe("k");
    expect(withKey.brain).toBe("claude");
    expect(withKey.model).toBe("opus");
  });

  it("reads Claude Code's forced thinking (NOA_THINKING); unset, each run follows the extension's Reasoning setting (null)", () => {
    expect(loadConfig({ NOA_HOME: dir, NOA_THINKING: "off" }, { dotenvDirs: [] }).thinking).toBe(false);
    expect(loadConfig({ NOA_HOME: dir, NOA_THINKING: " ON " }, { dotenvDirs: [] }).thinking).toBe(true);
    expect(loadConfig({ NOA_HOME: dir }, { dotenvDirs: [] }).thinking).toBeNull();
    expect(loadConfig({ NOA_HOME: dir, NOA_THINKING: "maybe" }, { dotenvDirs: [] }).thinking).toBeNull();
  });

  it("defaults the base dir to %LOCALAPPDATA%\\noa", () => {
    const cfg = loadConfig({ LOCALAPPDATA: dir }, { dotenvDirs: [] });
    expect(cfg.baseDir).toBe(join(dir, "noa"));
  });
});

describe("logger", () => {
  it("writes JSONL events per run and a readable line to live.log", () => {
    const live = new LiveLog(join(dir, "logs"));
    const run = new RunLog(join(dir, "run", "log.jsonl"), live, "T1");
    run.event({ type: "tool_call", name: "click", args: { index: 3 } });
    run.event({ type: "note", text: "line1\nline2" });
    const lines = readFileSync(run.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "tool_call", name: "click", taskId: "T1" });
    expect(typeof lines[0].ts).toBe("string");
    const tail = live.tail(10);
    expect(tail.split("\n")).toHaveLength(2);
    expect(tail).toContain("T1 tool_call");
  });

  it("tail returns only the last N lines", () => {
    const live = new LiveLog(dir);
    for (let i = 0; i < 20; i++) live.write(`line ${i}`);
    expect(live.tail(3)).toMatch(/line 17\n.*line 18\n.*line 19$/);
  });

  it("keeps one event on one line", () => {
    const live = new LiveLog(dir);
    live.write("a\nb");
    expect(live.tail(10).split("\n")).toHaveLength(1);
  });

  it("a tail of Korean text still fits one native message: capped in bytes, starting at a whole line", () => {
    const live = new LiveLog(dir, 50 * 1024 * 1024);
    // ~3 bytes per character and quotes that JSON escapes: 400,000 characters of this were 1.2+ MB.
    const line = `"작업" ${"한국어 로그 줄입니다 ".repeat(40)}`;
    for (let i = 0; i < 1500; i++) live.write(`${i} ${line}`);
    const tail = live.tail(5000);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(LIVE_LOG_TAIL_MAX_BYTES);
    expect(tail).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(tail).toMatch(/1499 "작업"/);
    expect(encodeNativeMessage({ id: "h1", result: { text: tail } }).length).toBeLessThan(MAX_NATIVE_OUT);
  });

  it("a run log never contains a secret the session knows, nor does live.log", () => {
    const live = new LiveLog(join(dir, "logs"));
    const secrets = new SecretRedactor();
    const run = new RunLog(join(dir, "run", "log.jsonl"), live, "T1", secrets);
    secrets.add("s3cret-pw");
    run.event({ type: "claude", event: { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "username: u\npassword: s3cret-pw" }] }] } } });
    expect(readFileSync(run.path, "utf8")).not.toContain("s3cret-pw");
    expect(readFileSync(run.path, "utf8")).toContain("[redacted]");
    expect(live.tail(10)).not.toContain("s3cret-pw");
  });

  it("rotates live.log past the size limit", () => {
    const live = new LiveLog(dir, 1000);
    for (let i = 0; i < 50; i++) live.write("x".repeat(50));
    expect(existsSync(join(dir, "live.log.1"))).toBe(true);
    expect(statSync(join(dir, "live.log")).size).toBeLessThan(1100);
  });
});
