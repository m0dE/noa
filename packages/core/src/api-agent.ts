/**
 * Claude API brain: the agent loop over the Anthropic Messages API, with the
 * shared tool executor. act replaces click and type, so a turn can do several
 * steps.
 *
 * A session is a conversation: after a turn ends (task_* call, failure or
 * abort) its message history stays in memory, and continueWith(text) runs
 * the next turn on top of it, like a chat.
 */
import { ANTHROPIC_MESSAGES_URL, ATTACHMENT_LIMITS, delay, DeltaBatcher, errorMessage, stopwatch, toolsFor, traceText, type AgentEvent, type RunConfig, type Sleep, type TaskRunResult, type ToolName, type TraceDraft } from "@noa/shared";
import type { AgentSession, ApiAgentOptions } from "./types.js";
import { attachmentBlocks, withAttachmentLines, type ApiAttachment } from "./attachments.js";
import { createToolExecutor } from "./executor.js";
import { agentError, CLAUDE_DECLINED, ENDED_WITHOUT_RESULT } from "./failures.js";
import { Interjections } from "./interjections.js";
import { buildSystemPrompt, buildTaskPrompt, FOLLOW_UP_PREFIX } from "./prompts.js";
import { raiseNote, ReasoningGovernor, reasoningParams, reasoningTrace } from "./reasoning.js";
import { isTaskEndTool, timeLimitReached, toolBudget, toolCallLimitExceeded, toolCallLimitReached, turnEndEvents } from "./turn-rules.js";
import {
  buildRequest,
  postMessages,
  type MessagesTransport,
  toolResultBlock,
  type ContentBlock,
  type MessageParam,
  type MessagesResponse,
  type PostResult,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./anthropic.js";

export const RETRY_DELAYS_MS = [1000, 3000, 9000];
/** Each backoff delay varies by up to this fraction either way, so clients that failed together do not retry together. */
export const RETRY_JITTER = 0.2;
/** Longest wait a server's retry-after may ask for; a longer one is cut to this (the turn has a time limit). */
export const MAX_RETRY_AFTER_MS = 60_000;

/** How long to wait before retry `attempt` (0-based): the server's retry-after when it gave one, else the jittered backoff. */
export function retryWaitMs(attempt: number, delays: number[], retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const base = delays[attempt]!;
  return Math.round(base * (1 + RETRY_JITTER * (2 * random() - 1)));
}
/**
 * Screenshots in the conversation: when there are more than MAX_IMAGES_IN_HISTORY, all but the newest
 * IMAGES_KEPT_ON_PRUNE are replaced by a note. Pruning in batches rather than one image per step matters for
 * prompt caching: replacing an old screenshot changes the history from that point on, so every later block is
 * written to the cache again (1.25x the input price) instead of read (0.05-0.1x). One prune every ~9 screenshots
 * costs far less than re-writing the last few turns on every one, and the extra images are cheap cache reads.
 */
export const MAX_IMAGES_IN_HISTORY = 12;
export const IMAGES_KEPT_ON_PRUNE = 3;
/**
 * Bytes of attached images and PDFs kept in the conversation (one message's worth): every request resends the
 * history, and the hosted AI takes at most 20 MB. Older attachments are replaced by a note.
 */
export const MAX_ATTACHMENT_BYTES_IN_HISTORY = ATTACHMENT_LIMITS.maxMessageBytes;
/** What an attached image or PDF dropped from the history (MAX_ATTACHMENT_BYTES_IN_HISTORY) is replaced with. */
export const ATTACHMENT_DROPPED = "[an earlier attachment was removed from the conversation to keep requests small; ask the user to attach it again if you need to see it]";
export const KEY_REJECTED = "Claude API key rejected";
/** Result text for tool calls a stopped turn never ran, so the history stays valid for the next turn. */
export const NOT_RUN = "Not run: the turn was stopped before this tool ran.";

/**
 * One Messages request as the trace sees it: when the response started
 * (headers), the stream's first and last text delta and how many there were,
 * and at the end its span (outcome, stop reason, tokens). The deltas still go
 * to the chat (`onDelta`); only counts are kept.
 */
function startModelCall(streaming: boolean, doFetch: typeof fetch, onDelta: (id: string, text: string) => void) {
  const t = Date.now();
  const took = stopwatch();
  let headersMs: number | undefined;
  let firstTextMs: number | undefined;
  let lastTextMs: number | undefined;
  let deltas = 0;
  let toolStarted = false;
  return {
    /** The reply has started a tool call (streamed replies only). */
    get toolStarted() {
      return toolStarted;
    },
    fetch: (async (input, init) => {
      const res = await doFetch(input, init);
      headersMs = took();
      return res;
    }) as typeof fetch,
    stream: streaming
      ? {
          onText: (messageId: string, index: number, text: string) => {
            lastTextMs = took();
            firstTextMs ??= lastTextMs;
            deltas++;
            onDelta(`${messageId}:${index}`, text);
          },
          onToolStart: () => {
            toolStarted = true;
          },
        }
      : undefined,
    /** interrupted: stopped for a message from the user (see request()). */
    span(r: PostResult, extra: { model: string; attempt: number; messages: number; reasoning: string }, interrupted = false): TraceDraft {
      const data: NonNullable<TraceDraft["data"]> = { ...extra, result: interrupted ? "interrupted" : r.kind, streamed: streaming };
      if (headersMs !== undefined) data.responseMs = headersMs;
      if (firstTextMs !== undefined) data.firstTextMs = firstTextMs;
      if (lastTextMs !== undefined) data.lastTextMs = lastTextMs;
      if (deltas) data.deltas = deltas;
      if (r.kind === "ok") {
        const m = r.message;
        if (m.stop_reason) data.stop = m.stop_reason;
        const content = Array.isArray(m.content) ? m.content : [];
        data.toolUses = content.filter((b) => b.type === "tool_use").length;
        Object.assign(data, usageOf(m.usage));
      } else data.reason = traceText(r.reason);
      return { t, ms: took(), cat: "model", name: "model.call", data };
    },
  };
}

/** Token counts of a Messages usage object (missing ones left out). */
export function usageOf(usage: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const pick = (from: string, to: string) => {
    const v = usage?.[from];
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v;
  };
  pick("input_tokens", "inTokens");
  pick("output_tokens", "outTokens");
  pick("cache_read_input_tokens", "cacheReadTokens");
  pick("cache_creation_input_tokens", "cacheWriteTokens");
  return out;
}

export interface ApiAgentInternals {
  /** Delays between retries of one request. Default 1 s, 3 s, 9 s. */
  retryDelaysMs?: number[];
  /** Used for retry backoff and by the tool executor. */
  sleep?: Sleep;
  /** Backoff jitter source, 0..1. Default Math.random. */
  random?: () => number;
}

export function startApiAgent(opts: ApiAgentOptions): AgentSession {
  return startApiAgentWith(opts, {});
}

export function startApiAgentWith(opts: ApiAgentOptions, internals: ApiAgentInternals): AgentSession {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = internals.sleep ?? delay;
  const delays = internals.retryDelaysMs ?? RETRY_DELAYS_MS;
  const random = internals.random ?? Math.random;
  const jevOn = opts.jev !== null;
  const label = opts.label ?? "Claude API";
  const transport: MessagesTransport = {
    url: opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, "")}/messages` : ANTHROPIC_MESSAGES_URL,
    auth: opts.auth ?? "x-api-key",
    label,
  };
  if (opts.headers) transport.headers = opts.headers;

  // Stream text as it is written: on by default for the Anthropic API; the hosted AI (bearer) answers whole messages.
  const streaming = opts.stream ?? transport.auth !== "bearer";
  // Live text goes out in ~50 ms batches; every other event first sends what is pending.
  const batcher = new DeltaBatcher((e) => {
    try {
      opts.onEvent(e);
    } catch {
      /* listeners must not break the loop */
    }
  });
  const emit = (e: AgentEvent) => {
    reasoning.observe(e);
    batcher.emit(e);
  };
  const trace = (e: TraceDraft) => {
    try {
      opts.onTrace?.(e);
    } catch {
      /* listeners must not break the loop */
    }
  };
  /** The note that goes after the next tool results when a stuck Fast run's reasoning was raised. */
  let raiseNotePending: string | null = null;
  /** How much the model thinks: the Reasoning setting, raised while a Fast run is stuck (reasoning.ts). */
  const reasoning = new ReasoningGovernor(opts.config, (change) => {
    trace(reasoningTrace(change));
    raiseNotePending = change.kind === "raise" ? raiseNote(change.why) : null;
  });
  const reasoningNow = () => (reasoning.raised ? "raised" : reasoning.thinking ? "thorough" : "fast");

  /** The running turn's task_* result sink (the executor is shared by every turn). */
  let onTaskEnd: (r: TaskRunResult) => void = () => {};
  /** When the running turn's time limit ends it (wait_for stops before). */
  let turnEndsAt: number | undefined;
  /** Messages the user types while a turn runs: with the next tool result or request, and the turn cannot end before. */
  const interjections = new Interjections((route, waitedMs, count) =>
    trace({ t: Date.now() - Math.round(waitedMs), ms: waitedMs, cat: "user", name: "interjection", data: { route, count } }),
  );
  const executor = createToolExecutor({
    interjections,
    browser: opts.browser,
    jev: opts.jev,
    jevThreshold: opts.config.jevThreshold,
    onEvent: emit,
    onTaskEnd: (r) => onTaskEnd(r),
    turnEndsAt: () => turnEndsAt,
    mediaPaths: [...opts.mediaPaths, ...uploadPaths(opts.attachments)],
    account: opts.task.account ?? null,
    sleep,
    ...(opts.onTrace ? { onTrace: trace } : {}),
    ...(opts.todo ? { todo: opts.todo } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
  });

  const tools = toolsFor({ images: opts.config.imageGeneration !== false });
  const system = buildSystemPrompt({ tools, jev: jevOn });
  /** The whole conversation, across turns. */
  const messages: MessageParam[] = [];
  /** Results of the last assistant message's tool calls when its turn ended before they were sent. */
  let unsent: ContentBlock[] = [];
  let turnRunning = false;

  /** Past MAX_IMAGES_IN_HISTORY images in tool results, keep only the newest IMAGES_KEPT_ON_PRUNE. */
  const pruneImages = () => {
    let total = 0;
    for (const m of messages) for (const block of m.content) if (block.type === "tool_result") total += (block as ToolResultBlock).content.filter((c) => c.type === "image").length;
    if (total <= MAX_IMAGES_IN_HISTORY) return;
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const block of messages[i]!.content) {
        if (block.type !== "tool_result") continue;
        const tr = block as ToolResultBlock;
        tr.content = tr.content.map((c) => {
          if (c.type !== "image") return c;
          seen++;
          return seen > IMAGES_KEPT_ON_PRUNE ? { type: "text" as const, text: "[older screenshot removed]" } : c;
        });
      }
    }
  };

  /**
   * Keep the newest attachments (top-level image and document blocks, not screenshots in tool results) up to
   * MAX_ATTACHMENT_BYTES_IN_HISTORY; older ones become a note.
   */
  const pruneAttachments = () => {
    let kept = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "user") continue;
      m.content = m.content.map((block) => {
        const data = attachedData(block);
        if (data === null) return block;
        kept += Math.floor((data.length * 3) / 4);
        return kept > MAX_ATTACHMENT_BYTES_IN_HISTORY ? { type: "text" as const, text: ATTACHMENT_DROPPED } : block;
      });
    }
  };

  /**
   * Adds the next user text (after `before`: a message's attachment blocks). The history must alternate and
   * answer every tool_use: after a turn that ended on a tool call, its results (or NOT_RUN for the ones a stop
   * skipped) go first in the same user message.
   */
  const addUserText = (text: string, before: ContentBlock[] = []) => {
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      const uses = last.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const answered = new Map(unsent.map((b) => [(b as ToolResultBlock).tool_use_id, b]));
      const results = uses.map((u) => answered.get(u.id) ?? toolResultBlock(u.id, { text: NOT_RUN, isError: true }));
      messages.push({ role: "user", content: [...results, ...before, { type: "text", text }] });
    } else if (last?.role === "user") {
      last.content.push(...before, { type: "text", text });
    } else {
      messages.push({ role: "user", content: [...before, { type: "text", text }] });
    }
    unsent = [];
  };

  const runTurn = (config: RunConfig): AgentSession => {
    turnRunning = true;
    reasoning.startTurn(config);
    raiseNotePending = null;
    const controller = new AbortController();
    let ended = false;
    let resolveDone!: (r: TaskRunResult) => void;
    const done = new Promise<TaskRunResult>((r) => (resolveDone = r));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let taskResult: TaskRunResult | null = null;
    onTaskEnd = (r) => {
      if (!taskResult) taskResult = r;
    };

    const finish = (r: TaskRunResult) => {
      if (ended) return;
      ended = true;
      turnRunning = false;
      if (timer) clearTimeout(timer);
      controller.abort();
      // Messages typed while the turn was ending still reach Claude with the next turn.
      const said = interjections.take("next_message");
      if (said) addUserText(said);
      // Who picked this turn's elements (Jev, or Claude after Jev was unsure), then task_end.
      for (const e of turnEndEvents(r, jevOn ? executor.takePicks() : null)) emit(e);
      resolveDone(r);
    };

    const takeUserText = (route: "request" | "interrupt" | "next_message"): TextBlock[] => {
      const said = interjections.take(route);
      return said ? [{ type: "text", text: said }] : [];
    };

    /**
     * One request with retries. null means the turn already ended. "interrupted": a message from the user came
     * while the model was only writing (thinking or text, no tool call started), so the request was stopped and
     * its reply dropped: the next request carries the message at once, as Claude Code's interrupt does. A reply
     * that is not streamed (the hosted AI) never shows where it is, so it is let finish.
     */
    const request = async (): Promise<MessagesResponse | "interrupted" | null> => {
      const thinking = reasoningNow();
      const body = buildRequest({ model: opts.model, system, tools, messages, jev: jevOn, reasoning: reasoningParams(opts.model, thinking) });
      for (let attempt = 0; ; attempt++) {
        const call = startModelCall(streaming, doFetch, (id, text) => batcher.delta(id, text));
        const thisRequest = new AbortController();
        const endRequest = () => thisRequest.abort();
        controller.signal.addEventListener("abort", endRequest, { once: true });
        let interrupted = false;
        const stopListening = streaming
          ? interjections.onAdd(() => {
              if (call.toolStarted || interrupted) return;
              interrupted = true;
              thisRequest.abort();
            })
          : () => {};
        let r: PostResult;
        try {
          r = await postMessages(call.fetch, opts.apiKey, body, thisRequest.signal, transport, call.stream);
        } finally {
          stopListening();
          controller.signal.removeEventListener("abort", endRequest);
        }
        batcher.flush();
        trace(call.span(r, { model: opts.model, attempt: attempt + 1, messages: messages.length, reasoning: thinking }, interrupted));
        if (ended) return null;
        if (interrupted) return "interrupted";
        if (r.kind === "ok") return r.message;
        if (r.kind === "credit") {
          emit({ type: "error", text: r.reason });
          try {
            opts.onOutOfCredit?.({ message: r.reason, ...(r.topupUrl ? { topupUrl: r.topupUrl } : {}), ...(r.shortfall ? { shortfall: r.shortfall } : {}) });
          } catch {
            /* the listener must not break the loop */
          }
          finish({ outcome: "paused", reason: r.pauseReason });
          return null;
        }
        if (r.kind === "auth") {
          emit({ type: "error", text: r.reason });
          finish({ outcome: "failed", reason: transport.auth === "bearer" ? r.reason : KEY_REJECTED });
          return null;
        }
        if (r.kind === "error") {
          emit({ type: "error", text: r.reason });
          finish({ outcome: "failed", reason: r.reason });
          return null;
        }
        if (attempt >= delays.length) {
          emit({ type: "error", text: r.reason });
          finish({ outcome: "retry", reason: `${r.reason}; gave up after ${attempt + 1} attempts` });
          return null;
        }
        const wait = retryWaitMs(attempt, delays, r.retryAfterMs, random);
        emit({ type: "status", text: `${r.reason}; retrying in ${Math.max(1, Math.round(wait / 1000))} s` });
        const t = Date.now();
        const waited = stopwatch();
        await sleep(wait);
        trace({ t, ms: waited(), cat: "model", name: "model.wait", data: { attempt: attempt + 1, planMs: wait, serverAsked: r.retryAfterMs !== undefined } });
        if (ended) return null;
      }
    };

    const loop = async () => {
      const max = config.maxToolCalls;
      let toolCalls = 0;
      /** How the next request gets the user's waiting messages. */
      let route: "request" | "interrupt" = "request";
      while (!ended) {
        const pending = takeUserText(route);
        route = "request";
        if (pending.length) messages[messages.length - 1]!.content.push(...pending);
        // Raised: the note goes after the tool results, so the model reads why and thinks (the history stays append-only).
        if (raiseNotePending && messages.at(-1)?.role === "user") {
          messages.at(-1)!.content.push({ type: "text", text: raiseNotePending });
          raiseNotePending = null;
        }
        pruneImages();
        pruneAttachments();
        const msg = await request();
        if (msg === "interrupted") {
          route = "interrupt";
          continue;
        }
        if (!msg || ended) return;
        const content = Array.isArray(msg.content) ? msg.content : [];
        // The API rejects a history with an empty assistant message, which would break every later turn.
        if (content.length) messages.push({ role: "assistant", content });
        content.forEach((b, i) => {
          if (b.type === "text" && typeof (b as TextBlock).text === "string" && (b as TextBlock).text.trim()) {
            // The id of the streamed block this text completes (the chat swaps its live text for it).
            emit(streaming && msg.id ? { type: "assistant_text", text: (b as TextBlock).text, id: `${msg.id}:${i}` } : { type: "assistant_text", text: (b as TextBlock).text });
          }
        });
        const uses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (uses.length === 0) {
          if (interjections.unseen) {
            // The user said something while Claude was finishing; let Claude answer it.
            // (After an empty answer the last message is still the user's: the next round adds the text to it.)
            if (content.length) messages.push({ role: "user", content: takeUserText("next_message") });
            continue;
          }
          const why = msg.stop_reason === "refusal" ? CLAUDE_DECLINED : ENDED_WITHOUT_RESULT;
          finish({ outcome: "failed", reason: why });
          return;
        }

        const results: ContentBlock[] = [];
        // Shared so a turn that ends mid-way still answers what already ran.
        unsent = results;
        for (const use of uses) {
          if (ended) return;
          const name = use.name as ToolName;
          if (taskResult) {
            results.push(toolResultBlock(use.id, { text: "The task already ended. Stop now.", isError: true }));
            continue;
          }
          if (!tools.includes(name)) {
            const hint = name === "click" || name === "type" ? " Use act; a step can name the element index to run directly." : "";
            results.push(toolResultBlock(use.id, { text: `Tool ${use.name} is not available.${hint}`, isError: true }));
            continue;
          }
          const budget = isTaskEndTool(name) ? "run" : toolBudget(++toolCalls, max);
          if (budget === "stop") {
            finish({ outcome: "failed", reason: toolCallLimitExceeded(max) });
            return;
          }
          if (budget === "refuse") {
            results.push(toolResultBlock(use.id, { text: toolCallLimitReached(max), isError: true }));
            continue;
          }
          // A Fast run's first task_fail: one careful look first, with its reasoning raised (never after the tool limit).
          const recheck = name === "task_fail" && toolCalls < max ? reasoning.beforeTaskFail() : null;
          if (recheck) {
            results.push(toolResultBlock(use.id, { text: recheck, isError: true }));
            continue;
          }
          const r = await executor.call(name, use.input);
          // Recorded even when the turn was stopped meanwhile: it did run.
          results.push(toolResultBlock(use.id, r));
          if (ended) return;
        }
        if (taskResult) {
          finish(taskResult);
          return;
        }
        unsent = [];
        messages.push({ role: "user", content: results });
      }
    };

    turnEndsAt = Date.now() + Math.max(0, config.maxTaskMinutes * 60_000);
    timer = setTimeout(
      () => finish({ outcome: "failed", reason: timeLimitReached(config.maxTaskMinutes) }),
      Math.max(0, config.maxTaskMinutes * 60_000),
    );
    loop().catch((e) => {
      emit({ type: "error", text: `Agent loop error: ${errorMessage(e)}` });
      finish({ outcome: "failed", reason: agentError(errorMessage(e)) });
    });

    return {
      sessionId: opts.sessionId,
      done,
      sendUserMessage(text: string) {
        if (ended || !text.trim()) return;
        interjections.add(text);
        emit({ type: "user_message", text });
      },
      abort(reason: string, outcome: "paused" | "failed" | "retry" = "failed") {
        finish({ outcome, reason });
      },
      continueWith,
    };
  };

  /** The next user message once the current turn has ended: a new turn with the whole history. */
  function continueWith(text: string, next: { config?: RunConfig; attachments?: ApiAttachment[] } = {}): AgentSession {
    if (turnRunning) throw new Error("busy");
    if (!text.trim()) throw new Error("empty message");
    emit({ type: "user_message", text });
    const attachments = next.attachments ?? [];
    executor.allowMedia(uploadPaths(attachments));
    addUserText(withAttachmentLines(`${FOLLOW_UP_PREFIX}${text}`, attachments, "blocks"), attachmentBlocks(attachments));
    return runTurn(next.config ?? opts.config);
  }

  const attachments = opts.attachments ?? [];
  const taskPrompt = buildTaskPrompt(opts.task, opts.mediaPaths, { isRetry: opts.config.isRetry, attachments, view: "blocks" });
  messages.push({ role: "user", content: [...attachmentBlocks(attachments), { type: "text", text: taskPrompt }] });
  emit({ type: "status", text: `${label} (${opts.model})${jevOn ? " with Jev" : ""}` });
  return runTurn(opts.config);
}

/** The paths upload may attach among these attachments. */
function uploadPaths(attachments: readonly ApiAttachment[] | undefined): string[] {
  return (attachments ?? []).flatMap((a) => (a.path ? [a.path] : []));
}

/** The base64 data of an attached image or PDF block at the top of a user message (null: any other block). */
function attachedData(block: ContentBlock): string | null {
  if (block.type !== "image" && block.type !== "document") return null;
  const source = (block as { source?: { type?: unknown; data?: unknown } }).source;
  return source?.type === "base64" && typeof source.data === "string" ? source.data : null;
}
