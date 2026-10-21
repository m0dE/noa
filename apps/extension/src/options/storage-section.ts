/**
 * Settings > Storage: the account's cloud files (how full, a way to browse them on the dashboard), where Noa keeps
 * the files it saves (cloud, this computer or both; fileStorage) and the Noa folder on this computer. The summary is asked for whenever the section is drawn, at most
 * once a minute unless the account changed; storage-view.ts decides what shows.
 */
import { errorMessage, type ExtensionSettings } from "@noa/shared";
import { openBilling, openCloudFiles } from "../ui/billing.js";
import { $, busy, flash, h, showError } from "../ui/dom.js";
import { uiRequest, type StorageSummary, type UiState } from "../ui-protocol.js";
import { storageView } from "./storage-view.js";

/** A summary is reused this long (the cloud files' usage changes slowly; the section is drawn often). */
const SUMMARY_MS = 60_000;

export interface StorageSection {
  render(state: UiState): void;
}

export function initStorageSection(opts: { onState(state: UiState): void; signIn(button: HTMLButtonElement, note: HTMLElement): void }): StorageSection {
  const msg = $("storage-msg");
  const browse = $<HTMLButtonElement>("storage-browse");
  const action = $<HTMLButtonElement>("storage-action");
  let last: UiState | null = null;
  let summary: StorageSummary | null = null;
  let asked: { at: number; who: string } | null = null;

  async function save(patch: Partial<ExtensionSettings>): Promise<void> {
    try {
      opts.onState(await uiRequest({ type: "settings.save", settings: patch }));
    } catch (err) {
      flash(msg, `Not saved: ${errorMessage(err)}`, "bad");
    }
  }

  const draw = (): void => {
    if (!last) return;
    const v = storageView({ settings: last.settings, account: last.account }, summary);
    const cloud = $("storage-cloud");
    cloud.textContent = v.cloud;
    cloud.dataset.tone = v.tone;
    const meter = $("storage-meter");
    meter.hidden = v.fraction === null;
    meter.dataset.tone = v.tone;
    meter.setAttribute("aria-label", v.cloud);
    $("storage-meter-fill").style.width = `${((v.fraction ?? 0) * 100).toFixed(1)}%`;
    browse.hidden = !v.browse;
    action.hidden = !v.action;
    action.textContent = v.action === "sign-in" ? "Sign in" : "See plans";
    $("storage-where").replaceChildren(
      ...v.where.map((o) =>
        h(
          "div.opt",
          { "data-storage": o.id },
          h(
            "label.opt-head",
            null,
            h("input", { type: "radio", name: "fileStorage", value: o.id, checked: o.checked, disabled: o.disabled, onchange: () => void save({ fileStorage: o.id }) }),
            h("span.opt-text", null, h("b", null, o.label), h("small.opt-detail", null, o.detail)),
          ),
        ),
      ),
    );
    const note = $("storage-where-note");
    note.textContent = v.whereNote;
    note.hidden = !v.whereNote;
    $("storage-folder").textContent = v.folder;
  };

  /** The background's summary, again when the account changed or it is older than SUMMARY_MS. */
  const refresh = (state: UiState, force = false): void => {
    const who = `${state.account?.signedIn ? (state.account.user?.email ?? "") : ""}|${state.account?.plan?.id ?? ""}`;
    if (!force && asked && asked.who === who && Date.now() - asked.at < SUMMARY_MS) return;
    asked = { at: Date.now(), who };
    void uiRequest({ type: "storage.summary" }).then(
      (s) => {
        summary = s;
        draw();
      },
      (err: unknown) => showError(msg, err),
    );
  };

  browse.addEventListener("click", () => void openCloudFiles(last?.account).catch((err: unknown) => showError(msg, err)));
  action.addEventListener("click", () => {
    if (action.textContent === "Sign in") opts.signIn(action, msg);
    else void openBilling(last?.account ?? null).catch((err: unknown) => showError(msg, err));
  });
  const open = $<HTMLButtonElement>("storage-open");
  open.addEventListener("click", () => void busy(open, () => uiRequest({ type: "folder.open" }), msg));
  // Back from the dashboard (files uploaded or deleted there): count again.
  addEventListener("focus", () => last && refresh(last, true));

  return {
    render(state) {
      last = state;
      draw();
      refresh(state);
    },
  };
}
