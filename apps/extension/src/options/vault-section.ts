/** Options page: the "Site logins" section (encrypted vault used by get_credential). */
import { uiRequest, type UiResults } from "../ui-protocol.js";
import { $, busy, flash, h, showError } from "../ui/dom.js";
import { erasedMessage, vaultPanel, type VaultUi } from "./vault-view.js";

export function initVaultSection(): void {
  const locked = $("vault-locked");
  const open = $("vault-open");
  const list = $("vault-sites");
  const msg = $("vault-msg");
  const pass = $<HTMLInputElement>("vault-pass");
  const site = $<HTMLInputElement>("vault-site");
  const user = $<HTMLInputElement>("vault-user");
  const pw = $<HTMLInputElement>("vault-pw");

  const unlock = $<HTMLButtonElement>("vault-unlock");
  const createNote = $("vault-create-note");
  const forgotRow = $("vault-forgot-row");
  const forgotLead = $("vault-forgot-lead");
  const forgotLink = $<HTMLButtonElement>("vault-forgot");
  const forgotBox = $("vault-forgot-box");
  const eraseQuestion = $("vault-erase-question");
  const erase = $<HTMLButtonElement>("vault-erase");
  const eraseCancel = $<HTMLButtonElement>("vault-erase-cancel");

  let vault: UiResults["vault.list"] = { exists: true, locked: true, sites: [] };
  const ui: VaultUi = { wrongTries: 0, forgotStep: "closed" };

  /** Shows the passphrase field, "Forgot passphrase?" and its steps for the vault's state. */
  function render(): void {
    const p = vaultPanel(vault, ui);
    locked.hidden = p.mode === "open";
    open.hidden = p.mode !== "open";
    pass.placeholder = p.passPlaceholder;
    unlock.textContent = p.unlockLabel;
    createNote.hidden = !p.createNote;
    forgotRow.hidden = p.forgot === "none";
    forgotRow.toggleAttribute("data-prominent", p.forgot === "prominent");
    forgotLead.textContent = p.forgotLead;
    forgotLink.setAttribute("aria-expanded", String(p.forgotStep !== "closed"));
    forgotBox.hidden = p.forgotStep === "closed";
    eraseQuestion.textContent = p.eraseQuestion;
    erase.textContent = p.eraseLabel;
  }

  async function refresh(): Promise<void> {
    vault = await uiRequest({ type: "vault.list" });
    render();
    list.replaceChildren(
      ...(vault.sites.length
        ? vault.sites.map((s) => {
            const del = h("button.small", { type: "button" }, "Remove");
            del.addEventListener("click", () =>
              void busy(
                del,
                async () => {
                  await uiRequest({ type: "vault.delete", site: s });
                  flash(msg, `Removed ${s}.`, "ok");
                  await refresh();
                },
                msg,
              ),
            );
            return h("li", {}, h("span", {}, s), del);
          })
        : [h("li", { class: "empty" }, vault.locked ? "" : "No saved logins yet.")]),
    );
  }

  const doUnlock = () =>
    void busy(
      unlock,
      async () => {
        const creating = !vault.exists;
        const { ok } = await uiRequest({ type: "vault.unlock", passphrase: pass.value });
        if (!ok) {
          ui.wrongTries++;
          pass.select();
          flash(msg, "Wrong passphrase", "bad");
          return render();
        }
        pass.value = "";
        ui.wrongTries = 0;
        ui.forgotStep = "closed";
        flash(msg, creating ? "Passphrase set. Add your first login." : "Unlocked.", "ok");
        await refresh();
      },
      msg,
    );
  unlock.addEventListener("click", doUnlock);
  pass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doUnlock();
    }
  });

  forgotLink.addEventListener("click", () => {
    ui.forgotStep = ui.forgotStep === "closed" ? "explain" : "closed";
    render();
  });
  eraseCancel.addEventListener("click", () => {
    ui.forgotStep = "closed";
    render();
    forgotLink.focus();
  });
  // Erasing takes a second click on the same button; the second click of a double-click (detail 2) does not count.
  erase.addEventListener("click", (e) => {
    if (ui.forgotStep === "explain") {
      ui.forgotStep = "confirm";
      return render();
    }
    if (ui.forgotStep !== "confirm" || e.detail > 1) return;
    void busy(
      erase,
      async () => {
        const count = vault.sites.length;
        await uiRequest({ type: "vault.reset" });
        ui.wrongTries = 0;
        ui.forgotStep = "closed";
        pass.value = "";
        await refresh();
        flash(msg, erasedMessage(count), "ok", { keep: true });
        pass.focus();
      },
      msg,
    );
  });

  const add = $<HTMLButtonElement>("vault-add");
  add.addEventListener("click", () =>
    void busy(
      add,
      async () => {
        if (!site.value.trim() || !user.value || !pw.value) return flash(msg, "Fill in site, username and password.", "bad");
        await uiRequest({ type: "vault.set", site: site.value.trim(), username: user.value, password: pw.value });
        flash(msg, `Saved the login for ${site.value.trim()}.`, "ok");
        site.value = user.value = pw.value = "";
        await refresh();
      },
      msg,
    ),
  );

  const lock = $<HTMLButtonElement>("vault-lock");
  lock.addEventListener("click", () =>
    void busy(
      lock,
      async () => {
        await uiRequest({ type: "vault.lock" });
        flash(msg, "Locked.", "ok");
        await refresh();
      },
      msg,
    ),
  );

  void refresh().catch((err: unknown) => showError(msg, err));
}
