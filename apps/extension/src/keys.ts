/**
 * Key names and combos ("Control+Shift+Enter") to CDP Input.dispatchKeyEvent fields.
 */

export interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** CDP bitmask: Alt=1, Control=2, Meta=4, Shift=8. */
  modifiers: number;
  /** Text produced by the key, when it types something. */
  text: string | undefined;
}

const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8,
};

const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
};

/** US-layout punctuation: char -> [code, vk]. Shifted chars share the base key. */
const PUNCT: Record<string, [string, number]> = {
  ";": ["Semicolon", 186],
  ":": ["Semicolon", 186],
  "=": ["Equal", 187],
  "+": ["Equal", 187],
  ",": ["Comma", 188],
  "<": ["Comma", 188],
  "-": ["Minus", 189],
  _: ["Minus", 189],
  ".": ["Period", 190],
  ">": ["Period", 190],
  "/": ["Slash", 191],
  "?": ["Slash", 191],
  "`": ["Backquote", 192],
  "~": ["Backquote", 192],
  "[": ["BracketLeft", 219],
  "{": ["BracketLeft", 219],
  "\\": ["Backslash", 220],
  "|": ["Backslash", 220],
  "]": ["BracketRight", 221],
  "}": ["BracketRight", 221],
  "'": ["Quote", 222],
  '"': ["Quote", 222],
  " ": ["Space", 32],
};

export function parseKeyCombo(combo: string): KeySpec {
  if (!combo) throw new Error("press_key needs a key name");
  let keyPart: string;
  let modParts: string[];
  if (combo === "+") {
    keyPart = "+";
    modParts = [];
  } else if (combo.endsWith("++")) {
    keyPart = "+";
    modParts = combo.slice(0, -2).split("+");
  } else {
    const parts = combo.split("+");
    keyPart = parts.pop() ?? "";
    modParts = parts;
  }
  if (!keyPart) throw new Error(`No key in "${combo}"`);

  let modifiers = 0;
  for (const m of modParts) {
    const bit = MODIFIERS[m.trim().toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${m}" in "${combo}"`);
    modifiers |= bit;
  }

  const named = NAMED[keyPart.toLowerCase()];
  let spec: KeySpec;
  if (named && (keyPart.length > 1 || keyPart === " ")) {
    spec = { key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, modifiers, text: named.text };
  } else if ([...keyPart].length === 1) {
    spec = charSpec(keyPart, modifiers);
  } else {
    throw new Error(`Unknown key "${keyPart}"`);
  }
  // Shortcuts (Control/Alt/Meta held) do not type text.
  if (modifiers & (1 | 2 | 4) && spec.key !== "Enter") spec.text = undefined;
  return spec;
}

function charSpec(ch: string, modifiers: number): KeySpec {
  const shift = (modifiers & 8) !== 0;
  if (/^[a-z]$/i.test(ch)) {
    const key = shift ? ch.toUpperCase() : ch;
    return { key, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), modifiers, text: key };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0), modifiers, text: ch };
  }
  const p = PUNCT[ch];
  return { key: ch, code: p?.[0] ?? "", windowsVirtualKeyCode: p?.[1] ?? 0, modifiers, text: ch };
}

/** The keyDown/keyUp pair for Input.dispatchKeyEvent. */
export function keyEvents(combo: string): [Record<string, unknown>, Record<string, unknown>] {
  const s = parseKeyCombo(combo);
  const base = {
    key: s.key,
    code: s.code,
    windowsVirtualKeyCode: s.windowsVirtualKeyCode,
    nativeVirtualKeyCode: s.windowsVirtualKeyCode,
    modifiers: s.modifiers,
  };
  const down = s.text !== undefined ? { type: "keyDown", ...base, text: s.text, unmodifiedText: s.text } : { type: "rawKeyDown", ...base };
  return [down, { type: "keyUp", ...base }];
}
