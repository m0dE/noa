/**
 * The hands-free voice session as the background knows it: the one source of
 * truth for which tab it belongs to, which side panel runs it, its engine,
 * and which tab the user is looking at (the active tab of the last focused
 * normal window). Every side panel gets it (VoiceSessionView, pushed on the
 * UI port when it changes and when a panel connects): the other windows'
 * panels say where voice is on instead of looking live (the panel running
 * it follows its own window's active tab).
 *
 * PanelCommands says which panel runs a session (their panel.listening
 * reports); Chrome's tab and window events say what the user looks at. It
 * is kept in chrome.storage.session, so a restarted service worker knows it
 * before the panel says so again (a session whose panel is gone meanwhile
 * is dropped).
 *
 * The toolbar badge: "MIC" in the live colour on the session's tab, and a
 * grey "MIC" on the tab the user is looking at when that is another one
 * (its tooltip says voice is on in another tab); muted, both say "MUTE" in
 * grey instead (the microphone is off, the session goes on). An open side
 * panel's voice strip says the same with the tab's name; the grey badge is
 * for a window whose panel is closed, or another window: a click opens the
 * panel there, whose strip offers Go to tab and Use voice here. Badges are
 * per tab; Chrome clears a tab's badge when the tab loads a page, so it is
 * set again then (tabLoading).
 */
import { errorMessage, type VoiceEngineId } from "@noa/shared";

/** A session as the panel running it reports it. */
export interface VoiceSessionInfo {
  /** The tab it belongs to: what is said goes to that tab's chat. */
  tabId: number;
  /** The window of the panel running it (null: not known yet). */
  windowId: number | null;
  /** The id of the panel page running it (null: not known), so that page knows the session is its own. */
  panel: string | null;
  /** The engine it runs on (null: still choosing). */
  engine: VoiceEngineId | null;
  /** The user muted the microphone (absent: not muted). */
  muted?: true;
}

/** What every side panel is told. */
export interface VoiceSessionView extends VoiceSessionInfo {
  /** The tab the user is looking at (null: not known). */
  viewing: number | null;
}

/** How a tab's toolbar button shows the session: its own tab, or the tab the user looks at instead; each live or muted. */
export type VoiceBadge = "live" | "muted" | "elsewhere" | "elsewhere-muted";

const GREY = "#80868b";

/**
 * The toolbar badges: the session's tab in the voice bar's live colour; the tab looked at instead in grey, with a
 * tooltip; muted, "MUTE" in grey on either.
 */
export const VOICE_BADGES: Readonly<Record<VoiceBadge, { text: string; color: string; textColor: string; title?: string }>> = {
  live: { text: "MIC", color: "#c8233f", textColor: "#ffffff" },
  muted: { text: "MUTE", color: GREY, textColor: "#ffffff", title: "Voice is on, microphone muted" },
  elsewhere: { text: "MIC", color: GREY, textColor: "#ffffff", title: "Voice is on in another tab: click to see where" },
  "elsewhere-muted": { text: "MUTE", color: GREY, textColor: "#ffffff", title: "Voice is on in another tab, microphone muted: click to see where" },
};

const isBadge = (look: unknown): look is VoiceBadge => typeof look === "string" && Object.hasOwn(VOICE_BADGES, look);

const KEY = "voiceSession";

/** What is kept in chrome.storage.session. */
interface Stored {
  session: VoiceSessionInfo | null;
  badges: [number, VoiceBadge][];
}

export interface VoiceSessionDeps {
  /** Tells every side panel (null: no session). */
  broadcast(view: VoiceSessionView | null): void;
  /** Sets a tab's badge (null: clears it). */
  badge(tabId: number, look: VoiceBadge | null): void;
  /** chrome.storage.session, for worker restarts (absent: nothing is kept). */
  storage?: { load(): Promise<unknown>; save(value: unknown): Promise<void> };
  /** A kept session's panel is still open (after a worker restart). */
  alive?(session: VoiceSessionInfo): Promise<boolean>;
  log?(message: string): void;
}

export class VoiceSessions {
  private session: VoiceSessionInfo | null = null;
  /** window -> its active tab. */
  private readonly activeTabs = new Map<number, number>();
  private focusedWindow: number | null = null;
  /** Tabs whose badge this set, and how. */
  private readonly badges = new Map<number, VoiceBadge>();
  /** What the panels were told last (JSON). */
  private told = "null";
  /** A panel reported before the kept session was read: that report wins. */
  private reported = false;
  /** Written only once the kept session was read (an earlier write would lose it). */
  private loaded = false;
  readonly ready: Promise<void>;

  constructor(private readonly deps: VoiceSessionDeps) {
    this.ready = this.load().catch((err: unknown) => {
      this.loaded = true;
      this.log(`reading the voice session failed: ${errorMessage(err)}`);
    });
  }

  view(): VoiceSessionView | null {
    const s = this.session;
    if (!s) return null;
    const window = this.focusedWindow ?? s.windowId;
    return { ...s, viewing: window === null ? null : (this.activeTabs.get(window) ?? null) };
  }

  /** The session the panels report (PanelCommands), or none. */
  set(session: VoiceSessionInfo | null): void {
    this.reported = true;
    this.session = session;
    this.update();
  }

  /** chrome.tabs.onActivated (and the active tabs read at start). */
  tabActivated(tabId: number, windowId: number): void {
    this.activeTabs.set(windowId, tabId);
    this.update();
  }

  /** What Chrome says at start: the active tab of each window and the focused one (not over what events said meanwhile). */
  seed(active: readonly { tabId: number; windowId: number }[], focusedWindow: number | null): void {
    for (const { tabId, windowId } of active) if (!this.activeTabs.has(windowId)) this.activeTabs.set(windowId, tabId);
    if (this.focusedWindow === null && focusedWindow !== null && focusedWindow >= 0) this.focusedWindow = focusedWindow;
    this.update();
  }

  /** chrome.windows.onFocusChanged for normal windows (the focus leaving Chrome is ignored: the user looks where they did). */
  windowFocused(windowId: number): void {
    if (windowId < 0) return;
    this.focusedWindow = windowId;
    this.update();
  }

  /** The voice badge a tab has now, or null. */
  badgeOf(tabId: number): VoiceBadge | null {
    return this.badges.get(tabId) ?? null;
  }

  /** A tab started loading a page: Chrome cleared its badge, so it is set again. */
  tabLoading(tabId: number): void {
    const look = this.badges.get(tabId);
    if (look) this.deps.badge(tabId, look);
  }

  /** A tab closed: it has no badge, and is no window's active tab (its panel's report ends a session there). */
  tabRemoved(tabId: number): void {
    this.badges.delete(tabId);
    for (const [w, t] of this.activeTabs) if (t === tabId) this.activeTabs.delete(w);
    this.update();
  }

  /** chrome.windows.onRemoved. */
  windowRemoved(windowId: number): void {
    this.activeTabs.delete(windowId);
    if (this.focusedWindow === windowId) this.focusedWindow = null;
    this.update();
  }

  /** The badges as the session and the tab looked at want them; tells the panels about any change, and keeps it. */
  private update(): void {
    const view = this.view();
    const want = new Map<number, VoiceBadge>();
    if (view) {
      want.set(view.tabId, view.muted ? "muted" : "live");
      if (view.viewing !== null && view.viewing !== view.tabId) want.set(view.viewing, view.muted ? "elsewhere-muted" : "elsewhere");
    }
    let badgesChanged = false;
    for (const [tab, look] of this.badges) {
      if (want.get(tab) === look) continue;
      if (!want.has(tab)) this.deps.badge(tab, null);
      this.badges.delete(tab);
      badgesChanged = true;
    }
    for (const [tab, look] of want) {
      if (this.badges.get(tab) === look) continue;
      this.badges.set(tab, look);
      this.deps.badge(tab, look);
      badgesChanged = true;
    }
    const told = JSON.stringify(view);
    const viewChanged = told !== this.told;
    if (viewChanged) {
      this.told = told;
      this.deps.broadcast(view);
    }
    if (viewChanged || badgesChanged) this.save();
  }

  private async load(): Promise<void> {
    const got = (await this.deps.storage?.load()) as Partial<Stored> | undefined;
    for (const [tab, look] of Array.isArray(got?.badges) ? got.badges : []) {
      if (typeof tab === "number" && isBadge(look) && !this.badges.has(tab)) this.badges.set(tab, look);
    }
    const kept = got?.session;
    if (!this.reported && kept && typeof kept.tabId === "number" && (await (this.deps.alive?.(kept) ?? Promise.resolve(true))) && !this.reported) {
      this.session = { tabId: kept.tabId, windowId: kept.windowId ?? null, panel: typeof kept.panel === "string" ? kept.panel : null, engine: kept.engine ?? null, ...(kept.muted === true ? { muted: true } : {}) };
    }
    this.loaded = true;
    this.update();
    this.save();
  }

  private save(): void {
    if (!this.loaded) return;
    const stored: Stored = { session: this.session, badges: [...this.badges] };
    this.deps.storage?.save(stored).catch((err: unknown) => this.log(`keeping the voice session failed: ${errorMessage(err)}`));
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
