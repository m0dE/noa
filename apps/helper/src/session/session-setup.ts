/**
 * What a new task session needs before its brain starts: the run folder, the
 * MCP config Claude Code loads, and the session's view of the browser.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_SERVER_NAME, type ToolName } from "@noa/shared";
import type { BrowserCaller } from "@noa/core";
import { ENV } from "../env-names.js";

function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "task";
}

/** runs/<session>-<stamp> */
export function runDirFor(runsDir: string, sessionId: string): string {
  return join(runsDir, `${safeId(sessionId)}-${runStamp()}`);
}

/** The --mcp-config for Claude Code: one Noa MCP server (dist/mcp-server.js) bound to this session. */
export function buildMcpConfig(opts: { nodePath: string; mcpServerPath: string; pipePath: string; pipeToken: string; taskId: string; toolNames: ToolName[]; jev?: boolean }) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: opts.nodePath,
        args: [opts.mcpServerPath],
        env: {
          [ENV.pipe]: opts.pipePath,
          [ENV.pipeToken]: opts.pipeToken,
          [ENV.task]: opts.taskId,
          [ENV.tools]: opts.toolNames.join(","),
          // Jev picks act's elements: the tools are described for that mode.
          [ENV.jev]: opts.jev ? "1" : "0",
        },
      },
    },
  };
}

/** Browser call params with the calling session's id (see BrowserCallContext). */
function withSession<P>(params: P, sessionId: string): P {
  return { ...((params ?? {}) as object), sessionId } as P;
}

/**
 * The session's browser: every call names the session (so the extension
 * acts in that session's own tab), and screenshots are also saved into the
 * run folder.
 */
export function sessionBrowser(browser: BrowserCaller, sessionId: string, runDir: string): BrowserCaller {
  let screenshots = 0;
  return {
    call: async (method, params) => {
      const r = await browser.call(method, withSession(params, sessionId));
      if (method === "browser.screenshot") {
        const shot = r as { base64: string; mimeType: string };
        screenshots++;
        const ext = shot.mimeType === "image/png" ? "png" : "jpg";
        try {
          writeFileSync(join(runDir, `screenshot-${String(screenshots).padStart(3, "0")}.${ext}`), Buffer.from(shot.base64, "base64"));
        } catch {
          /* best effort */
        }
      }
      return r;
    },
  };
}
