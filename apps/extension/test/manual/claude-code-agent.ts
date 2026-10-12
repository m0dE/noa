/**
 * The real agent for the live voice runs (test/manual/*.live.ts): the helper with headless Claude Code on this
 * machine's login, on a fake Gmail.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localTimeZone, type AgentEvent } from "@noa/shared";
import { buildFollowUpMessage } from "@noa/core";
import { startHost, type HostProcess } from "../../../helper/test/support/host-process.js";
import { ENV } from "../../../helper/src/env-names.js";
import { FakeGmail } from "./fake-gmail.js";

type Emit = (ev: AgentEvent) => void;

/**
 * The real agent as the extension's default brain runs it: the helper (apps/helper dist/host.js, `pnpm --filter
 * @noa/helper build` first) with headless Claude Code on this machine's login, on a fake Gmail. Driven like the
 * extension's runner: helper.runTask for the first request, helper.sendUserMessage for one while its turn runs,
 * helper.continueSession (buildFollowUpMessage) for one after. The helper's events reach the voice as the panel gets
 * them: the brain's echo of a message is dropped (the runner shows the voice message instead), and of the traces only
 * "interjection" (sessions.ts passes it on live).
 */
export class ClaudeCodeAgent {
  working = false;
  requests = 0;
  ended = 0;
  private host: HostProcess | null = null;
  private ready: Promise<void> | null = null;
  private started = false;
  private readonly gmail = new FakeGmail();
  private readonly config = { maxToolCalls: 40, maxTaskMinutes: 6, jevEnabled: false, jevThreshold: 0.8, isRetry: false };
  constructor(
    private readonly emit: Emit,
    private readonly setWorking: (w: boolean) => void,
    private readonly log: (line: string) => void,
  ) {}

  /** Starts the helper (its self test runs Claude Code once). */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const env: NodeJS.ProcessEnv = { ...process.env, [ENV.home]: mkdtempSync(join(tmpdir(), "noa-live-voice-")) };
    delete env[ENV.brain];
    this.host = startHost({
      env,
      methods: ["browser.navigate", "browser.readPage", "browser.screenshot", "browser.click", "browser.type", "browser.paste", "browser.pressKey", "browser.scroll", "browser.currentUrl", "browser.listTabs", "browser.switchTab", "browser.waitFor"],
      browser: (m, p) => this.gmail.handle(m, p as never),
      onEvent: ({ event: e }) => {
        if (e.type === "user_message" || e.type === "assistant_text_delta") return;
        if (e.type === "trace") {
          if (e.trace.cat !== "user" || e.trace.name !== "interjection") return;
          this.log("AGENT   read the message sent into its turn");
        }
        if (e.type === "assistant_text") this.log(`AGENT   text: "${e.text.replace(/\s+/g, " ").slice(0, 140)}"`);
        if (e.type === "tool_call") this.log(`AGENT   tool: ${e.name}${e.name === "answer_user" ? ` "${String((e.args as { text?: unknown }).text)}"` : ""}`);
        if (e.type === "task_end") this.log(`AGENT   -> task_end ${e.outcome}: spoken "${e.spoken ?? ""}"`);
        this.emit(e);
      },
    });
    this.ready = this.host.ext.call("helper.hello", {}, { timeoutMs: 120_000 }).then((info) => {
      this.log(`AGENT   helper ready (self test ${info.selfTest?.ok ? "ok" : "FAILED"})`);
    });
    return this.ready;
  }

  stop(): void {
    this.host?.child.stdin.end();
    setTimeout(() => this.host?.child.exitCode === null && this.host.child.kill(), 1_000);
  }

  async request(text: string): Promise<void> {
    this.requests++;
    const n = this.requests;
    this.log(`AGENT   <- request #${n}${this.working ? " (into the running turn)" : ""}: "${text}"`);
    const ext = this.host!.ext;
    if (this.working) {
      this.emit({ type: "user_message", text, voice: true });
      const r = await ext.call("helper.sendUserMessage", { sessionId: "LIVE-VOICE", text }, { timeoutMs: 5_000 });
      if (!r.ok) this.log("AGENT   the running turn did not take the message");
      return;
    }
    this.working = true;
    this.setWorking(true);
    try {
      if (!this.started) {
        this.started = true;
        // A new chat's first turn has no message of its own (the request is the task).
        await ext.call(
          "helper.runTask",
          { sessionId: "LIVE-VOICE", task: { id: "T-LIVE-VOICE", instructions: text, account: null, userTab: { ...FakeGmail.start, access: "here" } }, mediaPaths: [], config: this.config },
          { timeoutMs: 8 * 60_000 },
        );
      } else {
        this.emit({ type: "user_message", text, voice: true });
        await ext.call("helper.continueSession", { sessionId: "LIVE-VOICE", text: buildFollowUpMessage({ text, timeZone: localTimeZone() }), config: this.config }, { timeoutMs: 8 * 60_000 });
      }
    } catch (err) {
      this.log(`AGENT   failed: ${String(err)}`);
    }
    this.working = false;
    this.ended++;
    this.setWorking(false);
  }
}
