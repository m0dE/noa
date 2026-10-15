/**
 * Buttons that declare they open a menu, list or dialog (aria-haspopup) only show choices: they wait for nobody,
 * whatever their label says. What is chosen in the menu or dialog (a "Repost" menu item, the composer's Post) and
 * buttons that act in one click still wait. And a card says what the action acts on: the post or dialog the element
 * is in, as the page read shows it.
 */
import type { BrowserCaller } from "@noa/core";
import type { ApprovalRequest, ElementInfo, PageSnapshot } from "@noa/shared";
import { describe, expect, it } from "vitest";
import { classifyByRules, type GateAction } from "../../src/approval/consequence.js";
import { ApprovalGate, approvalAsk } from "../../src/approval/gate.js";

const X_STATUS = { url: "https://x.com/carla/status/1000", title: "Carla on X" };
const SHOP = { url: "https://shop.example.com/item/42", title: "Kettle - Shop" };
const el = (role: string, name: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({ index: 1, tag: "button", role, name, inViewport: true, ...extra });
const click = (element: ElementInfo, page = X_STATUS): GateAction => ({ method: "click", element, page, typed: [] });

describe("a button that opens a menu or dialog", () => {
  it("does not wait, whatever its label says", () => {
    const openers = [
      el("button", "0 reposts. Repost", { testId: "retweet", popup: "menu", expanded: false }),
      el("button", "0 reposts. Repost", { testId: "retweet", popup: "menu", expanded: true }),
      el("button", "Delete", { popup: "dialog" }),
      el("button", "Send options", { popup: "menu" }),
      el("button", "Buy now", { popup: "dialog" }, ),
      el("menuitem", "Share", { popup: "menu" }),
      el("combobox", "Visibility", { popup: "listbox" }),
    ];
    for (const o of openers) expect([o.name, classifyByRules(click(o, o.name === "Buy now" ? SHOP : X_STATUS)).verdict]).toEqual([o.name, "benign"]);
    expect(classifyByRules(click(openers[0]!)).reason).toBe('"0 reposts. Repost" opens a menu');
  });

  it("still waits without the declaration (the same label, no aria-haspopup)", () => {
    expect(classifyByRules(click(el("button", "0 reposts. Repost", { testId: "retweet" })))).toMatchObject({ verdict: "consequential", kind: "publish" });
  });

  it("leaves what is chosen in the menu or dialog, and one-click buttons, waiting", () => {
    const acting = [
      click(el("menuitem", "Repost", { testId: "retweetConfirm", inDialog: true })),
      click(el("button", "Post", { testId: "tweetButton", inDialog: true })),
      click(el("button", "5 Likes. Like", { testId: "like" })),
      click(el("menuitem", "Delete", { inDialog: true })),
      click(el("button", "Buy now"), SHOP),
      // aria-expanded alone (a disclosure) says nothing about what it does: the label decides.
      click(el("button", "Send", { expanded: false })),
    ];
    for (const a of acting) expect([a.element!.name, classifyByRules(a).verdict]).toEqual([a.element!.name, "consequential"]);
  });
});

describe("the card names what the action acts on", () => {
  const post = "Carla @carla · 2h Our tide tables now cover every harbour on the coast.";
  const snapshot = (elements: ElementInfo[], contexts?: string[]): PageSnapshot => ({ ...X_STATUS, text: "", elements, truncated: false, ...(contexts ? { contexts } : {}) });

  it("shows the post a menu item reposts, and the account", () => {
    const repost = el("menuitem", "Repost", { testId: "retweetConfirm", context: 0 });
    const ask = approvalAsk({ ...click(repost), account: "@beta", target: snapshot([repost], [post]).contexts![0] }, "publishes", "publish");
    expect(ask).toMatchObject({ action: 'Click "Repost" as @beta', site: "x.com", target: post });
  });

  it("shows a quote's composer with the drafted text", () => {
    const box = el("textbox", "Post text", { tag: "div", testId: "tweetTextarea_0", context: 0, inDialog: true });
    const send = el("button", "Post", { index: 2, testId: "tweetButton", context: 0, inDialog: true });
    const dialog = "Compose post: Carla @carla Our tide tables now cover every harbour on the coast. Post";
    const ask = approvalAsk({ ...click(send), account: "@beta", target: dialog, typed: [{ element: box, text: "Handy for sailors" }] }, "publishes", "publish");
    expect(ask).toMatchObject({ action: 'Click "Post" as @beta', text: "Handy for sailors", target: dialog });
  });

  it("clips a long target, and leaves it out when the element is in nothing", () => {
    const long = "x".repeat(400);
    expect(approvalAsk({ ...click(el("button", "Post")), target: long }, "publishes", "publish").target).toHaveLength(160);
    expect(approvalAsk(click(el("button", "Post")), "publishes", "publish")).not.toHaveProperty("target");
  });
});

describe("the gate on a post's page", () => {
  const post = "Carla @carla · 2h Our tide tables now cover every harbour on the coast.";
  const opener = el("button", "0 reposts. Repost", { index: 30, testId: "retweet", popup: "menu", expanded: false, context: 0 });
  const repost = el("menuitem", "Repost", { index: 31, testId: "retweetConfirm", context: 0 });
  const page: PageSnapshot = { ...X_STATUS, text: post, elements: [opener, repost], truncated: false, contexts: [post] };

  it("lets the menu opener through, and asks for the menu item naming the post", async () => {
    const asked: Omit<ApprovalRequest, "id" | "expiresAt">[] = [];
    const ran: string[] = [];
    const inner: BrowserCaller = {
      call: async (method, params) => {
        ran.push(`${method} ${JSON.stringify(params)}`);
        return (method === "browser.readPage" ? page : { ok: true }) as never;
      },
    };
    const gate = new ApprovalGate(inner, () => "s1", {
      context: async () => ({ level: "ask_consequential" }),
      request: async (_s, ask) => (asked.push(ask), "allow_once"),
    });
    await gate.browser.call("browser.readPage", {});
    await gate.browser.call("browser.click", { index: 30 });
    expect(asked).toEqual([]);
    await gate.browser.call("browser.click", { index: 31 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: 'Click "Repost"', kind: "publish", target: post });
    expect(ran.filter((r) => r.startsWith("browser.click"))).toHaveLength(2);
  });
});
