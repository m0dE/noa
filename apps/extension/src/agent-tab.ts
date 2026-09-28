import { MAX_AGENT_TABS } from "@noa/shared";
import { addToGroup, createWindowTab, lastNormalWindow, mustId, removeAgentTabs, removeTabs, tabExists } from "./chrome-tabs.js";
import { isControllableUrl } from "./restricted.js";

const TAB_KEY = "agentTabId";
/** The run's tabs (main + opened by open_tabs) and which one is current. */
const TABS_KEY = "agentTabs";
/** A chat's opened tabs between its turns: "agentChatTabs.<sessionId>" (see park). */
const CHAT_TABS_KEY = "agentChatTabs";

/**
 * current-tab: act on the tab the user is looking at (one-off runs).
 * own-tab: reuse the agent tab from earlier in this browser session, or open one (scheduled runs).
 */
export type TabMode = "current-tab" | "own-tab";

const AGENT_TAB_CLOSED = "the agent tab was closed";

/** One tab of the run: short id ("t1", "t2", ...), Chrome tab id, and whether the agent opened it. */
export interface RunTab {
  id: string;
  tabId: number;
  /** True for tabs opened by open_tabs (closed when the chat or unattended run ends) or by a page of the run (see fromPage). */
  opened: boolean;
  /** Opened by a page in one of the run's tabs (a link or button that opens a new tab): never closed by the agent's cleanup. */
  fromPage?: boolean;
}

interface TabsState {
  /** Chrome id of the current tab (the one single-tab browser methods act on). */
  current: number;
  /** The run's main tab (from prepare()) first, then the tabs the agent opened. */
  tabs: [main: RunTab, ...opened: RunTab[]];
  next: number;
  /** Tabs a page opened that the agent has not been told about yet (Chrome ids). */
  unreported?: number[];
  /** The chat (session id) whose turn these tabs are for: the opened ones are its own. */
  owner?: string;
}

/** A chat's opened tabs while no turn of it runs, and its next short id. */
interface ChatTabs {
  tabs: RunTab[];
  next: number;
}

/** A run with only its main tab, current. */
function freshState(tabId: number): TabsState {
  return { current: tabId, tabs: [{ id: "t1", tabId, opened: false }], next: 2 };
}

/** The run's tabs without the opened ones that match (the main tab always stays). */
function withoutOpened(state: TabsState, drop: (t: RunTab) => boolean): TabsState["tabs"] {
  const [main, ...opened] = state.tabs;
  return [main, ...opened.filter((t) => !drop(t))];
}

export interface AgentTabOptions {
  /**
   * True when another slot's run uses this tab right now: a one-off run then
   * gets a new tab instead of the one the user is looking at.
   */
  isTaken?(tabId: number): boolean | Promise<boolean>;
  /**
   * True when the tab belongs to a conversation (see TabChats): an own-tab
   * run (scheduled) then opens a tab of its own instead of reusing it.
   */
  isChatTab?(tabId: number): boolean | Promise<boolean>;
}

/**
 * The tabs the agent acts in, inside the user's own browser window: the run's
 * main tab (picked by prepare()) plus tabs it opened with open_tabs, one of
 * them current. The state lives in chrome.storage.session so a restarted
 * service worker finds it again. Every agent tab is put in a tab group titled
 * "noa".
 *
 * The opened tabs belong to the chat (owner) whose turns opened them: between
 * its turns they are kept for the chat (park), its next turn in any slot takes
 * them back (prepare), and they close when the chat is over (closeChatTabs).
 *
 * Runs that happen at the same time each use their own slot: slot 0 is the
 * first agent tab (its storage keys predate slots), slot n keeps its state
 * under "agentTabId.n" / "agentTabs.n".
 */
export class AgentTab {
  private readonly tabKey: string;
  private readonly tabsKey: string;

  constructor(
    readonly slot = 0,
    private readonly opts: AgentTabOptions = {},
  ) {
    this.tabKey = slot ? `${TAB_KEY}.${slot}` : TAB_KEY;
    this.tabsKey = slot ? `${TABS_KEY}.${slot}` : TABS_KEY;
  }

  /**
   * Picks the main tab for a run and makes it the current tab. The driver
   * keeps using the current tab until the next prepare() or switch, even if
   * the user switches tabs. current-tab with `tabId`: that tab (the one the
   * run was started from) instead of the one the user is looking at now; the
   * same rules apply.
   * owner: the chat the run is a turn of. The tabs its earlier turns opened
   * are its tabs again. Tabs a turn of another chat left here (it never
   * ended, e.g. the worker restarted) are kept for that chat; ones no chat
   * owns are closed.
   */
  async prepare(mode: TabMode, opts: { tabId?: number; owner?: string } = {}): Promise<number> {
    const tabId = mode === "current-tab" ? await this.pickCurrentTab(opts.tabId) : await this.pickOwnTab();
    const previous = await this.state();
    const left = previous?.tabs.slice(1) ?? [];
    let kept: RunTab[] = [];
    let next = 2;
    if (previous && previous.owner === opts.owner) [kept, next] = [left, previous.next];
    else if (previous?.owner) await parkTabs(previous.owner, left, previous.next);
    else await closeTabsOf(left);
    if (opts.owner) {
      const parked = await takeChatTabs(opts.owner);
      kept = [...kept, ...parked.tabs];
      next = Math.max(next, parked.next);
    }
    const state = freshState(tabId);
    state.tabs.push(...(await existing(kept, tabId)));
    state.next = renumber(state.tabs, next);
    if (opts.owner) state.owner = opts.owner;
    await chrome.storage.session.set({ [this.tabKey]: tabId, [this.tabsKey]: state });
    await addToGroup(tabId);
    return tabId;
  }

  /**
   * The chat's turn ended: its opened tabs stay open and are kept for it (its
   * next turn, in any slot, takes them back); the main tab stays here.
   * owner: only when these are that chat's tabs.
   */
  async park(owner: string): Promise<void> {
    const state = await this.state();
    if (!state || state.owner !== owner) return;
    const [main, ...opened] = state.tabs;
    if (!opened.length) return;
    await parkTabs(owner, opened, state.next);
    await this.save({ ...state, tabs: [main], current: main.tabId, unreported: [] });
  }

  /**
   * The current tab for the next browser call. Opens one (own-tab) when there
   * is none yet. If the main tab was closed, fails once with a readable error
   * and forgets it, so a later call can start afresh. If the current tab was
   * one the agent opened and it was closed, fails once and falls back to the
   * main tab.
   */
  async ensureTab(): Promise<number> {
    const state = await this.state();
    if (state === null) return this.prepare("own-tab");
    if (await tabExists(state.current)) return state.current;
    const [main] = state.tabs;
    const gone = state.tabs.find((t) => t.tabId === state.current);
    if (!gone || gone === main || !(await tabExists(main.tabId))) {
      await chrome.storage.session.remove([this.tabKey, this.tabsKey]);
      throw new Error(AGENT_TAB_CLOSED);
    }
    await this.save({ ...state, current: main.tabId, tabs: withoutOpened(state, (t) => t === gone) });
    throw new Error(`tab ${gone.id} was closed; the current tab is now ${main.id}`);
  }

  /** Chrome id of a run tab by short id ("t2"). Throws a readable error for unknown or closed tabs. */
  async resolve(id: string): Promise<number> {
    const state = await this.state();
    const key = normalizeId(id);
    const tab = state?.tabs.find((t) => t.id === key);
    if (!state || !tab) throw new Error(`unknown tab "${id}"; call list_tabs`);
    if (await tabExists(tab.tabId)) return tab.tabId;
    if (tab.opened) await this.save({ ...state, tabs: withoutOpened(state, (t) => t === tab) });
    throw new Error(`tab ${tab.id} was closed`);
  }

  /** The run's tabs that still exist, main first, with which one is current. */
  async list(): Promise<(RunTab & { current: boolean })[]> {
    const state = await this.state();
    if (!state) return [];
    const [main] = state.tabs;
    const alive: RunTab[] = [];
    for (const t of state.tabs) if (await tabExists(t.tabId)) alive.push(t);
    const opened = alive.filter((t) => t !== main);
    if (opened.length !== state.tabs.length - 1) await this.save({ ...state, tabs: [main, ...opened] });
    return alive.map((t) => ({ ...t, current: t.tabId === state.current }));
  }

  /** Chrome ids of every tab of the run (main and opened). */
  async tabIds(): Promise<number[]> {
    return (await this.state())?.tabs.map((t) => t.tabId) ?? [];
  }

  /** The short id of a Chrome tab of the run, or null. */
  async shortId(tabId: number): Promise<string | null> {
    return (await this.state())?.tabs.find((t) => t.tabId === tabId)?.id ?? null;
  }

  /**
   * Opens each URL in a new background tab of the main tab's window, right
   * after the run's tabs, in the Noa group. Returns them in order.
   * current: make the first one the current tab (it stays in the background).
   * Does not wait for loads.
   */
  async open(urls: string[], opts: { current?: boolean } = {}): Promise<RunTab[]> {
    await this.ensureTab();
    const alive = await this.list();
    if (alive.length + urls.length > MAX_AGENT_TABS) {
      throw new Error(`too many tabs: ${alive.length} open, at most ${MAX_AGENT_TABS} in total; close tabs you no longer need (close_tabs)`);
    }
    const state = await this.state();
    if (!state) throw new Error(AGENT_TAB_CLOSED);
    const main = await chrome.tabs.get(state.tabs[0].tabId);
    let index = main.index;
    for (const t of alive) {
      const tab = await chrome.tabs.get(t.tabId).catch(() => null);
      if (tab && tab.windowId === main.windowId) index = Math.max(index, tab.index);
    }
    const created: RunTab[] = [];
    try {
      for (const url of urls) {
        const tab = await chrome.tabs.create({ windowId: main.windowId, index: ++index, active: false, url });
        created.push({ id: `t${state.next++}`, tabId: mustId(tab), opened: true });
      }
    } finally {
      // Remember what was created even if a later create failed, so it is cleaned up.
      state.tabs.push(...created);
      if (opts.current && created[0]) state.current = created[0].tabId;
      await this.save(state);
    }
    await addToGroup(created.map((t) => t.tabId));
    return created;
  }

  /**
   * A tab a page opened (a link with target=_blank, window.open, a popup):
   * when its opener is one of the run's tabs, it becomes a run tab too (in
   * the Noa group; never activated by the agent), and takeNewTabs()
   * reports it once. Returns it, or null when the opener is not the run's.
   */
  async adopt(tabId: number, openerTabId: number): Promise<RunTab | null> {
    const state = await this.state();
    if (!state || !state.tabs.some((t) => t.tabId === openerTabId) || state.tabs.some((t) => t.tabId === tabId)) return null;
    if (state.tabs.length >= MAX_AGENT_TABS) return null;
    const tab: RunTab = { id: `t${state.next++}`, tabId, opened: true, fromPage: true };
    state.tabs.push(tab);
    state.unreported = [...(state.unreported ?? []), tabId];
    await this.save(state);
    await addToGroup(tabId);
    return tab;
  }

  /** The tabs pages opened since the last call, with their address and title (see adopt). */
  async takeNewTabs(): Promise<{ id: string; url: string; title: string }[]> {
    const state = await this.state();
    if (!state?.unreported?.length) return [];
    const ids = state.unreported;
    await this.save({ ...state, unreported: [] });
    const out: { id: string; url: string; title: string }[] = [];
    for (const tabId of ids) {
      const run = state.tabs.find((t) => t.tabId === tabId);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (run && tab) out.push({ id: run.id, url: tab.pendingUrl || tab.url || "", title: tab.title ?? "" });
    }
    return out;
  }

  /** Makes a run tab current. Returns its Chrome id. */
  async setCurrent(id: string): Promise<number> {
    const tabId = await this.resolve(id);
    const state = await this.state();
    if (!state) throw new Error(AGENT_TAB_CLOSED);
    await this.save({ ...state, current: tabId });
    return tabId;
  }

  /**
   * Closes tabs the agent opened. The main tab is never closed; an unknown id
   * or the main tab fails before anything is closed. If the current tab is
   * closed, the main tab becomes current. Returns the closed short ids.
   */
  async close(ids: string[]): Promise<string[]> {
    const state = await this.state();
    if (!state) throw new Error("there are no agent tabs");
    const targets: RunTab[] = [];
    for (const id of new Set(ids.map(normalizeId))) {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`unknown tab "${id}"; call list_tabs`);
      if (!tab.opened) throw new Error(`${tab.id} is the tab the task started on; it is never closed`);
      targets.push(tab);
    }
    await removeTabs(targets.map((t) => t.tabId));
    const tabs = withoutOpened(state, (t) => targets.includes(t));
    const current = tabs.some((t) => t.tabId === state.current) ? state.current : tabs[0].tabId;
    await this.save({ ...state, tabs, current });
    return targets.map((t) => t.id);
  }

  /**
   * The run is over (an unattended run's end): closes every tab the agent
   * opened with open_tabs in it and forgets the rest (tabs a page opened stay:
   * they may hold what the user wanted; so do tabs the user took over); the
   * main tab becomes current again. Returns how many were closed.
   */
  async closeOpened(): Promise<number> {
    const state = await this.state();
    if (!state) return 0;
    const [main, ...opened] = state.tabs;
    if (!opened.length) return 0;
    const closed = await closeTabsOf(opened);
    await this.save({ ...state, tabs: [main], current: main.tabId, unreported: [] });
    return closed;
  }

  /** Brings the current agent tab's window to the front and activates the tab. */
  async show(): Promise<boolean> {
    const tabId = await this.tabId();
    if (tabId === null) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      await chrome.windows.update(tab.windowId, win.state === "minimized" ? { focused: true, state: "normal" } : { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      return true;
    } catch {
      return false;
    }
  }

  /** The window the main agent tab is in, or null when there is no agent tab. */
  async windowId(): Promise<number | null> {
    const tabId = await this.storedTabId();
    if (tabId === null) return null;
    try {
      return (await chrome.tabs.get(tabId)).windowId;
    } catch {
      return null;
    }
  }

  /** The current agent tab (the one the driver acts on), or null. */
  async tabId(): Promise<number | null> {
    return (await this.state())?.current ?? null;
  }

  /** True for the run's main tab and every tab the agent opened. */
  async isAgentTab(tabId: number): Promise<boolean> {
    return (await this.tabIds()).includes(tabId);
  }

  /** The main tab (picked by prepare()). */
  private async storedTabId(): Promise<number | null> {
    const got = await chrome.storage.session.get(this.tabKey);
    const id = got[this.tabKey];
    return typeof id === "number" ? id : null;
  }

  /** The run's tab state; derived from the main tab when missing or stale (e.g. set by an older worker). */
  private async state(): Promise<TabsState | null> {
    const got = await chrome.storage.session.get([this.tabKey, this.tabsKey]);
    const main = got[this.tabKey];
    if (typeof main !== "number") return null;
    const s = got[this.tabsKey] as TabsState | undefined;
    if (!s || !Array.isArray(s.tabs) || s.tabs[0]?.tabId !== main || typeof s.current !== "number") {
      return freshState(main);
    }
    return s;
  }

  private async save(state: TabsState): Promise<void> {
    await chrome.storage.session.set({ [this.tabsKey]: state });
  }

  private async pickCurrentTab(origin?: number): Promise<number> {
    let tab: chrome.tabs.Tab | undefined = origin === undefined ? undefined : await chrome.tabs.get(origin).catch(() => undefined);
    if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
    if (!tab) {
      const win = await lastNormalWindow();
      if (!win) return createWindowTab();
      [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    }
    if (tab?.id === undefined) return createWindowTab();
    if (isControllableUrl(tab.url ?? tab.pendingUrl) && !(await this.opts.isTaken?.(tab.id))) return tab.id;
    // Shown in place of the tab the user is looking at (the side panel follows it there).
    const created = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: !!tab.active, url: "about:blank" });
    return mustId(created);
  }

  private async pickOwnTab(): Promise<number> {
    const stored = await this.storedTabId();
    if (stored !== null && (await tabExists(stored)) && !(await this.opts.isTaken?.(stored)) && !(await this.opts.isChatTab?.(stored))) return stored;
    const win = await lastNormalWindow();
    // The agent works in the background: the user keeps the tab they are using.
    if (!win?.id) return createWindowTab(false);
    const created = await chrome.tabs.create({ windowId: win.id, active: false, url: "about:blank" });
    return mustId(created);
  }
}

/**
 * The chat is over (New Chat): closes the tabs its agent opened and forgets
 * them. keep: tabs to leave open (another run or chat uses them now).
 * Returns how many were closed.
 */
export async function closeChatTabs(owner: string, keep: (tabId: number) => Promise<boolean>): Promise<number> {
  const { tabs } = await takeChatTabs(owner);
  const closing: RunTab[] = [];
  for (const t of tabs) if (!(await keep(t.tabId))) closing.push(t);
  return closeTabsOf(closing);
}

/** Closes the tabs the agent opened with open_tabs, except ones the user took over (removeAgentTabs). */
function closeTabsOf(tabs: RunTab[]): Promise<number> {
  return removeAgentTabs(tabs.filter((t) => t.opened && !t.fromPage).map((t) => t.tabId));
}

const chatTabsKey = (owner: string) => `${CHAT_TABS_KEY}.${owner}`;

/** Adds tabs to the ones kept for a chat between its turns. */
async function parkTabs(owner: string, tabs: RunTab[], next: number): Promise<void> {
  if (!tabs.length) return;
  const key = chatTabsKey(owner);
  const known = ((await chrome.storage.session.get(key))[key] as ChatTabs | undefined) ?? { tabs: [], next: 2 };
  const added = tabs.filter((t) => !known.tabs.some((k) => k.tabId === t.tabId));
  await chrome.storage.session.set({ [key]: { tabs: [...known.tabs, ...added], next: Math.max(next, known.next) } satisfies ChatTabs });
}

/** The tabs kept for a chat, taken out of the store (the caller holds them now). */
async function takeChatTabs(owner: string): Promise<ChatTabs> {
  const key = chatTabsKey(owner);
  const got = (await chrome.storage.session.get(key))[key] as ChatTabs | undefined;
  if (!got) return { tabs: [], next: 2 };
  await chrome.storage.session.remove(key);
  return got;
}

/** The tabs that still exist (one the user closed is forgotten), once each, without the main tab. */
async function existing(tabs: RunTab[], main: number): Promise<RunTab[]> {
  const out: RunTab[] = [];
  for (const t of tabs) {
    if (t.tabId !== main && !out.some((o) => o.tabId === t.tabId) && (await tabExists(t.tabId))) out.push(t);
  }
  return out;
}

/** Gives a tab whose short id is taken a new one (t1 is the main tab). Returns the next free number. */
function renumber(tabs: RunTab[], next: number): number {
  const seen = new Set<string>();
  for (const t of tabs) {
    if (seen.has(t.id)) t.id = `t${next++}`;
    seen.add(t.id);
  }
  return next;
}

/** "T2", " t2 " and "2" all mean t2. */
export function normalizeId(id: string): string {
  const s = id.trim().toLowerCase();
  return /^\d+$/.test(s) ? `t${s}` : s;
}
