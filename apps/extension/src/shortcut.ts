/**
 * The keyboard shortcuts (the manifest's "commands"; the background handles
 * them in panel-command.ts): one opens the side panel with the cursor in the
 * chat, the other starts or stops voice input there. The keys themselves are
 * only in the manifest: pages show what Chrome actually assigned
 * (chrome.commands.getAll), else the manifest's suggestion.
 */

/** The manifest "commands" key of the shortcut that opens the chat. */
export const OPEN_CHAT_COMMAND = "open-chat";
/** The manifest "commands" key of the shortcut that talks (voice input). */
export const VOICE_COMMAND = "voice";
export type ShortcutCommand = typeof OPEN_CHAT_COMMAND | typeof VOICE_COMMAND;

/** Where the user sets or changes it (opened with chrome.tabs.create). */
export const SHORTCUTS_URL = "chrome://extensions/shortcuts";

const MAC_SYMBOLS: Readonly<Record<string, string>> = { command: "⌘", macctrl: "⌃", ctrl: "⌘", alt: "⌥", option: "⌥", shift: "⇧" };
/** The order macOS menus list modifiers in the way the user reads it here: ⌘⌃⌥⇧, then the key. */
const MAC_ORDER = ["⌘", "⌃", "⌥", "⇧"];
/** Keys Chrome names in words that read as their character ("Ctrl+Period" is Ctrl+.). */
const KEY_CHARS: Readonly<Record<string, string>> = { period: ".", comma: "," };

/**
 * A shortcut as the user reads it: "Ctrl+." (Chrome says "Ctrl+Period") or
 * "Ctrl+Shift+K" elsewhere, "⌘." or "⌘⇧K" on a Mac (Chrome reports Mac
 * shortcuts as symbols already, e.g. "⇧⌘K"; either way the modifiers come
 * in one order).
 */
export function shortcutLabel(shortcut: string, mac: boolean): string {
  const s = shortcut.trim();
  if (!s) return s;
  const named = (key: string) => KEY_CHARS[key.trim().toLowerCase()] ?? key.trim();
  if (!mac) return s.split("+").map(named).join("+");
  const parts = s.includes("+") ? s.split("+").map((p) => MAC_SYMBOLS[p.trim().toLowerCase()] ?? named(p)) : [...s];
  const mods = MAC_ORDER.filter((m) => parts.includes(m));
  const keys = parts.filter((p) => !MAC_ORDER.includes(p));
  return [...mods, ...keys].join("");
}

/** Is this a Mac (for the shortcut's symbols)? */
export function isMac(nav: { platform?: string; userAgentData?: { platform?: string } } = navigator as never): boolean {
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

/**
 * A shortcut's label, or null when Chrome has no key for it (e.g. another
 * extension already uses the suggested one): then the pages offer
 * SHORTCUTS_URL instead. Without chrome.commands, the manifest's suggestion.
 */
export async function readShortcut(command: ShortcutCommand = OPEN_CHAT_COMMAND): Promise<string | null> {
  const mac = isMac();
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === command);
    if (cmd) return cmd.shortcut ? shortcutLabel(cmd.shortcut, mac) : null;
  } catch {
    // No commands API here: the manifest's suggestion below.
  }
  const suggested = chrome.runtime.getManifest?.().commands?.[command]?.suggested_key;
  // suggested_key is a key for every platform, or one per platform.
  const key = typeof suggested === "string" ? suggested : ((mac ? suggested?.mac : undefined) ?? suggested?.default);
  return key ? shortcutLabel(key, mac) : null;
}

/** Opens Chrome's shortcut settings. */
export async function openShortcutSettings(): Promise<void> {
  try {
    await chrome.tabs.create({ url: SHORTCUTS_URL });
  } catch {
    // Not in this browser.
  }
}
