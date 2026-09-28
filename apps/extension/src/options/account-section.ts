/**
 * Options page: the Account tab (sign-in, plan and credit, the one billing
 * button, sign out) and the API keys tab. Buying happens on the dashboard's
 * Billing page only: the billing buttons open it in a new tab (ui/billing.ts),
 * and coming back refreshes the plan and credit. When the server has no
 * billing, a plain note replaces the button.
 */
import { API_KEY_LIMITS, API_KEY_ROLE_LABELS, apiKeyRoleLabel, OUT_OF_CREDIT } from "@noa/shared";
import { SIGN_IN_NOT_SET_UP } from "../account/google-auth.js";
import type { KeyRole } from "../account/types.js";
import { showAvatar } from "../ui/avatar.js";
import { openBilling, openDashboard, refreshOnReturn } from "../ui/billing.js";
import { $, busy, flash, h, showError } from "../ui/dom.js";
import { signIn, SIGNED_OUT } from "../ui/sign-in.js";
import { uiRequest, type AccountView, type ApiKeyInfo, type UiState } from "../ui-protocol.js";
import { accountSummary, dateLabel, keysLockedText } from "./account-view.js";

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
  const keysMsg = $("keys-msg");

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

  // Sign in / out (also from the AI tab's "Log in to use Noa AI" and the API keys tab).
  const signInWith = (button: HTMLButtonElement, note: HTMLElement): void => signIn(button, note, account, opts.onState);
  const signInBtn = $<HTMLButtonElement>("acct-signin");
  signInBtn.addEventListener("click", () => signInWith(signInBtn, $("acct-signin-msg")));
  const keysSignIn = $<HTMLButtonElement>("keys-signin");
  keysSignIn.addEventListener("click", () => signInWith(keysSignIn, $("keys-signin-msg")));
  const signOut = $<HTMLButtonElement>("acct-signout");
  signOut.addEventListener("click", () => void busy(signOut, async () => opts.onState(await uiRequest({ type: "account.signOut" })), msg));
  const reload = $<HTMLButtonElement>("acct-reload");
  reload.addEventListener("click", () => void busy(reload, () => refresh(true), msg));
  const billingButtons = [$<HTMLButtonElement>("acct-billing-open"), $<HTMLButtonElement>("keys-billing-open")];
  for (const b of billingButtons) b.addEventListener("click", billing);
  $("acct-dashboard").addEventListener("click", () => void openDashboard(account).catch((err: unknown) => showError(msg, err)));

  function renderAccount(a: AccountView): void {
    $("acct-out").hidden = a.signedIn;
    $("acct-in").hidden = !a.signedIn;
    signOut.hidden = !a.signedIn;
    for (const b of [signInBtn, keysSignIn]) b.title = a.signInConfigured ? "" : SIGN_IN_NOT_SET_UP;
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
    $("acct-billing").hidden = $("keys-billing").hidden = sum.billing === "not-set-up";
    for (const b of billingButtons) b.textContent = sum.billingLabel;
    $("acct-dashboard").hidden = !a.dashboardUrl;
    if (a.fetchedAt) reload.title = `Loaded ${dateLabel(a.fetchedAt)}; load plan and credit again`;
  }

  // API keys
  const keysList = $("keys-list");
  const keyName = $<HTMLInputElement>("key-name");
  const keyRole = $<HTMLSelectElement>("key-role");
  const create = $<HTMLButtonElement>("key-create");
  let keysLoadedFor = "";
  keyRole.replaceChildren(...Object.entries(API_KEY_ROLE_LABELS).map(([role, r]) => h("option", { value: role, title: r.hint }, r.label)));
  $("keys-rate").textContent = String(API_KEY_LIMITS.requestsPerMinute);
  $("keys-locked-text").textContent = keysLockedText();

  async function loadKeys(): Promise<void> {
    try {
      const { keys } = await uiRequest({ type: "account.keys.list" });
      renderKeys(keys);
    } catch (err) {
      showError(keysMsg, err);
    }
  }

  function renderKeys(keys: ApiKeyInfo[]): void {
    const live = keys.filter((k) => !k.revokedAt);
    keysList.replaceChildren(
      ...(live.length
        ? live.map((k) => {
            const revoke = h("button.small.danger", { type: "button" }, "Revoke");
            revoke.addEventListener("click", () =>
              void busy(
                revoke,
                async () => {
                  await uiRequest({ type: "account.keys.revoke", id: k.id });
                  flash(keysMsg, `Revoked ${k.name}.`, "ok");
                  await loadKeys();
                },
                keysMsg,
              ),
            );
            return h("li", null, h("span.key-name", { title: k.name }, k.name), h("span.chip", null, apiKeyRoleLabel(k.role)), h("span.muted", null, dateLabel(k.createdAt)), revoke);
          })
        : [h("li.empty", null, "No keys yet.")]),
    );
  }

  create.addEventListener("click", () =>
    void busy(
      create,
      async () => {
        const name = keyName.value.trim();
        if (!name) return flash(keysMsg, "Give the key a name.", "bad");
        const k = await uiRequest({ type: "account.keys.create", name, role: keyRole.value as KeyRole });
        keyName.value = "";
        $("key-value").textContent = k.key;
        $("key-new").hidden = false;
        flash(keysMsg, "");
        await loadKeys();
      },
      keysMsg,
    ),
  );
  const copy = $<HTMLButtonElement>("key-copy");
  copy.addEventListener("click", () =>
    void navigator.clipboard.writeText($("key-value").textContent ?? "").then(
      () => flash(keysMsg, "Copied.", "ok"),
      () => flash(keysMsg, "Could not copy; select the key and copy it by hand.", "bad"),
    ),
  );

  /** Signed out: Log in. A plan without keys: what they come with, and the billing button. Else the keys. */
  function renderKeysTab(a: AccountView): void {
    const allowed = a.signedIn && accountSummary(a).keysAllowed;
    $("keys-out").hidden = a.signedIn;
    $("keys-locked").hidden = !a.signedIn || allowed;
    $("keys-body").hidden = !allowed;
    if (!allowed) {
      keysLoadedFor = "";
      $("key-new").hidden = true;
      return;
    }
    const who = a.user?.email ?? "";
    if (keysLoadedFor !== who) {
      keysLoadedFor = who;
      void loadKeys();
    }
  }

  return {
    signIn: signInWith,
    openBilling: billing,
    render(state) {
      account = state.account ?? SIGNED_OUT;
      renderAccount(account);
      renderKeysTab(account);
    },
  };
}
