/** Names the extension's pages show for brains and models. Pure. */
import { CLAUDE_MODELS, type BrainKind } from "@noa/shared";

export const BRAIN_LABELS: Readonly<Record<BrainKind, string>> = {
  "claude-code": "Claude Code",
  "claude-api": "Claude API",
  scripted: "Scripted",
  noa: "Noa AI",
};

export function brainLabel(kind: BrainKind, jev = false): string {
  return BRAIN_LABELS[kind] + (jev ? " + Jev" : "");
}

/** "claude-sonnet-5" -> "Sonnet 5"; unknown ids are shown as typed. */
export function modelLabel(id: string | null | undefined): string {
  const m = id?.trim() ?? "";
  if (!m) return "Default model";
  return CLAUDE_MODELS.find((k) => k.id === m)?.label ?? m;
}
