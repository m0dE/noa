/**
 * save_file (files.save): keeps a file for the user. Its bytes come from one source (a web address fetched with the
 * browser's sign-ins, text the agent wrote, a screenshot of the tab, a file on this computer the agent may use, or the
 * browser's last download); it is saved in the Noa folder (Downloads/Noa/<folder>/<name>, a name already there gets a
 * number) unless it is in the folder already, and, on a plan with cloud files, stored in the account's cloud files in
 * the same folder. The cloud copy never fails the tool: the result says why there is none.
 *
 * Files on this computer are read by the helper (files.read), a piece at a time: an extension cannot read them.
 */
import {
  cloudFileName,
  cloudFolderName,
  errorMessage,
  formatBytes,
  SAVE_FILE_MAX_BYTES,
  type SavedFile,
  type SaveFileParams,
} from "@noa/shared";
import { base64ToBytes, bytesToBase64 } from "../base64.js";
import { writeDownload, type DownloadsLike } from "./media-files.js";

/** The browser's last download, as save_file's `download` source takes it. */
export interface LastDownload {
  /** Absolute path on this computer. */
  filename: string;
  /** Where it came from (http(s): fetched again when the helper cannot read the file). */
  url: string;
  mime?: string;
}

export interface FileSaverDeps {
  fetch?: typeof fetch;
  /** Writes the bytes to `rel` under the download folder ("Noa/<folder>/<name>"); resolves with the absolute path. */
  writeLocal(rel: string, blob: Blob): Promise<string>;
  /** Stores a copy in the account's cloud files. */
  cloud(blob: Blob, name: string, folder: string): Promise<{ saved: true; folder?: string } | { saved: false; why: "signed-out" | "no-plan" }>;
  /** The whole file at `path` on this computer (the helper's files.read). Absent: such files cannot be read here. */
  readLocal?(path: string): Promise<Blob>;
  /** The browser's newest finished download of the last 15 minutes, or null. */
  lastDownload?(): Promise<LastDownload | null>;
  /** The Noa folder, absolute (a file already in it is not copied again). */
  folder?(): Promise<string>;
}

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

function extOf(name: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
}

/** The type a name's extension says; "" when it says none. */
export function typeOfName(name: string): string {
  return TYPES[extOf(name)] ?? "";
}

/** The extension a type has ("" for none known). */
function extOfType(type: string): string {
  const t = type.split(";")[0]!.trim().toLowerCase();
  return Object.entries(TYPES).find(([, v]) => v === t)?.[0] ?? "";
}

/** A safe file name with an extension: the one asked for, else the source's, with the type's extension when it has none. */
export function savedName(asked: string | undefined, fallback: string, type: string): string {
  let name = cloudFileName(asked?.trim() || fallback);
  const ext = extOfType(type);
  if (!extOf(name) && ext) name = `${name}.${ext}`;
  return name;
}

/** The last part of a URL's path, decoded ("" when it has none). */
function urlFileName(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

function tooLarge(size: number): Error {
  return new Error(`The file is ${formatBytes(size)}; save_file keeps files up to ${formatBytes(SAVE_FILE_MAX_BYTES)}.`);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

export class FileSaver {
  constructor(private readonly deps: FileSaverDeps) {}

  /** Keeps the file (see the header); ctx.screenshot: the current tab's picture, for the screenshot source. */
  async save(p: SaveFileParams, ctx: { screenshot?: () => Promise<{ base64: string; mimeType: string }> }): Promise<SavedFile> {
    const got = await this.source(p, ctx);
    if (got.blob.size > SAVE_FILE_MAX_BYTES) throw tooLarge(got.blob.size);
    const contentType = got.blob.type || typeOfName(got.name) || "application/octet-stream";
    const name = savedName(p.name, got.name, contentType);
    const folder = cloudFolderName(p.folder ?? (p.screenshot ? "images" : ""));
    const blob = got.blob.type ? got.blob : new Blob([got.blob], { type: contentType });
    const path = (await this.alreadyInFolder(got.localPath, folder, name)) ?? (await this.deps.writeLocal(["Noa", ...(folder ? [folder] : []), name].join("/"), blob));
    // The name it got here (a name already there gets a number), so both copies match.
    const keptName = baseName(path) || name;
    const saved: SavedFile = { path, name: keptName, folder, size: blob.size, contentType, cloud: "saved" };
    try {
      const r = await this.deps.cloud(blob, keptName, folder);
      if (!r.saved) saved.cloud = r.why;
      else if (r.folder !== undefined && r.folder !== folder) saved.cloudFolder = r.folder;
    } catch (err) {
      saved.cloud = "failed";
      saved.cloudError = errorMessage(err);
    }
    return saved;
  }

  /** The path of a file on this computer that is in the Noa folder at the asked place already (no copy needed). */
  private async alreadyInFolder(localPath: string | undefined, folder: string, name: string): Promise<string | null> {
    if (!localPath || !this.deps.folder) return null;
    const root = (await this.deps.folder()).replace(/\\/g, "/").toLowerCase();
    const here = localPath.replace(/\\/g, "/").toLowerCase();
    const want = [root, ...(folder ? [folder.toLowerCase()] : []), name.toLowerCase()].join("/");
    return here === want ? localPath : null;
  }

  /** The bytes and a name for them, from the one source given. */
  private async source(
    p: SaveFileParams,
    ctx: { screenshot?: () => Promise<{ base64: string; mimeType: string }> },
  ): Promise<{ blob: Blob; name: string; localPath?: string }> {
    if (p.text !== undefined) return { blob: new Blob([p.text], { type: typeOfName(p.name ?? "") || "text/plain" }), name: p.name ?? "notes.txt" };
    if (p.url !== undefined) return { blob: await this.fetchUrl(p.url), name: urlFileName(p.url) || "file" };
    if (p.screenshot) {
      if (!ctx.screenshot) throw new Error("No tab to take a screenshot of.");
      const shot = await ctx.screenshot();
      return { blob: new Blob([base64ToBytes(shot.base64)], { type: shot.mimeType }), name: `screenshot-${stamp()}` };
    }
    if (p.path !== undefined) return { blob: await this.readLocal(p.path), name: baseName(p.path), localPath: p.path };
    if (p.download) {
      const d = await this.deps.lastDownload?.();
      if (!d) throw new Error("The browser has not downloaded a file in the last 15 minutes. Click the page's Download or Export button first, then call save_file with download: true.");
      const name = baseName(d.filename);
      if (this.deps.readLocal) {
        try {
          return { blob: await this.readLocal(d.filename, d.mime), name, localPath: d.filename };
        } catch (err) {
          if (!/^https?:/i.test(d.url)) throw err;
        }
      }
      if (/^https?:/i.test(d.url)) return { blob: await this.fetchUrl(d.url), name };
      throw new Error(`${name} was made by the page itself, and only Noa's helper can read it from this computer: it is not connected. It is in the downloads folder: ${d.filename}`);
    }
    throw new Error("save_file needs one source: url, text, screenshot, path or download.");
  }

  private async readLocal(path: string, mime?: string): Promise<Blob> {
    if (!this.deps.readLocal) throw new Error("Files on this computer can be read only with Noa's helper, which is not connected.");
    const blob = await this.deps.readLocal(path);
    const type = mime || blob.type || typeOfName(path);
    return type && blob.type !== type ? new Blob([blob], { type }) : blob;
  }

  /** The file at a web address (with the browser's sign-ins) or a data: URL. */
  private async fetchUrl(url: string): Promise<Blob> {
    if (/^blob:/i.test(url)) throw new Error("A blob: link is made by the page itself: click its Download button, then call save_file with download: true.");
    const f = this.deps.fetch ?? ((i, init) => fetch(i, init));
    let res: Response;
    try {
      res = await f(url, { credentials: "include" });
    } catch (err) {
      throw new Error(`Could not download ${url}: ${errorMessage(err)}`);
    }
    if (!res.ok) throw new Error(`Could not download ${url}: the site answered ${res.status}${res.status === 401 || res.status === 403 ? " (sign in there first, or click the page's Download button and use download: true)" : ""}.`);
    const declared = Number(res.headers.get("Content-Length") ?? 0);
    if (declared > SAVE_FILE_MAX_BYTES) throw tooLarge(declared);
    const blob = await res.blob();
    const type = res.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
    // A sign-in page instead of the file: the site wants the user signed in.
    if (/^text\/html/i.test(type) && !/\.html?$/i.test(urlFileName(url))) {
      throw new Error(`${url} gave a web page, not a file (perhaps a sign-in page). Open it in the tab to see, or click the page's Download button and use download: true.`);
    }
    return blob.type || !type ? blob : new Blob([blob], { type });
  }
}

/** chrome.downloads as the writer and the last-download finder need it. */
export interface SaverDownloadsLike extends DownloadsLike {
  search(query: { id?: number; state?: string; orderBy?: string[]; limit?: number }): Promise<
    { id: number; state?: string; filename: string; error?: string; exists?: boolean; url?: string; finalUrl?: string; mime?: string; endTime?: string; byExtensionId?: string }[]
  >;
}

/** writeLocal on the download folder: the bytes as a data: URL, without the download bubble (the chat says where it is). */
export function downloadsWriter(dl: DownloadsLike, timeoutMs = 2 * 60_000): FileSaverDeps["writeLocal"] {
  return async (rel, blob) => {
    const url = `data:${blob.type || "application/octet-stream"};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
    await dl.setUiOptions?.({ enabled: false }).catch(() => {});
    try {
      return await writeDownload(dl, { url, filename: rel, conflictAction: "uniquify" }, () => {}, timeoutMs);
    } finally {
      await dl.setUiOptions?.({ enabled: true }).catch(() => {});
    }
  };
}

/** How recent a download save_file's `download` source takes. */
export const LAST_DOWNLOAD_MS = 15 * 60_000;

/** The browser's newest finished download of the last 15 minutes that is still there and not Noa's own; null if none. */
export function lastDownloadFinder(dl: SaverDownloadsLike, ownId: string, now: () => number = Date.now): () => Promise<LastDownload | null> {
  return async () => {
    const items = await dl.search({ state: "complete", orderBy: ["-endTime"], limit: 20 });
    const d = items.find((i) => i.exists !== false && i.byExtensionId !== ownId && i.endTime && now() - Date.parse(i.endTime) <= LAST_DOWNLOAD_MS);
    if (!d) return null;
    return { filename: d.filename, url: d.finalUrl || d.url || "", ...(d.mime ? { mime: d.mime } : {}) };
  };
}
