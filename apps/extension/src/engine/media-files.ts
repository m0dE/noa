/**
 * Writes task media to real files with chrome.downloads, so both brains and
 * DOM.setFileInputFiles get absolute local paths:
 * Downloads/noa-media/<sessionId>/<name>.
 *
 * Local blobs go through a data: URL (URL.createObjectURL does not exist in
 * an MV3 service worker; data: URL downloads were checked to work up to at
 * least 60 MB). Cloud media is downloaded straight from the API with the
 * runner key as a header, falling back to fetch + data: URL.
 */
import { bytesToBase64 } from "../base64.js";
import { errorMessage, safeFileName, uniqueNames } from "@noa/shared";

export type MediaSource =
  | { kind: "blob"; name: string; blob: Blob }
  | { kind: "url"; name: string; url: string; headers?: { name: string; value: string }[] };

export interface MaterializedMedia {
  paths: string[];
  /** Deletes the files and erases them from the download history. Never throws. */
  cleanup(): Promise<void>;
}

type DownloadDelta = { id: number; state?: { current?: string }; error?: { current?: string } };

/** The subset of chrome.downloads used here. */
export interface DownloadsLike {
  download(options: {
    url: string;
    filename?: string;
    conflictAction?: "uniquify" | "overwrite" | "prompt";
    saveAs?: boolean;
    headers?: { name: string; value: string }[];
  }): Promise<number>;
  search(query: { id: number }): Promise<{ id: number; state?: string; filename: string; error?: string }[]>;
  onChanged: { addListener(fn: (d: DownloadDelta) => void): void; removeListener(fn: (d: DownloadDelta) => void): void };
  setUiOptions?(options: { enabled: boolean }): Promise<void>;
  removeFile(id: number): Promise<void>;
  erase(query: { id: number }): Promise<number[]>;
}

const MEDIA_DIR = "noa-media";

async function blobToDataUrl(blob: Blob): Promise<string> {
  return `data:${blob.type || "application/octet-stream"};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}

export class MediaFiles {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: { downloads?: DownloadsLike; timeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    this.fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private get downloads(): DownloadsLike {
    return this.opts.downloads ?? chrome.downloads;
  }

  async materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> {
    const ids: number[] = [];
    const cleanup = async () => {
      for (const id of ids) {
        await this.downloads.removeFile(id).catch(() => {});
        await this.downloads.erase({ id }).catch(() => {});
      }
    };
    if (sources.length === 0) return { paths: [], cleanup };
    const dir = `${MEDIA_DIR}/${safeFileName(sessionId)}`;
    const names = uniqueNames(sources.map((s) => safeFileName(s.name, s.kind === "blob" ? s.blob.type : "")));
    const paths: string[] = [];
    await this.downloads.setUiOptions?.({ enabled: false }).catch(() => {});
    try {
      for (const [i, src] of sources.entries()) {
        const filename = `${dir}/${names[i]}`;
        let path: string;
        if (src.kind === "blob") {
          path = await this.write({ url: await blobToDataUrl(src.blob), filename }, ids);
        } else {
          try {
            path = await this.write({ url: src.url, filename, headers: src.headers }, ids);
          } catch (err) {
            // Some servers or header combinations fail inside the download manager; fetch it ourselves.
            const res = await this.fetchFn(src.url, { headers: Object.fromEntries((src.headers ?? []).map((h) => [h.name, h.value])) });
            if (!res.ok) throw new Error(`Downloading ${src.name} failed: HTTP ${res.status} (${errorMessage(err)})`);
            path = await this.write({ url: await blobToDataUrl(await res.blob()), filename }, ids);
          }
        }
        paths.push(path);
      }
    } catch (err) {
      await cleanup();
      throw err;
    } finally {
      await this.downloads.setUiOptions?.({ enabled: true }).catch(() => {});
    }
    return { paths, cleanup };
  }

  /** One download; resolves with the absolute path once complete (onChanged says when it ends; one search reads the path). */
  private async write(
    opts: { url: string; filename: string; headers?: { name: string; value: string }[] },
    ids: number[],
  ): Promise<string> {
    const dl = this.downloads;
    // Downloads that ended, and the one being waited for (it may end before download() even resolves).
    const ended = new Map<number, DownloadDelta>();
    let waiting: { id: number; done(): void } | null = null;
    const listener = (d: DownloadDelta) => {
      if (!d.state?.current || d.state.current === "in_progress") return;
      ended.set(d.id, d);
      if (waiting?.id === d.id) waiting.done();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    dl.onChanged.addListener(listener);
    try {
      const id = await dl.download({
        url: opts.url,
        filename: opts.filename,
        conflictAction: "uniquify",
        saveAs: false,
        ...(opts.headers?.length ? { headers: opts.headers } : {}),
      });
      ids.push(id);
      let [item] = await dl.search({ id });
      if (item?.state === "in_progress") {
        if (!ended.has(id)) {
          const finished = await new Promise<boolean>((resolve) => {
            waiting = { id, done: () => resolve(true) };
            timer = setTimeout(() => resolve(false), this.timeoutMs);
          });
          if (!finished) throw new Error(`Writing ${opts.filename} timed out`);
        }
        [item] = await dl.search({ id });
      }
      if (item?.state === "complete") {
        if (!item.filename) throw new Error(`Download of ${opts.filename} finished without a file path`);
        return item.filename;
      }
      throw new Error(`Writing ${opts.filename} failed: ${item?.error ?? ended.get(id)?.error?.current ?? "download interrupted"}`);
    } finally {
      clearTimeout(timer);
      dl.onChanged.removeListener(listener);
    }
  }
}
