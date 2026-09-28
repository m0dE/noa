/**
 * Scheduled tasks run on their own ("Do what the task says without asking"),
 * except for a consequential action the task's written instructions do not
 * ask for: liking posts when the task only says to post, sending an email
 * when it only says to read the inbox, paying on a site the task never names.
 * The rules, in three answers:
 *
 * - yes: the instructions use a verb of the action's family ("post", "tweet",
 *   "reply" for a Post click) as a whole word (or its -ing form), do not
 *   forbid the action itself ("don't post it"; "don't post links" is a rule about
 *   the content, not a ban), and name the action's site (its domain, its
 *   name "Namecheap", or X for a task that acts as an X account);
 * - no: no such verb, a forbidden one, or the task names other sites only;
 * - unsure: the verb is there but the task says nowhere where (judge.ts asks Jev).
 *
 * Coarse by design (a verb anywhere in the task counts, and a noun spelled
 * like one does too: "Make one post"); see the measured limits in
 * test/approval/consequence.test.ts. Pure.
 */
import { isXSite, isXTask, registrableDomain, sameSite, type ConsequenceKind } from "@noa/shared";
import { hasPhrase, labelOf, type GateAction } from "./consequence.js";

/**
 * The verbs that ask for each family of actions, in their base form (the -ing form counts too; "posts", "likely",
 * "bookmark" do not). Uploads also count what is uploaded ("Post this photo"): a run uploads only the task's own files.
 */
export const TASK_FAMILIES = {
  post: ["post", "tweet", "publish", "share", "reply", "respond", "comment", "quote", "announce"],
  like: ["like", "heart", "favorite", "favourite", "fav"],
  repost: ["repost", "retweet", "share", "boost"],
  follow: ["follow", "unfollow"],
  moderate: ["block", "report", "mute"],
  send: ["send", "email", "mail", "message", "reply", "respond", "answer", "forward", "invite", "dm", "write to", "text", "tell"],
  pay: ["pay", "buy", "purchase", "order", "renew", "subscribe", "check out", "donate", "transfer", "book", "top up", "upgrade", "tip"],
  delete: ["delete", "remove", "clean", "clear", "trash", "purge", "unsubscribe", "empty", "discard", "get rid"],
  submit: ["submit", "sign", "apply", "register", "subscribe", "book", "reserve", "rsvp", "confirm", "accept", "agree", "vote", "fill", "enrol", "enroll", "join", "create", "complete"],
  account: ["change", "reset", "update", "enable", "disable", "turn on", "turn off", "set up", "deactivate", "revoke", "unsubscribe"],
  upload: ["upload", "attach", "photo", "image", "picture", "video", "file", "media", "pdf", "document", "screenshot", "gif"],
} as const satisfies Record<string, readonly string[]>;
export type TaskFamily = keyof typeof TASK_FAMILIES;

/** Whether a scheduled task's instructions ask for an action: see the top of this file. */
export type WithinRules = "yes" | "no" | "unsure";

/** Words just before a verb that forbid it: "don't post", "without posting", "never reply". */
const NEGATIONS = ["not", "dont", "don t", "never", "without", "no", "nor", "avoid"];
/** How many words before a verb a negation still applies to ("do not ever post"). */
const NEGATION_REACH = 3;

/** Verbs stressed on their last syllable, which double their last consonant ("submitting"). */
const DOUBLED = new Set(["submit", "transfer", "enrol"]);

/** A verb's -ing form: "post" -> "posting", "like" -> "liking", "tip" -> "tipping", "agree" -> "agreeing". */
export function ingForm(verb: string): string {
  if (verb.endsWith("ie")) return `${verb.slice(0, -2)}ying`;
  if (verb.endsWith("e") && !/[eoy]e$/.test(verb)) return `${verb.slice(0, -1)}ing`;
  if (DOUBLED.has(verb) || /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(verb)) return `${verb}${verb.at(-1)}ing`;
  return `${verb}ing`;
}

/** Each family's word forms as token lists: a phrase inflects its first word ("top up", "topping up"). */
const FAMILY_FORMS = Object.fromEntries(
  Object.entries(TASK_FAMILIES).map(([family, verbs]) => [
    family,
    verbs.flatMap((v) => {
      const [head, ...rest] = v.split(" ");
      return [head!, ingForm(head!)].map((h) => [h, ...rest]);
    }),
  ]),
) as Record<TaskFamily, string[][]>;

/** Domain names in a text ("namecheap.com", the site of "ada@example.com"). */
const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;

/** The family an action belongs to: a publish click by its own word (Like, Follow, Repost), otherwise by its kind. */
export function familyOf(kind: ConsequenceKind, action: GateAction): TaskFamily {
  if (kind !== "publish") return kind === "upload" ? "upload" : kind;
  const label = action.element ? labelOf(action.element) : "";
  if (hasPhrase(label, ["like", "unlike", "upvote", "downvote"])) return "like";
  if (hasPhrase(label, ["repost", "retweet", "retweet confirm"])) return "repost";
  if (hasPhrase(label, ["follow", "unfollow"])) return "follow";
  if (hasPhrase(label, ["block", "report", "mute"])) return "moderate";
  return "post";
}

/** Lower-case words of prose, apostrophes dropped ("don't" -> "dont"); a name is one word ("DocuSign", "GitHub"). */
function proseWords(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The instructions' words without addresses and handles ("booking.com", "ada@example.com", "@likeme" ask for
 * nothing), each with the number of its clause (punctuation and line breaks end one).
 */
function verbWords(instructions: string): { word: string; clause: number }[] {
  const text = instructions
    .replace(/\S+@\S+/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(DOMAIN, " ")
    .replace(/@\w+/g, " ");
  return text.split(/[.,;:!?()\n\r]+/).flatMap((clause, n) => proseWords(clause).map((word) => ({ word, clause: n })));
}

/**
 * What a negated verb is followed by, when it bans the action itself rather than what is posted or sent: nothing
 * ("do not post."), a word for the thing the task makes ("don't post it", "don't publish the draft"), a word of
 * time, place or manner ("never post on weekends", "don't reply yet"), or any determiner. A content word after it
 * is a rule about the content ("Don't post contract addresses", "never post links"): the task can still ask for
 * the action elsewhere.
 */
const BANS_THE_ACTION = new Set([
  ...["it", "them", "this", "that", "these", "those", "anything", "something", "everything", "any", "anyone", "anybody", "anymore", "yet"],
  ...["the", "a", "an", "my", "your", "our", "his", "her", "their", "its", "one", "more", "again", "now", "today", "until", "before", "after"],
  ...["unless", "without", "or", "nor", "and", "but", "on", "to", "at", "in", "from", "for", "with", "as", "about", "of", "anywhere", "here"],
  ...["there", "if", "when", "while", "so", "then", "other", "else", "publicly", "online", "back", "out", "up"],
]);

/**
 * Where the family's verbs occur in the instructions: asked (not negated) and forbidden (negated, and banning the
 * action itself; see BANS_THE_ACTION). A negated verb with a content word after it neither asks nor forbids.
 */
function mentions(instructions: string, family: TaskFamily): { asked: boolean; forbidden: boolean } {
  const tokens = verbWords(instructions);
  const words = tokens.map((t) => t.word);
  let asked = false;
  let forbidden = false;
  for (let i = 0; i < words.length; i++) {
    const form = FAMILY_FORMS[family].find((f) => f.every((w, k) => words[i + k] === w));
    if (!form) continue;
    const before = words.slice(Math.max(0, i - NEGATION_REACH), i).join(" ");
    if (!NEGATIONS.some((n) => ` ${before} `.includes(` ${n} `))) {
      asked = true;
      continue;
    }
    const next = tokens[i + form.length];
    if (!next || next.clause !== tokens[i]!.clause || BANS_THE_ACTION.has(next.word)) forbidden = true;
  }
  return { asked, forbidden };
}

/** Whether the task names the site an action happens on: named, names other sites only, or says nowhere. */
function siteNamed(task: { instructions: string; account?: string | null }, url: string): "named" | "other" | "unnamed" {
  const site = registrableDomain(url);
  const domains = task.instructions.match(DOMAIN) ?? [];
  const x = isXTask(task);
  if (!site) return "unnamed";
  if (x && isXSite(site)) return "named";
  if (domains.some((d) => sameSite(d, site))) return "named";
  // Its name as a word: "on Namecheap" names namecheap.com, "on X" x.com, "on GitHub" github.com.
  if (proseWords(task.instructions).includes(site.split(".")[0]!)) return "named";
  return domains.length || x ? "other" : "unnamed";
}

/** Whether a scheduled task's instructions ask for this consequential action, on this site (see the top of this file). */
export function withinInstructions(kind: ConsequenceKind, action: GateAction, task: { instructions: string; account?: string | null }): WithinRules {
  const { asked, forbidden } = mentions(task.instructions, familyOf(kind, action));
  if (!asked || forbidden) return "no";
  const url = action.method === "navigate" || action.method === "openTabs" ? (action.urls?.[0] ?? "") : action.page.url;
  const site = siteNamed(task, url);
  return site === "named" ? "yes" : site === "other" ? "no" : "unsure";
}
