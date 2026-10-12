/**
 * Options page: the masked key fields (Anthropic API key, Jev API key).
 * A saved key shows as Set with Replace and Remove; otherwise
 * a password field with its own Save button. Keys never auto-save.
 */
import { REDACTED, SECRET_SETTING_KEYS, type ExtensionSettings } from "@noa/shared";
import { busy, find, flash, h } from "../ui/dom.js";
import type { SecretKey } from "./settings-patch.js";

const SECRET_LABELS: Record<SecretKey, string> = { anthropicApiKey: "Anthropic API key", jevApiKey: "Jev API key" };

export interface SecretFieldDeps {
  /** The saved settings (secrets redacted to REDACTED / ""). */
  saved(): ExtensionSettings | null;
  /** Saves one key; false when it could not (the page says why). */
  save(patch: Partial<ExtensionSettings>): Promise<boolean>;
}

/** Returns a function that renders every key field from the saved settings. */
export function initSecretFields(deps: SecretFieldDeps): () => void {
  /** Keys being replaced (Replace clicked). */
  const replacing = new Set<SecretKey>();
  /** A note from the last action on a key, shown once in its re-rendered field. */
  const notes: Partial<Record<SecretKey, string>> = {};

  function render(key: SecretKey): void {
    const host = find(document, `[data-secret=${key}]`);
    const label = find(host, "span");
    const isSet = deps.saved()?.[key] === REDACTED;
    const note = h("p.msg", { role: "status" });
    const last = notes[key];
    delete notes[key];
    if (last) flash(note, last, "ok");
    const done = (text: string) => {
      notes[key] = text;
      render(key);
    };
    const edit = (replace: boolean) => {
      if (replace) replacing.add(key);
      else replacing.delete(key);
      render(key);
    };
    let row: HTMLElement;
    if (isSet && !replacing.has(key)) {
      const remove = h("button.small.danger", { type: "button" }, "Remove");
      remove.addEventListener("click", () =>
        void busy(
          remove,
          async () => {
            if (await deps.save({ [key]: "" })) done(`${SECRET_LABELS[key]} removed.`);
          },
          note,
        ),
      );
      const replace = h("button.small", { type: "button" }, "Replace");
      replace.addEventListener("click", () => {
        edit(true);
        host.querySelector("input")?.focus();
      });
      row = h("div.secret-row", null, h("div.secret-state", null, h("b", null, "Set"), h("span", null, "••••••••")), replace, remove);
    } else {
      const field = h("input", {
        type: "password",
        placeholder: isSet ? "New key" : "Paste the key",
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": SECRET_LABELS[key],
      });
      const save = h("button.small.primary", { type: "button", disabled: true }, "Save");
      const doSave = () =>
        void busy(
          save,
          async () => {
            const value = field.value.trim();
            if (!value) return flash(note, "Paste a key first.", "bad");
            replacing.delete(key);
            if (await deps.save({ [key]: value })) done(`${SECRET_LABELS[key]} saved.`);
            else replacing.add(key);
          },
          note,
        ).then(() => {
          save.disabled = !field.value.trim();
        });
      field.addEventListener("input", () => (save.disabled = !field.value.trim()));
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          doSave();
        } else if (e.key === "Escape" && isSet) {
          edit(false);
        }
      });
      save.addEventListener("click", doSave);
      const cancel = isSet ? h("button.small.ghost", { type: "button", onclick: () => edit(false) }, "Cancel") : null;
      row = h("div.secret-row", null, field, save, cancel);
    }
    host.replaceChildren(label, row, note);
  }

  return () => {
    for (const key of SECRET_SETTING_KEYS) render(key);
  };
}
