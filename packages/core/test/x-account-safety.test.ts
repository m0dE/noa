/**
 * Regression tests for two production failures of repeating X jobs (build c2852cb, Claude Code brain, 2026-09-28):
 *
 * A) A Rooftop Chat post ("Group chat etiquette: ...", status 2104445831705477232) was published on @mecharoyalecom.
 *    The @rooftopchat run's switch_x_account failed (step 3), the agent then opened x.com/rooftopchat (a profile page
 *    whose title names @rooftopchat whoever is signed in), said "Signed in as @rooftopchat", typed the post and
 *    clicked Post while X's switcher still showed another account. Nothing in code checks the active account before
 *    a publishing click, and verifyXPost does not look at the account either.
 *
 * B) switch_x_account cannot switch on the real X account menu. The DOM below is copied from real read_page results
 *    of those runs: the menu lists delegate accounts ("Act as" UserCells) and keeps personal accounts in a collapsed
 *    "Personal accounts" section that has no interactive element, while the page itself has buttons and links that
 *    name the handle (a profile's "Follow back @handle" button, its "@handle" links). switch_x_account matches ANY
 *    button or link that mentions the handle, so it clicks one of those instead of an account entry.
 */
import { describe, expect, it } from "vitest";
import type { BrowserMethod, BrowserMethods, ElementInfo, PageSnapshot } from "@noa/shared";
import { createToolExecutor, verifyXPost } from "../src/index.js";
import { switchXAccount } from "../src/x-account.js";
import type { BrowserCaller } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { collect, noSleep } from "./helpers.js";

interface El {
  el: ElementInfo;
  onClick?: () => void;
  /** Part of the open account menu (anything else is the page behind it). */
  menu?: boolean;
}

/**
 * X as the real site showed it to the agent: signed in as `account`; other personal accounts only in the collapsed
 * "Personal accounts" section of the account menu (no element to click); delegate accounts as "Act as" buttons.
 */
class RealishX {
  url: string;
  account: { name: string; handle: string };
  menuOpen = false;
  /** Clicks on page elements (not the switcher, not the menu): a Follow button, a profile link... */
  strayClicks: string[] = [];
  follows: string[] = [];
  private els: El[] = [];

  constructor(opts: { url: string; account: { name: string; handle: string } }) {
    this.url = opts.url;
    this.account = opts.account;
  }

  private profile(): string | null {
    const m = /^https:\/\/x\.com\/([A-Za-z0-9_]+)$/.exec(this.url);
    return m && m[1] !== "home" ? m[1]! : null;
  }

  snapshot(): PageSnapshot {
    const els: El[] = [];
    const add = (el: Omit<ElementInfo, "index" | "inViewport">, more: Omit<El, "el"> = {}) =>
      els.push({ el: { inViewport: true, ...el, index: els.length }, ...more });
    if (this.menuOpen) {
      add({ tag: "div", role: "group", name: `${this.account.name} ${this.account.handle} Delegate accounts Tales of Meteora @talesofmeteora CRED Official @credofficial` }, { menu: true });
      add({ tag: "button", role: "button", name: "Act as", text: "Tales of Meteora @talesofmeteora", testId: "UserCell" }, { menu: true });
      add({ tag: "button", role: "button", name: "Act as", text: "CRED Official @credofficial", testId: "UserCell" }, { menu: true });
      add({ tag: "a", role: "menuitem", name: "Manage accounts", href: "https://x.com/account/switch", testId: "AccountSwitcher_ManageAccounts_Button" }, { menu: true });
      add({ tag: "a", role: "menuitem", name: `Log out ${this.account.handle}`, href: "https://x.com/logout", testId: "AccountSwitcher_Logout_Button" }, { menu: true });
    }
    add({ tag: "a", role: "link", name: "Home", href: "https://x.com/home", testId: "AppTabBar_Home_Link" });
    add(
      { tag: "button", role: "button", name: "Account menu", text: `${this.account.name} ${this.account.handle}`, testId: "SideNav_AccountSwitcher_Button" },
      { onClick: () => (this.menuOpen = !this.menuOpen) },
    );
    const profile = this.profile();
    if (profile) {
      // As on https://x.com/mecharoyalecom at 06:15:06 (signed in as @rooftopchat).
      add(
        { tag: "button", role: "button", name: `Follow back @${profile}`, text: "Follow back", testId: "2083936604524269568-follow" },
        { onClick: () => void this.follows.push(`@${profile}`) },
      );
      add({ tag: "a", role: "link", name: `@${profile}`, href: `https://x.com/${profile}` }, { onClick: () => (this.url = `https://x.com/${profile}`) });
    }
    this.els = els;
    const visible = this.menuOpen ? "Delegate accounts\nPersonal accounts\n" : "";
    return { url: this.url, title: profile ? `${profile} (@${profile}) / X` : "Home / X", text: visible, elements: els.map((e) => e.el), truncated: false };
  }

  caller(): BrowserCaller {
    return {
      call: async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => {
        const p = params as Record<string, any>;
        switch (method) {
          case "browser.readPage":
            return this.snapshot() as never;
          case "browser.navigate":
            this.url = p.url;
            this.menuOpen = false;
            return { url: this.url, title: "X" } as never;
          case "browser.click": {
            const e = this.els[p.index];
            if (!e) throw new Error(`element ${p.index} not found; call read_page again`);
            if (!e.menu && e.el.testId !== "SideNav_AccountSwitcher_Button") this.strayClicks.push(`${e.el.role} "${e.el.name}"`);
            e.onClick?.();
            return { ok: true } as never;
          }
          case "browser.clickXAccountEntry":
            // Like the page function: this menu has no "Switch to" entry, only delegates' "Act as" cells.
            return { clicked: false, reason: this.menuOpen ? 'the account menu shows only delegate accounts ("Act as")' : "the account menu is not open" } as never;
          default:
            throw new Error(`Unknown method: ${method}`);
        }
      },
    };
  }
}

describe("B: switch_x_account on X's real account menu", () => {
  it("on a profile page it never clicks the page's Follow button or profile links (only an account entry)", async () => {
    const x = new RealishX({ url: "https://x.com/mecharoyalecom", account: { name: "Rooftop Chat", handle: "@rooftopchat" } });
    const r = await switchXAccount(x.caller(), "@mecharoyalecom", { sleep: noSleep });
    // What it clicked on the page, and whether it followed the account it was asked to switch to.
    // Whatever else happens, the answer must not claim it clicked the account's entry.
    expect({ strayClicks: x.strayClicks, follows: x.follows, text: r.text }).toEqual({
      strayClicks: [],
      follows: [],
      text: expect.not.stringMatching(/clicked the @mecharoyalecom entry/),
    });
  });
});

describe("A: nothing is published on X as another account than the task's", () => {
  it("a Post click is refused while X's switcher shows another account than the task's", async () => {
    // Signed in as @alice (the switch to @bob failed); the task is @bob's.
    const x = new FakeX({ url: "https://x.com/home", account: "alice", accounts: ["alice", "bob"] });
    const { onEvent } = collect();
    const exec = createToolExecutor({
      browser: x.caller(),
      jev: null,
      jevThreshold: 0.8,
      onEvent,
      mediaPaths: [],
      sleep: noSleep,
      onTaskEnd: () => {},
      // The task's X account (the job's `account`).
      account: "@bob",
    } as Parameters<typeof createToolExecutor>[0]);
    const page = x.snapshot();
    const box = page.elements.find((e) => e.testId === "tweetTextarea_0")!.index;
    await exec.call("act", { steps: [{ goal: "type the post", index: box, text: "Group chat etiquette: typing for 4 minutes then sending lol" }] });
    const post = x.snapshot().elements.find((e) => e.name === "Post" && e.role === "button")!.index;
    const r = await exec.call("act", { steps: [{ goal: "click the Post button", index: post }] });
    expect(x.posts.map((p) => `${p.account}: ${p.text}`)).toEqual([]);
    expect(r.isError).toBe(true);
  });

  it("verifyXPost fails for a post that went out on another account than the task's", async () => {
    const text = "Group chat etiquette: typing for 4 minutes and then sending lol is a valid contribution.";
    const x = new FakeX({ posts: [{ account: "mecharoyalecom", text, files: [], url: "https://x.com/mecharoyalecom/status/2104445831705477232" }] });
    const verify = verifyXPost as (b: BrowserCaller, url: string, text: string, account?: string) => ReturnType<typeof verifyXPost>;
    const v = await verify(x.caller(), "https://x.com/mecharoyalecom/status/2104445831705477232", text, "@rooftopchat");
    expect(v.ok).toBe(false);
  });
});
