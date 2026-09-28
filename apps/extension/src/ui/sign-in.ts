/** The Google sign-in every Log in button starts (the options page). */
import { SIGN_IN_NOT_SET_UP } from "../account/google-auth.js";
import { uiRequest, type AccountView, type UiState } from "../ui-protocol.js";
import { busy, flash } from "./dom.js";

/** The account before the background has said anything about it. */
export const SIGNED_OUT: AccountView = { signedIn: false, signInConfigured: false, apiBase: "", dashboardUrl: "", billingUrl: "" };

/**
 * Signs in with Google from `button`: progress and problems show in `note`,
 * the signed-in state goes to `onState`. Says so at once when this build has
 * no Google client ID.
 */
export function signIn(
  button: HTMLButtonElement,
  note: HTMLElement,
  account: AccountView | null,
  onState: (state: UiState) => void | Promise<void>,
): void {
  if (account && !account.signInConfigured) return flash(note, SIGN_IN_NOT_SET_UP, "bad");
  void busy(
    button,
    async () => {
      flash(note, "Continue in the Google window…");
      const state = await uiRequest({ type: "account.signIn" });
      flash(note, "");
      await onState(state);
    },
    note,
  );
}
