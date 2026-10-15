/**
 * Auto tab switching as the user sees it: the chat's notice (once per chat, its (i) explains and links to the
 * setting), the card that asks when it is off (Switch to it / Not now), and the options page's toggle.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentEvent, type ApprovalRequest } from "@noa/shared";
import { approvalView, SWITCH_BUTTONS } from "../../src/sidepanel/approval-view.js";
import { renderApproval } from "../../src/sidepanel/approval-card.js";
import { describeEvent } from "../../src/sidepanel/event-format.js";
import { placeEvent, renderEvent } from "../../src/sidepanel/event-render.js";
import { anchorFromHash, formValues, parseForm, sectionFromHash } from "../../src/options/settings-view.js";
import { box, installMiniDom, type MiniElement } from "./mini-dom.js";

const HINT =
  "Noa switched to its tab (tab t2 on docs.test) because it needs the tab visible to see the page (to take a screenshot). " +
  "Please don't type while it works. You can turn Auto tab switching off in Settings, but then Noa can't see tabs you're not looking at, which limits what it can do.";

const request: ApprovalRequest = { id: "s1", action: "Switch to tab t2", site: "docs.test", why: "Noa needs to see this tab to take a screenshot", switchTo: { tabId: 42 }, expiresAt: "2026-10-13T09:00:00.000Z" };
const ask: Extract<AgentEvent, { type: "approval_request" }> = { type: "approval_request", request };

describe("the Auto tab switching notice", () => {
  it("says it is on, and why, what not to do and how to turn it off", () => {
    expect(describeEvent({ type: "auto_tab_switching", tab: "t2", url: "https://docs.test/a" })).toEqual({ kind: "tabswitch", text: "Auto tab switching on", hint: HINT, settings: "tab-switching" });
    expect((describeEvent({ type: "auto_tab_switching" }) as { hint: string }).hint).toMatch(/^Noa switched to its tab because it needs the tab visible/);
  });

  it("under full autonomy (full): says that did it, not the setting, and links to the Permission tab", () => {
    const v = describeEvent({ type: "auto_tab_switching", tab: "t2", url: "https://docs.test/a", full: true });
    expect(v).toMatchObject({ kind: "tabswitch", text: "Full autonomy: switched tabs without asking", settings: "permission" });
    const hint = (v as { hint: string }).hint;
    expect(hint).toMatch(/^Noa switched to its tab \(tab t2 on docs.test\) because it needs the tab visible to see the page \(to take a screenshot\)\. Please don't type while it works\. /);
    expect(hint).toContain("Full autonomy never asks, so this happens whatever Auto tab switching is set to.");
    expect(hint).toContain("pick another permission level in Settings and turn Auto tab switching off");
    expect(hint).not.toContain("You can turn Auto tab switching off in Settings, but");
  });

  describe("rendered", () => {
    beforeAll(installMiniDom);

    it("one line with an (i) button that shows and hides the explanation (aria-expanded, aria-controls); Open Settings opens the toggle", () => {
      const showExtensionPage = vi.fn(async () => undefined);
      (globalThis as unknown as { chrome: unknown }).chrome = {
        runtime: { getURL: (p: string) => `chrome-extension://x/${p}`, openOptionsPage: vi.fn() },
        tabs: { query: async () => [], create: showExtensionPage, update: vi.fn() },
        windows: { update: vi.fn() },
      };
      const el = renderEvent(describeEvent({ type: "auto_tab_switching", tab: "t2", url: "https://docs.test/a" })) as unknown as MiniElement;
      expect(el.className).toContain("ev-tabswitch");
      expect(el.getAttribute("role")).toBe("note");
      const [info, settings] = el.all("button");
      expect(info!.getAttribute("aria-label")).toBe("What this means");
      expect(info!.getAttribute("aria-expanded")).toBe("false");
      const hint = el.all("div").find((d) => d.getAttribute("id") === info!.getAttribute("aria-controls"))!;
      expect(hint.hidden).toBe(true);
      expect(hint.textContent).toContain(HINT);
      info!.click();
      expect(info!.getAttribute("aria-expanded")).toBe("true");
      expect(hint.hidden).toBe(false);
      info!.click();
      expect(info!.getAttribute("aria-expanded")).toBe("false");
      expect(hint.hidden).toBe(true);
      expect(settings!.textContent).toBe("Open Settings");
      settings!.click();
      return vi.waitFor(() => expect(showExtensionPage).toHaveBeenCalledWith(expect.objectContaining({ url: "chrome-extension://x/options.html#tab-switching" })));
    });

    it("placed in the thread itself, not in a folded group of steps", () => {
      const log = box();
      const v = describeEvent({ type: "auto_tab_switching", tab: "t1" });
      const node = renderEvent(v);
      placeEvent(log as unknown as HTMLElement, node, v);
      expect(log.childNodes).toEqual([node]);
    });
  });
});

describe("the card that asks to switch (Auto tab switching off)", () => {
  it("Switch to it / Not now; how it ended in its own words", () => {
    expect(SWITCH_BUTTONS.map((b) => [b.answer, b.label])).toEqual([
      ["allow_once", "Switch to it"],
      ["deny", "Not now"],
    ]);
    expect(approvalView(ask)).toMatchObject({ state: "pending", switchTo: { tabId: 42 } });
    expect(approvalView(ask, { outcome: "allow_once" }).outcome).toBe("Switched to the tab");
    expect(approvalView(ask, { outcome: "deny" }).outcome).toBe("Not now: Noa didn't switch");
    expect(approvalView(ask, { outcome: "timeout" }).outcome).toBe("No answer in time: Noa didn't switch");
  });

  describe("rendered", () => {
    beforeAll(installMiniDom);

    it("says what Noa needs, offers the setting, and Switch to it opens the side panel by the tab before answering", async () => {
      const open = vi.fn(async () => undefined);
      (globalThis as unknown as { chrome: unknown }).chrome = { sidePanel: { open } };
      const answers: string[] = [];
      const card = renderApproval(approvalView(ask), { answer: async (_id, a) => (answers.push(a), true) }) as unknown as MiniElement;
      expect(card.textContent).toContain("Noa needs to see this tab to take a screenshot");
      expect(card.textContent).toContain("Switch to tab t2 on docs.test");
      expect(card.textContent).toContain("Auto tab switching in Settings does this without asking.");
      expect(card.textContent).toContain("counts as Not now.");
      const buttons = card.all("button").filter((b) => b.getAttribute("data-answer"));
      expect(buttons.map((b) => b.textContent)).toEqual(["Switch to it", "Not now"]);
      buttons[0]!.click();
      expect(open).toHaveBeenCalledWith({ tabId: 42 });
      await vi.waitFor(() => expect(answers).toEqual(["allow_once"]));
    });

    it("Not now opens nothing", async () => {
      const open = vi.fn(async () => undefined);
      (globalThis as unknown as { chrome: unknown }).chrome = { sidePanel: { open } };
      const answers: string[] = [];
      const card = renderApproval(approvalView(ask), { answer: async (_id, a) => (answers.push(a), true) }) as unknown as MiniElement;
      card.all("button").find((b) => b.getAttribute("data-answer") === "deny")!.click();
      await vi.waitFor(() => expect(answers).toEqual(["deny"]));
      expect(open).not.toHaveBeenCalled();
    });
  });
});

describe("the options page's toggle", () => {
  const html = readFileSync(new URL("../../static/options.html", import.meta.url), "utf8");

  it("a switch labelled Auto tab switching that says what it does and what turning it off costs", () => {
    const row = /<div class="srow" id="tab-switching-row">([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1] ?? "";
    expect(row).toContain('<label class="srow-label" for="f-autoTabSwitching"><b>Auto tab switching</b>');
    expect(row).toContain("Noa switches to its tab when it needs to see the page (to take a screenshot)");
    expect(row).toContain("without your OK it can't see tabs you're not looking at, which limits what it can do");
    expect(row).toContain('<input id="f-autoTabSwitching" type="checkbox" role="switch" />');
  });

  it("shows the setting (on by default) and saves it as switched", () => {
    expect(formValues(DEFAULT_SETTINGS).autoTabSwitching).toBe(true);
    expect(parseForm({ ...formValues(DEFAULT_SETTINGS), autoTabSwitching: false }).autoTabSwitching).toBe(false);
  });

  it("options.html#tab-switching opens Tasks at the toggle", () => {
    expect(sectionFromHash("#tab-switching")).toBe("tasks");
    expect(anchorFromHash("#tab-switching")).toBe("tab-switching-row");
  });
});
