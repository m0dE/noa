import { describe, expect, it } from "vitest";
import type { ElementInfo, PageSnapshot } from "@noa/shared";
import { formatElementsInWords, formatPageChange, formatSnapshot, textWithoutElements } from "../src/page-format.js";

const link = (index: number, name: string, inViewport = true): ElementInfo => ({ index, tag: "a", role: "link", name, href: `https://mail.test/m/${index}`, inViewport });

describe("read_page compaction", () => {
  it("leaves out text lines that only repeat a listed element, and keeps lines that say more", () => {
    const rows = [link(0, "Lena Park Security review: sign-off needed - Can you confirm by Friday"), { index: 1, tag: "button", role: "button", name: "Compose", inViewport: true }];
    const text = ["Inbox", "Compose", "☆ Lena Park Security review: sign-off needed - Can you confirm by Friday ↧", "Lena Park Security review: sign-off needed - Can you confirm by Friday that we can ship?", "", "3 unread"].join("\n");
    expect(textWithoutElements(text, rows)).toBe(["Inbox", "Lena Park Security review: sign-off needed - Can you confirm by Friday that we can ship?", "3 unread"].join("\n"));
  });

  it("a mail list is not read twice: the rows stay in the element list only", () => {
    const elements = Array.from({ length: 40 }, (_, i) => link(i, `Sender ${i} Subject number ${i} - a snippet of the message body ${i}`));
    const snap: PageSnapshot = { url: "https://mail.test/", title: "Inbox", elements, truncated: false, text: ["Inbox", ...elements.map((e) => `☆ ${e.name} ◷`)].join("\n") };
    const before = snap.text.length + elements.map((e) => e.name).join("\n").length;
    const out = formatSnapshot(snap, { words: true });
    expect(out.split("--- visible text")[1]).toBe(" ---\nInbox");
    expect(out.length).toBeLessThan(before);
  });

  it("past the line limit, elements in view are listed first; hidden ones are counted", () => {
    const els = [...Array.from({ length: 5 }, (_, i) => link(i, `offscreen ${i}`, false)), ...Array.from({ length: 5 }, (_, i) => link(10 + i, `in view ${i}`))];
    const list = formatElementsInWords(els, false, 6).split("\n");
    expect(list.slice(0, 1)).toEqual(['link "offscreen 0" (href=https://mail.test/m/0, offscreen)']);
    expect(list.filter((l) => l.includes("in view"))).toHaveLength(5);
    expect(list.at(-1)).toBe("(4 more elements not listed, out of view; scroll, or describe what you need)");
  });
});

describe("act's page change (Jev mode)", () => {
  const field = (value?: string, invalid?: string): ElementInfo => ({ index: 3, tag: "input", role: "textbox", name: "Email", type: "email", inViewport: true, ...(value ? { value } : {}), ...(invalid ? { invalid } : {}) });
  const page = (elements: ElementInfo[], text = "Sign up", url = "https://form.test/"): PageSnapshot => ({ url, title: "Form", text, elements, truncated: false });
  const button = (name: string, inDialog = false): ElementInfo => ({ index: 9, tag: "button", role: "button", name, inViewport: true, ...(inDialog ? { inDialog } : {}) });

  it("lists what appeared, changed state or went away, and the new text", () => {
    const out = formatPageChange(page([field(), button("Open")]), page([field("ada@", 'Please include an "@" and a domain'), button("Close", true)], "Sign up\nAre you sure?"));
    expect(out).toBe(
      [
        "URL: https://form.test/",
        "Title: Form",
        "What changed on the page since before these steps (read_page shows all of it):",
        "Appeared (1):",
        'button "Close" (in dialog)',
        "Changed (1):",
        'textbox "Email" (type=email, value="ada@", invalid: "Please include an \\"@\\" and a domain")',
        "Gone (1):",
        'button "Open"',
        "New text:",
        "Are you sure?",
      ].join("\n"),
    );
  });

  it("says so when nothing changed, and gives the whole new page after a navigation", () => {
    expect(formatPageChange(page([button("Open")]), page([button("Open")]))).toMatch(/Nothing on the page changed since before these steps/);
    const moved = formatPageChange(page([button("Open")]), page([button("Reply")], "Mail", "https://form.test/done"));
    expect(moved).toBe(formatSnapshot(page([button("Reply")], "Mail", "https://form.test/done"), { words: true }));
  });
});

describe("frames from other sites", () => {
  const snap = (frames?: PageSnapshot["frames"]): PageSnapshot => ({ url: "https://mail.test/u/0/", title: "Inbox", text: "Inbox", elements: [], truncated: false, ...(frames ? { frames } : {}) });

  it("read_page says what it cannot show, and act says when such a frame opened", () => {
    const popover = [{ url: "https://accounts.test/switcher", title: "Account switcher" }];
    expect(formatSnapshot(snap(popover), { words: true })).toContain(
      '--- not shown: 1 frame(s) from another site on this page ("Account switcher" https://accounts.test/switcher). Their content (e.g. an account switcher or a sign-in popup) cannot be read or clicked from here',
    );
    expect(formatSnapshot(snap(), { words: true })).not.toContain("not shown");
    const opened = formatPageChange(snap(), snap(popover));
    expect(opened).not.toContain("Nothing on the page changed");
    expect(opened).toContain("--- not shown: 1 frame(s)");
    expect(formatPageChange(snap(popover), snap(popover))).toMatch(/Nothing on the page changed/);
  });
});

describe("scrollable areas", () => {
  const row = (index: number, name: string): ElementInfo => ({ index, tag: "div", role: "generic", name, inViewport: true, inDialog: true });
  const page = (above: number, rows: string[]): PageSnapshot => ({
    url: "https://app.test/",
    title: "App",
    elements: rows.map((r, i) => row(i, r)),
    truncated: false,
    text: "Teams",
    areas: [{ index: rows.length, label: "Teams", first: rows[0]!, last: rows.at(-1)!, height: 180, above, below: 420 - above, inDialog: true }],
  });

  it("read_page says a list scrolls with more above and below, and gives the number scroll takes", () => {
    const out = formatSnapshot(page(270, ["Kite", "Lark", "Moss"]), { words: true });
    const at = out.indexOf("--- scrollable areas");
    expect(at).toBeGreaterThan(out.indexOf("Interactive elements"));
    expect(at).toBeLessThan(out.indexOf("--- visible text"));
    expect(out).toContain('area index=3 "Teams", shows "Kite" to "Moss" (180 px tall, 270 px more above, 150 px more below, in dialog)');
    expect(out).toContain("not complete lists");
  });

  it("act's page change lists the areas, and says when one scrolled during the steps", () => {
    const out = formatPageChange(page(270, ["Kite", "Lark", "Moss"]), page(90, ["Fern", "Glen", "Hale"]));
    expect(out).toContain('area index=3 "Teams", shows "Fern" to "Hale" (180 px tall, 90 px more above, 330 px more below, in dialog, it scrolled during these steps');
  });

  it("a page without such areas has no such lines", () => {
    const snap = { ...page(0, ["Kite"]), areas: undefined };
    expect(formatSnapshot(snap, { words: true })).not.toContain("scrollable areas");
  });
});
