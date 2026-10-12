/**
 * The voice strip: one slim line in the live colour at the top of the side
 * panel, under the tabs, while a hands-free session is on (hands-free.ts
 * shows it; voice/voice-bar-view.ts decides what it says). It only tells:
 * "Voice on · <the session's tab>" and the state word, a small meter of the
 * microphone's level, and the time on; its tooltip names the engine and what
 * to do. It stays on every tab (the panel does). It has no controls (they
 * are in the composer row, voice-input.ts), except on another tab: Go to tab
 * and Use voice here, and in a panel that runs no session, Turn off.
 *
 * The strip is a labelled region; a polite live line inside it says the state
 * when it changes (the ticking time and "Hearing you" are left out of it).
 * The meter follows --level, which voice-input.ts sets on the page.
 */
import { h } from "../ui/dom.js";
import type { VoiceBarView } from "../voice/voice-bar-view.js";

export interface VoiceBarActions {
  goToTab(): void;
  useThisTab(): void;
  /** Ends the session another panel runs. */
  turnOff(): void;
}

export interface VoiceBar {
  /** Shows the strip as `view` says (null: no session, hidden). */
  show(view: VoiceBarView | null): void;
}

/** The meter's bars: how much of the level each shows. */
const METER_BARS = [0.6, 1, 0.7];

export function initVoiceBar(bar: HTMLElement, actions: VoiceBarActions): VoiceBar {
  const dot = h("span.vb-dot", { "aria-hidden": "true" });
  const label = h("b.vb-label");
  const status = h("span.vb-status");
  const go = h("button.link.vb-go", { type: "button", title: "Show the tab voice listens in" }, "Go to tab");
  const use = h("button.link.vb-use", { type: "button", title: "Talk to this tab's chat instead" }, "Use voice here");
  const off = h("button.link.vb-off", { type: "button", title: "Turn voice off in that tab" }, "Turn off");
  const links = h("span.vb-links", null, go, use, off);
  const meter = h("span.vb-meter", { "aria-hidden": "true" }, ...METER_BARS.map((k) => h("i", { style: `--k: ${k}` })));
  const time = h("span.vb-time");
  const live = h("span.sr-only.vb-live", { role: "status", "aria-live": "polite" });
  bar.append(dot, h("span.vb-text", null, label, status), links, meter, time, live);

  go.addEventListener("click", () => actions.goToTab());
  use.addEventListener("click", () => actions.useThisTab());
  off.addEventListener("click", () => actions.turnOff());

  return {
    show(view) {
      bar.hidden = !view;
      if (!view) {
        live.textContent = "";
        return;
      }
      bar.dataset.state = view.state;
      if (view.muted) bar.dataset.muted = "true";
      else delete bar.dataset.muted;
      bar.title = view.hint;
      label.textContent = view.label;
      status.textContent = view.status;
      status.hidden = !view.status;
      links.hidden = !view.links;
      off.hidden = !view.links?.turnOff;
      meter.hidden = !view.meter;
      time.textContent = view.time ?? "";
      time.hidden = view.time === null;
      // Only a change is read out.
      if (live.textContent !== view.announce) live.textContent = view.announce;
    },
  };
}
