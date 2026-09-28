/**
 * Approvals in hands-free voice: the line that asks for one (said by Standard,
 * passed to the Realtime narrator as a question), the approval the chat is
 * waiting on, and a spoken answer: "yes" / "allow" allows it once, "no" /
 * "deny" refuses it. Anything else is a normal message. Pure.
 */
import type { AgentEvent, ApprovalAnswer, ApprovalRequest } from "@noa/shared";

/** "Approval needed: Click "Post" on x.com; it publishes. Say yes to allow it, or no." */
export function approvalLine(r: Pick<ApprovalRequest, "action" | "site" | "why">): string {
  return `Approval needed: ${r.action}${r.site ? ` on ${r.site}` : ""}; it ${r.why.replace(/^it /, "")}. Say yes to allow it, or no.`;
}

const ALLOW = /^(yes|yeah|yep|sure|ok|okay|allow( it)?|go ahead|do it|approve( it)?|allow once)$/;
const DENY = /^(no|nope|deny( it)?|don'?t|do not|stop|cancel|refuse|don'?t do it)$/;

/** The answer a short utterance gives, or null when it is something else (then it goes to the agent as usual). */
export function spokenApprovalAnswer(text: string): ApprovalAnswer | null {
  const t = text.toLowerCase().replace(/[.!,?]+/g, " ").replace(/\s+/g, " ").trim().replace(/ please$/, "");
  if (ALLOW.test(t)) return "allow_once";
  if (DENY.test(t)) return "deny";
  return null;
}

/**
 * Words that say yes to an action, in the languages voice listens in (voice-language.ts): whole words for
 * scripts with spaces, parts of the text for Chinese and Japanese.
 */
const YES_WORDS = [
  // English
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright", "all right", "allow", "allow it", "allowed", "approve", "approved", "i approve",
  "go ahead", "do it", "do that", "post it", "send it", "publish it", "submit it", "pay it", "delete it", "confirm", "confirmed", "proceed",
  "go for it", "please do", "that's fine", "that is fine", "fine", "of course", "absolutely", "affirmative", "correct",
  // Spanish, Portuguese, Italian, French, German, Dutch
  "sí", "vale", "adelante", "hazlo", "publícalo", "publicalo", "claro", "sim", "pode", "certo", "fallo", "va bene", "procedi",
  "oui", "d'accord", "vas y", "vas-y", "allez y", "allez-y", "fais le", "fais-le", "ja", "klar", "mach es", "mach das", "einverstanden",
  "doe maar", "prima",
  // Russian, Ukrainian
  "да", "давай", "разрешаю", "конечно",
  // Korean
  "네", "예", "응", "그래", "좋아", "좋아요", "허락", "승인", "올려", "올려줘", "게시해", "해줘", "진행해",
  // Japanese, Chinese
  "はい", "いいよ", "いいです", "お願いします", "どうぞ", "許可", "承認", "投稿して",
  "是的", "好的", "可以", "允许", "同意", "批准", "发吧", "发布吧",
];

/** Words that make an utterance anything but a plain yes: a no, a wait, or a question. */
const NOT_YES_WORDS = [
  "no", "nope", "not", "don't", "dont", "never", "wait", "hold on", "stop", "cancel", "deny", "why", "what", "how", "when", "where", "who", "which",
  "espera", "non", "attends", "nein", "nicht", "warte", "nee", "нет", "не", "подожди", "почему",
  "아니", "안 돼", "안돼", "하지 마", "하지마", "잠깐", "멈춰", "왜", "뭐",
  "いいえ", "だめ", "ダメ", "待って", "やめ", "なぜ", "なんで", "何",
  "不", "别", "等", "为什么", "什么", "吗",
];

/** Scripts written without spaces between words: a phrase counts wherever it appears. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function normalized(text: string): string {
  return ` ${text.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'?\-]+/gu, " ").replace(/\s+/g, " ").trim()} `;
}

function hasWord(t: string, phrase: string): boolean {
  return UNSPACED.test(phrase) ? t.includes(phrase) : t.includes(` ${phrase} `);
}

/**
 * Whether the user's words say yes to the waiting action, plainly: a yes word, and no no, wait or question
 * ("So why is it talking about Sunday?" is not a yes). A spoken allow needs this; a no never does.
 */
export function explicitYes(words: string): boolean {
  const t = normalized(words);
  if (t.includes("?")) return false;
  const plain = t.replace(/\?/g, " ");
  if (NOT_YES_WORDS.some((w) => hasWord(plain, w))) return false;
  return YES_WORDS.some((w) => hasWord(plain, w));
}

/** Generic words of an action's description (describeAction): what is left names the action itself. */
const ACTION_VERBS = new Set(["click", "type", "into", "press", "open", "in", "a", "new", "tab", "tabs", "choose", "upload", "check", "uncheck", "close", "the", "an", "on", "files"]);

/**
 * Whether `said` (the narrator's words for the action it asked about) names the waiting action: every word of
 * its label (`Click "Post"` -> post), or of its description when it has none.
 */
export function namesAction(said: string, action: string): boolean {
  const label = /"([^"]+)"/.exec(action)?.[1] ?? action;
  const words = normalized(label).replace(/[?']/g, " ").split(" ").filter((w) => w && !ACTION_VERBS.has(w)).slice(0, 3);
  const t = normalized(said);
  return words.length > 0 && words.every((w) => t.includes(w));
}

/**
 * Why a spoken allow of the waiting action is refused (the narrator is told to ask the user plainly), or null when
 * it stands: the user's own words for the turn say yes, and the narrator names the action it asked about.
 */
export function spokenAllowRefusal(userWords: string, named: string, waiting: string | null): string | null {
  if (!waiting) return "Nothing is waiting for the user's OK.";
  if (!explicitYes(userWords)) {
    return `Not allowed: the user did not plainly say yes to it. Ask them plainly: "Should I ${waiting}? Say yes or no." Then call answer_approval again with their answer.`;
  }
  if (!namesAction(named, waiting)) return `Not allowed: say which action they allow. Call answer_approval again with action "${waiting}".`;
  return null;
}

/** The approval request of each chat that still waits (the newest one). */
export class WaitingApprovals {
  private readonly waiting = new Map<string, string>();

  push(ev: AgentEvent & { sessionId: string }): void {
    if (ev.type === "approval_request") this.waiting.set(ev.sessionId, ev.request.id);
    else if ((ev.type === "approval_resolved" && this.waiting.get(ev.sessionId) === ev.id) || ev.type === "task_end") this.waiting.delete(ev.sessionId);
  }

  of(sessionId: string | null): string | null {
    return sessionId ? (this.waiting.get(sessionId) ?? null) : null;
  }
}
