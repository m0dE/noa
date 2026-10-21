/**
 * A model the user runs on their own computer (Ollama, LM Studio, llama.cpp's server, vLLM), e.g. Qwen or
 * Hermes. Each of them answers the OpenAI chat API at `<server>/v1` and lists its models at `<server>/v1/models`.
 * The helper runs the session on OpenCode (an open-source agent: web search, web pages, skills, thinking) with
 * Noa's browser tools, as it runs Claude Code's.
 */

/** What the local brain is called in messages and settings. */
export const LOCAL_MODEL_LABEL = "Local model";
/** Ollama's address, the most common local server. */
export const DEFAULT_LOCAL_MODEL_URL = "http://localhost:11434";
/** The one command that sets up the Local model: the helper, Ollama, a model and OpenCode (packages/local-llm). */
export const LOCAL_SETUP_COMMAND = "npx -y noa-local-llm";

/**
 * The server's address as typed, without what the user may have copied with it (a trailing slash, `/v1`,
 * `/v1/messages`): null when it is not an http(s) address.
 */
export function localServerUrl(typed: string): string | null {
  let url: URL;
  try {
    url = new URL(typed.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1(\/messages|\/models)?$/, "");
  return `${url.origin}${path}`;
}

/** The API base (`${base}/chat/completions`, `${base}/messages`); null for an address that is not one. */
export function localMessagesBase(typed: string): string | null {
  const server = localServerUrl(typed);
  return server && `${server}/v1`;
}

/** The server's model list (OpenAI's shape, which every one of these servers also answers). */
export function localModelsUrl(typed: string): string | null {
  const server = localServerUrl(typed);
  return server && `${server}/v1/models`;
}
