/** Tiny DOM helpers for the extension's pages (side panel, options, mic permission); no framework. */
import { errorMessage } from "@noa/shared";

type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;
type Child = Node | string | null | undefined | false;

/** h("div.row.muted", { title: "x", onclick: fn }, "text", child) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tagAndClasses: K | `${K}.${string}`,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = tagAndClasses.split(".") as [K, ...string[]];
  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = [el.className, String(v)].filter(Boolean).join(" ");
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

/** The first element under `root` matching `selector`; throws when the page lacks it (like $). */
export function find<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`${selector} missing`);
  return el;
}

/** How long an "ok" message stays before it clears itself. */
export const OK_MESSAGE_MS = 4000;

let flashes = 0;

/**
 * Show a short message in a status element. An "ok" message clears itself
 * after `ms` (unless `keep`); other tones stay until the next message.
 */
export function flash(el: HTMLElement, text: string, tone: "ok" | "bad" | "" = "", opts: { ms?: number; keep?: boolean } = {}): void {
  el.textContent = text;
  el.dataset.tone = tone;
  // Every message gets its own stamp, so an earlier message's timer never clears a later one.
  const stamp = String(++flashes);
  el.dataset.stamp = stamp;
  if (tone !== "ok" || !text || opts.keep) return;
  setTimeout(() => {
    if (el.dataset.stamp === stamp) el.textContent = "";
  }, opts.ms ?? OK_MESSAGE_MS);
}

/** Where a failed action says why: a message element (shown as a "bad" message) or a function. */
export type ErrorSink = HTMLElement | ((message: string) => void);

export function showError(sink: ErrorSink, err: unknown): void {
  const message = errorMessage(err);
  if (typeof sink === "function") sink(message);
  else flash(sink, message, "bad");
}

/** Run an async button action with the button disabled meanwhile; a failure is shown in `errors`. */
export async function busy(button: HTMLButtonElement, fn: () => Promise<unknown>, errors: ErrorSink): Promise<void> {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    showError(errors, err);
  } finally {
    button.disabled = false;
  }
}

/** Plays a CSS animation class again from the start (removing and re-adding it alone would not). */
export function restartAnimation(el: HTMLElement, className: string): void {
  el.classList.remove(className);
  void el.offsetWidth; // a reflow in between restarts it
  el.classList.add(className);
}

/** Open <details> menus matching `selector` close when a click lands outside them. */
export function closeMenusOnOutsideClick(selector: string): void {
  document.addEventListener("click", (e) => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>("details[open]")) {
      if (menu.matches(selector) && !menu.contains(e.target as Node)) menu.open = false;
    }
  });
}

/**
 * Copies `text` to the clipboard. Without the clipboard API (older Chrome, no permission) it selects a hidden
 * textarea inside `host` (e.g. a dialog, when that is the only live part of the page) and copies that.
 */
export async function copyText(text: string, host: HTMLElement = document.body): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { "aria-hidden": "true", tabindex: "-1", style: "position:fixed;opacity:0;pointer-events:none" });
    area.value = text;
    host.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
