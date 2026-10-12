/** Pure view models for agent events in a job's conversation. */
import { ANSWER_TOOL, describeSchedule, dialogLine, localTimeZone, SCREEN_HELP_TEXT, type AgentEvent, type AttachmentRef, type Chip, type SessionInfo, type TaskSource, type TodoChange } from "@noa/shared";
import { repeatsPausedCard } from "../approval/paused.js";
import { clip, isLongSummary, toolArgsSummary } from "../text.js";
import { speakable } from "../voice/spoken-line.js";
import { errorHelp, type ErrorHelp } from "./error-help.js";
import { clockLabel, firstLine, outcomeChip } from "./format.js";
import { approvalView, type ApprovalView } from "./approval-view.js";
import { memoryNoteView, type MemoryNoteView } from "./memory-note.js";

export type EventView =
  | { kind: "status"; text: string }
  /** Claude's text (Markdown). id: the streamed block it completes. */
  | { kind: "text"; text: string; id?: string }
  | { kind: "tool"; id: string; name: string; args: string }
  | { kind: "result"; id: string; name: string; preview: string; full: string; isError: boolean; thumbnail?: string }
  | { kind: "jev"; label: string; ms: number; executed: boolean; title: string }
  /**
   * screen: an empty message, "look at the page and do what is needed" (shown quieter, with an eye). voice: it was
   * spoken. heard: the user's words for a spoken request, word for word, when they read otherwise than the request
   * (Realtime: the text is what the narrator understood and passed on), shown folded under it.
   */
  | { kind: "user"; text: string; screen?: true; voice?: true; heard?: string[]; attachments?: AttachmentRef[] }
  /** A line hands-free voice said aloud. echo: it repeats the start of the text written above it (shown compact). */
  | { kind: "spoken"; text: string; echo?: true }
  /** long: the text is an answer (several lines or long), shown as a message above the outcome line. */
  | {
      kind: "end";
      chip: Chip;
      text: string;
      url?: string;
      long?: true;
      /** The turn failed on an error no card of its own showed yet: shown as that card (in place of `text`). */
      error?: ErrorHelp;
      /** Continue reads "Retry": the turn ended on an error that trying again may fix. */
      retry?: true;
      /** The failure's card has a fix button: that is the main action, not Continue. */
      fixable?: true;
      /** What the agent wrote for the user to review, not sent: shown whole, with Copy. */
      draft?: string;
    }
  /** An error, in plain words with the buttons that fix it (error-help.ts). */
  | { kind: "error"; help: ErrorHelp }
  /**
   * A task the agent put in the TODO list (schedule_task), or changed or cancelled there (change, with the
   * changeId its Undo names): its first line, its schedule in words, and whether the user undid it from the card.
   */
  | { kind: "scheduled"; taskId: string; title: string; instructions: string; when: string; change?: TodoChange; changeId?: string; undone?: true }
  /** A dialog a page of the run opened, and how it was answered: "Dialog: Leave site? … → Cancel". title: by whom, where. */
  | { kind: "dialog"; text: string; title: string }
  /** An action waiting for the user's OK, or how that ended (approval-view.ts). */
  | ApprovalView
  /** The agent's memory changed from this chat (memory-view.ts): "Remembered: ...", with Undo. */
  | MemoryNoteView;

/** The events of the turn that `events[endIndex]` (a task_end) closes: those since the previous task_end. */
function turnBefore(events: readonly AgentEvent[], endIndex: number): AgentEvent[] {
  let start = endIndex;
  while (start > 0 && events[start - 1]!.type !== "task_end") start--;
  return events.slice(start, endIndex);
}

/** The last error the turn that `events[endIndex]` closes already showed as a card of its own. */
export function turnError(events: readonly AgentEvent[], endIndex: number): string | undefined {
  const err = turnBefore(events, endIndex).reverse().find((e) => e.type === "error");
  return err?.type === "error" ? err.text : undefined;
}

/** What a task_end's view needs from the rest of its turn (see turnError), and a spoken line's (spokenEchoes). */
export interface TurnContext {
  /** An error the turn already showed as its own card. */
  error?: string | undefined;
  /** A spoken line repeats what is written above it. */
  echo?: boolean;
  /** A task_scheduled or task_changed: the user undid it since (a task_unscheduled or task_change_undone of it follows). */
  undone?: boolean;
  /** An approval_request: how it ended (approvalEnding); absent while it waits. */
  approval?: Parameters<typeof approvalView>[1];
  /** An approval_request its run paused at, still to be decided (Allow & continue, Don't: approval/paused.ts). */
  decidable?: boolean;
  /** A memory change: the user undid it since (a memory_undone of the same change follows it). */
  memoryUndone?: boolean;
}

/** Text compared for sameness: letters and digits only, lower case. */
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The same words, whatever the case, spacing and punctuation. */
export const sameWords = (a: string, b: string): boolean => comparable(a) === comparable(b);

/**
 * Whether the spoken line `events[index]` says what the turn already shows in
 * writing: the first sentence of the agent's text or of the turn's summary
 * (the plan read out, a summary that is the answer's first line).
 */
export function spokenEchoes(events: readonly AgentEvent[], index: number): boolean {
  const ev = events[index];
  if (ev?.type !== "spoken") return false;
  const said = comparable(ev.text);
  for (let i = index - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user_message") return false;
    const written = e.type === "assistant_text" ? e.text : e.type === "task_end" ? (e.summary ?? "") : "";
    if (written && comparable(speakable(written, Infinity)) === said) return true;
  }
  return false;
}

/**
 * A turn's end card. A failure is shown once: when the turn already showed
 * its error, the end card does not repeat it (it keeps the outcome and
 * Continue); otherwise a reason that is a known error becomes the error card.
 * The agent's own reason (byAgent: its task_pause, task_fail) is never read as
 * an error: "@rooftopchat is not signed in" (in X) is not Noa's sign-in. Other
 * reasons read as a summary, as before.
 */
function describeEnd(ev: Extract<AgentEvent, { type: "task_end" }>, turn: TurnContext): EventView {
  const reason = (ev.summary || ev.reason || "").trim();
  const failed = ev.outcome !== "done";
  const shown = failed && turn.error !== undefined ? errorHelp(turn.error) : undefined;
  const fromReason = failed && !shown && reason && !ev.byAgent ? errorHelp(reason) : undefined;
  const error = fromReason?.known ? fromReason : undefined;
  const text = shown || error ? "" : reason;
  return {
    kind: "end",
    chip: outcomeChip(ev.outcome),
    text,
    ...(ev.url ? { url: ev.url } : {}),
    ...(isLongSummary(text) ? { long: true as const } : {}),
    ...(error ? { error } : {}),
    ...((shown ?? error)?.retry ? { retry: true as const } : {}),
    ...((shown ?? error)?.fixes.length ? { fixable: true as const } : {}),
    ...(ev.draft?.trim() ? { draft: ev.draft.trim() } : {}),
  };
}

export type ScheduledView = Extract<EventView, { kind: "scheduled" }>;

/**
 * A task_scheduled's or task_changed's card; undone: the user undid it since. Its schedule is put in words now, in
 * the browser's zone (a card read the next day no longer says "today").
 */
export function scheduledView(
  ev: Extract<AgentEvent, { type: "task_scheduled" | "task_changed" }>,
  undone: boolean,
  opts: { now?: Date; timeZone?: string; hour12?: boolean } = {},
): ScheduledView {
  const when = describeSchedule(ev.schedule, { now: opts.now ?? new Date(), timeZone: opts.timeZone ?? localTimeZone(), ...(opts.hour12 === undefined ? {} : { hour12: opts.hour12 }) });
  const v: ScheduledView = {
    kind: "scheduled",
    taskId: ev.taskId,
    title: firstLine(ev.instructions),
    instructions: ev.instructions,
    when,
    ...(ev.type === "task_changed" ? { change: ev.change, changeId: ev.changeId } : {}),
  };
  return undone ? { ...v, undone: true } : v;
}

/** turn: for a task_end, what its turn held (see TurnContext). */
export function describeEvent(ev: AgentEvent, turn: TurnContext = {}): EventView {
  switch (ev.type) {
    case "status":
      return { kind: "status", text: ev.text };
    case "assistant_text":
      return ev.id ? { kind: "text", text: ev.text.trim(), id: ev.id } : { kind: "text", text: ev.text.trim() };
    case "assistant_text_delta":
      // Live text is shown by the chat as it streams (see chat.ts); as an event it is its block's text so far.
      return { kind: "text", text: ev.text, id: ev.id };
    case "tool_call": {
      // An answer to the user's message (answer_user) is the agent's words to them, not a step.
      const answer = ev.name === ANSWER_TOOL ? (ev.args as { text?: unknown } | undefined)?.text : undefined;
      if (typeof answer === "string") return { kind: "text", text: answer.trim() };
      return { kind: "tool", id: ev.id, name: ev.name, args: toolArgsSummary(ev.name, ev.args) };
    }
    case "tool_result": {
      const full = ev.text ?? "";
      const preview = clip(full, 90) || (ev.thumbnail ? "image" : ev.isError ? "error" : "ok");
      return {
        kind: "result",
        id: ev.id,
        name: ev.name,
        preview,
        full,
        isError: !!ev.isError,
        ...(ev.thumbnail ? { thumbnail: ev.thumbnail } : {}),
      };
    }
    case "jev": {
      const target = ev.index === null ? "" : ` #${ev.index}`;
      return {
        kind: "jev",
        // Say plainly who made the decision: Jev did it, or Jev was unsure and Claude takes over.
        // Jev sure but its pick did not run (not approved, refused, or it failed) is not "unsure".
        label: ev.executed
          ? `Jev: ${ev.operation}${target} · ${ev.confidence.toFixed(2)}`
          : ev.notRun
            ? `Jev: ${ev.operation}${target} · ${ev.confidence.toFixed(2)} · ${ev.notRun === "not_approved" ? "not approved" : ev.notRun}`
            : `Jev unsure (${ev.confidence.toFixed(2)}) · Claude decides`,
        ms: ev.ms,
        executed: ev.executed,
        title: `Jev (a faster helper for simple clicks and typing): ${ev.goal}${ev.executed ? "" : ev.notRun === "not_approved" ? " (not approved)" : ev.notRun ? ` (${ev.notRun})` : " (not confident, left to Claude)"}`,
      };
    }
    case "user_message": {
      if (isScreenHelp(ev.text)) return { kind: "user", text: ev.text, screen: true };
      const files = ev.attachments?.length ? { attachments: ev.attachments } : {};
      return ev.voice ? { kind: "user", text: ev.text, voice: true, ...wordForWord(ev.text, ev.heard), ...files } : { kind: "user", text: ev.text, ...files };
    }
    case "spoken":
      return turn.echo ? { kind: "spoken", text: ev.text, echo: true } : { kind: "spoken", text: ev.text };
    case "heard":
      // Words that led to no request are kept for the record (Raw), not shown in the chat.
      return { kind: "status", text: "" };
    case "task_end":
      return describeEnd(ev, turn);
    case "error":
      return { kind: "error", help: errorHelp(ev.text) };
    case "task_scheduled":
      return scheduledView(ev, !!turn.undone);
    case "task_unscheduled":
      // It changes its task_scheduled card (see turn.undone); the chat shows nothing of its own for it.
      return { kind: "status", text: "" };
    case "task_changed":
      return scheduledView(ev, !!turn.undone);
    case "task_change_undone":
      // It changes its task_changed card (see turn.undone); nothing of its own.
      return { kind: "status", text: "" };
    case "approval_request":
      return approvalView(ev, turn.approval, !!turn.decidable);
    case "approval_resolved":
      // It changes its approval card (see turn.approval); nothing of its own.
      return { kind: "status", text: "" };
    case "dialog":
      return dialogView(ev);
    case "memory":
      return memoryNoteView(ev, !!turn.memoryUndone);
    case "memory_undone":
    case "memory_redone":
      // It changes its memory note (see turn.memoryUndone); nothing of its own.
      return { kind: "status", text: "" };
    case "trace":
      // Timing goes to the conversation's trace (the Raw view), never into the chat: an empty line if one got here.
      return { kind: "status", text: "" };
  }
}

const DIALOG_ANSWERED_BY = { agent: "the agent", auto: "Noa, because nobody did in time", user: "someone in the browser" } as const;

/** A dialog's line in the run, with who answered it and where in its title. */
export function dialogView(ev: Extract<AgentEvent, { type: "dialog" }>): EventView {
  let site = "";
  try {
    site = new URL(ev.dialog.url).host;
  } catch {
    /* no page address */
  }
  const where = [site && `on ${site}`, ev.tab && `in tab ${ev.tab}`].filter(Boolean).join(" ");
  return { kind: "dialog", text: dialogLine(ev), title: `A ${ev.dialog.type} dialog the page opened${where ? ` ${where}` : ""}, answered by ${DIALOG_ANSWERED_BY[ev.by]}` };
}

/** The conversation's first message: what was asked, as the first bubble of the thread. */
export interface OpeningView {
  /** The prompt as typed, or the task's instructions (only its one-line title for runs that did not save them). */
  text: string;
  /** An empty send: "look at the page" (shown quieter, with an eye). */
  screen?: true;
  /** Not typed in Chat: where the instructions came from. */
  origin?: string;
  /** Spoken (hands-free voice), not typed. */
  voice?: true;
  /** The user's words for it, word for word, when they read otherwise than the request (see the user view's heard). */
  heard?: string[];
  /** How many files the first turn came with (a TODO task's media: their names are not saved with the run). */
  files?: number;
  /** The files the first message was sent with (chat attachments). */
  attachments?: AttachmentRef[];
  /** When the conversation started: "14:30", "yesterday 23:00". */
  when: string;
  /** The same moment (ISO), for the timestamp's tooltip. */
  at: string;
}

const ORIGIN_OF: Partial<Record<TaskSource, string>> = { local: "Scheduled run", cloud: "Scheduled run" };
/** The status line a first turn with files starts with (see run/turn.ts). */
const PREPARING_FILES = /^Preparing (\d+) file\(s\)$/;

/** The prompt as typed, or the task's instructions (only its title for runs that did not save them: older ones). */
const firstMessage = (s: SessionInfo): string => s.instructions?.trim() || s.title;

/** The first message of a conversation, from its session and its events (the first turn's files). */
export function openingTurn(s: SessionInfo, events: readonly AgentEvent[], now = Date.now()): OpeningView {
  const text = firstMessage(s);
  const at = s.firstStartedAt ?? s.startedAt;
  const v: OpeningView = { text, when: clockLabel(at, now).replace(/^today /, ""), at };
  if (s.source === "adhoc" && isScreenHelp(text)) v.screen = true;
  else if (s.voice) {
    v.voice = true;
    Object.assign(v, wordForWord(text, s.heard));
  }
  const origin = ORIGIN_OF[s.source];
  if (origin) v.origin = origin;
  if (s.attachments?.length) v.attachments = s.attachments;
  const firstEnd = events.findIndex((e) => e.type === "task_end");
  for (const e of firstEnd < 0 ? events : events.slice(0, firstEnd)) {
    const n = e.type === "status" ? PREPARING_FILES.exec(e.text)?.[1] : undefined;
    if (n) v.files = Number(n);
  }
  return v;
}

/**
 * The line a brain writes as its session starts: "Noa AI (claude-opus-5-5) with Jev" or
 * "Claude API (claude-sonnet-5)" (core's api-agent with the brain's label), "Claude Code started
 * (claude-sonnet-5)" (the helper). Case-insensitive: older sessions spelled the hosted AI in lower case.
 */
const BRAIN_START = /^(?:Claude Code started(?: \([^()]*\))?|(?:Claude API|Noa AI) \([^()]*\)(?: with Jev)?)$/i;

/** A brain's start line: the chat's brain chip says the same, so the chat leaves it out. */
export function isBrainStartLine(text: string): boolean {
  return BRAIN_START.test(text.trim());
}

/**
 * What the chat leaves to the Raw view: a brain's start line (the brain chip says it), Jev's element picks and the
 * turn's count of them (nothing to act on), and what only repeats the card a run paused at (its "Pausing: ..." line
 * and its end: the card says it, with its answers).
 */
export function hiddenInChat(events: readonly AgentEvent[], index: number): boolean {
  const e = events[index]!;
  if (e.type === "jev") return true;
  if (e.type === "status" && (e.picks || isBrainStartLine(e.text))) return true;
  return repeatsPausedCard(events, index);
}

/** The user's turn was an empty message in Chat: look at the page (SCREEN_HELP_TEXT). */
export function isScreenHelp(text: string | undefined): boolean {
  return text?.trim() === SCREEN_HELP_TEXT;
}

/**
 * A spoken request's words, word for word, to show folded under it: only when they read otherwise than the request
 * (Standard sends the words themselves; a Realtime request in the user's own words needs no second copy).
 */
export function wordForWord(text: string, heard: readonly string[] | undefined): { heard?: string[] } {
  if (!heard?.length || sameWords(text, heard.join(" "))) return {};
  return { heard: [...heard] };
}

/** Should a scroll container keep following new content? (within `slack` px of the bottom) */
export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}
