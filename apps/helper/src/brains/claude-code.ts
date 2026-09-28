/**
 * Runs Claude Code headless for one task, with stream-json in and out, so
 * every assistant message is a structured event for the side panel's
 * Activity view. The task prompt is the first stdin message; stdin stays
 * open so the human can add messages while it runs. Single-turn: stdin is
 * closed after a task_* tool call (or when Claude ends its turn without
 * one). Persistent: stdin stays open for follow-up turns until the runner
 * ends the session. Claude gets the Noa MCP tools and, in a task
 * session, its own Read on the files the user attached (it runs in the
 * attachments folder and may read nothing else): no shell, web or other file
 * access.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_REASONING, DeltaBatcher, MAX_ASSISTANT_TEXT, clipEventText, type AgentEvent } from "@noa/shared";
import { plainErrorText, raiseNote, THINKING_BUDGET_TOKENS } from "@noa/core";
import { claudeEnv, isolatedClaudeArgs, killTree } from "../claude-process.js";
import { LineSplitter } from "../line-framing.js";
import { ClaudeStreamTimer } from "./claude-timing.js";
import { ClaudeTurnState } from "./claude-turn-state.js";
import type { Brain, BrainContext } from "./brain.js";

/** Claude Code's settings that turn its extended thinking off (it then answers at once). */
export const NO_THINKING_SETTINGS = JSON.stringify({ alwaysThinkingEnabled: false });

/**
 * Claude Code's own Read, for a session's attachments: allowed in its working directory (the attachments folder,
 * see WarmSpec.readDir); dontAsk refuses every call that would need a permission prompt, so any other path is refused.
 */
export const READ_ATTACHMENTS_ARGS = { tool: "Read", allow: "Read(./**)", permissionMode: "dontAsk" } as const;

/**
 * The file a session's system prompt is passed in (Claude Code's --append-system-prompt-file), in its run folder
 * (where its MCP config is): tens of KB on the command line would near Windows' 32,767-character limit. Named by its
 * content, so the same prompt is the same path and args (WarmClaude.take compares them) and a written file never
 * changes under a process reading it.
 */
export function systemPromptFile(mcpConfigPath: string, systemPrompt: string): string {
  const hash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
  return join(dirname(mcpConfigPath), `system-prompt-${hash}.txt`);
}

export function buildClaudeArgs(opts: { systemPrompt: string; mcpConfigPath: string; allowedTools: string[]; read?: boolean; model: string; thinking?: boolean }): string[] {
  const read = opts.read === true;
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Text arrives as it is written (stream_event lines), for the chat to show live.
    "--include-partial-messages",
    // Each stdin message is echoed when Claude Code reads it: whether a result ends the work (ClaudeTurnState).
    "--replay-user-messages",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    "--allowedTools",
    [...opts.allowedTools, ...(read ? [READ_ATTACHMENTS_ARGS.allow] : [])].join(","),
    ...(read ? ["--permission-mode", READ_ATTACHMENTS_ARGS.permissionMode] : []),
    "--append-system-prompt-file",
    systemPromptFile(opts.mcpConfigPath, opts.systemPrompt),
    ...(opts.thinking === false ? ["--settings", NO_THINKING_SETTINGS] : []),
    ...isolatedClaudeArgs(opts.model, read ? [READ_ATTACHMENTS_ARGS.tool] : []),
  ];
}

/** The fields of a Claude Code stream-json line the brain reads (untrusted JSON: each is checked before use). */
interface StreamLine {
  type?: unknown;
  subtype?: unknown;
  /** control_response lines. */
  response?: { subtype?: unknown; request_id?: unknown; error?: unknown };
  is_error?: unknown;
  result?: unknown;
  model?: unknown;
  message?: { id?: unknown; content?: unknown };
  /** stream_event lines: set for a subagent's stream. */
  parent_tool_use_id?: unknown;
  /** stream_event lines: the Messages API stream event. */
  event?: {
    type?: unknown;
    index?: unknown;
    message?: { id?: unknown };
    content_block?: { type?: unknown; text?: unknown };
    delta?: { type?: unknown; text?: unknown };
  };
}

function asStreamLine(value: unknown): StreamLine | null {
  return value && typeof value === "object" ? (value as StreamLine) : null;
}

/** One stream-json input line carrying a user message. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * The stream-json control request that sets Claude Code's thinking from its next turn on (not the
 * running one: measured with Claude Code 2.1.283, a change mid-turn waits for the next turn). In a
 * session started with thinking off, a budget turns it on and null turns it off again; in one started
 * with thinking on, neither 0 nor null turns it off (measured), so only the first case is used.
 */
export function thinkingLine(requestId: string, maxThinkingTokens: number | null): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "set_max_thinking_tokens", max_thinking_tokens: maxThinkingTokens } }) + "\n";
}

/**
 * The stream-json control request that switches the session's model from its next request on.
 * Claude Code first checks the model with a one-token request, answers the control request (an
 * error when the check failed: the model stays), and only then reads the next stdin message
 * (measured with Claude Code 2.1.283).
 */
export function modelLine(requestId: string, model: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "set_model", model } }) + "\n";
}

/** The stream-json control request that stops Claude Code's current model request (it answers with an error result, then reads stdin on). */
export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }) + "\n";
}

/**
 * Claude Code stream-json events to AgentEvents. Stateful: with
 * --include-partial-messages, text arrives first as stream_event deltas
 * (content_block_delta / text_delta) and then once more, complete, in an
 * "assistant" event per content block. Each streamed text block gets the id
 * "<message id>:<block index>"; its assistant_text carries the same id so
 * the chat replaces the live text with it. Thinking deltas are ignored. Tool
 * calls and results are not mapped: the helper's tool executor emits them.
 */
export class ClaudeStreamMapper {
  private messageId: string | null = null;
  /** Streamed text blocks of the current message whose assistant event has not come yet, in order. */
  private open: string[] = [];

  map(line: unknown): AgentEvent[] {
    const ev = asStreamLine(line);
    if (!ev) return [];
    if (ev.type === "stream_event") return this.partial(ev);
    const content = ev.message?.content;
    if (ev.type === "assistant" && Array.isArray(content)) {
      const sameMessage = typeof ev.message?.id === "string" && ev.message.id === this.messageId;
      const out: AgentEvent[] = [];
      for (const block of content as unknown[]) {
        const b = block as { type?: unknown; text?: unknown } | null;
        if (b?.type !== "text" || typeof b.text !== "string") continue;
        const id = sameMessage ? this.open.shift() : undefined;
        if (!b.text.trim()) continue;
        const e: AgentEvent = { type: "assistant_text", text: clipEventText(b.text, MAX_ASSISTANT_TEXT) };
        if (id) e.id = id;
        out.push(e);
      }
      return out;
    }
    if (ev.type === "result" && (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success"))) {
      const detail = typeof ev.result === "string" && ev.result.trim() ? plainErrorText(ev.result.trim()) : typeof ev.subtype === "string" ? ev.subtype : "error";
      return [{ type: "error", text: clipEventText(`Claude Code: ${detail}`) }];
    }
    if (ev.type === "system" && ev.subtype === "init") {
      return [{ type: "status", text: `Claude Code started${typeof ev.model === "string" && ev.model ? ` (${ev.model})` : ""}` }];
    }
    return [];
  }

  private partial(ev: StreamLine): AgentEvent[] {
    // Subagents' streams (none today: Claude Code runs without its own tools).
    if (ev.parent_tool_use_id) return [];
    const e = ev.event;
    if (!e || typeof e !== "object") return [];
    if (e.type === "message_start") {
      this.messageId = typeof e.message?.id === "string" ? e.message.id : null;
      this.open = [];
      return [];
    }
    if (!this.messageId || typeof e.index !== "number") return [];
    const id = `${this.messageId}:${e.index}`;
    if (e.type === "content_block_start" && e.content_block?.type === "text") {
      this.open.push(id);
      const text = e.content_block.text;
      return typeof text === "string" && text ? [{ type: "assistant_text_delta", id, text }] : [];
    }
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string" && e.delta.text && this.open.includes(id)) {
      return [{ type: "assistant_text_delta", id, text: e.delta.text }];
    }
    return [];
  }
}

/** Claude Code's `system/status: requesting` line: a model request starts. */
function isRequestStart(line: unknown): boolean {
  const ev = asStreamLine(line) as (StreamLine & { status?: unknown }) | null;
  return ev?.type === "system" && ev.subtype === "status" && ev.status === "requesting";
}

/** Raw stream lines kept out of the run log (and so the Raw Log): the partial-message deltas; the full text follows in "assistant". */
export function isNoisyStreamLine(line: unknown): boolean {
  const ev = asStreamLine(line);
  return ev?.type === "stream_event" || (ev?.type === "system" && ev.subtype === "thinking_tokens");
}

/**
 * The run log's copy of a stream-json line: base64 data (the screenshots in
 * tool results, each hundreds of KB and already saved beside the log as a
 * file) replaced by its size.
 */
export function withoutBase64Data(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBase64Data);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.type === "base64" && typeof obj.data === "string") {
    return { ...obj, data: `[${Math.ceil((obj.data.length * 3) / 4 / 1024)} KB of base64 data not logged]` };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = withoutBase64Data(v);
  return out;
}

/** What a Claude Code session is started with (BrainContext's part of it). */
export interface WarmSpec {
  systemPrompt: string;
  mcpConfigPath: string;
  allowedTools: string[];
  /** The attachments folder: Claude Code runs there, with its Read tool (see READ_ATTACHMENTS_ARGS). */
  readDir?: string;
  model?: string;
  /** The Reasoning setting's thinking; absent: DEFAULT_REASONING's. */
  thinking?: boolean;
}

/** A Claude Code process started ahead of its session (ClaudeCodeBrain.warm), waiting for its first message. */
export class WarmClaude {
  private readonly startedAt = Date.now();
  private exited = false;
  private taken = false;
  /** Settles when the process has exited. */
  readonly closed: Promise<void>;

  constructor(
    readonly args: readonly string[],
    private readonly child: ChildProcess,
  ) {
    this.closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("exit", () => {
        this.exited = true;
        resolve();
      });
      child.once("error", () => {
        this.exited = true;
        resolve();
      });
    });
    child.stdin?.on("error", () => {});
  }

  get ageMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Alive and not taken yet. */
  get ready(): boolean {
    return !this.exited && !this.taken;
  }

  /** The process, for a session started with exactly these args; null otherwise. */
  take(args: readonly string[]): ChildProcess | null {
    if (!this.ready || args.length !== this.args.length || args.some((a, i) => a !== this.args[i])) return null;
    this.taken = true;
    return this.child;
  }

  /** Ends the process unless a session took it. */
  stop(): void {
    if (this.taken) return;
    this.taken = true;
    killTree(this.child);
  }
}

export class ClaudeCodeBrain implements Brain {
  constructor(
    private readonly opts: {
      claudePath: string;
      model: string;
      /**
       * Forces extended thinking on or off for every run (NOA_THINKING). Unset: each session
       * starts as its first turn's Reasoning setting says (BrainContext.reasoning) and follows its changes.
       */
      thinking?: boolean;
      /** Extra leading args, for tests that run a fake claude script with node. */
      prefixArgs?: string[];
      /**
       * Keep stdin open after a turn (follow-up messages continue the same
       * session); the runner closes the input to end it. Otherwise stdin is
       * closed once every message has its result, so claude exits.
       */
      persistent?: boolean;
    },
  ) {}

  get persistent(): boolean {
    return this.opts.persistent === true;
  }

  /** The model and thinking a session starts with, and Claude Code's args for them (its system prompt file written). */
  private plan(spec: WarmSpec): { args: string[]; model: string; thinking: boolean } {
    // The extension's model setting wins over NOA_MODEL / DEFAULT_CLAUDE_MODEL.
    const model = spec.model?.trim() || this.opts.model;
    const thinking = this.opts.thinking ?? spec.thinking ?? DEFAULT_REASONING === "thorough";
    const promptFile = systemPromptFile(spec.mcpConfigPath, spec.systemPrompt);
    if (!existsSync(promptFile)) writeFileSync(promptFile, spec.systemPrompt, "utf8");
    const args = buildClaudeArgs({
      systemPrompt: spec.systemPrompt,
      mcpConfigPath: spec.mcpConfigPath,
      allowedTools: spec.allowedTools,
      ...(spec.readDir ? { read: true } : {}),
      model,
      ...(thinking ? {} : { thinking: false }),
    });
    return { args, model, thinking };
  }

  private spawnClaude(args: string[], spec: Pick<WarmSpec, "mcpConfigPath" | "readDir">): ChildProcess {
    return spawn(this.opts.claudePath, [...(this.opts.prefixArgs ?? []), ...args], {
      cwd: spec.readDir ?? dirname(spec.mcpConfigPath),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: claudeEnv(),
    });
  }

  /**
   * Starts Claude Code ahead of a session's first message (TaskRunner.prewarm): a session started
   * with the same args then skips starting the process and its MCP server (measured with Claude
   * Code 2.1.283: 660-745 ms from the first message to the model request, 56-70 ms when started
   * ahead). It uses no tokens while it waits: Claude Code calls the model only for a message.
   */
  warm(spec: WarmSpec): WarmClaude {
    const { args } = this.plan(spec);
    return new WarmClaude(args, this.spawnClaude(args, spec));
  }

  run(ctx: BrainContext): Promise<void> {
    const { args, model: requested, thinking } = this.plan({ ...ctx, ...(ctx.reasoning ? { thinking: ctx.reasoning.thinking } : {}) });
    const forced = this.opts.thinking;
    const warmAgeMs = ctx.warm ? Math.round(ctx.warm.ageMs) : 0;
    const warm = ctx.warm && !ctx.signal.aborted ? ctx.warm.take(args) : null;
    ctx.warm?.stop();
    ctx.log({
      type: "claude_start",
      claudePath: this.opts.claudePath,
      model: requested,
      thinking,
      allowedTools: ctx.allowedTools,
      ...(ctx.warm ? { prewarmed: warm ? { ageMs: warmAgeMs } : "not used: started with other settings" } : {}),
    });
    return new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) return resolve();
      let child: ChildProcess;
      try {
        child = warm ?? this.spawnClaude(args, ctx);
      } catch (e) {
        return reject(e);
      }
      const mapper = new ClaudeStreamMapper();
      // Live text goes out in ~50 ms batches; every other event first sends what is pending.
      const out = new DeltaBatcher(ctx.emit);
      const timer = new ClaudeStreamTimer((trace) => out.emit({ type: "trace", trace: { ...trace, src: "helper" } }));
      timer.spawned(warm ? { prewarmedMs: warmAgeMs } : undefined);
      const stdin = child.stdin!;
      stdin.on("error", (e) => ctx.log({ type: "claude_stdin_error", message: e.message }));

      // A result with every stdin message read and nothing else waiting means
      // Claude has stopped: idle (persistent), or close stdin so it exits.
      const turn = new ClaudeTurnState();
      let started = false;
      let interrupts = 0;
      /** An interrupt was sent: its error result is expected, not a failure. */
      let interrupted = false;
      const writable = () => !stdin.destroyed && !stdin.writableEnded;
      const send = (text: string) => {
        if (!writable()) return;
        turn.wrote();
        stdin.write(userMessageLine(text));
        timer.sent();
      };
      /** Hands the user's waiting messages to Claude as a message of their own. */
      const sendInterjections = (route: "next_step" | "next_message"): boolean => {
        if (!writable()) return false;
        const text = ctx.interjections.handOff(route);
        if (text === null) return false;
        ctx.log({ type: "claude_user_message", kind: route, chars: text.length });
        send(text);
        return true;
      };
      /** Stops the model's request (only text or thinking so far) so the message written for it is read now. */
      const interrupt = () => {
        if (interrupted || !turn.interruptible || !writable()) return;
        interrupted = true;
        ctx.interjections.reroute("interrupt");
        ctx.log({ type: "claude_interrupt" });
        timer.interrupted("user message");
        stdin.write(interruptLine(`interrupt-${++interrupts}`));
      };
      /**
       * The turn already has its task_* result, yet Claude Code starts one more request after that tool's result:
       * its text would reach nobody (measured: 17 to 323 output tokens, 1 to 4 s each). It is stopped at its start;
       * the session stays open for the next message, and the stop's result still gives the turn's summary.
       */
      let afterResult = false;
      const stopAfterResult = () => {
        if (interrupted || !turn.interruptible || turn.pendingInput || !writable()) return;
        interrupted = true;
        afterResult = true;
        ctx.log({ type: "claude_interrupt", reason: "turn over" });
        timer.interrupted("turn over");
        stdin.write(interruptLine(`interrupt-${++interrupts}`));
      };
      /** A raise's note, waiting for the model's request to be stoppable (a raise takes effect in a new turn). */
      let raising: string | null = null;
      let thinkingRequests = 0;
      const setThinking = (tokens: number | null) => {
        if (!writable()) return;
        ctx.log({ type: "claude_thinking", maxThinkingTokens: tokens });
        stdin.write(thinkingLine(`thinking-${++thinkingRequests}`, tokens));
      };
      /** Stops the running request and sends the note as a new turn, which runs with thinking on. */
      const raiseNow = () => {
        if (raising === null || interrupted || !turn.interruptible || !writable()) return;
        const note = raising;
        raising = null;
        interrupted = true;
        ctx.log({ type: "claude_interrupt", reason: "reasoning raised" });
        timer.interrupted("reasoning raised");
        stdin.write(interruptLine(`interrupt-${++interrupts}`));
        ctx.log({ type: "claude_user_message", kind: "reasoning", chars: note.length });
        send(note);
      };
      // Only a session started without thinking can switch it (see thinkingLine); a forced setting never changes.
      if (forced === undefined && !thinking) {
        ctx.reasoning?.onChange((change) => {
          if (change.kind === "raise") {
            setThinking(THINKING_BUDGET_TOKENS);
            raising = raiseNote(change.why);
            raiseNow();
          } else {
            // Back to fast (a step worked) or a new turn's level: from the next turn on.
            raising = null;
            setThinking(change.thinking ? THINKING_BUDGET_TOKENS : null);
          }
        });
      } else if (forced === undefined) {
        ctx.reasoning?.onChange((change) => {
          if (!change.thinking) ctx.log({ type: "claude_thinking_kept", why: `${change.why}: this session started with thinking on, which stays on` });
        });
      }
      /** Model switches waiting for Claude Code's answer, by request id. */
      const switching = new Map<string, string>();
      let model = requested;
      ctx.onModelChange?.((next) => {
        if (!writable()) return;
        const id = `model-${switching.size + 1}-${Date.now()}`;
        switching.set(id, next);
        ctx.log({ type: "claude_model", model: next });
        stdin.write(modelLine(id, next));
      });
      /** Claude Code's answer to a model switch: the chat says which model the session runs now. */
      const modelSwitched = (response: NonNullable<StreamLine["response"]>): AgentEvent | null => {
        const id = typeof response.request_id === "string" ? response.request_id : "";
        const next = switching.get(id);
        if (next === undefined) return null;
        switching.delete(id);
        if (response.subtype === "success") {
          model = next;
          return { type: "status", text: `Switched the model to ${next}` };
        }
        const why = typeof response.error === "string" && response.error.trim() ? plainErrorText(response.error.trim()) : "refused";
        ctx.log({ type: "claude_model_refused", model: next, error: why });
        return { type: "status", text: `The model was not switched to ${next} (${why}): this session keeps ${model}` };
      };
      send(ctx.prompt);
      ctx.input.onMessage((text) => {
        ctx.log({ type: "claude_user_message", kind: "followup", chars: text.length });
        send(text);
      });
      // A message typed mid-turn goes to stdin at once: Claude Code reads it at its next step (with the
      // running tool's result). While the model only thinks or writes, that request is stopped so it reads it now.
      ctx.interjections.onAdd(() => {
        const writing = turn.interruptible;
        if (sendInterjections("next_step") && writing) interrupt();
      });
      ctx.input.onClose(() => {
        if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
      });

      const onAbort = () => {
        ctx.log({ type: "claude_kill", reason: String(ctx.signal.reason ?? "aborted") });
        killTree(child);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const lines = new LineSplitter();
      child.stdout!.on("data", (chunk: Buffer) => {
        for (const line of lines.push(chunk)) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            ctx.log({ type: "claude_stdout", text: line.slice(0, 2000) });
            continue;
          }
          if (!isNoisyStreamLine(event)) ctx.log({ type: "claude", event: withoutBase64Data(event) });
          timer.line(event);
          const read = turn.line(event);
          if (read !== null) ctx.interjections.seen(read);
          if (isRequestStart(event) && ctx.turnOver?.()) stopAfterResult();
          // A request that started without the message written before its step would only read it after its tool.
          if (turn.missedInput && ctx.interjections.unread) interrupt();
          raiseNow();
          // Claude Code repeats its init event for every turn; "started" is said once per session.
          const ev = asStreamLine(event);
          if (ev?.type === "control_response" && ev.response) {
            const said = modelSwitched(ev.response);
            if (said) out.emit(said);
          }
          const isInit = ev?.type === "system" && ev.subtype === "init";
          const isResult = ev?.type === "result";
          // The interrupted request ends with an error result: expected, not a failure to show. A request stopped
          // after the turn's result shows nothing it may have streamed before the stop took effect.
          if (!(isInit && started) && !(isResult && interrupted) && !afterResult)
            for (const e of mapper.map(event)) {
              if (e.type === "assistant_text_delta") out.delta(e.id, e.text);
              else out.emit(e);
            }
          if (isInit) started = true;
          if (isResult) {
            out.flush();
            interrupted = false;
            afterResult = false;
            // The turn ended before its request could be stopped: its next turn thinks anyway (the setting was sent).
            raising = null;
            if (!turn.pendingInput && !ctx.input.closed && !sendInterjections("next_message")) {
              ctx.log({ type: "claude_turns_done" });
              if (this.persistent) ctx.idle?.();
              else ctx.input.close();
            }
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => ctx.log({ type: "claude_stderr", text: chunk.toString("utf8").slice(0, 2000) }));
      child.on("error", (e) => {
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "claude_error", message: e.message });
        reject(e);
      });
      child.on("close", (code, signal) => {
        out.flush();
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "claude_exit", code, signal });
        resolve();
      });
    });
  }
}
