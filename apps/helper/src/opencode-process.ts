/**
 * OpenCode (https://opencode.ai, MIT), the open-source agent the Local model brain runs on: finding it, and the
 * config and environment of a session's runs. `npx noa-local-llm` (packages/local-llm) installs the version it was
 * tested with into Noa's folder; an OpenCode of the user's own is used when that one is not there.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localMessagesBase } from "@noa/shared";
import { ENV } from "./env-names.js";

export const OPENCODE_NOT_FOUND = "OpenCode was not found: run npx -y noa-local-llm to set up the Local model.";

/** Where `npx noa-local-llm` installs OpenCode: `npm install --prefix <Noa's folder>/opencode opencode-ai`. */
export function noaFolderOpencode(baseDir: string): string {
  // The package's bin is opencode.exe on every system: its postinstall puts the system's own binary there.
  return join(baseDir, "opencode", "node_modules", "opencode-ai", "bin", "opencode.exe");
}

/** NOA_OPENCODE_PATH, else the one in Noa's folder, else `opencode` on the PATH, else ~/.opencode/bin (OpenCode's own installer). */
export function resolveOpencodePath(
  env: Record<string, string | undefined>,
  baseDir: string,
  deps: { where?: () => string; exists?: (p: string) => boolean } = {},
): string | null {
  const exists = deps.exists ?? existsSync;
  const override = env[ENV.opencodePath]?.trim();
  if (override) return override;
  const own = noaFolderOpencode(baseDir);
  if (exists(own)) return own;
  const where =
    deps.where ??
    (() => execFileSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
  try {
    const found = where()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // With shell: false a .cmd shim (npm's on Windows) cannot be started.
    const exe = (process.platform === "win32" ? found.filter((p) => p.toLowerCase().endsWith(".exe")) : found).find((p) => exists(p));
    if (exe) return exe;
  } catch {
    /* not on the PATH */
  }
  const installed = join(env.USERPROFILE || homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  return exists(installed) ? installed : null;
}

/** OpenCode's provider id for the Local model's server: models are named `noa-local/<model>`. */
export const LOCAL_PROVIDER = "noa-local";
/** OpenCode's agent a session runs as: Noa's system prompt, Noa's tools, and OpenCode's web and skill tools. */
export const NOA_AGENT = "noa";

/**
 * OpenCode's tools a session goes without: shell, files and code. Pages are untrusted (the system prompt's first
 * rule), and an agent that reads them must not be able to run commands or change files on the user's computer.
 * Kept: websearch, webfetch, skill, todowrite and the noa_* tools.
 */
export const OPENCODE_TOOLS_OFF = ["bash", "edit", "write", "read", "glob", "grep", "list", "patch", "multiedit", "lsp", "task", "codesearch"] as const;

/**
 * How much the model is told it may use: the context `npx noa-local-llm` gives the model in Ollama (num_ctx), and
 * room for an answer with thinking before it. OpenCode asks for limit.output tokens of answer; a server whose context
 * is smaller refuses the request (measured: an OpenAI-compatible server with a 32k context and OpenCode's default
 * 32,000 output tokens).
 */
export const LOCAL_MODEL_LIMIT = { context: 32_768, output: 8_192 } as const;

export interface OpencodeConfigSpec {
  /** The Local model's server as typed in Settings (localMessagesBase trims what was pasted with it). */
  serverUrl: string;
  model: string;
  /** NOA_LOCAL_MODEL_KEY, for a server that wants one. */
  apiKey?: string;
  /** The session's system prompt, in a file of its own (systemPromptFile). */
  systemPromptPath: string;
  /** The Noa MCP server of the session (buildMcpConfig's). */
  mcp: { command: string; args: string[]; env: Record<string, string> };
}

/** The config a session's OpenCode runs with (OPENCODE_CONFIG_CONTENT, which wins over the user's own config files). */
export function buildOpencodeConfig(spec: OpencodeConfigSpec): Record<string, unknown> {
  const baseURL = localMessagesBase(spec.serverUrl);
  if (!baseURL) throw new Error(`The local model's server address is not a web address: ${spec.serverUrl}`);
  const model = `${LOCAL_PROVIDER}/${spec.model}`;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [LOCAL_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local model",
        options: { baseURL, ...(spec.apiKey ? { apiKey: spec.apiKey } : {}) },
        models: { [spec.model]: { name: spec.model, tool_call: true, limit: LOCAL_MODEL_LIMIT } },
      },
    },
    model,
    small_model: model,
    mcp: { noa: { type: "local", command: [spec.mcp.command, ...spec.mcp.args], environment: spec.mcp.env, enabled: true } },
    agent: {
      [NOA_AGENT]: {
        mode: "primary",
        description: "Noa: carries out the user's task in their Chrome browser.",
        prompt: `{file:${spec.systemPromptPath}}`,
        tools: Object.fromEntries(OPENCODE_TOOLS_OFF.map((t) => [t, false])),
      },
      // A session title is one more model call, slow on a local model, and Noa names its chats itself.
      title: { disable: true },
    },
    autoupdate: false,
    share: "disabled",
  };
}

/**
 * Environment of a session's OpenCode: its config, web search on (Exa's, which OpenCode turns on with
 * OPENCODE_ENABLE_EXA; no key needed), and none of Claude Code's CLAUDE.md files in its prompt (the user's skills
 * in ~/.claude/skills still load).
 */
export function opencodeEnv(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_ENABLE_EXA: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}

/** `opencode run` for one message (read from stdin): JSON events out, the reasoning too, continuing `session` when set. */
export function opencodeRunArgs(opts: { session?: string; files?: string[] }): string[] {
  return ["run", "--format", "json", "--thinking", "--agent", NOA_AGENT, ...(opts.session ? ["--session", opts.session] : []), ...(opts.files ?? []).flatMap((f) => ["--file", f])];
}
