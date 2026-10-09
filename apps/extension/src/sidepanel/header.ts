/**
 * The side panel's header: "Noa", the jobs view's tabs (job-list.ts), the files button (signed in on a plan with
 * cloud files: the dashboard's Files page; otherwise the Noa folder, Downloads/Noa, in the system's file manager) and
 * the account menu (Log in, Settings, Plan & billing, the Noa folder on this computer, Sign out), and under either
 * view a one-line problem strip that shows only while something stops jobs for the whole account (no AI set up,
 * out of usage credit, a plan without the TODO list) with the button that fixes it. Jobs are paused one by one
 * (their rows and menus), never all at once from here. The brain in use is the brand's tooltip.
 */
import { planAllows } from "@noa/shared";
import { uiRequest, type AccountView, type UiState } from "../ui-protocol.js";
import { openCloudFiles } from "../ui/billing.js";
import { createAccountMenu } from "../ui/account-menu.js";
import { $, busy } from "../ui/dom.js";
import type { ErrorFixKind } from "./error-help.js";
import { runErrorFix } from "./error-view.js";
import { statusLine, type ListFacts } from "./format.js";
import { openSettings } from "./open-settings.js";

export interface HeaderDeps {
  onState(state: UiState): void;
  /** Top up, and Plan & billing in the menu: the dashboard's Billing page. */
  onBilling(): void;
  /** Log in: the Google sign-in. */
  onSignIn(): void;
}

export interface Header {
  render(state: UiState): void;
  /** What the jobs list knows changed (the strip follows). */
  setList(facts: ListFacts): void;
  /** The background could not be reached at all. */
  unreachable(message: string): void;
}

export function initHeader(deps: HeaderDeps): Header {
  const statusEl = $("status");
  const statusText = $("status-text");
  const statusAction = $<HTMLButtonElement>("status-action");
  const brand = $("brand");
  /** A failed header action says why in the problem strip. */
  const say = (message: string) => {
    statusText.textContent = message;
    statusEl.dataset.tone = "bad";
    statusEl.hidden = false;
  };
  const request = async (type: "pause.migrate" | "account.signOut") => deps.onState(await uiRequest({ type }));
  let last: UiState | null = null;
  let list: ListFacts = { lockedWaiting: 0 };
  // Always shown: signed out it offers Log in and Settings, signed in the account too.
  const menu = createAccountMenu({
    id: "acct",
    signedOutTitle: "Log in or open settings",
    items: [
      { id: "acct-login", label: "Log in with Google", show: "signed-out", run: () => deps.onSignIn() },
      { id: "acct-open-settings", label: "Settings", show: "always", run: () => void openSettings() },
      { id: "acct-billing", label: "Plan & billing", show: "signed-in", run: () => deps.onBilling() },
      { id: "acct-folder", label: "Noa folder on this computer", show: "signed-in", run: (b) => void busy(b, () => uiRequest({ type: "folder.open" }), say) },
      { id: "acct-signout", label: "Sign out", show: "signed-in", tone: "bad", run: (b) => void busy(b, () => request("account.signOut"), say) },
    ],
  });
  $("acct-slot").replaceWith(menu.el);
  const folder = $<HTMLButtonElement>("open-folder");
  folder.addEventListener("click", () =>
    void busy(folder, () => (hasCloudFiles(last?.account) ? openCloudFiles(last?.account) : uiRequest({ type: "folder.open" })), say),
  );
  const renderFolder = (account: AccountView | undefined) => {
    const label = hasCloudFiles(account) ? "Open your cloud files" : "Open the Noa folder";
    folder.title = hasCloudFiles(account) ? `${label} (the Noa folder on this computer is in the account menu)` : `${label} (Downloads/Noa)`;
    folder.setAttribute("aria-label", label);
  };

  function renderStatus(s: UiState): void {
    last = s;
    const line = statusLine(s, list);
    brand.title = line.tone === "ok" ? `Working with ${line.text}` : "";
    // All is well: nothing to say.
    statusEl.hidden = line.tone === "ok";
    statusEl.dataset.tone = line.tone;
    statusText.textContent = line.text;
    statusText.title = line.title ?? line.text;
    const action = line.action;
    const retry = action === "retry-pause";
    statusAction.hidden = !action;
    statusAction.textContent = retry ? "Retry" : (action?.label ?? "");
    statusAction.dataset.action = retry ? "retry-pause" : (action?.kind ?? "");
    statusAction.title = retry ? "Try again to pause the account's jobs one by one" : (action?.title ?? "");
  }

  statusAction.addEventListener("click", () => {
    const action = statusAction.dataset.action;
    if (action === "retry-pause") return void busy(statusAction, () => request("pause.migrate"), say);
    // A fix: the same action as the chat's error cards (settings as the fallback).
    if (action && !runErrorFix(action as ErrorFixKind)) void openSettings("ai");
  });

  return {
    render(s) {
      renderStatus(s);
      menu.render(s.account);
      renderFolder(s.account);
    },
    setList(facts) {
      if (facts.lockedWaiting === list.lockedWaiting) return;
      list = facts;
      if (last) renderStatus(last);
    },
    unreachable(message) {
      say(`Background not reachable: ${message}`);
      statusAction.hidden = true;
    },
  };
}

/** Signed in on a plan with cloud files: the files button opens them (the dashboard's Files page). */
export function hasCloudFiles(account: AccountView | undefined): boolean {
  return !!account?.signedIn && !!account.filesUrl && planAllows(account.plan, "todo");
}
