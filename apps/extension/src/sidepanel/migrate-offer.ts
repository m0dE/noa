/**
 * Over the jobs list after the first sign-in with tasks saved in this browser: "Move them to your account?"
 * (account.migrate), or Not now (account.dismissMigration). Shown while AccountView.localTasks is above 0.
 */
import { plural } from "@noa/shared";
import { uiRequest, type AccountView, type UiState } from "../ui-protocol.js";
import { $, busy, flash, showError } from "../ui/dom.js";

export function initMigrateOffer(opts: { onState(state: UiState): void; onMoved(text: string): void }): { render(account: AccountView | undefined): void } {
  const card = $("migrate");
  const text = $("migrate-text");
  const msg = $("migrate-msg");
  const go = $<HTMLButtonElement>("migrate-go");
  go.addEventListener("click", () =>
    void busy(
      go,
      async () => {
        flash(msg, "Moving…");
        const r = await uiRequest({ type: "account.migrate" });
        if (r.failed) flash(msg, `Moved ${r.moved}; ${r.failed} could not be moved: ${r.errors[0] ?? ""}`, "bad");
        else {
          flash(msg, "");
          opts.onMoved(`Moved ${plural(r.moved, "task")} to your account.`);
        }
        opts.onState(r.state);
      },
      msg,
    ),
  );
  $("migrate-later").addEventListener("click", () =>
    void uiRequest({ type: "account.dismissMigration" })
      .then((state) => opts.onState(state))
      .catch((err: unknown) => showError(msg, err)),
  );

  return {
    render(account) {
      const n = account?.signedIn ? (account.localTasks ?? 0) : 0;
      card.hidden = n === 0;
      if (!n) return;
      const one = n === 1;
      text.textContent = `You have ${plural(n, "task")} saved in this browser. Move ${one ? "it" : "them"} to your account so ${one ? "it runs" : "they run"} from there?`;
      go.textContent = `Move ${plural(n, "task")} to your account`;
    },
  };
}
