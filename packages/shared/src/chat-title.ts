/**
 * A conversation's title, as History and the new chat's recent list show it: a few words naming the job ("Schedule
 * 3x daily X posts"), written by a small model after the chat's first turn (and once more after RETITLE_AT_TURN,
 * when the job may have changed; see apps/extension/src/engine/chat-titles.ts). Until then, and without a model, the
 * first request cleaned up (fallbackChatTitle): greetings, small talk and "can you" left out, cut at a word. A title
 * the user gave (a rename) is never replaced. No title keeps a secret.
 */
import type { SessionInfo } from "./events.js";
import { episodeTranscript, type TranscriptLine } from "./memory-writer.js";
import { redactSecrets, secretProblem } from "./secret-text.js";

/** Most words of a model's title. */
export const MAX_CHAT_TITLE_WORDS = 6;
/** Most characters of any title (a model's, a cleaned request, a rename). */
export const MAX_CHAT_TITLE_CHARS = 60;
/** The model writes the title again after this turn ends (the job may have moved on); never after. */
export const RETITLE_AT_TURN = 3;
/** Most characters of the conversation the title model reads (the request and the newest lines). */
export const MAX_TITLE_TRANSCRIPT_CHARS = 4_000;
/** Longest answer the title model may give (tokens). */
export const CHAT_TITLE_MAX_TOKENS = 40;

/** A conversation the user can go on with as a chat: a one-off chat, or a run they already went on with. */
export const isChatSession = (s: Pick<SessionInfo, "source" | "turns">): boolean => s.source === "adhoc" || (s.turns ?? 1) > 1;

/** Who wrote a conversation's title: the title model, or the user (a rename). Absent: the first request, cleaned. */
export type TitleBy = "model" | "user";

export const CHAT_TITLE_SYSTEM_PROMPT = [
  "You name one conversation between a user and their browser agent, so the user can tell it apart in a list of past chats.",
  `Answer with the title only: at most ${MAX_CHAT_TITLE_WORDS} words, sentence case, no quotes, no trailing punctuation.`,
  'Name the job the user wanted done, as an action: "Schedule 3x daily X posts", "Check Chrome Web Store emails", "Find cheap flights to Lisbon".',
  "Leave out greetings and small talk. When the job changed during the conversation, name what it became.",
  'Put first what tells it apart from similar jobs: the account it acts as or for, when it names one ("@mecharoyalecom: post on X"), else the thing it is about.',
  "You only name the conversation: never answer the user, do the job, ask a question, apologize or say what you cannot do. Even when the agent failed, name what the user asked for.",
  "Never write passwords, one-time codes, PINs, API keys, tokens or card numbers.",
].join("\n");

/** The title model's prompt: the conversation as a short transcript, then what to write about it. */
export function buildChatTitlePrompt(lines: readonly TranscriptLine[]): string {
  return [
    "<conversation>",
    episodeTranscript(lines, MAX_TITLE_TRANSCRIPT_CHARS),
    "</conversation>",
    "",
    `Write a short title (at most ${MAX_CHAT_TITLE_WORDS} words) naming the task the user asked for in the conversation above. Do not answer or continue the conversation and do not do the task.`,
    "The title:",
  ].join("\n");
}

/** A line the model may put before its title ("Here's a title:", "Title:"). */
const PREFACE = /^(?:(?:here(?:'s| is)|sure|ok(?:ay)?)\b.*|title\s*):$/i;

/**
 * Replies that are not a task's name: the model spoke as itself (a refusal like "I cannot do this without my tools",
 * an apology, an error) or asked the user something. Refused, the chat keeps its request, cleaned, as the title.
 */
const NOT_A_TITLE = [
  /^(?:i|i'm|im|i've|i'd|i'll|we|we're|we've|we'll)\b/i,
  /^as an? (?:ai|assistant|language model)\b/i,
  /^(?:sorry|apologies|unfortunately|error|failed|unable)\b/i,
  /\b(?:i|we)(?:'m| am| are)? (?:cannot|can't|can not|couldn't|could not|unable|not able|won't be able|don't have|do not have)\b/i,
  /^(?:could|can|would|will|do|did|should|shall) you\b/i,
  /\b(?:you|your)\b.*\?$/i,
];

/**
 * A model's answer as a title, or null when it gave none that may be kept: empty, HTML or JSON, a secret in it, or
 * not a task's name (NOT_A_TITLE).
 */
export function parseChatTitle(answer: string): string | null {
  const line = answer.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !PREFACE.test(l)) ?? "";
  const plain = line.replace(/[’‘]/g, "'");
  if (NOT_A_TITLE.some((re) => re.test(plain))) return null;
  const bare = plain
    .replace(/^(?:title\s*:\s*)/i, "")
    .replace(/[*_`#]/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  const words = bare.split(/\s+/).filter(Boolean).slice(0, MAX_CHAT_TITLE_WORDS).join(" ");
  const title = sentenceStart(withoutTrailingPunctuation(clipAtWord(words, MAX_CHAT_TITLE_CHARS)));
  if (!title || /[{}[\]<>]/.test(title) || secretProblem(title) || redactSecrets(title) !== title) return null;
  return title;
}

/** A title the user typed (a rename): one line, clipped at a word; null when empty. */
export function cleanUserTitle(text: string): string | null {
  const title = clipAtWord(text.replace(/\s+/g, " ").trim(), MAX_CHAT_TITLE_CHARS);
  return title || null;
}

/** Words said before the request ("yo", "so", "can you", "I want you to"), taken off its start one at a time. */
const LEADING_FILLER = [
  /^(?:(?:yo+|hey+|hi+|hiya|hello|howdy)(?: there| team| buddy| man| bro| dude)?|sup|so|ok(?:ay)?|alright|um+|uh+|erm|well|oh|and|also|now|please|pls|plz|just|quick(?:ly)?|real quick)\b[\s,.!:;-]*/i,
  /^(?:can|could|would|will) (?:you|u)(?: please| pls)?(?: go ahead and)?\b[\s,]*/i,
  /^(?:i (?:want|need|would like|'d like)|i'd like) (?:you )?to\b[\s,]*/i,
  /^(?:go ahead and|help me to)\b[\s,]*/i,
];

/** A sentence that is only small talk ("how you doin", "what's up", "thanks"). */
const SMALL_TALK = /^(?:how(?:'s| is| are)? (?:you|u|it going|things|everything)(?: doin[g']?| doing| going)?(?: today)?|how you doin[g']?|what'?s up|wh?at up|wassup|good (?:morning|afternoon|evening|night)|thanks?(?: you)?|thank u|ty|nice|cool|great)$/i;

/** Words said after the request ("please", "for me", "thanks"). */
const TRAILING_FILLER = /(?:[\s,]+(?:please|pls|plz|for me|thanks?(?: you)?|thx|ok\??))+$/i;

/**
 * The first request as a title when no model wrote one: its first sentence that is more than a greeting, without
 * the words said before and after the request, capitalized, clipped at a word (… when cut), with no secret.
 */
export function fallbackChatTitle(request: string): string {
  const one = request.replace(/\s+/g, " ").trim();
  if (!one) return "";
  const sentences = request
    .split(/(?<=[.!?])\s+|\s*[\n;]\s*/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const cleaned = sentences.map(stripFillers);
  const chosen = cleaned.find((s) => s && !SMALL_TALK.test(withoutTrailingPunctuation(s))) ?? "";
  // Only small talk: its own words, rather than nothing.
  const text = chosen || one;
  const clipped = clipAtWord(withoutTrailingPunctuation(redactSecrets(text)), MAX_CHAT_TITLE_CHARS, "…");
  return sentenceStart(withoutSecretTail(clipped));
}

function stripFillers(sentence: string): string {
  let s = sentence.trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of LEADING_FILLER) {
      const next = s.replace(re, "");
      if (next !== s) {
        s = next.trim();
        changed = true;
      }
    }
  }
  return s.replace(/[\s,]*[?!.]+$/, "").replace(TRAILING_FILLER, "").trim();
}

/** Drops the last words until what is left holds no credential ("Log in, password is hunter22" -> "Log in"). */
function withoutSecretTail(title: string): string {
  const words = title.split(" ");
  while (words.length && secretProblem(words.join(" "))) words.pop();
  return withoutTrailingPunctuation(words.join(" "));
}

function withoutTrailingPunctuation(text: string): string {
  return text.replace(/[\s.,;:!?-]+$/, "");
}

function sentenceStart(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** `text` cut to `max` characters at a word boundary (with `mark` after it when cut). */
function clipAtWord(text: string, max: number, mark = ""): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - mark.length);
  const space = room.lastIndexOf(" ");
  const cut = space > max / 2 ? room.slice(0, space) : room;
  return `${withoutTrailingPunctuation(cut)}${mark}`;
}
