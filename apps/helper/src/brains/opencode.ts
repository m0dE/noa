/**
 * The Local model brain: OpenCode (opencode-process.ts) on the model the user runs on their own computer, with Noa's
 * MCP tools (named noa_<tool> there) beside OpenCode's web search, web page reader and skills. Each message is one
 * `opencode run` (the message on stdin, JSON events out); the next message continues the same OpenCode session
 * (--session), so the session stays open between turns without a process waiting.
 *
 * Messages the user types mid-turn reach the model with the next Noa tool result (the tool executor hands them over);
 * the rest go as the next message once the run ends. The model's reasoning shows live as thinking.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DeltaBatcher, MAX_ASSISTANT_TEXT, TASK_END_TOOLS, clipEventText, type AgentEvent } from "@noa/shared";
import { plainErrorText, type ContentBlock } from "@noa/core";
import { killTree } from "../claude-process.js";
import { LineSplitter } from "../line-framing.js";
import { buildOpencodeConfig, opencodeEnv, opencodeRunArgs } from "../opencode-process.js";
import { systemPromptFile } from "./claude-code.js";
import type { Brain, BrainContext } from "./brain.js";

/** What the brain reads of the session's MCP config (buildMcpConfig). */
interface McpConfigFile {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

/** The fields of an `opencode run --format json` line the brain reads (untrusted JSON: each is checked before use). */
interface RunLine {
  type?: unknown;
  sessionID?: unknown;
  part?: {
    id?: unknown;
    text?: unknown;
    tool?: unknown;
    callID?: unknown;
    state?: { status?: unknown; input?: unknown; output?: unknown; error?: unknown };
  };
  error?: { name?: unknown; data?: { message?: unknown } };
}

function asRunLine(value: unknown): RunLine | null {
  return value && typeof value === "object" ? (value as RunLine) : null;
}

/**
 * Sent once when a run ends without the turn's task_* result: open models often stop after writing the answer, and
 * a turn without a result fails (ENDED_WITHOUT_RESULT). The rule as the system prompt states it, not new instructions.
 */
export const RESULT_REMINDER =
  "You stopped without calling noa_task_complete, noa_task_fail or noa_task_pause. Finish by calling exactly one of them now. If you already wrote the answer as message text, do not write it again: call noa_task_complete with a one-line summary. If the task is not done, go on with it.";

/** OpenCode's name for Noa's tool `name` (its MCP server is "noa"). */
export function noaToolName(name: string): string {
  return `noa_${name}`;
}

/**
 * OpenCode JSON events to AgentEvents: its text and reasoning, and its own tools' calls and results (websearch,
 * webfetch, skill). Noa's tools are left out: the helper's tool executor emits them.
 */
export function mapRunLine(line: unknown): AgentEvent[] {
  const ev = asRunLine(line);
  const part = ev?.part;
  if (!ev) return [];
  if (ev.type === "text" && typeof part?.text === "string" && part.text.trim()) {
    return [{ type: "assistant_text", text: clipEventText(part.text.trim(), MAX_ASSISTANT_TEXT) }];
  }
  if (ev.type === "reasoning" && typeof part?.text === "string" && part.text.trim() && typeof part.id === "string") {
    return [{ type: "assistant_text_delta", id: part.id, text: part.text.trim(), thinking: true }];
  }
  if (ev.type === "tool_use" && typeof part?.tool === "string" && !part.tool.startsWith("noa_")) {
    const id = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : part.tool;
    const state = part.state ?? {};
    const failed = state.status === "error";
    const out = failed ? state.error : state.output;
    return [
      { type: "tool_call", id, name: part.tool, args: state.input ?? {} },
      { type: "tool_result", id, name: part.tool, ...(typeof out === "string" && out ? { text: clipEventText(out) } : {}), ...(failed ? { isError: true } : {}) },
    ];
  }
  if (ev.type === "error") {
    const message = ev.error?.data?.message;
    const detail = typeof message === "string" && message.trim() ? plainErrorText(message.trim()) : typeof ev.error?.name === "string" ? ev.error.name : "error";
    return [{ type: "error", text: clipEventText(`OpenCode: ${detail}`) }];
  }
  return [];
}

/** A Noa task_* tool (task_complete, task_fail, task_pause) finished in this line: the turn may have its result. */
function finishedTaskTool(line: unknown): boolean {
  const part = asRunLine(line)?.part;
  if (asRunLine(line)?.type !== "tool_use" || typeof part?.tool !== "string") return false;
  return part.state?.status === "completed" && TASK_END_TOOLS.some((n) => part.tool === noaToolName(n));
}

/** Attached images and PDFs (ContentBlocks) as files in the run folder, for `opencode run --file`. */
export function writeBlockFiles(runDir: string, blocks: readonly ContentBlock[], turn: number): string[] {
  const files: string[] = [];
  blocks.forEach((b, i) => {
    const source = (b as { source?: { type?: string; media_type?: string; data?: string } }).source;
    if (source?.type !== "base64" || typeof source.data !== "string") return;
    const ext = source.media_type === "application/pdf" ? "pdf" : (source.media_type?.split("/")[1] ?? "bin");
    const path = join(runDir, `attached-${turn}-${i + 1}.${ext}`);
    writeFileSync(path, Buffer.from(source.data, "base64"));
    files.push(path);
  });
  return files;
}

export class OpencodeBrain implements Brain {
  readonly persistent = true;

  constructor(
    private readonly opts: {
      opencodePath: string;
      /** The Local model's server (RunConfig.local). */
      serverUrl: string;
      /** The model when the extension names none. */
      model: string;
      apiKey?: string;
      /** Extra leading args, for tests that run a fake opencode script with node. */
      prefixArgs?: string[];
    },
  ) {}

  async run(ctx: BrainContext): Promise<void> {
    let model = ctx.model?.trim() || this.opts.model;
    ctx.onModelChange?.((next) => {
      ctx.log({ type: "opencode_model", model: next });
      model = next;
    });
    const promptPath = systemPromptFile(ctx.mcpConfigPath, ctx.systemPrompt);
    if (!existsSync(promptPath)) writeFileSync(promptPath, ctx.systemPrompt, "utf8");
    const mcp = (JSON.parse(readFileSync(ctx.mcpConfigPath, "utf8")) as McpConfigFile).mcpServers.noa;
    if (!mcp) throw new Error("The session's MCP config has no Noa server");
    const runDir = dirname(ctx.mcpConfigPath);
    let session: string | undefined;
    let turns = 0;

    // Follow-ups (persistent session) wait here until the running turn is over.
    type Message = { text: string; blocks?: readonly ContentBlock[] };
    const followUps: Message[] = [];
    let wake: (() => void) | null = null;
    ctx.input.onMessage((text, blocks) => {
      followUps.push({ text, ...(blocks ? { blocks } : {}) });
      wake?.();
    });
    ctx.input.onClose(() => wake?.());
    ctx.signal.addEventListener("abort", () => wake?.(), { once: true });
    /** The user's next message, or null once the session is closed (or stopped). */
    const nextMessage = async (): Promise<Message | null> => {
      while (!followUps.length && !ctx.input.closed && !ctx.signal.aborted) await new Promise<void>((r) => (wake = r));
      wake = null;
      return ctx.signal.aborted ? null : (followUps.shift() ?? null);
    };

    let message: Message | null = { text: ctx.prompt, ...(ctx.blocks ? { blocks: ctx.blocks } : {}) };
    /** RESULT_REMINDER was sent in this turn. */
    let reminded = false;
    while (message && !ctx.signal.aborted) {
      turns++;
      const files = message.blocks?.length ? writeBlockFiles(runDir, message.blocks, turns) : [];
      const config = buildOpencodeConfig({
        serverUrl: this.opts.serverUrl,
        model,
        ...(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {}),
        systemPromptPath: promptPath,
        mcp,
      });
      const ran = await this.runOnce(ctx, message.text, { config, runDir, ...(session ? { session } : {}), files, model });
      session = ran.session ?? session;
      if (ctx.signal.aborted) break;
      // A run that failed (the server refused, OpenCode crashed) said why: reminding it would only fail again.
      if (ran.failed) reminded = true;
      // Messages typed while the model only wrote (no Noa tool result to bring them) go now, as the next message.
      const waiting = ctx.interjections.handOff("next_message");
      if (waiting !== null) {
        ctx.log({ type: "opencode_user_message", kind: "next_message", chars: waiting.length });
        message = { text: waiting };
        continue;
      }
      if (!reminded && !ctx.input.closed && ctx.turnOver && !ctx.turnOver()) {
        reminded = true;
        ctx.log({ type: "opencode_user_message", kind: "result_reminder", chars: RESULT_REMINDER.length });
        message = { text: RESULT_REMINDER };
        continue;
      }
      ctx.log({ type: "opencode_turns_done" });
      if (ctx.input.closed) break;
      ctx.idle?.();
      message = await nextMessage();
      reminded = false;
      if (message) ctx.log({ type: "opencode_user_message", kind: "followup", chars: message.text.length, ...(message.blocks?.length ? { blocks: message.blocks.length } : {}) });
    }
  }

  /** One `opencode run`: resolves with OpenCode's session id once the process has exited, and whether it failed. */
  private runOnce(
    ctx: BrainContext,
    text: string,
    run: { config: Record<string, unknown>; runDir: string; session?: string; files: string[]; model: string },
  ): Promise<{ session?: string; failed: boolean }> {
    const args = [...(this.opts.prefixArgs ?? []), ...opencodeRunArgs({ ...(run.session ? { session: run.session } : {}), files: run.files })];
    ctx.log({ type: "opencode_start", opencodePath: this.opts.opencodePath, model: run.model, server: this.opts.serverUrl, session: run.session ?? null, files: run.files.length });
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.opts.opencodePath, args, { cwd: run.runDir, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: opencodeEnv(run.config) });
      } catch (e) {
        return reject(e);
      }
      const out = new DeltaBatcher(ctx.emit);
      let session: string | undefined;
      /** Stopped because the turn had its task_* result: what it wrote after that reaches nobody. */
      let stoppedAfterResult = false;
      const onAbort = () => {
        ctx.log({ type: "opencode_kill", reason: String(ctx.signal.reason ?? "aborted") });
        killTree(child);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      // The message goes on stdin: OpenCode reads it to the end (a run whose stdin stays open waits for it).
      child.stdin!.on("error", (e) => ctx.log({ type: "opencode_stdin_error", message: e.message }));
      child.stdin!.end(text, "utf8");

      const lines = new LineSplitter();
      child.stdout!.on("data", (chunk: Buffer) => {
        for (const line of lines.push(chunk)) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            ctx.log({ type: "opencode_stdout", text: line.slice(0, 2000) });
            continue;
          }
          ctx.log({ type: "opencode", event });
          const ev = asRunLine(event);
          if (!session && typeof ev?.sessionID === "string") session = ev.sessionID;
          if (stoppedAfterResult) continue;
          for (const e of mapRunLine(event)) {
            if (e.type === "assistant_text_delta") out.delta(e.id, e.text, e.thinking);
            else out.emit(e);
          }
          // OpenCode asks the model once more after a tool's result: once the turn has its result, that answer
          // would reach nobody and costs a local model seconds to minutes. The session keeps the result for the next run.
          if (finishedTaskTool(event) && ctx.turnOver?.()) {
            stoppedAfterResult = true;
            ctx.log({ type: "opencode_stop", reason: "turn over" });
            killTree(child);
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => ctx.log({ type: "opencode_stderr", text: chunk.toString("utf8").slice(0, 2000) }));
      child.on("error", (e) => {
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "opencode_error", message: e.message });
        reject(e);
      });
      child.on("close", (code, signal) => {
        out.flush();
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "opencode_exit", code, signal, ...(stoppedAfterResult ? { stoppedAfterResult } : {}) });
        const failed = code !== 0 && !stoppedAfterResult && !ctx.signal.aborted;
        if (failed) out.emit({ type: "error", text: `OpenCode exited with code ${code ?? signal}` });
        resolve({ ...(session ? { session } : {}), failed });
      });
    });
  }
}
