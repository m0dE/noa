import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_API_BASE } from "@noa/shared";
import { dashboardUrl } from "../../src/account/dashboard.js";
import { createReturnWatcher, openBilling, openDashboard, refreshOnReturn } from "../../src/ui/billing.js";
import { installChromeFake, type ChromeFake } from "../chrome-fake.js";

describe("dashboard URLs (the one place they are built)", () => {
  it("the dashboard and its Billing page at the account server's origin", () => {
    expect(dashboardUrl(ACCOUNT_API_BASE)).toBe("https://app.noa.bot/");
    expect(dashboardUrl(ACCOUNT_API_BASE, "billing")).toBe("https://app.noa.bot/billing");
    // A self-hosted server with a path: the dashboard is at its origin.
    expect(dashboardUrl("http://127.0.0.1:8787/api", "billing")).toBe("http://127.0.0.1:8787/billing");
    expect(dashboardUrl("", "billing")).toBe("");
    expect(dashboardUrl("not a url")).toBe("");
  });
});

describe("openBilling / openDashboard", () => {
  let chrome: ChromeFake;
  beforeEach(() => {
    chrome = installChromeFake();
    void chrome.windows.create({ url: "https://news.test/", focused: true, type: "normal" });
  });

  it("open the account's dashboard page in a new tab", async () => {
    await openBilling({ billingUrl: "https://app.noa.bot/billing" });
    await openDashboard({ dashboardUrl: "https://app.noa.bot/" });
    expect(chrome.tabs.createCalls.map((c) => c.url)).toEqual(["https://app.noa.bot/billing", "https://app.noa.bot/"]);
  });

  it("without an account server address, open Settings > Advanced where it is set", async () => {
    await openBilling({ billingUrl: "" });
    expect(chrome.tabs.createCalls.map((c) => c.url)).toEqual(["chrome-extension://testextensionid/options.html#advanced"]);
    // No account known yet: the same, in the options tab already open.
    await openBilling(null);
    expect(chrome.tabs.createCalls).toHaveLength(1);
  });
});

describe("coming back from the dashboard refreshes the account", () => {
  /** A window and document that only dispatch the events refreshOnReturn listens to. */
  function page() {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const win = Object.assign(new EventTarget(), { document: doc });
    const watcher = createReturnWatcher();
    const refresh = vi.fn();
    refreshOnReturn(refresh, win as never, watcher);
    const visibility = (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event("visibilitychange"));
    };
    const fire = (type: "focus" | "blur") => win.dispatchEvent(new Event(type));
    return { watcher, refresh, visibility, fire };
  }

  it("no dashboard page opened: leaving and coming back does nothing", () => {
    const p = page();
    p.fire("blur");
    p.fire("focus");
    p.visibility("hidden");
    p.visibility("visible");
    expect(p.refresh).not.toHaveBeenCalled();
  });

  it("opened, left (tab hidden), back: one refresh, even when focus and visibilitychange both fire", () => {
    const p = page();
    p.watcher.arm();
    p.visibility("hidden");
    p.fire("blur");
    p.visibility("visible");
    p.fire("focus");
    expect(p.refresh).toHaveBeenCalledTimes(1);
  });

  it("the side panel stays visible and only loses focus: back on focus", () => {
    const p = page();
    p.watcher.arm();
    p.fire("blur");
    p.fire("focus");
    expect(p.refresh).toHaveBeenCalledTimes(1);
  });

  it("every later return refreshes too (the payment may finish after a first look back)", () => {
    const p = page();
    p.watcher.arm();
    p.fire("blur");
    p.fire("focus");
    p.fire("blur");
    p.fire("focus");
    expect(p.refresh).toHaveBeenCalledTimes(2);
  });

  it("focus without having left (the click that opened the dashboard) does not refresh", () => {
    const p = page();
    p.watcher.arm();
    p.fire("focus");
    p.visibility("visible");
    expect(p.refresh).not.toHaveBeenCalled();
  });
});
