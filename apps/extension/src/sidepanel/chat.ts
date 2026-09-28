/**
 * A job's conversation, live (every turn of it in one thread: the user's messages as bubbles, starting with the
 * prompt or task that opened it, the agent's text, tool calls and results (Jev's picks are for Raw), and what hands-free voice
 * said aloud, shown playing while it is said; with Realtime voice the user's own words take the place of the request
 * the narrator sent for them), on the job's page (job-page.ts), which also puts the job's runs and instructions above it
 * (setBefore) and opens Raw (the conversation with its timings, raw-view.ts) in place of the log. Which conversation
 * that is comes from sidepanel.ts.
 */
import { errorMessage, type SessionInfo, type StampedAgentEvent } from "@noa/shared";
import { isContinuableOutcome } from "../continue.js";
import { uiRequest } from "../ui-protocol.js";
import { $, h } from "../ui/dom.js";
import { errorHelp } from "./error-help.js";
import { renderErrorHelp } from "./error-view.js";
import { pausedRequest } from "../approval/paused.js";
import { describeEvent, hiddenInChat, isNearBottom, openingTurn, sameWords, scheduledView, spokenEchoes, turnError, type TurnContext } from "./event-format.js";
import {
  placeEvent,
  pruneContinue,
  renderEvent,
  renderMemoryNote,
  renderOpening,
  renderScheduled,
  renderSessionHead,
  renderSpoken,
  renderText,
  type MemoryNoteActions,
  type ScheduledCardActions,
} from "./event-render.js";
import { memoryNoteView } from "./memory-note.js";
import { LiveTexts } from "./live-text.js";
import { bindApprovalKeys, renderApproval, type ApprovalCardActions } from "./approval-card.js";
import { approvalEnding, approvalView } from "./approval-view.js";
import { MarkdownView } from "./markdown.js";
import { initRawView } from "./raw-view.js";
import type { ReportEnv } from "../trace/trace-report.js";

export interface ChatView {
  /** The running sessions from UiState, oldest first (several tasks can run at once). */
  setRunning(sessions: readonly SessionInfo[]): void;
  onEvent(ev: StampedAgentEvent): void;
  onSession(session: SessionInfo): void;
  /**
   * Show this conversation; null: none (the list is shown, or a job that never ran). It shows at its end, or with
   * `top` at its top (what goes above it in view: a run picked in a job's runs, and back from it to the list).
   */
  show(sessionId: string | null, opts?: { top?: boolean }): void;
  /** The conversation shown, or null. */
  shown(): SessionInfo | null;
  /** What goes above the conversation, in the same scroll (a task's runs and instructions; a task that never ran); null: nothing. */
  setBefore(el: HTMLElement | null): void;
  /** Raw (the conversation with its timings) in place of the log, or the log again. */
  setRaw(on: boolean): void;
  /** Raw is open. */
  readonly rawOpen: boolean;
  /**
   * Hands-free voice is saying a line in a chat (null: the line is over). It shows playing at the end of that
   * chat until its kept copy (a "spoken" event) takes its place.
   */
  setSpeaking(line: { sessionId: string; text: string } | null): void;
}

export interface ChatOptions {
  /** The Continue button in a task_end card. */
  onContinue?(sessionId: string): void;
  /** The conversation shown changed (null: none). */
  onFocus?(session: SessionInfo | null): void;
  /** The conversation's first message was picked: show its task's details. */
  onDetails?(session: SessionInfo, trigger: HTMLElement): void;
  /** What the panel knows about voice, for the Raw view's export. */
  voiceEnv?(): ReportEnv["voice"];
  /** View on a scheduled card: that task's job. */
  onOpenTask?(taskId: string): void;
  /** Raw opened or closed (by the view's own Back too). */
  onRaw?(open: boolean): void;
}

const eventKey = (e: StampedAgentEvent) => JSON.stringify(e);
/** Recent events of conversations not on screen, kept for when one is shown: at most this many. */
const MAX_BUFFERED_EVENTS = 300;

/** How the buttons in a conversation's events act. */
interface EventHandlers {
  onContinue?: (sessionId: string) => void;
  scheduled?: ScheduledCardActions;
  approval?: ApprovalCardActions;
  memory?: MemoryNoteActions;
}

/**
 * The element of events[i] with its view (for placing it in the log), or null when it shows nothing of its own.
 * `session`: the conversation, when known (a cloud run cannot be continued from here); `running`: it runs now (a card
 * its run paused at is decided only once it stopped).
 */
function eventNode(
  events: readonly StampedAgentEvent[],
  i: number,
  session: SessionInfo | null,
  on: EventHandlers,
  running = false,
): { el: HTMLElement; view: ReturnType<typeof describeEvent> } | null {
  const e = events[i]!;
  // What the Raw view keeps for itself (hiddenInChat).
  if (hiddenInChat(events, i)) return null;
  // An undo changes its task's card (see markUndone); it shows nothing of its own.
  if (e.type === "task_unscheduled" || e.type === "task_change_undone") return null;
  // An approval's ending changes its card (see refreshApprovals).
  if (e.type === "approval_resolved") return null;
  // An undo changes its memory note (see markMemoryUndone).
  if (e.type === "memory_undone") return null;
  // Words that led to no request are kept for the record (Raw), not shown.
  if (e.type === "heard") return null;
  const s = e.type === "task_end" && session?.sessionId === e.sessionId ? session : null;
  const canContinue = !!on.onContinue && e.type === "task_end" && isContinuableOutcome(e.outcome) && s?.source !== "cloud";
  const undone = (taskId: string) => events.some((x) => x.type === "task_unscheduled" && x.taskId === taskId);
  const changeUndone = (changeId: string) => events.some((x) => x.type === "task_change_undone" && x.changeId === changeId);
  const memoryUndone = (changeId: string) => events.some((x) => x.type === "memory_undone" && x.changeId === changeId);
  const turn: TurnContext =
    e.type === "task_end"
      ? { error: turnError(events, i) }
      : e.type === "spoken"
        ? { echo: spokenEchoes(events, i) }
        : e.type === "task_scheduled"
          ? { undone: undone(e.taskId) }
          : e.type === "task_changed"
            ? { undone: changeUndone(e.changeId) }
            : e.type === "approval_request"
              ? { approval: approvalEnding(events, e.request.id), decidable: !running && pausedRequest(events, e.request.id) !== null }
              : e.type === "memory"
                ? { memoryUndone: memoryUndone(e.changeId) }
                : {};
  const view = describeEvent(e, turn);
  const el = renderEvent(view, canContinue ? () => on.onContinue?.(e.sessionId) : undefined, on.scheduled, on.approval, on.memory);
  return { el, view };
}

export function initChat(opts: ChatOptions = {}): ChatView {
  const log = $("chat-log");
  const rawHost = $("chat-raw");
  const raw = initRawView(rawHost, { voiceEnv: () => opts.voiceEnv?.(), onBack: () => setRaw(false) });
  /** Above the conversation: a task's runs and instructions, or a task that never ran. */
  let before: HTMLElement | null = null;

  /** Raw in place of the log (true), or the log (false). */
  function setRaw(on: boolean): void {
    const id = on ? shownId : null;
    const was = raw.shown !== null;
    if (id) raw.open(id);
    else raw.close();
    rawHost.hidden = !id;
    log.hidden = !!id;
    if (was !== !!id) opts.onRaw?.(!!id);
  }

  /** The id of the conversation shown (set at once), and its info once known. */
  let shownId: string | null = null;
  /** The conversation shown was asked for at its top (show's `top`): drawing it leaves the scroll where it is. */
  let atTop = false;
  let current: SessionInfo | null = null;
  let events: StampedAgentEvent[] = [];
  let backfilling = false;
  /** Recent events of every session, for a conversation shown after they arrived. */
  let buffered: StampedAgentEvent[] = [];
  /** Every running session. */
  let runningList: readonly SessionInfo[] = [];
  /** onFocus starts after init: the first view (nothing shown) needs no notice, and callers may not be wired yet. */
  let ready = false;

  /** Text Claude is still writing, and its elements while its conversation is shown. */
  const live = new LiveTexts();
  const liveEls = new Map<string, { el: HTMLElement; view: MarkdownView }>();
  let paintQueued = false;

  /**
   * The buttons of TODO cards: View (the task's job), and Undo (the card turns "undone" when its task_unscheduled, or a
   * changed card's task_change_undone, arrives).
   */
  const scheduledActions: ScheduledCardActions = {
    view: (taskId) => opts.onOpenTask?.(taskId),
    undo: async (taskId) => {
      if (current) await uiRequest({ type: "chat.undoScheduled", sessionId: current.sessionId, taskId });
    },
    undoChange: async (changeId) => {
      if (current) await uiRequest({ type: "chat.undoTaskChange", sessionId: current.sessionId, changeId });
    },
  };

  /** Undo on memory notes (the note turns "undone" when its memory_undone arrives). */
  const memoryActions: MemoryNoteActions = {
    undo: async (changeId) => {
      if (current) await uiRequest({ type: "memory.undo", sessionId: current.sessionId, changeId });
    },
  };

  /** An undone memory change's note, wherever it is in the log, now says so. */
  function markMemoryUndone(changeId: string): void {
    const ev = events.find((e) => e.type === "memory" && e.changeId === changeId);
    const note = [...log.querySelectorAll<HTMLElement>(".ev-memory")].find((c) => c.dataset.changeId === changeId);
    if (ev?.type === "memory" && note) note.replaceWith(renderMemoryNote(memoryNoteView(ev, true)));
  }

  /** The answers of approval cards (the card changes when its approval_resolved arrives); Alt+Y / Alt+T / Alt+N too. */
  const approvalActions: ApprovalCardActions = {
    answer: async (id, answer, by) => (current ? (await uiRequest({ type: "approval.answer", sessionId: current.sessionId, id, answer, by })).ok : false),
  };
  bindApprovalKeys(log);

  /** The conversation shown runs now. */
  const isRunning = () => !!current && runningList.some((s) => s.sessionId === current!.sessionId);

  /**
   * Approval cards follow how they ended once that is known (answered, timed out, the turn ended, or its run paused
   * there: then it can be decided until it is, or the run goes on).
   */
  function refreshApprovals(): void {
    const running = isRunning();
    for (const card of log.querySelectorAll<HTMLElement>(".ev-approval")) {
      const id = card.dataset.approvalId ?? "";
      const ev = events.find((e) => e.type === "approval_request" && e.request.id === id);
      const ending = approvalEnding(events, id);
      if (ev?.type !== "approval_request" || !ending) continue;
      const v = approvalView(ev, ending, !running && pausedRequest(events, id) !== null);
      if (card.dataset.outcome === v.state && (card.dataset.decidable === "true") === !!v.decidable) continue;
      card.replaceWith(renderApproval(v, v.decidable ? approvalActions : undefined));
    }
  }

  /** An undone task's card, wherever it is in the log, now says so. */
  function markUndone(taskId: string): void {
    const ev = events.find((e) => e.type === "task_scheduled" && e.taskId === taskId);
    const card = [...log.querySelectorAll<HTMLElement>(".ev-scheduled")].find((c) => c.dataset.taskId === taskId);
    if (ev?.type === "task_scheduled" && card) card.replaceWith(renderScheduled(scheduledView(ev, true)));
  }

  /** An undone change's card, wherever it is in the log, now says so. */
  function markChangeUndone(changeId: string): void {
    const ev = events.find((e) => e.type === "task_changed" && e.changeId === changeId);
    const card = [...log.querySelectorAll<HTMLElement>(".ev-scheduled")].find((c) => c.dataset.changeId === changeId);
    if (ev?.type === "task_changed" && card) card.replaceWith(renderScheduled(scheduledView(ev, true)));
  }

  const handlers: EventHandlers = {
    ...(opts.onContinue ? { onContinue: opts.onContinue } : {}),
    scheduled: scheduledActions,
    approval: approvalActions,
    memory: memoryActions,
  };

  function renderOne(ev: StampedAgentEvent, i: number): void {
    const node = eventNode(events, i, current, handlers, isRunning());
    if (!node) return;
    if (ev.type === "spoken") placeKept(node.el, ev.text);
    else placeEvent(log, node.el, node.view);
  }

  /** The line hands-free voice is saying now (in any chat). */
  let speaking: { sessionId: string; text: string } | null = null;
  /** Live copies of lines said in the chat shown, oldest first: the one playing, and said ones waiting for their kept copy. */
  let lives: HTMLElement[] = [];

  /** A kept line takes its live copy's place; one said before the live ones goes before them. */
  function placeKept(el: HTMLElement, text: string): void {
    lives = lives.filter((l) => l.isConnected);
    const i = lives.findIndex((l) => sameWords(l.dataset.text ?? "", text));
    if (i >= 0) {
      lives[i]!.replaceWith(el);
      lives.splice(i, 1);
    } else if (lives[0]) lives[0].before(el);
    else log.append(el);
  }

  /** Shows the line being said at the end of its chat, playing (the Realtime narrator's words grow in place). */
  function showSpeaking(): void {
    lives = lives.filter((l) => l.isConnected);
    const last = lives.at(-1);
    const line = speaking && current?.sessionId === speaking.sessionId && !backfilling ? speaking : null;
    if (!line) {
      last?.classList.remove("playing");
      return;
    }
    const follow = isNearBottom(log);
    const el = renderSpoken({ kind: "spoken", text: line.text });
    el.classList.add("live", "playing");
    el.dataset.text = line.text;
    log.querySelector(":scope > p.empty")?.remove();
    if (last?.classList.contains("playing")) {
      last.replaceWith(el);
      lives[lives.length - 1] = el;
    } else {
      log.append(el);
      lives.push(el);
    }
    if (follow) log.scrollTop = log.scrollHeight;
  }

  /** Repaints the shown conversation's live texts, once per frame; a new one starts at the end of the log. */
  function paintLive(): void {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (!current || backfilling) return;
      const follow = isNearBottom(log);
      for (const [id, text] of live.of(current.sessionId)) {
        if (!text.trim()) continue;
        let e = liveEls.get(id);
        if (!e?.el.isConnected) {
          const el = h("div.ev-text.md.streaming", { "data-stream": id });
          e = { el, view: new MarkdownView(el) };
          liveEls.set(id, e);
          log.querySelector(":scope > p.empty")?.remove();
          log.append(el);
        }
        e.view.update(text, true);
      }
      if (follow) log.scrollTop = log.scrollHeight;
    });
  }

  /**
   * Updates live texts for an event of any conversation. A final
   * assistant_text takes the place of its live text (same spot, final
   * rendering); live texts of earlier messages that never got theirs are
   * removed; at task_end what is still live stays as written. True when the
   * event's own text replaced a live one (so it needs no element of its own).
   */
  function settleLive(ev: StampedAgentEvent): boolean {
    const r = live.settle(ev);
    for (const id of r.drop) liveEls.get(id)?.el.remove();
    for (const id of r.freeze) liveEls.get(id)?.el.classList.remove("streaming");
    for (const id of [...r.drop, ...r.freeze]) liveEls.delete(id);
    if (!r.replaces) return false;
    const e = liveEls.get(r.replaces);
    liveEls.delete(r.replaces);
    if (!e?.el.isConnected || ev.type !== "assistant_text") return false;
    e.el.replaceWith(renderText(ev.text.trim(), r.replaces));
    return true;
  }

  /** The log drawn again under what goes above it, which stays in place (so the focus in it stays too). */
  function resetLog(...nodes: Node[]): void {
    if (before && log.firstChild === before) {
      while (before.nextSibling) before.nextSibling.remove();
      log.append(...nodes);
    } else log.replaceChildren(...(before ? [before] : []), ...nodes);
  }

  function renderLog(): void {
    if (!shownId) {
      resetLog();
      return;
    }
    if (!current) {
      resetLog(h("p.empty", null, "Loading…"));
      return;
    }
    lives = [];
    resetLog(renderOpeningOf(current), renderSessionHead(current));
    events.forEach((ev, i) => renderOne(ev, i));
    liveEls.clear();
    showSpeaking();
    if (!events.length && !live.of(current.sessionId).some(([, t]) => t.trim())) log.append(h("p.empty", null, "Waiting for the agent…"));
    pruneContinue(log);
    paintLive();
    if (!atTop) log.scrollTop = log.scrollHeight;
  }

  function refreshHead(s: SessionInfo): void {
    log.querySelector(":scope > .ev-head")?.replaceWith(renderSessionHead(s));
  }

  /** The conversation's first message (its prompt), which opens its details. */
  function renderOpeningOf(s: SessionInfo): HTMLElement {
    const v = openingTurn(s, events);
    // The details of the session as it is now (it ends, gets an outcome, ...).
    const el = renderOpening(v, (trigger) => opts.onDetails?.(current ?? s, trigger));
    el.dataset.files = String(v.files ?? 0);
    return el;
  }

  /** The first turn's files are known once its "Preparing N file(s)" line arrives. */
  function refreshOpening(): void {
    const el = log.querySelector<HTMLElement>(":scope > .ev-opening");
    if (current && el && el.dataset.files !== String(openingTurn(current, events).files ?? 0)) el.replaceWith(renderOpeningOf(current));
  }

  function render(): void {
    renderLog();
    log.classList.toggle("busy", !!current && runningList.some((s) => s.sessionId === current!.sessionId));
    if (ready) opts.onFocus?.(current);
  }

  async function load(sessionId: string): Promise<void> {
    const known = runningList.find((s) => s.sessionId === sessionId) ?? null;
    current = known;
    events = buffered.filter((e) => e.sessionId === sessionId);
    backfilling = true;
    render();
    try {
      const res = await uiRequest({ type: "sessions.events", sessionId });
      if (shownId !== sessionId) return;
      current = runningList.find((s) => s.sessionId === sessionId) ?? res.session ?? current;
      const seen = new Set(res.events.map(eventKey));
      events = [...res.events, ...events.filter((e) => !seen.has(eventKey(e)))];
    } catch (err) {
      // Live pushes still arrive; the backfill is best effort.
      if (shownId === sessionId && !current) {
        backfilling = false;
        const help = errorHelp(errorMessage(err));
        log.replaceChildren(renderErrorHelp({ ...help, message: "This chat couldn't be loaded.", details: errorMessage(err) }));
        return;
      }
    } finally {
      if (shownId === sessionId) backfilling = false;
    }
    if (shownId === sessionId) render();
  }

  function append(ev: StampedAgentEvent): void {
    events.push(ev);
    if (backfilling || !current) {
      settleLive(ev);
      return;
    }
    if (ev.type === "task_unscheduled") {
      markUndone(ev.taskId);
      return;
    }
    if (ev.type === "task_change_undone") {
      markChangeUndone(ev.changeId);
      return;
    }
    if (ev.type === "approval_resolved") {
      refreshApprovals();
      return;
    }
    if (ev.type === "memory_undone") {
      markMemoryUndone(ev.changeId);
      return;
    }
    // A turn's end, or a new message: a card its run paused at can be decided, or not any more.
    if (ev.type === "task_end" || ev.type === "user_message") refreshApprovals();
    const follow = isNearBottom(log);
    log.querySelector(":scope > p.empty")?.remove();
    // The final text of a streamed block takes the place of its live text.
    if (!settleLive(ev)) renderOne(ev, events.length - 1);
    if (ev.type === "status") refreshOpening();
    pruneContinue(log);
    if (follow) log.scrollTop = log.scrollHeight;
  }

  // A log read at its bottom stays there when it gets shorter (the header grows, the panel is resized).
  // Scrolling up lets go of the bottom, reaching it again holds it. (Not "is it near the bottom now": a
  // scroll event can come after the log already got shorter, and that must not let go.)
  let pinned = true;
  let lastTop = 0;
  log.addEventListener(
    "scroll",
    () => {
      if (log.scrollTop < lastTop - 1) pinned = false;
      if (isNearBottom(log)) pinned = true;
      lastTop = log.scrollTop;
    },
    { passive: true },
  );
  // (Also when its content grows after rendering, e.g. once fonts load: every top-level entry is watched.) What goes
  // above the conversation growing while the user works in it (a job's runs list opened) leaves the scroll alone.
  const stick = new ResizeObserver(() => {
    if (pinned && !before?.contains(document.activeElement)) log.scrollTop = log.scrollHeight;
  });
  stick.observe(log);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) stick.observe(n);
  }).observe(log, { childList: true });

  render();
  ready = true;

  return {
    setRunning(sessions) {
      runningList = sessions;
      const watching = current ? sessions.find((s) => s.sessionId === current!.sessionId) : undefined;
      // Continue buttons wait until the shown conversation's turn ends.
      log.classList.toggle("busy", !!watching);
      if (watching) {
        current = watching;
        refreshHead(current);
      }
    },
    onEvent(ev) {
      raw.touched(ev.sessionId);
      if (ev.type === "assistant_text_delta") {
        live.add(ev);
        if (shownId && ev.sessionId === shownId) paintLive();
        return;
      }
      if (shownId && ev.sessionId === shownId) append(ev);
      else {
        settleLive(ev);
        buffered = [...buffered.slice(-MAX_BUFFERED_EVENTS), ev];
      }
    },
    onSession(s) {
      raw.touched(s.sessionId);
      if (s.sessionId !== shownId) return;
      current = s;
      refreshHead(current);
      if (s.endedAt) log.scrollTop = log.scrollHeight;
      opts.onFocus?.(current);
    },
    show(sessionId, opts = {}) {
      if (sessionId === shownId) return;
      // At its top: the log is not held at its end while this conversation is shown (until the reader scrolls there).
      atTop = !!opts.top;
      if (atTop) {
        pinned = false;
        log.scrollTop = 0;
      }
      // Raw shows one conversation: another one on screen goes back to its chat.
      if (raw.shown !== null) setRaw(false);
      // Events of the conversation that was shown stay available if it comes back.
      if (shownId) buffered = [...buffered, ...events].slice(-MAX_BUFFERED_EVENTS);
      shownId = sessionId;
      if (!sessionId) {
        current = null;
        events = [];
        backfilling = false;
        render();
        return;
      }
      void load(sessionId);
    },
    shown() {
      return current;
    },
    setBefore(el) {
      if (el === before) return;
      const old = before;
      before = el;
      if (old?.parentElement === log) {
        if (el) old.replaceWith(el);
        else old.remove();
      } else if (el && log.firstChild !== el) log.prepend(el);
    },
    setRaw,
    get rawOpen() {
      return raw.shown !== null;
    },
    setSpeaking(line) {
      speaking = line;
      showSpeaking();
    },
  };
}
