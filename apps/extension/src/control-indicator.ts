/**
 * Shows which tabs the agent controls, three ways, kept in step with the runs:
 *
 * - The Noa tab group's title and colour: "Noa · working" (or "· 2 working") in purple while a run
 *   acts in it, "Noa · needs you" in yellow while one waits for the user, plain "Noa" in grey when
 *   idle. Always on. A title or colour the user changed stays theirs (chrome-tabs.ts applyGroupLook).
 * - The toolbar button's badge on each controlled tab ("RUN", or "!" when it needs the user); a voice badge wins
 *   (tab-badges.ts).
 * - The overlay on the page (page-indicator.ts): the glow with "Noa is working · Stop", or "Noa needs
 *   you · Open". The setting "Show when Noa controls a tab" turns it off.
 *
 * A tab is controlled while a running session acts in it (its slot's tabs); it needs the user while that session
 * waits for an approval, and after a run ended paused for the user (not stopped by them) until its next turn starts,
 * the user opens it from the pill, or the tab closes. What was shown is kept in chrome.storage.session, so a
 * restarted service worker takes it down or keeps it up.
 *
 * Changes come in bursts (a run starts, its tabs load, an approval appears): refresh() gathers them and applies the
 * result once, one refresh at a time.
 */
import { errorMessage, USER_STOP_REASON, type AgentEvent } from "@noa/shared";
import { TAB_GROUP_STATUS_SEPARATOR, TAB_GROUP_TITLE, IDLE_GROUP_LOOK, type GroupLook } from "./chrome-tabs.js";
import type { IndicatorVariant } from "./page-indicator.js";
import type { BadgeLook } from "./tab-badges.js";

export type ControlState = IndicatorVariant;

/** A running session and the tabs it acts in. */
export interface ControlledSession {
  sessionId: string;
  tabs: number[];
  /** It waits for the user (an approval). */
  needsYou: boolean;
}

/** The toolbar badge of a controlled tab. */
export const CONTROL_BADGES: Readonly<Record<ControlState, BadgeLook>> = {
  working: { text: "RUN", color: "#4f46e5", textColor: "#ffffff", title: "Noa is working in this tab" },
  "needs-you": { text: "!", color: "#f9ab00", textColor: "#202124", title: "Noa needs you in this tab" },
};

/** The group's look for the states of the sessions with tabs in it (one entry per session). */
export function groupLook(states: readonly ControlState[]): GroupLook {
  if (states.includes("needs-you")) return { title: `${TAB_GROUP_TITLE}${TAB_GROUP_STATUS_SEPARATOR}needs you`, color: "yellow" };
  const working = states.length;
  if (!working) return IDLE_GROUP_LOOK;
  return { title: `${TAB_GROUP_TITLE}${TAB_GROUP_STATUS_SEPARATOR}${working === 1 ? "" : `${working} `}working`, color: "purple" };
}

/** Each controlled tab's state and the session it belongs to; a session that needs the user wins a shared tab. */
export function tabStates(sessions: readonly (ControlledSession & { state?: ControlState })[]): Map<number, { state: ControlState; sessionId: string }> {
  const out = new Map<number, { state: ControlState; sessionId: string }>();
  for (const s of sessions) {
    const state: ControlState = s.state ?? (s.needsYou ? "needs-you" : "working");
    for (const tabId of s.tabs) {
      if (out.get(tabId)?.state === "needs-you") continue;
      out.set(tabId, { state, sessionId: s.sessionId });
    }
  }
  return out;
}

export interface ControlIndicatorDeps {
  /** The sessions running now, with their tabs and whether they wait for the user. */
  running(): Promise<ControlledSession[]>;
  /** The tabs a session acts in now (its slot's; at a turn's end they are still there). */
  tabsOf(sessionId: string): Promise<number[]>;
  /** The tab whose side panel has the session's chat (null: none, e.g. a scheduled run). */
  chatTabOf(sessionId: string): Promise<number | null>;
  /** The setting "Show when Noa controls a tab" (the page overlay). */
  showOverlay(): Promise<boolean>;
  groups: {
    /** The agent group the tab is in, or null. */
    of(tabId: number): Promise<number | null>;
    /** Every agent group that exists. */
    all(): Promise<number[]>;
    apply(groupId: number, look: GroupLook): Promise<void>;
  };
  badges: { controlled(tabId: number, look: BadgeLook | null): void };
  pages: { show(tabId: number, variant: IndicatorVariant): Promise<void>; remove(tabId: number): Promise<void> };
  storage?: { load(): Promise<unknown>; save(value: unknown): Promise<void> };
  /** How long refresh() gathers changes before applying them. */
  delayMs?: number;
  log?(message: string): void;
}

/** What is kept in chrome.storage.session. */
interface Stored {
  /** Sessions whose run ended paused for the user -> the tabs it acted in. */
  paused: Record<string, number[]>;
  /** Tabs shown as controlled -> how, and whether the page overlay is up. */
  shown: Record<string, { state: ControlState; sessionId: string; overlay: boolean }>;
}

const DEFAULT_DELAY_MS = 120;

export class ControlIndicator {
  private paused = new Map<string, number[]>();
  private shown = new Map<number, Stored["shown"][string]>();
  /** Each running session's tabs at the last refresh (a run that ends paused needs you there). */
  private readonly lastTabs = new Map<string, number[]>();
  /** Each session's chat tab at the last refresh (Open must answer at once: the click's user gesture). */
  private readonly chatTabs = new Map<string, number | null>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private applying: Promise<void> | null = null;
  private again = false;
  readonly ready: Promise<void>;

  constructor(private readonly deps: ControlIndicatorDeps) {
    this.ready = this.load().catch((err: unknown) => this.log(`reading what was shown failed: ${errorMessage(err)}`));
  }

  /** Something may have changed: applied after a moment, with whatever else changed meanwhile. */
  refresh(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.applyNow();
    }, this.deps.delayMs ?? DEFAULT_DELAY_MS);
  }

  /** Applies the current state now (after any refresh in progress); resolves once applied. */
  async applyNow(): Promise<void> {
    if (this.applying) {
      this.again = true;
      return this.applying;
    }
    this.applying = (async () => {
      await this.ready;
      do {
        this.again = false;
        await this.apply().catch((err: unknown) => this.log(`showing the agent's tabs failed: ${errorMessage(err)}`));
      } while (this.again);
    })().finally(() => (this.applying = null));
    return this.applying;
  }

  /** A conversation event: a turn that ended paused for the user needs the user in its tabs. */
  onEvent(sessionId: string, event: AgentEvent): void {
    if (event.type === "approval_request" || event.type === "approval_resolved") return this.refresh();
    // The user answered: the next turn starts.
    if (event.type === "user_message") {
      if (this.paused.delete(sessionId)) this.refresh();
      return;
    }
    if (event.type !== "task_end") return;
    const known = this.lastTabs.get(sessionId);
    this.lastTabs.delete(sessionId);
    if (event.outcome !== "paused" || event.reason?.trim() === USER_STOP_REASON) {
      this.paused.delete(sessionId);
      return this.refresh();
    }
    // A short turn may have ended before any refresh saw its tabs: they are read now, while its slot still has them.
    const tabs = known?.length ? Promise.resolve(known) : this.deps.tabsOf(sessionId).catch(() => []);
    void tabs.then((t) => {
      if (t.length) this.paused.set(sessionId, t);
      this.refresh();
    });
  }

  /** The session controlling the tab (the pill's Stop), or null. */
  sessionOf(tabId: number): string | null {
    return this.shown.get(tabId)?.sessionId ?? null;
  }

  /**
   * The pill's Open in a tab: the tab whose side panel has that session's chat (else this tab). A run that ended
   * paused has been seen: its tabs stop saying so. Answers at once (the caller opens the panel within the click).
   */
  open(tabId: number): number {
    const sessionId = this.sessionOf(tabId);
    if (sessionId && this.paused.delete(sessionId)) this.refresh();
    return (sessionId ? this.chatTabs.get(sessionId) : null) ?? tabId;
  }

  /** A tab of the page loaded: its overlay is put back (a new page has none); a closed one is forgotten. */
  tabLoaded(tabId: number): void {
    const s = this.shown.get(tabId);
    if (s?.overlay) void this.deps.pages.show(tabId, s.state);
  }

  tabRemoved(tabId: number): void {
    if (!this.shown.delete(tabId)) return;
    for (const [sessionId, tabs] of this.paused) {
      const left = tabs.filter((t) => t !== tabId);
      if (left.length) this.paused.set(sessionId, left);
      else this.paused.delete(sessionId);
    }
    this.save();
    this.refresh();
  }

  private async apply(): Promise<void> {
    const running = await this.deps.running();
    for (const s of running) this.lastTabs.set(s.sessionId, s.tabs);
    // A turn that ended paused may still be finishing: it needs the user already. Its next turn starts with the user's message (onEvent).
    const all = [...running.filter((s) => !this.paused.has(s.sessionId)), ...[...this.paused].map(([sessionId, tabs]): ControlledSession & { state: ControlState } => ({ sessionId, tabs, needsYou: true, state: "needs-you" }))];
    for (const s of all) this.chatTabs.set(s.sessionId, await this.deps.chatTabOf(s.sessionId).catch(() => null));
    for (const id of [...this.chatTabs.keys()]) if (!all.some((s) => s.sessionId === id)) this.chatTabs.delete(id);
    const want = tabStates(all);
    const overlay = await this.deps.showOverlay();

    for (const [tabId, was] of this.shown) {
      if (want.has(tabId)) continue;
      this.deps.badges.controlled(tabId, null);
      if (was.overlay) await this.deps.pages.remove(tabId);
      this.shown.delete(tabId);
    }
    for (const [tabId, now] of want) {
      const was = this.shown.get(tabId);
      if (was?.state !== now.state) this.deps.badges.controlled(tabId, CONTROL_BADGES[now.state]);
      if (overlay && (was?.state !== now.state || !was.overlay)) await this.deps.pages.show(tabId, now.state);
      if (!overlay && was?.overlay) await this.deps.pages.remove(tabId);
      this.shown.set(tabId, { ...now, overlay });
    }

    // One entry per session with a tab in the group.
    const inGroup = new Map<number, Map<string, ControlState>>();
    for (const [tabId, { state, sessionId }] of want) {
      const groupId = await this.deps.groups.of(tabId);
      if (groupId === null) continue;
      const states = inGroup.get(groupId) ?? new Map<string, ControlState>();
      if (states.get(sessionId) !== "needs-you") states.set(sessionId, state);
      inGroup.set(groupId, states);
    }
    const groups = new Set([...(await this.deps.groups.all()), ...inGroup.keys()]);
    for (const groupId of groups) await this.deps.groups.apply(groupId, groupLook([...(inGroup.get(groupId)?.values() ?? [])]));
    this.save();
  }

  private async load(): Promise<void> {
    const got = (await this.deps.storage?.load()) as Partial<Stored> | undefined;
    for (const [sessionId, tabs] of Object.entries(got?.paused ?? {})) {
      if (Array.isArray(tabs)) this.paused.set(sessionId, tabs.filter((t) => typeof t === "number"));
    }
    for (const [tab, s] of Object.entries(got?.shown ?? {})) {
      if (s && (s.state === "working" || s.state === "needs-you") && typeof s.sessionId === "string") this.shown.set(Number(tab), { state: s.state, sessionId: s.sessionId, overlay: !!s.overlay });
    }
    // What an earlier worker showed is this one's: the badges it tracks, the overlays the drivers hide from the agent.
    for (const [tabId, s] of this.shown) {
      this.deps.badges.controlled(tabId, CONTROL_BADGES[s.state]);
      if (s.overlay) await this.deps.pages.show(tabId, s.state);
    }
  }

  private save(): void {
    const stored: Stored = { paused: Object.fromEntries(this.paused), shown: Object.fromEntries(this.shown) };
    this.deps.storage?.save(stored).catch((err: unknown) => this.log(`keeping what was shown failed: ${errorMessage(err)}`));
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
