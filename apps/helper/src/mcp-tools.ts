/** Pure helpers for the MCP server entry (importable without starting it). */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { APPROVAL_TIMEOUT_MS, TOOL_NAMES, type ToolName, type ToolResult } from "@noa/shared";

/**
 * Pipe task id of the attached session: the user's own Claude Code running
 * `mcp-server.js --attach` (no task to end). Never a task session id.
 */
export const INTERACTIVE_TASK_ID = "interactive";

/**
 * Long enough for act / switch_x_account, which make several 60 s browser
 * calls, plus one approval the user may take up to APPROVAL_TIMEOUT_MS to
 * give (a second long wait in the same call can still run out).
 */
export const TOOL_CALL_TIMEOUT_MS = 5 * 60_000 + APPROVAL_TIMEOUT_MS;
/** tool.list is answered from memory: a helper that takes longer is not answering. */
export const TOOL_LIST_TIMEOUT_MS = 5000;

export function toolsFromEnv(value: string | undefined): ToolName[] {
  if (!value || !value.trim()) return [...TOOL_NAMES];
  const wanted = new Set(value.split(",").map((s) => s.trim()));
  return TOOL_NAMES.filter((n) => wanted.has(n));
}

export function toMcpResult(r: ToolResult): CallToolResult {
  const content: CallToolResult["content"] = [];
  if (r.text) content.push({ type: "text", text: r.text });
  if (r.image) content.push({ type: "image", data: r.image.base64, mimeType: r.image.mimeType });
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  return r.isError ? { content, isError: true } : { content };
}
