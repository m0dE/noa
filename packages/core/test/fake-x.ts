/**
 * A tiny in-memory model of X (compose box, account switcher, profile pages
 * and post pages) that answers browser.* calls the way the extension would.
 */
import type { BrowserMethod, BrowserMethods, ElementInfo, PageSnapshot } from "@noa/shared";
import type { BrowserCaller } from "../src/types.js";

interface Action {
  el: ElementInfo;
  /** Part of the open account menu (its nodes are replaced when X re-renders the menu). */
  menu?: boolean;
  onClick?: () => void;
  onType?: (text: string) => void;
  onUpload?: (paths: string[]) => void;
}

export interface FakePost {
  account: string;
  text: string;
  files: string[];
  url: string;
}

export interface FakeXOptions {
  url?: string;
  account?: string;
  accounts?: string[];
  /**
   * The account menu as the real X renders it for an account with delegates (seen in the owner's run logs, Sep 27):
   * the first time the menu opens after a page load it lists the other signed-in accounts ("Switch to @h" buttons,
   * testid=UserCell); moments later X re-renders it with "Delegate accounts" expanded ("Act as" buttons) and
   * "Personal accounts" folded into plain text that is no element at all. The re-render replaces the menu's nodes,
   * and every later opening in the same page load shows the delegate view at once.
   */
  delegates?: string[];
  /** Per page load (the first, the next after a navigation, ...): browser calls after the menu opens before X re-renders it. Default 3. */
  flipAfter?: number[];
  /** The menu was already opened once in the current page load (e.g. by an earlier job in this tab). */
  menuOpenedBefore?: boolean;
  /** The page ignores an untrusted click on a menu entry (only a real mouse press switches). */
  ignoresPageClicks?: boolean;
  hasSwitcher?: boolean;
  credentials?: Record<string, { username: string; password: string }>;
  vaultLocked?: boolean;
  posts?: FakePost[];
}

const cap = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

export const FAKE_JPEG_B64 = btoa("fake-jpeg");

export class FakeX {
  url: string;
  account: string;
  accounts: string[];
  hasSwitcher: boolean;
  menuOpen = false;
  delegates: string[] | null;
  flipAfter: number[];
  /** X has re-rendered the menu in this page load (it shows delegate accounts now). */
  delegateView: boolean;
  pageLoads = 0;
  callsSinceOpen = 0;
  /** "Act as" clicks: delegate switches (never wanted). */
  delegateClicks: string[] = [];
  /** browser.clickXAccountEntry picks that clicked an entry: in the page, or a real press. */
  entryClicks: { handle: string; press: boolean }[] = [];
  ignoresPageClicks: boolean;
  composeText = "";
  files: string[] = [];
  posts: FakePost[];
  calls: { method: string; params: unknown }[] = [];
  credentials: Record<string, { username: string; password: string }>;
  vaultLocked: boolean;
  private actions: Action[] = [];

  constructor(opts: FakeXOptions = {}) {
    this.url = opts.url ?? "https://x.com/compose/post";
    this.account = opts.account ?? "alice";
    this.accounts = opts.accounts ?? ["alice", "bob", "carol"];
    this.delegates = opts.delegates ?? null;
    this.flipAfter = opts.flipAfter ?? [];
    this.delegateView = !!opts.menuOpenedBefore;
    this.hasSwitcher = opts.hasSwitcher ?? true;
    this.ignoresPageClicks = opts.ignoresPageClicks ?? false;
    this.credentials = opts.credentials ?? {};
    this.vaultLocked = opts.vaultLocked ?? false;
    this.posts = opts.posts ?? [];
  }

  private path(): string {
    try {
      const u = new URL(this.url);
      return u.hostname === "x.com" ? u.pathname : "";
    } catch {
      return "";
    }
  }

  private isX(): boolean {
    return this.path() !== "";
  }

  private post(): FakePost | undefined {
    return this.posts.find((p) => p.url === this.url);
  }

  /** /<handle> profile page (not home, compose, i/...). */
  private profile(): string | null {
    const m = /^\/([A-Za-z0-9_]+)\/?$/.exec(this.path());
    return m && m[1] !== "home" ? m[1]! : null;
  }

  title(): string {
    if (this.path().startsWith("/i/flow/login")) return "Log in to X / X";
    const post = this.post();
    if (post) return `${post.account} on X: "${post.text}" / X`;
    return this.isX() ? "Home / X" : "Blank";
  }

  private switchTo(acc: string): void {
    this.account = acc;
    this.menuOpen = false;
    this.url = "https://x.com/home";
    this.newPageLoad();
  }

  private newPageLoad(): void {
    this.pageLoads++;
    this.delegateView = false;
  }

  /** X re-renders the open menu once delegate accounts are in: the old menu nodes are gone. */
  private tick(): void {
    if (!this.delegates || !this.menuOpen || this.delegateView) return;
    this.callsSinceOpen++;
    if (this.callsSinceOpen < (this.flipAfter[this.pageLoads] ?? 3)) return;
    this.delegateView = true;
    this.actions = this.actions.filter((a) => !a.menu);
  }

  snapshot(): PageSnapshot {
    const actions: Action[] = [];
    const add = (el: Omit<ElementInfo, "index" | "inViewport"> & { inViewport?: boolean }, handlers: Omit<Action, "el"> = {}) => {
      actions.push({ el: { inViewport: true, ...el, index: actions.length }, ...handlers });
    };
    let text = "";
    if (this.path().startsWith("/i/flow/login")) {
      add({ tag: "input", role: "textbox", name: "Phone, email, or username", type: "text" });
      add({ tag: "input", role: "textbox", name: "Password", type: "password" });
      text = "Sign in to X";
    } else if (this.isX()) {
      if (this.hasSwitcher) {
        add(
          { tag: "button", role: "button", name: "Account menu", text: `${this.account} @${this.account}`, testId: "SideNav_AccountSwitcher_Button" },
          {
            onClick: () => {
              this.menuOpen = !this.menuOpen;
              this.callsSinceOpen = 0;
            },
          },
        );
      }
      if (this.menuOpen) {
        const menu = (el: Omit<ElementInfo, "index" | "inViewport">, onClick?: () => void) => add(el, { onClick, menu: true } as Omit<Action, "el">);
        if (this.delegateView && this.delegates) {
          for (const d of this.delegates)
            menu({ tag: "button", role: "button", name: "Act as", text: `${cap(d)} @${d}`, testId: "UserCell" }, () => {
              this.delegateClicks.push(d);
              this.menuOpen = false;
              this.url = "https://x.com/i/delegate/switch";
            });
        } else {
          for (const acc of this.accounts.filter((a) => a !== this.account))
            menu({ tag: "button", role: "button", name: `Switch to @${acc}`, text: `${cap(acc)} @${acc}`, testId: "UserCell" }, () => this.switchTo(acc));
        }
        menu({ tag: "a", role: "menuitem", name: "Manage accounts", href: "https://x.com/account/switch", testId: "AccountSwitcher_ManageAccounts_Button" });
        if (this.delegateView && this.delegates) {
          menu({ tag: "a", role: "menuitem", name: "View delegate accounts", href: "https://x.com/i/delegate/delegations", testId: "AccountSwitcher_ManageAccounts_Button" });
        }
        menu({ tag: "a", role: "menuitem", name: `Log out @${this.account}`, href: "https://x.com/logout", testId: "AccountSwitcher_Logout_Button" });
        if (this.delegateView && this.delegates) text += ["Delegate accounts", ...this.delegates.flatMap((d) => [cap(d), `@${d}`]), "Personal accounts", ""].join("\n");
      }
      add({ tag: "a", role: "link", name: "Home", href: "https://x.com/home", testId: "AppTabBar_Home_Link" });
      const post = this.post();
      const profile = this.profile();
      if (post) {
        text = `${post.account}\n${post.text}`;
      } else if (profile) {
        const mine = this.posts.filter((p) => p.account === profile).reverse();
        for (const p of mine) add({ tag: "a", role: "link", name: p.text.slice(0, 50), href: p.url });
        text = `@${profile}\n${mine.map((p) => p.text).join("\n") || "No posts yet"}`;
      } else {
        add(
          { tag: "div", role: "textbox", name: "Post text", testId: "tweetTextarea_0", value: this.composeText || undefined },
          { onType: (t) => (this.composeText += t) },
        );
        add({ tag: "input", role: "textbox", name: "Choose files", type: "file", testId: "fileInput", inViewport: false }, { onUpload: (p) => (this.files = p) });
        add(
          {
            tag: "button",
            role: "button",
            name: "Post",
            testId: this.url.includes("/compose/") ? "tweetButton" : "tweetButtonInline",
            disabled: this.composeText.length === 0,
          },
          {
            onClick: () => {
              if (!this.composeText) return;
              const url = `https://x.com/${this.account}/status/${1000 + this.posts.length}`;
              this.posts.push({ account: this.account, text: this.composeText, files: this.files, url });
              this.composeText = "";
              this.files = [];
              this.url = url;
            },
          },
        );
        text += `What is happening?! Signed in as @${this.account}`;
      }
    }
    this.actions = actions;
    return { url: this.url, title: this.title(), text, elements: actions.map((a) => a.el), truncated: false };
  }

  private find(index: number): Action {
    const a = this.actions.find((x) => x.el.index === index);
    if (!a) throw new Error(`element ${index} not found; call read_page again`);
    return a;
  }

  async handle<M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> {
    this.calls.push({ method, params });
    this.tick();
    return (await this.dispatch(method, params as Record<string, any>)) as BrowserMethods[M]["result"];
  }

  private async dispatch(method: string, p: Record<string, any>): Promise<unknown> {
    switch (method) {
      case "browser.navigate":
        this.url = p.url;
        this.menuOpen = false;
        this.newPageLoad();
        this.snapshot();
        return { url: this.url, title: this.title() };
      case "browser.readPage":
        return this.snapshot();
      case "browser.screenshot":
        return { base64: FAKE_JPEG_B64, mimeType: "image/jpeg" };
      case "browser.click":
        this.find(p.index).onClick?.();
        return { ok: true };
      case "browser.type": {
        const a = this.find(p.index);
        if (!a.onType) throw new Error(`element ${p.index} is not editable`);
        a.onType(p.text);
        return { ok: true };
      }
      case "browser.paste":
      case "browser.pressKey":
      case "browser.scroll":
        return { ok: true };
      case "browser.upload": {
        const a = this.find(p.index);
        if (!a.onUpload) throw new Error(`element ${p.index} is not a file input`);
        a.onUpload(p.paths);
        return { ok: true };
      }
      case "browser.clickXAccountEntry": {
        // Like the page function (page-x-account.ts): the menu as it is at this instant, only a "Switch to" entry.
        const want = String(p.handle).replace(/^@/, "").toLowerCase();
        const shown = this.menuOpen && !(this.delegateView && this.delegates);
        const entry = shown ? this.accounts.find((a) => a !== this.account && a.toLowerCase() === want) : undefined;
        if (!entry) return { clicked: false, reason: this.menuOpen ? `the account menu does not list @${want}` : "the account menu is not open" };
        this.entryClicks.push({ handle: `@${entry}`, press: !!p.press });
        if (!p.press && this.ignoresPageClicks) return { clicked: true };
        this.switchTo(entry);
        return { clicked: true };
      }
      case "browser.currentUrl":
        return { url: this.url };
      case "vault.getCredential": {
        if (this.vaultLocked) return { found: false, locked: true };
        const c = this.credentials[p.site];
        return c ? { found: true, ...c } : { found: false };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /** A BrowserCaller backed by this fake. */
  caller(): BrowserCaller {
    return { call: (method, params) => this.handle(method, params) };
  }
}
