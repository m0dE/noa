/**
 * The account avatar and its menu, shared by the side panel's header and the
 * options page's header: the user's picture (or initial; a person icon when
 * signed out), and a menu with the email and the plan and credit, then the
 * page's own items, each shown signed in, signed out or always. Signed out, the
 * icon carries a "Login" label. Any item
 * closes the menu. Styles: ui.css (.acct).
 */
import { formatCents, OUT_OF_CREDIT, PLAN_FEATURE_TEXT, planName } from "@noa/shared";
import { todoAllowed } from "../account/types.js";
import type { AccountView } from "../ui-protocol.js";
import { showAvatar } from "./avatar.js";
import { h } from "./dom.js";

export interface AccountMenuItem {
  /** The button's id (pages and tests address items by it). */
  id: string;
  label: string;
  show: "signed-in" | "signed-out" | "always";
  tone?: "bad";
  run(button: HTMLButtonElement): void;
}

export interface AccountMenu {
  readonly el: HTMLDetailsElement;
  render(account: AccountView | undefined): void;
  item(id: string): HTMLButtonElement;
}

const PERSON_ICON =
  '<svg class="acct-anon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="5.6" r="2.6"/><path d="M2.8 13.6c.9-2.4 2.9-3.6 5.2-3.6s4.3 1.2 5.2 3.6" stroke-linecap="round"/></svg>';

/** "Plus plan · $15.40 usage credit"; a plan without the TODO list says so. */
export function planLine(a: AccountView): { text: string; warn: boolean } {
  const plan = a.plan ? `${planName(a.plan.id)} plan${todoAllowed(a.plan) ? "" : `, no ${PLAN_FEATURE_TEXT.todo.name}`}` : "";
  const credit = a.credit ? `${formatCents(a.credit.totalCents)} usage credit` : "";
  return { text: [plan, a.outOfCredit ? OUT_OF_CREDIT : credit].filter(Boolean).join(" · "), warn: !!a.outOfCredit };
}

/** The avatar button and its menu; `id` names the <details> (and `${id}-btn`, `${id}-menu`). */
export function createAccountMenu(opts: { id: string; items: AccountMenuItem[]; signedOutTitle: string }): AccountMenu {
  const img = h("img.acct-avatar", { alt: "", referrerpolicy: "no-referrer", hidden: true }) as HTMLImageElement;
  const initial = h("span.acct-initial", { "aria-hidden": "true" });
  const summary = h("summary", { id: `${opts.id}-btn`, "aria-label": "Account and settings" }, img, initial);
  summary.insertAdjacentHTML("beforeend", PERSON_ICON);
  summary.append(h("span.acct-label", null, "Login"));
  const email = h("div.acct-email");
  const plan = h("div.acct-plan");
  const buttons = new Map<string, HTMLButtonElement>();
  const items = opts.items.map((it) => {
    const b = h("button", { type: "button", id: it.id, "data-show": it.show, class: it.tone }, it.label);
    b.addEventListener("click", () => it.run(b));
    buttons.set(it.id, b);
    return b;
  });
  const pop = h("div.menu-pop.acct-pop", { id: `${opts.id}-menu` }, h("div.acct-who", null, email, plan), ...items);
  const el = h("details.menu.acct", { id: opts.id }, summary, pop) as HTMLDetailsElement;
  pop.addEventListener("click", (e) => {
    if ((e.target as Element).closest("button")) el.open = false;
  });

  return {
    el,
    item(id) {
      const b = buttons.get(id);
      if (!b) throw new Error(`No account menu item ${id}`);
      return b;
    },
    render(a) {
      const user = a?.signedIn ? a.user : undefined;
      el.toggleAttribute("data-signed-in", !!user);
      showAvatar(img, initial, user ?? null);
      if (!a || !user) {
        summary.title = opts.signedOutTitle;
        return;
      }
      const who = user.name ? `${user.name} (${user.email})` : user.email;
      summary.title = `Signed in as ${who}`;
      email.textContent = user.email;
      email.title = who;
      const line = planLine(a);
      plan.textContent = line.text;
      plan.dataset.tone = line.warn ? "warn" : "";
    },
  };
}
