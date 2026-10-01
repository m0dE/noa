/** DOM for one conversation log entry (a job's conversation and its earlier runs) (see event-format.ts for the pure view models). */
import { chipHint, plural, TASK_END_TOOLS, type SessionInfo, type TodoChange } from "@noa/shared";
import { busy, copyText, h } from "../ui/dom.js";
import { renderErrorHelp } from "./error-view.js";
import type { EventView, OpeningView, ScheduledView } from "./event-format.js";
import { undoneText, type MemoryNoteView } from "./memory-note.js";
import { renderApproval, type ApprovalCardActions } from "./approval-card.js";
import { sessionHeadline } from "./format.js";
import { MarkdownView } from "./markdown.js";
import { renderSentFiles } from "./attachments/view.js";

/** What a scheduled card's buttons do (the chat binds them; without them the card shows no buttons). */
export interface ScheduledCardActions {
  /** View: the task's job page. */
  view(taskId: string): void;
  /** Undo on a Scheduled card: delete the task (the card then says it was undone). */
  undo(taskId: string): Promise<void>;
  /** Undo on a Changed or Cancelled card: the task goes back as it was (the card then says it was undone). */
  undoChange(changeId: string): Promise<void>;
}

/** What a memory note's Undo does (the chat binds it; without it the note shows no button). */
export interface MemoryNoteActions {
  /** Undo: the entry goes back to how it was before the change (the note then says so). */
  undo(changeId: string): Promise<void>;
  /** Redo on an undone note: the change is made again (the note then shows it with Undo). */
  redo(changeId: string): Promise<void>;
}

/**
 * onContinue: the run ended without finishing and can be continued (task_end cards).
 * scheduled: the buttons of a scheduled card.
 * approval: the answers of an approval card (without them it shows no buttons).
 * memory: Undo on a memory note.
 */
export function renderEvent(v: EventView, onContinue?: () => void, scheduled?: ScheduledCardActions, approval?: ApprovalCardActions, memory?: MemoryNoteActions): HTMLElement {
  switch (v.kind) {
    case "status":
      return h("div.ev-status", null, v.text);
    case "dialog":
      // A step of the run like a status line, and worded like one.
      return h("div.ev-status.ev-dialog", { title: v.title }, v.text);
    case "text":
      return renderText(v.text, v.id);
    case "tool":
      // Every tool call is Claude's decision (Jev's own picks are in the Raw view).
      return h("div.ev-tool", { title: `Claude chose: ${v.name} ${v.args}` }, h("b", null, v.name), v.args ? ` ${v.args}` : "");
    case "result": {
      const cls = v.isError ? "err" : "";
      // Long results collapse behind their preview; short ones are just the line.
      const wrap = h(
        "div",
        null,
        v.full && v.full !== v.preview
          ? h("details.ev-result", { class: cls }, h("summary", null, v.preview), h("pre", null, v.full))
          : h("div.ev-result", { class: cls }, h("div.line", null, v.preview)),
      );
      if (v.thumbnail) {
        const img = h("img.thumb", { src: `data:image/jpeg;base64,${v.thumbnail}`, alt: "screenshot", loading: "lazy" });
        img.addEventListener("click", () => img.classList.toggle("big"));
        wrap.append(img);
      }
      return wrap;
    }
    case "jev":
      return h(
        "div.ev-jev",
        { title: v.title },
        h("span.chip", { "data-tone": v.executed ? "accent" : "muted" }, v.label),
        h("span.ms", null, `${v.ms} ms`),
      );
    case "user": {
      if (v.screen) return renderScreenHelp(v.text);
      const files = renderSentFiles(v.attachments);
      if (!v.voice) return h("div.ev-user", null, files, ...userText(v.text));
      const bubble = h("div.ev-user.voice", { title: "Sent by voice" }, files, voiceMark(), ...userText(v.text));
      return v.heard ? h("div.ev-said", null, bubble, renderWordForWord(v.heard)) : bubble;
    }
    case "spoken":
      return renderSpoken(v);
    case "end":
      return h(
        "div.ev-end",
        null,
        // A failure no card of the turn showed yet: its card (a failure is shown once).
        v.error ? renderErrorHelp(v.error) : null,
        // A long text is an answer: it reads as a message, and the outcome line under it stays short.
        v.long ? renderText(v.text) : null,
        v.draft ? renderDraft(v.draft) : null,
        h(
          "div.ev-outcome",
          null,
          h("span.chip", { "data-tone": v.chip.tone, title: chipHint(v.chip.label) || null }, v.chip.label),
          v.text && !v.long ? h("span.ev-summary", { title: v.text }, v.text) : null,
        ),
        v.url ? h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.url) : null,
        onContinue
          ? h(
              "div.ev-actions",
              null,
              h(
                "button.small.ev-continue",
                {
                  type: "button",
                  // The error card's own fix, when there is one, is the main button.
                  class: v.fixable ? null : "primary",
                  title: `${v.retry ? "Try again" : "Go on"} from where it stopped (anything typed in the box below is sent along)`,
                  onclick: () => onContinue(),
                },
                v.retry ? "Retry" : "Continue",
              ),
            )
          : null,
      );
    case "error":
      return renderErrorHelp(v.help);
    case "scheduled":
      return renderScheduled(v, scheduled);
    case "approval":
      return renderApproval(v, approval);
    case "memory":
      return renderMemoryNote(v, memory);
  }
}

/**
 * A change to the agent's memory: "Remembered: <subject> · <text>" on one quiet line, with Undo ("replaced “<old>”"
 * after the subject when it replaced another entry). Undone, it says so, with Redo; a failed undo or redo says why
 * under the line and keeps its button.
 */
export function renderMemoryNote(v: MemoryNoteView, actions?: MemoryNoteActions): HTMLElement {
  const line = h(
    "div.mem-line",
    { title: v.title },
    svgIcon(13, MEMORY_ICON),
    h("span.mem-label", null, v.undone ? "Undone:" : `${v.label}:`),
    h("span.mem-subject", null, v.subject),
    v.replaced ? h("span.mem-replaced", null, v.replaced.text) : null,
    h("span.mem-text", null, `· ${v.text}`),
  );
  const note = h("div.ev-memory", { class: v.undone ? "undone" : null, "data-change-id": v.changeId }, line);
  if (v.undone) note.append(h("div.mem-note", null, undoneText(v)));
  if (!actions) return note;
  const problem = h("div.mem-note.bad", { hidden: true, role: "alert" });
  const [word, title, act] = v.undone
    ? (["Redo", "Make this change to memory again", actions.redo] as const)
    : (["Undo", v.change === "forgot" ? "Keep this memory after all" : "Undo this change to memory", actions.undo] as const);
  const button = h(`button.small.ghost.mem-${word.toLowerCase()}`, { type: "button", title }, word);
  button.addEventListener("click", () => {
    problem.hidden = true;
    void busy(button, () => act(v.changeId), (message) => {
      problem.textContent = `Couldn't ${word.toLowerCase()}: ${message}`;
      problem.hidden = false;
    });
  });
  line.append(button);
  note.append(problem);
  return note;
}

/** A TODO card's words by what the agent did: its label, what Undo does, and what the card says once undone. */
const SCHEDULED_WORDS: Record<"scheduled" | TodoChange, { label: string; undo: string; undone: string }> = {
  scheduled: { label: "Scheduled:", undo: "Delete this scheduled job", undone: "Removed from your jobs." },
  updated: { label: "Changed:", undo: "Put this task back as it was", undone: "Put back as it was." },
  cancelled: { label: "Cancelled:", undo: "Schedule this job again", undone: "Scheduled again." },
};

/**
 * A task the agent put in the TODO list, or changed or cancelled there: "Scheduled: <task> · <when>" (Changed:,
 * Cancelled:) on one line, with View (its job) and Undo. Undone, it says so and keeps no buttons. A failed undo says
 * why under the line and keeps Undo.
 */
export function renderScheduled(v: ScheduledView, actions?: ScheduledCardActions): HTMLElement {
  const words = SCHEDULED_WORDS[v.change ?? "scheduled"];
  const card = h(
    "div.ev-scheduled",
    { class: v.undone ? "undone" : null, "data-task-id": v.taskId, "data-change-id": v.changeId ?? null, "data-change": v.change ?? null },
    h(
      "div.sched-line",
      { title: `${v.instructions}\n\n${v.when}` },
      svgIcon(13, CLOCK_ICON),
      h("span.sched-label", null, v.undone ? "Undone:" : words.label),
      h("span.sched-task", null, v.title),
      h("span.sched-when", null, `· ${v.when}`),
    ),
  );
  if (v.undone) {
    card.append(h("div.sched-note", null, words.undone));
    return card;
  }
  if (!actions) return card;
  const note = h("div.sched-note.bad", { hidden: true, role: "alert" });
  const undo = h("button.small.sched-undo", { type: "button", title: words.undo }, "Undo");
  undo.addEventListener("click", () => {
    note.hidden = true;
    void busy(undo, () => (v.changeId ? actions.undoChange(v.changeId) : actions.undo(v.taskId)), (message) => {
      note.textContent = `Couldn't undo: ${message}`;
      note.hidden = false;
    });
  });
  card.append(
    h(
      "div.sched-actions",
      null,
      h("button.small.sched-view", { type: "button", title: "Open this scheduled job", onclick: () => actions.view(v.taskId) }, "View"),
      undo,
    ),
    note,
  );
  return card;
}

/**
 * A line hands-free voice said aloud: quieter than the agent's answer, with a speaker and an accent bar; the
 * wave moves while it plays (the chat adds .playing). One that repeats the text above it is compact.
 */
export function renderSpoken(v: Extract<EventView, { kind: "spoken" }>): HTMLElement {
  return h(
    "div.ev-spoken",
    { class: v.echo ? "echo" : null, title: "Said aloud by hands-free voice" },
    svgIcon(13, SPEAKER_ICON),
    h("span.ev-spoken-text", null, v.text),
    h("span.ev-spoken-wave", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i")),
  );
}

/**
 * Under a spoken request (what the voice assistant understood, which the agent got): the user's words for it as
 * transcribed, each part of their speech in order, folded.
 */
function renderWordForWord(heard: readonly string[]): HTMLElement {
  return h(
    "details.ev-words",
    null,
    h("summary", { title: "What was heard, as transcribed, before the voice assistant passed it on" }, "Word for word"),
    h("p.ev-words-text", null, heard.join(" · ")),
  );
}

/** The mic in a message the user spoke (read out as "Voice"). */
function voiceMark(): HTMLElement {
  return h("span.ev-voice", { "aria-label": "Voice:" }, svgIcon(12, MIC_ICON));
}

/** A draft the agent wrote and did not send: its whole text, as it would go out, with Copy. */
export function renderDraft(text: string): HTMLElement {
  const copy = h("button.small.ghost", { type: "button", title: "Copy the draft's text" }, "Copy");
  copy.addEventListener("click", () => {
    void copyText(text).then((ok) => {
      copy.textContent = ok ? "Copied" : "Couldn't copy";
      setTimeout(() => (copy.textContent = "Copy"), 2000);
    });
  });
  return h(
    "div.ev-draft",
    null,
    h("div.ev-draft-head", null, h("span.ev-draft-label", null, "Draft · not sent"), copy),
    h("div.ev-draft-text", null, text),
  );
}

/** Claude's text as Markdown. `id`: the streamed block it is (the chat updates it in place). */
export function renderText(text: string, id?: string): HTMLElement {
  const el = h("div.ev-text.md", id ? { "data-stream": id } : null);
  new MarkdownView(el).update(text);
  return el;
}

/** Tool calls and what goes with them: grouped, and folded once a run of them gets long. */
const STEP_KINDS = new Set<EventView["kind"]>(["tool", "result", "jev", "status", "dialog"]);
/** A group with this many tool calls folds to its summary line. */
export const FOLD_STEPS = 3;

/**
 * Appends an event's element to a conversation log. Tool calls, results,
 * Jev lines, status and dialog lines in a row go into one steps group; the group
 * folds to "N steps" once it has FOLD_STEPS tool calls, unless the user
 * opened it.
 */
export function placeEvent(log: HTMLElement, node: HTMLElement, v: EventView): void {
  if (!STEP_KINDS.has(v.kind)) {
    log.append(node);
    return;
  }
  let group = log.lastElementChild as HTMLElement | null;
  if (!group?.classList.contains("ev-steps")) {
    group = newStepsGroup();
    log.append(group);
  }
  // The task_* call and its result say what the end card below says: kept, but not shown or counted.
  const ending = (v.kind === "tool" || v.kind === "result") && (TASK_END_TOOLS as readonly string[]).includes(v.name);
  if (ending) node.hidden = true;
  group.querySelector(":scope > .ev-steps-body")!.append(node);
  if (v.kind === "tool" && !ending) updateStepsGroup(group as HTMLDetailsElement, v.name);
}

function newStepsGroup(): HTMLDetailsElement {
  const d = h(
    "details.ev-steps.few",
    { open: true },
    h("summary", { title: "Show or hide the steps" }, h("span.ev-steps-count", null, ""), h("span.ev-steps-last", null, "")),
    h("div.ev-steps-body"),
  );
  d.dataset.steps = "0";
  // Once the user opens or closes it, it stays that way.
  d.querySelector("summary")!.addEventListener("click", () => (d.dataset.user = "1"));
  return d;
}

function updateStepsGroup(d: HTMLDetailsElement, last: string): void {
  const n = Number(d.dataset.steps ?? "0") + 1;
  d.dataset.steps = String(n);
  d.querySelector(".ev-steps-count")!.textContent = `${n} steps`;
  d.querySelector(".ev-steps-last")!.textContent = last;
  if (n >= FOLD_STEPS && d.classList.contains("few")) {
    d.classList.remove("few");
    if (!d.dataset.user) d.open = false;
  }
}

/** The chip under the conversation's first message: which brain and model, Jev on or off. */
export function renderSessionHead(s: SessionInfo): HTMLElement {
  return h(
    "div.ev-head",
    { title: "The agent behind this conversation: brain · model · Jev (a faster helper for simple clicks and typing)" },
    sessionHeadline(s),
  );
}

/**
 * The conversation's first message: the prompt as a user bubble like the follow-ups (a task's
 * instructions say where they came from), with the time it started under it. Clicking it, or
 * Enter/Space on it, opens its details. A div rather than a button, so its text can still be selected
 * and copied: a click that ends a selection does not open the sheet.
 */
export function renderOpening(v: OpeningView, onDetails: (trigger: HTMLElement) => void): HTMLElement {
  const bubble = v.screen
    ? renderScreenHelp(v.text)
    : h(
        "div.ev-user",
        { class: v.voice ? "voice" : null },
        v.origin ? h("span.ev-origin", null, v.origin) : null,
        renderSentFiles(v.attachments),
        v.voice ? voiceMark() : null,
        // A scheduled run's instructions are its job's (shown on the job's page): its first line, the rest on Show all.
        ...userText(v.text, v.origin ? { lines: 1, cut: v.text.trim().includes("\n") || v.text.length > SCHEDULED_CHARS } : {}),
        v.files ? h("span.ev-files", { title: "Files sent with this message" }, svgIcon(12, CLIP_ICON), plural(v.files, "file")) : null,
      );
  bubble.classList.add("ev-first");
  bubble.tabIndex = 0;
  bubble.setAttribute("role", "button");
  bubble.setAttribute("aria-haspopup", "dialog");
  bubble.title = `${v.screen ? `${bubble.title}
` : ""}Show the full ${v.origin ? "task" : "message"} and its details`;
  bubble.addEventListener("click", () => {
    if (window.getSelection()?.isCollapsed !== false) onDetails(bubble);
  });
  bubble.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onDetails(bubble);
  });
  const started = new Date(v.at);
  return h("div.ev-opening", null, bubble, v.heard ? renderWordForWord(v.heard) : null, h("time.ev-when", { datetime: v.at, title: `Started ${started.toLocaleString()}` }, v.when));
}

/** A message longer than this (lines, or characters) shows its first CUT_LINES lines, with Show all for the rest. */
const LONG_LINES = 6;
const LONG_CHARS = 600;
const CUT_LINES = 4;
/** A scheduled run's instructions longer than this (or on more than one line) show their first line. */
const SCHEDULED_CHARS = 120;

/**
 * A message's text in its bubble: a long one cut to its first `lines` lines, with Show all (and Show less) that do not
 * open the bubble's details.
 */
function userText(text: string, opts: { lines?: number; cut?: boolean } = {}): HTMLElement[] {
  const cut = opts.cut ?? (text.split(/\r?\n/).length > LONG_LINES || text.length > LONG_CHARS);
  const body = h("span.ev-user-text", null, text);
  if (!cut) return [body];
  body.dataset.cut = "true";
  body.style.setProperty("--lines", String(opts.lines ?? CUT_LINES));
  const more = h("button.link.ev-more", { type: "button", "aria-expanded": "false" }, "Show all");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = body.dataset.cut === "true";
    body.dataset.cut = String(!open);
    more.textContent = open ? "Show less" : "Show all";
    more.setAttribute("aria-expanded", String(open));
  });
  // Enter and Space on it are its own, not the bubble's (which opens the details).
  more.addEventListener("keydown", (e) => e.stopPropagation());
  return [body, more];
}

const CLIP_ICON =
  '<path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.8-5.8a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.2 1.2 0 0 1-1.7-1.7L10 4.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const MIC_ICON =
  '<rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
const SPEAKER_ICON =
  '<path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.4 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>';
const CLOCK_ICON =
  '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
/** A bookmark: something kept for later. */
const MEMORY_ICON =
  '<path d="M4.5 2.25h7v11.5L8 11.2l-3.5 2.55z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>';
const EYE_ICON =
  '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/>';

/** A decorative 16×16 icon drawn at `size` px. */
function svgIcon(size: number, paths: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

/** An empty message in Chat, as the user's turn: quieter than a typed one, with an eye, so it does not read as blank. */
export function renderScreenHelp(text: string): HTMLElement {
  return h(
    "div.ev-user.screen",
    { title: "You sent an empty message: Noa looks at the page and works out what is needed" },
    svgIcon(13, EYE_ICON),
    h("span", null, text),
  );
}

/** Continue belongs to the conversation's last turn only, and only when that turn ended the thread. */
export function pruneContinue(log: HTMLElement): void {
  const cards = [...log.querySelectorAll(".ev-actions")];
  for (const c of cards.slice(0, -1)) c.remove();
  if (log.lastElementChild && !log.lastElementChild.classList.contains("ev-end")) cards.at(-1)?.remove();
}

