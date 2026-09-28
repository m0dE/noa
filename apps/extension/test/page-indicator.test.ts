import { describe, expect, it } from "vitest";
import { hideIndicatorInPage, INDICATOR_MESSAGE, INDICATOR_TAG, isIndicatorMessage, PageIndicators, removeIndicatorInPage, showIndicatorInPage } from "../src/page-indicator.js";
import { AgentTab } from "../src/agent-tab.js";
import { Cdp } from "../src/cdp.js";
import { Driver } from "../src/driver.js";
import { installChromeFake } from "./chrome-fake.js";

function recording() {
  const calls: [number, string, unknown[]][] = [];
  const pages = new PageIndicators({ inject: async (tabId, func, args) => void calls.push([tabId, func.name, args]) });
  return { pages, calls };
}

describe("PageIndicators", () => {
  it("shows the overlay in the tab's top frame and removes it", async () => {
    const { pages, calls } = recording();
    await pages.show(4, "working");
    expect(calls).toEqual([[4, showIndicatorInPage.name, [INDICATOR_TAG, "working", INDICATOR_MESSAGE]]]);
    expect(pages.has(4)).toBe(true);
    await pages.remove(4);
    expect(calls.at(-1)).toEqual([4, removeIndicatorInPage.name, []]);
    expect(pages.has(4)).toBe(false);
    // Nothing shown: nothing to remove.
    await pages.remove(4);
    expect(calls).toHaveLength(2);
  });

  it("hides it around a call (all for a screenshot, the pill for input) and shows it again, even when the call fails", async () => {
    const { pages, calls } = recording();
    await pages.show(4, "working");
    calls.length = 0;
    const order: string[] = [];
    const inject = pages as unknown as { deps: { inject: (t: number, f: { name: string }, a: unknown[]) => Promise<void> } };
    const original = inject.deps.inject;
    inject.deps.inject = async (t, f, a) => {
      order.push(`${f.name}(${JSON.stringify(a)})`);
      await original(t, f, a);
    };
    expect(await pages.hiddenDuring(4, "all", async () => (order.push("capture"), "shot"))).toBe("shot");
    expect(order).toEqual([`${hideIndicatorInPage.name}(["all"])`, "capture", `${hideIndicatorInPage.name}([null])`]);
    order.length = 0;
    await expect(pages.hiddenDuring(4, "pill", async () => Promise.reject(new Error("click failed")))).rejects.toThrow("click failed");
    expect(order).toEqual([`${hideIndicatorInPage.name}(["pill"])`, `${hideIndicatorInPage.name}([null])`]);
  });

  it("a tab without the overlay runs the call as it is (no page script)", async () => {
    const { pages, calls } = recording();
    expect(await pages.hiddenDuring(9, "all", async () => 1)).toBe(1);
    expect(calls).toEqual([]);
  });

  it("a page Chrome keeps extensions out of simply has none", async () => {
    const pages = new PageIndicators({ inject: async () => Promise.reject(new Error("Cannot access a chrome:// URL")) });
    await expect(pages.show(1, "working")).resolves.toBeUndefined();
    expect(await pages.hiddenDuring(1, "all", async () => "ok")).toBe("ok");
  });

  it("only the pill's own messages are taken for it", () => {
    expect(isIndicatorMessage({ type: "control.stop" })).toBe(true);
    expect(isIndicatorMessage({ type: "control.open" })).toBe(true);
    expect(isIndicatorMessage({ type: "run.stop" })).toBe(false);
    expect(isIndicatorMessage(null)).toBe(false);
  });
});

describe("the driver never shows the overlay to the agent", () => {
  async function driverWithOverlay() {
    const chrome = installChromeFake();
    chrome.debugger.respond = (method) => (method === "Page.captureScreenshot" ? { data: "SU1H" } : { result: { value: { x: 5, y: 5 } } });
    const win = await chrome.windows.create({ url: "https://site.test/", focused: true, type: "normal" });
    const tabId = win.tabs[0]!.id;
    const agent = new AgentTab();
    await agent.prepare("current-tab");
    const hidden: string[] = [];
    const indicator = {
      hiddenDuring: async <T,>(tab: number, part: "all" | "pill", fn: () => Promise<T>) => {
        hidden.push(`${tab}:${part}:start`);
        try {
          return await fn();
        } finally {
          hidden.push(`${tab}:${part}:end`);
        }
      },
    };
    const driver = new Driver(new Cdp(), agent, { sleep: async () => {}, indicator });
    return { chrome, driver, tabId, hidden };
  }

  it("a screenshot is taken with all of it hidden (debugger)", async () => {
    const { chrome, driver, tabId, hidden } = await driverWithOverlay();
    await driver.screenshot();
    expect(hidden).toEqual([`${tabId}:all:start`, `${tabId}:all:end`]);
    const shotAt = chrome.debugger.commands.findIndex((c) => c.method === "Page.captureScreenshot");
    expect(shotAt).toBeGreaterThanOrEqual(0);
  });

  it("a screenshot in fallback mode is taken with all of it hidden too", async () => {
    const { chrome, driver, tabId, hidden } = await driverWithOverlay();
    chrome.debugger.blocked.add(tabId);
    await driver.screenshot();
    expect(chrome.tabs.captureCalls).toHaveLength(1);
    expect(hidden).toEqual([`${tabId}:all:start`, `${tabId}:all:end`]);
  });

  it("scrolling hides the pill (input at a point never reaches it)", async () => {
    const { driver, tabId, hidden } = await driverWithOverlay();
    await driver.scroll({ direction: "down" });
    expect(hidden).toEqual([`${tabId}:pill:start`, `${tabId}:pill:end`]);
  });
});
