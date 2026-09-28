import { delay, errorMessage } from "@noa/shared";

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
 * chrome.debugger wrapper for the agent's tabs. Several tabs can be attached at
 * once (a run may read many tabs without activating them); `send` targets the
 * current tab (the last one passed to attach()), `sendTo` any tab. A tab is
 * reattached on the next command after an unexpected detach; a detach by the
 * user (infobar "Cancel") is final for every tab until reset() is called for
 * the next task.
 */
export class Cdp {
  /** The current tab: the default target of send(). */
  private tabId: number | null = null;
  private readonly attached = new Set<number>();
  /** Attaches in flight, so parallel reads of one tab attach it once. */
  private readonly attaching = new Map<number, Promise<void>>();
  private canceledByUser = false;
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
  }

  /** A command on the current tab. */
  async send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.canceledByUser) throw new Error(DEBUGGER_CANCELED);
    if (this.tabId === null) throw new Error("debugger is not attached");
    return this.sendTo<T>(this.tabId, method, params);
  }

  /** A command on any tab, attaching to it first when needed (again, while its page is being swapped: see NOT_ACTIVE_PAGE). */
  async sendTo<T = Record<string, unknown>>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.ensure(tabId);
      try {
        return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
      } catch (err) {
        if (attempt >= NOT_ACTIVE_RETRIES.tries || !NOT_ACTIVE_PAGE.test(errorMessage(err))) throw err;
        this.attached.delete(tabId);
        await chrome.debugger.detach({ tabId }).catch(() => {});
        await delay(NOT_ACTIVE_RETRIES.waitMs);
      }
    }
  }

  /** Detaches from one tab (default: the current tab). */
  async detach(tabId: number | null = this.tabId): Promise<void> {
    if (tabId === null) return;
    const was = this.attached.delete(tabId);
    if (was || tabId === this.tabId) await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  /** chrome.debugger.onDetach handler. */
  handleDetach(source: { tabId?: number }, reason: string): void {
    const tabId = source.tabId;
    if (tabId === undefined || (tabId !== this.tabId && !this.attached.has(tabId))) return;
    this.attached.delete(tabId);
    if (reason === "canceled_by_user") {
      // Chrome's infobar cancel ends debugging of every tab.
      this.canceledByUser = true;
      this.attached.clear();
      this.onUserCancel?.();
    }
  }

  /** Clear a user cancel before the next task. */
  reset(): void {
    this.canceledByUser = false;
  }
}
