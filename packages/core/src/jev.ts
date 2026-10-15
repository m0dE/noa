/**
 * Jev grounding for act steps: given a plain-language goal and the page's
 * element list, Jev picks one operation and one target element. Jev never
 * supplies text; typing text always comes from Claude.
 */
import { TypeSafeClient, type EntryType, type Logger } from "@typesafe-ai/sdk";
import type { PageSnapshot } from "@noa/shared";
import { errorDetail, outOfCreditError, OutOfCreditError, parseJsonBody } from "./api-errors.js";
import type { JevDecision, JevLike, JevOperation, JevPause } from "./types.js";

export const JEV_OPERATIONS: readonly JevOperation[] = ["click", "type", "scroll", "press_key", "wait", "done", "blocked"];
export const JEV_MAX_ELEMENTS = 250;
/**
 * Input tokens a Jev request may use. TypeSafe answers 400 max_tokens_exceeded
 * past about 32k; measured (jev-1.13.0, 2026-10): about 121 tokens per element
 * plus 0.165 per byte of the request, so a dense page (a dashboard's 240
 * elements with links) failed every pick. The rest is margin for the estimate; text that takes more tokens per
 * character (Japanese, Korean) can still go over, and is sent again with half (see jevFromClient).
 */
export const JEV_TOKEN_BUDGET = 28_000;
const JEV_TOKENS_PER_ELEMENT = 121;
const JEV_TOKENS_PER_BYTE = 0.165;
/** Bytes of a request besides its elements: the questions' instructions and criteria, and JSON framing. */
const JEV_FIXED_BYTES = 2_500;
/** Longest a Jev request may take (the TypeSafe SDK's and the proxy's timeout); an act step gives up sooner (JEV_DEADLINE_MS). */
export const JEV_TIMEOUT_MS = 15_000;
/**
 * How long an act step waits for Jev's answer (to each request: a smaller try after max_tokens_exceeded has its own,
 * see jevFromClient); past it the step is left to the model, as when Jev is unsure (its
 * candidates). Cloud Jev in production (/v1/ai/jev wall time, Workers Observability, 2026-10-06 to 10-13,
 * test/e2e/jev-latency-prod.mjs): the 52 answers outside the 10-13 00:40 slow spell took at most 1.95 s (p50 0.47 s,
 * p99 1.33 s), and all 11 in that spell 5.1 to 13.3 s. 3 s is 1.5 times the slowest normal answer and well short of
 * the slow ones. A step past it costs 3 s and a model turn instead of the 5 to 13 s wait (test/e2e/jev-latency-live.mjs).
 */
export const JEV_DEADLINE_MS = 3_000;
/** Answers past the deadline in a row after which a run stops asking Jev (one late answer can be chance; the slow spell was 11 in a row). */
export const JEV_SLOW_LIMIT = 2;
/**
 * How long a run then leaves every step to the model without asking Jev. After it, the next step asks Jev again:
 * an answer in time ends the skipping, a late one starts another JEV_SKIP_MS. The slow spell lasted 2.7 minutes
 * (00:40:13 to 00:42:56; the next answer, at 00:43:02, took 0.46 s), so a run caught in all of it pays 2 deadlines,
 * then about 2 more (one a minute), instead of the spell's 103 s of waits.
 */
export const JEV_SKIP_MS = 60_000;

/** Jev did not answer an act step in time (JEV_DEADLINE_MS), or was not asked because it was slow just before. */
export class JevSlowError extends Error {
  constructor(
    message: string,
    /** True: not asked at all (it was slow on the steps before); false: asked, and the deadline passed. */
    readonly skipped: boolean,
  ) {
    super(message);
    this.name = "JevSlowError";
  }
}

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
  /** Behind an open modal dialog, which covers it (ElementInfo.covered). */
  covered?: true;
  /** When several elements share role and name: "2 of 5" in page order (so "the second Reply button" can be matched). */
  occurrence?: string;
}

export interface JevState {
  goal: string;
  /** The step types text (Claude gives it); Jev only picks where. */
  typesText: boolean;
  /** The step's text is empty: it empties the field Jev picks. */
  emptiesField?: true;
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
  emptiesField?: boolean;
  previousStep?: string;
}

/**
 * Trimmed state for Jev: at most `max` elements, and no more than fit in `budget` tokens; those in an open dialog
 * first, then in-viewport ones, then the rest, then those a modal dialog covers (each part in page order).
 */
export function buildJevState(goal: string, snapshot: PageSnapshot, max = JEV_MAX_ELEMENTS, step: JevStepInfo = {}, budget = JEV_TOKEN_BUDGET): JevState {
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
  // An open dialog covers the page: its elements first, then the rest in view, then offscreen ones, then those a modal
  // dialog covers. These stay, marked, so a goal that names one is matched to it (and its click says the dialog is in
  // the way) rather than to a look-alike in the dialog.
  const usable = snapshot.elements.filter((e) => !e.covered);
  const dialog = usable.filter((e) => e.inDialog);
  const visible = usable.filter((e) => e.inViewport && !e.inDialog);
  const hidden = usable.filter((e) => !e.inViewport && !e.inDialog);
  const covered = snapshot.elements.filter((e) => e.covered);
  const chosen = [...dialog, ...visible, ...hidden, ...covered].slice(0, max);
  const state: JevState = {
    goal,
    typesText: step.typesText === true,
    url: snapshot.url,
    title: snapshot.title,
    pageText: snapshot.text.slice(0, JEV_PAGE_TEXT),
    elements: [],
  };
  if (step.typesText && step.emptiesField) state.emptiesField = true;
  if (step.previousStep) state.previousStep = step.previousStep;
  // Each element is sent twice: in the state and as its target option.
  let tokens = (JSON.stringify(state).length + JEV_FIXED_BYTES) * JEV_TOKENS_PER_BYTE;
  for (const e of chosen) {
    const el = jevElement(e, snapshot.url, occurrence.get(e.index));
    tokens += JEV_TOKENS_PER_ELEMENT + (JSON.stringify(el).length + describeJevElement(el).length) * JEV_TOKENS_PER_BYTE;
    if (tokens > budget) break;
    state.elements.push(el);
  }
  return state;
}

function jevElement(e: PageSnapshot["elements"][number], pageUrl: string, occ: string | undefined): JevElement {
  const out: JevElement = { index: e.index, role: e.role || e.tag, name: e.name.slice(0, 120), tag: e.tag, inViewport: e.inViewport };
  if (e.text && e.text !== e.name) out.text = e.text.slice(0, 80);
  if (e.type) out.type = e.type;
  if (e.testId) out.testId = e.testId;
  if (e.href) out.href = shortHref(e.href, pageUrl);
  if (e.value) out.value = e.value.slice(0, 60);
  if (e.options?.length) out.options = e.options.join(", ").slice(0, 200);
  if (e.disabled) out.disabled = true;
  if (e.inDialog) out.inDialog = true;
  if (e.covered) out.covered = true;
  if (occ) out.occurrence = occ;
  return out;
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
  if (e.covered) parts.push("behind the open dialog (covered by it)");
  parts.push(e.inViewport ? "in view" : "offscreen");
  return parts.join(", ");
}

const OPERATION_CRITERIA: Record<JevOperation, string> = {
  click: "Click one element (button, link, tab, menu item, checkbox, radio button) to do the goal.",
  // A custom dropdown is often a button (browser.type opens its list and clicks the option). With dropdowns named as
  // "(select, combobox)" only, choosing an option of one drew 0.07 to 0.32 to blocked, and 18 of 25 picks fell below
  // the 0.8 threshold (5 goals on 2 custom dropdowns, the element 0.87 to 1.00); with the button named, blocked drew
  // 0.01 to 0.11 and 5 of 25 fell below. Native selects, text fields, buttons, links and absent elements were unchanged.
  type: "Type the step's text into one input, text box or editable element (an empty text empties it), or choose it as the option of a dropdown: a select, a combobox, or a button that opens a list of options.",
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
  // act types (or chooses a dropdown's option) for a step with text and clicks for any other, whatever Jev answers, so
  // only that one of the two is offered: a choice between them would split Jev's confidence over a difference act
  // ignores (measured on "select the State dropdown": type 0.6 to click 0.35, below the threshold, the element 1.00).
  const operations: Partial<Record<JevOperation, string>> = { ...OPERATION_CRITERIA };
  delete operations[state.typesText ? "click" : "type"];
  // Jev is not given a typing step's text, so it cannot see whether that text is already there: a typing step is not
  // offered "done". Offered as is, done drew 0.15 to 0.48 for a field that held another value (57 of 60 such steps
  // below the 0.8 threshold). Offered as "Never for this step: ...", it still drew 0.05 to 0.15 on dropdown steps, and
  // 0.12 to 0.18 when the option was the criterion's own first word: "set Email notifications to Never" on a closed
  // custom dropdown, 0/5 at the threshold (0.69 to 0.76); worded without "Never", done kept 0.04 to 0.11 (0.76 to 0.83).
  // Not offered: 0.85 to 0.89, and 192 of 210 probes of custom dropdowns whose option is a criterion word reached the
  // threshold instead of 160 (3 pages, "set/change/make X to Y"); text fields, native selects, buttons, links and
  // absent elements unchanged.
  if (state.typesText) delete operations.done;
  return {
    operation: {
      type: "choice" as const,
      instructions: state.emptiesField
        ? "The goal is one step of a browser task, and this step empties a field: its text is empty, so the field it is typed into ends up with no text. Which single operation does it need on this page?"
        : state.typesText
          ? "The goal is one step of a browser task, and this step types text (given separately). Which single operation does it need on this page?"
          : "The goal is one step of a browser task. Which single operation best does it on this page?",
      criteria: operations,
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

export interface JevFromClientOptions {
  model?: string;
  /** Default JEV_DEADLINE_MS. */
  deadlineMs?: number;
  /** Default JEV_SLOW_LIMIT. */
  slowLimit?: number;
  /** Default JEV_SKIP_MS. */
  skipMs?: number;
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * A JevLike over any systemOne-capable client. Each request to Jev has JEV_DEADLINE_MS: past it the request is
 * dropped and decide throws JevSlowError. A request refused as too long (max_tokens_exceeded) is sent again with
 * half the elements, and that try has its own JEV_DEADLINE_MS: the refusal is an answer in time, so a page that
 * needs smaller tries (Japanese or Korean text) is not taken for a slow Jev. After JEV_SLOW_LIMIT late answers in a row, this
 * JevLike (one per run) throws JevSlowError at once for JEV_SKIP_MS, then asks Jev again. It is paused (paused())
 * from the start of that skip until Jev answers in time again.
 */
export function jevFromClient(client: JevClientLike, opts: JevFromClientOptions = {}): JevLike {
  const deadlineMs = opts.deadlineMs ?? JEV_DEADLINE_MS;
  const slowLimit = opts.slowLimit ?? JEV_SLOW_LIMIT;
  const skipMs = opts.skipMs ?? JEV_SKIP_MS;
  let lateInARow = 0;
  let skipUntil = 0;
  /** Skipped since JEV_SLOW_LIMIT late answers in a row, and not answered in time since. */
  let pausedNow = false;
  return {
    paused() {
      return pausedNow ? { why: `it was slower than ${seconds(deadlineMs)} on ${slowLimit} steps in a row`, retry: performance.now() >= skipUntil } : null;
    },
    async decide({ goal, snapshot, typesText, emptiesField, previousStep }) {
      if (performance.now() < skipUntil) {
        throw new JevSlowError(`Jev was slower than ${seconds(deadlineMs)} on ${lateInARow} steps in a row, so it is not asked for ${seconds(skipUntil - performance.now())}`, true);
      }
      const step: JevStepInfo = {};
      if (typesText !== undefined) step.typesText = typesText;
      if (emptiesField !== undefined) step.emptiesField = emptiesField;
      if (previousStep !== undefined) step.previousStep = previousStep;
      try {
        for (let budget = JEV_TOKEN_BUDGET; ; budget /= 2) {
          const state = buildJevState(goal, snapshot, JEV_MAX_ELEMENTS, step, budget);
          const request: JevRequest = { state, questions: buildJevQuestions(state) };
          if (opts.model) request.model = opts.model;
          // At the try's deadline its request is aborted, and the decision fails even when the client does not stop at the abort.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new JevSlowError(`Jev did not answer within ${seconds(deadlineMs)}`, false)), deadlineMs);
          const lateAnswer = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason)));
          lateAnswer.catch(() => {});
          try {
            const res = await Promise.race([client.systemOne(request, { signal: controller.signal, timeout: JEV_TIMEOUT_MS }), lateAnswer]);
            lateInARow = 0;
            pausedNow = false;
            return parseJevAnswers(res.answers);
          } catch (err) {
            if (controller.signal.aborted) throw controller.signal.reason;
            // Still too long for TypeSafe: again with half the budget (at most three tries).
            if (!(err instanceof Error && err.message.includes("max_tokens_exceeded")) || budget <= JEV_TOKEN_BUDGET / 4) throw err;
          } finally {
            clearTimeout(timer);
          }
        }
      } catch (err) {
        if (err instanceof JevSlowError && ++lateInARow >= slowLimit) {
          skipUntil = performance.now() + skipMs;
          pausedNow = true;
        }
        throw err;
      }
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

/**
 * Noa's cloud Jev for a run whose AI is not Noa AI (local Claude Code, the Claude API): an empty
 * usage credit must not pause that run, as it does Noa AI's (the AI itself is not billed). The first
 * refusal turns it off for the run instead (paused, for good): act then takes element indices, as with Jev off.
 */
export function withoutCreditPause(jev: JevLike): JevLike {
  let noCredit: string | null = null;
  return {
    paused(): JevPause | null {
      return noCredit ? { why: noCredit, retry: false } : (jev.paused?.() ?? null);
    },
    async decide(input) {
      if (noCredit) throw new Error(noCredit);
      try {
        return await jev.decide(input);
      } catch (err) {
        if (!(err instanceof OutOfCreditError)) throw err;
        noCredit = `Noa's cloud Jev: ${err.message}`;
        throw new Error(noCredit);
      }
    },
  };
}
