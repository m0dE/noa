/**
 * Jev as the fast second opinion for actions the rules are unsure about
 * (consequence.ts): one systemOne request with a choice question "what does
 * this action do when it runs", answered with a kind of consequence or
 * "none", and a confidence. For scheduled runs it can also be asked whether
 * the task's instructions ask for the action. Jev only sees the action, the
 * element, the page's address and title, the start of its text and the text
 * the agent typed (clipped); never a password.
 */
import type { ConsequenceKind, ElementInfo } from "@noa/shared";
import type { GateAction } from "./consequence.js";

/** A systemOne client: TypeSafe's endpoint, or the account server's Jev proxy (core's proxyJevClient). */
export interface SystemOneLike {
  systemOne(
    request: { state: unknown; questions: Record<string, unknown>; model?: string },
    options?: { timeout?: number },
  ): PromiseLike<{ answers: Record<string, unknown> }>;
}

/** A judgement slower than this is dropped (the gate asks the user instead). */
export const JUDGE_TIMEOUT_MS = 8000;
/** Characters of the page's text and of typed text Jev sees. */
const PAGE_TEXT_CHARS = 800;
const TYPED_TEXT_CHARS = 300;

export const CONSEQUENCE_CRITERIA: Record<ConsequenceKind | "none", string> = {
  publish: "It publishes something other people can see: a post, reply, comment, repost, like or follow.",
  send: "It sends a message or an email to someone.",
  pay: "It pays, buys, places an order, starts a paid subscription or moves money.",
  delete: "It deletes or removes something that is hard to get back (not an item in a shopping cart).",
  submit: "It submits a form that commits the user: signs, agrees to terms, applies, books, creates an account or confirms something.",
  account: "It changes account or security settings: password, two-factor, email address, access, unsubscribing.",
  upload: "It sends a file from the user's computer to the site.",
  none: "None of these: it only opens or shows something (a page, a menu, a reply or compose box, a draft, the next step of a form), selects, types into a field, or cancels. Nothing is sent, published, paid or deleted by this action itself.",
};

export interface JevJudgement {
  /** The consequence Jev sees; null: none. */
  kind: ConsequenceKind | null;
  confidence: number;
  /** Asked only with instructions: whether they ask for the action. */
  within?: { yes: boolean; confidence: number };
}

/** The action in words for Jev: "click the button "Post" (testid tweetButtonInline, in the open dialog)". */
export function describeForJev(a: GateAction): string {
  switch (a.method) {
    case "click":
      return `click ${a.element ? describeElement(a.element) : "an element that is not known"}${a.checked === undefined ? "" : ` (to set it ${a.checked ? "on" : "off"})`}`;
    case "type":
      return `type into ${a.element ? describeElement(a.element) : "a field"}`;
    case "paste":
      return "paste text into the focused field";
    case "pressKey": {
      const field = a.typed.at(-1)?.element;
      return `press ${a.key ?? "a key"}${field ? ` in ${describeElement(field)}, just typed into` : ""}`;
    }
    case "upload":
      return `upload ${a.paths?.length ?? 0} file(s) with ${a.element ? describeElement(a.element) : "a file input"}`;
    case "navigate":
    case "openTabs":
      return `open ${(a.urls ?? []).join(", ")}`;
    case "closeTabs":
      return `close the agent's tabs ${(a.tabs ?? []).join(", ")}`;
    case "switchXAccount":
      return `switch X to the signed-in account ${a.handle ?? ""} in its account menu`;
    case "handleDialog":
      return `answer the page's ${a.dialog?.type ?? "browser"} dialog${a.dialog ? ` ${JSON.stringify(a.dialog.message)}` : ""} with ${a.accept ? "OK" : "Cancel"}`;
  }
}

function describeElement(e: ElementInfo): string {
  const parts = [`the ${e.role || e.tag} "${e.name}"`];
  if (e.text && e.text !== e.name) parts.push(`showing "${e.text}"`);
  if (e.testId) parts.push(`testid ${e.testId}`);
  if (e.type) parts.push(`type=${e.type}`);
  if (e.href) parts.push(`linking to ${e.href.slice(0, 120)}`);
  if (e.inDialog) parts.push("in the open dialog");
  return parts.join(", ");
}

/** What was typed, for context; a password field's text is never included. */
function typedText(a: GateAction): string {
  return a.typed
    .filter((t) => t.element.type !== "password")
    .map((t) => `${t.element.name || t.element.role}: ${t.text.slice(0, TYPED_TEXT_CHARS)}`)
    .join("\n");
}

export function buildJudgeRequest(a: GateAction, pageText: string, instructions?: string) {
  const state: Record<string, string> = {
    action: describeForJev(a),
    url: a.page.url,
    title: a.page.title,
    pageText: pageText.slice(0, PAGE_TEXT_CHARS),
  };
  const typed = typedText(a);
  if (typed) state.typedBefore = typed;
  if (instructions) state.taskInstructions = instructions.slice(0, 1000);
  const questions: Record<string, unknown> = {
    consequence: {
      type: "choice",
      instructions:
        "A browser agent is about to take this action for its user. What does this one action do when it runs? Judge only its direct effect: a button that opens a reply or compose box is 'none'; the button that sends or posts what was typed is the consequence.",
      criteria: CONSEQUENCE_CRITERIA,
    },
  };
  if (instructions) {
    questions.within = {
      type: "choice",
      instructions: "The agent runs a scheduled task with the instructions in taskInstructions. Do those instructions ask for this action (or clearly need it to be done)?",
      criteria: {
        yes: "Yes: the instructions ask for this action or clearly need it.",
        no: "No: the instructions do not ask for this action, only mention it, or forbid it.",
      },
    };
  }
  return { state, questions };
}

const KINDS = Object.keys(CONSEQUENCE_CRITERIA) as (ConsequenceKind | "none")[];

export function parseJudgeAnswers(answers: Record<string, unknown>): JevJudgement {
  const c = answers.consequence as { choice?: unknown; confidence?: unknown } | undefined;
  const choice = typeof c?.choice === "string" && (KINDS as string[]).includes(c.choice) ? (c.choice as ConsequenceKind | "none") : undefined;
  // An answer that is not one of the choices counts as a consequence nobody is sure about.
  const out: JevJudgement = {
    kind: choice === "none" ? null : (choice ?? "submit"),
    confidence: choice && typeof c?.confidence === "number" ? c.confidence : 0,
  };
  const w = answers.within as { choice?: unknown; confidence?: unknown } | undefined;
  if (w && (w.choice === "yes" || w.choice === "no")) out.within = { yes: w.choice === "yes", confidence: typeof w.confidence === "number" ? w.confidence : 0 };
  return out;
}

/** Asks Jev about one action. Throws when Jev fails or is slower than JUDGE_TIMEOUT_MS. */
export async function judgeWithJev(client: SystemOneLike, a: GateAction, pageText: string, instructions?: string): Promise<JevJudgement> {
  const res = await client.systemOne(buildJudgeRequest(a, pageText, instructions), { timeout: JUDGE_TIMEOUT_MS });
  return parseJudgeAnswers(res.answers);
}
