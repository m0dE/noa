/** A tab of the run in limited mode, in the chat: a notice of its own (never folded into the steps), with the fix. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { describeEvent } from "../../src/sidepanel/event-format.js";
import { placeEvent, renderEvent } from "../../src/sidepanel/event-render.js";
import { box, installMiniDom, type MiniElement } from "./mini-dom.js";

const ID = "gppongmhjkpfnbhagpmjfkannfbllamg";

describe("limited mode in the chat", () => {
  it("where, what it means (simulated input some sites ignore, no uploads) and how to fix it", () => {
    expect(describeEvent({ type: "limited_mode", tab: "t2", url: "https://mail.google.com/mail/u/0/", extensionId: ID })).toEqual({
      kind: "limited",
      text: "Limited mode in tab t2 on mail.google.com",
      hint:
        `Another extension (id ${ID}) has a frame on this page that blocks Chrome's debugger. Noa's clicks and typing there are simulated, ` +
        "so some sites ignore them, and it can't upload files. To fix it, turn that extension off for this site (Open that extension), then continue.",
      settings: `chrome://extensions/?id=${ID}`,
    });
  });

  it("the other extension not known: no button, the fix in words", () => {
    const v = describeEvent({ type: "limited_mode" });
    expect(v).toMatchObject({ kind: "limited", text: "Limited mode" });
    expect(v).not.toHaveProperty("settings");
    expect((v as { hint: string }).hint).toMatch(/^Another extension has a frame .* turn off the extension that adds its frame to this page, then continue\.$/);
  });

  describe("rendered", () => {
    beforeAll(installMiniDom);

    it("a notice with Open that extension, which opens its page in Chrome", () => {
      const create = vi.fn(async () => ({}));
      (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { create } };
      const el = renderEvent(describeEvent({ type: "limited_mode", tab: "t1", url: "https://mail.test/", extensionId: ID })) as unknown as MiniElement;
      expect(el.className).toContain("ev-limited");
      expect(el.getAttribute("role")).toBe("note");
      expect(el.textContent).toContain("Limited mode in tab t1 on mail.test");
      const button = el.all("button")[0]!;
      expect(button.textContent).toBe("Open that extension");
      button.click();
      expect(create).toHaveBeenCalledWith({ url: `chrome://extensions/?id=${ID}` });
    });

    it("placed in the thread itself, not in a folded group of steps", () => {
      const log = box();
      const v = describeEvent({ type: "limited_mode", tab: "t1" });
      const node = renderEvent(v);
      placeEvent(log as unknown as HTMLElement, node, v);
      expect(log.childNodes).toEqual([node]);
    });
  });
});
