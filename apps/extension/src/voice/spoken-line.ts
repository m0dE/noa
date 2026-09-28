/**
 * The lines hands-free voice says aloud: the agent's own `spoken` line when
 * a turn ends, else the first sentence of its summary or reason; errors in
 * the error card's plain words; the agent's opening plan when it is short.
 * Long answers are never read out. Pure.
 */
import { MAX_SPOKEN_CHARS, type AgentEvent, USER_STOP_REASON } from "@noa/shared";
import { errorHelp } from "../sidepanel/error-help.js";

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
  const help = reason ? errorHelp(reason) : null;
  if (help?.known) return help.message;
  // A paused turn's reason is what the agent needs from the user: said as it is.
  if (ev.outcome === "paused" && reason) return speakable(reason);
  return reason ? `That didn't work: ${speakable(reason, MAX_SPOKEN_CHARS - 18)}` : "That didn't work.";
}

/** The first sentence of the agent's opening text of a turn, when it is short enough to say; else null. */
export function planLine(text: string): string | null {
  const line = speakable(text, MAX_PLAN_CHARS + 1);
  return line && line.length <= MAX_PLAN_CHARS && !line.endsWith("…") ? line : null;
}
