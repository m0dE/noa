/**
 * Native messaging host entry. Chrome starts this process when the extension
 * calls chrome.runtime.connectNative("com.noa.helper").
 *
 * stdout is the native messaging channel (4-byte LE length + UTF-8 JSON).
 * Nothing else may ever be written to it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_TIMEOUT_MS,
  DEFAULT_SETTINGS,
  delay,
  errorMessage,
  RpcPeer,
  toolsFor,
  type AgentEvent,
  type BrowserMethods,
  type MemoryMethods,
  type TodoMethods,
  type HelperMethods,
  type HelperNotifications,
  type RpcMessage,
} from "@noa/shared";
import { createJev, createToolExecutor, type JevLike } from "@noa/core";
import { HELPER_VERSION, loadConfig } from "./config.js";
import { LiveLog, redirectConsole, summarize } from "./logger.js";
import { encodeNativeMessage, FrameTooLargeError, MAX_NATIVE_OUT, NativeDecoder } from "./native-framing.js";
import { pipePathFor, startPipeServer, type PipeServer } from "./pipe-server.js";
import { BROWSER_RPC_TIMEOUT_MS, rpcBrowser, ToolRouter, type InteractiveTools } from "./tool-router.js";
import { INTERACTIVE_TASK_ID } from "./mcp-tools.js";
import { AttachmentInbox } from "./session/attachments.js";
import { TaskRunner } from "./task-runner.js";
import { ClaudeCodeBrain } from "./brains/claude-code.js";
import { apiBillingVarsIn, CLAUDE_NOT_FOUND, resolveClaudePath } from "./claude-process.js";
import { ScriptedBrain } from "./brains/scripted.js";
import type { Brain } from "./brains/brain.js";
import { SelfTestCache } from "./self-test.js";
import { runMemorySummarize } from "./memory-summarize.js";
import { pruneRuns, readRunLog } from "./run-log.js";
import { removeHelperFile, writeHelperFile } from "./helper-file.js";

/** On shutdown, how long the sessions get to stop their Claude Code processes before the helper exits anyway. */
const SHUTDOWN_WAIT_MS = 5000;

async function main(): Promise<void> {
  const config = loadConfig();
  const live = new LiveLog(config.logDir);
  redirectConsole(live);
  const logLine = (line: string) => live.write(`helper ${line}`);
  const scripted = config.brain === "scripted";
  logLine(`start v${HELPER_VERSION} pid=${process.pid} brain=${config.brain} jev=${config.typesafeApiKey ? "on" : "off"}`);
  const stripped = apiBillingVarsIn();
  if (stripped.length) logLine(`not passing ${stripped.join(", ")} to Claude Code: it runs on your Claude Code login, never an API key`);

  const writeFrame = (msg: RpcMessage) => {
    let frame: Buffer;
    try {
      frame = encodeNativeMessage(msg);
    } catch (e) {
      if (!(e instanceof FrameTooLargeError)) throw e;
      logLine(`dropping oversize message ${msg.id ?? msg.method}: ${e.message}`);
      if (msg.id === undefined) return;
      frame = encodeNativeMessage({ id: msg.id, error: { message: `The helper's answer was too large for Chrome (the limit is ${MAX_NATIVE_OUT / (1024 * 1024)} MB).` } });
    }
    process.stdout.write(frame);
  };
  const peer = new RpcPeer<BrowserMethods & TodoMethods & MemoryMethods, HelperMethods>(writeFrame, "h");
  const notify = <K extends keyof HelperNotifications>(method: K, params: HelperNotifications[K]) => peer.notify(method, params);
  const browser = rpcBrowser(peer);

  const makeJev = (key: string): JevLike => createJev(key);
  const envJev = config.typesafeApiKey ? makeJev(config.typesafeApiKey) : null;
  const pipePath = pipePathFor(process.pid);
  // The pipe's name is predictable: only calls carrying this token are answered (the MCP servers this helper starts get it, --attach reads helper.json).
  const pipeToken = randomBytes(32).toString("hex");
  // resolveClaudePath honours NOA_CLAUDE_PATH (from .env or the environment).
  const claudePath = scripted ? null : resolveClaudePath(config.env);

  const makeBrain = (): Brain => {
    if (scripted) return new ScriptedBrain((t, n, a) => router.call(t, n, a));
    if (!claudePath) throw new Error(CLAUDE_NOT_FOUND);
    // Headless stream-json with stdin kept open: structured events, and follow-up turns in the same session.
    return new ClaudeCodeBrain({ claudePath, model: config.model, ...(config.thinking === null ? {} : { thinking: config.thinking }), persistent: true });
  };
  // Attachments wait here for their session's turn; nothing waits across a restart (sessions do not survive it).
  const inbox = new AttachmentInbox(join(config.baseDir, "incoming"));
  inbox.clear();
  const runner = new TaskRunner({
    runsDir: config.runsDir,
    inbox,
    mcpServerPath: config.mcpServerPath,
    pipePath,
    pipeToken,
    browser,
    envJevKey: config.typesafeApiKey,
    makeJev,
    makeBrain,
    notify: (sessionId, event: AgentEvent) => notify("helper.event", { sessionId, event }),
    // The TODO tools: the extension answers them from the TODO list of that session's conversation. Changing a task
    // may wait for the user's OK (the automation level), so the call may take an approval's time too.
    todo: (sessionId, tool, args) => peer.call("todo.call", { sessionId, tool, args }, { timeoutMs: BROWSER_RPC_TIMEOUT_MS + APPROVAL_TIMEOUT_MS }),
    // remember / recall / forget: the extension keeps the memory of that session's conversation.
    memory: (sessionId, tool, args) => peer.call("memory.call", { sessionId, tool, args }, { timeoutMs: BROWSER_RPC_TIMEOUT_MS }),
    onSessionsChanged: (open) => notify("helper.sessions", { open }),
    live,
  });

  // Tools for the user's own Claude Code (`mcp-server.js --attach`): no task to end, no media.
  const interactive: InteractiveTools = {
    allowedTools: new Set(toolsFor({ interactive: true })),
    jev: envJev !== null,
    executor: createToolExecutor({
      browser,
      jev: envJev,
      jevThreshold: DEFAULT_SETTINGS.jevThreshold,
      onEvent: (e) => live.write(`${INTERACTIVE_TASK_ID} ${summarize(e)}`),
      mediaPaths: [],
    }),
  };
  const router = new ToolRouter({ getSession: (taskId) => runner.session(taskId), getInteractive: () => interactive });

  const selfTest = new SelfTestCache({
    brain: config.brain,
    claudePath,
    cacheFile: join(config.baseDir, "selftest.json"),
  });

  let pipe: PipeServer | null = null;
  try {
    pipe = await startPipeServer(
      pipePath,
      pipeToken,
      {
        toolCall: (p) => router.call(p.taskId || INTERACTIVE_TASK_ID, p.name, p.args),
        toolList: (p) => ({ names: router.allowedTools(p.taskId || INTERACTIVE_TASK_ID), jev: router.jev(p.taskId || INTERACTIVE_TASK_ID) }),
      },
      logLine,
    );
    logLine(`pipe listening at ${pipePath}`);
    try {
      writeHelperFile(config.helperFilePath, { pipe: pipePath, token: pipeToken, pid: process.pid, startedAt: new Date().toISOString() });
    } catch (e) {
      logLine(`could not write ${config.helperFilePath}: ${errorMessage(e)}`);
    }
  } catch (e) {
    logLine(`pipe failed to start: ${errorMessage(e)}`);
  }

  // Old run folders go (RUN_RETENTION), in the background: start-up does not wait for it.
  void pruneRuns(config.runsDir)
    .then((r) => r.removed && logLine(`pruned ${r.removed} old run folder(s), ${Math.round(r.freedBytes / 1048576)} MB freed; ${Math.round(r.keptBytes / 1048576)} MB kept`))
    .catch((e: unknown) => logLine(`could not prune ${config.runsDir}: ${errorMessage(e)}`));

  peer.handle("helper.hello", async ({ selfTest: rerun }) => {
    const st = await selfTest.get(rerun === true);
    return {
      version: HELPER_VERSION,
      jevAvailable: envJev !== null,
      brain: config.brain,
      claudePath,
      logDir: config.logDir,
      openSessions: runner.openSessions,
      selfTest: st,
    };
  });
  peer.handle("helper.runTask", async (params) => {
    if (!pipe) throw new Error("Helper pipe server is not running");
    logLine(`runTask ${params.sessionId} task=${params.task.id} media=${params.mediaPaths.length} attachments=${params.attachments?.length ?? 0}`);
    const result = await runner.run(params);
    logLine(`runTask ${params.sessionId} -> ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  });
  peer.handle("helper.putAttachment", (params) => inbox.put(params));
  peer.handle("helper.continueSession", async (params) => {
    logLine(`continueSession ${params.sessionId} chars=${params.text.length}`);
    const result = await runner.continueSession(params);
    logLine(`continueSession ${params.sessionId} -> ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  });
  peer.handle("helper.prewarm", ({ config }) => {
    try {
      return { ok: runner.prewarm(config) };
    } catch (e) {
      logLine(`prewarm failed: ${errorMessage(e)}`);
      return { ok: false };
    }
  });
  peer.handle("helper.endSession", ({ sessionId }) => ({ ok: runner.endSession(sessionId) }));
  peer.handle("helper.sendUserMessage", ({ sessionId, text }) => ({ ok: runner.sendUserMessage(sessionId, text) }));
  peer.handle("helper.forcePause", ({ sessionId, reason }) => {
    runner.forcePause(sessionId, reason);
    return { ok: true as const };
  });
  peer.handle("helper.abortTask", ({ sessionId, reason }) => {
    runner.abort(sessionId, reason);
    return { ok: true as const };
  });
  peer.handle("helper.getLog", ({ lines }) => ({ text: live.tail(lines) }));
  peer.handle("helper.runLog", ({ path, maxBytes }) => readRunLog(config.runsDir, path, maxBytes));
  // The background memory writer on Claude Code: run in the helper's runs folder, so no project's files are read.
  peer.handle("memory.summarize", async ({ system, prompt }) => {
    if (!claudePath) throw new Error(scripted ? "The scripted brain has no memory writer" : CLAUDE_NOT_FOUND);
    mkdirSync(config.runsDir, { recursive: true });
    const r = await runMemorySummarize({ claudePath, system, prompt, cwd: config.runsDir });
    logLine(`memory.summarize chars=${prompt.length}${r.costUsd === undefined ? "" : ` cost=$${r.costUsd.toFixed(4)}`}`);
    return r;
  });

  const decoder = new NativeDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    let msgs: unknown[];
    try {
      msgs = decoder.push(chunk);
    } catch (e) {
      logLine(`bad native frame: ${errorMessage(e)}`);
      return;
    }
    for (const m of msgs) void peer.receive(m as RpcMessage);
  });

  let exiting = false;
  const shutdown = async (why: string) => {
    if (exiting) return;
    exiting = true;
    logLine(`shutting down: ${why}`);
    peer.close("helper shutting down");
    runner.shutdown(why);
    removeHelperFile(config.helperFilePath, process.pid);
    // Give the brains a moment to kill their process trees.
    await Promise.race([runner.whenAllClosed(), delay(SHUTDOWN_WAIT_MS)]);
    await pipe?.close().catch(() => {});
    process.exit(0);
  };
  process.stdout.on("error", (e) => void shutdown(`stdout error: ${e.message}`));
  process.stdin.on("end", () => void shutdown("stdin closed (Chrome disconnected)"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("exit", () => removeHelperFile(config.helperFilePath, process.pid));
  process.on("uncaughtException", (e) => logLine(`uncaught: ${e.stack ?? e.message}`));
  process.on("unhandledRejection", (e) => logLine(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
}

main().catch((e) => {
  try {
    process.stderr.write(`Noa host failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  } finally {
    process.exit(1);
  }
});
