/**
 * Tool execution shared by both brains. Plain tools map 1:1 to browser.*
 * calls; switch_x_account, get_credential, upload checks and task_* are
 * implemented here, act in act.ts. Every call emits tool_call and
 * tool_result events (and one jev event per act decision). Never throws.
 *
 * A task with an X account never publishes on X as another one: a click or
 * key that would post is refused while X's switcher shows another account.
 */
import {
  clipEventText,
  delay,
  dialogAnswerLabel,
  dialogLabel,
  errorMessage,
  formatCents,
  isXSite,
  picksText,
  siteHost,
  TASK_END_TOOLS,
  TOOL_NAMES,
  ToolArgs,
  type AgentEvent,
  type BrowserMethod,
  type BrowserMethods,
  type ElementPicks,
  type PageSnapshot,
  type TaskRunResult,
  type ToolArgsOf,
  type ToolName,
  type ToolResult,
  traceStart,
  traceText,
  type TraceDraft,
  type TraceValue,
} from "@noa/shared";
import type { BrowserCaller, ToolExecutor, ToolExecutorOptions } from "./types.js";
import { createActGate, RefusedActionError, runAct } from "./act.js";
import { unreadInterjection, untilUserSpeaks } from "./interjections.js";
import { formatScroll, formatSnapshot, formatTabs, formatTabSnapshots } from "./page-format.js";
import { mapStrings, SecretRedactor } from "./redact.js";
import { mayPublishKey, switchXAccount, wrongXAccountRefusal } from "./x-account.js";
import { runWaitFor } from "./wait.js";

/** Answer of task_* tools when the executor has no task to end (mcp-server --attach). */
export const NO_TASK_TO_END = "no task to end in an attached session";

const err = (text: string): ToolResult => ({ text, isError: true });

/** Tools that do not change the page: the steps Jev left to the model stay open across them. */
const KEEPS_PENDING = new Set<string>(["act", "read_page", "screenshot", "list_tabs"]);

/**
 * Tools that may wait for a page to load (up to the driver's navigation timeout, 30 s), and which message from the
 * user ends that wait (the load goes on in the browser), so the model reads it now rather than after the load:
 * - "waiting": one it has not read, even one sent before the tool started (navigate and open_tabs start a load
 *   it need not see finish before it reads the message);
 * - "new": one sent while the tool runs (read_page is quick unless the page is still loading; a message already
 *   waiting is read right after it anyway).
 */
const WAITS_FOR_LOAD: Partial<Record<ToolName, "waiting" | "new">> = { navigate: "waiting", open_tabs: "waiting", read_page: "new" };

/** Result of navigate when a message from the user ended its wait for the page. */
export const PAGE_STILL_LOADING = (url: string) =>
  `Opening ${url}: the page was still loading when the user sent you a message (it follows), so this did not wait for it. read_page shows how far it got.`;
/** Result of open_tabs when a message from the user ended its wait for the tabs. */
export const TABS_STILL_LOADING = (count: number) =>
  `Opening ${count} tab(s): they were still loading when the user sent you a message (it follows), so this did not wait for them. list_tabs shows them.`;
/** Result of read_page when a message from the user ended its wait for a page still loading. */
export const READ_STILL_LOADING = "The page was still loading when the user sent you a message (it follows), so it was not read. Call read_page again to read it.";

/** What a tool says when a message from the user ended its wait for a page. */
function stillLoadingText(name: ToolName, args: unknown): string {
  if (name === "navigate") return PAGE_STILL_LOADING((args as ToolArgsOf<"navigate">).url);
  if (name === "open_tabs") return TABS_STILL_LOADING((args as ToolArgsOf<"open_tabs">).urls.length);
  return READ_STILL_LOADING;
}

/** The status line at the end of a turn with Jev on: who picked act's elements. Null when nothing was picked. */
export function picksEvent(picks: ElementPicks): AgentEvent | null {
  if (picks.jev + picks.claude === 0) return null;
  return { type: "status", text: picksText(picks), picks };
}

/** A task_* result with the agent's follow-up suggestion, spoken line and draft, when it gave them. */
function withExtras(
  r: TaskRunResult,
  extras: { suggestion?: string | undefined; spoken?: string | undefined; draft?: string | undefined; memory_note?: string | undefined; output?: string | undefined },
): TaskRunResult {
  const out = { ...r };
  if (extras.suggestion) out.suggestion = extras.suggestion;
  if (extras.spoken) out.spoken = extras.spoken;
  if (extras.draft) out.draft = extras.draft;
  if (extras.memory_note) out.memoryNote = extras.memory_note;
  if (extras.output) out.output = extras.output;
  return out;
}

/** The trace of one tool call: how long it took and how big its answer was (what the model reads). */
function toolSpan(span: { t: number; elapsed: () => number }, id: string, name: string, args: unknown, result: ToolResult, extra?: Record<string, TraceValue>): TraceDraft {
  const data: NonNullable<TraceDraft["data"]> = { tool: name, id, args: traceText(args), chars: result.text?.length ?? 0, ...extra };
  // base64 is 4 characters per 3 bytes.
  if (result.image) data.imageKB = Math.round((result.image.base64.length * 3) / 4 / 1024);
  if (result.isError) {
    data.error = true;
    data.detail = traceText(result.text ?? "");
  }
  return { t: span.t, ms: span.elapsed(), cat: "tool", name: "tool", data };
}

/** handle_dialog's answer: which button it pressed on which dialog, and what that did to the page. */
function dialogAnswered(r: BrowserMethods["browser.handleDialog"]["result"], text: string | undefined): string {
  const { dialog, accepted, tab } = r;
  const pressed = `Pressed ${dialogAnswerLabel(dialog.type, accepted ? "accepted" : "dismissed", dialog.type === "prompt" ? (text ?? dialog.defaultPrompt) : undefined)} on the ${dialogLabel(dialog)} in ${tab}.`;
  if (dialog.type !== "beforeunload") return `${pressed} Read the page to see what it did.`;
  return accepted
    ? `${pressed} Left the page: the navigation or tab close goes on. Read the page or list_tabs to see where things are now.`
    : `${pressed} Stayed on the page: nothing was navigated or closed, and its unsaved changes are still there.`;
}

/** Case- and slash-insensitive path key, for comparing upload paths with mediaPaths. */
function pathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const sleep = opts.sleep ?? delay;
  const now = opts.now ?? Date.now;
  const secrets = opts.secrets ?? new SecretRedactor();
  /** Allowed upload paths by pathKey, to the exact path the task listed. */
  const allowedMedia = new Map(opts.mediaPaths.map((p) => [pathKey(p), p]));
  let nextId = 1;
  /** Jev on: read_page lists elements in words and act steps name indices only after Jev was unsure. */
  const jevOn = opts.jev !== null;
  const gate = createActGate();

  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent(secrets.redact(e));
    } catch {
      /* a listener must not break tool execution */
    }
  };
  const trace = opts.onTrace
    ? (e: TraceDraft) => {
        try {
          opts.onTrace!(secrets.redact(e));
        } catch {
          /* a listener must not break tool execution */
        }
      }
    : undefined;
  /** Notes the browser attaches to results (e.g. "Using fallback mode…"), shown once with the next tool result. */
  const notes: string[] = [];
  /**
   * The current tab's last page read: what the agent's element indices point at. Null when not known (another
   * page or tab since): then the X account check reads it.
   */
  let page: PageSnapshot | null = null;
  const follow = (method: BrowserMethod, params: unknown, result: unknown) => {
    if (method === "browser.readPage") page = (params as { tab?: string }).tab ? null : (result as PageSnapshot);
    else if (method === "browser.navigate" || method === "browser.switchTab" || method === "browser.openTabs" || method === "browser.closeTabs" || method === "browser.clickXAccountEntry" || method === "browser.handleDialog") page = null;
  };
  /** Throws the refusal of a click or key that would publish on X while it is signed in as another account than the task's. */
  const checkXAccount = async (account: string, action: Parameters<typeof wrongXAccountRefusal>[1]) => {
    if (action.method === "browser.pressKey" && !mayPublishKey(action.key)) return;
    page ??= await opts.browser.call("browser.readPage", {});
    const refusal = wrongXAccountRefusal(page, action, account);
    if (refusal) throw new RefusedActionError(refusal);
  };
  const browser = async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => {
    if (opts.account && method === "browser.click") await checkXAccount(opts.account, { method, index: (params as BrowserMethods["browser.click"]["params"]).index });
    if (opts.account && method === "browser.pressKey") await checkXAccount(opts.account, { method, key: (params as BrowserMethods["browser.pressKey"]["params"]).key });
    const r = await opts.browser.call(method, params);
    follow(method, params, r);
    const note = r && typeof r === "object" ? (r as { note?: unknown }).note : undefined;
    if (typeof note === "string" && note && !notes.includes(note)) notes.push(note);
    return r;
  };
  const noted: BrowserCaller = { call: browser };

  /** `value` holds a password get_credential handed out in this run. */
  const containsKnownSecret = (value: unknown) => {
    const text = JSON.stringify(value);
    return secrets.redact(text) !== text;
  };

  const endTask = (r: TaskRunResult, reply: string): ToolResult => {
    if (!opts.onTaskEnd) return err(`${NO_TASK_TO_END}. Just tell the human what happened.`);
    opts.onTaskEnd(r);
    return { text: reply };
  };

  /** extra: what the call adds to its trace span (wait_for: why and after how long it stopped waiting). */
  async function run(name: ToolName, a: unknown, extra: { trace?: Record<string, TraceValue> }): Promise<ToolResult> {
    switch (name) {
      case "navigate": {
        const r = await browser("browser.navigate", { url: (a as ToolArgsOf<"navigate">).url });
        return { text: `Navigated to ${r.url}\nTitle: ${r.title}` };
      }
      case "read_page": {
        const { tabs } = a as ToolArgsOf<"read_page">;
        if (!tabs) return { text: formatSnapshot(await browser("browser.readPage", {}), { words: jevOn }) };
        // Every tab is read at the same time; one failing tab does not hide the others.
        const ids = [...new Set(tabs)];
        const reads = await Promise.all(
          ids.map((tab) =>
            browser("browser.readPage", { tab }).then(
              (snap) => ({ tab, snap }),
              (e: unknown) => ({ tab, error: errorMessage(e) }),
            ),
          ),
        );
        const text = formatTabSnapshots(reads, { words: jevOn });
        return reads.every((r) => "error" in r) ? err(text) : { text };
      }
      case "open_tabs": {
        const { urls, background } = a as ToolArgsOf<"open_tabs">;
        const params: BrowserMethods["browser.openTabs"]["params"] = { urls };
        if (background !== undefined) params.background = background;
        const r = await browser("browser.openTabs", params);
        const ids = r.tabs.map((t) => t.id);
        return {
          text: `Opened ${r.tabs.length} tab(s):\n${formatTabs(r.tabs)}\nRead them together with read_page {"tabs": ${JSON.stringify(ids)}}; use switch_tab to act in one.`,
        };
      }
      case "switch_tab": {
        const t = await browser("browser.switchTab", { tab: (a as ToolArgsOf<"switch_tab">).tab });
        return { text: `Current tab is now ${t.id}: ${t.url}\nTitle: ${t.title}` };
      }
      case "list_tabs":
        return { text: formatTabs((await browser("browser.listTabs", {})).tabs) };
      case "close_tabs": {
        const r = await browser("browser.closeTabs", { tabs: (a as ToolArgsOf<"close_tabs">).tabs });
        return { text: `Closed ${r.closed.length ? r.closed.join(", ") : "no tabs"}. Open tabs:\n${formatTabs(r.tabs)}` };
      }
      case "handle_dialog": {
        const { accept, text, tab } = a as ToolArgsOf<"handle_dialog">;
        const params: BrowserMethods["browser.handleDialog"]["params"] = { accept };
        if (text !== undefined) params.text = text;
        if (tab !== undefined) params.tab = tab;
        return { text: dialogAnswered(await browser("browser.handleDialog", params), text) };
      }
      case "screenshot": {
        const shot = await browser("browser.screenshot", {});
        return { image: { base64: shot.base64, mimeType: shot.mimeType } };
      }
      case "click": {
        const { index } = a as ToolArgsOf<"click">;
        await browser("browser.click", { index });
        return { text: `Clicked [${index}].` };
      }
      case "type": {
        const { index, text } = a as ToolArgsOf<"type">;
        await browser("browser.type", { index, text });
        return { text: `Typed ${text.length} characters into [${index}].` };
      }
      case "paste": {
        const { text } = a as ToolArgsOf<"paste">;
        await browser("browser.paste", { text });
        return { text: `Inserted ${text.length} characters at the focus.` };
      }
      case "press_key": {
        const { key } = a as ToolArgsOf<"press_key">;
        await browser("browser.pressKey", { key });
        return { text: `Pressed ${key}.` };
      }
      case "scroll": {
        const { direction, amount, index } = a as ToolArgsOf<"scroll">;
        const params: BrowserMethods["browser.scroll"]["params"] = { direction };
        if (amount !== undefined) params.amount = amount;
        if (index !== undefined) params.index = index;
        const r = await browser("browser.scroll", params);
        return { text: formatScroll({ direction, amount, index }, r ?? {}) };
      }
      case "upload": {
        const { index, paths } = a as ToolArgsOf<"upload">;
        const bad = paths.filter((p) => !allowedMedia.has(pathKey(p)));
        if (bad.length) {
          const allowed = allowedMedia.size ? [...allowedMedia.values()].map((p) => `- ${p}`).join("\n") : "(none)";
          return err(`upload refused: ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not in the task's media list. Allowed files:\n${allowed}`);
        }
        // The files exactly as the task listed them: the check above ignores case and slashes, a file system may not.
        const r = await browser("browser.upload", { index, paths: paths.map((p) => allowedMedia.get(pathKey(p))!) });
        // A drop or paste the page accepted may still have gone elsewhere (a page that takes drops anywhere).
        if (r?.via === "drop" || r?.via === "paste") {
          return { text: `${r.via === "drop" ? "Dropped" : "Pasted"} ${paths.length} file(s) on [${index}]; check that the page shows them.` };
        }
        return { text: `Attached ${paths.length} file(s) to [${index}].` };
      }
      case "get_credential": {
        const { site } = a as ToolArgsOf<"get_credential">;
        if (isXSite(site)) return err("get_credential is never used for X. Sign-in to X is done by the human; call task_pause if X asks to log in.");
        const host = siteHost(site);
        const r = await browser("vault.getCredential", { site: host });
        if (!r.found) {
          return r.locked
            ? err(
                `The user's saved site logins are locked. If ${host} is asking you to sign in, call task_pause with the reason "Sign in to ${host} in this tab (or unlock saved logins in Settings > Site logins), then press Continue."`,
              )
            : err(
                `No login is saved for ${host}. First check whether the user is already signed in there. Only if it shows a sign-in page, call task_pause with the reason "Please sign in to ${host} in this tab, then press Continue." Never mention a vault.`,
              );
        }
        secrets.add(r.password);
        return { text: `username: ${r.username}\npassword: ${r.password}` };
      }
      case "generate_image": {
        const r = await browser("media.generateImage", a as ToolArgsOf<"generate_image">);
        // The new file is the agent's to upload, like the task's own media.
        allowedMedia.set(pathKey(r.path), r.path);
        return {
          text: `Created the image (${r.size}, ${r.quality} quality, ${formatCents(r.chargedCents)}) and saved it in the user's Noa folder: ${r.path}\nThis is a smaller preview of it. To put it on a page, upload this path. Tell the user where it is saved.`,
          image: r.preview,
        };
      }
      case "wait_for": {
        const w = await runWaitFor(a as ToolArgsOf<"wait_for">, {
          browser,
          sleep,
          now,
          ...(opts.interjections ? { interjections: opts.interjections } : {}),
          ...(opts.turnEndsAt ? { turnEndsAt: opts.turnEndsAt } : {}),
        });
        extra.trace = w.trace;
        return w.result;
      }
      case "switch_x_account":
        return switchXAccount(noted, (a as ToolArgsOf<"switch_x_account">).handle, { sleep });
      case "act":
        return runAct((a as ToolArgsOf<"act">).steps, {
          browser,
          jev: opts.jev,
          jevThreshold: opts.jevThreshold,
          sleep,
          emit,
          gate,
          ...(trace ? { trace } : {}),
          ...(opts.interjections ? { interrupted: () => opts.interjections!.unseen, userSpeaks: () => opts.interjections!.spoken(true) } : {}),
          // The hosted Jev and the hosted AI share one credit: pause the task, like a 402 from the Messages API does.
          outOfCredit: (e) =>
            endTask(
              { outcome: "paused", reason: e.pauseReason },
              `Task paused: the account ${e.shortfall ? "has too little usage credit for this request" : "is out of usage credit"}. Stop now.`,
            ),
        });
      case "schedule_task":
      case "list_scheduled_tasks":
      case "update_scheduled_task":
      case "cancel_scheduled_task": {
        if (!opts.todo) return err(`${name} is not available here: the TODO list belongs to a Noa chat. Tell the user to ask in the Noa chat.`);
        const r = await opts.todo(name, a);
        return r.isError ? err(r.text) : { text: r.text };
      }
      case "remember":
      case "recall":
      case "forget":
      case "search_history":
      case "check_similar": {
        if (!opts.memory) return err(`${name} is not available here: memory belongs to a Noa chat or task.`);
        // A password get_credential handed out in this run is never kept (the secrets live here, in the executor).
        if (name === "remember" && containsKnownSecret(a)) return err("Not saved: it contains a password you were given. Memory never keeps passwords.");
        const r = await opts.memory(name, a);
        return r.isError ? err(r.text) : { text: r.text };
      }
      case "task_complete": {
        const { summary, url, ...extras } = a as ToolArgsOf<"task_complete">;
        const r: TaskRunResult = { outcome: "done", summary };
        if (url) r.url = url;
        // A run note or output holding a password the agent was given is dropped (memory never keeps passwords).
        if (extras.memory_note && containsKnownSecret(extras.memory_note)) delete extras.memory_note;
        if (extras.output && containsKnownSecret(extras.output)) delete extras.output;
        return endTask(withExtras(r, extras), "Task recorded as done. Stop now.");
      }
      case "task_fail": {
        const { reason, ...extras } = a as ToolArgsOf<"task_fail">;
        return endTask(withExtras({ outcome: "failed", reason, byAgent: true }, extras), "Task recorded as failed. Stop now.");
      }
      case "task_pause": {
        const { reason, ...extras } = a as ToolArgsOf<"task_pause">;
        return endTask(withExtras({ outcome: "paused", reason, byAgent: true }, extras), "Task paused for the human. Stop now.");
      }
    }
  }

  return {
    allowMedia(paths) {
      for (const p of paths) allowedMedia.set(pathKey(p), p);
    },
    takePicks() {
      const p = { ...gate.picks };
      gate.picks = { jev: 0, claude: 0 };
      return p;
    },
    async call(name: ToolName, args: unknown): Promise<ToolResult> {
      const id = `t${nextId++}`;
      const span = traceStart();
      // Candidates Jev left to the model stay valid only while the page is left alone.
      if (!KEEPS_PENDING.has(name)) gate.pending.clear();
      // Arguments can be long (a pasted text): each string is clipped like any other event text.
      const shownArgs = mapStrings(args ?? {}, (s) => clipEventText(s));
      emit({ type: "tool_call", id, name, args: shownArgs });
      let result: ToolResult;
      const extra: { trace?: Record<string, TraceValue> } = {};
      try {
        if (!(TOOL_NAMES as string[]).includes(name)) {
          result = err(`Unknown tool ${String(name)}.`);
        } else {
          const parsed = ToolArgs[name].safeParse(args ?? {});
          if (!parsed.success) {
            const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
            result = err(`Invalid arguments for ${name}: ${msg}`);
          } else if (TASK_END_TOOLS.includes(name) && opts.interjections?.unseen) {
            // The user spoke after the model decided to end: the turn goes on with their message.
            result = err(unreadInterjection(name));
          } else if (WAITS_FOR_LOAD[name] && opts.interjections) {
            const spoken = opts.interjections.spoken(WAITS_FOR_LOAD[name] === "new");
            result = await untilUserSpeaks(run(name, parsed.data, extra), spoken, () => ({ text: stillLoadingText(name, parsed.data) }));
          } else {
            result = await run(name, parsed.data, extra);
          }
        }
      } catch (e) {
        result = err(`${name} failed: ${errorMessage(e)}`);
      }
      if (notes.length) {
        // Both the model and the Activity log see why the page behaves differently.
        const prefix = notes.splice(0).join("\n");
        result = { ...result, text: result.text ? `${prefix}\n${result.text}` : prefix };
      }
      const ev: Extract<AgentEvent, { type: "tool_result" }> = { type: "tool_result", id, name };
      const text = name === "get_credential" && !result.isError ? "[credential redacted]" : (result.text ?? (result.image ? "[screenshot]" : undefined));
      if (text !== undefined) ev.text = clipEventText(text);
      if (result.isError) ev.isError = true;
      // A picture the agent made is shown in the chat (screenshots are not: they would crowd it).
      if (name === "generate_image" && result.image?.mimeType === "image/jpeg") ev.thumbnail = result.image.base64;
      emit(ev);
      trace?.(toolSpan(span, id, name, shownArgs, result, extra.trace));
      return result;
    },
  };
}
