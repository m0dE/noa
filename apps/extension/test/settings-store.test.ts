import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_API_BASE, DEFAULT_SETTINGS, PREVIOUS_ACCOUNT_API_BASES } from "@noa/shared";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import {
  ALARM_NAME,
  ensureAlarm,
  getRunnerId,
  handleStorageChange,
  loadSettings,
  migrateStoredSettings,
  saveSettings,
  saveSettingsPatch,
} from "../src/settings-store.js";

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});

describe("settings store", () => {
  it("returns defaults when nothing is stored", async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("parses stored values and repairs invalid ones", async () => {
    chrome.storage.local.data.settings = { intervalMinutes: -3, delayMinSec: 5, delayMaxSec: 1 };
    const s = await loadSettings();
    expect(s.intervalMinutes).toBe(15);
    expect(s.delayMinSec).toBe(5);
    expect(s.delayMaxSec).toBe(5);
  });

  it("saveSettings merges a partial update and stores parsed values", async () => {
    await saveSettings({ jevApiKey: "jk_x" });
    await saveSettings({ intervalMinutes: 30 });
    const stored = chrome.storage.local.data.settings as Record<string, unknown>;
    expect(stored.jevApiKey).toBe("jk_x");
    expect(stored.intervalMinutes).toBe(30);
    expect(stored.delayMinSec).toBe(60);
  });

  it("persists one random runnerId", async () => {
    const a = await getRunnerId();
    const b = await getRunnerId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
  });
});

describe("settings.save patches", () => {
  it("keeps omitted secrets and the 'set' marker, clears with '', sets new values", async () => {
    await saveSettings({ anthropicApiKey: "sk-1", jevApiKey: "jk-1" });
    await saveSettingsPatch({ anthropicApiKey: "set", jevApiKey: " jk-2 ", brain: "claude-api", maxConsecutiveFailures: 5 });
    expect(await loadSettings()).toMatchObject({ anthropicApiKey: "sk-1", jevApiKey: "jk-2", brain: "claude-api", maxConsecutiveFailures: 5 });
    await saveSettingsPatch({ jevApiKey: "" });
    expect((await loadSettings()).jevApiKey).toBe("");
  });

  it("ignores unknown keys and keeps old values for invalid ones", async () => {
    await saveSettingsPatch({ retryAfterMinutes: 20 });
    await saveSettingsPatch({ retryAfterMinutes: -1, bogus: 1 } as never);
    const s = await loadSettings();
    expect(s.retryAfterMinutes).toBe(20);
    expect((chrome.storage.local.data.settings as Record<string, unknown>).bogus).toBeUndefined();
  });

  it("has defaults for the v2 fields", async () => {
    expect(await loadSettings()).toMatchObject({ brain: "auto", maxConsecutiveFailures: 3, retryAfterMinutes: 10 });
  });
});

describe("alarm scheduling", () => {
  it("ensureAlarm creates the alarm with the configured interval", async () => {
    await chrome.storage.local.set({ settings: { intervalMinutes: 20 } });
    await ensureAlarm();
    expect(chrome.alarms.all.get(ALARM_NAME)?.periodInMinutes).toBe(20);
  });

  it("ensureAlarm keeps an alarm that already matches", async () => {
    await ensureAlarm();
    const before = chrome.alarms.all.get(ALARM_NAME);
    await ensureAlarm();
    expect(chrome.alarms.all.get(ALARM_NAME)).toBe(before);
  });

  it("reschedules when intervalMinutes changes", async () => {
    await ensureAlarm();
    await saveSettings({ intervalMinutes: 45 });
    // saveSettings fires storage.onChanged; the background forwards it here.
    await handleStorageChange({ settings: { oldValue: { intervalMinutes: 15 }, newValue: { intervalMinutes: 45 } } }, "local");
    expect(chrome.alarms.all.get(ALARM_NAME)?.periodInMinutes).toBe(45);
  });

  it("ignores unrelated changes", async () => {
    await ensureAlarm();
    const before = chrome.alarms.all.get(ALARM_NAME);
    await handleStorageChange({ settings: { oldValue: { intervalMinutes: 15 }, newValue: { intervalMinutes: 15, jevApiKey: "k" } } }, "local");
    await handleStorageChange({ other: { newValue: 1 } }, "local");
    await handleStorageChange({ settings: { newValue: { intervalMinutes: 99 } } }, "session");
    expect(chrome.alarms.all.get(ALARM_NAME)).toBe(before);
  });
});

describe("the account server's earlier default in stored settings", () => {
  const OLD = PREVIOUS_ACCOUNT_API_BASES[0]!;

  it("is read at its current address, and written back there once at worker start", async () => {
    chrome.storage.local.data.settings = { accountApiBase: OLD, brain: "noa", intervalMinutes: 30 };
    expect((await loadSettings()).accountApiBase).toBe(ACCOUNT_API_BASE);
    expect(await migrateStoredSettings()).toBe(true);
    // Only the address changes; the rest stays as stored.
    expect(chrome.storage.local.data.settings).toEqual({ accountApiBase: ACCOUNT_API_BASE, brain: "noa", intervalMinutes: 30 });
    expect(await migrateStoredSettings()).toBe(false);
  });

  it("leaves a self-hosted server, the current default and a fresh install alone", async () => {
    expect(await migrateStoredSettings()).toBe(false);
    expect(chrome.storage.local.data.settings).toBeUndefined();
    for (const accountApiBase of ["https://api.example.org", ACCOUNT_API_BASE]) {
      chrome.storage.local.data.settings = { accountApiBase };
      expect(await migrateStoredSettings()).toBe(false);
      expect(chrome.storage.local.data.settings).toEqual({ accountApiBase });
    }
  });
});

describe("settings of the removed runner-key cloud sync", () => {
  it("are deleted from storage once at worker start, the runner key with them", async () => {
    chrome.storage.local.data.settings = { cloudEnabled: true, apiBase: "https://tasks.example.com", runnerKey: "bt_secret", brain: "noa" };
    expect(await migrateStoredSettings()).toBe(true);
    expect(chrome.storage.local.data.settings).toEqual({ brain: "noa" });
    expect(await migrateStoredSettings()).toBe(false);
  });

  it("go together with moving an earlier default account server", async () => {
    chrome.storage.local.data.settings = { accountApiBase: PREVIOUS_ACCOUNT_API_BASES[0], runnerKey: "" };
    expect(await migrateStoredSettings()).toBe(true);
    expect(chrome.storage.local.data.settings).toEqual({ accountApiBase: ACCOUNT_API_BASE });
  });
});
