/**
 * The user's Noa folder: Downloads/Noa. The download folder is the one place Chrome lets an extension write on
 * every OS (Windows, macOS, Linux), and a place users know; Documents is often synced to OneDrive on Windows.
 *
 * Opening it: the folder's README, which the extension writes there, shown in the system's file manager
 * (chrome.downloads.show: Explorer, Finder, the Linux file manager), which opens the folder with it selected. The
 * README is written again when it is gone (deleted, or the download history cleared). A user who moved Chrome's
 * download folder gets Noa in that folder.
 */
import { errorMessage } from "@noa/shared";
import { writeDownload, type DownloadsLike } from "./media-files.js";

export const NOA_FOLDER = "Noa";
const README = `${NOA_FOLDER}/README.txt`;
/** chrome.storage.local: the README's download id. */
const README_ID_KEY = "noaFolderReadmeId";

export const README_TEXT = [
  "This is your Noa folder.",
  "",
  "Keep files, folders and images here that you want Noa to work with.",
  "",
].join("\r\n");

interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class NoaFolder {
  constructor(
    private readonly opts: { downloads?: DownloadsLike; storage?: StorageAreaLike; timeoutMs?: number } = {},
  ) {}

  private get downloads(): DownloadsLike {
    return this.opts.downloads ?? chrome.downloads;
  }

  private get storage(): StorageAreaLike {
    return this.opts.storage ?? chrome.storage.local;
  }

  /** Opens the folder in the system's file manager (creating it first); returns its absolute path. */
  async open(): Promise<string> {
    const readme = await this.readme();
    if (!this.downloads.show) throw new Error("This browser cannot open folders");
    this.downloads.show(readme.id);
    // The folder the README is in, whatever name Chrome gave the file.
    return readme.path.replace(/[\\/][^\\/]*$/, "");
  }

  /** The README that is there, else a new one. */
  private async readme(): Promise<{ id: number; path: string }> {
    const stored = (await this.storage.get(README_ID_KEY))[README_ID_KEY];
    if (typeof stored === "number") {
      const [item] = await this.downloads.search({ id: stored });
      if (item?.state === "complete" && item.exists !== false && item.filename) return { id: stored, path: item.filename };
    }
    const dl = this.downloads;
    let id: number | null = null;
    await dl.setUiOptions?.({ enabled: false }).catch(() => {});
    try {
      const url = `data:text/plain;charset=utf-8,${encodeURIComponent(README_TEXT)}`;
      const path = await writeDownload(dl, { url, filename: README, conflictAction: "overwrite" }, (i) => (id = i), this.opts.timeoutMs ?? 30_000);
      await this.storage.set({ [README_ID_KEY]: id });
      return { id: id!, path };
    } catch (err) {
      throw new Error(`Could not create the Noa folder in Downloads: ${errorMessage(err)}`);
    } finally {
      await dl.setUiOptions?.({ enabled: true }).catch(() => {});
    }
  }
}
