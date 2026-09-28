/**
 * The approval gate: a BrowserCaller around an agent slot's browser that
 * holds every action that changes something until the automation level
 * allows it (automation.ts). Both brains' browser calls pass here (the Claude
 * API brain's directly, Claude Code's through the helper), so the level holds
 * whatever the model was told.
 *
 * - full: nothing waits.
 * - ask_all: every click, typing, key, upload, navigation and tab change waits; reads never do.
 * - ask_consequential: what the classifier (judge.ts) finds consequential waits.
 * - full_within_task (scheduled runs): a consequential action waits only when the task's instructions do not ask for it.
 *
 * What it knows of an action comes from the calls themselves: the last page
 * read (the element behind an index, the URL and title), and the fields typed
 * into since (the text a Post or Send click sends). It never reads the page
 * on its own: another read would renumber the elements the agent's indices
 * point at. An answer to a page's dialog is judged by the dialog the tab has
 * open (dialogOf), never by what the agent says it is. An action that waits becomes an approval request (broker.ts); a
 * refusal is an error whose text tells the agent not to retry
 * (approvalRefusalText).
 *
 * Nothing runs on a stale answer: Stop ends a waiting request at once and no
 * action of a stopped run runs after it (checked again right before the
 * action), a message from the user ends the request as not done (the agent
 * reads the message first), and an unattended run (a scheduled task nobody
 * watches) does not wait for a card nobody sees: it pauses at once for the
 * user's OK.
 */
import {
  activeXAccount,
  APPROVAL_TIMEOUT_MS,
  approvalPauseReason,
  approvalRefusalText,
  CONSEQUENCE_TEXT,
  dialogText,
  isApprovalGated,
  isXUrl,
  PERMISSION_TITLE,
  type ApprovalGatedMethod,
  type ApprovalOutcome,
  type AgentTabInfo,
  type ApprovalRequest,
  type BrowserMethod,
  type BrowserMethods,
  type ConsequenceKind,
  type EffectiveLevel,
  type ElementInfo,
  type JsDialog,
  type PageSnapshot,
  type TraceEvent,
  type TraceValue,
} from "@noa/shared";
import type { BrowserCaller } from "@noa/core";
import { normalizeId } from "../agent-tab.js";
import type { ApprovalRequestOptions } from "./broker.js";
import { classifyByRules, hostOf, type GateAction, type GateMethod, type TypedField } from "./consequence.js";
import type { SystemOneLike } from "./jev-judge.js";
import { judgeAction, judgeWithinTask } from "./judge.js";

/** What the gate needs to know about the session making a call. */
export interface GateContext {
  level: EffectiveLevel;
  /** Scheduled runs: the task's instructions (full_within_task holds actions they do not ask for). */
  instructions?: string;
  /** Scheduled runs: the account the task acts as (an X handle names X as its site). */
  account?: string | null;
  /** Scheduled runs: the agent wrote the task's instructions (Task.agentAuthored), so its actions wait until the user trusts it. */
  agentAuthored?: boolean;
  /** When the turn's time limit ends it (epoch ms): an approval waits at most until shortly before. */
  endsAt?: number;
  /**
   * Someone can answer an approval card now (a chat, or a scheduled run whose conversation is open). Absent: a
   * scheduled level (full_within_task) counts as unattended, a chat level as attended.
   */
  attended?: boolean;
  /** Ends a waiting approval when aborted, with reason "stop" (the run was stopped) or "message" (the user wrote to the agent). */
  interrupt?: AbortSignal;
  /** The run was stopped (Stop, a page that needs the user, its tab closed): no action of it runs any more. */
  stopped?(): boolean;
  /** An unattended run needs the user's OK: it pauses with this reason (the TODO row and the notification show it). */
  pause?(reason: string): void;
}

export interface GateDeps {
  /** The level and task of a session, looked up at each action (a changed setting applies at once). */
  context(sessionId: string): Promise<GateContext>;
  /** Asks the user (ApprovalBroker.request). */
  request(sessionId: string, ask: Omit<ApprovalRequest, "id" | "expiresAt">, opts?: ApprovalRequestOptions): Promise<ApprovalOutcome>;
  /** Jev for what the rules are unsure about, for this session; null: rules only (unsure asks). */
  jev?(sessionId: string): SystemOneLike | null | Promise<SystemOneLike | null>;
  /** Adds a row to the session's timing trace (the Raw view): how each consequential action was judged. */
  trace?(sessionId: string, row: TraceEvent): void;
  /**
   * Whether the user allowed this exact action ahead for this session's run (Allow & continue on the card its run
   * paused at: paused.ts); used up when true. It only stands for the card: every other check still runs.
   */
  preapproved?(sessionId: string, ask: Omit<ApprovalRequest, "id" | "expiresAt">): boolean;
  now?(): number;
}

/** An approval ends this long before the turn's time limit, so the agent still hears the answer. */
export const APPROVAL_TURN_MARGIN_MS = 30_000;

/** APPROVAL_GATED_METHODS as the classifier names them. */
export const GATED_METHODS: Record<ApprovalGatedMethod, GateMethod> = {
  "browser.click": "click",
  "browser.type": "type",
  "browser.paste": "paste",
  "browser.pressKey": "pressKey",
  "browser.upload": "upload",
  "browser.navigate": "navigate",
  "browser.openTabs": "openTabs",
  "browser.closeTabs": "closeTabs",
  "browser.clickXAccountEntry": "switchXAccount",
  "browser.handleDialog": "handleDialog",
};

/** Typed fields remembered per page (a long form keeps its last ones). */
const MAX_TYPED = 8;
/** The text an approval card shows at most. */
const MAX_CARD_TEXT = 2000;
const ASK_ALL_WHY = `You asked to approve every action (Settings > ${PERMISSION_TITLE})`;
/** Why an action of a job the agent wrote waits (effectiveLevel holds it like ask_consequential until Trust). */
export const AGENT_AUTHORED_WHY = "the agent wrote this job, so it asks until you press Trust on the job";

export class ApprovalGate {
  /** The session the slot serves now: "allow for this task" and what was typed belong to it. */
  private boundTo: string | null = null;
  private allowAll = false;
  /** The current tab's last page read. */
  private page: PageSnapshot | null = null;
  /**
   * The current tab's short id, as the calls' results say (a turn starts on t1; switch_tab, open_tabs shown, and
   * the tab lists change it): a read that names this tab (read_page with `tabs`) is a read of the current tab.
   */
  private current = MAIN_TAB;
  private typed: TypedField[] = [];

  constructor(
    private readonly inner: BrowserCaller,
    /** The session using the slot now (null: none, e.g. `mcp-server --attach`, where the user drives their own Claude Code). */
    private readonly sessionOf: () => string | null,
    private readonly deps: GateDeps,
    /** Called when the gate starts waiting for the user; returns what ends it (the turn's clock leaves the wait out). */
    private readonly waiting?: () => () => void,
    /** The dialog open in the current tab, or in `tab` (a short id): what an answer to it is judged by. */
    private readonly dialogOf?: (tab?: string) => Promise<JsDialog | null>,
  ) {}

  readonly browser: BrowserCaller = {
    call: async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => {
      const sessionId = this.sessionOf();
      this.follow(sessionId);
      const gated = isApprovalGated(method) ? GATED_METHODS[method] : undefined;
      if (gated && sessionId) {
        const ctx = await this.check(sessionId, gated, params as Record<string, unknown>);
        // Stopped while it was judged or waited: it is not done, whatever was answered.
        if (ctx.stopped?.()) throw new Error(stoppedText(describeAction(this.actionOf(gated, params as Record<string, unknown>))));
      }
      const result = await this.inner.call(method, params);
      this.observe(method, params as Record<string, unknown>, result);
      return result;
    },
  };

  /** The session's turn ended (the slot is given back): "allow for this task" and what the gate knew are gone. */
  release(): void {
    this.boundTo = null;
    this.reset();
  }

  private follow(sessionId: string | null): void {
    if (sessionId === this.boundTo) return;
    this.boundTo = sessionId;
    this.reset();
  }

  private reset(): void {
    this.allowAll = false;
    this.current = MAIN_TAB;
    this.page = null;
    this.typed = [];
  }

  /** Returns when the action may run (with the context it was judged in); throws the refusal otherwise. */
  private async check(sessionId: string, method: GateMethod, params: Record<string, unknown>): Promise<GateContext> {
    const ctx = await this.deps.context(sessionId);
    const action = this.actionOf(method, params);
    if (method === "handleDialog") {
      const dialog = await this.dialogOf?.(typeof params.tab === "string" ? params.tab : undefined);
      if (dialog) action.dialog = dialog;
    }
    if (ctx.stopped?.()) throw new Error(stoppedText(describeAction(action)));
    if (ctx.level === "full" || this.allowAll) return ctx;
    const ask = await this.why(sessionId, ctx, action);
    if (!ask) return ctx;
    const request = approvalAsk(action, ask.why, ask.kind);
    if (this.deps.preapproved?.(sessionId, request)) {
      const t = this.deps.now?.() ?? Date.now();
      this.deps.trace?.(sessionId, { t, ms: 0, cat: "approval", name: "approval.preapproved", src: "engine", data: { action: request.action, site: request.site } });
      return ctx;
    }
    await this.ask(sessionId, ctx, request);
    return ctx;
  }

  /**
   * A change the agent makes outside the page (a TODO task changed or cancelled, engine/schedule-task.ts): it
   * waits for the user's OK at every level but full autonomy, like a consequential action the task does not
   * ask for; "Allow for this task" covers it too. Throws the refusal the agent reads when it is not allowed.
   * Resolves true when the user allowed this very request on its card (false: nothing asked them).
   */
  async confirm(sessionId: string, request: Omit<ApprovalRequest, "id" | "expiresAt">): Promise<boolean> {
    this.follow(sessionId);
    const ctx = await this.deps.context(sessionId);
    if (ctx.stopped?.()) throw new Error(stoppedText(request.action));
    if (ctx.level === "full" || this.allowAll) return false;
    await this.ask(sessionId, ctx, request);
    if (ctx.stopped?.()) throw new Error(stoppedText(request.action));
    return true;
  }

  /**
   * Asks the user (no longer than the turn allows); returns when allowed, throws the refusal otherwise. Unattended:
   * the card is kept in the thread and the run pauses for the user's OK at once, instead of waiting for nobody.
   */
  private async ask(sessionId: string, ctx: GateContext, request: Omit<ApprovalRequest, "id" | "expiresAt">): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const left = ctx.endsAt === undefined ? undefined : Math.max(0, ctx.endsAt - now - APPROVAL_TURN_MARGIN_MS);
    const unattended = !(ctx.attended ?? ctx.level !== "full_within_task");
    const opts: ApprovalRequestOptions = {
      ...(left === undefined || left >= APPROVAL_TIMEOUT_MS ? {} : { timeoutMs: left }),
      ...(ctx.interrupt ? { signal: ctx.interrupt } : {}),
      ...(unattended ? { unattended: true } : {}),
    };
    const waited = unattended ? undefined : this.waiting?.();
    const outcome = await this.deps.request(sessionId, request, opts).finally(() => waited?.());
    if (outcome === "paused") ctx.pause?.(approvalPauseReason(request));
    // An answer that comes after the turn ended (the slot moved on) or after Stop does nothing.
    const still = this.sessionOf() === sessionId && !ctx.stopped?.() && ctx.interrupt?.reason !== "stop";
    if ((outcome === "allow_once" || outcome === "allow_task") && still) {
      if (outcome === "allow_task") this.allowAll = true;
      return;
    }
    throw new Error(approvalRefusalText(outcome === "allow_once" || outcome === "allow_task" ? "ended" : outcome, request.action));
  }

  /** Why this action waits at this level; null: it runs. How a consequential action was judged goes to the trace (approval.judge). */
  private async why(sessionId: string, ctx: GateContext, action: GateAction): Promise<{ why: string; kind?: ConsequenceKind } | null> {
    // Cancel on a dialog, or OK on an alert, changes nothing: it never waits, even when every action asks.
    if (action.method === "handleDialog" && classifyByRules(action).verdict === "benign") return null;
    if (ctx.level === "ask_all") return { why: ASK_ALL_WHY };
    const jev = (await this.deps.jev?.(sessionId)) ?? null;
    const pageText = this.page?.text ?? "";
    const started = this.deps.now?.() ?? Date.now();
    const j = await judgeAction(action, { jev, pageText });
    if (!j.consequential) return null;
    // A dialog's answer says what it does itself ("the page's unsaved changes are lost"), not what a button might.
    const what = j.kind ? CONSEQUENCE_TEXT[j.kind] : action.method === "handleDialog" ? j.reason : "may publish, send, pay or delete (it could not be told apart)";
    const judged: Record<string, TraceValue> = { action: describeAction(action), level: ctx.level, kind: j.kind ?? null, by: j.by, reason: j.reason };
    if (ctx.agentAuthored) judged.agentAuthored = true;
    // A job the agent wrote waits because of who wrote it, whatever it asks for: the card says so, and how to let it run.
    const why = ctx.agentAuthored && ctx.level === "ask_consequential" ? `${what}; ${AGENT_AUTHORED_WHY}` : what;
    let wait: { why: string; kind?: ConsequenceKind } | null = { why, ...(j.kind ? { kind: j.kind } : {}) };
    if (ctx.level === "full_within_task") {
      const w = await judgeWithinTask(j.kind, action, { instructions: ctx.instructions ?? "", account: ctx.account ?? null }, { jev, pageText });
      // Both verdicts: what the rules said and, when they were unsure, Jev's answer are plain in the Raw view.
      Object.assign(judged, { withinRules: w.rules, withinJev: w.jev ?? null, within: w.within });
      wait = w.within ? null : { why: `${what}; ${w.reason}`, ...(j.kind ? { kind: j.kind } : {}) };
    }
    judged.waits = wait !== null;
    this.deps.trace?.(sessionId, { t: started, ms: (this.deps.now?.() ?? Date.now()) - started, cat: "approval", name: "approval.judge", src: "engine", data: judged });
    return wait;
  }

  private elementAt(index: unknown): ElementInfo | undefined {
    return typeof index === "number" ? this.page?.elements.find((e) => e.index === index) : undefined;
  }

  private actionOf(method: GateMethod, p: Record<string, unknown>): GateAction {
    const action: GateAction = { method, page: { url: this.page?.url ?? "", title: this.page?.title ?? "" }, typed: [...this.typed] };
    const element = this.elementAt(p.index);
    if (element) action.element = element;
    const account = this.page && isXUrl(this.page.url) ? activeXAccount(this.page) : null;
    if (account) action.account = account;
    if (typeof p.checked === "boolean") action.checked = p.checked;
    if (typeof p.text === "string") action.text = p.text;
    if (typeof p.key === "string") action.key = p.key;
    if (typeof p.url === "string") action.urls = [p.url];
    if (Array.isArray(p.urls)) action.urls = p.urls.filter((u): u is string => typeof u === "string");
    if (Array.isArray(p.paths)) action.paths = p.paths.filter((u): u is string => typeof u === "string");
    if (Array.isArray(p.tabs)) action.tabs = p.tabs.filter((u): u is string => typeof u === "string");
    if (typeof p.handle === "string") action.handle = p.handle;
    if (typeof p.accept === "boolean") action.accept = p.accept;
    return action;
  }

  /** A tab list says which tab is current: a different one than known means the page known is not its page. */
  private follows(tabs: AgentTabInfo[] | undefined): void {
    const now = tabs?.find((t) => t.current)?.id;
    if (!now || now === this.current) return;
    this.current = now;
    this.page = null;
    this.typed = [];
  }

  /** Keeps what later actions need to be judged: the page read, and the fields typed into on it. */
  private observe(method: BrowserMethod, p: Record<string, unknown>, result: unknown): void {
    switch (method) {
      case "browser.readPage": {
        // Another tab's read (read_page with tabs) says nothing about the tab the actions go to; the current tab's does.
        if (typeof p.tab === "string" && normalizeId(p.tab) !== this.current) return;
        const snap = result as PageSnapshot;
        if (this.page && snap.url !== this.page.url) this.typed = [];
        this.page = snap;
        return;
      }
      case "browser.navigate":
      case "browser.clickXAccountEntry":
        this.page = null;
        this.typed = [];
        return;
      case "browser.handleDialog": {
        // Leave: the page read is gone, and so is what was typed on it.
        const r = result as BrowserMethods["browser.handleDialog"]["result"];
        if (r.accepted && r.dialog.type === "beforeunload") {
          this.page = null;
          this.typed = [];
        }
        return;
      }
      case "browser.switchTab":
        this.current = (result as AgentTabInfo).id;
        this.page = null;
        this.typed = [];
        return;
      case "browser.openTabs":
        if (p.background === false) {
          this.follows((result as { tabs: AgentTabInfo[] }).tabs);
          this.page = null;
          this.typed = [];
        }
        return;
      case "browser.listTabs":
      case "browser.closeTabs":
        this.follows((result as { tabs: AgentTabInfo[] }).tabs);
        return;
      case "browser.type":
      case "browser.paste": {
        const element = this.elementAt(p.index) ?? this.typed.at(-1)?.element ?? { index: -1, tag: "", role: "textbox", name: "the focused field", inViewport: true };
        if (typeof p.text === "string") this.typed = [...this.typed.filter((t) => t.element.index !== element.index), { element, text: p.text }].slice(-MAX_TYPED);
        return;
      }
      case "browser.click": {
        // What was typed went out with (or was left by) a click on anything but a field.
        const el = this.elementAt(p.index);
        if (!el || !isField(el)) this.typed = [];
        return;
      }
      default:
        return;
    }
  }
}

/** The refusal for an action of a run that was stopped. */
function stoppedText(action: string): string {
  return approvalRefusalText("ended", action);
}

/** The tab a run starts on (AgentTab: the main tab is t1 and current when a turn starts). */
const MAIN_TAB = "t1";

function isField(el: ElementInfo): boolean {
  return ["textbox", "searchbox", "combobox"].includes(el.role) || (el.tag === "input" && !["submit", "button", "checkbox", "radio", "image"].includes(el.type ?? "text")) || el.tag === "textarea";
}

// ------------------------------------------------------------------ the card's words

const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"`;

function elementName(el: ElementInfo | undefined): string {
  if (!el) return "an element";
  return quote(el.name || el.text || el.testId || el.role || el.tag);
}

/** The action in plain words: `Click "Post"`, `Press Control+Enter`, `Open example.com/delete`. */
export function describeAction(a: GateAction): string {
  switch (a.method) {
    case "click":
      if (a.checked !== undefined) return `${a.checked ? "Check" : "Uncheck"} ${elementName(a.element)}`;
      return `Click ${elementName(a.element)}`;
    case "type":
      return a.element?.options ? `Choose ${quote(a.text ?? "")} in ${elementName(a.element)}` : `Type into ${elementName(a.element)}`;
    case "paste":
      return "Paste text";
    case "pressKey":
      return `Press ${a.key ?? "a key"}`;
    case "upload": {
      const names = (a.paths ?? []).map((p) => p.split(/[\\/]/).pop() ?? p);
      return `Upload ${names.length === 1 ? names[0] : `${names.length} files`}`;
    }
    case "navigate":
      return `Open ${shortUrl(a.urls?.[0] ?? "")}`;
    case "openTabs":
      return (a.urls?.length ?? 0) === 1 ? `Open ${shortUrl(a.urls![0]!)} in a new tab` : `Open ${a.urls?.length ?? 0} tabs`;
    case "closeTabs":
      return `Close tab${(a.tabs?.length ?? 0) === 1 ? "" : "s"} ${(a.tabs ?? []).join(", ")}`;
    case "switchXAccount":
      return `Switch X to ${a.handle ?? "another account"}`;
    case "handleDialog":
      return describeDialogAnswer(a);
  }
}

/** A dialog's text on the card, in the page's own quotes: `Confirm “Delete this item?”`. */
const dialogQuote = (d: JsDialog) => {
  const text = dialogText(d);
  return `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;
};

/** An answer to a page's dialog in plain words: "Leave the page", `Confirm “Delete this item?”`. */
function describeDialogAnswer(a: GateAction): string {
  const d = a.dialog;
  if (!d) return `${a.accept ? "Accept" : "Cancel"} the page's dialog`;
  switch (d.type) {
    case "beforeunload":
      return a.accept ? "Leave the page" : "Stay on the page";
    case "alert":
      return `Close ${dialogQuote(d)}`;
    case "confirm":
      return `${a.accept ? "Confirm" : "Cancel"} ${dialogQuote(d)}`;
    case "prompt":
      return a.accept ? `Answer ${dialogQuote(d)}` : `Cancel ${dialogQuote(d)}`;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** The text the action posts or sends: what was typed on the page before it (never a password), or a prompt's answer. */
function actionText(a: GateAction): string | undefined {
  if (a.method === "handleDialog") return a.dialog?.type === "prompt" && a.accept ? a.text : undefined;
  if (a.method === "type" || a.method === "paste") return a.element?.type === "password" ? undefined : a.text;
  if (a.method !== "click" && a.method !== "pressKey") return undefined;
  const fields = a.typed.filter((t) => t.element.type !== "password" && t.text.trim());
  if (!fields.length) return undefined;
  if (fields.length === 1) return fields[0]!.text;
  return fields.map((t) => `${t.element.name || "Field"}: ${t.text}`).join("\n");
}

/** The approval request for an action that waits. */
export function approvalAsk(a: GateAction, why: string, kind?: ConsequenceKind): Omit<ApprovalRequest, "id" | "expiresAt"> {
  const where = a.method === "navigate" || a.method === "openTabs" ? (a.urls?.[0] ?? "") : a.method === "handleDialog" ? (a.dialog?.url ?? a.page.url) : a.page.url;
  const text = actionText(a);
  return {
    // What publishes on X names the account it publishes as: `Click "Post" as @name`.
    action: kind === "publish" && a.account ? `${describeAction(a)} as ${a.account}` : describeAction(a),
    site: hostOf(where),
    why,
    ...(kind ? { kind } : {}),
    ...(text ? { text: text.length > MAX_CARD_TEXT ? `${text.slice(0, MAX_CARD_TEXT - 1)}…` : text } : {}),
  };
}
