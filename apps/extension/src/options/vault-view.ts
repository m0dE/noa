/** Pure logic for the options page's Site logins tab: what the vault's state and the forgot flow show. */
import type { UiResults } from "../ui-protocol.js";

/** Wrong passphrases in a row before "Forgot passphrase?" is offered prominently (no lockout: PBKDF2 already slows guessing). */
export const WRONG_TRIES_BEFORE_PROMINENT = 3;

/** "Forgot passphrase?": closed, explaining that only an erase gets out, or asking to confirm the erase. */
export type ForgotStep = "closed" | "explain" | "confirm";

export interface VaultUi {
  /** Wrong passphrases in a row since the page opened or the last unlock. */
  wrongTries: number;
  forgotStep: ForgotStep;
}

export interface VaultPanel {
  /** create: no passphrase set yet; unlock: saved logins behind a passphrase; open: unlocked. */
  mode: "create" | "unlock" | "open";
  passPlaceholder: string;
  unlockLabel: string;
  /** Say before the passphrase is chosen that forgetting it means erasing the logins. */
  createNote: boolean;
  /** How "Forgot passphrase?" is offered: not at all (nothing to forget), as a quiet link, or prominently after wrong tries. */
  forgot: "none" | "quiet" | "prominent";
  /** The words before the prominent link: "Wrong passphrase 3 times in a row." */
  forgotLead: string;
  forgotStep: ForgotStep;
  eraseLabel: string;
  /** Shown while confirming: "Erase 3 saved logins? This can't be undone." */
  eraseQuestion: string;
}

export function vaultPanel(v: UiResults["vault.list"], ui: VaultUi): VaultPanel {
  const mode = !v.exists ? "create" : v.locked ? "unlock" : "open";
  const creating = mode === "create";
  const forgot = mode !== "unlock" ? "none" : ui.wrongTries >= WRONG_TRIES_BEFORE_PROMINENT ? "prominent" : "quiet";
  const forgotStep = forgot === "none" ? "closed" : ui.forgotStep;
  const count = v.sites.length;
  const confirming = forgotStep === "confirm";
  return {
    mode,
    passPlaceholder: creating ? "Choose a passphrase" : "Passphrase",
    unlockLabel: creating ? "Set passphrase" : "Unlock",
    createNote: creating,
    forgot,
    forgotLead: forgot === "prominent" ? `Wrong passphrase ${ui.wrongTries} times in a row.` : "",
    forgotStep,
    eraseLabel: !confirming ? "Erase saved logins" : count ? `Yes, erase ${count} ${logins(count)}` : "Yes, start over",
    eraseQuestion: confirming ? eraseQuestion(count) : "",
  };
}

export function eraseQuestion(count: number): string {
  if (!count) return "There are no saved logins to lose. Start over with a new passphrase?";
  return `Erase ${count} saved ${logins(count)}? This can't be undone.`;
}

/** After the erase: what went, and what to do next. */
export function erasedMessage(count: number): string {
  return `${count ? `Erased ${count} saved ${logins(count)}. ` : ""}Choose a new passphrase to start over.`;
}

function logins(count: number): string {
  return count === 1 ? "login" : "logins";
}
