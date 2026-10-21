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
 *
 * Without a search the agent sees the newest LIST_NEWEST_FILES and how many there are; with one, the best
 * FILE_SEARCH_SHOWN of all of them (file-search.ts: words, name, the account's meaning search, dates), so a storage of
 * thousands of files costs the agent no more than a page of them.
 *
 * Each listed file carries what is known about it (FileMeta): the helper's (a picture's size, the folder's notes), the
 * cloud row's (what save_file sent, the size the server read), and, for a file Chrome downloaded, the address it came
 * from and the page it was downloaded on, from Chrome's download history.
 */
import {
  cleanFileMeta,
  cloudFileName,
  errorMessage,
  FILE_SEARCH_SHOWN,
  LIST_NEWEST_FILES,
  LOCAL_SEARCH_MAX,
  MAX_LISTED_FILES,
  type CloudFile,
  type CloudFileList,
  type FileMeta,
  type FileSearchResponse,
  type NoaFile,
  type NoaFileList,
} from "@noa/shared";
import { searchFiles } from "./file-search.js";
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
  url?: string;
  finalUrl?: string;
  referrer?: string;
  byExtensionId?: string;
  state?: string;
  exists?: boolean;
  fileSize?: number;
  endTime?: string;
  startTime?: string;
}

interface DownloadSearchLike {
  search(query: { state?: string; limit?: number; orderBy?: string[] }): Promise<DownloadItemLike[]>;
}

/** A path as a key: any case, either slash. */
function pathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").toLowerCase();
}

/**
 * How long a listing of the account's files is reused: the calls of one turn, back to back. cloudChanged forgets it
 * when Noa stores a file, and a search that finds a file the listing lacks (stored elsewhere: the dashboard, another
 * computer) reads it again.
 */
const CLOUD_LIST_MS = 5_000;

/** How long list_files waits for the helper to connect before it lists what Chrome knows instead. */
const HELPER_WAIT_MS = 10_000;

/** list_files (files.list): the files in the Noa folder, newest first. */
export class NoaFiles {
  constructor(
    private readonly deps: {
      folder: Pick<NoaFolder, "path">;
      /** The helper's files.list, connecting it first; rejects when there is no helper. */
      helperList(params: { folder: string; search?: string; max?: number }, timeoutMs: number): Promise<NoaFileList>;
      downloads?: DownloadSearchLike;
      /**
       * The account's cloud files: list (null when signed out) and download one to `path` in the Noa folder
       * (returns where it was saved). Absent: none are listed.
       */
      cloud?: {
        list(): Promise<CloudFileList | null>;
        download(file: CloudFile, path: string): Promise<string>;
        /** The account's meaning search over its files; null when signed out. Absent: words, names and dates only. */
        search?(query: string): Promise<FileSearchResponse | null>;
      };
      now?: () => Date;
      /** The whole file at `path` on this computer (the helper's files.read), for view_file. Absent: none can be viewed. */
      read?(path: string): Promise<Blob>;
      /** A picture made small enough to look at (image-generator.ts jpegView); null when it cannot be decoded. */
      shrink?(blob: Blob): Promise<{ base64: string; mimeType: string; width: number; height: number } | null>;
      log?: (message: string) => void;
    },
  ) {}

  /** Cloud files listed but not on this computer, by their path in the folder (pathKey), until they are downloaded. */
  private readonly inCloud = new Map<string, CloudFile>();
  /** Cloud files already downloaded, by the path they were listed under, to the path they were saved at. */
  private readonly fetched = new Map<string, Promise<string>>();

  /** The cloud list, kept CLOUD_LIST_MS: an agent lists and searches several times in a row. */
  private cloudCache: { at: number; list: Promise<CloudFileList | null> } | null = null;

  /** The account's files changed here (a file kept or made): the next listing reads them again. */
  cloudChanged(): void {
    this.cloudCache = null;
  }

  async list(params: { search?: string }): Promise<NoaFileList> {
    const folder = await this.deps.folder.path();
    const search = params.search?.trim() || undefined;
    const [local, listed, downloaded, meaning] = await Promise.all([
      // A search ranks all the folder's files (up to LOCAL_SEARCH_MAX), not only the names that contain it.
      this.local(folder, search ? LOCAL_SEARCH_MAX : undefined),
      this.cloudList(),
      this.downloadSources(),
      search ? this.cloudSearch(search) : Promise.resolve(null),
    ]);
    // A file the search found that the reused listing lacks was stored since: read the listing again.
    const known = new Set(listed?.files.map((f) => f.id));
    let cloud = listed;
    if (meaning?.hits.some((h) => !known.has(h.id))) {
      this.cloudChanged();
      cloud = await this.cloudList();
    }
    for (const f of local.files) {
      const from = downloaded.get(pathKey(f.path));
      if (from) f.meta = { ...from, ...f.meta };
    }
    // A cloud file that is in the folder already (same place, same name) is listed once, as the file here, with
    // what the cloud copy knows added to what is known here.
    const here = new Map(local.files.map((f) => [f.name.toLowerCase(), f]));
    const byCloudId = new Map<string, NoaFile>();
    const extra: NoaFile[] = [];
    for (const c of cloud?.files ?? []) {
      const name = c.folder ? `${c.folder}/${c.name}` : c.name;
      const mine = here.get(name.toLowerCase());
      if (mine) {
        if (c.meta) mine.meta = { ...c.meta, ...mine.meta };
        byCloudId.set(c.id, mine);
        continue;
      }
      const path = this.cloudPathIn(folder, c);
      const file: NoaFile = { path, name, size: c.size, modified: c.createdAt, cloud: true, ...(c.meta ? { meta: c.meta } : {}) };
      byCloudId.set(c.id, file);
      extra.push(file);
    }
    const all = [...local.files, ...extra].sort((a, b) => b.modified.localeCompare(a.modified));
    // Files listed here that are not shown (a search's or the folder's beyond what was read) still count.
    const unread = Math.max(0, local.total - local.files.length);
    if (!search) return { ...local, files: all.slice(0, LIST_NEWEST_FILES), total: all.length + unread };
    const semantic = new Map<NoaFile, number>();
    for (const h of meaning?.hits ?? []) {
      const f = byCloudId.get(h.id);
      if (f) semantic.set(f, h.score);
    }
    const now = (this.deps.now ?? (() => new Date()))();
    const hits = searchFiles(all, search, { now, offsetMinutes: -now.getTimezoneOffset(), semantic });
    return {
      ...local,
      files: hits.slice(0, FILE_SEARCH_SHOWN).map((h) => h.file),
      total: hits.length,
      searched: { meaning: meaning !== null, ...(meaning?.pending ? { pending: meaning.pending } : {}) },
    };
  }

  /**
   * A cloud file Noa just stored there only (Storage: cloud): the path in the Noa folder upload takes for it (it is
   * downloaded there first, as a listed cloud file).
   */
  async adopt(file: CloudFile): Promise<string> {
    return this.cloudPathIn(await this.deps.folder.path(), file);
  }

  /** Where a cloud file goes in the Noa folder (its folder and name), remembered for upload's download (fetch). */
  private cloudPathIn(folder: string, c: CloudFile): string {
    const sep = folder.includes("\\") ? "\\" : "/";
    const path = [folder, ...(c.folder ? [c.folder] : []), cloudFileName(c.name)].join(sep);
    this.inCloud.set(pathKey(path), c);
    return path;
  }

  /** The account's meaning search; null when signed out, not set up, or failing (the other ways of finding go on). */
  private async cloudSearch(query: string): Promise<FileSearchResponse | null> {
    if (!this.deps.cloud?.search) return null;
    try {
      return await this.deps.cloud.search(query);
    } catch (err) {
      this.deps.log?.(`list_files without the meaning search: ${errorMessage(err)}`);
      return null;
    }
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

  /**
   * view_file: the picture at `path` (a listed cloud file is downloaded first), made small enough to look at, with its
   * own size in pixels and the file's bytes.
   */
  async view(params: { path: string }): Promise<{ image: { base64: string; mimeType: string }; width: number; height: number; size: number }> {
    if (!this.deps.read || !this.deps.shrink) throw new Error("Files on this computer can be opened only with Noa's helper, which is not connected.");
    const [path] = await this.fetch([params.path]);
    const blob = await this.deps.read(path!);
    let shown: Awaited<ReturnType<NonNullable<typeof this.deps.shrink>>> = null;
    try {
      shown = await this.deps.shrink(blob);
    } catch {
      // Not a picture this browser can decode.
    }
    if (!shown) throw new Error(`${params.path} is not a picture that can be shown (view_file shows PNG, JPEG, GIF, WebP and BMP pictures).`);
    return { image: { base64: shown.base64, mimeType: shown.mimeType }, width: shown.width, height: shown.height, size: blob.size };
  }

  /**
   * Where each file Chrome downloaded came from (its address, and the page it was downloaded on), by path. Noa's own
   * downloads (save_file's writes, cloud copies) say nothing about that and are left out. Empty when the history
   * cannot be read.
   */
  private async downloadSources(): Promise<Map<string, FileMeta>> {
    const out = new Map<string, FileMeta>();
    try {
      const downloads = this.deps.downloads ?? (chrome.downloads as unknown as DownloadSearchLike);
      // Newest first: a file downloaded again under the same name came from the newest.
      for (const d of await downloads.search({ state: "complete", limit: 0, orderBy: ["-startTime"] })) {
        if (d.byExtensionId && d.byExtensionId === globalThis.chrome?.runtime?.id) continue;
        const meta = cleanFileMeta({ source: d.finalUrl || d.url, page: d.referrer });
        const key = pathKey(d.filename);
        if (meta && !out.has(key)) out.set(key, meta);
      }
    } catch (err) {
      this.deps.log?.(`list_files without the download history: ${errorMessage(err)}`);
    }
    return out;
  }

  /** The folder's newest `max` files (default MAX_LISTED_FILES). */
  private async local(folder: string, max: number | undefined): Promise<NoaFileList> {
    try {
      return await this.deps.helperList(max ? { folder, max } : { folder }, HELPER_WAIT_MS);
    } catch (err) {
      this.deps.log?.(`list_files without the helper (${errorMessage(err)}): only Chrome's own downloads are listed`);
      return this.fromDownloads(folder, max ?? MAX_LISTED_FILES);
    }
  }

  /** The account's cloud files; null when signed out, there are none to list, or they cannot be loaded now. */
  private async cloudList(): Promise<CloudFileList | null> {
    const cloud = this.deps.cloud;
    if (!cloud) return null;
    const now = Date.now();
    if (!this.cloudCache || now - this.cloudCache.at > CLOUD_LIST_MS) {
      const list = cloud.list();
      this.cloudCache = { at: now, list };
      // A failure is not kept: the next listing asks again.
      list.catch(() => {
        if (this.cloudCache?.list === list) this.cloudCache = null;
      });
    }
    try {
      // A copy: listing adds what is known here to the files it is given.
      return structuredClone(await this.cloudCache.list);
    } catch (err) {
      this.deps.log?.(`list_files without the cloud files: ${errorMessage(err)}`);
      return null;
    }
  }

  /** The files in the folder Chrome saved and that are still there, from its download history (the newest `max`). */
  private async fromDownloads(folder: string, max: number): Promise<NoaFileList> {
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
      if (name === "README.txt") continue;
      files.push({ path: d.filename, name, size: Math.max(0, d.fileSize ?? 0), modified: d.endTime ?? d.startTime ?? new Date(0).toISOString() });
    }
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return { folder, files: files.slice(0, max), total: files.length, partial: true };
  }
}
