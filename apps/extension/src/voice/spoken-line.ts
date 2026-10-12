/**
 * The lines hands-free voice says aloud: the agent's own `spoken` line when
 * a turn ends, else the first sentence of its summary or reason; errors in
 * the error card's plain words; the agent's opening plan when it is short.
 * Long answers are never read out. Pure.
 */
import { MAX_SPOKEN_CHARS, type AgentEvent, USER_STOP_REASON } from "@noa/shared";
import { errorHelp } from "../sidepanel/error-help.js";
import { containedWordShare } from "../text.js";

/** The opening plan is said only when its first sentence is at most this long. */
const MAX_PLAN_CHARS = 160;

/** Markdown as plain words: no headings, emphasis, code marks, links or bare URLs. */
function plainText(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, "") // headings name a section; they are not said
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`>~]+/g, "")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** `text` clipped to `max` characters at a word, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** The first sentence of `text` as plain words, at most `max` characters ("" when there is none). */
export function speakable(text: string, max = MAX_SPOKEN_CHARS): string {
  const plain = plainText(text);
  const end = /[.!?](?=\s|$)/.exec(plain);
  return clip(end ? plain.slice(0, end.index + 1) : plain, max);
}

/** The agent's answer to what the user asked it while it worked, as plain words (at most MAX_SPOKEN_CHARS). */
export function answerLine(text: string): string {
  return clip(plainText(text), MAX_SPOKEN_CHARS);
}

/** An error's one short line (the error card's message). */
export function errorLine(text: string): string {
  return errorHelp(text).message;
}

type TaskEnd = Extract<AgentEvent, { type: "task_end" }>;

/** What is said when the user stopped the task. */
export const STOPPED_LINE = "Stopped.";

/** What is said when a turn ends. */
export function endLine(ev: TaskEnd): string {
  const own = ev.spoken?.trim();
  if (own) return clip(own, MAX_SPOKEN_CHARS);
  if (ev.outcome === "done") return speakable(ev.summary ?? "") || "Done.";
  const reason = ev.reason?.trim() ?? "";
  // The user stopped it: one clear line, not a question.
  if (ev.outcome === "paused" && reason === USER_STOP_REASON) return STOPPED_LINE;
  // The agent's own reason is said as it wrote it, never as one of Noa's errors.
  const help = reason && !ev.byAgent ? errorHelp(reason) : null;
  if (help?.known) return help.message;
  // A paused turn's reason is what the agent needs from the user: said as it is.
  if (ev.outcome === "paused" && reason) return speakable(reason);
  return reason ? `That didn't work: ${speakable(reason, MAX_SPOKEN_CHARS - 18)}` : "That didn't work.";
}

/** A sentence with at least this share of its words in a line said already is that line again. */
const SAID_OVERLAP_MIN = 0.8;

/** Lower-case words, for comparing lines. */
const wordsOf = (text: string): string[] => text.toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];

/** `text` with its first `n` words left out (and the punctuation after them), starting with a capital. */
function withoutWords(text: string, n: number): string {
  const rest = text.replace(new RegExp(`^\\s*(?:[^\\p{L}\\p{N}'’\`]*[\\p{L}\\p{N}'’\`]+){${n}}[^\\p{L}\\p{N}'’\`]*`, "u"), "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * `line` without what was already said aloud (`said`): its sentences said already, and the words of a line said
 * already when it starts with all of them ("Not much!", then "Not much, just here and ready to help." says "Just here
 * and ready to help."). "" when all of it was. A real trace: the opening text "I'm doing well, thanks for asking!" was
 * said as the plan, then the turn's spoken line "I'm doing well, thanks for asking! What can I help you with?" said it
 * again.
 */
export function unsaid(line: string, said: readonly string[]): string {
  if (!said.length) return line;
  const before = said.join(" ");
  let rest = line
    .split(/(?<=[.!?…])\s+/)
    .filter((s) => !/[\p{L}\p{N}]/u.test(s) || containedWordShare(s, before) < SAID_OVERLAP_MIN)
    .join(" ")
    .trim();
  for (const s of said) {
    const w = wordsOf(s);
    const r = wordsOf(rest);
    if (w.length && w.length < r.length && w.every((x, i) => r[i] === x)) rest = withoutWords(rest, w.length);
  }
  return rest;
}

/** `line` was said already (in `said`): its words are in what was said. */
export function saidBefore(line: string, said: readonly string[]): boolean {
  return said.length > 0 && containedWordShare(line, said.join(" ")) >= SAID_OVERLAP_MIN;
}

/** The first sentence of the agent's opening text of a turn, when it is short enough to say; else null. */
export function planLine(text: string): string | null {
  const line = speakable(text, MAX_PLAN_CHARS + 1);
  return line && line.length <= MAX_PLAN_CHARS && !line.endsWith("…") ? line : null;
}
