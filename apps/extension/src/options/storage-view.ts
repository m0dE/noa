/**
 * Settings > Storage: what the section says about the user's files, from the settings, the account and the
 * background's summary (storage.summary). Pure; storage-section.ts draws it.
 */
import { CLOUD_FILES_FEATURE, fileStorageFor, formatBytes, planAllows, plural, type ExtensionSettings, type FileStorage } from "@noa/shared";
import type { AccountView, StorageSummary } from "../ui-protocol.js";

export interface StorageView {
  /** The cloud files' line: usage, or why there are none. */
  cloud: string;
  /** How full the cloud files are (0 to 1); null: no meter. */
  fraction: number | null;
  tone: "" | "warn";
  /** Browse cloud files (the dashboard's Files page) is offered. */
  browse: boolean;
  /** The button besides it: sign in, or see plans. */
  action: "sign-in" | "plans" | null;
  /** Where Noa keeps files: the choices, the one in effect checked; cloud and both only when cloud files are there. */
  where: { id: FileStorage; label: string; detail: string; checked: boolean; disabled: boolean }[];
  /** Why the cloud choices are off, or that the user's choice waits for them. */
  whereNote: string;
  /** The Noa folder's line: where it is and how many files it has. */
  folder: string;
  folderPath: string | null;
}

export function storageView(state: { settings: ExtensionSettings; account?: AccountView | undefined }, sum: StorageSummary | null): StorageView {
  const a = state.account;
  const v: StorageView = { cloud: "", fraction: null, tone: "", browse: false, action: null, where: [], whereNote: "", folder: "", folderPath: sum?.folder ?? null };
  // What the plan includes; the account server's own answer (locked) replaces it once it is known.
  let cloudAllowed = !!a?.signedIn && planAllows(a.plan, CLOUD_FILES_FEATURE);

  if (!a?.signedIn) {
    v.cloud = "Sign in to keep copies of your files in your Noa account, on every computer you sign in on.";
    v.action = "sign-in";
  } else if (!sum) {
    v.cloud = "Loading your cloud files…";
  } else if (sum.cloudError) {
    v.cloud = `Your cloud files could not be loaded: ${sum.cloudError}`;
    v.tone = "warn";
    v.browse = !!a.filesUrl;
  } else {
    const c = sum.cloud;
    if (c) cloudAllowed = !c.locked;
    if (c) {
      v.fraction = Math.min(1, c.usedBytes / c.quotaBytes);
      v.browse = !!a.filesUrl && (cloudAllowed || c.files > 0);
    }
    if (!cloudAllowed) {
      v.cloud = c?.files
        ? `Cloud files come with a paid plan. The ${plural(c.files, "file")} kept before stay${c.files === 1 ? "s" : ""}: you can browse, download and delete them.`
        : "Cloud files come with a paid plan. Until then, files stay in the Noa folder on this computer.";
      v.action = "plans";
    } else if (c) {
      v.cloud = `${formatBytes(c.usedBytes)} of ${formatBytes(c.quotaBytes)} used · ${plural(c.files, "file")}`;
      if (v.fraction !== null && v.fraction >= 0.9) v.tone = "warn";
    }
  }

  const chosen = state.settings.fileStorage;
  const now = fileStorageFor(chosen, cloudAllowed);
  const CHOICES: [FileStorage, string, string][] = [
    ["cloud", "Cloud", "In your cloud files, on every computer you sign in on. When Noa puts one on a page, it downloads it to the Noa folder first."],
    ["local", "This computer", "In the Noa folder on this computer only. Signed out or without a paid plan, files are always kept here."],
    ["both", "Both", "In your cloud files and in the Noa folder on this computer."],
  ];
  v.where = CHOICES.map(([id, label, detail]) => ({ id, label, detail, checked: id === now, disabled: id !== "local" && !cloudAllowed }));
  if (!cloudAllowed) {
    v.whereNote =
      chosen && chosen !== "local"
        ? `You chose ${chosen === "cloud" ? "Cloud" : "Both"}: files are kept on this computer until you are signed in on a plan with cloud files.`
        : a?.signedIn
          ? "Cloud files come with a paid plan: until then, files are kept on this computer."
          : "Sign in on a plan with cloud files to keep them in the cloud.";
  } else if (!chosen) v.whereNote = "Cloud is the default for your plan.";

  if (!sum) v.folder = "Finding the folder…";
  else if (!sum.folder) v.folder = `The folder could not be found: ${sum.folderError ?? "unknown error"}`;
  else v.folder = sum.localFiles === null ? `${sum.folder} (Noa's helper is not connected, so its files are not counted)` : `${sum.folder} · ${plural(sum.localFiles, "file")}`;
  return v;
}
