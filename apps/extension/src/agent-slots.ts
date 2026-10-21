/**
 * Agent slots: runs that happen at the same time each act in their own tab.
 * A slot is an AgentTab (its tabs in the Noa group) plus a Driver on
 * the shared debugger. The runner takes a slot for a session and gives it
 * back when the turn ends; browser calls from the helper name their session
 * (BrowserCallContext) and are served by that session's slot.
 */
import type { BrowserCaller } from "@noa/core";
import type { AgentEvent, ApprovalRequest, Screenshot } from "@noa/shared";
import { AgentTab, closeChatTabs, type TabMode } from "./agent-tab.js";
import type { Cdp } from "./cdp.js";
import { bringTabForward, tabUrl, userActiveInWindowOf } from "./chrome-tabs.js";
import { closeTabsAsking, DialogWatch, type DialogEvent } from "./dialogs.js";
import { SHOT_NOT_SWITCHED } from "./driver-common.js";
import { Driver, type TabFront } from "./driver.js";
import { createBrowserCaller, tracedBrowser, type BrowserCallTrace, type FilesLike, type VaultLike } from "./engine/browser-caller.js";
import type { GenerateImageParams, GenerateImageResult } from "./engine/image-generator.js";
import { isRestrictedError } from "./restricted.js";
import { hostOf } from "./approval/consequence.js";
import { ApprovalGate, type GateDeps } from "./approval/gate.js";

/** What the runner needs of a slot (see RunnerDeps.slots). */
export interface AgentSlot {
  readonly index: number;
  /**
   * Picks the slot's main tab for a run and attaches the debugger (see
   * AgentTab.prepare). tabId: with mode current-tab, the tab the run belongs
   * to. userTabs false: the run is not given the user's other tabs (settings: shareOtherTabs). Returns the tab picked.
   */
  prepare(opts: { mode?: TabMode; tabId?: number; userTabs?: boolean }): Promise<number>;
  /** The user's other tabs the run may use, after prepare, and how many were left out (see AgentTab.userTabs). */
  userTabs?(): Promise<{ tabs: { id: string; url: string; title: string }[]; more: number }>;
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
  /**
   * The turn ended needing the user in a tab of the slot (a sign-in, a code): `tabId` (the tab that reached a login
   * page; the run's stop for it does not count as stopped here), else the one AgentTab.tabForUser names (a tab the
   * agent opened behind and paused about, or the current tab). Brings that tab forward when Auto tab switching allows
   * it (see AgentSlots.showForUser). chat: the user is talking with this run (a chat's turn), so it switches even
   * while they are active in that window; else (a scheduled run) not then. True when the tab is in front now.
   */
  showForUser?(opts: { chat: boolean; tabId?: number }): Promise<boolean>;
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
  /** The user did not let this turn switch to a tab for a screenshot (Not now, or no answer): it does not ask again. */
  switchRefused: keyof typeof SHOT_NOT_SWITCHED | null;
}

/** A tab of a session's run went into limited mode (Driver.fallbackOf): the line its chat gets. */
export type LimitedModeEvent = Extract<AgentEvent, { type: "limited_mode" }>;

/** Auto tab switching brought a tab of a session's run forward: the line its chat gets, once. */
export type AutoTabSwitchingEvent = Extract<AgentEvent, { type: "auto_tab_switching" }>;

/** The approval gate's needs (approval/gate.ts), and how a turn's waiting requests end with it. */
export type SlotApprovals = GateDeps & { end(sessionId: string): void };

export class AgentSlots implements SlotPool {
  readonly size = MAX_SLOTS;
  private readonly slots = new Map<number, Slot>();
  /** "<sessionId> <tabId>" of the tabs whose limited mode the session's chat was told about. */
  private readonly toldLimited = new Set<string>();
  /** "<sessionId> <why>" of the conversations told that Auto tab switching brought a tab forward, per reason (a screenshot, needs_you). */
  private readonly toldSwitching = new Set<string>();

  constructor(
    private readonly cdp: Cdp,
    private readonly vault: VaultLike,
    /** Tabs that belong to a conversation: scheduled runs do not take them over. */
    private readonly isChatTab?: (tabId: number) => Promise<boolean>,
    /** Each browser call of a session, timed, for its conversation's trace. */
    private readonly onBrowserCall?: (sessionId: string, call: Parameters<BrowserCallTrace>[0]) => void,
    /** Approvals before actions (the automation level). Absent: nothing waits. */
    private readonly approvals?: SlotApprovals,
    /**
     * What happened on a page of a session's run that its chat shows: a JavaScript dialog was answered (dialogs.ts),
     * a tab went into limited mode (once per tab and conversation in this worker).
     */
    private readonly onPageEvent?: (sessionId: string, event: DialogEvent | LimitedModeEvent | AutoTabSwitchingEvent) => void,
    /** generate_image (engine/image-generator.ts), for the session using the slot. Absent: the tool says it is not available. */
    private readonly images?: { generate(params: GenerateImageParams, sessionId: string | null): Promise<GenerateImageResult> },
    /** list_files: the user's Noa folder (engine/noa-folder.ts NoaFiles). Absent: the tool says it cannot be listed. */
    private readonly files?: FilesLike,
    /**
     * Auto tab switching (settings): whether a hidden tab is brought forward for a screenshot without asking (else
     * the user is asked on a card). Absent: a hidden tab is never brought forward.
     */
    private readonly autoTabSwitching?: () => Promise<boolean>,
  ) {}

  /** Closes a run's tabs at its end without leaving a page silently: "Leave site?" is answered Cancel, and the tab stays. */
  private readonly removeTabs = async (tabIds: number[]): Promise<void> => void (await closeTabsAsking(this.cdp, tabIds, { cancel: true }));

  /** Slot n, created on first use. Slot 0 is the first agent tab. */
  get(index: number): Slot {
    const existing = this.slots.get(index);
    if (existing) return existing;
    const { isChatTab } = this;
    const tab = new AgentTab(index, {
      isTaken: (tabId) => this.takenByOther(index, tabId),
      ...(isChatTab ? { isChatTab } : {}),
      removeTabs: this.removeTabs,
    });
    const onPageEvent = this.onPageEvent;
    const dialogs = new DialogWatch({
      cdp: this.cdp,
      session: () => slot.sessionId,
      shortId: (tabId) => tab.shortId(tabId),
      emit: (sessionId, event) => onPageEvent?.(sessionId, event),
    });
    const onFallback = (tabId: number) => void this.tellLimited(slot, tabId).catch(() => undefined);
    const auto = this.autoTabSwitching;
    const front: TabFront | undefined = auto && {
      auto: async () => (await auto()) || (await this.fullAutonomy(slot)),
      show: (tabId, opts) => this.showForShot(slot, tabId, opts),
    };
    const driver = new Driver(this.cdp, tab, { knownTabs: () => this.allTabIds(), dialogs, onFallback, ...(front ? { front } : {}) });
    const cdp = this.cdp;
    const cleanedUp = () => this.cleanedUp();
    const onCall = this.onBrowserCall;
    const images = this.images;
    const plain = createBrowserCaller(driver, this.vault, images ? { generate: (p) => images.generate(p, slot.sessionId) } : undefined, this.files);
    // Calls made for a session are timed in its trace.
    const traced = onCall
      ? tracedBrowser(plain, () => (driver.inFallback ? "fallback" : "cdp"), (call) => {
          if (slot.sessionId) onCall(slot.sessionId, call);
        })
      : plain;
    // Waiting (a wait_for slice, an unanswered approval) is left out of the turn's time limit (onWait). While the user
    // decides, no dialog is answered for them: the agent's OK on it may be what they are asked about.
    const waiting = new Set<() => () => void>([() => dialogs.hold()]);
    const startWait = () => {
      const ends = [...waiting].map((start) => start());
      return () => ends.forEach((end) => end());
    };
    // The gate is outside the timing: a browser call's time never includes the user deciding.
    const gate = this.approvals ? new ApprovalGate(traced, () => slot.sessionId, this.approvals, startWait, (t) => driver.openDialog(t)) : null;
    const gated = gate?.browser ?? traced;
    const slot: Slot = {
      index,
      tab,
      driver,
      sessionId: null,
      gate,
      ending: Promise.resolve(),
      switchRefused: null,
      showForUser: (opts) => this.showForUser(slot, opts),
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
          ...(opts.userTabs === false ? { userTabs: false } : {}),
        });
        // Not brought to the front here: the user may be using another tab ("Show Tab" does, and a screenshot that needs it: showForShot).
        // A page Chrome keeps extensions out of does not end the run: its tools say so, other tabs work.
        await driver.ready().catch((err: unknown) => {
          if (!isRestrictedError(err)) throw err;
        });
        return tabId;
      },
      userTabs: () => tab.userTabs(),
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
    // "Allow all until done" lasts one turn, and so does Not now on switching to a tab.
    s.gate?.release();
    s.switchRefused = null;
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
    s.ending = (opts.keepTabs ? s.tab.park(sessionId) : s.driver.closeOpenedTabs()).catch(() => 0).then(() => this.detachWhenIdle()).catch(() => 0);
  }

  /**
   * No turn runs in any slot: the debugger lets go of every tab, so Chrome's "Noa started debugging this browser"
   * bar goes away until the next turn attaches again. Chrome draws that bar while any tab is attached; an extension
   * cannot hide it (Noa Browser never shows it: noa-browser/host-debugger.ts).
   */
  private async detachWhenIdle(): Promise<void> {
    // Checked again before every tab: a turn that started meanwhile keeps what it attached.
    for (const tabId of this.cdp.attachedTabs) {
      if (this.busy()) return;
      await this.cdp.detach(tabId);
    }
  }

  /** A turn runs in some slot. */
  private busy(): boolean {
    return [...this.slots.values()].some((s) => s.sessionId !== null);
  }

  /**
   * Closes the tabs a chat's turns opened, except ones another run or chat
   * uses now. Not while a turn of it runs (its tabs are that turn's).
   */
  async endChat(sessionId: string): Promise<void> {
    if (this.slotUsedBy(sessionId)) return;
    await this.cleanedUp();
    const inUse = new Set(await this.allTabIds());
    await closeChatTabs(sessionId, async (tabId) => inUse.has(tabId) || !!(await this.isChatTab?.(tabId)), this.removeTabs);
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
   * its automation level, through its slot's gate ("Allow all until done" and the turn's clock are the slot's).
   * Without approvals nothing waits. A session without a slot (its turn ended) is refused. True: the user allowed it on
   * its card.
   */
  async confirm(sessionId: string, request: Omit<ApprovalRequest, "id" | "expiresAt">): Promise<boolean> {
    const slot = this.slotUsedBy(sessionId);
    if (!slot) throw new Error("This task session has no turn running right now (its turn has ended), so nothing was changed. Stop and wait for the user's next message.");
    return (await slot.gate?.confirm(sessionId, request)) ?? false;
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

  /** Whether a tab of a run is in limited mode now, and the other extension that blocks the debugger there (Driver.fallbackOf). */
  fallbackOf(tabId: number): { extensionId: string | null } | null {
    for (const s of this.slots.values()) {
      const f = s.driver.fallbackOf(tabId);
      if (f) return f;
    }
    return null;
  }

  /** A call in the tab ran in limited mode: the session's chat is told, once per tab. */
  private async tellLimited(slot: Slot, tabId: number): Promise<void> {
    const sessionId = slot.sessionId;
    const mode = slot.driver.fallbackOf(tabId);
    const key = `${sessionId} ${tabId}`;
    if (!sessionId || !mode || this.toldLimited.has(key)) return;
    this.toldLimited.add(key);
    const { short, url } = await tabLabel(slot, tabId);
    this.onPageEvent?.(sessionId, {
      type: "limited_mode",
      ...(short ? { tab: short } : {}),
      ...(url ? { url } : {}),
      ...(mode.extensionId ? { extensionId: mode.extensionId } : {}),
    });
  }

  /**
   * The driver needs the tab in front for a screenshot (Driver.screenshot: where Chrome cannot capture it hidden).
   * Never for a stopped run. Auto tab switching on, or the session under full autonomy (which never asks, whatever
   * the setting): brought forward at once, and the session's chat is told the first time. Off: the user is asked on
   * a card (ApprovalGate.askToSwitch; a run nobody watches is not asked), and after Not now or no answer this turn
   * does not ask again. Switching on the user's OK also brings its window in front: they asked to see it. Resolves
   * null once the tab is in front, else why not (SHOT_NOT_SWITCHED).
   *
   * Noa stays on the tab afterwards, never switching back: a run takes screenshots again and again, and each switch
   * back would make the next one switch again.
   */
  private async showForShot(slot: Slot, tabId: number, opts: { restore: boolean; auto?: boolean }): Promise<string | null> {
    const sessionId = slot.sessionId;
    const ctx = sessionId && this.approvals ? await this.approvals.context(sessionId) : null;
    if (ctx?.stopped?.()) return SHOT_NOT_SWITCHED.stopped;
    // Not while the user may be typing in that window: their keys would go on in the run's tab (measured with real
    // OS keystrokes: a sentence split between their field and the agent's). Then they are asked, as with it off.
    // Full autonomy: never asked, not even then (the user chose it for everything; the chat's notice tells them not
    // to type while it works).
    const full = ctx?.level === "full";
    if (full || ((opts.auto ?? (await this.autoTabSwitching?.())) && !(await userActiveInWindowOf(tabId)))) {
      // A tab that is gone: the capture says so.
      if (!(await bringTabForward(tabId, { restore: opts.restore, focus: false }))) return null;
      if (sessionId) void this.tellSwitching(slot, sessionId, tabId, full).catch(() => undefined);
      return null;
    }
    if (!sessionId || !slot.gate) return SHOT_NOT_SWITCHED.noChat;
    if (slot.switchRefused) return SHOT_NOT_SWITCHED[slot.switchRefused];
    const { short, url } = await tabLabel(slot, tabId);
    const outcome = await slot.gate.askToSwitch(sessionId, {
      action: `Switch to tab ${short ?? ""}`.trim(),
      site: hostOf(url),
      why: "Noa needs to see this tab to take a screenshot",
      switchTo: { tabId },
    });
    switch (outcome) {
      case "allow_once":
      case "allow_task":
        await bringTabForward(tabId, { restore: true, focus: true });
        return null;
      case "deny":
      case "timeout":
        slot.switchRefused = outcome === "deny" ? "declined" : "timeout";
        return SHOT_NOT_SWITCHED[slot.switchRefused];
      case "unattended":
        return SHOT_NOT_SWITCHED.unattended;
      case "interrupted":
        return SHOT_NOT_SWITCHED.interrupted;
      default:
        return SHOT_NOT_SWITCHED.stopped;
    }
  }

  /**
   * The slot's turn ended needing the user in a tab of its run (the runner, at a pause of the agent's own or on a login
   * page: lifecycle.ts finish): opts.tabId (the tab that reached the login page), else AgentTab.tabForUser. The tab
   * comes forward as for a screenshot (Auto tab switching on, or full autonomy; never for a stopped run, except by the
   * stop for that login page itself, which is what opts.tabId comes with), without taking the window's focus, and the
   * chat is told once why. A chat's pause is Noa's reply to the user, so it switches even while they are active in that
   * window; a scheduled run's does not then (their keys would go on in the run's tab), and the "Noa needs you" pill on
   * their tab opens the chat. A tab already in front moves nothing and says nothing (a minimized window is shown
   * again). Off: nothing moves, no card (the run is over: there is nothing to wait for). Resolves true when the tab is
   * in front.
   */
  private async showForUser(slot: Slot, opts: { chat: boolean; tabId?: number }): Promise<boolean> {
    const sessionId = slot.sessionId;
    const tabId = opts.tabId ?? (await slot.tab.tabForUser());
    if (tabId === null) return false;
    const ctx = sessionId && this.approvals ? await this.approvals.context(sessionId) : null;
    if (opts.tabId === undefined && ctx?.stopped?.()) return false;
    const full = ctx?.level === "full";
    if (!full && !(await this.autoTabSwitching?.())) return false;
    if (!full && !opts.chat && (await userActiveInWindowOf(tabId))) return false;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.active) {
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      if (win?.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => undefined);
      return true;
    }
    if (!(await bringTabForward(tabId, { restore: true, focus: false }))) return false;
    if (sessionId) await this.tellSwitching(slot, sessionId, tabId, full, "needs_you").catch(() => undefined);
    return true;
  }

  /** The slot's session runs under full autonomy (Settings > Permission): nothing of it waits for the user, a tab switch included. */
  private async fullAutonomy(slot: Slot): Promise<boolean> {
    const sessionId = slot.sessionId;
    if (!sessionId || !this.approvals) return false;
    return (await this.approvals.context(sessionId)).level === "full";
  }

  /**
   * Auto tab switching (or full autonomy: full) brought a tab of the session's run forward, for a screenshot (no why)
   * or for the user (why needs_you): its chat is told, once per conversation and reason.
   */
  private async tellSwitching(slot: Slot, sessionId: string, tabId: number, full: boolean, why?: "needs_you"): Promise<void> {
    const key = `${sessionId} ${why ?? "shot"}`;
    if (this.toldSwitching.has(key)) return;
    this.toldSwitching.add(key);
    const { short, url } = await tabLabel(slot, tabId);
    this.onPageEvent?.(sessionId, { type: "auto_tab_switching", ...(short ? { tab: short } : {}), ...(url ? { url } : {}), ...(full ? { full: true } : {}), ...(why ? { why } : {}) });
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

/** A tab of the slot's run as its chat names it: its short id (null when not known) and its address ("" when it is gone). */
async function tabLabel(slot: Slot, tabId: number): Promise<{ short: string | null; url: string }> {
  const [short, url] = await Promise.all([slot.tab.shortId(tabId), chrome.tabs.get(tabId).then(tabUrl, () => "")]);
  return { short, url };
}
