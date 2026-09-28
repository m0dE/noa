/** Pages Chrome keeps extensions out of: URL checks, Chrome's errors, and what the driver's tools answer there. */
import { beforeEach, describe, expect, it } from "vitest";
import type { ChromeFake } from "./chrome-fake.js";
import { DRAWN, driverHarness, runInUserTab } from "./driver-harness.js";
import type { Driver } from "../src/driver.js";
import { isRestrictedError, isRestrictedUrl, restrictedToolError } from "../src/restricted.js";

describe("isRestrictedUrl", () => {
  it.each([
    "chrome://newtab/",
    "chrome://extensions/shortcuts",
    "chrome-extension://abcdefghijklmnop/popup.html",
    "view-source:https://example.com/",
    "https://chromewebstore.google.com/detail/x/abc",
    "https://chrome.google.com/webstore/devconsole/123",
    "edge://settings",
    "devtools://devtools/bundled/inspector.html",
  ])("%s is restricted", (url) => expect(isRestrictedUrl(url)).toBe(true));

  it.each(["https://mail.google.com/", "http://127.0.0.1:8080/x", "about:blank", "https://chrome.google.com/intl/en/chrome/", "", undefined])(
    "%s is not",
    (url) => expect(isRestrictedUrl(url)).toBe(false),
  );
});

describe("isRestrictedError", () => {
  it.each([
    "The extensions gallery cannot be scripted.",
    "Cannot access a chrome:// URL",
    'Cannot access contents of url "view-source:https://example.com/". Extension manifest must request permission to access this host.',
    '{"code":-32000,"message":"Not allowed"}',
    "Not allowed",
  ])("%s", (msg) => expect(isRestrictedError(new Error(msg))).toBe(true));

  it("not another extension's frame (that tab has a fallback) or ordinary errors", () => {
    expect(isRestrictedError(new Error("Cannot access a chrome-extension:// URL of different extension"))).toBe(false);
    expect(isRestrictedError(new Error("element 4 not found; call read_page again"))).toBe(false);
    expect(isRestrictedError(new Error("Not allowed to load local resource"))).toBe(false);
  });
});

describe("Driver on such a page", () => {
  let chrome: ChromeFake;
  let driver: Driver;
  let tabId: number;
  const STORE = "https://chromewebstore.google.com/detail/x";

  beforeEach(async () => {
    const h = driverHarness();
    ({ chrome, driver } = h);
    ({ tabId } = await runInUserTab(h, "https://site.test/"));
    // The agent tab then shows the Web Store (e.g. the agent navigated there).
    chrome.tabs.byId.get(tabId)!.url = STORE;
    chrome.debugger.refused.set(tabId, "The extensions gallery cannot be scripted.");
  });

  it("read_page, screenshot and click answer with one plain sentence, not Chrome's raw error", async () => {
    for (const call of [() => driver.readPage(), () => driver.screenshot(), () => driver.click({ index: 1 })]) {
      await expect(call()).rejects.toThrow(restrictedToolError(STORE));
    }
  });

  it("other tabs keep working, and switching back to that tab says why plainly", async () => {
    // ready() itself keeps Chrome's error (the slot's prepare tolerates it).
    await expect(driver.ready()).rejects.toThrow(/cannot be scripted/);
    const opened = await driver.openTabs({ urls: ["https://mail.test/"] });
    chrome.debugger.respond = (method) =>
      method === "Runtime.evaluate" ? { result: { value: { url: "https://mail.test/", title: "Mail", text: "", elements: DRAWN, truncated: false } } } : {};
    const snap = await driver.readPage({ tab: opened.tabs[0]!.id });
    expect(snap.url).toBe("https://mail.test/");
    await expect(driver.switchTab({ tab: "t1" })).rejects.toThrow(restrictedToolError(STORE));
  });
});
