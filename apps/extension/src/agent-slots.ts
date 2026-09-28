/**
 * Agent slots: runs that happen at the same time each act in their own tab.
 * A slot is an AgentTab (its tabs in the Noa group) plus a Driver on
 * the shared debugger. The runner takes a slot for a session and gives it
 * back when the turn ends; browser calls from the helper name their session
 * (BrowserCallContext) and are served by that session's slot.
 */
import type { BrowserCaller } from "@noa/core";
import type { ApprovalRequest, Screenshot } from "@noa/shared";
import { AgentTab, closeChatTabs, type TabMode } from "./agent-tab.js";
import type { Cdp } from "./cdp.js";
import { Driver } from "./driver.js";
import { createBrowserCaller, tracedBrowser, type BrowserCallTrace, type VaultLike } from "./engine/browser-caller.js";
import { isRestrictedError } from "./restricted.js";
import { ApprovalGate, type GateDeps } from "./approval/gate.js";

/** What the runner needs of a slot (see RunnerDeps.slots). */
export interface AgentSlot {
  readonly index: number;
  /**
   * Picks the slot's main tab for a run and attaches the debugger (see
   * AgentTab.prepare). tabId: with mode current-tab, the tab the run belongs
   * to. Returns the tab picked.
   */
  prepare(opts: { mode?: TabMode; tabId?: number }): Promise<number>;
  /** Browser calls in this slot's tabs (the Claude API brain, post verification). */
  readonly browser: BrowserCaller;
  isAgentTab(tabId: number): Promise<boolean>;
  screenshot(): Promise<Screenshot>;
  /**
   * start is called each time the slot starts waiting (a wait_for slice, an approval the user has not answered);
   * it returns what ends that wait. The runner's turn clock leaves waits out of the time limit. Returns what
   * unregisters it.
   */
  onWait(start: () => () => void): () => void;
}

/** Agent slots (tabs) in use at most: maxParallelTasks due tasks plus one-off runs beside them. */
export const MAX_SLOTS = 6;

export interface SlotPool {
  /** How many slots there are (indexes 0 .. size - 1). */
  readonly size: number;
  /** The slot with this index, now used by this session (its browser calls go there). */
  take(index: number, sessionId: string): AgentSlot;
  /**
   * The session's turn ended: its browser calls are refused. keepTabs: the
   * tabs it opened stay open for its next turn (a chat); else they close.
   */
  release(index: number, sessionId: string, opts: { keepTabs: boolean }): void;
  /** The chat is over (New Chat): the tabs its turns opened close. */
  endChat(sessionId: string): Promise<void>;
}

interface Slot extends AgentSlot {
  tab: AgentTab;
  driver: Driver;
  /** The session using the slot right now. */
  sessionId: string | null;
  /** Holds actions until the automation level allows them (null: no gate). */
  gate: ApprovalGate | null;
  /** The last turn's tab cleanup (release): the next prepare in any slot waits for it. */
  ending: Promise<unknown>;
}

/** The approval gate's needs (approval/gate.ts), and how a turn's waiting requests end with it. */
export type SlotApprovals = GateDeps & { end(sessionId: string): void };

export class AgentSlots implements SlotPool {
  readonly size = MAX_SLOTS;
  private readonly slots = new Map<number, Slot>();

  constructor(
    private readonly cdp: Cdp,
    private readonly vault: VaultLike,
    /** Tabs that belong to a conversation: scheduled runs do not take them over. */
    private readonly isChatTab?: (tabId: number) => Promise<boolean>,
    /** Each browser call of a session, timed, for its conversation's trace. */
    private readonly onBrowserCall?: (sessionId: string, call: Parameters<BrowserCallTrace>[0]) => void,
    /** Approvals before actions (the automation level). Absent: nothing waits. */
    private readonly approvals?: SlotApprovals,
  ) {}

  /** Slot n, created on first use. Slot 0 is the first agent tab. */
  get(index: number): Slot {
    const existing = this.slots.get(index);
    if (existing) return existing;
    const { isChatTab } = this;
    const tab = new AgentTab(index, {
      isTaken: (tabId) => this.takenByOther(index, tabId),
      ...(isChatTab ? { isChatTab } : {}),
    });
    const driver = new Driver(this.cdp, tab, { knownTabs: () => this.allTabIds() });
    const cdp = this.cdp;
    const cleanedUp = () => this.cleanedUp();
    const onCall = this.onBrowserCall;
    const plain = createBrowserCaller(driver, this.vault);
    // Calls made for a session are timed in its trace.
    const traced = onCall
      ? tracedBrowser(plain, () => (driver.inFallback ? "fallback" : "cdp"), (call) => {
          if (slot.sessionId) onCall(slot.sessionId, call);
        })
      : plain;
    // Waiting (a wait_for slice, an unanswered approval) is left out of the turn's time limit (onWait).
    const waiting = new Set<() => () => void>();
    const startWait = () => {
      const ends = [...waiting].map((start) => start());
      return () => ends.forEach((end) => end());
    };
    // The gate is outside the timing: a browser call's time never includes the user deciding.
    const gate = this.approvals ? new ApprovalGate(traced, () => slot.sessionId, this.approvals, startWait) : null;
    const gated = gate?.browser ?? traced;
    const slot: Slot = {
      index,
      tab,
      driver,
      sessionId: null,
      gate,
      ending: Promise.resolve(),
      browser: {
        call: (method, params) => {
          if (method !== "browser.waitFor") return gated.call(method, params);
          const end = startWait();
          return gated.call(method, params).finally(end);
        },
      },
      async prepare(opts) {
        cdp.reset();
        // A chat's tabs are parked by its last turn's release, maybe in another slot.
        await cleanedUp();
        // The run's tab is picked once; the driver keeps using it for the whole turn.
        const tabId = await tab.prepare(opts.mode ?? "own-tab", {
          ...(opts.tabId === undefined ? {} : { tabId: opts.tabId }),
          ...(slot.sessionId ? { owner: slot.sessionId } : {}),
        });
        // Never brought to the front: the user may be using another tab (only "Show Tab" does that).
        // A page Chrome keeps extensions out of does not end the run: its tools say so, other tabs work.
        await driver.ready().catch((err: unknown) => {
          if (!isRestrictedError(err)) throw err;
        });
        return tabId;
      },
      isAgentTab: (tabId) => tab.isAgentTab(tabId),
      screenshot: () => driver.screenshot(),
      onWait: (start) => {
        waiting.add(start);
        return () => void waiting.delete(start);
      },
    };
    this.slots.set(index, slot);
    return slot;
  }

  take(index: number, sessionId: string): AgentSlot {
    const s = this.get(index);
    s.sessionId = sessionId;
    // "Allow for this task" lasts one turn.
    s.gate?.release();
    return s;
  }

  release(index: number, sessionId: string, opts: { keepTabs: boolean }): void {
    const s = this.slots.get(index);
    if (!s || s.sessionId !== sessionId) return;
    s.sessionId = null;
    // Approvals still waiting end with the turn (their actions are not done).
    s.gate?.release();
    this.approvals?.end(sessionId);
    // A chat's tabs stay open for it (the user may sign in or follow up there); an unattended run's go away. The main tab stays.
    s.ending = (opts.keepTabs ? s.tab.park(sessionId) : s.driver.closeOpenedTabs()).catch(() => 0);
  }

  /**
   * Closes the tabs a chat's turns opened, except ones another run or chat
   * uses now. Not while a turn of it runs (its tabs are that turn's).
   */
  async endChat(sessionId: string): Promise<void> {
    if (this.slotUsedBy(sessionId)) return;
    await this.cleanedUp();
    const inUse = new Set(await this.allTabIds());
    await closeChatTabs(sessionId, async (tabId) => inUse.has(tabId) || !!(await this.isChatTab?.(tabId)));
  }

  /**
   * Where a helper browser call goes: the slot of the session that made it.
   * No session (mcp-server --attach): the first agent tab. A session without
   * a slot (its turn ended) is refused.
   */
  browserFor(sessionId: string | undefined): BrowserCaller {
    if (!sessionId) return this.get(0).browser;
    const slot = this.slotUsedBy(sessionId);
    if (slot) return slot.browser;
    throw new Error("This task session has no browser tab right now (its turn has ended). Stop and wait for the user's next message.");
  }

  /**
   * The user's OK for a change a session's agent makes outside the page (a TODO task changed or cancelled), at
   * its automation level, through its slot's gate ("Allow for this task" and the turn's clock are the slot's).
   * Without approvals nothing waits. A session without a slot (its turn ended) is refused.
   */
  async confirm(sessionId: string, request: Omit<ApprovalRequest, "id" | "expiresAt">): Promise<void> {
    const slot = this.slotUsedBy(sessionId);
    if (!slot) throw new Error("This task session has no turn running right now (its turn has ended), so nothing was changed. Stop and wait for the user's next message.");
    await slot.gate?.confirm(sessionId, request);
  }

  /** The slot a session uses right now, if any. */
  slotOf(sessionId: string): number | null {
    return this.slotUsedBy(sessionId)?.index ?? null;
  }

  /** Brings the session's tab to the front (default: the first agent tab). */
  async show(sessionId?: string): Promise<boolean> {
    const index = (sessionId && this.slotOf(sessionId)) || 0;
    return this.get(index).tab.show();
  }

  /** The tabs a running session acts in (the one it acts on now first, where the user can watch it), or none. */
  async tabsOf(sessionId: string): Promise<number[]> {
    const tab = this.slotUsedBy(sessionId)?.tab;
    if (!tab) return [];
    const [ids, now] = await Promise.all([tab.tabIds(), tab.tabId()]);
    return now !== null && ids.includes(now) ? [now, ...ids.filter((id) => id !== now)] : ids;
  }

  /**
   * A new tab: when a page of a running session's tabs opened it, that
   * session's slot takes it (see AgentTab.adopt). A tab the user opens from
   * their tab while no turn runs there stays theirs.
   */
  async adopt(tab: { id?: number; openerTabId?: number }): Promise<void> {
    if (tab.id === undefined || tab.openerTabId === undefined) return;
    for (const s of this.slots.values()) {
      if (s.sessionId === null) continue;
      if (await s.tab.adopt(tab.id, tab.openerTabId)) return;
    }
  }

  /** Every tab of every slot. */
  async allTabIds(): Promise<number[]> {
    const ids = await Promise.all([...this.slots.values()].map((s) => s.tab.tabIds()));
    return ids.flat();
  }

  /** Every slot's last turn cleanup is done. */
  private async cleanedUp(): Promise<void> {
    await Promise.all([...this.slots.values()].map((s) => s.ending));
  }

  private slotUsedBy(sessionId: string): Slot | undefined {
    for (const s of this.slots.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  }

  private async takenByOther(index: number, tabId: number): Promise<boolean> {
    for (const s of this.slots.values()) {
      if (s.index === index || s.sessionId === null) continue;
      if (await s.tab.isAgentTab(tabId)) return true;
    }
    return false;
  }
}
