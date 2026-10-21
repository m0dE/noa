/** Names of the environment variables the helper reads (from .env files or the environment) or sets for the processes it starts. */
export const ENV = {
  /** Base folder for logs, runs and helper.json. Default: see HelperConfig.baseDir. */
  home: "NOA_HOME",
  /** "scripted": the deterministic scripted brain instead of Claude Code (tests, e2e). */
  brain: "NOA_BRAIN",
  /** Claude Code model when the extension names none. */
  model: "NOA_MODEL",
  /** "on": Claude Code thinks before its answers; "off": it answers at once. Unset: the extension's Reasoning setting (HelperConfig.thinking). */
  thinking: "NOA_THINKING",
  /** Path of claude.exe, instead of looking it up. */
  claudePath: "NOA_CLAUDE_PATH",
  /** Path of OpenCode (the Local model brain), instead of looking it up (opencode-process.ts). */
  opencodePath: "NOA_OPENCODE_PATH",
  /** API key the Local model's server wants, for servers started with one (vLLM --api-key, LM Studio's); Ollama needs none. */
  localModelKey: "NOA_LOCAL_MODEL_KEY",
  /** Jev key used when the extension sends none. */
  typesafeApiKey: "TYPESAFE_API_KEY",
  /** For the MCP server a task session's Claude Code starts: the helper's pipe. */
  pipe: "NOA_PIPE",
  /** For the MCP server: the token every call on the pipe carries (random per helper start; see PipeMethods). */
  pipeToken: "NOA_PIPE_TOKEN",
  /** For the MCP server: its task session id (empty: the attached session's tools). */
  task: "NOA_TASK",
  /** For the MCP server: comma list of the tools to register (default: all). */
  tools: "NOA_TOOLS",
  /** For the MCP server: "1" when Jev picks act's elements (tools are described for that mode). */
  jev: "NOA_JEV",
} as const;
