/**
 * The notice line directly above the input box: voice tips, fallbacks,
 * hints, progress ("Sending…") and error cards, one at a time (see
 * notice-queue.ts for which one). It is part of the composer's layout, so a
 * notice pushes the chat up and never covers the box. Each can be dismissed
 * (×); info hides by itself after a few seconds, not while the pointer or the
 * focus is on it.
 */
import { h } from "../ui/dom.js";
import { autoHideMs, NoticeQueue, type NoticeLevel } from "./notice-queue.js";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  /** Who shows it ("voice", "composer", ...): a new one with the same key replaces it. */
  key: string;
  level: NoticeLevel;
  /** One short line. */
  text?: string;
  /** Or a whole card (an error with its fix buttons, error-view.ts). */
  body?: HTMLElement;
  /** Buttons after the text, the first the main one (a click also dismisses the notice). */
  actions?: readonly NoticeAction[];
  /** Stays until cleared (progress while a request is out). */
  sticky?: boolean;
}

export interface Notices {
  show(notice: Notice): void;
  /** Takes away `key`'s notice (shown or waiting). */
  clear(key: string): void;
  /** The notice shown, if any. */
  current(): Notice | null;
}

/** Draws the notices into `el` (the composer's notice slot). */
export function initNotices(el: HTMLElement): Notices {
  const queue = new NoticeQueue<Notice>();
  let drawn: Notice | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The pointer or the focus is on the notice: it does not hide by itself meanwhile. */
  let held = false;

  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const startTimer = () => {
    stopTimer();
    const ms = drawn && !held ? autoHideMs(drawn) : null;
    if (drawn && ms !== null) {
      const n = drawn;
      timer = setTimeout(() => dismiss(n), ms);
    }
  };

  function dismiss(n: Notice): void {
    // Only this notice: one that replaced it under the same key since stays.
    if (queue.current !== n) return;
    queue.clear(n.key);
    render();
  }

  function render(): void {
    const n = queue.current;
    if (n === drawn) return;
    drawn = n;
    el.replaceChildren();
    el.hidden = !n;
    if (!n) {
      held = false;
      return stopTimer();
    }
    el.dataset.level = n.level;
    el.dataset.key = n.key;
    el.append(n.body ?? h("span.notice-text", null, n.text ?? ""));
    for (const { label, run } of n.actions ?? []) {
      el.append(h("button.link.notice-action", { type: "button", onclick: () => (dismiss(n), run()) }, label));
    }
    el.append(h("button.notice-close", { type: "button", "aria-label": "Dismiss", title: "Dismiss", onclick: () => dismiss(n) }, "×"));
    startTimer();
  }

  const hold = () => {
    held = true;
    stopTimer();
  };
  const release = () => {
    held = false;
    startTimer();
  };
  el.addEventListener("pointerenter", hold);
  el.addEventListener("pointerleave", release);
  el.addEventListener("focusin", hold);
  el.addEventListener("focusout", (e) => {
    if (!el.contains(e.relatedTarget as Node | null)) release();
  });

  return {
    show(n) {
      queue.put(n);
      render();
    },
    clear(key) {
      queue.clear(key);
      render();
    },
    current: () => queue.current,
  };
}
