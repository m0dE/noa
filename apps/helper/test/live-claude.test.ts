/**
 * Live check (real Claude Code, uses your subscription): dist/host.js runs
 * posting tasks against the fake X page with headless Claude Code
 * (stream-json in and out, stdin kept open).
 *   1. A task runs, a user message is typed in mid-task, and the turn ends
 *      with task_complete; the session stays open.
 *   2. A follow-up (helper.continueSession) runs in the same session.
 *   3. helper.endSession closes it; continuing it then rejects "session ended".
 * Runs only with NOA_LIVE_CLAUDE=1 (after `pnpm build`):
 *   NOA_LIVE_CLAUDE=1 pnpm --filter @noa/helper test live-claude
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delay, HelperErrorCode, type BrowserMethod, type HelperNotifications } from "@noa/shared";
import { ENV } from "../src/env-names.js";
import { FakeX } from "./fake-x.js";
import { startHost } from "./support/host-process.js";

const home = mkdtempSync(join(tmpdir(), "noa-live-test-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The helper with its real brain (Claude Code), whatever the environment says. */
function liveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: home };
  delete env[ENV.brain];
  return env;
}

describe.runIf(process.env.NOA_LIVE_CLAUDE === "1")("live Claude Code through dist/host.js", () => {
  it("posts, hears a message injected mid-task, takes a follow-up in the same session, and ends it", async () => {
    const x = new FakeX({ account: "alice", url: "https://x.com/home" });
    let open!: () => void;
    let gate: Promise<void> | null = new Promise<void>((r) => (open = r));
    const { child, ext, events, openSessions } = startHost({
      env: liveEnv(),
      browser: async (m: BrowserMethod, p) => {
        if (gate) await gate;
        return x.handle(m, p as never);
      },
      onEvent: (p) => console.log(`[event] ${p.event.type} ${JSON.stringify(p.event).slice(0, 220)}`),
    });
    const config = { maxToolCalls: 40, maxTaskMinutes: 6, jevEnabled: true, jevThreshold: 0.8, isRetry: false };
    try {
      const t0 = Date.now();
      const info = await ext.call("helper.hello", {}, { timeoutMs: 90_000 });
      console.log("hello", JSON.stringify(info), `${Date.now() - t0} ms`);
      expect(info.selfTest?.ok).toBe(true);

      // 1. The first turn, with a message typed in while it runs.
      const started = Date.now();
      const run = ext.call(
        "helper.runTask",
        { sessionId: "LIVE-1", task: { id: "T-LIVE", instructions: "Post: live check from Noa", account: null }, mediaPaths: [], config },
        { timeoutMs: 7 * 60_000 },
      );
      // Hold the first browser call until the message is in.
      await vi.waitFor(() => expect(events.some((e) => e.sessionId === "LIVE-1" && e.event.type === "tool_call")).toBe(true), { timeout: 5 * 60_000, interval: 100 });
      const said = await ext.call(
        "helper.sendUserMessage",
        { sessionId: "LIVE-1", text: "Change of plan: add the hashtag #bt2 at the very end of the post text." },
        { timeoutMs: 5000 },
      );
      await delay(3000);
      gate = null;
      open();
      const result = await run;
      console.log("result", JSON.stringify(result), `${Math.round((Date.now() - started) / 1000)} s`, JSON.stringify(x.posts));
      expect(said.ok).toBe(true);
      expect(result.outcome).toBe("done");
      const first = x.posts.filter((p) => p.text.includes("live check from Noa"));
      expect(first).toHaveLength(1);
      expect(first[0]!.text).toContain("#bt2");
      const mine = events.filter((e) => e.sessionId === "LIVE-1").map((e) => e.event).filter((e) => e.type !== "trace");
      expect(mine[0]).toEqual({ type: "status", text: expect.stringMatching(/^Claude Code started \(/) });
      expect(mine.some((e) => e.type === "assistant_text")).toBe(true);
      expect(mine.some((e) => e.type === "tool_call" && e.name === "task_complete")).toBe(true);

      // 2. A follow-up turn in the same session.
      const t1 = Date.now();
      const follow = await ext.call(
        "helper.continueSession",
        { sessionId: "LIVE-1", text: "Now post one more: follow-up from Noa", config },
        { timeoutMs: 7 * 60_000 },
      );
      console.log("follow-up", JSON.stringify(follow), `${Math.round((Date.now() - t1) / 1000)} s`, JSON.stringify(x.posts));
      expect(follow.outcome).toBe("done");
      expect(x.posts.filter((p) => p.text.includes("follow-up from Noa"))).toHaveLength(1);
      // Same Claude Code process: no second "started" status.
      expect(events.filter((e) => e.sessionId === "LIVE-1" && e.event.type === "status" && /^Claude Code started/.test((e.event as { text: string }).text))).toHaveLength(1);

      // 3. Ending it.
      expect(await ext.call("helper.endSession", { sessionId: "LIVE-1" }, { timeoutMs: 5000 })).toEqual({ ok: true });
      await vi.waitFor(() => expect(openSessions()).not.toContain("LIVE-1"), { timeout: 30_000 });
      await expect(ext.call("helper.continueSession", { sessionId: "LIVE-1", text: "x", config }, { timeoutMs: 5000 })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
    } finally {
      child.stdin.end();
      await delay(1000);
      if (child.exitCode === null) child.kill();
    }
  }, 12 * 60_000);

  it("streams a long answer as text deltas over time, answers in the chat and keeps the run log free of deltas", async () => {
    const x = new FakeX({ account: "alice", url: "https://x.com/home" });
    const seen: { at: number; event: HelperNotifications["helper.event"]["event"] }[] = [];
    const { child, ext } = startHost({
      env: liveEnv(),
      methods: ["browser.navigate", "browser.readPage", "browser.screenshot", "browser.currentUrl"],
      browser: (m, p) => x.handle(m, p as never),
      onEvent: (p) => {
        if (p.sessionId === "LIVE-STREAM") seen.push({ at: Date.now(), event: p.event });
      },
    });
    const config = { maxToolCalls: 10, maxTaskMinutes: 6, jevEnabled: false, jevThreshold: 0.8, isRetry: false };
    try {
      await ext.call("helper.hello", {}, { timeoutMs: 90_000 });
      const started = Date.now();
      const result = await ext.call(
        "helper.runTask",
        {
          sessionId: "LIVE-STREAM",
          task: { id: "T-STREAM", instructions: "How do I publish a Chrome extension to the Chrome Web Store? Explain the steps in detail. You do not need the browser for this.", account: null },
          mediaPaths: [],
          config,
        },
        { timeoutMs: 7 * 60_000 },
      );
      const deltas = seen.filter((s) => s.event.type === "assistant_text_delta");
      const finals = seen.filter((s) => s.event.type === "assistant_text") as { at: number; event: { type: "assistant_text"; text: string; id?: string } }[];
      const answer = finals.reduce((a, b) => (b.event.text.length > a.event.text.length ? b : a));
      const answerDeltas = deltas.filter((d) => (d.event as { id: string }).id === answer.event.id);
      const summary = { ...result };
      process.stdout.write(
        "stream " +
        JSON.stringify({
          timeToFirstTextMs: deltas.length ? deltas[0]!.at - started : null,
          timeToFinalTextMs: answer.at - started,
          deltas: deltas.length,
          answerDeltas: answerDeltas.length,
          answerDeltaSpanMs: answerDeltas.length ? answerDeltas.at(-1)!.at - answerDeltas[0]!.at : 0,
          answerChars: answer.event.text.length,
          finals: finals.length,
          summary: summary.summary,
          outcome: summary.outcome,
          totalMs: Date.now() - started,
        }) + "\n",
      );
      expect(result.outcome).toBe("done");
      // The answer is chat text, streamed in many pieces over time, and the deltas add up to it.
      expect(answer.event.id).toBeTruthy();
      expect(answerDeltas.length).toBeGreaterThan(5);
      expect(answerDeltas.at(-1)!.at - answerDeltas[0]!.at).toBeGreaterThan(1000);
      expect(answerDeltas.map((d) => (d.event as { text: string }).text).join("")).toBe(answer.event.text);
      expect(answer.event.text.length).toBeGreaterThan(400);
      // task_complete's summary is one short line, not the answer.
      expect(result.summary ?? "").not.toContain("\n");
      expect((result.summary ?? "").length).toBeLessThan(200);
      // The run log has the final text but no deltas or raw stream_event lines.
      const log = readFileSync(result.logPath!, "utf8");
      expect(log).not.toContain('"assistant_text_delta"');
      expect(log).not.toContain('"stream_event"');
      expect(log).toContain('"assistant_text"');
    } finally {
      child.stdin.end();
      await delay(1000);
      if (child.exitCode === null) child.kill();
    }
  }, 8 * 60_000);
});
