/**
 * Options page: the Account tab (sign-in, plan and credit, the one billing
 * button, sign out). API keys are managed on the dashboard. Buying happens on the dashboard's
 * Billing page only: the billing buttons open it in a new tab (ui/billing.ts),
 * and coming back refreshes the plan and credit. When the server has no
 * billing, a plain note replaces the button.
 */
import { OUT_OF_CREDIT } from "@noa/shared";
import { SIGN_IN_NOT_SET_UP } from "../account/google-auth.js";
import { showAvatar } from "../ui/avatar.js";
import { openBilling, openDashboard, refreshOnReturn } from "../ui/billing.js";
import { $, busy, showError } from "../ui/dom.js";
import { signIn, SIGNED_OUT } from "../ui/sign-in.js";
import { uiRequest, type AccountView, type UiState } from "../ui-protocol.js";
import { accountSummary, dateLabel } from "./account-view.js";
import { bookmarkSyncNote } from "./bookmark-sync-view.js";

/** chrome.storage.local key of the bookmark sync state (bookmarks/sync.ts BOOKMARK_SYNC_KEY). */
const BOOKMARK_SYNC_KEY = "bookmarkSync";

export const BILLING_NOT_SET_UP_NOTE = "Billing isn't set up on this server yet, so plans and top-ups can't be bought here.";

export interface AccountSection {
  render(state: UiState): void;
  /** Google sign-in from any button; progress and errors go to `note`. */
  signIn(button: HTMLButtonElement, note: HTMLElement): void;
  /** The dashboard's Billing page for this account, in a new tab. */
  openBilling(): void;
}

export function initAccountSection(opts: { onState(state: UiState): void }): AccountSection {
  let account: AccountView = SIGNED_OUT;
  const msg = $("acct-msg");

  async function refresh(force = false): Promise<void> {
    try {
      opts.onState(await uiRequest({ type: "account.refresh", force }));
    } catch (err) {
      showError(msg, err);
    }
  }

  const billing = (): void => void openBilling(account).catch((err: unknown) => showError(msg, err));
  // Back from the dashboard: the plan and credit may have changed.
  refreshOnReturn(() => void refresh(true));

  // Sign in / out (also from the AI tab's "Log in to use Noa AI").
  const signInWith = (button: HTMLButtonElement, note: HTMLElement): void => signIn(button, note, account, opts.onState);
  const signInBtn = $<HTMLButtonElement>("acct-signin");
  signInBtn.addEventListener("click", () => signInWith(signInBtn, $("acct-signin-msg")));
  const signOut = $<HTMLButtonElement>("acct-signout");
  signOut.addEventListener("click", () => void busy(signOut, async () => opts.onState(await uiRequest({ type: "account.signOut" })), msg));
  const reload = $<HTMLButtonElement>("acct-reload");
  reload.addEventListener("click", () => void busy(reload, () => refresh(true), msg));
  const billingButton = $<HTMLButtonElement>("acct-billing-open");
  billingButton.addEventListener("click", billing);
  $("acct-dashboard").addEventListener("click", () => void openDashboard(account).catch((err: unknown) => showError(msg, err)));

  // Noa Browser only (its copy of Noa has chrome.bookmarks): the bookmark sync switch, and how the last sync went.
  const bookmarkSwitch = $<HTMLInputElement>("f-bookmarkSync");
  let bookmarkSyncOn = false;
  const drawBookmarkNote = async (): Promise<void> => {
    const stored = (await chrome.storage.local.get(BOOKMARK_SYNC_KEY))[BOOKMARK_SYNC_KEY] as { lastSyncAt?: string; lastError?: string } | undefined;
    $("bookmark-sync-note").textContent = bookmarkSyncNote(bookmarkSyncOn, stored);
  };
  if (chrome.bookmarks) {
    $("bookmark-sync-box").hidden = false;
    bookmarkSwitch.addEventListener("change", () => {
      void uiRequest({ type: "settings.save", settings: { bookmarkSync: bookmarkSwitch.checked } }).then(opts.onState, (err: unknown) => {
        bookmarkSwitch.checked = !bookmarkSwitch.checked;
        showError(msg, err);
      });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[BOOKMARK_SYNC_KEY]) void drawBookmarkNote();
    });
  }

  function renderAccount(a: AccountView): void {
    $("acct-out").hidden = a.signedIn;
    $("acct-in").hidden = !a.signedIn;
    signOut.hidden = !a.signedIn;
    signInBtn.title = a.signInConfigured ? "" : SIGN_IN_NOT_SET_UP;
    if (!a.signedIn || !a.user) return;
    const u = a.user;
    $("acct-name").textContent = u.name || u.email;
    $("acct-mail").textContent = u.name ? u.email : "";
    showAvatar($<HTMLImageElement>("acct-pic"), $("acct-letter"), u);

    const sum = accountSummary(a);
    $("acct-plan").textContent = sum.planName;
    $("acct-plan-status").textContent = sum.planStatus;
    $("acct-plan-includes").textContent = sum.planIncludes;
    $("acct-credit").textContent = sum.outOfCredit ? OUT_OF_CREDIT : sum.credit || "—";
    $("acct-credit-detail").textContent = sum.outOfCredit ? (sum.credit ? `${sum.credit} left` : "") : sum.creditDetail;
    $("credit-fact").dataset.tone = sum.outOfCredit ? "warn" : "";

    const note = $("acct-note");
    const noteText =
      a.error ??
      (sum.billing === "not-set-up"
        ? BILLING_NOT_SET_UP_NOTE
        : sum.outOfCredit
          ? "Tasks on Noa AI are paused until you top up or subscribe."
          : "");
    note.hidden = !noteText;
    note.textContent = noteText;
    note.dataset.tone = a.error || sum.outOfCredit ? "warn" : "";

    // The billing button only when the server can take payments (unknown: shown).
    $("acct-billing").hidden = sum.billing === "not-set-up";
    billingButton.textContent = sum.billingLabel;
    $("acct-dashboard").hidden = !a.dashboardUrl;
    if (a.fetchedAt) reload.title = `Loaded ${dateLabel(a.fetchedAt)}; load plan and credit again`;
  }

  return {
    signIn: signInWith,
    openBilling: billing,
    render(state) {
      account = state.account ?? SIGNED_OUT;
      if (chrome.bookmarks) {
        bookmarkSyncOn = state.settings.bookmarkSync;
        bookmarkSwitch.checked = bookmarkSyncOn;
        void drawBookmarkNote();
      }
      renderAccount(account);
    },
  };
}
