/**
 * When a page that is loading can be used: after DOMContentLoaded, once what
 * it shows has stopped changing for a moment. Heavy web apps (Gmail and the
 * like) keep loading resources for seconds after they can be read and
 * clicked, so the load event is not waited for; a page that is complete only
 * needs one unchanged reading. Both drivers use it after a navigation, each
 * reading the page its own way (the debugger, or chrome.scripting).
 */
import type { Sleep } from "@noa/shared";
import { NAV_TIMEOUT_MS, POLL_MS } from "./driver-common.js";

/** One reading of a page: which document it is, how far it loaded, and how much it shows. */
export interface LoadProbe {
  /** performance.timeOrigin: a new document has a new one. */
  doc: number;
  state: DocumentReadyState;
  /** Links, buttons and fields. */
  controls: number;
  /** Characters of text. */
  text: number;
  /** Another extension's frame is on the page (Chrome then refuses the debugger for the tab). */
  foreignFrame: boolean;
}

/** The reading, in the page. Self-contained: serialized by the debugger and chrome.scripting. */
export function loadProbeInPage(): LoadProbe {
  const controls = document.querySelectorAll("a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[contenteditable=true]").length;
  const foreignFrame = document.querySelector('iframe[src^="chrome-extension://"]') !== null;
  return { doc: performance.timeOrigin, state: document.readyState, controls, text: document.body?.textContent?.length ?? 0, foreignFrame };
}

/**
 * The id of another extension whose frame is in the page (the first found), or null. Chrome refuses
 * the debugger for the tab because of it. Self-contained: run with chrome.scripting.
 */
export function foreignExtensionInPage(): string | null {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="chrome-extension://"]');
  return (frame && /^chrome-extension:\/\/([a-p]{32})\//.exec(frame.src)?.[1]) || null;
}

/** Unchanged readings in a row that make a page usable: complete, or only past DOMContentLoaded (still loading resources). */
export const STABLE_READINGS = { complete: 1, interactive: 3 } as const;

/**
 * Waits until the page is usable (see the file comment). read: one reading,
 * or null when the page cannot be read right now (it is navigating); an
 * error it throws ends the wait. leaving: the document being navigated away
 * from (its readings are not the new page). Resolves with the last reading
 * once usable, or null after timeoutMs.
 */
export async function waitForUsablePage(
  read: () => Promise<LoadProbe | null>,
  opts: { sleep: Sleep; leaving?: number | null; timeoutMs?: number },
): Promise<LoadProbe | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? NAV_TIMEOUT_MS);
  let last: string | null = null;
  let same = 0;
  for (;;) {
    const p = await read();
    if (p && p.doc !== opts.leaving && p.state !== "loading") {
      // Text in 200-character steps: a clock or a counter ticking does not keep the page "changing".
      const key = `${p.controls}|${Math.round(p.text / 200)}`;
      same = key === last ? same + 1 : 0;
      last = key;
      const needed = p.state === "complete" ? STABLE_READINGS.complete : STABLE_READINGS.interactive;
      if (same >= needed && (p.controls > 0 || p.state === "complete")) return p;
    } else {
      last = null;
      same = 0;
    }
    if (Date.now() >= deadline) return null;
    await opts.sleep(POLL_MS);
  }
}

/**
 * The document a navigation from `from` to `to` leaves, or null when it
 * stays in the same document (only the #fragment changes), so its readings
 * count.
 */
export function leavingDocument(from: string | undefined, to: string, doc: number | null | undefined): number | null {
  if (doc == null) return null;
  const strip = (u: string) => u.replace(/#.*$/, "");
  return from && to.includes("#") && strip(from) === strip(to) ? null : doc;
}

/**
 * read_page (and act's reads) on a tab that is still loading or still drawing its first screen: a snapshot with
 * at most this many elements and characters of text is a loading screen, not a page to reason about (measured:
 * X tabs read right after open_tabs gave 2 elements and 8 characters, X's home right after navigate 0 elements).
 */
export const NEARLY_EMPTY = { elements: 2, textChars: 50 } as const;
/** How long a read waits for a nearly empty tab whose document is still loading (then it reads it as it is). */
export const READ_LOAD_WAIT_MS = 10_000;
/** How long a read waits for a loaded document that is still nearly empty (a web app drawing its first screen). */
export const EMPTY_PAGE_WAIT_MS = 3_000;
/** How often a loaded but nearly empty page is read again. */
const EMPTY_PAGE_POLL_MS = 250;

/** The part of a snapshot the wait looks at. */
export interface ReadSnapshot {
  url: string;
  text: string;
  elements: readonly unknown[];
}

/**
 * A web page that shows next to nothing yet. `heading`: the address the tab is on or loading (Chrome's
 * pendingUrl, else url): a tab opened a moment ago still shows its first, blank document.
 */
export function looksUnloaded(snap: ReadSnapshot | undefined, heading?: string): boolean {
  if (!snap || typeof snap.url !== "string") return false;
  const web = /^https?:/i.test(snap.url) || /^https?:/i.test(heading ?? "");
  return web && (snap.elements?.length ?? 0) <= NEARLY_EMPTY.elements && (snap.text ?? "").trim().length <= NEARLY_EMPTY.textChars;
}

/** The tab as Chrome reports it: where it is heading (pendingUrl, else url) and whether it is loading. */
export interface TabLoad {
  heading?: string;
  loading: boolean;
}

/** The note a read carries when the page still looked empty after the wait. */
export function stillLoadingNote(snap: ReadSnapshot, waitedMs: number): string {
  const seconds = Math.round(waitedMs / 100) / 10;
  return `Page still loading: after ${seconds} s it still shows next to nothing (${snap.elements.length} elements, ${snap.text.trim().length} characters of text). Read it again in a moment, or use wait_for, before concluding anything from it.`;
}

/**
 * Reads the page; when it shows next to nothing yet (looksUnloaded), waits for it: while its document loads, with
 * waitForUsablePage (at most READ_LOAD_WAIT_MS in all), and once loaded, EMPTY_PAGE_WAIT_MS for it to draw. Resolves
 * with the first read that shows something, or the last one with `stillLoading` (how long it waited) when it gave up.
 */
export async function readWhenDrawn<T extends ReadSnapshot>(
  read: () => Promise<T>,
  probe: () => Promise<LoadProbe | null>,
  opts: { sleep: Sleep; tab?: () => Promise<TabLoad | null> },
): Promise<{ snap: T; stillLoading?: number }> {
  const started = Date.now();
  const tab = () => opts.tab?.().catch(() => null) ?? Promise.resolve(null);
  let snap = await read();
  for (let t = await tab(); looksUnloaded(snap, t?.heading); t = await tab()) {
    const waited = Date.now() - started;
    const p = await probe().catch(() => null);
    const loading = !p || p.state !== "complete" || t?.loading === true;
    if (waited >= READ_LOAD_WAIT_MS || (!loading && waited >= EMPTY_PAGE_WAIT_MS)) return { snap, stillLoading: waited };
    if (loading) await waitForUsablePage(probe, { sleep: opts.sleep, timeoutMs: READ_LOAD_WAIT_MS - waited });
    else await opts.sleep(EMPTY_PAGE_POLL_MS);
    snap = await read();
  }
  return { snap };
}
