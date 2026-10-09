/**
 * The user's Noa folder: Downloads/Noa. The download folder is the one place Chrome lets an extension write on
 * every OS (Windows, macOS, Linux), and a place users know; Documents is often synced to OneDrive on Windows.
 *
 * Opening it: the folder's README, which the extension writes there, shown in the system's file manager
 * (chrome.downloads.show: Explorer, Finder, the Linux file manager), which opens the folder with it selected. The
 * README is written again when it is gone (deleted, or the download history cleared). A user who moved Chrome's
 * download folder gets Noa in that folder.
 *
 * Listing it (the agent's list_files, NoaFiles): an extension cannot list a folder, so the helper reads it from disk;
 * without the helper, only the files Chrome itself saved there (its download history) are listed. Signed in, the
 * account's cloud files are listed with them: one that is not on this computer is downloaded into the folder (in its
 * cloud folder: images/ for generated pictures) when the agent uploads it.
 */
import { errorMessage, matchesFileSearch, MAX_LISTED_FILES, type CloudFile, type CloudFileList, type NoaFile, type NoaFileList } from "@noa/shared";
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

/** The folder a file is in, whatever name Chrome gave the file. */
function folderOf(file: string): string {
  return file.replace(/[\\/][^\\/]*$/, "");
}

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
    return folderOf(readme.path);
  }

  /** The folder's absolute path (creating it first), without showing it. */
  async path(): Promise<string> {
    return folderOf((await this.readme()).path);
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

/** A finished download as chrome.downloads.search gives it (the fields NoaFiles reads). */
interface DownloadItemLike {
  id: number;
  filename: string;
  state?: string;
  exists?: boolean;
  fileSize?: number;
  endTime?: string;
  startTime?: string;
}

interface DownloadSearchLike {
  search(query: { state?: string; limit?: number }): Promise<DownloadItemLike[]>;
}

/** A path as a key: any case, either slash. */
function pathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").toLowerCase();
}

/** How long list_files waits for the helper to connect before it lists what Chrome knows instead. */
const HELPER_WAIT_MS = 10_000;

/** list_files (files.list): the files in the Noa folder, newest first. */
export class NoaFiles {
  constructor(
    private readonly deps: {
      folder: Pick<NoaFolder, "path">;
      /** The helper's files.list, connecting it first; rejects when there is no helper. */
      helperList(params: { folder: string; search?: string }, timeoutMs: number): Promise<NoaFileList>;
      downloads?: DownloadSearchLike;
      /**
       * The account's cloud files: list (null when signed out) and download one to `path` in the Noa folder
       * (returns where it was saved). Absent: none are listed.
       */
      cloud?: {
        list(): Promise<CloudFileList | null>;
        download(file: CloudFile, path: string): Promise<string>;
      };
      log?: (message: string) => void;
    },
  ) {}

  /** Cloud files listed but not on this computer, by their path in the folder (pathKey), until they are downloaded. */
  private readonly inCloud = new Map<string, CloudFile>();
  /** Cloud files already downloaded, by the path they were listed under, to the path they were saved at. */
  private readonly fetched = new Map<string, Promise<string>>();

  async list(params: { search?: string }): Promise<NoaFileList> {
    const folder = await this.deps.folder.path();
    const search = params.search?.trim() || undefined;
    const [local, cloud] = await Promise.all([this.local(folder, search), this.cloudList()]);
    if (!cloud?.files.length) return local;
    // A cloud file that is in the folder already (same place, same name) is listed once, as the file here.
    const here = new Set(local.files.map((f) => f.name.toLowerCase()));
    const sep = folder.includes("\\") ? "\\" : "/";
    const extra: NoaFile[] = [];
    for (const c of cloud.files) {
      const name = c.folder ? `${c.folder}/${c.name}` : c.name;
      if (here.has(name.toLowerCase()) || !matchesFileSearch(name, search)) continue;
      const path = [folder, ...name.split("/")].join(sep);
      this.inCloud.set(pathKey(path), c);
      extra.push({ path, name, size: c.size, modified: c.createdAt, cloud: true });
    }
    const files = [...local.files, ...extra].sort((a, b) => b.modified.localeCompare(a.modified));
    return { ...local, files: files.slice(0, MAX_LISTED_FILES), total: local.total + extra.length };
  }

  /**
   * The paths upload is given, each one on this computer: a listed cloud file is downloaded into the Noa folder first
   * (once), and its saved path replaces it. Other paths are returned as they are.
   */
  async fetch(paths: string[]): Promise<string[]> {
    return Promise.all(
      paths.map((p) => {
        const key = pathKey(p);
        const file = this.inCloud.get(key);
        if (!file || !this.deps.cloud) return p;
        let saved = this.fetched.get(key);
        if (!saved) {
          saved = this.deps.cloud.download(file, p).catch((err: unknown) => {
            this.fetched.delete(key);
            throw new Error(`Could not download ${file.name} from the user's cloud files: ${errorMessage(err)}`);
          });
          this.fetched.set(key, saved);
        }
        return saved;
      }),
    );
  }

  private async local(folder: string, search: string | undefined): Promise<NoaFileList> {
    try {
      return await this.deps.helperList(search ? { folder, search } : { folder }, HELPER_WAIT_MS);
    } catch (err) {
      this.deps.log?.(`list_files without the helper (${errorMessage(err)}): only Chrome's own downloads are listed`);
      return this.fromDownloads(folder, search);
    }
  }

  /** The account's cloud files; null when signed out, there are none to list, or they cannot be loaded now. */
  private async cloudList(): Promise<CloudFileList | null> {
    if (!this.deps.cloud) return null;
    try {
      return await this.deps.cloud.list();
    } catch (err) {
      this.deps.log?.(`list_files without the cloud files: ${errorMessage(err)}`);
      return null;
    }
  }

  /** The files in the folder Chrome saved and that are still there, from its download history. */
  private async fromDownloads(folder: string, search: string | undefined): Promise<NoaFileList> {
    const downloads = this.deps.downloads ?? (chrome.downloads as unknown as DownloadSearchLike);
    const items = await downloads.search({ state: "complete", limit: 0 });
    const prefix = folder.replace(/\\/g, "/").toLowerCase() + "/";
    const seen = new Set<string>();
    const files: NoaFile[] = [];
    for (const d of items) {
      const key = d.filename.replace(/\\/g, "/").toLowerCase();
      if (d.exists === false || !key.startsWith(prefix) || seen.has(key)) continue;
      seen.add(key);
      const name = d.filename.slice(folder.length + 1).replace(/\\/g, "/");
      if (name === "README.txt" || !matchesFileSearch(name, search)) continue;
      files.push({ path: d.filename, name, size: Math.max(0, d.fileSize ?? 0), modified: d.endTime ?? d.startTime ?? new Date(0).toISOString() });
    }
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return { folder, files: files.slice(0, MAX_LISTED_FILES), total: files.length, partial: true };
  }
}
