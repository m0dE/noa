/**
 * Jev grounding for act steps: given a plain-language goal and the page's
 * element list, Jev picks one operation and one target element. Jev never
 * supplies text; typing text always comes from Claude.
 */
import { TypeSafeClient, type EntryType, type Logger } from "@typesafe-ai/sdk";
import type { PageSnapshot } from "@noa/shared";
import { errorDetail, outOfCreditError, parseJsonBody } from "./api-errors.js";
import type { JevDecision, JevLike, JevOperation } from "./types.js";

export const JEV_OPERATIONS: readonly JevOperation[] = ["click", "type", "scroll", "press_key", "wait", "done", "blocked"];
export const JEV_MAX_ELEMENTS = 250;
export const JEV_TIMEOUT_MS = 15_000;

/** One systemOne request: the step's state and the two questions Jev answers. */
export interface JevRequest {
  state: JevState;
  questions: JevQuestions;
  model?: string;
}

/** The subset of TypeSafeClient that Jev uses, so tests can fake it. */
export interface JevClientLike {
  systemOne(request: JevRequest, options?: { signal?: AbortSignal; timeout?: number }): PromiseLike<{ answers: Record<string, unknown> }>;
}

export interface JevElement {
  index: number;
  role: string;
  name: string;
  tag: string;
  text?: string;
  type?: string;
  testId?: string;
  href?: string;
  value?: string;
  /** A dropdown's option labels (clipped), so "select United Kingdom" matches the dropdown that offers it. */
  options?: string;
  disabled?: true;
  inViewport: boolean;
  /** Inside an open dialog (compose box, reply box, menu). */
  inDialog?: true;
  /** When several elements share role and name: "2 of 5" in page order (so "the second Reply button" can be matched). */
  occurrence?: string;
}

export interface JevState {
  goal: string;
  /** The step types text (Claude gives it); Jev only picks where. */
  typesText: boolean;
  /** What happened in the step before this one, in the same act call. */
  previousStep?: string;
  url: string;
  title: string;
  /** Start of the page's visible text, for context. */
  pageText: string;
  elements: JevElement[];
}

/** Characters of visible page text given to Jev for context. */
export const JEV_PAGE_TEXT = 1200;

/** Short form of a link target: path and query for same-site links. */
function shortHref(href: string, pageUrl: string): string {
  try {
    const u = new URL(href, pageUrl);
    const base = new URL(pageUrl);
    const out = u.host === base.host ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}`;
    return out.slice(0, 100);
  } catch {
    return href.slice(0, 100);
  }
}

export interface JevStepInfo {
  typesText?: boolean;
  previousStep?: string;
}

/** Trimmed state for Jev: at most `max` elements; those in an open dialog first, then in-viewport ones, then the rest (each part in page order). */
export function buildJevState(goal: string, snapshot: PageSnapshot, max = JEV_MAX_ELEMENTS, step: JevStepInfo = {}): JevState {
  // Occurrence among elements with the same role and name, in page order.
  const keyOf = (e: PageSnapshot["elements"][number]) => `${e.role}\u0000${e.name}`;
  const totals = new Map<string, number>();
  for (const e of snapshot.elements) totals.set(keyOf(e), (totals.get(keyOf(e)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const occurrence = new Map<number, string>();
  for (const e of snapshot.elements) {
    const k = keyOf(e);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    const total = totals.get(k)!;
    if (total > 1) occurrence.set(e.index, `${n} of ${total}`);
  }
  // An open dialog covers the page: its elements first, then the rest in view, then offscreen ones.
  const dialog = snapshot.elements.filter((e) => e.inDialog);
  const visible = snapshot.elements.filter((e) => e.inViewport && !e.inDialog);
  const hidden = snapshot.elements.filter((e) => !e.inViewport && !e.inDialog);
  const chosen = [...dialog, ...visible, ...hidden].slice(0, max);
  const state: JevState = {
    goal,
    typesText: step.typesText === true,
    url: snapshot.url,
    title: snapshot.title,
    pageText: snapshot.text.slice(0, JEV_PAGE_TEXT),
    elements: chosen.map((e) => {
      const out: JevElement = { index: e.index, role: e.role || e.tag, name: e.name.slice(0, 120), tag: e.tag, inViewport: e.inViewport };
      if (e.text && e.text !== e.name) out.text = e.text.slice(0, 80);
      if (e.type) out.type = e.type;
      if (e.testId) out.testId = e.testId;
      if (e.href) out.href = shortHref(e.href, snapshot.url);
      if (e.value) out.value = e.value.slice(0, 60);
      if (e.options?.length) out.options = e.options.join(", ").slice(0, 200);
      if (e.disabled) out.disabled = true;
      if (e.inDialog) out.inDialog = true;
      const occ = occurrence.get(e.index);
      if (occ) out.occurrence = occ;
      return out;
    }),
  };
  if (step.previousStep) state.previousStep = step.previousStep;
  return state;
}

/** One-line summary of an element: the description of its option in the target question. */
export function describeJevElement(e: JevElement): string {
  const parts = [`${e.role} "${e.name}"`];
  if (e.occurrence) parts.push(`${e.occurrence} with this label`);
  if (e.text) parts.push(`shows "${e.text}"`);
  if (e.type) parts.push(`type=${e.type}`);
  if (e.testId) parts.push(`testid=${e.testId}`);
  if (e.href) parts.push(`links to ${e.href}`);
  if (e.value) parts.push(`value "${e.value}"`);
  if (e.options) parts.push(`options: ${e.options}`);
  if (e.disabled) parts.push("disabled");
  if (e.inDialog) parts.push("in the open dialog");
  parts.push(e.inViewport ? "in view" : "offscreen");
  return parts.join(", ");
}

const OPERATION_CRITERIA: Record<JevOperation, string> = {
  click: "Click one element (button, link, tab, menu item, checkbox, radio button) to do the goal.",
  type: "Type the step's text into one input, text box or editable element, or choose it as the option of a dropdown (select, combobox). Only when the step has text.",
  scroll: "Scroll down: the element the goal needs is not in the list yet.",
  press_key: "Press a key such as Enter or Escape instead of clicking.",
  wait: "Wait: the page is still loading or changing.",
  done: "Nothing to do: the goal is already achieved on this page (e.g. the dialog is already open, the text is already there).",
  blocked: "The goal cannot be done here: login page, captcha, error page, or no element matches the goal.",
};

export type JevQuestions = ReturnType<typeof buildJevQuestions>;

export function buildJevQuestions(state: JevState) {
  // Integer-like keys always enumerate first, so "none" ends up last.
  const targets: Record<string, string> = {};
  for (const e of state.elements) targets[String(e.index)] = describeJevElement(e);
  targets.none = "No element is needed for this operation.";
  return {
    operation: {
      type: "choice" as const,
      instructions: state.typesText
        ? "The goal is one step of a browser task, and this step types text (given separately). Which single operation does it need on this page?"
        : "The goal is one step of a browser task. Which single operation best does it on this page?",
      criteria: OPERATION_CRITERIA,
    },
    target: {
      type: "choice" as const,
      instructions:
        "Which element does the goal describe? Match its visible label and role first, then any position words in the goal (first, second, under the first post) using the page order and the 'n of m with this label' of elements that share a label. Prefer elements in view, and when a dialog is open prefer the elements in the open dialog (the page behind it is covered). Answer none if no element is needed.",
      criteria: targets,
    },
  };
}

/** Turn a systemOne answer into a decision. Unknown operations become blocked. */
export function parseJevAnswers(answers: Record<string, unknown>): JevDecision {
  const op = answers.operation as { choice?: string; confidence?: number } | undefined;
  const target = answers.target as { choice?: string; confidence?: number } | undefined;
  const operation = (JEV_OPERATIONS as readonly string[]).includes(op?.choice ?? "") ? (op!.choice as JevOperation) : "blocked";
  const idx = target && target.choice !== undefined && target.choice !== "none" ? Number(target.choice) : null;
  const index = idx !== null && Number.isInteger(idx) ? idx : null;
  const opConf = typeof op?.confidence === "number" ? op.confidence : 0;
  const targetConf = typeof target?.confidence === "number" ? target.confidence : 0;
  const d: JevDecision = { operation, index, confidence: Math.min(opConf, targetConf) };
  // Element indices from most to least likely, for the candidate list when Jev is unsure.
  const probs = (target as { probabilities?: Record<string, unknown> } | undefined)?.probabilities;
  if (probs && typeof probs === "object") {
    d.ranked = Object.entries(probs)
      .filter(([k, v]) => k !== "none" && typeof v === "number" && Number.isInteger(Number(k)))
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .map(([k]) => Number(k));
  }
  return d;
}

/** A JevLike over any systemOne-capable client. */
export function jevFromClient(client: JevClientLike, opts: { model?: string } = {}): JevLike {
  return {
    async decide({ goal, snapshot, typesText, previousStep }) {
      const step: JevStepInfo = {};
      if (typesText !== undefined) step.typesText = typesText;
      if (previousStep !== undefined) step.previousStep = previousStep;
      const state = buildJevState(goal, snapshot, JEV_MAX_ELEMENTS, step);
      const request: JevRequest = { state, questions: buildJevQuestions(state) };
      if (opts.model) request.model = opts.model;
      const res = await client.systemOne(request, { timeout: JEV_TIMEOUT_MS });
      return parseJevAnswers(res.answers);
    },
  };
}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export interface CreateJevOptions {
  fetch?: typeof fetch;
  model?: string;
  /**
   * Full URL of a systemOne-compatible proxy (the Noa API's
   * `${apiBase}/v1/ai/jev`). The body is `{ state, questions }`, apiKey is
   * sent as a bearer token, and the answer is `{ answers }`. A 402 throws
   * OutOfCreditError. Default: TypeSafe's own endpoint through its SDK.
   */
  endpoint?: string;
  /** Extra headers for `endpoint` requests (e.g. X-Noa-Session). */
  headers?: Record<string, string>;
}

/** systemOne over a plain POST to a proxy endpoint (see CreateJevOptions.endpoint). */
export function proxyJevClient(endpoint: string, apiKey: string, opts: { fetch?: typeof fetch; headers?: Record<string, string> } = {}): JevClientLike {
  const f: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async systemOne(request, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options?.timeout ?? JEV_TIMEOUT_MS);
      const onAbort = () => controller.abort();
      options?.signal?.addEventListener("abort", onAbort);
      try {
        const res = await f(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(opts.headers ?? {}) },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status === 402) throw outOfCreditError(text);
        if (!res.ok) {
          const detail = errorDetail(text, 200);
          throw new Error(`Jev HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
        }
        const answers = (parseJsonBody(text) as { answers?: unknown } | undefined)?.answers;
        if (!answers || typeof answers !== "object") throw new Error("Jev returned no answers");
        return { answers: answers as Record<string, unknown> };
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Jev client over fetch (works in the extension and in Node). */
export function createJev(apiKey: string, opts: CreateJevOptions = {}): JevLike {
  const f = opts.fetch;
  if (opts.endpoint) {
    const proxyOpts: { fetch?: typeof fetch; headers?: Record<string, string> } = {};
    if (f) proxyOpts.fetch = f;
    if (opts.headers) proxyOpts.headers = opts.headers;
    return jevFromClient(proxyJevClient(opts.endpoint, apiKey, proxyOpts), opts.model ? { model: opts.model } : {});
  }
  const client = new TypeSafeClient({
    apiKey,
    dangerouslyAllowBrowser: true,
    logger: quiet,
    logLevel: "off",
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: 1 },
    // Call through a wrapper so a browser fetch is never invoked with a foreign `this`.
    fetch: f ? (input, init) => f(input, init) : (input, init) => globalThis.fetch(input, init),
  });
  // JevState is plain JSON; the SDK types state as EntryType, which an interface with optional fields cannot satisfy.
  const sdk: JevClientLike = { systemOne: (request, options) => client.systemOne({ ...request, state: request.state as unknown as EntryType }, options) };
  const jevOpts: { model?: string } = {};
  if (opts.model) jevOpts.model = opts.model;
  return jevFromClient(sdk, jevOpts);
}
