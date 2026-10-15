/**
 * "Before you start": the screen that covers the side panel the first time it opens (and every time after, until
 * the user presses I understand): Noa can make mistakes, it sees the pages it works on, and a page can try to
 * trick it, with Learn more (the website's /safety page). Pressing the button saves disclaimerAccepted, so the
 * screen never shows again on this install. While it shows, the rest of the panel is inert.
 */
import { SAFETY_URL, type ExtensionSettings } from "@noa/shared";
import { $, h } from "../ui/dom.js";

export const BEFORE_START_TITLE = "Before you start";
export const BEFORE_START_BUTTON = "I understand";
export const BEFORE_START_LEARN_MORE = "Learn more";

export interface BeforeStartPoint {
  /** Which icon goes with it (the HTML has one of each). */
  icon: "mistakes" | "sees" | "tricks";
  text: string;
  /** This point is the one with the Learn more link, and the one drawn as a warning. */
  warn?: boolean;
}

/** The three points, in the order they show. The first is the one the whole screen is for. */
export const BEFORE_START_POINTS: readonly BeforeStartPoint[] = [
  {
    icon: "mistakes",
    text: "Noa can make mistakes. It acts in your browser as you, and it can misread a page or do the wrong thing: a wrong post, purchase or deletion. Check anything that matters, and what it does in your accounts is your responsibility.",
  },
  {
    icon: "sees",
    text: "To work, Noa reads the pages it acts on and takes screenshots of them, and sends them to the AI you chose. Keep it away from sites with things you would not share, like health records or private messages.",
  },
  {
    icon: "tricks",
    warn: true,
    text: "A web page, an email or a document can contain text written to look like instructions to the AI, so that it does something you never asked. Noa is told to ignore such text and asks before posting, sending or paying, but no protection is perfect.",
  },
];

/** Whether the screen covers the panel: until the user has said they understand. */
export function beforeStartShown(settings: Pick<ExtensionSettings, "disclaimerAccepted">): boolean {
  return !settings.disclaimerAccepted;
}

export function initBeforeStart(save: (patch: Partial<ExtensionSettings>) => Promise<unknown>): { render(settings: Pick<ExtensionSettings, "disclaimerAccepted">): void } {
  const el = $("before-start");
  const list = $("before-start-points");
  const ok = $<HTMLButtonElement>("before-start-ok");
  const rest = [...document.body.children].filter((c) => c !== el) as HTMLElement[];
  $("before-start-title").textContent = BEFORE_START_TITLE;
  ok.textContent = BEFORE_START_BUTTON;
  for (const point of BEFORE_START_POINTS) {
    const icon = $<HTMLTemplateElement>(`before-start-icon-${point.icon}`).content.cloneNode(true);
    const text = h("p.before-start-text", null, point.text);
    if (point.warn) text.append(" ", h("a", { href: SAFETY_URL, target: "_blank", rel: "noopener noreferrer" }, BEFORE_START_LEARN_MORE));
    list.append(h("li.before-start-point", point.warn ? { "data-warn": "" } : null, icon, text));
  }
  let shown: boolean | null = null;
  const show = (on: boolean) => {
    if (on === shown) return;
    shown = on;
    el.hidden = !on;
    for (const c of rest) c.inert = on;
    if (on) ok.focus();
  };
  ok.addEventListener("click", () => {
    ok.disabled = true;
    void save({ disclaimerAccepted: true }).finally(() => {
      ok.disabled = false;
      show(false);
    });
  });
  return {
    render(settings) {
      show(beforeStartShown(settings));
    },
  };
}
