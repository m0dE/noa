/**
 * Is a browser action consequential: does it publish, send, pay, delete,
 * submit a form that commits the user, or change account settings? The
 * rule-based first pass: named word lists matched against the target
 * element (its label, visible text, test id, link), the page (URL, title)
 * and, for a key press, the field it goes to. What the rules cannot tell
 * apart ("Reply" opens a box on X but "Send" sends; "Confirm" after
 * "Delete post?") is "unsure": Jev judges it (consequence-jev.ts), and when
 * there is no Jev, or it is unsure too, the gate asks the user. Pure.
 */
import type { ConsequenceKind, ElementInfo, JsDialog } from "@noa/shared";

/** The browser methods the gate looks at: every one that changes something. */
export type GateMethod = "click" | "type" | "paste" | "pressKey" | "upload" | "navigate" | "openTabs" | "closeTabs" | "switchXAccount" | "handleDialog";

/** A field the agent typed into on this page, and what it typed. */
export interface TypedField {
  element: ElementInfo;
  text: string;
}

/** One browser action about to run, with what the gate knows around it. */
export interface GateAction {
  method: GateMethod;
  /** The element it acts on (click, type, upload), as the last page read listed it; absent when not known. */
  element?: ElementInfo;
  /** click: sets a checkbox, radio button or switch to this state. */
  checked?: boolean;
  /** type / paste: the text. */
  text?: string;
  /** pressKey: the key, e.g. "Enter" or "Control+Enter". */
  key?: string;
  /** navigate / openTabs: where to. */
  urls?: string[];
  /** upload: the files. */
  paths?: string[];
  /** closeTabs: which. */
  tabs?: string[];
  /** switchXAccount: the X account switched to. */
  handle?: string;
  /** handleDialog: the dialog it answers (as the tab has it open now; absent when none is), and OK or Cancel. */
  dialog?: JsDialog;
  accept?: boolean;
  /** The page it happens on (the last page read); "" when not known. */
  page: { url: string; title: string };
  /** The X account that page is signed in as (its account switcher), when it shows one. */
  account?: string;
  /** Fields typed into on this page since it was read after a navigation, oldest first (the last one has the focus). */
  typed: TypedField[];
}

export type Verdict =
  | { verdict: "consequential"; kind: ConsequenceKind; reason: string }
  | { verdict: "benign"; reason: string }
  | { verdict: "unsure"; kind?: ConsequenceKind; reason: string };

// ------------------------------------------------------------------ word lists
// Whole words or phrases, lower case, matched on word boundaries of the element's label (see labelOf).

/** Labels that only open, show, cancel or start something, even when they contain a strong word ("New post"). */
export const BENIGN_PHRASES = [
  "new post", "create post", "write post", "start a post", "compose", "new message", "new email", "new tweet", "write a reply",
  "post your reply", // X's reply box placeholder (a text box), never a button
  "cookie", "cookies", "sign in", "log in", "login", "signin", "add to cart", "add to bag", "add to basket", "save for later",
  "save draft", "drafts", "view order", "order history", "your orders", "track package", "payment methods", "search",
  "accept all", "reject all", "allow all", "necessary only", "sign up with", "continue with",
  "proceed to checkout", "go to checkout", "continue to checkout", "view cart", "go to cart",
] as const;

/** Words and phrases that make a button consequential by themselves, per kind (checked in this order). */
export const STRONG_WORDS: Readonly<Record<ConsequenceKind, readonly string[]>> = {
  pay: [
    "pay", "pay now", "buy", "buy now", "purchase", "place order", "place your order", "complete order", "complete purchase",
    "confirm order", "confirm purchase", "confirm payment", "submit order", "order now", "donate", "transfer", "send money",
    "withdraw", "tip", "cancel order", "cancel subscription", "renew", "one click", "1 click",
  ],
  delete: [
    "delete", "remove", "trash", "move to trash", "erase", "destroy", "wipe", "empty trash", "empty bin", "delete forever",
    "permanently delete",
  ],
  account: [
    "change password", "update password", "reset password", "two factor", "2fa", "deactivate", "close account", "delete account",
    "revoke", "remove access", "change email", "update email", "transfer ownership", "make admin", "unsubscribe",
    "sign out of all", "log out of all", "log out everywhere",
  ],
  send: ["send", "send now", "send message", "send email", "send invite", "send invitation", "invite", "forward message"],
  publish: [
    "post", "post all", "tweet", "tweet all", "tweet button", "repost", "retweet", "publish", "share now", "go live", "like",
    "follow", "unfollow", "block", "report", "upvote", "downvote", "deploy", "redeploy",
  ],
  submit: [
    "submit", "sign and send", "sign document", "sign contract", "sign now", "sign here", "e sign", "i agree", "agree",
    "accept offer", "accept invitation", "apply now", "submit application", "book", "book now", "reserve", "rsvp", "vote",
    "confirm booking", "confirm reservation",
  ],
  upload: [],
};

/** Words that may be consequential depending on the page (the rules leave them to Jev, or to the user). */
export const WEAK_WORDS: Readonly<Record<ConsequenceKind, readonly string[]>> = {
  pay: ["checkout", "check out", "subscribe", "upgrade", "top up", "add funds", "start trial", "continue to payment", "proceed to payment"],
  delete: ["clear", "clear all", "archive all", "discard"],
  account: ["save changes", "update", "enable", "disable", "turn off", "turn on"],
  send: ["reply", "reply all", "respond", "forward", "email", "message", "comment", "answer"],
  publish: ["share", "quote", "save", "done", "schedule"],
  submit: ["confirm", "finish", "accept", "apply", "register", "sign up", "create account", "request", "save and continue"],
  upload: [],
};

/** Labels of buttons that are clearly harmless, even on a checkout or settings page. */
export const BENIGN_WORDS = [
  "cancel", "close", "back", "go back", "dismiss", "not now", "no thanks", "maybe later", "skip", "next", "previous", "more",
  "menu", "open", "view", "show", "expand", "collapse", "edit", "filter", "sort", "add", "attach", "insert", "emoji", "gif",
  "copy", "help", "details", "learn more", "see more", "show more", "home", "notifications", "explore", "settings", "profile",
] as const;

/** Buttons that confirm whatever the dialog they are in asks ("Delete this post?" [Yes]). */
export const CONFIRM_WORDS = ["ok", "okay", "yes", "continue", "proceed", "i understand", "got it"] as const;

/** Page URLs and titles where buttons may pay (checkout) or change the account (settings). */
export const CHECKOUT_CONTEXT = ["checkout", "check out", "payment", "billing", "cart", "basket", "order", "pay", "purchase", "subscribe"] as const;
export const ACCOUNT_CONTEXT = ["settings", "security", "password", "account", "privacy", "two factor", "2fa"] as const;

/** Link targets that act when opened (a GET that deletes or unsubscribes). */
export const ACTING_URL_WORDS = ["delete", "remove", "unsubscribe", "destroy", "deactivate", "cancel subscription"] as const;

/** Fields whose Enter searches, navigates or logs in (harmless). */
export const LOOKUP_FIELD_WORDS = [
  "search", "query", "find", "filter", "address", "url", "location", "city", "zip", "postcode", "where", "username", "user name",
  "email or phone", "phone or email", "password", "code", "otp", "verification", "login", "log in", "sign in",
] as const;
/** Fields whose Enter may send what was written (chats send on Enter). */
export const MESSAGE_FIELD_WORDS = [
  "message", "reply", "comment", "post", "tweet", "chat", "write", "compose", "what is happening", "whats happening", "body",
  "text", "caption", "status", "note",
] as const;
/** Keys that only move around or close things. */
export const HARMLESS_KEYS = [
  "tab", "escape", "esc", "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown", "home", "end", "shift+tab",
] as const;

/** Social sites where a sent message is public: Enter or a send button there publishes. */
const SOCIAL_HOSTS = ["x.com", "twitter.com", "facebook.com", "linkedin.com", "instagram.com", "threads.net", "reddit.com", "bsky.app", "mastodon"];

// ------------------------------------------------------------------ text helpers

/** Lower-case words: "tweetButtonInline" -> "tweet button inline", "Send ‪(Ctrl-Enter)‬" -> "send ctrl enter". */
export function words(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether `text` (already words()) contains one of the phrases as whole words. */
export function hasPhrase(text: string, phrases: readonly string[]): string | null {
  if (!text) return null;
  const padded = ` ${text} `;
  for (const p of phrases) if (padded.includes(` ${p} `)) return p;
  return null;
}

/** What identifies an element to a person: its label, visible text, test id and (inputs) value. */
export function labelOf(el: ElementInfo): string {
  const parts = [el.name, el.text, el.testId];
  // A submit input's label is its value.
  if (el.tag === "input" && (el.type === "submit" || el.type === "button")) parts.push(el.value);
  return words(parts.filter(Boolean).join(" "));
}

/** The site of a URL without "www.": "x.com"; "" when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const isSocial = (url: string) => {
  const host = hostOf(url);
  return SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`) || host.includes(s));
};

/** The page's URL (path and host) and title as words. */
function pageWords(page: GateAction["page"]): string {
  let path = page.url;
  try {
    const u = new URL(page.url);
    path = `${u.host} ${u.pathname} ${u.search}`;
  } catch {
    /* not a URL: its words as they are */
  }
  return words(`${path} ${page.title}`);
}

const CONTROL_ROLES = new Set(["textbox", "searchbox", "combobox", "option", "listbox", "tab", "slider", "spinbutton", "tablist", "treeitem"]);
const TOGGLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

// ------------------------------------------------------------------ the rules

/** The rule-based verdict on one action. */
export function classifyByRules(a: GateAction): Verdict {
  switch (a.method) {
    case "type":
    case "paste":
      return { verdict: "benign", reason: "typing only fills a field" };
    case "closeTabs":
      return { verdict: "benign", reason: "closes tabs the agent opened" };
    // switch_x_account choosing the job's own account in X's account menu (only ever a "Switch to" entry of an account
    // signed in in this browser, never a delegate's "Act as"): it changes which account X shows, no setting, and posts
    // nothing; what then publishes is judged by itself, naming the account it publishes as.
    case "switchXAccount":
      return { verdict: "benign", reason: "switches X to another of your accounts signed in in this browser; changes no setting" };
    case "upload":
      return { verdict: "consequential", kind: "upload", reason: "sends a file from your computer to the site" };
    case "navigate":
    case "openTabs":
      return classifyUrls(a.urls ?? []);
    case "pressKey":
      return classifyKey(a);
    case "click":
      return classifyClick(a);
    case "handleDialog":
      return classifyDialogAnswer(a);
  }
}

/** Why leaving a page is held: "Leave site?" is Chrome's only warning that its changes are not saved. */
export const LEAVE_PAGE_WHY = "the page's unsaved changes are lost";

/**
 * Answering a page's dialog. Cancel changes nothing, nor does the OK of an alert. Leave on "Leave site?" throws away
 * what the page did not save, which the rules cannot see (so it always asks, see LEAVE_PAGE_WHY). OK on a confirm
 * or prompt does what the page asks, judged by the dialog's words like a button's.
 */
function classifyDialogAnswer(a: GateAction): Verdict {
  const d = a.dialog;
  if (!a.accept || !d) return { verdict: "benign", reason: "cancels: the page stays as it was" };
  if (d.type === "alert") return { verdict: "benign", reason: "closes the page's message" };
  if (d.type === "beforeunload") return { verdict: "unsure", reason: LEAVE_PAGE_WHY };
  const said = words(d.message);
  for (const kind of KIND_ORDER) {
    const hit = hasPhrase(said, STRONG_WORDS[kind]);
    if (hit) return { verdict: "consequential", kind: publicSend(kind, d.url), reason: `the dialog says "${hit}"` };
  }
  for (const kind of KIND_ORDER) {
    const hit = hasPhrase(said, WEAK_WORDS[kind]);
    if (hit) return { verdict: "unsure", kind: publicSend(kind, d.url), reason: `the dialog says "${hit}"` };
  }
  return { verdict: "unsure", reason: "does what the page asks (the rules cannot tell what)" };
}

function classifyUrls(urls: readonly string[]): Verdict {
  for (const url of urls) {
    const hit = hasPhrase(words(url.replace(/^https?:\/\/[^/]+/, "")), ACTING_URL_WORDS);
    if (hit) return { verdict: "consequential", kind: hit === "unsubscribe" || hit === "deactivate" ? "account" : "delete", reason: `the address says "${hit}"` };
  }
  return { verdict: "benign", reason: "opens a page" };
}

function classifyKey(a: GateAction): Verdict {
  const key = (a.key ?? "").trim().toLowerCase();
  if ((HARMLESS_KEYS as readonly string[]).includes(key)) return { verdict: "benign", reason: "moves around the page" };
  const parts = key.split("+");
  const base = parts.at(-1) ?? "";
  const modified = parts.length > 1;
  const field = a.typed.at(-1)?.element;
  const fieldWords = field ? words(`${field.name} ${field.testId ?? ""} ${field.type ?? ""} ${field.role}`) : "";
  const lookup = field && (field.role === "searchbox" || ["search", "url", "password", "email"].includes(field.type ?? "") || hasPhrase(fieldWords, LOOKUP_FIELD_WORDS));
  if (base === "enter") {
    if (lookup) return { verdict: "benign", reason: `Enter in "${field!.name || field!.role}" searches or logs in` };
    const kind: ConsequenceKind = isSocial(a.page.url) ? "publish" : "send";
    // Ctrl+Enter / Cmd+Enter sends in mail, chat and social composers.
    if (modified) return { verdict: "consequential", kind, reason: `${a.key} sends what was written` };
    if (field && hasPhrase(fieldWords, MESSAGE_FIELD_WORDS)) return { verdict: "consequential", kind, reason: `Enter in "${field.name || field.role}" may send it` };
    return { verdict: "unsure", kind: "submit", reason: "Enter may submit the form" };
  }
  if (!field && (base === "delete" || base === "backspace")) return { verdict: "unsure", kind: "delete", reason: `${a.key} outside a field may delete` };
  // A single key outside a field can be a site shortcut ("#" deletes in Gmail, "r" replies).
  if (!field && base.length === 1) return { verdict: "unsure", reason: `"${a.key}" outside a field may be a site shortcut` };
  return { verdict: "benign", reason: "a key in a field" };
}

function classifyClick(a: GateAction): Verdict {
  const el = a.element;
  if (!el) return { verdict: "unsure", reason: "the element is not in the last page read" };
  // Never "disabled, so harmless": the state is from the last read, and typing enables a Post button without a new read.
  const label = labelOf(el);
  const quoted = `"${el.name || el.text || el.testId || el.role}"`;
  const page = pageWords(a.page);
  const role = (el.role || el.tag).toLowerCase();

  if (CONTROL_ROLES.has(role) || (el.tag === "input" && !["submit", "button", "image", "checkbox", "radio"].includes(el.type ?? "text"))) {
    return { verdict: "benign", reason: `${quoted} is a field or a choice` };
  }
  if (TOGGLE_ROLES.has(role) || el.type === "checkbox" || el.type === "radio") {
    // A switch on a settings page usually saves at once.
    if (hasPhrase(page, ACCOUNT_CONTEXT) && (role === "switch" || el.checked !== undefined)) {
      return { verdict: "unsure", kind: "account", reason: `${quoted} on a settings page may save at once` };
    }
    return { verdict: "benign", reason: `${quoted} is a checkbox or choice` };
  }
  if (hasPhrase(label, BENIGN_PHRASES)) return { verdict: "benign", reason: `${quoted} opens or starts something` };

  // A link opens a page: only a link whose target acts (delete, unsubscribe) is consequential.
  if (role === "link" || (el.tag === "a" && el.href)) {
    const acting = classifyUrls(el.href ? [el.href] : []);
    if (acting.verdict === "consequential") return acting;
    const hit = hasPhrase(label, [...STRONG_WORDS.delete, ...STRONG_WORDS.account]);
    return hit ? { verdict: "unsure", kind: "delete", reason: `the link ${quoted} says "${hit}"` } : { verdict: "benign", reason: `the link ${quoted} opens a page` };
  }

  for (const kind of KIND_ORDER) {
    const hit = hasPhrase(label, STRONG_WORDS[kind]);
    if (hit) return { verdict: "consequential", kind, reason: `${quoted} says "${hit}"` };
  }
  for (const kind of KIND_ORDER) {
    const hit = hasPhrase(label, WEAK_WORDS[kind]);
    if (!hit) continue;
    // The page settles it: "Subscribe" on a checkout page pays, "Save" on a settings page changes the account.
    if (kind === "pay" && hasPhrase(page, CHECKOUT_CONTEXT)) return { verdict: "consequential", kind, reason: `${quoted} on a payment page` };
    if (kind === "account" && hasPhrase(page, ACCOUNT_CONTEXT)) return { verdict: "consequential", kind, reason: `${quoted} on a settings page` };
    return { verdict: "unsure", kind: publicSend(kind, a.page.url), reason: `${quoted} ("${hit}") may be consequential` };
  }
  const confirms = hasPhrase(label, CONFIRM_WORDS);
  if (confirms && el.inDialog) return { verdict: "unsure", kind: "submit", reason: `${quoted} confirms what the dialog asks` };
  if (hasPhrase(label, BENIGN_WORDS)) return { verdict: "benign", reason: `${quoted} only moves around` };
  if (hasPhrase(page, CHECKOUT_CONTEXT)) return { verdict: "unsure", kind: "pay", reason: `${quoted} on a payment page` };
  if (hasPhrase(page, ACCOUNT_CONTEXT) && /save|apply|update/.test(label)) return { verdict: "consequential", kind: "account", reason: `${quoted} on a settings page` };
  return { verdict: "benign", reason: `${quoted} has no consequential word` };
}

/** Checked in this order: money first, then what cannot be undone, then what others see. */
const KIND_ORDER: readonly ConsequenceKind[] = ["pay", "delete", "account", "send", "publish", "submit"];

/** A reply or comment on a social site is public: it publishes. */
function publicSend(kind: ConsequenceKind, url: string): ConsequenceKind {
  return kind === "send" && isSocial(url) ? "publish" : kind;
}
