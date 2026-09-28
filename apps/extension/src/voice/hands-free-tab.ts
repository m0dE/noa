/**
 * The browser tab a hands-free session belongs to. The side panel is one per
 * window, on screen on every tab, and shows the active tab's job. A session
 * runs in the panel it started in and stays with the tab it started in: what
 * is said goes to that tab's chat and its answers are narrated from there,
 * whichever tab the user looks at.
 *
 * One session at a time, and the background knows it (voice-session.ts: its
 * tab, the panel it runs in, and the tab the user looks at). The voice strip
 * always names the session's tab ("Voice on · Inbox"). While the user looks
 * at another tab, it offers Go to tab (that tab and its window come to the
 * front) and Use voice here, and what is said carries a note naming both
 * tabs, so the agent and the narrator do not pretend to see the tab in front
 * of the user; "use this tab" (said, or the narrator's use_this_tab) moves it
 * there. Another window's panel shows the same strip with Turn off too, and
 * nothing live; its Use voice here moves the session there (it ends where it
 * ran, then starts in that panel, same engine, one microphone). The voice key
 * and the mic end a session this panel runs, wherever it listens; in a panel
 * that shows another panel's session they move it here. Closing its tab ends
 * it. Pure.
 */
import { isRestrictedUrl } from "../restricted.js";
import type { VoiceSessionView } from "../voice-session.js";

/** What the voice shortcut (or the mic) does to hands-free voice: start one, or end the one that is on. */
export type VoiceKeyAction = "start" | "stop";

/** `on`: a session is on in this panel (its own state; which tab it listens in does not matter). */
export function voiceKeyAction(on: boolean): VoiceKeyAction {
  return on ? "stop" : "start";
}

/**
 * The tabs a session is at home in: the tab it started in (or was moved to), and every tab its chat lived in
 * during the session (a run started from an extension page works in a tab of its own). The voice bar is the plain
 * one there, and names where it listens elsewhere.
 */
export type SessionTabs = ReadonlySet<number>;

/** The session belongs to tabs other than the one shown (tabs not known: it is here). */
export function listensElsewhere(sessionTabs: SessionTabs, shown: number | null): boolean {
  return sessionTabs.size > 0 && shown !== null && !sessionTabs.has(shown);
}

/**
 * What a panel that runs no session makes of the one the background reports: "notice" when another panel runs it
 * (the strip names its tab, with Go to tab, Use voice here and Turn off), else "none" (no session, or this panel's
 * own report of one it no longer runs: `panel` is this page's id).
 */
export function remoteSession(view: VoiceSessionView | null, panel: string): "notice" | "none" {
  return view && view.panel !== panel ? "notice" : "none";
}

/** A closed tab ends the session when it was the one the session started in (or was moved to). */
export function endsWithTab(sessionTab: number | null, closed: number): boolean {
  return sessionTab === closed;
}

/** A tab's title in the voice bar is cut to this many characters. */
export const TAB_TITLE_CHARS = 28;

/** What the voice strip says first. */
export const VOICE_ON = "Voice on";

/**
 * The voice strip's words: where the session runs, by its tab's title, else its site ("Voice on · Inbox – Gmail",
 * "Voice on · mail.google.com"). Not known (yet): "Voice on", or, on another tab, "Voice on · another tab".
 */
export function voiceOnLabel(page: TabPage | null, elsewhere = false): string {
  const title = (page?.title ?? "").replace(/\s+/g, " ").trim();
  const name = title ? (title.length > TAB_TITLE_CHARS ? `${title.slice(0, TAB_TITLE_CHARS - 1).trimEnd()}…` : title) : hostOf(page?.url ?? null);
  const where = name || (elsewhere ? "another tab" : "");
  return where ? `${VOICE_ON} · ${where}` : VOICE_ON;
}

export const MOVED_NOTE = "Hands-free moved to this tab.";
export const TAB_CLOSED_NOTE = "Hands-free stopped: its tab was closed.";

/** A tab as the notes name it. */
export interface TabPage {
  title: string | null;
  url: string | null;
}

/** An address's host ("" when there is none, or it is no URL). */
function hostOf(url: string | null): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

/** "Recipes (example.com)": the title and the site, as far as they are known. */
function pageName(page: TabPage | null, unknown: string): string {
  const title = (page?.title ?? "").replace(/\s+/g, " ").trim();
  const host = hostOf(page?.url ?? null);
  if (title && host) return `${title} (${host})`;
  return title || host || unknown;
}

/**
 * The note for the agent and the narrator while the user looks at another tab than the session's: neither sees that
 * tab. It goes with every message sent meanwhile, and to the narrator when the user turns to another tab.
 */
export function lookingElsewhereNote(looking: TabPage | null, home: TabPage | null): string {
  return `The user is looking at another tab: ${pageName(looking, "another tab")}. You work in ${pageName(home, "the tab where voice started")}.`;
}

/** The note for the narrator when the user looks at the session's tab again. */
export function lookingHomeNote(home: TabPage | null): string {
  return `The user is looking at ${pageName(home, "the tab you work in")} again, the tab you work in.`;
}

/** Said to move hands-free to the tab the user looks at: "use this tab", "switch here", "use voice here". */
export function spokenUseThisTab(text: string): boolean {
  const said = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  return /^(?:(?:ok|okay|please)\s+)?(?:use|switch to|move to|go to|work in)\s+(?:this|the current)\s+tab(?:\s+please)?$|^(?:(?:ok|okay|please)\s+)?(?:switch|move|come)\s+(?:over\s+)?here(?:\s+please)?$|^use voice here$/.test(said);
}

/**
 * What "use this tab" did: moved to the tab the user looks at, or not (the tab is not known, it is the session's
 * own already, or it is gone).
 */
export type UseTabOutcome = { moved: TabPage } | "unknown" | "here" | "gone";

/** What the narrator is told when the user asks to use the tab they look at (use_this_tab). */
export function useThisTabAnswer(outcome: UseTabOutcome): string {
  if (outcome === "unknown") return "It is not known which tab the user is looking at: ask them to press Use voice here in the side panel.";
  if (outcome === "here") return "The user is already looking at the tab you work in.";
  if (outcome === "gone") return "That tab is gone: nothing moved.";
  const restricted = isRestrictedUrl(outcome.moved.url) ? " Chrome doesn't let you see that page, so you work in other tabs from there." : "";
  return `Moved: you now work in ${pageName(outcome.moved, "the tab the user is looking at")}; what the user says goes to that tab's chat.${restricted}`;
}

/** What Standard says for "use this tab" (it has no narrator to word it). */
export function useThisTabLine(outcome: UseTabOutcome): string {
  if (outcome === "unknown") return "I can't tell which tab you're looking at. Press Use voice here in the side panel.";
  if (outcome === "here") return "I'm already working in this tab.";
  if (outcome === "gone") return "That tab is gone.";
  return `Now working in ${outcome.moved.title?.replace(/\s+/g, " ").trim() || "this tab"}.`;
}
