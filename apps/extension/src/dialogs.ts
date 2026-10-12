/**
 * The JavaScript dialogs of one agent slot's run (dialog.ts): who answered each, the line the run's events get for
 * it, and the automatic answer when nobody gives one in DIALOG_AUTO_DISMISS_MS (Cancel; an alert just OK), so a run
 * nobody watches never hangs on a frozen page and never leaves a page or confirms anything on its own. The wait
 * stops while an approval waits for the user (hold): the agent's OK on the dialog may be what they are deciding.
 *
 * Only dialogs that open while a run uses the slot, in its tabs, are the run's: one a user's tab had before is
 * left alone (the agent still sees it, and may answer it).
 */
import { DIALOG_AUTO_DISMISS_MS, dialogAnswerLabel, dialogLabel, type AgentEvent, type JsDialog } from "@noa/shared";
import { DialogOpenError, type Cdp, type DialogChange } from "./cdp.js";

export type DialogEvent = Extract<AgentEvent, { type: "dialog" }>;

export interface DialogWatchDeps {
  cdp: Pick<Cdp, "onDialog" | "dialogOf" | "handleDialog">;
  /** The session using the slot now; null between runs. */
  session(): string | null;
  /** The run's short id of a tab ("t2"); null when the tab is not one of the slot's. */
  shortId(tabId: number): Promise<string | null>;
  /** Adds the line to the session's run. */
  emit(sessionId: string, event: DialogEvent): void;
  /** Default DIALOG_AUTO_DISMISS_MS. */
  autoAnswerMs?: number;
  log?(line: string): void;
}

interface Watched {
  sessionId: string;
  tab: string;
  dialog: JsDialog;
  timer?: ReturnType<typeof setTimeout>;
  /** Set once the agent or the watch answered it. */
  answered?: { by: "agent" | "auto"; accepted: boolean };
}

export class DialogWatch {
  private readonly open = new Map<number, Watched>();
  private holds = 0;
  /** What the agent is told with its next result: dialogs answered automatically. */
  private readonly notes: string[] = [];
  /** The last dialog of each tab answered automatically, for a handle_dialog that comes too late. */
  private readonly autoAnswered = new Map<number, JsDialog>();
  private readonly autoAnswerMs: number;

  constructor(private readonly deps: DialogWatchDeps) {
    this.autoAnswerMs = deps.autoAnswerMs ?? DIALOG_AUTO_DISMISS_MS;
    deps.cdp.onDialog((change) =>
      void this.onChange(change).catch((err: unknown) => deps.log?.(`dialog in tab ${change.tabId}: ${err instanceof Error ? err.message : String(err)}`)),
    );
  }

  /** The agent answers the tab's dialog now (handle_dialog): its close is the agent's, and nothing answers it for it. */
  answering(tabId: number, accepted: boolean): void {
    const w = this.open.get(tabId);
    if (!w) return;
    this.disarm(w);
    w.answered = { by: "agent", accepted };
  }

  /** The agent's answer did not go through: the dialog is still open and waits for one again. */
  notAnswered(tabId: number): void {
    const w = this.open.get(tabId);
    if (!w || w.answered?.by !== "agent") return;
    delete w.answered;
    if (!this.holds) this.arm(tabId, w);
  }

  /** Stops the automatic answers until the returned function is called (an approval waits for the user meanwhile). */
  hold(): () => void {
    this.holds++;
    for (const w of this.open.values()) this.disarm(w);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds > 0) return;
      for (const [tabId, w] of this.open) if (!w.answered) this.arm(tabId, w);
    };
  }

  /** The dialogs answered automatically since the last call, in words for the agent. */
  takeNotes(): string[] {
    return this.notes.splice(0);
  }

  /** The tab's last dialog answered automatically, if it has not had another since. */
  lastAutoAnswered(tabId: number): JsDialog | null {
    return this.autoAnswered.get(tabId) ?? null;
  }

  private async onChange(c: DialogChange): Promise<void> {
    if (c.state === "open") {
      const sessionId = this.deps.session();
      if (!sessionId) return;
      this.autoAnswered.delete(c.tabId);
      const tab = await this.deps.shortId(c.tabId);
      // Not the run's tab, or answered already while its id was looked up.
      if (!tab || this.deps.cdp.dialogOf(c.tabId) !== c.dialog) return;
      const w: Watched = { sessionId, tab, dialog: c.dialog };
      this.open.set(c.tabId, w);
      if (!this.holds) this.arm(c.tabId, w);
      return;
    }
    const w = this.open.get(c.tabId);
    if (!w || w.dialog !== c.dialog) return;
    this.open.delete(c.tabId);
    this.disarm(w);
    // Chrome's answer, or when the tab went away first, the answer given to it.
    const accepted = c.answer?.accepted ?? w.answered?.accepted;
    if (accepted === undefined) return;
    const text = w.dialog.type === "prompt" && accepted && c.answer?.text ? c.answer.text : undefined;
    const by = w.answered?.by ?? "user";
    this.deps.emit(w.sessionId, { type: "dialog", dialog: w.dialog, outcome: accepted ? "accepted" : "dismissed", by, tab: w.tab, ...(text ? { text } : {}) });
    if (by === "auto") {
      this.autoAnswered.set(c.tabId, w.dialog);
      this.notes.push(autoAnswerNote(w.dialog, w.tab, this.autoAnswerMs));
    }
  }

  private arm(tabId: number, w: Watched): void {
    this.disarm(w);
    w.timer = setTimeout(() => void this.autoAnswer(tabId, w), this.autoAnswerMs);
  }

  private disarm(w: Watched): void {
    if (w.timer !== undefined) clearTimeout(w.timer);
    delete w.timer;
  }

  /** Nobody answered in time: Cancel (Stay on the page), or OK on an alert, which has nothing else. */
  private async autoAnswer(tabId: number, w: Watched): Promise<void> {
    delete w.timer;
    if (this.open.get(tabId) !== w || w.answered) return;
    const accepted = w.dialog.type === "alert";
    w.answered = { by: "auto", accepted };
    try {
      await this.deps.cdp.handleDialog(tabId, accepted);
    } catch (err) {
      delete w.answered;
      this.deps.log?.(`answering the dialog in tab ${tabId} automatically failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** What the agent is told about a dialog nobody answered in time. */
export function autoAnswerNote(dialog: JsDialog, tab: string, ms: number): string {
  const how = dialog.type === "alert" ? "closed automatically (OK)" : "cancelled automatically";
  const stays = dialog.type === "alert" ? "" : dialog.type === "beforeunload" ? " The tab stayed on its page." : " The page did not get an OK.";
  return `The browser dialog ${dialogLabel(dialog)} in ${tab} was ${how}: nobody answered it within ${ms / 1000} s.${stays}`;
}

/** handle_dialog's error when no dialog is open in the tab (and why, when the last one was answered automatically). */
export function noDialogText(tab: string, autoAnswered: JsDialog | null): string {
  const why = autoAnswered
    ? ` Its last one, ${dialogLabel(autoAnswered)}, was answered automatically (${dialogAnswerLabel(autoAnswered.type, autoAnswered.type === "alert" ? "accepted" : "dismissed")}) because nobody answered it in time. If it is still needed, do what opened it again and answer the dialog right away.`
    : "";
  return `No browser dialog is open in ${tab}.${why}`;
}

/** A tab that did not close: its page asked "Leave site?" (or had a dialog open), which is `dialog`. */
export interface CloseAsked {
  tabId: number;
  dialog: JsDialog;
}

/**
 * Closes tabs without ever leaving a page's unsaved changes silently: a tab whose page asks "Leave site?" as it
 * closes (or has a dialog open) stays open. Its dialog is left for the agent to answer, or with cancel, answered
 * Cancel at once (a run's cleanup: the page and what it holds stay for the user). Each tab is attached to first, so
 * that its dialog is seen; chrome.tabs.remove would otherwise wait on it for ever. A tab already gone counts as closed.
 */
export async function closeTabsAsking(cdp: Pick<Cdp, "ensure" | "assertNoDialog" | "failOnDialog" | "handleDialog">, tabIds: readonly number[], opts: { cancel?: boolean } = {}): Promise<{ closed: number[]; asked: CloseAsked[] }> {
  const closed: number[] = [];
  const asked: CloseAsked[] = [];
  await Promise.all(
    tabIds.map(async (tabId) => {
      await cdp.ensure(tabId).catch(() => undefined);
      try {
        cdp.assertNoDialog(tabId);
        await cdp.failOnDialog([tabId], chrome.tabs.remove(tabId));
        closed.push(tabId);
      } catch (err) {
        if (err instanceof DialogOpenError) {
          if (opts.cancel) await cdp.handleDialog(tabId, false).catch(() => undefined);
          asked.push({ tabId, dialog: err.dialog });
        } else {
          closed.push(tabId);
        }
      }
    }),
  );
  return { closed: tabIds.filter((t) => closed.includes(t)), asked };
}
