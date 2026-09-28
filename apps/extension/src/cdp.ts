import { delay, dialogOpenText, errorMessage, type JsDialog, type JsDialogType } from "@noa/shared";

/**
 * Chrome's answer while a tab's page is being swapped for another (a tab a
 * page just opened, on its first navigation): the command did not run, and
 * attaching again after a moment works.
 */
const NOT_ACTIVE_PAGE = /Not attached to an active page/i;
/** Tries of a command that meets NOT_ACTIVE_PAGE, and the wait between them. */
export const NOT_ACTIVE_RETRIES = { tries: 4, waitMs: 150 };

/** Every command fails with this once the user canceled debugging from Chrome's infobar (failure classification reads it as final). */
export const DEBUGGER_CANCELED = "The debugger was detached by the user (the Cancel button on Chrome's debugging bar)";

/**
 * A command on a tab whose page a JavaScript dialog froze (dialog.ts): Chrome would answer it only once the dialog
 * is closed, so it fails at once instead. tab: the run's short id, when it is not the current tab.
 */
export class DialogOpenError extends Error {
  constructor(
    readonly dialog: JsDialog,
    tab?: string,
  ) {
    super(dialogOpenText(dialog, tab));
    this.name = "DialogOpenError";
  }
}

/** The commands that still answer while a dialog is open. */
const ANSWERED_DURING_DIALOG = new Set(["Page.handleJavaScriptDialog", "Page.enable"]);

/** How a dialog was answered: OK or Cancel, and a prompt's text. */
export interface DialogAnswerSeen {
  accepted: boolean;
  text: string;
}

/** A dialog opened in a tab, or closed (answer: how; null when its page or tab went away first). */
export type DialogChange = { tabId: number; dialog: JsDialog } & ({ state: "open" } | { state: "closed"; answer: DialogAnswerSeen | null });

/**
 * chrome.debugger wrapper for the agent's tabs. Several tabs can be attached at
 * once (a run may read many tabs without activating them); `send` targets the
 * current tab (the last one passed to attach()), `sendTo` any tab. A tab is
 * reattached on the next command after an unexpected detach; a detach by the
 * user (infobar "Cancel") is final for every tab until reset() is called for
 * the next task.
 *
 * Every attached tab has the Page domain on, so its JavaScript dialogs are known (handleEvent): while one is open,
 * commands on that tab fail with DialogOpenError, and so do the ones in flight when it opens, instead of waiting
 * until someone answers it. Chrome still shows its own dialog, so the user can answer it there too.
 */
export class Cdp {
  /** The current tab: the default target of send(). */
  private tabId: number | null = null;
  private readonly attached = new Set<number>();
  /** Attaches in flight, so parallel reads of one tab attach it once. */
  private readonly attaching = new Map<number, Promise<void>>();
  private canceledByUser = false;
  /** The open JavaScript dialog of each tab that has one. */
  private readonly dialogs = new Map<number, JsDialog>();
  /** Work in flight per tab (see failOnDialog), each failed by a dialog that opens. */
  private readonly inFlight = new Map<number, Set<(dialog: JsDialog) => void>>();
  private readonly dialogListeners = new Set<(change: DialogChange) => void>();
  /** Called when the user cancels debugging from Chrome's infobar. */
  onUserCancel: (() => void) | null = null;

  /** The current tab, when the debugger is attached to it. */
  get attachedTabId(): number | null {
    return this.tabId !== null && this.attached.has(this.tabId) ? this.tabId : null;
  }

  /** Tabs the debugger is attached to right now. */
  get attachedTabs(): number[] {
    return [...this.attached];
  }

  /** Attaches to the tab (if needed) and makes it the target of send(). */
  async attach(tabId: number): Promise<void> {
    await this.ensure(tabId);
    this.tabId = tabId;
  }

  /** Attaches to the tab if needed, without changing the current tab. */
  async ensure(tabId: number): Promise<void> {
    if (this.canceledByUser) throw new Error(DEBUGGER_CANCELED);
    if (this.attached.has(tabId)) return;
    let pending = this.attaching.get(tabId);
    if (!pending) {
      pending = this.attachRaw(tabId).finally(() => this.attaching.delete(tabId));
      this.attaching.set(tabId, pending);
    }
    await pending;
  }

  private async attachRaw(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      // Left over from a previous service worker lifetime: detach and retry once.
      if (!/already attached/i.test(errorMessage(err))) throw err;
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.debugger.attach({ tabId }, "1.3");
    }
    this.attached.add(tabId);
    // Let pages behave as focused even when the tab is in the background.
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    // Its JavaScript dialogs (Page.javascriptDialogOpening / Closed, see handleEvent).
    await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  }

  /** A command on the current tab. */
  async send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.canceledByUser) throw new Error(DEBUGGER_CANCELED);
    if (this.tabId === null) throw new Error("debugger is not attached");
    return this.sendTo<T>(this.tabId, method, params);
  }

  /**
   * A command on any tab, attaching to it first when needed (again, while its page is being swapped: see
   * NOT_ACTIVE_PAGE). Fails with DialogOpenError while a dialog froze the page, or when one opens before it answers.
   */
  async sendTo<T = Record<string, unknown>>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    const duringDialog = ANSWERED_DURING_DIALOG.has(method);
    for (let attempt = 1; ; attempt++) {
      await this.ensure(tabId);
      if (!duringDialog) this.assertNoDialog(tabId);
      try {
        const sent = chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>;
        return duringDialog ? await sent : await this.failOnDialog([tabId], sent);
      } catch (err) {
        if (attempt >= NOT_ACTIVE_RETRIES.tries || !NOT_ACTIVE_PAGE.test(errorMessage(err))) throw err;
        this.attached.delete(tabId);
        await chrome.debugger.detach({ tabId }).catch(() => {});
        await delay(NOT_ACTIVE_RETRIES.waitMs);
      }
    }
  }

  /** The JavaScript dialog open in a tab, if any. */
  dialogOf(tabId: number): JsDialog | null {
    return this.dialogs.get(tabId) ?? null;
  }

  /** Throws DialogOpenError when a dialog froze the tab's page. */
  assertNoDialog(tabId: number): void {
    const dialog = this.dialogs.get(tabId);
    if (dialog) throw new DialogOpenError(dialog);
  }

  /**
   * `work` (a command, or a chrome.tabs.remove that a page's "Leave site?" holds up), failed with DialogOpenError as
   * soon as a dialog opens in one of these tabs: Chrome settles it only once the dialog is answered.
   */
  failOnDialog<T>(tabIds: readonly number[], work: Promise<T>): Promise<T> {
    // It settles when someone answers the dialog, and nothing waits for it then.
    work.catch(() => undefined);
    let fail!: (dialog: JsDialog) => void;
    const opened = new Promise<never>((_, reject) => (fail = (dialog) => reject(new DialogOpenError(dialog))));
    for (const tabId of tabIds) {
      const waiting = this.inFlight.get(tabId) ?? new Set();
      waiting.add(fail);
      this.inFlight.set(tabId, waiting);
    }
    return Promise.race([work, opened]).finally(() => {
      for (const tabId of tabIds) this.inFlight.get(tabId)?.delete(fail);
    });
  }

  /** Answers the tab's dialog: accept presses OK (Leave on "Leave site?"), otherwise Cancel; promptText is a prompt's answer. */
  async handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<void> {
    await this.sendTo(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
  }

  /** Called for every dialog that opens or closes in an attached tab; returns what unsubscribes. */
  onDialog(listener: (change: DialogChange) => void): () => void {
    this.dialogListeners.add(listener);
    return () => void this.dialogListeners.delete(listener);
  }

  /** chrome.debugger.onEvent handler: keeps each tab's open dialog. */
  handleEvent(source: { tabId?: number }, method: string, params?: unknown): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    if (method === "Page.javascriptDialogOpening") {
      const p = (params ?? {}) as { type?: JsDialogType; message?: string; url?: string; defaultPrompt?: string };
      const dialog: JsDialog = { type: p.type ?? "alert", message: p.message ?? "", url: p.url ?? "" };
      if (p.type === "prompt" && p.defaultPrompt) dialog.defaultPrompt = p.defaultPrompt;
      this.dialogs.set(tabId, dialog);
      for (const fail of [...(this.inFlight.get(tabId) ?? [])]) fail(dialog);
      this.tell({ tabId, dialog, state: "open" });
    } else if (method === "Page.javascriptDialogClosed") {
      const p = (params ?? {}) as { result?: boolean; userInput?: string };
      this.closeDialog(tabId, { accepted: p.result === true, text: p.userInput ?? "" });
    }
  }

  /** Detaches from one tab (default: the current tab). */
  async detach(tabId: number | null = this.tabId): Promise<void> {
    if (tabId === null) return;
    const was = this.attached.delete(tabId);
    this.closeDialog(tabId, null);
    if (was || tabId === this.tabId) await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  /** chrome.debugger.onDetach handler. */
  handleDetach(source: { tabId?: number }, reason: string): void {
    const tabId = source.tabId;
    if (tabId === undefined || (tabId !== this.tabId && !this.attached.has(tabId))) return;
    this.attached.delete(tabId);
    // Its dialog is out of sight now (the tab closed, or debugging ended).
    this.closeDialog(tabId, null);
    if (reason === "canceled_by_user") {
      // Chrome's infobar cancel ends debugging of every tab.
      this.canceledByUser = true;
      this.attached.clear();
      for (const t of [...this.dialogs.keys()]) this.closeDialog(t, null);
      this.onUserCancel?.();
    }
  }

  /** Clear a user cancel before the next task. */
  reset(): void {
    this.canceledByUser = false;
  }

  private closeDialog(tabId: number, answer: DialogAnswerSeen | null): void {
    const dialog = this.dialogs.get(tabId);
    if (!dialog) return;
    this.dialogs.delete(tabId);
    this.tell({ tabId, dialog, state: "closed", answer });
  }

  private tell(change: DialogChange): void {
    for (const listener of this.dialogListeners) {
      try {
        listener(change);
      } catch {
        /* a listener must not break the others */
      }
    }
  }
}
