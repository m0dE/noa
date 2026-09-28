/**
 * Voice in the side panel: the voice controls in the composer row, left of
 * Send, the orb in the middle of the panel, voice's notices, and the
 * microphone permission.
 *
 * - The Voice button (a small sound wave and the word) and the voice shortcut do the
 *   same: start a hands-free session (hands-free.ts) with the engine picked in
 *   Settings, or end the one that is on, wherever it listens. The session
 *   shows itself on the button (still "Voice", pressed: filled in the live
 *   colour, a ring following the voice; its tooltip says it ends voice mode),
 *   the orb, and the box (a glow and "Listening… just talk" while it listens
 *   for this tab; muted, no glow and a placeholder that says so); the status
 *   strip at the top is hands-free.ts's.
 * - While a session runs here: Mute (a mic icon, slashed while muted; a
 *   toggle, Alt+M) left of Voice. A line being said is cut off by Esc or by
 *   talking. The task's own Stop is the composer's (a square), apart from these.
 * - Plans without voice (and signed out) see a lock that explains, with a
 *   way to pick a plan. The microphone is asked for on mic-permission.html,
 *   since a side panel cannot show Chrome's prompt.
 */
import { errorMessage, plansWithText } from "@noa/shared";
import type { MicPermission } from "../voice/mic-access.js";
import { VoiceError } from "../voice/transcribe.js";
import type { ComposerView } from "./composer.js";
import { FIXES } from "./error-help.js";
import type { NoticeLevel } from "./notice-queue.js";
import type { NoticeAction } from "./notices.js";
import { h, restartAnimation } from "../ui/dom.js";
import { MUTE_KEY } from "../voice/voice-bar-view.js";

/** What the mic button shows ("handsfree": a hands-free session is on). */
export type VoiceUiState = "locked" | "idle" | "handsfree";

/** From the plan catalog, e.g. "Voice needs the Plus or Pro plan". */
export const LOCKED_TEXT = `Voice needs ${plansWithText("voice")}`;

/** The Voice button's tooltip and accessible name: it starts voice mode, or (on) ends it. */
export function micButtonTitle(state: VoiceUiState, shortcut: string | null): string {
  if (state === "locked") return LOCKED_TEXT;
  const base = state === "handsfree" ? "End voice mode" : "Voice mode";
  return shortcut ? `${base} · ${shortcut}` : base;
}

/** Voice's notices (above the box, notices.ts) go under this key: a new one replaces the last. */
export const VOICE_NOTICE = "voice";

/** A voice notice: one short line, with optional buttons (the first the main one). */
export interface VoiceTip {
  text: string;
  level: NoticeLevel;
  actions?: readonly NoticeAction[];
}

/** The tip for a failure: plan and credit come with the dashboard's Billing page, which fixes them. */
export function errorTip(err: unknown, openBilling: () => void): VoiceTip {
  if (err instanceof VoiceError) {
    if (err.kind === "plan") return { text: err.message, level: "error", actions: [{ label: FIXES.plans.label, run: openBilling }] };
    if (err.kind === "credit") return { text: err.message, level: "error", actions: [{ label: "Top up", run: openBilling }] };
    return { text: err.message, level: "error" };
  }
  return { text: `Voice stopped: ${errorMessage(err)}`, level: "error" };
}

export interface VoiceInputDeps {
  composer: Pick<ComposerView, "actionSlot" | "setDictating" | "notices">;
  mic: {
    permission(): Promise<MicPermission>;
    openPermissionPage(): Promise<void>;
    /** Calls back when the permission changes; returns the unsubscribe. */
    watch(onChange: (state: MicPermission) => void): Promise<() => void>;
  };
  /** The dashboard's Billing page (pick a plan, top up). */
  openBilling(): void;
  /** Where the orb goes (the panel's body). */
  host: HTMLElement;
}

/** How a hands-free session shows on the mic button and the orb (null: none is on). */
export interface HandsFreeLook {
  /** The orb in the middle of the panel (the pill carries the session once something was sent). */
  orb: boolean;
  /** Under the orb. */
  caption: string;
  /** "sending" / "speaking" change the orb's rhythm. */
  phase: string;
  /** It listens for another tab than the one shown (the box here is not its). */
  elsewhere: boolean;
  /** The microphone is muted: the box does not say it listens, the mic stops pulsing. */
  muted: boolean;
  /** The Mute toggle (null: not offered, e.g. while starting). */
  mute: { pressed: boolean; label: string } | null;
}

/** What voice input needs of the hands-free session (hands-free.ts). */
export interface HandsFreeControl {
  readonly active: boolean;
  /** The voice shortcut or the mic: starts a session, or ends the one that is on (wherever it listens). */
  toggle(reason: "shortcut" | "button"): void;
  /** Mute or unmute the microphone. */
  toggleMute(): void;
}

export interface VoiceInput {
  /** The account may use voice (signed in, a plan with voice in good standing). */
  setAllowed(allowed: boolean): void;
  /** The voice shortcut's label for the tooltip (null: none assigned). */
  setShortcut(label: string | null): void;
  /** The voice shortcut's label (null: none assigned). */
  readonly shortcutLabel: string | null;
  /** The voice shortcut: hands-free on or off, as the mic button; locked, it points at the button and says why. */
  shortcut(): void;
  readonly state: VoiceUiState;
  /** Wires the hands-free session in (the shortcut and the button then start and end it). */
  attachHandsFree(control: HandsFreeControl): void;
  /** The hands-free session's look on the button and the orb. */
  showHandsFree(look: HandsFreeLook | null): void;
  /** The microphone level (the hands-free session's), 0..1. */
  setLevel(level: number): void;
  /** Shows (or clears) voice's notice above the box. */
  showTip(tip: VoiceTip | null): void;
  /** True when the microphone may be used; otherwise asks for it (the permission page) and says so. */
  ensureMic(): Promise<boolean>;
}

const svg = (size: number, body: string) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
/** Mute: the microphone while it is live, slashed while muted. */
const MIC = '<rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75"/>';
const MIC_LIVE_ICON = svg(15, MIC);
const MIC_OFF_ICON = svg(15, `${MIC}<path d="m2.25 2.25 11.5 11.5"/>`);

/** The Voice button: a small sound wave before the word (a lock over it while the plan has no voice). */
const VOICE_ICON =
  '<svg class="wave" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.75v2.5M5 4.5v7M8 2v12M11 4.5v7M14 6.75v2.5"/></svg>' +
  '<svg class="lock" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="currentColor"><path d="M5 7V5.5a3 3 0 0 1 6 0V7h.5A1.5 1.5 0 0 1 13 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5.5a1.5 1.5 0 0 0-3 0V7Z"/></svg>';

export function initVoiceInput(deps: VoiceInputDeps): VoiceInput {
  const { composer } = deps;
  let allowed = false;
  let shortcutLabel: string | null = null;
  let unwatchMic: (() => void) | null = null;
  let handsFree: HandsFreeControl | null = null;
  let look: HandsFreeLook | null = null;

  const button = h("button.voice-mic", { type: "button" });
  button.innerHTML = VOICE_ICON;
  button.append(h("span.voice-word", null, "Voice"));
  // While a session runs here: Mute, left of Voice (an icon; its name is in aria-label and the tooltip).
  const mute = h("button.now-tool.voice-mute", { type: "button", hidden: true, "aria-pressed": "false", "aria-keyshortcuts": MUTE_KEY.label });
  composer.actionSlot.append(mute, button);

  const caption = h("p.voice-caption");
  // A veil over the panel (the input stays above it) with the orb and its caption in the middle.
  const orb = h(
    "div.voice-orb",
    { "aria-hidden": "true", hidden: true },
    h("div.voice-orb-stack", null, h("div.voice-orb-halo"), h("div.voice-orb-core"), caption),
  );
  deps.host.append(orb);

  // The level drives the orb, the button ring and the voice bar's meter (all read --level), once per frame at most.
  let level = 0;
  let frame = 0;
  const paint = () => {
    frame = 0;
    document.body.style.setProperty("--level", level.toFixed(3));
  };
  const setLevel = (l: number) => {
    level = l;
    if (!frame) frame = requestAnimationFrame(paint);
  };

  // A session on shows (and the button ends it) even if the plan changed meanwhile.
  const uiState = (): VoiceUiState => (look ? "handsfree" : allowed ? "idle" : "locked");

  function render(): void {
    const state = uiState();
    const title = micButtonTitle(state, shortcutLabel);
    button.dataset.state = state;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", String(!!look));
    if (look?.muted) button.dataset.muted = "true";
    else delete button.dataset.muted;
    // Mute belongs to a session this panel runs, on its own tab or another.
    const m = look?.mute ?? null;
    mute.hidden = !m;
    if (m) {
      mute.setAttribute("aria-pressed", String(m.pressed));
      mute.title = m.label;
      mute.setAttribute("aria-label", m.label);
      const icon = m.pressed ? "off" : "live";
      if (mute.dataset.icon !== icon) {
        mute.dataset.icon = icon;
        mute.innerHTML = m.pressed ? MIC_OFF_ICON : MIC_LIVE_ICON;
      }
    }
    orb.hidden = !look?.orb;
    orb.dataset.state = look?.phase ?? "idle";
    if (look?.muted) orb.dataset.muted = "true";
    else delete orb.dataset.muted;
    caption.textContent = look?.caption ?? "";
    // The box shows it listens only on the session's own tab (elsewhere, what is said goes to that tab's chat).
    const box = !look || look.elsewhere ? "off" : look.muted ? "muted" : "listening";
    composer.setDictating(box);
    document.body.classList.toggle("voice-live", box === "listening");
    if (!look) setLevel(0);
  }

  function showTip(t: VoiceTip | null): void {
    if (t) composer.notices.show({ key: VOICE_NOTICE, ...t });
    else composer.notices.clear(VOICE_NOTICE);
  }

  /** Locked: points at the button and says why, with a way to pick a plan. */
  function explainLock(): void {
    showTip({ text: LOCKED_TEXT, level: "info", actions: [{ label: FIXES.plans.label, run: () => deps.openBilling() }] });
    restartAnimation(button, "nudge");
    button.focus();
  }

  /** The mic button and the voice shortcut: hands-free on or off. */
  function toggle(reason: "shortcut" | "button"): void {
    if (!allowed && !handsFree?.active) return explainLock();
    handsFree?.toggle(reason);
  }

  /** Opens the permission page and waits there for the grant. */
  async function askForMic(): Promise<void> {
    await deps.mic.openPermissionPage();
    showTip({ text: "Allow the microphone in the new tab, then press the mic again.", level: "info" });
    unwatchMic?.();
    unwatchMic = await deps.mic.watch((state) => {
      if (state !== "granted") return;
      unwatchMic?.();
      unwatchMic = null;
      showTip({ text: "Microphone allowed. Press the mic to talk.", level: "info" });
    });
  }

  button.addEventListener("pointerdown", (e) => {
    if (e.button === 0) e.preventDefault(); // keep the cursor in the box
  });
  button.addEventListener("click", () => toggle("button"));
  mute.addEventListener("pointerdown", (e) => {
    if (e.button === 0) e.preventDefault(); // keep the cursor in the box
  });
  mute.addEventListener("click", () => handsFree?.toggleMute());

  render();
  return {
    setAllowed(next) {
      allowed = next;
      render();
    },
    setShortcut(label) {
      shortcutLabel = label;
      render();
    },
    get shortcutLabel() {
      return shortcutLabel;
    },
    shortcut: () => toggle("shortcut"),
    get state() {
      return uiState();
    },
    attachHandsFree(control) {
      handsFree = control;
    },
    showHandsFree(next) {
      look = next;
      render();
    },
    setLevel,
    showTip,
    async ensureMic() {
      if ((await deps.mic.permission()) === "granted") return true;
      await askForMic();
      return false;
    },
  };
}
