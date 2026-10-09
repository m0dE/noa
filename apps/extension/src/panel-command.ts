/**
 * The side panel of each window and the keyboard shortcuts (the manifest's
 * "commands", see shortcut.ts). The panel is the manifest's default one: a
 * window's panel, once opened, stays on screen across tab switches, and what
 * it shows follows the active tab (sidepanel/sidepanel.ts).
 *
 * OPEN_CHAT_COMMAND opens the window's side panel and puts the cursor in the
 * chat input; when the panel is already open, it focuses the input.
 * VOICE_COMMAND does the same and then starts a hands-free session there
 * (sidepanel/hands-free.ts), as the mic button does; pressed while a panel of
 * the window is listening, it reaches that panel, which ends the session. The
 * panel decides: without a plan that includes voice it points at the locked
 * mic button and says why.
 *
 * Chrome counts a command as a user gesture, which sidePanel.open() needs,
 * but only while the listener runs: open() is called before anything is
 * awaited. The panels report their window, whether they are the side panel
 * or the panel page opened as a tab, and where the keyboard focus is over the
 * UI port (PanelMessage), so the decision needs no await either. A panel the
 * shortcut opened is told to focus when it says hello (its ready handshake),
 * not after some delay.
 *
 * Chrome moves the keyboard focus into a side panel only when it creates the
 * panel's page: open() on an open panel, close() then open(), or a tab's own
 * options leave the focus in the web page (or turn the panel into a per-tab
 * one). Disabling the default panel and enabling it again closes every
 * window's panel at once, without the close animation; so when the focus is
 * outside the panel, the shortcut does that and opens every window's panel
 * again, all within the gesture. Each new page is told to focus (the window
 * the key was pressed in) or not, and gets back the text its box had and the
 * job it showed (the chat itself comes from the background). A listening
 * panel is never recreated, in any window: the session would end. The
 * shortcut then only moves the panel's focus to its input.
 *
 * Which panel runs the hands-free session (its tab, window, panel and engine)
 * goes to the voice dep (voice-session.ts), which tells every panel and sets
 * the toolbar badges; it ends when the panel stops listening or closes. Stop
 * and Use voice here in another panel reach the panel running it
 * (panel.voiceStop -> voice.stop): one session, one microphone.
 *
 * Extension shortcuts work while a Chrome window has the focus. They are
 * not system-wide: Chrome allows "global" only for Ctrl+Shift+[0-9], and a
 * side panel cannot open without a focused Chrome window anyway.
 */

import { VoiceEngineId } from "@noa/shared";
import { OPEN_CHAT_COMMAND, VOICE_COMMAND } from "./shortcut.js";
import type { VoiceSessionInfo } from "./voice-session.js";

/** Panel -> background on the UI port. */
export type PanelMessage =
  /** panel: the page's own id (hands-free sessions name the panel running them); asTab: the panel page opened as a tab, not the side panel. */
  | { type: "panel.hello"; windowId: number; panel: string; asTab?: true }
  /** Hands-free voice started or stopped listening in the panel; tabId: the tab its session belongs to; engine: the one it runs on; muted: its microphone is muted. */
  | { type: "panel.listening"; listening: boolean; tabId?: number; engine?: VoiceEngineId; muted?: boolean }
  /** End the hands-free session, whichever panel runs it (Stop, or Use voice here, in another panel). */
  | { type: "panel.voiceStop" }
  /**
   * The panel's page got or lost the keyboard focus, or showed another view; `draft`: the text in its box then, `job`:
   * the job its page shows (absent: the jobs list). A recreated panel gets both back.
   */
  | { type: "panel.document"; focused: boolean; draft: string; job?: string };

/** A UI port as this uses it (chrome.runtime.Port). */
export interface PanelPort {
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface PanelCommandDeps {
  /** chrome.sidePanel.open({ windowId }). Called synchronously in the command listener. */
  open(windowId: number): Promise<void>;
  /**
   * Closes every window's side panel at once, without the close animation, so that the next open() creates the
   * panel's page anew. Called synchronously in the command listener, right before the open() calls.
   */
  closeAllInstantly(): Promise<void>;
  /** The hands-free session changed: the one the panels run now (null: none). */
  voice?(session: VoiceSessionInfo | null): void;
  log?(message: string): void;
}

export type CommandOutcome = "opened" | "reopened" | "focused" | "voice" | "ignored";

interface PanelInfo {
  windowId: number | null;
  /** The page's own id (null: it has not said hello). */
  id: string | null;
  /** The panel page opened as a tab (it is no side panel: reopening the side panels leaves it alone). */
  asTab: boolean;
  /** Voice input is listening (or starting to). */
  listening: boolean;
  /** The tab its session belongs to. */
  voiceTab: number | null;
  /** The engine its session runs on (null: not chosen yet). */
  engine: VoiceEngineId | null;
  /** Its session's microphone is muted. */
  muted: boolean;
  /** When it started listening (the latest one is the session, should two ever report at once). */
  since: number;
  /** The panel's page has the keyboard focus. */
  focused: boolean;
  /** The text in the box when the page last got or lost the focus. */
  draft: string;
  /** The job the page shows (null: the list). */
  job: string | null;
}

/** What a recreated panel gets back: the text in its box, and the job it showed. */
interface Restore {
  draft: string;
  job: string | null;
}

type Tab = { windowId?: number } | null | undefined;

const NOTHING: Restore = { draft: "", job: null };

export class PanelCommands {
  private readonly panels = new Map<PanelPort, PanelInfo>();
  /**
   * Windows whose side panel a shortcut is opening -> the text to put back in its box, the job it showed, and what
   * its new page is told when it says hello: to take the focus (the window the key was pressed in), and to listen.
   */
  private readonly opening = new Map<number, Restore & { focus: boolean; voice: boolean }>();
  /** The session last reported to the voice dep (JSON). */
  private reported = "null";
  private reports = 0;

  constructor(private readonly deps: PanelCommandDeps) {}

  /** A side panel's UI port (after UiHub.attach accepted it). */
  attach(port: PanelPort): void {
    const info: PanelInfo = { windowId: null, id: null, asTab: false, listening: false, voiceTab: null, engine: null, muted: false, since: 0, focused: false, draft: "", job: null };
    this.panels.set(port, info);
    port.onDisconnect.addListener(() => {
      this.panels.delete(port);
      this.setVoiceTab(info, null);
    });
    port.onMessage.addListener((raw) => {
      const msg = raw as Partial<PanelMessage> | null;
      if (msg?.type === "panel.hello" && typeof msg.windowId === "number") {
        info.windowId = msg.windowId;
        info.id = typeof msg.panel === "string" && msg.panel ? msg.panel : null;
        info.asTab = msg.asTab === true;
        this.reportVoice();
        const pending = info.asTab ? undefined : this.opening.get(msg.windowId);
        if (!pending) return;
        this.opening.delete(msg.windowId);
        this.restore(port, pending, pending.focus, pending.voice);
      } else if (msg?.type === "panel.listening" && typeof msg.listening === "boolean") {
        if (msg.listening && !info.listening) info.since = ++this.reports;
        info.listening = msg.listening;
        info.engine = msg.listening && VoiceEngineId.safeParse(msg.engine).success ? (msg.engine as VoiceEngineId) : null;
        info.muted = msg.listening && msg.muted === true;
        this.setVoiceTab(info, msg.listening && typeof msg.tabId === "number" ? msg.tabId : null);
      } else if (msg?.type === "panel.voiceStop") {
        this.stopVoice();
      } else if (msg?.type === "panel.document" && typeof msg.focused === "boolean") {
        info.focused = msg.focused;
        info.draft = typeof msg.draft === "string" ? msg.draft : "";
        info.job = typeof msg.job === "string" && msg.job ? msg.job : null;
      }
    });
  }

  /** The window has an open panel page (it said hello): its side panel, or the panel page opened as a tab. */
  isOpen(windowId: number): boolean {
    return this.panelsOfWindow(windowId).length > 0;
  }

  /** A panel of the window is listening (the voice shortcut then goes to it, and hands-free ends). */
  listening(windowId: number): boolean {
    return this.panelsOfWindow(windowId).some(([, p]) => p.listening);
  }

  /**
   * chrome.commands.onCommand, with the tab the key was pressed in. Synchronous until sidePanel.open() was
   * called, so Chrome still counts the key press as the user gesture.
   */
  onCommand(command: string, tab?: Tab): CommandOutcome {
    const voice = command === VOICE_COMMAND;
    if (!voice && command !== OPEN_CHAT_COMMAND) return "ignored";
    const windowId = tab?.windowId;
    if (windowId === undefined || windowId < 0) return "ignored";
    const inWindow = this.panelsOfWindow(windowId);
    const listening = inWindow.filter(([, p]) => p.listening);
    if (voice && listening.length) {
      for (const [port] of listening) this.post(port, { type: "panel.voice" });
      return "voice";
    }
    // The focus is in a panel page of the window already: it moves it to the input.
    const focused = inWindow.filter(([, p]) => p.focused);
    if (focused.length) {
      for (const [port] of focused) this.restore(port, NOTHING, true, voice);
      return voice ? "voice" : "focused";
    }
    const side = inWindow.filter(([, p]) => !p.asTab);
    // No side panel in the window, or none said hello since the worker restarted (open() leaves an open one as it is).
    if (!side.length) {
      this.openFocused(windowId, { ...NOTHING, focus: true, voice });
      return "opened";
    }
    // Recreating closes every window's panel: a listening one would end its session. The input gets the cursor as far
    // as Chrome lets a page move it.
    if ([...this.panels.values()].some((p) => p.listening)) {
      for (const [port] of side) this.restore(port, NOTHING, true, voice);
      return voice ? "voice" : "focused";
    }
    // The focus is in the web page: only a newly created panel page gets it (see the top of this file). Every
    // window's side panel is recreated, each with the text in its box and the job it showed.
    const others = this.restoresByWindow();
    this.deps.closeAllInstantly().catch((err: unknown) => this.log(`closing the side panels failed: ${String(err)}`));
    this.openFocused(windowId, { ...(others.get(windowId) ?? NOTHING), focus: true, voice });
    for (const [other, restore] of others) if (other !== windowId) this.openFocused(other, { ...restore, focus: false, voice: false });
    return "reopened";
  }

  /** The hands-free session the panels run now: the panel that started listening last (null: none). */
  voiceSession(): VoiceSessionInfo | null {
    let latest: PanelInfo | null = null;
    for (const p of this.panels.values()) if (p.voiceTab !== null && (!latest || p.since > latest.since)) latest = p;
    if (!latest || latest.voiceTab === null) return null;
    return { tabId: latest.voiceTab, windowId: latest.windowId, panel: latest.id, engine: latest.engine, ...(latest.muted ? { muted: true as const } : {}) };
  }

  /** The panel's session is now in `tab` (null: none). */
  private setVoiceTab(info: PanelInfo, tab: number | null): void {
    info.voiceTab = tab;
    this.reportVoice();
  }

  /** Tells the voice dep when the session changed. */
  private reportVoice(): void {
    const session = this.voiceSession();
    const json = JSON.stringify(session);
    if (json === this.reported) return;
    this.reported = json;
    this.deps.voice?.(session);
  }

  /**
   * Ends the session wherever it runs (the panels that listen are told to stop, and report it). None listens: a
   * session the voice dep still has (kept across a worker restart) is over.
   */
  stopVoice(): void {
    const listening = [...this.panels].filter(([, p]) => p.listening);
    for (const [port] of listening) this.post(port, { type: "voice.stop" });
    if (!listening.length) {
      this.reported = "null";
      this.deps.voice?.(null);
    }
  }

  /**
   * A panel gets back the draft and the job it showed; `focus`: the cursor goes in its box (panel.focus), then
   * `voice`: it starts listening. A panel reopened in another window only gets its things back (panel.restore).
   */
  private restore(port: PanelPort, { draft, job }: Restore, focus: boolean, voice: boolean): void {
    const back = { ...(draft ? { draft } : {}), ...(job ? { job } : {}) };
    if (focus) this.post(port, { type: "panel.focus", ...back });
    else if (draft || job) this.post(port, { type: "panel.restore", ...back });
    if (voice) this.post(port, { type: "panel.voice" });
  }

  /** Opens the window's side panel; when it says hello it gets what `opening` says. */
  private openFocused(windowId: number, opening: Restore & { focus: boolean; voice: boolean }): void {
    this.opening.set(windowId, opening);
    this.deps.open(windowId).catch((err: unknown) => {
      // Nothing opens, so no hello will consume it.
      this.opening.delete(windowId);
      this.log(`opening the side panel failed: ${String(err)}`);
    });
  }

  /** Each window with a side panel -> the text in its box and the job it showed. */
  private restoresByWindow(): Map<number, Restore> {
    const out = new Map<number, Restore>();
    for (const p of this.panels.values()) {
      if (p.windowId === null || p.asTab || out.has(p.windowId)) continue;
      out.set(p.windowId, { draft: p.draft, job: p.job });
    }
    return out;
  }

  private panelsOfWindow(windowId: number): [PanelPort, PanelInfo][] {
    return [...this.panels].filter(([, p]) => p.windowId === windowId);
  }

  private post(port: PanelPort, msg: unknown): void {
    try {
      port.postMessage(msg);
    } catch {
      this.panels.delete(port);
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
