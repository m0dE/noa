/**
 * A small Gmail for live runs of the real agent (realtime-lag.live.ts, NOA_LIVE_AGENT=claude): an inbox of links and
 * email pages with threads, answering the browser.* calls the way the extension would, with page loads that take as
 * long as real ones.
 */
import type { BrowserMethod, BrowserMethods, ElementInfo, PageSnapshot } from "@noa/shared";
import type { BrowserCaller } from "@noa/core";

interface Email {
  id: string;
  from: string;
  subject: string;
  when: string;
  /** The thread, oldest first: [from, text]. */
  thread: [string, string][];
}

const INBOX = "https://mail.google.com/mail/u/0/#inbox";

const EMAILS: Email[] = [
  {
    id: "18f3a",
    from: "Dana Kim",
    subject: "Design review moved to Friday 3 PM",
    when: "10:42 AM",
    thread: [
      ["Dana Kim <dana@acme.io>", "Hi team, I'm moving Friday's design review to 3 PM. Agenda: first the new onboarding flow, then the pricing page. Please bring your mocks. Dana"],
      ["Marco Rossi <marco@acme.io>", "3 PM works for me. See you then. Marco"],
    ],
  },
  {
    id: "18f39",
    from: "GitHub",
    subject: "[m0dE/noa-mono] Run failed: CI - main (a67a2c5)",
    when: "9:15 AM",
    thread: [["GitHub <notifications@github.com>", "The workflow CI failed on branch main for commit a67a2c5. Sent by GitHub Actions for the m0dE/noa-mono repository. View the run to see the failing job: test (extension)."]],
  },
  {
    id: "18f38",
    from: "Stripe",
    subject: "Your weekly payout summary",
    when: "Yesterday",
    thread: [["Stripe <no-reply@stripe.com>", "Your payouts this week totaled $1,284.10. The next payout is scheduled for Monday."]],
  },
  {
    id: "18f3b",
    from: "Neon",
    subject: "Your Neon invoice for September 2026",
    when: "Sep 30",
    thread: [["Neon <billing@neon.tech>", "Invoice NEON-2026-09 for $170.39, billed to jaeyun@gmail.com. Paid automatically on October 1, 2026 with the card ending 4242. Manage your projects at https://console.neon.tech."]],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeGmail {
  url = INBOX;
  private links: { index: number; href: string }[] = [];

  /** The tab as the user sees it when they start (the run acts in it). */
  static readonly start = { url: INBOX, title: "Inbox (4) - jaeyun@acme.io - Gmail" };

  private title(): string {
    if (this.onNeon()) return "Projects - Neon Console";
    const email = this.email();
    return email ? `${email.subject} - jaeyun@acme.io - Gmail` : FakeGmail.start.title;
  }

  /** The Neon console (the invoice's site): its projects and their usage this month. */
  private onNeon(): boolean {
    return /neon\.(tech|com)/.test(this.url);
  }

  private email(): Email | undefined {
    const id = /#inbox\/(\w+)/.exec(this.url)?.[1];
    return EMAILS.find((e) => e.id === id);
  }

  snapshot(): PageSnapshot {
    const elements: ElementInfo[] = [];
    this.links = [];
    const add = (el: Omit<ElementInfo, "index" | "inViewport">, href?: string) => {
      const index = elements.length + 1;
      elements.push({ ...el, index, inViewport: true } as ElementInfo);
      if (href) this.links.push({ index, href });
    };
    if (this.onNeon()) {
      for (const n of ["noa-prod", "noa-staging"]) add({ tag: "a", role: "link", name: n });
      const text = "Projects\nnoa-prod — aws-us-east-2 — compute 412 CU-hrs, storage 18.2 GB — $158.20 this month\nnoa-staging — aws-us-east-2 — compute 31 CU-hrs, storage 1.1 GB — $12.19 this month";
      return { url: this.url, title: this.title(), text, elements, truncated: false };
    }
    add({ tag: "a", role: "link", name: "Inbox 4", href: INBOX }, INBOX);
    const email = this.email();
    let text: string;
    if (email) {
      add({ tag: "div", role: "button", name: "Back to Inbox" }, INBOX);
      add({ tag: "div", role: "button", name: "Reply" });
      text = [email.subject, ...email.thread.flatMap(([from, body]) => [from, body])].join("\n");
    } else {
      for (const e of EMAILS) add({ tag: "tr", role: "link", name: `${e.from} ${e.subject} ${e.when}` }, `${INBOX}/${e.id}`);
      text = ["Inbox", ...EMAILS.map((e) => `${e.from} — ${e.subject} — ${e.when}`)].join("\n");
    }
    return { url: this.url, title: this.title(), text, elements, truncated: false };
  }

  async handle<M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> {
    const p = params as Record<string, any>;
    const tab = () => ({ id: "t1", url: this.url, title: this.title(), current: true });
    switch (method as string) {
      case "browser.navigate":
        await sleep(1_200);
        this.url = String(p.url);
        return { url: this.url, title: this.title() } as never;
      case "browser.readPage":
        await sleep(400);
        return this.snapshot() as never;
      case "browser.screenshot":
        await sleep(300);
        return { base64: btoa("fake-jpeg"), mimeType: "image/jpeg" } as never;
      case "browser.click": {
        await sleep(300);
        const link = this.links.find((l) => l.index === p.index);
        if (link) {
          await sleep(800);
          this.url = link.href;
        }
        return { ok: true } as never;
      }
      case "browser.type":
      case "browser.paste":
      case "browser.pressKey":
      case "browser.scroll":
        await sleep(200);
        return { ok: true } as never;
      case "browser.currentUrl":
        return { url: this.url } as never;
      case "browser.listTabs":
        return { tabs: [tab()] } as never;
      case "browser.switchTab":
        return tab() as never;
      case "browser.waitFor":
        await sleep(300);
        return { met: 0, url: this.url, title: this.title() } as never;
      default:
        throw new Error(`Not available in this test browser: ${method}`);
    }
  }

  caller(): BrowserCaller {
    return { call: (method, params) => this.handle(method, params) };
  }
}
