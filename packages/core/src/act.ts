/**
 * The act tool: up to MAX_ACT_STEPS small steps in one call. A step with text
 * fills a field (or chooses a dropdown's option); an empty text empties the
 * field. A step with checked sets a checkbox or radio button, any other step
 * clicks.
 *
 * Jev off: every step names an element index from read_page and runs directly.
 *
 * Jev on: Jev picks the element of every step from its words. A step may name
 * an index only when Jev was not confident about that same step in the
 * previous act result, and only an index from the candidates listed for it
 * (once). The batch stops at the first step Jev is not sure about and
 * returns candidates for that step only, so the model can pick one.
 *
 * Jev paused (too slow for this run, or out of credit; JevLike.paused): as Jev
 * off. Element lists the model gets have index numbers again and say why, and
 * steps naming an index from them run directly, until a result says Jev is back
 * (listMode).
 */
import { errorMessage, isApprovalRefusal, isCoveredText, isDialogOpenText, isInputBlockedText, stopwatch, traceStart, traceText, type AgentEvent, type BrowserMethod, type BrowserMethods, type ElementInfo, type ElementPicks, type PageSnapshot, type Sleep, type ToolArgsOf, type ToolResult, type TraceDraft } from "@noa/shared";
import { OutOfCreditError } from "./api-errors.js";
import { JevSlowError } from "./jev.js";
import type { JevDecision, JevLike, JevPause } from "./types.js";
import { formatCompact, formatElement, formatNotShown, formatPageChange, formatSnapshot, formatStepEffect, formatTypedValues, formSent, isEditable, notShownValues, NOTHING_CHANGED, UNCONFIRMED_RULE, withoutHash, type TypedValue } from "./page-format.js";
import { untilUserSpeaks, type Interjections } from "./interjections.js";

/** Marker in act results when a step was not executed. */
export const NOT_CONFIDENT = "not confident";
/** Candidates returned for a step Jev was not sure about. */
export const MAX_CANDIDATES = 40;
/**
 * Time the page gets to react after act types into an element (the driver waits longer while requests the typing
 * started are loading: Settle).
 */
export const SETTLE_AFTER_TYPE_MS = 300;
/** Time the page gets to react after act clicks an element. */
export const SETTLE_AFTER_CLICK_MS = 500;
/** How long a step waits when Jev says the page is still loading. */
export const JEV_WAIT_MS = 1000;

type Step = ToolArgsOf<"act">["steps"][number];

/**
 * Per-executor act state: which steps may name an index (Jev mode), and who
 * picked the elements.
 */
export interface ActGate {
  /** Steps Jev was not sure about in the last act result: goal key -> the candidate indices offered. */
  pending: Map<string, Set<number>>;
  picks: ElementPicks;
  /**
   * The last element list the model was given (read_page, navigate, act) had index numbers ("indices": Jev off or
   * paused) or not ("words"); null: none yet. While it is "indices", act steps may name any index (Jev mode too).
   */
  listed: "indices" | "words" | null;
  /** A probe of a paused Jev is waiting for its answer (see runAct): no second one meanwhile. */
  probing?: boolean;
  /** Clicks that ended an act call and changed nothing on the page: element (role, label, page) -> how many times. */
  noEffect?: Map<string, number>;
  /**
   * Values sent this session (by a click or Enter) that the page did not confirm: it did not show them back, or the
   * click changed nothing. A later send of the same field that the page confirms takes it out. task_complete refuses
   * an answer that names one in a sentence not saying it is unconfirmed (see the executor).
   */
  unconfirmed?: Map<string, UnconfirmedValue>;
  /** Values typed (act, paste) since the last send (cleared when a tab navigates). */
  typedSince?: TypedValue[];
  /** Sends whose form the page replaced with a result (formSent): what it showed; held: a resend was held back once. */
  created?: { url: string; shown: string; values: TypedValue[]; held: boolean }[];
}

/** A value the page did not confirm, and why. */
export type UnconfirmedValue = TypedValue & { why: string };

/** One entry per field (a field typed again keeps its last value); pasted text has no field, so its text is its key. */
const valueKey = (t: TypedValue) => t.field || t.text;

/** Typed values, a field typed again counted once with its last value. */
export const latestPerField = (values: TypedValue[]) => [...new Map(values.map((t) => [valueKey(t), t])).values()];

/**
 * A send (a click that ended an act call, or Enter that changed the page): `sent` is what was typed since the last
 * one. Records in the gate which of them the page did not confirm, and starts the next form. Returns those the page
 * does not show now.
 */
export function recordSend(gate: ActGate, sent: TypedValue[], before: PageSnapshot, after: PageSnapshot, nothingChanged: boolean): { missing: TypedValue[]; note: string } {
  const missing = notShownValues(sent, after);
  const map = (gate.unconfirmed ??= new Map());
  for (const t of sent) map.delete(valueKey(t));
  const why = nothingChanged ? "after the step that sent them, nothing on the page changed" : "after they were sent, the page did not show them";
  for (const t of nothingChanged ? sent : missing) map.set(valueKey(t), { ...t, why });
  gate.typedSince = [];
  // The form was taken: something now exists with what was typed, whether or not that was meant yet.
  const shown = nothingChanged ? null : formSent(before, after);
  // Sent, but nothing on the page took it: what was typed is only in the fields.
  const unconfirmedNote =
    nothingChanged && sent.length
      ? `Nothing on the page confirms these values were saved: ${formatTypedValues(sent)}. Until a page shows them saved, they are entered, not confirmed.${missing.length ? "" : ` ${UNCONFIRMED_RULE}`}\n`
      : "";
  if (!shown) return { missing, note: formatNotShown(missing) + unconfirmedNote };
  (gate.created ??= []).push({ url: withoutHash(before.url), shown, values: sent, held: false });
  const what = sent.length ? ` with what was typed: ${formatTypedValues(sent)}` : "";
  const n = gate.created.length;
  return {
    missing,
    note: `${formatNotShown(missing)}This sent the form and the page now shows ${JSON.stringify(shown)}: count it as done: whatever this form makes (an issue, an order, a booking) now exists${what}. Sending the form again would make another one${n > 1 ? ` (this task has now sent it ${n} times)` : ""}; do not, unless the task asks for more than one. Name each one made in your final message.\n`,
  };
}

/**
 * A send on a form that already created something in this task (gate.created): held back once, so a retry does not
 * silently make a second record. Returns the refusal, or null (also for the second try, which goes through).
 */
export function holdResend(gate: ActGate, url: string): string | null {
  const prior = gate.created?.find((c) => c.url === withoutHash(url) && !c.held);
  if (!prior) return null;
  prior.held = true;
  return `Not sent: this form was already sent in this task, and the page showed ${JSON.stringify(prior.shown)}. Sending it again creates another one. If the task needs another, send this step again; otherwise finish and say what was created.`;
}

/** A click that would send a form: on a button (not a link, not a field). */
const sendsForm = (el: ElementInfo) => el.role === "button" || el.tag === "button" || (el.tag === "input" && (el.type === "submit" || el.type === "image"));

/** A click's element on a page, as noEffect counts it. */
const clickKey = (url: string, el: ElementInfo) => [withoutHash(url), el.role || el.tag, el.name ?? ""].join("|");

export function createActGate(): ActGate {
  return { pending: new Map(), picks: { jev: 0, claude: 0 }, listed: null };
}

/** Times the same click may change nothing before the result says to stop trying it. */
export const NO_EFFECT_LIMIT = 2;

/** The line on an element list with index numbers while Jev is paused. */
export const jevPausedNote = (p: JevPause) =>
  `Jev (the fast element picker) is paused for this run: ${p.why}. So this list has index numbers: name each act step's element by its index from it, e.g. {goal: 'click Save', index: 12}, as long as results say Jev is paused.`;
/** The line on the first result without index numbers after Jev was paused. */
export const JEV_BACK_NOTE =
  "Jev is back (it answered in time): element lists have no index numbers again. Describe each act step's element in words as before; index numbers from earlier lists are no longer accepted.";

/**
 * How the element list of the result being written shows elements: in words (Jev on), or with index numbers (Jev
 * off, or paused), with the line that says why while Jev is paused or when it is back. Records it in the gate: act
 * accepts index steps against the last list given.
 */
export function listMode(jev: JevLike | null, gate: ActGate): { words: boolean; note: string | null } {
  if (!jev) {
    gate.listed = "indices";
    return { words: false, note: null };
  }
  const paused = jev.paused?.() ?? null;
  if (paused) {
    gate.listed = "indices";
    return { words: false, note: jevPausedNote(paused) };
  }
  const back = gate.listed === "indices";
  gate.listed = "words";
  return { words: true, note: back ? JEV_BACK_NOTE : null };
}

/** `text` after the list mode's note, when there is one. */
export const withNote = (note: string | null, text: string) => (note ? `${note}\n${text}` : text);

/** An element list for the result being written, formatted in its list mode (listMode), after the mode's note. */
export function listView(jev: JevLike | null, gate: ActGate, format: (mode: { words: boolean; note: string | null }) => string): string {
  const mode = listMode(jev, gate);
  return withNote(mode.note, format(mode));
}

/** A step that clicks its element (not a key, not typing, not setting a checkbox). */
const isClick = (step: Step) => !step.key && step.text === undefined && step.checked === undefined;

/**
 * The end of a key press's result line: what it did to the page since `prior` (read just before the key), e.g. ";
 * on the page, 4 element(s) went away (...); new text: "Issue #12 created"". When the page cannot be read afterwards,
 * why (a dialog the key opened). Nothing when the page could not be read before the key either.
 */
export async function keyEffect(prior: PageSnapshot | null, read: () => Promise<PageSnapshot>, key = "", gate?: ActGate, sent?: TypedValue[]): Promise<string> {
  if (!prior) return "";
  try {
    const after = await read();
    const effect = formatStepEffect(prior, after);
    if (key !== "Enter" || !gate) return `; ${effect}`;
    // Enter is another way to send a form: on a page whose send click already changed nothing (spentClick), the same.
    if (effect === NOTHING_CHANGED) {
      const spent = [...(gate.noEffect ?? [])].some(([k, times]) => k.startsWith(`${withoutHash(prior.url)}|`) && times >= NO_EFFECT_LIMIT);
      return `; ${effect}${spent ? `. Sending this page has now shown no result several times: report that, instead of trying again or changing other fields` : ""}`;
    }
    // An Enter that changed the page sent what was typed: what the page does not show back is not confirmed.
    const { note } = recordSend(gate, sent ?? gate.typedSince ?? [], prior, after, false);
    return `; ${effect}${note ? `. ${note.trim().replace(/\n/g, " ")}` : ""}`;
  } catch (e) {
    return `; the page could not be read afterwards: ${errorMessage(e)}`;
  }
}

/** Goals compare case- and space-insensitively. */
export function goalKey(goal: string): string {
  return goal.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ActContext {
  browser: <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
  jev: JevLike | null;
  jevThreshold: number;
  sleep: Sleep;
  emit: (e: AgentEvent) => void;
  /** Jev was refused for lack of usage credit (hosted Jev): ends the task. Returns the act result. */
  outOfCredit: (e: OutOfCreditError) => ToolResult;
  /** Default: a fresh gate (nothing pending). */
  gate?: ActGate;
  /** One "act.step" span per step: its parts (reading the page, Jev, the action and the settle wait). */
  trace?: (e: TraceDraft) => void;
  /** True when the user sent a message meanwhile: the remaining steps are not run (the message may change them). */
  interrupted?: () => boolean;
  /**
   * Resolves when the user sends a message from now on (Interjections.spoken): the first step's read, which may
   * wait for a page still loading, gives way to it, as read_page does.
   */
  userSpeaks?: () => ReturnType<Interjections["spoken"]>;
}

/** An action refused before it ran (e.g. a Post on X while another account is signed in): final, like the user's No. */
export class RefusedActionError extends Error {}

/** act's answer when a message from the user came while its first read waited for the page: nothing was done. */
export const ACT_STOPPED_LOADING = (steps: number) =>
  `Stopped before step 1: the page was still loading when the user sent you a message (it follows). Steps 1-${steps} were not run.`;

/** What one act step spent its time on, and who picked its element. */
interface StepTiming {
  readMs: number;
  /** The click or typing and the settle wait after it. */
  performMs: number;
  jevMs?: number;
  picker?: "jev" | "claude";
  confidence?: number;
  operation?: string;
  /** False when the batch stopped at this step. */
  ran: boolean;
}

const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "in", "on", "into", "and", "or", "for", "with", "this", "that", "it", "its", "click", "press", "type", "enter", "open", "field", "box"]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9@#]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * The elements most likely meant by `goal`: Jev's own ranking first (when it
 * gave probabilities), then by words shared with the goal, elements in view
 * first. Returned in page order.
 */
export function rankCandidates(snap: PageSnapshot, goal: string, ranked: number[] = [], max = MAX_CANDIDATES): ElementInfo[] {
  const byIndex = new Map(snap.elements.map((e) => [e.index, e]));
  const chosen = new Map<number, ElementInfo>();
  // Jev's top guesses (the long tail of its ranking is noise, so only the head).
  for (const i of ranked.slice(0, Math.ceil(max / 2))) {
    const e = byIndex.get(i);
    if (e) chosen.set(i, e);
  }
  const goalWords = new Set(words(goal));
  const score = (e: ElementInfo) => {
    const own = new Set(words(`${e.role} ${e.name} ${e.text ?? ""} ${e.testId ?? ""} ${e.type ?? ""}`));
    let n = 0;
    for (const w of goalWords) if (own.has(w)) n++;
    return n;
  };
  const rest = snap.elements
    .filter((e) => !chosen.has(e.index))
    .map((e) => ({ e, s: score(e) }))
    .sort((a, b) => b.s - a.s || Number(b.e.inViewport) - Number(a.e.inViewport) || a.e.index - b.e.index);
  for (const { e } of rest) {
    if (chosen.size >= max) break;
    chosen.set(e.index, e);
  }
  return [...chosen.values()].sort((a, b) => a.index - b.index);
}

/**
 * The step's note on a text field that suggests values as you type when none of its suggestions is the typed text:
 * nothing was chosen, and the list may still be open.
 */
export function suggestionsShown(labels: string[]): string {
  return `; it suggests ${labels.map((l) => JSON.stringify(l)).join(", ")}, none of them exactly the text, so none was chosen and the field holds the typed text. If the field needs one of them, type its exact label into it (which chooses it) or click it`;
}

/** An element without its field state, which was read before the step changed it (the page after the batch has it). */
function withoutState({ value: _value, options: _options, checked: _checked, required: _required, invalid: _invalid, ...el }: ElementInfo): ElementInfo {
  return el;
}

/** Checks the index steps of a Jev-mode act call. Returns the refusal text, or null when every index step is allowed. */
function checkIndexSteps(steps: Step[], offered: Map<string, Set<number>>): string | null {
  const problems: string[] = [];
  const used = new Set<string>();
  steps.forEach((step, i) => {
    if (step.index === undefined) return;
    const key = goalKey(step.goal);
    // The goal must match the unsure step; a slightly reworded resend of the only unsure step (as the first step) counts too.
    let allowedKey: string | null = offered.has(key) ? key : null;
    if (!allowedKey && i === 0 && offered.size === 1) allowedKey = [...offered.keys()][0]!;
    if (!allowedKey || used.has(allowedKey)) {
      problems.push(`step ${i + 1} ("${step.goal}") names element [${step.index}], but Jev was not asked about this step yet`);
      return;
    }
    const candidates = offered.get(allowedKey)!;
    if (!candidates.has(step.index)) {
      problems.push(`step ${i + 1} ("${step.goal}"): [${step.index}] is not one of the candidates listed for it (${[...candidates].map((c) => `[${c}]`).join(", ")})`);
      return;
    }
    used.add(allowedKey);
  });
  if (!problems.length) return null;
  return [
    "act refused; nothing was run.",
    ...problems,
    "With Jev on, describe each element in words instead of naming an index: its visible label and role, and its position when several look alike (e.g. {goal: 'click the Reply button under the first post'}); the fast picker finds it.",
    "An index is accepted only when act just stopped at a step as not confident: send that step again with the same goal and the index of one of the candidates it listed.",
  ].join("\n");
}

/** What Jev is asked about a step on a page. */
function jevInput(step: Step, snapshot: PageSnapshot): Parameters<JevLike["decide"]>[0] {
  const input: Parameters<JevLike["decide"]>[0] = { goal: step.goal, snapshot, typesText: step.text !== undefined };
  if (step.text === "") input.emptiesField = true;
  return input;
}

/** The trace of one act step. */
function stepSpan(span: { t: number; elapsed: () => number }, n: number, goal: string, s: StepTiming): TraceDraft {
  const data: NonNullable<TraceDraft["data"]> = { step: n, goal: traceText(goal, 120), readMs: Math.round(s.readMs), performMs: Math.round(s.performMs), ran: s.ran };
  if (s.picker) data.picker = s.picker;
  if (s.jevMs !== undefined) data.jevMs = s.jevMs;
  if (s.confidence !== undefined) data.confidence = Math.round(s.confidence * 100) / 100;
  if (s.operation) data.operation = s.operation;
  return { t: span.t, ms: span.elapsed(), cat: "act", name: "act.step", data };
}

export async function runAct(steps: Step[], ctx: ActContext): Promise<ToolResult> {
  const { browser, jev, sleep, emit } = ctx;
  const gate = ctx.gate ?? createActGate();
  const jevOn = jev !== null;
  let timing: StepTiming = { readMs: 0, performMs: 0, ran: false };
  /** The page as the call's first step read it, before anything was done. */
  let before: PageSnapshot | null = null;
  /** The page as the current step first read it, before it did anything. */
  let stepBefore: PageSnapshot | null = null;
  /** What this call's steps typed, and into which field (by its label). */
  const typed: TypedValue[] = [];
  /** What index steps typed, by element index: named from the page read before the last click. */
  const typedAt: { index: number; text: string }[] = [];
  /** The element the last click step clicked: Jev's pick, or the index the model named (looked up at the end). */
  let lastClicked: ElementInfo | null = null;
  let lastClickIndex: number | null = null;
  /** typedAt named from a page read: its fields' labels; passwords and fields not on that page left out. */
  const resolveTyped = (page: PageSnapshot): TypedValue[] =>
    typedAt.flatMap(({ index, text }) => {
      const el = page.elements.find((e) => e.index === index);
      return el && el.type !== "password" ? [{ field: el.name ?? "", text }] : [];
    });
  const readPage = async () => {
    const took = stopwatch();
    try {
      const snap = await browser("browser.readPage", {});
      before ??= snap;
      stepBefore ??= snap;
      return snap;
    } finally {
      timing.readMs += took();
    }
  };
  /**
   * The page after the steps. Jev mode: only what changed since the first step (the model has
   * the page from before). With index steps, the whole list: indices may have shifted. Jev off or
   * paused: the whole page, its list with index numbers.
   */
  const pageText = async (clickStep?: { n: number; before: PageSnapshot }) => {
    const start = before;
    const after = await readPage();
    probeJev(after);
    // A click into a text field only focuses it: it sends nothing, and changing nothing is what it should do.
    const clicked = clickStep ? (lastClicked ?? (lastClickIndex !== null ? clickStep.before.elements.find((e) => e.index === lastClickIndex) : undefined)) : undefined;
    const lastStep = clicked && isEditable(clicked) ? undefined : clickStep;
    // The last step's own effect (the Save or Submit click that ends most calls): a confirmation, an error, or nothing.
    // And what the steps typed that the page no longer shows (a form sent to a page that does not show it back).
    let effect = "";
    // A password never goes back into a result (its field does not show it, so it would be listed); nor does a value
    // whose field is not known.
    const byIndex = resolveTyped(lastStep?.before ?? after);
    // What was typed since the last send, this call's last (a form filled in one call and sent in the next).
    const all = latestPerField([...(gate.typedSince ?? []), ...typed, ...byIndex]);
    gate.typedSince = all;
    if (lastStep) {
      const stepEffect = formatStepEffect(lastStep.before, after);
      const { note } = recordSend(gate, all, lastStep.before, after, stepEffect === NOTHING_CHANGED);
      effect = `After step ${lastStep.n}, ${stepEffect}.\n${note}`;
      // The same click changing nothing again: one retry is enough to know; more only cost time.
      if (clicked && stepEffect === NOTHING_CHANGED) {
        const key = clickKey(after.url, clicked);
        const times = ((gate.noEffect ??= new Map()).get(key) ?? 0) + 1;
        gate.noEffect.set(key, times);
        if (times >= NO_EFFECT_LIMIT) {
          effect += `Clicking ${clicked.role || clicked.tag} ${JSON.stringify(clicked.name ?? "")} has now changed nothing on the page ${times} times. Do not click it again, another way, or after changing other fields to find out why: report that the page showed no result of it.\n`;
        }
      }
    }
    // Back from a pause, the model's list had index numbers: the whole page in words, not only what changed.
    return effect + listView(jev, gate, (mode) => (mode.words && !mode.note && start && start !== after ? formatPageChange(start, after) : formatSnapshot(after, { words: mode.words })));
  };
  /**
   * Jev paused and its skip over, with the model naming indices: Jev is asked about the first index step on the side
   * (its answer is not used; the model's index runs at once, and the step is not held for a read). The question goes
   * with a page read anyway after the steps (the result's, or a stop's), never before an index step: a read numbers
   * the elements anew, and on a changed page the model's index would then name another element. An answer in time
   * ends the pause, so the next result is in words again; a late one starts another skip. Traced as "jev.probe".
   */
  let probeFor: Step | null = null;
  const probeJev = (snapshot: PageSnapshot) => {
    const step = probeFor;
    probeFor = null;
    if (!step || gate.probing || !snapshot.elements.length) return;
    const span = traceStart();
    const done = (data: NonNullable<TraceDraft["data"]>) => {
      gate.probing = false;
      ctx.trace?.({ t: span.t, ms: span.elapsed(), cat: "jev", name: "jev.probe", data: { goal: traceText(step.goal, 120), ...data } });
    };
    gate.probing = true;
    jev!.decide(jevInput(step, snapshot)).then(
      (d) => done({ inTime: true, operation: d.operation, confidence: Math.round(d.confidence * 100) / 100 }),
      (e: unknown) => done({ inTime: false, operation: e instanceof JevSlowError ? "slow" : "error" }),
    );
  };
  /**
   * Does the step on the element, then lets the page settle: sets a checkbox (checked), fills a field,
   * empties it (text "") or chooses a dropdown's option (text), else clicks. Returns what was done, as "<verb> ELEMENT<after>".
   */
  const perform = async (index: number, step: Step): Promise<{ did: string; after: string }> => {
    const took = stopwatch();
    try {
      return await performStep(index, step);
    } finally {
      timing.performMs += took();
    }
  };
  /**
   * Fields typed into whose suggestions show and none was chosen (the step result lists them): field index -> its step
   * number. A later click on anything but one of the suggestions is not run (see below).
   */
  const unchosen = new Map<number, number>();
  let stepNumber = 0;
  const performStep = async (index: number, step: Step): Promise<{ did: string; after: string }> => {
    if (step.checked !== undefined) {
      const r = await browser("browser.click", { index, checked: step.checked, settleMs: SETTLE_AFTER_TYPE_MS });
      if (!r?.settled) await sleep(SETTLE_AFTER_TYPE_MS);
      return { did: r?.checked === false ? "unchecked" : "checked", after: "" };
    }
    if (step.text !== undefined) {
      const r = await browser("browser.type", { index, text: step.text, settleMs: SETTLE_AFTER_TYPE_MS });
      if (!r?.settled) await sleep(SETTLE_AFTER_TYPE_MS);
      const did = r?.selected !== undefined ? `chose ${JSON.stringify(r.selected)} in` : step.text === "" ? "cleared" : `typed ${step.text.length} characters into`;
      if (r?.suggestions?.length) unchosen.set(index, stepNumber);
      else unchosen.delete(index);
      return { did, after: r?.suggestions?.length ? suggestionsShown(r.suggestions) : "" };
    }
    const r = await browser("browser.click", { index, settleMs: SETTLE_AFTER_CLICK_MS });
    if (!r?.settled) await sleep(SETTLE_AFTER_CLICK_MS);
    return { did: "clicked", after: r?.checked === undefined ? "" : ` (now ${r.checked ? "checked" : "not checked"})` };
  };

  // Jev mode: index steps only for the steps the last act result left to Claude, unless the model's last element list
  // had index numbers (Jev paused).
  const offered = gate.pending;
  gate.pending = new Map();
  if (jevOn && gate.listed !== "indices") {
    const refusal = checkIndexSteps(steps, offered);
    if (refusal) {
      gate.pending = offered; // still open: the model can resend the step properly
      return { text: refusal, isError: true };
    }
  }

  const lines: string[] = [];
  /** " Steps a-b were not run" and `end`, for the steps after step `n`; "" when it was the last. */
  const notRun = (n: number, end = ".") => (steps.length > n ? ` Steps ${n + 1}-${steps.length} were not run${end}` : "");
  /**
   * A click on an element whose click already changed nothing on this page NO_EFFECT_LIMIT times (one try and one
   * retry): not run again. Returns the result that says so (the steps before it ran), or null.
   */
  /** A click on a form's button (or Enter, el null) that would send again a form this task already sent: held once. */
  const heldResend = (n: number, url: string, el: ElementInfo | null): ToolResult | null => {
    if (el && !sendsForm(el)) return null;
    const held = holdResend(gate, url);
    if (!held) return null;
    const rest = steps.length > n ? ` Steps ${n + 1}-${steps.length} were not run.` : "";
    return { text: [...lines, `step ${n}: ${held}${rest}`].join("\n"), isError: true };
  };
  const spentClick = (n: number, url: string, el: ElementInfo): ToolResult | null => {
    const times = gate.noEffect?.get(clickKey(url, el)) ?? 0;
    if (times < NO_EFFECT_LIMIT) return null;
    const what = `${el.role || el.tag} ${JSON.stringify(el.name ?? "")}`;
    return {
      text: `${[...lines, `step ${n}: not clicked: clicking ${what} already changed nothing on this page ${times} times.${notRun(n)} Report that the page showed no result of it, instead of trying again or changing other fields.`].join("\n")}`,
      isError: true,
    };
  };
  /** failed: the step's element was picked (by Jev or Claude) but could not be used, so nobody was unsure. */
  const stop = (n: number, why: string, snap: PageSnapshot, d?: JevDecision, failed = false): ToolResult => {
    lines.push(`step ${n}: ${why}`);
    probeJev(snap);
    const step = steps[n - 1]!;
    const rest = notRun(n);
    // Jev off, or paused (it may have just become so at this step): the whole list with index numbers, from which the
    // model picks this step's element and those of the rest in one turn.
    const paused = jev?.paused?.() ? listMode(jev, gate) : null;
    if (!jevOn || paused) {
      const pick = paused ? `Send step ${n} again with the element index from this list (e.g. {goal, index, text}), and the rest by index too:` : `Send step ${n} again with the element index from this list (e.g. {goal, index, text}), then continue:`;
      return { text: `${lines.join("\n")}\n\n${NOT_CONFIDENT} at step ${n}.${rest} ${pick}\n${withNote(paused?.note ?? null, formatCompact(snap))}` };
    }
    const candidates = rankCandidates(snap, step.goal, d?.ranked);
    gate.pending.set(goalKey(step.goal), new Set(candidates.map((e) => e.index)));
    const example = step.text !== undefined ? `{goal: ${JSON.stringify(step.goal)}, index: <n>, text: ...}` : `{goal: ${JSON.stringify(step.goal)}, index: <n>}`;
    return {
      text: [
        lines.join("\n"),
        "",
        failed
          ? `Stopped at step ${n}.${rest} Its element could not be used (why is above), so step ${n} did nothing. Change the step as the error says, or pick the element yourself: send step ${n} again with the same goal and the index of the right candidate below, e.g. ${example}, followed by the remaining steps described in words.`
          : `${NOT_CONFIDENT} at step ${n}.${rest} Jev was not sure which element step ${n} means. Pick it yourself: send step ${n} again with the same goal and the index of the right candidate below, e.g. ${example}, followed by the remaining steps described in words. If none fits, describe the element differently (or scroll) instead.`,
        `URL: ${snap.url}`,
        `Title: ${snap.title}`,
        `Candidates for step ${n} (${candidates.length} of ${snap.elements.length} elements, most likely ones):`,
        candidates.map(formatElement).join("\n"),
      ].join("\n"),
    };
  };

  for (let i = 0; i < steps.length; i++) {
    const n = i + 1;
    const step = steps[i]!;
    if (i > 0 && ctx.interrupted?.()) {
      return { text: `${lines.join("\n")}\nStopped before step ${n}: the user sent a new message (it follows).${notRun(n - 1)}\n\n${await pageText()}` };
    }
    const span = traceStart();
    timing = { readMs: 0, performMs: 0, ran: false };
    stepBefore = null;
    stepNumber = n;
    try {
      if (step.key) {
        // A key at the focus (Enter after typing a search): no element to pick, so neither Jev nor an index. What it
        // caused (an Enter that submitted the form, an error, another page) is on its line, before the next step runs.
        // Not when a later step names an index: a read numbers the elements anew, and that index is from the model's list.
        const reads = !steps.slice(i + 1).some((s) => s.index !== undefined);
        const prior = reads ? await readPage().catch(() => null) : null;
        // What this call typed so far joins what was typed since the last send: an Enter may send it.
        if (prior) {
          gate.typedSince = latestPerField([...(gate.typedSince ?? []), ...typed, ...resolveTyped(prior)]);
          typed.length = 0;
          typedAt.length = 0;
          const held = step.key === "Enter" ? heldResend(n, prior.url, null) : null;
          if (held) return held;
        }
        const started = Date.now();
        const r = await browser("browser.pressKey", { key: step.key, settleMs: SETTLE_AFTER_CLICK_MS });
        if (!r?.settled) await sleep(SETTLE_AFTER_CLICK_MS);
        timing.performMs = Date.now() - started;
        timing.ran = true;
        lines.push(`step ${n}: pressed ${step.key}${await keyEffect(prior, readPage, step.key, gate)}`);
        continue;
      }
      // Any text, empty too, types: an empty text empties the field Jev picks.
      const hasText = step.text !== undefined;
      const couldNotUse = async (index: number, e: unknown, d?: JevDecision): Promise<ToolResult> => {
        const message = errorMessage(e);
        // The user did not approve the step, or it was refused: that is final. No candidates to pick again, nothing after it runs.
        // So is a dialog the page opened (the step's click did it) or had open: the page answers nothing until it is answered;
        // and a Chrome dialog that holds the tab's input (the click never reached the page). An element behind an open
        // modal dialog, or under something else (an open list, a banner), was the right one, but that is in the way:
        // another candidate would be the wrong element.
        if (isApprovalRefusal(message) || e instanceof RefusedActionError || isDialogOpenText(message) || isInputBlockedText(message) || isCoveredText(message)) {
          return { text: `${[...lines, `step ${n}: "${step.goal}": ${message}`].join("\n")}${notRun(n)}`, isError: true };
        }
        return stop(n, `"${step.goal}": could not use element [${index}]: ${message}`, await readPage(), d, true);
      };
      if (step.index !== undefined) {
        // The model knows the element (Jev off or paused, or Jev was unsure about this step): run it directly.
        if (jev?.paused?.()?.retry && !gate.probing) probeFor ??= step;
        try {
          timing.picker = "claude";
          const { did, after } = await perform(step.index, step);
          lines.push(`step ${n}: ${did} [${step.index}]${after} (picked by Claude)`);
          if (step.text) typedAt.push({ index: step.index, text: step.text });
          [lastClicked, lastClickIndex] = isClick(step) ? [null, step.index] : [null, null];
          gate.picks.claude++;
          timing.ran = true;
        } catch (e) {
          return couldNotUse(step.index, e);
        }
        continue;
      }
      if (!jev) return stop(n, `"${step.goal}": the fast model is off, so every step needs an element index`, await readPage());
      // The first read may wait for a page still loading (read_page's wait); a message from the user ends that wait.
      const spoken = n === 1 ? ctx.userSpeaks?.() : undefined;
      const snap = spoken ? await untilUserSpeaks<PageSnapshot | null>(readPage(), spoken, () => null) : await readPage();
      if (!snap) return { text: ACT_STOPPED_LOADING(steps.length) };
      // Nothing on the page to pick from (it is still loading): Jev is not asked, and its "unsure" would hide why.
      if (!snap.elements.length) {
        const empty = `step ${n}: "${step.goal}": the page has no elements yet (still loading or empty), so nothing was picked.${notRun(n)} Wait for it (wait_for), then send the steps again.`;
        return { text: `${[...lines, empty].join("\n")}\n\n${listView(jev, gate, ({ words }) => formatSnapshot(snap, { words }))}` };
      }
      const started = Date.now();
      let d: JevDecision;
      try {
        // Jev is asked here anyway: no probe on the side as well.
        probeFor = null;
        const input = jevInput(step, snap);
        const previous = lines.at(-1);
        if (previous) input.previousStep = previous;
        d = await jev.decide(input);
      } catch (e) {
        const ms = Date.now() - started;
        // Jev too slow (its deadline passed, or it was slow on the steps before): the model picks, as for any error.
        const operation = e instanceof JevSlowError ? (e.skipped ? "skipped" : "slow") : "error";
        Object.assign(timing, { jevMs: ms, operation });
        emit({ type: "jev", goal: step.goal, operation, index: null, confidence: 0, executed: false, ms });
        if (e instanceof OutOfCreditError) {
          const ended = ctx.outOfCredit(e);
          return { ...ended, text: [...lines, `step ${n}: "${step.goal}": ${e.message}`, ended.text].join("\n") };
        }
        return stop(n, `"${step.goal}": ${e instanceof JevSlowError ? e.message : `Jev is unavailable (${errorMessage(e)})`}`, snap);
      }
      const ms = Date.now() - started;
      Object.assign(timing, { jevMs: ms, picker: "jev", confidence: d.confidence, operation: d.operation });
      const target = d.index === null ? undefined : snap.elements.find((e) => e.index === d.index);
      const conf = `${d.operation}, confidence ${d.confidence.toFixed(2)}`;
      const jevEvent = (executed: boolean, operation = d.operation, why?: "not_approved" | "refused" | "failed") =>
        emit({ type: "jev", goal: step.goal, operation, index: d.index, confidence: d.confidence, executed, ms, ...(why ? { notRun: why } : {}) });

      if (d.operation === "blocked" || d.confidence < ctx.jevThreshold) {
        jevEvent(false);
        return stop(n, `"${step.goal}": ${conf}`, snap, d);
      }
      // Clicking or typing is decided by the step: a step with text types into the element Jev picked, one without clicks it.
      let op = d.operation;
      if ((op === "click" || op === "type") && target) op = hasText ? "type" : "click";
      switch (op) {
        case "click":
        case "type": {
          if (!target) {
            jevEvent(false);
            return stop(n, `"${step.goal}": ${conf}, but element [${d.index}] does not exist`, snap, d);
          }
          // A field typed into earlier still shows its suggestions, none of them chosen: a click on anything but one of
          // them (the form's submit button, the next page) would leave it with only the typed text, which a field that
          // takes only a picked value drops. The model sees the suggestions and decides; picking one runs.
          if (op === "click" && step.checked === undefined && unchosen.size && target.role !== "option") {
            jevEvent(false);
            const fields = [...unchosen.values()].map((s) => `step ${s}`).join(", ");
            return {
              text: `${lines.join("\n")}\nStopped before step ${n} ("${step.goal}"): the field of ${fields} shows suggestions and none of them was chosen (they are listed above), so the click was not run.${notRun(n)} If the field needs one of them, choose it (type its exact label into the field, or click it); then send step ${n} again.\n\n${await pageText()}`,
            };
          }
          if (op === "click" && step.checked === undefined) {
            const spent = spentClick(n, snap.url, target) ?? heldResend(n, snap.url, target);
            if (spent) return spent;
          }
          let done: { did: string; after: string };
          try {
            done = await perform(target.index, op === "type" ? step : { ...step, text: undefined });
          } catch (e) {
            // Jev was sure: its pick was not approved, refused, or failed; never "unsure".
            jevEvent(false, op, isApprovalRefusal(errorMessage(e)) ? "not_approved" : e instanceof RefusedActionError ? "refused" : "failed");
            return couldNotUse(target.index, e, d);
          }
          jevEvent(true, op);
          // A suggestion picked: its field has a chosen value now.
          if (op === "click" && target.role === "option") unchosen.clear();
          gate.picks.jev++;
          lines.push(`step ${n}: ${done.did} ${formatElement(withoutState(target))}${done.after} (picked by Jev, ${d.confidence.toFixed(2)}, ${ms} ms)`);
          if (op === "type" && step.text && target.type !== "password") typed.push({ field: target.name ?? "", text: step.text });
          [lastClicked, lastClickIndex] = op === "click" ? [target, null] : [null, null];
          break;
        }
        case "scroll":
          await browser("browser.scroll", { direction: "down" });
          jevEvent(true);
          lines.push(`step ${n}: scrolled down (picked by Jev)`);
          break;
        case "press_key":
          jevEvent(false);
          return stop(n, `"${step.goal}": Jev chose to press a key${target ? ` on ${formatElement(target)}` : ""}: send the step again with that key (e.g. key: "Enter"), or pick the element`, snap, d);
        case "wait":
          await sleep(JEV_WAIT_MS);
          jevEvent(true);
          lines.push(`step ${n}: waited ${JEV_WAIT_MS / 1000} s for the page`);
          break;
        case "done": {
          jevEvent(true);
          timing.ran = true;
          lines.push(`step ${n}: "${step.goal}" is already done`);
          return { text: `${lines.join("\n")}\nJev ended the batch at step ${n}.${notRun(n, "; send them again if they are still needed.")}\n\n${await pageText()}` };
        }
      }
      timing.ran = true;
    } finally {
      ctx.trace?.(stepSpan(span, n, step.goal, timing));
    }
  }
  // A last step that clicked: what that click did, apart from what the steps before it changed.
  const lastStep = isClick(steps.at(-1)!) && stepBefore ? { n: steps.length, before: stepBefore } : undefined;
  return { text: `${lines.join("\n")}\nAll ${steps.length} step(s) done. Verify the result.\n\n${await pageText(lastStep)}` };
}
