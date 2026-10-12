/**
 * The Claude models Noa offers: the side panel's model menu, the
 * options page's select and the hosted AI's allowlist (apps/api/src/pricing.ts
 * prices exactly these). Other ids still work with a local brain.
 *
 * thinking: how the Messages API controls the model's thinking (Anthropic's
 * per-model table): "switchable" takes adaptive or disabled; "always" always
 * thinks (disabled is a 400; effort is the lever); "budget" thinks only with
 * a fixed budget_tokens (adaptive is a 400).
 *
 * price: Anthropic's list price in cents per 1M tokens (input, output, 5-minute
 * cache write, cache read), read 2026-09-27 from Anthropic's model table (the
 * owner must confirm against the live pricing page before going live). The
 * ONE place to edit prices: the hosted AI's price table (apps/api/src/pricing.ts)
 * and the model menu's cost hint (modelHint) are built from it.
 */
export const CLAUDE_MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5", thinking: "switchable", price: { input: 200, output: 1000, cacheWrite: 250, cacheRead: 20 } },
  { id: "claude-opus-5-5", label: "Opus 5.5", thinking: "always", price: { input: 400, output: 2000, cacheWrite: 500, cacheRead: 20 } },
  { id: "claude-fable-5-1", label: "Fable 5.1", thinking: "always", price: { input: 1000, output: 5000, cacheWrite: 1250, cacheRead: 25 } },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", thinking: "budget", price: { input: 100, output: 500, cacheWrite: 125, cacheRead: 10 } },
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]["id"];
export type ModelThinking = (typeof CLAUDE_MODELS)[number]["thinking"];

/** How a model's thinking is controlled (see CLAUDE_MODELS), or null for a model Noa does not offer. */
export function modelThinking(id: string): ModelThinking | null {
  const known = resolveModel(id);
  return known ? CLAUDE_MODELS.find((m) => m.id === known)!.thinking : null;
}

/** The model setting's default, and what the hosted AI runs for an id it does not offer. */
export const DEFAULT_MODEL: ClaudeModelId = "claude-sonnet-5";

/**
 * The model menu's one-line hint, from the catalog alone: whether the model thinks before every step (thinking
 * "always": it cannot be turned off, so each step waits for it; the others think only when the Reasoning setting
 * asks) and its token price relative to the default model's, whose row says "default price" (input and output
 * tokens; relative, so it holds for the hosted AI's credit too). Null for a model Noa does not offer.
 */
export function modelHint(id: string): string | null {
  const known = resolveModel(id);
  if (!known) return null;
  const m = CLAUDE_MODELS.find((x) => x.id === known)!;
  const speed = m.thinking === "always" ? "Thinks first, slower" : "Faster";
  if (known === DEFAULT_MODEL) return `${speed} · default price`;
  const base = CLAUDE_MODELS.find((x) => x.id === DEFAULT_MODEL)!;
  return `${speed} · ${priceRatioText(m.price.output / base.price.output)} price`;
}

/** 2 -> "2×", 0.5 -> "½", 1.5 -> "1.5×". */
function priceRatioText(ratio: number): string {
  if (ratio === 0.5) return "½";
  return `${Math.round(ratio * 10) / 10}×`;
}

/** Other names accepted for a model (Anthropic's undated alias), resolved to its id. */
export const MODEL_ALIASES: Readonly<Record<string, ClaudeModelId>> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export function isClaudeModel(id: string): id is ClaudeModelId {
  return CLAUDE_MODELS.some((m) => m.id === id);
}

/** The catalog id for a model id or alias, or null when Noa does not offer it. */
export function resolveModel(id: unknown): ClaudeModelId | null {
  if (typeof id !== "string") return null;
  const resolved = Object.hasOwn(MODEL_ALIASES, id) ? MODEL_ALIASES[id]! : id;
  return isClaudeModel(resolved) ? resolved : null;
}

/** The model the hosted AI runs for this setting: ids it does not offer fall back to the default. */
export function hostedModel(id: string): ClaudeModelId {
  return resolveModel(id) ?? DEFAULT_MODEL;
}

/** Anthropic's API: its origin, and the `anthropic-version` every Messages call sends. */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_API_BASE}/messages`;
export const ANTHROPIC_API_VERSION = "2023-06-01";
