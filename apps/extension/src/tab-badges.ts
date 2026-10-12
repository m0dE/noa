/**
 * The toolbar button's per-tab badge, which two things want: hands-free voice ("MIC" / "MUTE", voice-session.ts) and
 * the agent controlling the tab (control-indicator.ts). Voice wins: it says where the microphone is, the agent's
 * control also shows on the page and in the tab group. Chrome keeps one badge per tab, so every change goes through
 * here and the tab gets whichever applies, or none.
 */

/** How a badge looks. title: the button's tooltip (absent: the extension's default title). */
export interface BadgeLook {
  text: string;
  color: string;
  textColor: string;
  title?: string;
}

export interface TabBadgesDeps {
  /** Sets the tab's badge and tooltip (null: clears them). */
  paint(tabId: number, look: BadgeLook | null): void;
  /** The voice badge the tab has now (VoiceSessions), for changes that come from the agent's side. */
  voiceOf(tabId: number): BadgeLook | null;
}

export class TabBadges {
  /** Tabs the agent controls, and how their badge looks. */
  private readonly control = new Map<number, BadgeLook>();

  constructor(private readonly deps: TabBadgesDeps) {}

  /** Voice set (or cleared, null) the tab's badge: shown, else the agent's. */
  voice(tabId: number, look: BadgeLook | null): void {
    this.deps.paint(tabId, look ?? this.control.get(tabId) ?? null);
  }

  /** The agent controls the tab (look) or no longer does (null): shown unless voice has the tab. */
  controlled(tabId: number, look: BadgeLook | null): void {
    if (look) this.control.set(tabId, look);
    else if (!this.control.delete(tabId)) return;
    this.deps.paint(tabId, this.deps.voiceOf(tabId) ?? look);
  }

  /** The tab started loading a page: the agent's badge is set again (voice sets its own again, voice-session.ts). */
  tabLoading(tabId: number): void {
    const look = this.control.get(tabId);
    if (look && !this.deps.voiceOf(tabId)) this.deps.paint(tabId, look);
  }

  /** The tab closed. */
  tabRemoved(tabId: number): void {
    this.control.delete(tabId);
  }
}
