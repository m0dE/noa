/**
 * The input bar pinned to the bottom of the panel, under the jobs list and under
 * a job's page. On a job's page it talks to the job's conversation: while its
 * turn runs, a message goes into that turn (and Stop pauses it); once the
 * turn ended, a message is the conversation's next turn. Under the list (no
 * conversation) it starts a new job in the current tab. Every request names
 * that tab.
 *
 * Sending an empty box means "look at this page and do what is needed"
 * (SCREEN_HELP_TEXT, see emptySend). After a turn, the job's page offers the
 * agent's follow-up suggestion faded in the box (see suggestion.ts): Tab
 * takes it, it is never sent by itself.
 *
 * Files go with a message too (attachments/): pasted into the box, dropped
 * anywhere on the panel, or picked with the paperclip; they show as chips
 * above the text and go with the next message that starts a turn (a new chat
 * or the next turn; a running turn refuses them, so they wait).
 */
import { errorMessage, FILES_WHILE_RUNNING, traceStart, type SessionInfo } from "@noa/shared";
import type { PanelTrace } from "../trace/panel-trace.js";
import { uiRequest, type UiAttachmentUpload, type UiRequest, type UiState } from "../ui-protocol.js";
import { $, busy } from "../ui/dom.js";
import { errorHelp } from "./error-help.js";
import { renderErrorHelp } from "./error-view.js";
import { prepareAttachment } from "./attachments/prepare.js";
import { AttachmentTray, type AttachmentBatch } from "./attachments/tray.js";
import { renderTrayChips } from "./attachments/view.js";
import { initModelPicker } from "./model-menu.js";
import { initNotices, type Notices } from "./notices.js";
import { FollowUpSuggestion, suggestionDescription, type SuggestionOffer } from "./suggestion.js";
import { ChatMemory } from "./chat-memory.js";

export type ComposerMode = "new" | "conversation" | "running";

/** The box under the list starts a new job (an empty send looks at the page: Send's tooltip says so). */
export const NEW_JOB_PLACEHOLDER = "Start a new job…";
/** The placeholder while hands-free voice listens for this box's tab. */
export const LISTENING_PLACEHOLDER = "Listening · go ahead";
/** The placeholder while hands-free voice starts (or reconnects) for this box's tab: it does not listen yet. */
export const STARTING_PLACEHOLDER = "Not listening yet · wait for the sound";
/** The placeholder while hands-free is on for this tab with the microphone muted. */
export const MUTED_PLACEHOLDER = "Microphone muted · type, or unmute to talk";

/** Hands-free voice and the box: off, starting for this tab (not listening yet), listening for it, or on with the microphone muted. */
export type DictationLook = "off" | "starting" | "listening" | "muted";
/** The Send button's tooltip where an empty send looks at the page. */
export const SCREEN_SEND_TITLE = "Describe a task, or press Enter to let Noa look at this page";

type EmptySendRequest = Extract<UiRequest, { type: "run.message" }> | Extract<UiRequest, { type: "run.adhoc" }>;

/**
 * What Send does with an empty box (and no text): look at the page — a new
 * job, or the shown one's next turn. A running turn is looking already;
 * files need a few words.
 */
export function emptySend(opts: {
  mode: ComposerMode;
  sessionId: string | null;
  hasFiles: boolean;
  tabId: number | null;
}): { request: EmptySendRequest } | { hint: string } {
  if (opts.hasFiles) return { hint: "Say what to do with the files" };
  if (opts.mode === "running") return { hint: "The agent is working: type a message, or press Stop" };
  const tab = opts.tabId === null ? {} : { tabId: opts.tabId };
  if (opts.mode === "conversation" && opts.sessionId) {
    return { request: { type: "run.message", sessionId: opts.sessionId, text: "", screen: true, ...tab } };
  }
  return { request: { type: "run.adhoc", instructions: "", screen: true, ...tab } };
}

export interface ComposerView {
  /** The sessions running right now (UiState.runningSessions). */
  setRunning(running: readonly SessionInfo[]): void;
  /** Keeps the model chip in step with the settings and brain status. */
  setState(state: UiState): void;
  /** The conversation of the job shown (null: the list, or a job that never ran: the box starts a new job). */
  setConversation(session: SessionInfo | null): void;
  /** The conversation the box talks to, or null ("Do this now"). */
  target(): SessionInfo | null;
  mode(): ComposerMode;
  /** Put the cursor in the box. */
  focus(): void;
  /**
   * The slot in the input's button row right left of Send, for a control
   * that belongs with sending (e.g. a voice toggle). Empty (and taking no
   * space) until something is mounted in it.
   */
  readonly actionSlot: HTMLElement;
  /** The text in the box. */
  draft(): string;
  /** Replaces the text in the box (hands-free voice writes the user's words here while they speak). */
  setDraft(value: string): void;
  /** Hands-free voice is on (it may write into the box): the follow-up suggestion stays hidden meanwhile. */
  setDictating(look: DictationLook): void;
  /** Continue a stopped conversation now: sends the typed note if there is one, otherwise just continues. */
  continueNow(sessionId: string): Promise<void>;
  /** Says above the box why something the panel did for this chat failed. */
  showError(err: unknown): void;
  /** The notice line above the box (voice tips, hints, errors): one at a time, never over the box. */
  readonly notices: Notices;
  /** Memory for the chat shown (the menu's switch); a new chat started elsewhere (voice) carries its choice too. */
  readonly memory: ChatMemory;
  /** The files waiting in the box: hands-free voice sends them with its next request that starts a turn. */
  readonly attachments: ComposerAttachments;
}

/** The box's files, for a request sent from elsewhere (hands-free voice). */
export interface ComposerAttachments {
  readonly count: number;
  /** The files, once each is prepared; sent() once they went out. */
  batch(): Promise<AttachmentBatch>;
}

/** The composer's own notices (progress, hints, failures of what it sent) go under this key: each replaces the last. */
const NOTICE_KEY = "composer";
/** Files that could not be added say so under this key. */
const FILES_NOTICE = "files";

const CHAT_PLACEHOLDER = "Message Noa…";
const MAX_ROWS = 8;

export function initComposer(opts: {
  /** A message or a new task went out: show its conversation. */
  onStarted: (sessionId: string) => void;
  onState: (state: UiState) => void;
  /** "Top up…" in the model menu. */
  onTopup?: () => void;
  /** Stop was pressed for chat `sessionId` (null: everything): hands-free voice ends with the task. */
  onStop?: (sessionId: string | null) => void;
  /** The browser tab the panel is showing the chat of (null: unknown). */
  tabId?: () => number | null;
  /** The conversation's trace: when each message was sent and how long the background took to take it. */
  trace?: Pick<PanelTrace, "newCid" | "record" | "bind">;
}): ComposerView {
  const tab = (): { tabId?: number } => {
    const id = opts.tabId?.() ?? null;
    return id === null ? {} : { tabId: id };
  };
  const form = $<HTMLFormElement>("now-form");
  const text = $<HTMLTextAreaElement>("now-text");
  const attach = $("now-attach");
  const submit = $<HTMLButtonElement>("now-submit");
  const stop = $<HTMLButtonElement>("now-stop");
  const notices = initNotices($("now-notice"));
  /** A request that failed: a known problem as its error card (plain words and the fix), anything else as its text. */
  const problem = (message: string): void => {
    const help = errorHelp(message);
    notices.show(help.known ? { key: NOTICE_KEY, level: "error", body: renderErrorHelp(help) } : { key: NOTICE_KEY, level: "error", text: message });
  };
  /** A request is out ("Sending…"): shown until it is answered. */
  const progress = (text: string) => notices.show({ key: NOTICE_KEY, level: "info", text, sticky: true });
  const hint = (text: string) => notices.show({ key: NOTICE_KEY, level: "info", text });
  const settled = () => notices.clear(NOTICE_KEY);
  const showError = (err: unknown) => problem(errorMessage(err));
  const fileInput = $<HTMLInputElement>("now-files");
  const filesList = $("now-files-list");
  const ghost = $("now-ghost");
  const ghostTyped = ghost.querySelector<HTMLElement>(".now-ghost-typed")!;
  const ghostRest = ghost.querySelector<HTMLElement>(".now-ghost-rest")!;
  const suggestionText = $("now-suggestion");
  const suggestion = new FollowUpSuggestion();
  /** The box's placeholder for the mode; the suggestion takes its place while it shows. */
  let placeholder = text.placeholder;
  /** Hands-free voice is on for this tab (setDictating). */
  let dictating: DictationLook = "off";
  const tray = new AttachmentTray({
    prepare: (file, held) => prepareAttachment(file, held),
    onChange: () => {
      renderTrayChips(filesList, tray.items(), (id) => tray.remove(id), () => text.focus());
      queueMicrotask(() => render());
    },
    onProblem: (message) => notices.show({ key: FILES_NOTICE, level: "error", text: message }),
  });
  const addFiles = (list: FileList | readonly File[] | null | undefined) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    notices.clear(FILES_NOTICE);
    tray.add(picked);
  };
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });
  // Pasted files (a screenshot, files copied in the file manager). A paste that carries plain text is text (Word
  // puts a picture of the copied text on the clipboard too).
  text.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data?.files.length || data.types.includes("text/plain")) return;
    e.preventDefault();
    addFiles(data.files);
  });
  // Files dropped anywhere on the panel.
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  let dragDepth = 0;
  const dropping = (on: boolean) => document.body.classList.toggle("dropping-files", on);
  document.addEventListener("dragenter", (e) => {
    if (!carriesFiles(e)) return;
    dragDepth++;
    dropping(true);
  });
  document.addEventListener("dragover", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (e) => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropping(false);
  });
  document.addEventListener("drop", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropping(false);
    addFiles(e.dataTransfer!.files);
    text.focus();
  });
  const memoryOff = $<HTMLButtonElement>("now-memory-off");
  const memory = new ChatMemory({
    tabId: () => opts.tabId?.() ?? null,
    onChange: () => drawMemory(),
    onError: (text) => notices.show({ key: "memory", level: "error", text }),
  });
  const model = initModelPicker({
    onState: opts.onState,
    onError: (text) => notices.show({ key: "model", level: "error", text }),
    onTopup: () => opts.onTopup?.(),
    memory: { view: () => memory.view(), toggle: () => void memory.toggle() },
  });
  /** The "memory off" button next to the model, and the menu's switch if it is open. */
  function drawMemory(): void {
    memoryOff.hidden = !memory.view().offBadge;
    model.refresh();
  }
  memoryOff.addEventListener("click", () => void memory.toggle());
  // The attach control is a label around a hidden input; make it keyboard-operable.
  attach.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  let running = new Set<string>();
  let shown: SessionInfo | null = null;

  const target = (): SessionInfo | null => shown;
  const mode = (): ComposerMode => {
    const t = target();
    if (!t) return "new";
    return running.has(t.sessionId) ? "running" : "conversation";
  };

  /** The follow-up suggestion after what is typed (or nothing), for eyes and for screen readers. */
  const drawSuggestion = () => {
    const shown = suggestion.shown(text.value);
    ghost.hidden = shown === null;
    ghostTyped.textContent = shown === null ? "" : text.value;
    ghostRest.textContent = suggestion.rest(text.value) ?? "";
    suggestionText.textContent = shown === null ? "" : suggestionDescription(shown);
    if (shown === null) text.removeAttribute("aria-describedby");
    else text.setAttribute("aria-describedby", suggestionText.id);
    text.placeholder = shown !== null ? "" : dictating === "listening" ? LISTENING_PLACEHOLDER : dictating === "starting" ? STARTING_PLACEHOLDER : dictating === "muted" ? MUTED_PLACEHOLDER : placeholder;
  };

  /** Grow with the text (or the suggestion shown in it) up to MAX_ROWS lines, then scroll inside. */
  const fit = () => {
    drawSuggestion();
    const cs = getComputedStyle(text);
    const line = parseFloat(cs.lineHeight) || 20;
    const max = line * MAX_ROWS + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    text.style.height = "auto";
    const full = Math.max(text.scrollHeight, ghost.hidden ? 0 : ghost.offsetHeight);
    text.style.height = `${Math.min(full, max)}px`;
    text.style.overflowY = full > max ? "auto" : "hidden";
    form.classList.toggle("blank", !text.value.trim());
  };
  text.addEventListener("input", fit);
  // Clicking the box around the textarea (not a control) focuses it, like chat apps.
  form.addEventListener("mousedown", (e) => {
    if (e.target === form || (e.target as HTMLElement).classList.contains("now-bar")) {
      e.preventDefault();
      text.focus();
    }
  });
  // Enter sends, Shift+Enter adds a line (like chat apps). Tab takes a shown suggestion, Esc dismisses it.
  text.addEventListener("keydown", (e) => {
    const took = suggestion.onKey(e, text.value);
    if (took) {
      e.preventDefault();
      if (took !== "dismissed") {
        text.value = took.accept;
        text.setSelectionRange(text.value.length, text.value.length);
      }
      fit();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  /** A message is going out: the box empties, and this turn's suggestion must not come back before the next turn's. */
  const dismissSuggestion = () => {
    suggestion.dismiss();
    fit();
  };

  const clearInput = () => {
    text.value = "";
    fit();
  };

  /**
   * A message is going out: its correlation id for the trace, and once the background took it (in `sessionId`),
   * a "user.send" event with how long that took.
   */
  const traced = (chars: number) => {
    const cid = opts.trace?.newCid();
    const span = traceStart();
    return {
      cid: cid ? { cid } : {},
      sent(sessionId: string, mode: string) {
        if (!cid || !opts.trace) return;
        opts.trace.record({ t: span.t, ms: span.elapsed(), cat: "user", name: "user.send", cid, data: { chars, mode, via: "typed" } });
        opts.trace.bind(cid, sessionId);
      },
    };
  };

  /**
   * The box's files for a message now (after "Preparing files…" while some are not ready): `fields` for the
   * request, and sent() once it went out.
   */
  const withFiles = async (): Promise<{ fields: { attachments?: UiAttachmentUpload[] }; sent(): void }> => {
    if (!tray.count) return { fields: {}, sent: () => {} };
    if (tray.busy) progress("Preparing files…");
    const batch = await tray.batch();
    return { fields: batch.uploads.length ? { attachments: batch.uploads } : {}, sent: batch.sent };
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = text.value.trim();
    if (!value) return sendEmpty();
    const m = mode();
    const t = target();
    // The running turn's agent cannot be given files: they wait in the box (the text stays too).
    if (m === "running" && tray.count) return hint(FILES_WHILE_RUNNING);
    dismissSuggestion();
    const sending = traced(value.length);
    void busy(
      submit,
      async () => {
        if (m !== "new" && t) {
          clearInput();
          if (m === "conversation") progress("Sending…");
          try {
            const files = await withFiles();
            const r = await uiRequest({ type: "run.message", sessionId: t.sessionId, text: value, ...tab(), ...sending.cid, ...files.fields });
            files.sent();
            sending.sent(r.sessionId, r.mode);
          } catch (err) {
            // Not sent: the text goes back into the box (the files are still there).
            text.value = value;
            fit();
            throw err;
          }
          settled();
          if (m === "conversation") opts.onStarted(t.sessionId);
          return;
        }
        const files = await withFiles();
        progress("Starting…");
        // No account field here: the agent picks up accounts named in the text ("post this from @beta").
        const { sessionId } = await uiRequest({ type: "run.adhoc", instructions: value, ...files.fields, ...tab(), ...sending.cid, ...memory.forNewChat() });
        files.sent();
        sending.sent(sessionId, "new");
        clearInput();
        settled();
        opts.onStarted(sessionId);
      },
      problem,
    );
  });

  /** Empty box: look at the page (see emptySend). */
  function sendEmpty(): void {
    const t = target();
    const next = emptySend({ mode: mode(), sessionId: t?.sessionId ?? null, hasFiles: tray.count > 0, tabId: opts.tabId?.() ?? null });
    if ("hint" in next) return hint(next.hint);
    dismissSuggestion();
    void busy(
      submit,
      async () => {
        progress("Looking at the page…");
        const { sessionId } = await uiRequest(next.request.type === "run.adhoc" ? { ...next.request, ...memory.forNewChat() } : next.request);
        settled();
        opts.onStarted(sessionId);
      },
      problem,
    );
  }


  stop.addEventListener("click", () => {
    // Stops this conversation's turn (and voice with it); other tasks keep running.
    const t = target();
    opts.onStop?.(t?.sessionId ?? null);
    void busy(stop, () => uiRequest({ type: "run.stop", ...(t ? { sessionId: t.sessionId } : {}) }), problem);
  });

  function render(): void {
    const m = mode();
    placeholder = m !== "new" ? CHAT_PLACEHOLDER : NEW_JOB_PLACEHOLDER;
    suggestion.setOffer(m === "conversation" ? offerOf(target()) : null);
    fit();
    // An empty box can be sent: it looks at the page.
    const screenOk = m !== "running" && tray.count === 0;
    form.classList.toggle("screen-ok", screenOk);
    submit.title = screenOk ? SCREEN_SEND_TITLE : "Send";
    text.setAttribute("aria-label", m === "new" ? "Task to do now" : m === "running" ? "Message to the agent" : "Next message in this conversation");
    stop.hidden = m !== "running";
    filesList.hidden = tray.count === 0;
    form.classList.toggle("running", m === "running");
    model.setRunning(m === "running");
  }

  const view: ComposerView = {
    setRunning(next) {
      running = new Set(next.map((s) => s.sessionId));
      render();
    },
    setConversation(session) {
      shown = session;
      memory.setConversation(session);
      drawMemory();
      render();
    },
    target,
    mode,
    actionSlot: $("now-actions"),
    draft: () => text.value,
    setDraft(value) {
      text.value = value;
      fit();
      // Keep the end of what is being dictated in view.
      text.scrollTop = text.scrollHeight;
    },
    setDictating(look) {
      dictating = look;
      suggestion.setDictating(look !== "off");
      fit();
    },
    focus() {
      text.focus();
    },
    async continueNow(sessionId) {
      const note = text.value.trim();
      dismissSuggestion();
      try {
        const files = await withFiles();
        progress("Continuing…");
        await uiRequest({ type: "run.continue", sessionId, ...(note ? { text: note } : {}), ...tab(), ...files.fields });
        files.sent();
        if (note) clearInput();
        settled();
        opts.onStarted(sessionId);
      } catch (err) {
        showError(err);
      }
    },
    setState(state) {
      model.setState(state);
      memory.setPaused(state.settings.memoryPaused);
      drawMemory();
    },
    showError(err) {
      showError(err);
    },
    notices,
    memory,
    attachments: {
      get count() {
        return tray.count;
      },
      batch: () => tray.batch(),
    },
  };

  render();
  return view;
}

/** The suggestion an ended turn left (SessionInfo.suggestion); a dismissal lasts until the next turn ends. */
function offerOf(session: SessionInfo | null): SuggestionOffer | null {
  if (!session?.suggestion) return null;
  return { text: session.suggestion, turn: `${session.sessionId}@${session.endedAt ?? ""}` };
}
