/** The panel's keyboard shortcuts (open the chat; talk): declared once in the manifest, shown as Chrome assigned them. */
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../static/manifest.json";
import { isMac, OPEN_CHAT_COMMAND, readShortcut, shortcutLabel, VOICE_COMMAND } from "../src/shortcut.js";

const commands = manifest.commands as Record<string, { suggested_key: { default: string; mac: string }; global?: boolean }>;
const suggested = commands[OPEN_CHAT_COMMAND]!.suggested_key;
const voiceSuggested = commands[VOICE_COMMAND]!.suggested_key;

describe("the manifest's commands", () => {
  it("are the ones the background handles, each with a key for Windows/Linux and Mac that Chrome accepts", () => {
    expect(Object.keys(commands)).toEqual([OPEN_CHAT_COMMAND, VOICE_COMMAND]);
    for (const c of Object.values(commands)) {
      // Chrome: Ctrl or Alt required, never Ctrl+Alt; Command or MacCtrl on a Mac.
      expect(c.suggested_key.default).toMatch(/^(Ctrl|Alt)\+/);
      expect(c.suggested_key.default).not.toMatch(/Ctrl\+Alt|Alt\+Ctrl/);
      expect(c.suggested_key.mac).toMatch(/^(Command|MacCtrl)\+/);
      // Not "global": those only take Ctrl+Shift+[0-9], and a side panel needs a focused Chrome window anyway.
      expect(c.global).toBeUndefined();
    }
    expect(new Set(Object.values(commands).map((c) => c.suggested_key.default)).size).toBe(2);
  });

  it("open is Ctrl+. (⌘. on a Mac); talk is Ctrl+, (⌃, on a Mac, since ⌘, is Chrome's Settings there)", () => {
    expect(suggested).toEqual({ default: "Ctrl+Period", mac: "Command+Period" });
    expect(voiceSuggested).toEqual({ default: "Ctrl+Comma", mac: "MacCtrl+Comma" });
    expect(shortcutLabel(voiceSuggested.default, false)).toBe("Ctrl+,");
    expect(shortcutLabel(voiceSuggested.mac, true)).toBe("⌃,");
  });
});

describe("shortcutLabel", () => {
  it("as written elsewhere, as symbols on a Mac (either way Chrome reports it)", () => {
    expect(shortcutLabel("Ctrl+Shift+K", false)).toBe("Ctrl+Shift+K");
    // Chrome names punctuation keys in words: they read as the character.
    expect(shortcutLabel("Ctrl+Period", false)).toBe("Ctrl+.");
    expect(shortcutLabel("Command+Period", true)).toBe("⌘.");
    expect(shortcutLabel("Ctrl+Period", true)).toBe("⌘.");
    expect(shortcutLabel("⌘.", true)).toBe("⌘.");
    expect(shortcutLabel("Alt+Shift+Comma", false)).toBe("Alt+Shift+,");
    expect(shortcutLabel("Command+Shift+K", true)).toBe("⌘⇧K");
    expect(shortcutLabel("⇧⌘K", true)).toBe("⌘⇧K");
    expect(shortcutLabel("Ctrl+Shift+K", true)).toBe("⌘⇧K");
    expect(shortcutLabel("MacCtrl+Alt+J", true)).toBe("⌃⌥J");
    expect(shortcutLabel("", true)).toBe("");
  });

  it("isMac reads the platform", () => {
    expect(isMac({ platform: "MacIntel" })).toBe(true);
    expect(isMac({ userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isMac({ platform: "Win32" })).toBe(false);
  });
});

describe("readShortcut", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (commands: unknown, platform = "Win32") => {
    vi.stubGlobal("navigator", { platform });
    vi.stubGlobal("chrome", { commands, runtime: { getManifest: () => manifest } });
  };

  it("what Chrome assigned; null when it assigned nothing (the key was taken)", async () => {
    stub({ getAll: async () => [{ name: OPEN_CHAT_COMMAND, shortcut: "Alt+Shift+B" }] });
    expect(await readShortcut()).toBe("Alt+Shift+B");
    stub({ getAll: async () => [{ name: OPEN_CHAT_COMMAND, shortcut: "" }] });
    expect(await readShortcut()).toBeNull();
  });

  it("each command's own key", async () => {
    stub({ getAll: async () => [{ name: OPEN_CHAT_COMMAND, shortcut: "Ctrl+Period" }, { name: VOICE_COMMAND, shortcut: "Ctrl+Comma" }] });
    expect(await readShortcut(OPEN_CHAT_COMMAND)).toBe("Ctrl+.");
    expect(await readShortcut(VOICE_COMMAND)).toBe("Ctrl+,");
    stub(undefined, "MacIntel");
    expect(await readShortcut(VOICE_COMMAND)).toBe("⌃,");
  });

  it("without chrome.commands: the manifest's suggestion, per platform", async () => {
    stub(undefined);
    expect(await readShortcut()).toBe(shortcutLabel(suggested.default, false));
    stub(undefined, "MacIntel");
    expect(await readShortcut()).toBe(shortcutLabel(suggested.mac, true));
  });
});
