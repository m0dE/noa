/**
 * The hands-free session in the side panel (the voice shortcut and the mic
 * button start and end it): runs the state machine (voice/hands-free.ts) on
 * what the engine hears, carries out its effects (send the message, say a
 * line, stop talking), and shows it: the voice bar at the top of the panel
 * (voice-bar.ts) all along, the orb until something was sent, and the mic
 * button and the box (voice-input.ts). While it is on, the toolbar button of
 * its tab has a badge (the background sets it, from onActive), and a soft
 * sound marks the microphone going live and off (Settings > Voice > Sounds).
 *
 * A session belongs to the browser tab it started in (voice/hands-free-tab.ts):
 * what is said goes to that tab's chat by its id, and that chat's events are
 * narrated, whichever tab the user looks at. The side panel stays on screen
 * on every tab of its window, and the bar always names the session's tab
 * ("Voice on · Inbox"). The background knows the one session and the tab in
 * front of the user, and tells every panel (setSession). While the user
 * looks at another tab, the bar offers Go to tab and Use voice here, and
 * what is said carries a note naming both tabs (so is the narrator told):
 * neither the agent nor the narrator sees that tab; "use this tab" (said, or
 * the narrator's use_this_tab) moves the session there. A panel that runs no
 * session (another window's) shows the one another panel runs (Go to tab,
 * Use voice here, Turn off) and nothing live; Use voice here and the mic
 * there end it where it runs, then start it in this panel with the same
 * engine (one microphone). The voice key and the mic end a session this
 * panel runs, wherever it listens; closing its tab ends it.
 *
 * What is said aloud is part of the chat: each line (not the milestones,
 * which repeat the tool rows) is kept in its chat as a "spoken" event, shown
 * playing while it is said. With Realtime, what the user said is kept too,
 * word for word (a "heard" event), with the request the narrator sent for it;
 * the request itself goes out at once and the box is left alone. Standard
 * shows the user's words in the box while they speak, then sends them after
 * a short window in which "cancel" or Esc takes them back.
 *
 * The engine is always the one picked in Settings; only the user changes it
 * (Settings, or a button they press). Realtime that cannot run says why and
 * offers Standard for this once (voice/engine-choice.ts). A Realtime
 * connection that drops is made again (RECONNECT_DELAYS_MS: the strip says
 * "Reconnecting…", the chat and the session go on, the trace says why);
 * if it cannot be, the session ends with "Voice disconnected." and Try
 * again. Connections this browser hands over (Use voice here, reconnecting)
 * take the place of its own session still closing on the server
 * (takeover); another window's or device's is only taken over when the user
 * presses Take over here. The first Realtime session shows what it costs
 * once. Mic permission and plan gating are voice-input.ts's.
 *
 * Mute (the bar's Mute, or Alt+M in the panel: MUTE_KEY) turns the
 * microphone off to the engine while the session goes on: nothing heard is
 * transcribed or sent (Realtime bills no input audio), the narrator and the
 * lines said go on, and the bar, the box and the badge show it, with a soft
 * sound. The session ending unmutes; moving it to another tab (use this tab,
 * or Use voice here in another panel) keeps it muted, so a move never
 * turns the microphone on by itself.
 *
 * It says it listens only once it does. Starting (the microphone check, the
 * connection, the microphone opening) every surface says it does not listen
 * yet and what it waits on: the strip in grey ("Voice starting ·
 * Connecting…"), the orb grey ("Not listening yet · …"), the box without
 * its glow, the Voice button unfilled. The moment the microphone's audio
 * reaches the engine (EngineEvents.capturing) it listens: the listen-on
 * sound, the strip and the orb turn live, "Listening · go ahead". A start
 * that takes START_SLOW_MS says "Still …"; one not listening after
 * START_TIMEOUT_MS ends with what went wrong and Try again. A dropped
 * Realtime connection is "Reconnecting…" (not listening) until the new
 * one's audio flows, with the sound again.
 *
 * Audio lives in the side panel, not an offscreen document: the session is
 * started from the panel, shows itself there, and ends when the panel
 * closes, so the microphone is never on without the indicator in view.
 */
import type { AccountView } from "../ui-protocol.js";
import { errorMessage, traceStart, type AgentEvent, type ApprovalAnswer, type ExtensionSettings, type StampedAgentEvent, isRealtimeEngine, type VoiceEngine, type VoiceEngineId, type VoiceEnginesResponse } from "@noa/shared";
import type { PanelTrace } from "../trace/panel-trace.js";
import { checkEngine, costPerMinuteText, ENGINE_SHORT_NAMES } from "../voice/engine-choice.js";

/** The action that starts the free engine instead (the browser's voice). */
const BROWSER_VOICE_LABEL = "Use browser voice";
import type { EngineEvents, HandsFreeEngine } from "../voice/engine.js";
import { HANDS_FREE, handsFree, initialHandsFree, type EndReason, type HandsFreeEffect, type HandsFreeEvent, type HandsFreePhase, type HandsFreeState } from "../voice/hands-free.js";
import {
  endsWithTab,
  listensElsewhere,
  lookingElsewhereNote,
  lookingHomeNote,
  MOVED_NOTE,
  remoteSession,
  spokenUseThisTab,
  TAB_CLOSED_NOTE,
  useThisTabAnswer,
  useThisTabLine,
  voiceKeyAction,
  type TabPage,
  type UseTabOutcome,
} from "../voice/hands-free-tab.js";
import type { VoiceSessionView } from "../voice-session.js";
import { ChatFollower } from "../voice/chat-follower.js";
import { Narration } from "../voice/narration.js";
import { spokenApprovalAnswer, WaitingApprovals } from "../voice/approval-voice.js";
import { ECHO_WINDOW_MS, echoesSpoken } from "../voice/narrator-policy.js";
import { asRealtimeFailure } from "../voice/realtime-client.js";
import { VoiceError } from "../voice/transcribe.js";
import { errorHelp } from "./error-help.js";
import { Earcons, type Earcon } from "../voice/earcons.js";
import { isMuteKey, LISTENING_CAPTION, notListeningCaption, remoteBarView, VoiceActivity, voiceBarView, type StartStep, type VoiceBarView } from "../voice/voice-bar-view.js";
import { initVoiceBar } from "./voice-bar.js";
import { errorTip, type HandsFreeControl, type VoiceInput, type VoiceTip } from "./voice-input.js";

/** Under the orb while muted (and nothing is being said). */
const MUTED_CAPTION = "Microphone muted · Unmute to talk";

/** A said line stays under the orb this long after it. */
const CAPTION_LINGER_MS = 4_000;

/** Notices about the engine (why it cannot start, the cost) go under this key, apart from voice's others. */
const ENGINE_NOTICE = "voice.engine";

/**
 * A Realtime connection that dropped (or, while connecting, found the user's previous session still closing on the
 * server) is tried again after each of these waits; then the session ends and says so.
 */
export const RECONNECT_DELAYS_MS = [500, 2_000, 5_000] as const;

/** A start (or a reconnect) not listening after this long says it is still at it. */
export const START_SLOW_MS = 6_000;
/** A start (or a reconnect) not listening after this long ends, saying why, with Try again: it never stays starting. */
export const START_TIMEOUT_MS = 25_000;

/** How an engine's opening went: it runs, the session was stopped meanwhile, or it failed (why). */
type Opened = "open" | "stopped" | { failed: unknown };

/** Why the session stopped, when the user did not stop it themselves. */
function endNote(reason: EndReason): string | null {
  if (reason === "silence") return "Hands-free stopped: it was quiet for a while.";
  return null;
}

/** What goes with a message besides its words (see HandsFreeDeps.send). */
export interface SendExtra {
  cid?: string;
  context?: string;
  /** The user's words for it, word for word (Realtime: the text is the request as the narrator understood it). */
  heard?: readonly string[];
}

/** A line being said: in which chat (null: none yet), its words so far, and whether the chat keeps it. */
interface Line {
  sessionId: string | null;
  text: string;
  keep: boolean;
}

export interface HandsFreeDeps {
  voice: Pick<VoiceInput, "state" | "attachHandsFree" | "showHandsFree" | "setLevel" | "showTip" | "ensureMic" | "shortcutLabel">;
  /** The input box: the user's words show there while the session's tab is shown. */
  composer: {
    draft(): string;
    setDraft(value: string): void;
  };
  /** Voice's notices above the box (why it cannot start or stopped, the cost). */
  notify(tip: VoiceTip & { key?: string }): void;
  /** The browser tab the panel shows: its window's active tab (null: unknown). */
  activeTab(): number | null;
  /** This panel page's id: the background names the panel running the session by it (VoiceSessionView.panel). */
  panel: string;
  /** The chat of a browser tab (null: it has none yet). */
  chatOf(tabId: number | null): string | null;
  /** The tabs a chat lives in now: the tab it belongs to and the tabs its running task works in. */
  tabsOf(sessionId: string): readonly number[];
  /**
   * Sends what was said to chat `sessionId` (null: starts one in `tabId`); resolves with the chat's id.
   * cid: the utterance's correlation id in the conversation's trace. context: what the agent is told with it (the
   * note on the tab the user looks at), never shown as the user's words.
   */
  send(text: string, target: { tabId: number | null; sessionId: string | null }, extra?: SendExtra): Promise<string>;
  /** A tab's title and address, for the bar and the notes on the tab the user looks at (null: no such tab). */
  tabPage(tabId: number): Promise<TabPage | null>;
  /** Shows a tab (Go to tab). */
  goToTab(tabId: number): void;
  /** A line is being said in a chat (null: it is over). */
  onSpeaking(line: { sessionId: string; text: string } | null): void;
  /** A line to say, in the language picked in Settings (phrases.ts localizeLine); absent: as it is. */
  localize?(text: string): string;
  /** Keeps a said line in its chat. */
  keepSpoken(sessionId: string, text: string): void;
  /** Keeps what the user said (Realtime) that led to no request in its chat, for the record (not shown). */
  keepHeard(sessionId: string, text: string): void;
  settings(): ExtensionSettings | null;
  account(): AccountView | undefined;
  /** The server's voice engines (null: could not be loaded). */
  engines(): Promise<VoiceEnginesResponse | null>;
  saveSettings(patch: Partial<ExtensionSettings>): Promise<void>;
  /** Settings > AI, where the voice engine is picked. */
  openVoiceSettings(): void;
  /** takeover: a Realtime engine ends the user's session still open on the server and takes its place. */
  createEngine(id: VoiceEngineId, events: EngineEvents, opts?: { takeover?: boolean }): HandsFreeEngine;
  /** Stops the running task of a chat; says what happened. */
  stopTask(sessionId: string | null): Promise<string>;
  /** Answers an approval request of a chat by voice; true when it was still waiting. */
  answerApproval(sessionId: string, id: string, answer: ApprovalAnswer): Promise<boolean>;
  openBilling(): void;
  signIn(): void;
  /**
   * The session started, moved to another tab, changed engine, was muted or unmuted, or ended; tabId: the tab it
   * belongs to. The panel tells the background, which tells the other panels, routes the shortcut to it, and sets
   * the badges.
   */
  onActive(active: boolean, tabId: number | null, engine: VoiceEngineId | null, muted: boolean): void;
  /** Ends the session another panel runs (the background tells that panel). */
  stopRemote(): void;
  /** The voice bar's element (under the tabs; voice-bar.ts fills it). */
  bar: HTMLElement;
  /** The start and stop sounds (default: WebAudio's). */
  earcons?: { play(kind: Earcon): void };
  /** The conversation's trace: what was heard, the sending window, and how long the message took to go out. */
  trace?: Pick<PanelTrace, "record" | "utterance" | "endUtterance" | "bind" | "target">;
  log?(message: string): void;
  now?(): number;
}

export interface HandsFree extends HandsFreeControl {
  /** An event of any chat (the session's chat's are narrated). */
  onEvent(ev: StampedAgentEvent): void;
  /** The chats with a task running now (the session's chat working keeps it listening). */
  setRunning(sessionIds: readonly string[]): void;
  /** The tab shown, or a tab's chat, changed: the bar and the chat followed are looked at again. */
  refresh(): void;
  /** A browser tab closed (its own ends the session). */
  tabClosed(tabId: number): void;
  /** A browser tab's title or address changed: the bar names the session's tab as it is now. */
  tabUpdated(tabId: number): void;
  /** The session as the background knows it (null: none), with the tab the user looks at. */
  setSession(view: VoiceSessionView | null): void;
  /** The background asks this panel to end its session (Stop or Use voice here in another panel). */
  stopHere(): void;
  /** The chat the session talks to (null: none, or a new chat not started yet). */
  chat(): string | null;
  /** Mutes or unmutes the microphone of the session on (nothing while none runs yet). */
  toggleMute(): void;
  readonly muted: boolean;
  readonly phase: HandsFreePhase;
  /** The tab the session belongs to (null: none is on). */
  readonly tab: number | null;
}

export function initHandsFree(deps: HandsFreeDeps): HandsFree {
  const now = deps.now ?? (() => Date.now());
  let state: HandsFreeState = initialHandsFree();
  let engine: HandsFreeEngine | null = null;
  let narration = new Narration();
  /** The approval each followed chat waits on: a spoken yes or no answers it. */
  const approvals = new WaitingApprovals();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: ReadonlySet<string> = new Set();
  let working = false;
  /** Something was sent this session (the orb then gives way to the chat). */
  let sent = false;
  /** The tab the session belongs to, and its title and address (for the bar, and the notes). */
  let tab: number | null = null;
  let homePage: TabPage | null = null;
  /** The session as the background last said (this panel's, another panel's, or none), and its tab's title and address. */
  let remote: VoiceSessionView | null = null;
  let remotePage: TabPage | null = null;
  /** Use voice here: waiting for the session to end where it runs, to start here with its engine and mute. */
  let takeOver: { engine: VoiceEngineId | null; muted: boolean } | null = null;
  /** A session starting muted (moved here muted), until the state machine holds it. */
  let startMuted = false;
  /** The narrator was last told the user looks at another tab. */
  let lookingAway = false;
  /** Its tab and the tabs its chat lived in this session (see voice/hands-free-tab.ts). */
  const ownTabs = new Set<number>();
  /**
   * The chat the session talks to, by id once known (the tab's chat when it started, or the one its first
   * message started): the chat may move to another tab (a run started from an extension page works in a tab of
   * its own, and the chat goes with it), and the session follows the chat, not the tab.
   */
  let chatId: string | null = null;
  /** The box's text before the session wrote the user's words into it; whether the box shows them. */
  let boxBase = "";
  let wroteBox = false;
  /** Under the orb (before anything was sent): what is being said. */
  let caption = "";
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  let line: Line | null = null;
  /** Lines said aloud lately, with when: the microphone hearing one of them is not the user (echoesSpoken). */
  const saidAloud: { text: string; at: number }[] = [];
  const recentlySaid = () => {
    const since = now() - ECHO_WINDOW_MS;
    while (saidAloud[0] && saidAloud[0].at < since) saidAloud.shift();
    return saidAloud.map((s) => s.text);
  };
  /** Milestone lines (said, but not kept: the chat shows those steps already). */
  const passing = new Set<string>();
  /** Starting (engine choice, microphone, connection). */
  let starting = false;
  /**
   * Which session is the current one: start() and finish() move it on. What a start or a reconnect does after an
   * await is only done while the session it began in is still the current one (a stop, or a stop and a new start,
   * may have come meanwhile).
   */
  let session = 0;
  /** The Realtime connection dropped and is being made again (the session goes on). */
  let reconnecting = false;
  /** When the session started (the bar's time on). */
  let startedAt = 0;
  /** The start sound was made: the stop sound goes with it. */
  let chimed = false;
  /**
   * Listening for real: the engine is open and the microphone's audio reached it (or it is muted: nothing is to
   * reach it). Until then every surface says it does not listen yet.
   */
  let ready = false;
  /** The engine is open (its start resolved). */
  let opened = false;
  /** The engine said its first audio came (EngineEvents.capturing). */
  let capturing = false;
  /** Not ready yet: what it waits on, and whether it has taken START_SLOW_MS. */
  let step: StartStep = "microphone";
  let slow = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  /** A voice on the microphone now ("Hearing you…"). */
  const activity = new VoiceActivity();
  /** What the bar last showed of it. */
  let hearing = false;
  const earcons = deps.earcons ?? new Earcons(undefined, deps.log);
  const sound = (kind: Earcon) => {
    if (deps.settings()?.voiceSounds !== false) earcons.play(kind);
  };
  /** The last message going out (it may be starting a new chat): the user's words for it wait for it. */
  let sending: Promise<void> = Promise.resolve();
  /** The message starting the session's chat, until its id is known: messages said meanwhile go to that chat after it. */
  let startingChat: Promise<void> | null = null;
  const chatNow = () => chatId ?? deps.chatOf(tab);
  const follower = new ChatFollower(chatNow);
  const trace = deps.trace;
  // Voice events without an utterance (lines said, the narrator's updates) belong to the chat the session talks to.
  if (trace) trace.target = () => (on() ? chatNow() : null);
  /** When the words to send were heard (the sending window starts). */
  let heardAt: number | null = null;
  const heard = (text: string) => {
    heardAt = Date.now();
    trace?.record({ t: heardAt, cat: "voice", name: "voice.heard", cid: trace.utterance(), data: { chars: text.length } });
  };
  const on = () => state.phase !== "off" || starting;
  const muted = () => (state.phase === "off" ? startMuted : state.muted);
  /** Adds the tabs the session's chat works in now to its own. */
  const learnTabs = () => {
    const chat = chatNow();
    if (chat) for (const t of deps.tabsOf(chat)) ownTabs.add(t);
  };
  /** The tab the user looks at (null: not known). */
  const viewing = () => deps.activeTab();
  const here = () => {
    learnTabs();
    return !listensElsewhere(ownTabs, viewing());
  };
  /** Another panel's session, as this panel shows it (Go to tab, Use voice here, Turn off). */
  const shownRemote = () => (!on() && remoteSession(remote, deps.panel) === "notice" ? remote : null);

  // The strip's links act on this panel's session, else on the one another panel runs.
  const bar = initVoiceBar(deps.bar, {
    turnOff: () => (on() ? stop("button") : deps.stopRemote()),
    goToTab: () => {
      const t = on() ? tab : (remote?.tabId ?? null);
      if (t !== null) deps.goToTab(t);
    },
    useThisTab: () => (on() ? moveHere() : useVoiceHere()),
  });

  function render(): void {
    if (!on()) {
      const r = shownRemote();
      bar.show(r ? remoteBarView({ where: remotePage, engine: r.engine, muted: r.muted === true }) : null);
      delete deps.bar.dataset.phase;
      deps.voice.showHandsFree(null);
      return;
    }
    // Not listening yet (the microphone check, the connection, the microphone's first audio): starting.
    const phase = state.phase === "off" || !ready ? null : state.phase;
    const elsewhere = !here();
    const t = now();
    hearing = activity.hearing(t);
    const view: VoiceBarView = voiceBarView({
      phase: phase ?? "starting",
      step,
      slow,
      hearing,
      muted: muted(),
      reconnecting,
      engine: engine?.id ?? null,
      elapsedMs: t - startedAt,
      where: homePage,
      elsewhere,
    });
    bar.show(view);
    // The phase, and where the session is at home (for debugging and tests): its chat and its tabs.
    deps.bar.dataset.phase = phase ?? (reconnecting ? "reconnecting" : "starting");
    deps.bar.dataset.chat = chatNow() ?? "";
    deps.bar.dataset.tabs = [...ownTabs].join(",");
    // The orb veils the session's own tab until something was sent; its caption carries the words.
    const orb = !sent && phase !== "working" && !elsewhere;
    // Not listening yet: the orb says so, and what it waits on.
    const waiting = !phase ? notListeningCaption(reconnecting ? "reconnecting" : step, slow) : null;
    deps.voice.showHandsFree({
      orb,
      phase: phase ?? "opening",
      caption: waiting ?? (phase === "sending" ? "Sending…" : caption || (muted() ? MUTED_CAPTION : LISTENING_CAPTION)),
      elsewhere,
      listening: !!phase && !muted(),
      muted: muted(),
      mute: view.mute,
    });
  }

  /** The microphone's level: the meter, and "Hearing you…" while a voice is on it. */
  function onLevel(level: number): void {
    deps.voice.setLevel(level);
    const t = now();
    activity.push(level, t);
    if (activity.hearing(t) !== hearing) render();
  }

  function dispatch(e: HandsFreeEvent): void {
    const r = handsFree(state, e);
    state = r.state;
    for (const effect of r.effects) run(effect);
    render();
  }

  // --- The lines said aloud: playing in their chat, then kept there.

  /** A new line starts (the one before it is over). */
  /** `said`: the line as decided, before it was put in the user's language (what `passing` holds). */
  function beginLine(text: string, said = text): void {
    endLine();
    line = { sessionId: chatNow(), text, keep: !passing.delete(said) };
    showLine();
  }

  /** The Realtime narrator's words so far (they only grow within a reply; a new reply starts a new line). */
  function narratorWords(text: string): void {
    if (!line || !text.startsWith(line.text)) beginLine(text);
    else {
      line.text = text;
      showLine();
    }
  }

  function showLine(): void {
    if (!line) return;
    setCaption(line.text);
    if (line.keep && line.sessionId) deps.onSpeaking({ sessionId: line.sessionId, text: line.text });
  }

  /** The orb's caption; a said line lingers there a little. */
  function setCaption(text: string, linger = false): void {
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = linger ? setTimeout(() => setCaption(""), CAPTION_LINGER_MS) : null;
    if (!linger) caption = text;
    render();
  }

  /** The line is over (said, cut off, or the session ended): its chat keeps it. */
  function endLine(): void {
    const l = line;
    line = null;
    if (!l) return;
    if (l.text.trim()) saidAloud.push({ text: l.text, at: now() });
    setCaption(l.text, true);
    if (!l.keep || !l.sessionId) return;
    deps.onSpeaking(null);
    if (l.text.trim()) deps.keepSpoken(l.sessionId, l.text.trim());
  }

  function run(effect: HandsFreeEffect): void {
    switch (effect.type) {
      case "send":
        sending = send(effect.text, effect.heard);
        break;
      case "speak": {
        const text = deps.localize?.(effect.text) ?? effect.text;
        beginLine(text, effect.text);
        engine?.speak(text);
        break;
      }
      case "hush":
        engine?.hush();
        endLine();
        break;
      case "transcribe":
        engine?.setTranscribing(effect.on);
        break;
      case "mute":
        engine?.setMuted(effect.muted);
        // The meter and "Hearing you…" drop at once; the badge and the other panels follow.
        activity.reset();
        hearing = false;
        if (effect.muted) deps.voice.setLevel(0);
        trace?.record({ t: Date.now(), cat: "voice", name: effect.muted ? "voice.mute" : "voice.unmute" });
        report();
        // Muted it is as ready as it gets; unmuted before any audio came, it waits for it again (and not forever).
        checkReady();
        if (!ready) watchStart();
        break;
      case "cancelled":
        if (wroteBox) deps.composer.setDraft(boxBase);
        wroteBox = false;
        heardAt = null;
        trace?.record({ t: Date.now(), cat: "voice", name: "voice.cancelled", cid: trace.utterance() });
        trace?.endUtterance();
        deps.notify({ text: "Cancelled.", level: "info" });
        break;
      case "end":
        finish(endNote(effect.reason), effect.reason);
        break;
    }
  }

  /**
   * Sends a message at once, unless the session's chat is still being started by an earlier one: then right after
   * it, into that chat (sent now, it would start a second chat).
   */
  function send(text: string, heard?: readonly string[]): Promise<void> {
    const cid = trace?.utterance();
    if (startingChat) return startingChat.then(() => sendNow(text, cid, heard));
    const startsChat = chatNow() === null;
    const out = sendNow(text, cid, heard);
    if (startsChat) {
      startingChat = out;
      void out.finally(() => {
        if (startingChat === out) startingChat = null;
      });
    }
    return out;
  }

  /** What was said goes to the session's chat, whichever tab is shown. cid: its utterance in the trace; heard: see SendExtra. */
  async function sendNow(text: string, cid: string | undefined, heard?: readonly string[]): Promise<void> {
    sent = true;
    follower.sent(now());
    if (wroteBox) deps.composer.setDraft("");
    wroteBox = false;
    boxBase = "";
    // The sending window (cancellable) was waiting too.
    if (trace && heardAt !== null) {
      const waited = Date.now() - heardAt;
      trace.record({ t: heardAt, ms: waited, cat: "voice", name: "voice.send_window", cid: cid!, data: { waitMs: waited } });
    }
    heardAt = null;
    const delivery = traceStart();
    try {
      // Said while the user looks at another tab: the agent learns it cannot see that tab (the chat shows the words alone).
      const note = here() ? null : await lookingNote();
      const target = { tabId: tab, sessionId: chatNow() };
      const extra: SendExtra = { ...(cid === undefined ? {} : { cid }), ...(note ? { context: note } : {}), ...(heard?.length ? { heard } : {}) };
      chatId = await (Object.keys(extra).length ? deps.send(text, target, extra) : deps.send(text, target));
      if (trace && cid) {
        const ms = delivery.elapsed();
        trace.record({ t: delivery.t, ms, cat: "voice", name: "voice.deliver", cid, data: { chars: text.length, waitMs: ms } });
        trace.bind(cid, chatId);
      }
    } catch (err) {
      deps.notify({ ...failureTip(err), key: "voice" });
    }
    trace?.endUtterance(cid);
    syncChat();
  }

  /** What the user said (Realtime) that led to no request: kept in the session's chat for the record (none yet: let go). */
  async function keepWords(words: readonly string[]): Promise<void> {
    if (startingChat) await startingChat;
    const chat = state.phase === "off" ? null : chatNow();
    if (chat && words.length) deps.keepHeard(chat, words.join(" "));
  }

  /** The user's words so far (Standard), in the box (after what was typed there) while the session's tab is shown. */
  function showWords(text: string): void {
    if (!here()) return;
    if (!wroteBox) boxBase = deps.composer.draft();
    wroteBox = true;
    const pending = state.pending ? `${state.pending} ` : "";
    deps.composer.setDraft([boxBase.trim(), `${pending}${text}`.trim()].filter(Boolean).join(" "));
  }

  function events(): EngineEvents {
    const alive = (fn: () => void) => () => state.phase !== "off" && fn();
    return {
      speech: () => alive(() => dispatch({ type: "speech", now: now() }))(),
      heard: (text, forward) =>
        alive(() => {
          // The speaker's own line heard back (Standard): not the user.
          if (forward && echoesSpoken(text, recentlySaid())) {
            forward = false;
            trace?.record({ t: Date.now(), cat: "voice", name: "voice.echo", data: { chars: text.length } });
          }
          // A yes or no while the chat waits for an approval answers it, and is not sent as a message.
          if (forward && answerByVoice(text)) forward = false;
          // "Use this tab" (Standard) moves the session to the tab the user looks at, and says so.
          if (forward && spokenUseThisTab(text)) {
            forward = false;
            void useViewedTab().then((outcome) => {
              if (state.phase === "off") return;
              narration.said(now());
              dispatch({ type: "say", text: useThisTabLine(outcome), now: now() });
            });
          }
          if (forward && text.trim()) heard(text);
          dispatch({ type: "heard", text, forward, now: now() });
          // Not going out (a stop word, nothing said): the utterance is over.
          if (state.phase !== "sending") trace?.endUtterance();
          if (state.phase === "sending") showWords("");
          else if (!forward && state.phase !== "off" && wroteBox) {
            deps.composer.setDraft(boxBase);
            wroteBox = false;
          }
        })(),
      partial: (text) => alive(() => showWords(text))(),
      level: (l) => onLevel(l),
      openingMic: () => {
        if (!on() || ready) return;
        step = "microphone";
        render();
      },
      capturing: () => {
        if (!on()) return;
        capturing = true;
        checkReady();
      },
      narrating: () => alive(() => dispatch({ type: "narrating", now: now() }))(),
      said: () =>
        alive(() => {
          endLine();
          dispatch({ type: "said", now: now() });
        })(),
      narratorText: (t) => alive(() => narratorWords(t))(),
      forward: (text, heard) =>
        alive(() => {
          // Realtime sends at once (no sending window).
          trace?.record({ t: Date.now(), cat: "voice", name: "voice.forward", cid: trace.utterance(), data: { chars: text.length } });
          dispatch({ type: "forward", text, ...(heard?.length ? { heard } : {}), now: now() });
        })(),
      userWords: (words) => alive(() => void keepWords(words))(),
      stopTask: () => deps.stopTask(chatNow()),
      answerApproval: async (allow) => {
        const chat = chatNow();
        const id = approvals.of(chat);
        if (!chat || !id) return "Nothing is waiting for the user's OK.";
        const ok = await deps.answerApproval(chat, id, allow ? "allow_once" : "deny");
        return ok ? (allow ? "Allowed: the task goes on." : "Denied: it will not be done.") : "That request is no longer waiting.";
      },
      endVoice: () => stop("narrator"),
      useThisTab: async () => useThisTabAnswer(await useViewedTab()),
      failed: (err) => void onEngineFailure(err),
    };
  }

  /**
   * Why an engine stopped: a Realtime connection that dropped is made again (reconnect); anything else ends the
   * session and says why. Never another engine.
   */
  function onEngineFailure(err: unknown): void {
    const id = engine?.id ?? null;
    traceFailure(id, err);
    if (id && isRealtimeEngine(id) && state.phase !== "off" && asRealtimeFailure(err)?.transient) return void reconnect(err);
    finish(null, "error");
    deps.notify(failureTip(err, id));
  }

  /** The Realtime connection dropped: a new one is made (the chat, the phase and the mute go on), or the session ends. */
  async function reconnect(err: unknown): Promise<void> {
    const gen = session;
    const dropped = engine;
    const id = dropped?.id ?? "realtime";
    engine = null;
    dropped?.stop();
    // Not listening until the new connection's audio flows.
    notReady("connecting");
    // What was being said is gone with the connection.
    endLine();
    if (state.phase === "speaking") dispatch({ type: "said", now: now() });
    reconnecting = true;
    render();
    trace?.record({ t: Date.now(), cat: "voice", name: "voice.reconnect", data: { reason: asRealtimeFailure(err)?.kind ?? "unknown", attempt: 0 } });
    // This browser held the one session: the server's end of it may still be closing, so this one takes its place.
    const r = await connect(id, true, gen);
    // Ended meanwhile (finish() reset the rest).
    if (gen !== session) return;
    if (r === "stopped") return;
    if (r !== "open") {
      reconnecting = false;
      finish(null, "error");
      deps.notify(failureTip(r.failed, id));
      return;
    }
    // "Reconnecting…" stays until its audio flows (checkReady).
    render();
  }

  /** An engine could not start or go on: an error in the trace of the chat the session talks to. */
  function traceFailure(id: VoiceEngineId | null, err: unknown): void {
    const message = asRealtimeFailure(err)?.message ?? errorMessage(err);
    trace?.record({ t: Date.now(), cat: "error", name: "voice.failed", data: { engine: id, error: message.slice(0, 160) } });
  }

  /** What to say when voice could not start or go on (on engine `id`), with what the user can do about it (never done for them). */
  function failureTip(err: unknown, id: VoiceEngineId | null = null): VoiceTip {
    if (err instanceof VoiceError) return errorTip(err, deps.openBilling);
    const f = asRealtimeFailure(err);
    const rt = id && isRealtimeEngine(id) ? id : "realtime";
    const standard = { label: BROWSER_VOICE_LABEL, run: () => void start("standard") };
    if (f?.kind === "busy" || f?.kind === "replaced") return { text: f.message, level: "error", actions: [{ label: "Take over here", run: () => void start(rt, false, true) }] };
    if (f?.transient) return { text: f.message, level: "error", actions: [{ label: "Try again", run: () => void start(rt) }, standard] };
    if (f?.kind === "unavailable") return { text: f.message, level: "error", actions: [standard] };
    const message = f?.message ?? errorMessage(err);
    const help = errorHelp(message);
    const fix = help.fixes.find((x) => x.kind === "topup" || x.kind === "plans" || x.kind === "login");
    const actions = fix ? [{ label: fix.label, run: fix.kind === "login" ? deps.signIn : deps.openBilling }] : [];
    return { text: help.known ? help.message : message, level: "error", ...(actions.length ? { actions } : {}) };
  }

  /**
   * Opens `id` (takeover: see HandsFreeDeps.createEngine); on success the session runs on it. An engine that is no
   * longer the session's once it started (a stop, or a newer start, came meanwhile) is stopped: nothing else would.
   */
  async function openEngine(id: VoiceEngineId, takeover: boolean): Promise<Opened> {
    const e = deps.createEngine(id, events(), takeover ? { takeover } : undefined);
    engine = e;
    opened = false;
    capturing = false;
    // Muted before the microphone opens (a muted session moved here, or reconnecting while muted).
    if (muted()) e.setMuted(true);
    try {
      await e.start();
    } catch (err) {
      e.stop();
      if (engine !== e) return "stopped";
      traceFailure(id, err);
      engine = null;
      return { failed: err };
    }
    if (engine !== e) {
      e.stop();
      return "stopped";
    }
    report();
    // The narrator starts out knowing whether the user looks at another tab.
    lookingAway = false;
    lookChanged();
    if (state.phase === "off") dispatch({ type: "start", now: now(), halfDuplex: e.halfDuplex, muted: startMuted });
    else if (e.halfDuplex !== state.halfDuplex) state = { ...state, halfDuplex: e.halfDuplex };
    e.setTranscribing(state.phase !== "speaking");
    e.setAgentWorking?.(working);
    if (working) dispatch({ type: "agent", working, now: now() });
    opened = true;
    step = "microphone";
    checkReady();
    return "open";
  }

  /** Opens `id`, trying Realtime again after RECONNECT_DELAYS_MS while its failure may pass; the trace says why. */
  async function connect(id: VoiceEngineId, takeover: boolean, gen: number): Promise<Opened> {
    for (let attempt = 1; ; attempt++) {
      const r = await openEngine(id, takeover);
      if (r === "open" || r === "stopped") return r;
      const f = asRealtimeFailure(r.failed);
      const delayMs = RECONNECT_DELAYS_MS[attempt - 1];
      if (!isRealtimeEngine(id) || !f?.transient || delayMs === undefined) return r;
      trace?.record({ t: Date.now(), cat: "voice", name: "voice.reconnect", data: { reason: f.kind, attempt, delayMs } });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (gen !== session) return "stopped";
    }
  }

  /** Binds the session to `next` (its start, or the shortcut pressed there): its chat is followed from now on. */
  function bind(next: number | null): void {
    tab = next;
    homePage = null;
    chatId = deps.chatOf(next);
    ownTabs.clear();
    if (next !== null) ownTabs.add(next);
    follower.start();
    narration = new Narration();
    if (next !== null) learnHomePage(next);
  }

  /** Tells the background where the session is (or that it ended), on which engine, and whether it is muted. */
  function report(): void {
    const live = on();
    deps.onActive(live, live ? tab : null, live ? (engine?.id ?? null) : null, live && muted());
  }

  /**
   * `picked`: the engine to use (a session moved here keeps its engine; the user chose one on a notice); else the one
   * in Settings. `mute`: it starts muted (a muted session moved here stays so). `takeover`: see createEngine.
   */
  async function start(picked: VoiceEngineId | null = null, mute = false, takeover = false): Promise<void> {
    if (on()) return;
    const gen = ++session;
    starting = true;
    startMuted = mute;
    sent = false;
    wroteBox = false;
    startedAt = now();
    const settings = deps.settings();
    const id = picked ?? settings?.voiceEngine ?? "realtime";
    // Realtime connects first; the others only open the microphone.
    notReady(isRealtimeEngine(id) ? "connecting" : "microphone");
    bind(deps.activeTab());
    render();
    report();
    trace?.record({ t: Date.now(), cat: "voice", name: "voice.start", data: { engine: id, why: picked ? (takeover ? "taken over" : "chosen") : "settings", ...(takeover ? { takeover } : {}) } });
    try {
      const micAllowed = await deps.voice.ensureMic();
      if (gen !== session) return;
      if (!micAllowed) return void finish(null);
      const engines = id === "standard" ? null : await deps.engines().catch(() => null);
      if (gen !== session) return;
      const check = checkEngine({ picked: id, engines, creditCents: deps.account()?.credit?.totalCents });
      if (check.blocked) {
        finish(null);
        deps.notify({ key: ENGINE_NOTICE, text: check.blocked, level: "error", actions: [{ label: BROWSER_VOICE_LABEL, run: () => void start("standard") }] });
        return;
      }
      if (check.note) deps.notify({ key: ENGINE_NOTICE, text: check.note, level: "info", actions: [{ label: "Top up", run: deps.openBilling }] });
      else if (isRealtimeEngine(id) && settings && !settings.realtimeCostNoticed) costNotice(id, engines?.engines ?? null);
      const r = await connect(id, takeover, gen);
      if (r === "stopped") return;
      if (r !== "open") {
        finish(null, "error");
        deps.notify(failureTip(r.failed));
        return;
      }
      // The engine is open (it listens once its audio flows: checkReady).
      syncChat();
      timer = setInterval(() => {
        const t = now();
        dispatch({ type: "tick", now: t });
        engine?.tick(t);
        stillWorking(t);
      }, HANDS_FREE.tickMs);
    } finally {
      if (gen === session) {
        starting = false;
        render();
      }
    }
  }

  /** Not listening (a start, or a reconnect): what it waits on first, and a limit on how long it may take. */
  function notReady(first: StartStep): void {
    ready = opened = capturing = false;
    step = first;
    watchStart();
  }

  /** Says "Still …" after START_SLOW_MS, and ends it, saying why, after START_TIMEOUT_MS, unless it listens by then. */
  function watchStart(): void {
    clearStartTimers();
    const gen = session;
    slowTimer = setTimeout(() => {
      slowTimer = null;
      slow = true;
      render();
    }, START_SLOW_MS);
    deadline = setTimeout(() => {
      deadline = null;
      if (gen === session && on() && !ready) startTimedOut();
    }, START_TIMEOUT_MS);
  }

  function clearStartTimers(): void {
    if (slowTimer) clearTimeout(slowTimer);
    if (deadline) clearTimeout(deadline);
    slowTimer = deadline = null;
    slow = false;
  }

  /** It listens now (the engine open, its audio flowing; or muted): the listen-on sound, and every surface goes live. */
  function checkReady(): void {
    const next = on() && opened && (capturing || muted());
    if (next === ready) return;
    ready = next;
    if (!next) return render();
    clearStartTimers();
    const again = reconnecting;
    reconnecting = false;
    trace?.record({ t: Date.now(), cat: "voice", name: "voice.listening", data: { engine: engine?.id ?? null, ...(again ? { reconnected: true } : {}) } });
    chimed = true;
    sound("start");
    render();
  }

  /** Not listening after START_TIMEOUT_MS: it ends, saying what it waited on, with Try again. */
  function startTimedOut(): void {
    const id = engine?.id ?? deps.settings()?.voiceEngine ?? "realtime";
    const connecting = step === "connecting";
    const text = connecting ? "Voice couldn't connect, so it isn't listening." : "The mic didn't start, so voice isn't listening. Check no other app is using it.";
    trace?.record({ t: Date.now(), cat: "error", name: "voice.failed", data: { engine: id, error: connecting ? "start timed out: connecting" : "start timed out: no microphone audio" } });
    const muteAgain = muted();
    finish(null, "error");
    const actions = [{ label: "Try again", run: () => void start(id, muteAgain) }];
    if (connecting && isRealtimeEngine(id)) actions.push({ label: BROWSER_VOICE_LABEL, run: () => void start("standard", muteAgain) });
    deps.notify({ text, level: "error", actions });
  }

  /** Once: what Realtime costs; the engine is changed in Settings. */
  function costNotice(id: VoiceEngineId, engines: VoiceEngine[] | null): void {
    const rt = engines?.find((e) => e.id === id);
    const name = `${ENGINE_SHORT_NAMES[id]} voice`;
    const cost = rt ? `${name} uses ${costPerMinuteText(rt.approxCentsPerMinute)}.` : `${name} uses usage credit by the minute.`;
    deps.notify({ key: ENGINE_NOTICE, text: `${cost} Deepgram and the browser voice cost much less.`, level: "info", actions: [{ label: "Voice settings", run: deps.openVoiceSettings }] });
    void deps.saveSettings({ realtimeCostNoticed: true }).catch((err: unknown) => deps.log?.(`saving the cost notice failed: ${errorMessage(err)}`));
  }

  /** Ends the session; `why` goes in the trace (the state machine's reason, or what ended it here). */
  function finish(note: string | null, why: EndReason | "tab closed" | "moved" | "not started" = "not started"): void {
    if (on()) trace?.record({ t: Date.now(), cat: "voice", name: "voice.end", data: { engine: engine?.id ?? null, why } });
    if (timer) clearInterval(timer);
    timer = null;
    startMuted = false;
    const e = engine;
    engine = null;
    e?.stop();
    session++;
    starting = false;
    reconnecting = false;
    clearStartTimers();
    ready = opened = capturing = false;
    endLine();
    passing.clear();
    setCaption("");
    if (state.phase !== "off") state = { ...initialHandsFree() };
    if (wroteBox && !sent) deps.composer.setDraft(boxBase);
    wroteBox = false;
    tab = null;
    chatId = null;
    ownTabs.clear();
    lookingAway = false;
    // The background's view was of this session: it is over (its "none" follows).
    remote = null;
    deps.voice.setLevel(0);
    activity.reset();
    if (chimed) sound("stop");
    chimed = false;
    render();
    report();
    if (note) deps.notify({ text: note, level: "info" });
  }

  function stop(reason: EndReason): void {
    if (state.phase === "off") {
      if (starting) finish(null);
      return;
    }
    dispatch({ type: "stop", reason });
  }

  /** Mute or unmute, once the session runs; a soft sound says which. */
  function toggleMute(): void {
    if (state.phase === "off") return;
    const next = !state.muted;
    dispatch({ type: "mute", muted: next, now: now() });
    sound(next ? "mute" : "unmute");
  }

  /** Use voice here (on the bar, on another tab): the session goes on in the tab the user looks at. */
  function moveHere(): void {
    moveTo(viewing());
    deps.notify({ text: MOVED_NOTE, level: "info" });
  }

  /** The session goes on for `target` (its chat, its badge), in this panel. */
  function moveTo(target: number | null): void {
    if (wroteBox) deps.composer.setDraft(boxBase);
    wroteBox = false;
    bind(target);
    report();
    syncChat();
    // Moved to where the user looks: the narrator learns it from the move's answer, not from a note.
    lookingAway = !here();
    render();
  }

  /** "Use this tab" said (or the narrator's use_this_tab): the session moves to the tab the user looks at, if it can. */
  async function useViewedTab(): Promise<UseTabOutcome> {
    const target = viewing();
    if (target === null) return "unknown";
    if (here()) return "here";
    const page = await deps.tabPage(target).catch(() => null);
    if (!page || !on()) return "gone";
    moveTo(target);
    return { moved: page };
  }

  /**
   * Use voice here (or the mic) in a panel that shows another tab's session: it ends where it runs, then starts in
   * this panel with the same engine once the background says it ended (setSession): one microphone at a time.
   */
  function useVoiceHere(): void {
    if (on() || takeOver || !remote) return;
    takeOver = { engine: remote.engine, muted: remote.muted === true };
    deps.stopRemote();
  }

  /** The note on the tab the user looks at (null: the session's own), with both tabs' titles as they are now. */
  async function lookingNote(): Promise<string | null> {
    const looking = viewing();
    if (looking === null || here()) return null;
    const home = tab;
    const [page, homeNow] = await Promise.all([deps.tabPage(looking).catch(() => null), home === null ? null : deps.tabPage(home).catch(() => null)]);
    if (homeNow && tab === home) homePage = homeNow;
    return lookingElsewhereNote(page, homePage);
  }

  /** The user turned to another tab, or back: the narrator is told (it cannot see the other tab). */
  function lookChanged(): void {
    if (!on() || !engine) return;
    const away = !here();
    if (away === lookingAway) return;
    lookingAway = away;
    const e = engine;
    void lookingNote().then((note) => {
      if (engine === e && lookingAway === away) e.note(note ?? lookingHomeNote(homePage));
    });
  }

  /** The tab of the session another panel runs, for the bar (it may have changed since). */
  function learnRemotePage(tabId: number): void {
    void deps.tabPage(tabId).then(
      (p) => {
        if (remote?.tabId !== tabId) return;
        remotePage = p;
        render();
      },
      () => undefined,
    );
  }

  /** This panel's session's tab, for the bar and the notes (its title may have changed). */
  function learnHomePage(tabId: number): void {
    void deps.tabPage(tabId).then((p) => (tab === tabId ? ((homePage = p), render()) : undefined), () => undefined);
  }

  /** The session's chat may have changed (a message started one; its tab shows another): narrate it, and whether it works. */
  function syncChat(): void {
    if (state.phase === "off") return;
    learnTabs();
    for (const e of follower.refresh()) narrate(e);
    const next = running.has(chatNow() ?? "");
    if (next === working) return;
    working = next;
    engine?.setAgentWorking?.(next);
    dispatch({ type: "agent", working: next, now: now() });
  }

  // Esc: cancels the message waiting to be sent, cuts a line off, else ends the session. Alt+M: mute or unmute.
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || state.phase === "off") return;
    if (isMuteKey(e)) {
      e.preventDefault();
      return toggleMute();
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    dispatch({ type: "cancel", now: now() });
  });

  /** Standard: a spoken yes or no answers the approval the chat waits on. True when it did. */
  function answerByVoice(text: string): boolean {
    const chat = chatNow();
    const id = approvals.of(chat);
    const answer = id ? spokenApprovalAnswer(text) : null;
    if (!chat || !id || !answer) return false;
    void deps.answerApproval(chat, id, answer);
    return true;
  }

  /**
   * Standard, while the agent works and the floor is free (not the user talking, nothing waiting to be sent or said):
   * "Still …" after a long silence (Realtime's engine paces its own). Milestones are not kept in the chat.
   */
  function stillWorking(t: number): void {
    if (!engine || isRealtimeEngine(engine.id) || !working || state.phase !== "working" || state.userSpeaking || state.queued) return;
    const line = narration.tick(t);
    if (!line) return;
    passing.add(line);
    dispatch({ type: "say", text: line, now: t });
  }

  /** Tells the engine (and, Standard, the narration) about an event of the session's chat. */
  function narrate(ev: StampedAgentEvent): void {
    const t = now();
    approvals.push(ev);
    engine?.agentEvent(ev as AgentEvent, t);
    if (!engine || isRealtimeEngine(engine.id)) return;
    const said = narration.push(ev, t);
    if (!said) return;
    if (ev.type === "tool_call") passing.add(said);
    dispatch({ type: "say", text: said, now: t });
  }

  const control: HandsFree = {
    get active() {
      return on();
    },
    get phase() {
      return state.phase;
    },
    get muted() {
      return on() && muted();
    },
    toggleMute,
    get tab() {
      return on() ? tab : null;
    },
    toggle(reason) {
      // This panel's own session ends (wherever it listens); another tab's moves here; else one starts here.
      if (!on() && remoteSession(remote, deps.panel) !== "none") return useVoiceHere();
      if (voiceKeyAction(on()) === "start") void start();
      else if (starting) finish(null);
      else stop(reason);
    },
    onEvent(ev) {
      if (state.phase !== "off") for (const e of follower.push(ev)) narrate(e);
    },
    setRunning(ids) {
      running = new Set(ids);
      syncChat();
    },
    refresh() {
      syncChat();
      lookChanged();
      render();
    },
    tabClosed(closed) {
      if (on() && endsWithTab(tab, closed)) finish(TAB_CLOSED_NOTE, "tab closed");
    },
    tabUpdated(tabId) {
      if (on() && tabId === tab) learnHomePage(tabId);
      else if (shownRemote()?.tabId === tabId) learnRemotePage(tabId);
    },
    setSession(view) {
      const before = remote;
      remote = view;
      if (on()) {
        lookChanged();
        return render();
      }
      if (!view) {
        // The session ended where it ran: Use voice here starts it in this panel now.
        const moving = takeOver;
        takeOver = null;
        if (moving) void start(moving.engine, moving.muted, true);
        return render();
      }
      if (remoteSession(view, deps.panel) === "notice") {
        if (view.tabId !== before?.tabId) remotePage = null;
        learnRemotePage(view.tabId);
      }
      render();
    },
    stopHere() {
      if (on()) stop("remote");
    },
    chat: chatNow,
  };
  deps.voice.attachHandsFree(control);
  return control;
}
