/**
 * generate_image (media.generateImage): the account's hosted AI makes the picture (POST /v1/ai/images, paid from its
 * usage credit), and it is saved as a PNG in the user's Noa folder, Downloads/Noa/images/<name>.png, where it stays
 * (it is the user's; nothing here deletes it). The agent gets its path, which upload takes, and a smaller JPEG preview
 * to look at: the PNG (1-3 MB as base64) may be larger than a native message to the helper carries (1 MB).
 * Where it is kept follows Settings > Storage (FileStorage): both, a copy also goes to the account's "images" folder
 * (POST /v1/files) in the background (the tool never waits for it or fails because of it); cloud only, it is stored
 * there first and not written here (the path is where it is downloaded when uploaded), and kept here instead when the
 * cloud cannot take it; this computer only, no cloud copy. Its prompt is kept as its note (FileMeta.about).
 */
import { MAX_FILE_ABOUT_CHARS, type BrowserMethods, type CloudFile, type ExtensionSettings, type FileMeta, type FileStorage, type GenerateImageRequest, type GenerateImageResponse } from "@noa/shared";
import { base64ToBytes, bytesToBase64 } from "../base64.js";
import { ApiRequestError, NotSignedInError } from "../http-client.js";
import { writeDownload, type DownloadsLike } from "./media-files.js";
import { NOA_FOLDER } from "./noa-folder.js";

export type GenerateImageParams = BrowserMethods["media.generateImage"]["params"];
export type GenerateImageResult = BrowserMethods["media.generateImage"]["result"];

export const IMAGES_FOLDER = `${NOA_FOLDER}/images`;
/** The preview's longest side: enough for the model to judge the picture, small enough for the chat and a native message. */
export const PREVIEW_MAX_SIDE = 768;
const PREVIEW_JPEG_QUALITY = 0.85;

export const NOT_SIGNED_IN =
  "Image generation uses Noa AI, and this browser is not signed in to a Noa account. Tell the user to sign in (the avatar at the top of the side panel); pictures are paid from the account's usage credit.";
export const IMAGES_OFF = "Image generation is turned off in Noa's settings. Tell the user they can turn it on in Settings > AI > Image generation.";
export const NOT_ON_SERVER = "The Noa account server does not make images yet. Tell the user image generation is not available yet.";

/** A file name (no extension) for the picture: the name given, else the description's first words. */
export function imageFileBase(name: string | undefined, prompt: string): string {
  const words = (name?.trim() ? name : prompt)
    .toLowerCase()
    .replace(/\.png$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let base = "";
  for (const w of words) {
    const next = base ? `${base}-${w}` : w;
    if (next.length > 60) break;
    base = next;
  }
  return base || "image";
}

/**
 * A JPEG of the picture at most PREVIEW_MAX_SIDE on its longest side, on white (a transparent PNG would turn black
 * in a JPEG). Null when this context cannot draw (no OffscreenCanvas).
 */
export async function jpegPreview(png: Uint8Array<ArrayBuffer>): Promise<{ base64: string; mimeType: string } | null> {
  const view = await jpegView(new Blob([png], { type: "image/png" }));
  return view && { base64: view.base64, mimeType: view.mimeType };
}

/**
 * Any picture the browser decodes (PNG, JPEG, GIF, WebP, BMP) as jpegPreview makes it, with the picture's own width
 * and height: what view_file shows. Null when this context cannot draw; rejects when the bytes are not a picture.
 */
export async function jpegView(blob: Blob): Promise<{ base64: string; mimeType: string; width: number; height: number } | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: PREVIEW_JPEG_QUALITY });
    return { base64: bytesToBase64(new Uint8Array(await out.arrayBuffer())), mimeType: "image/jpeg", width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export interface ImageGeneratorDeps {
  /** The image generation settings, read at each call: a switch turned off mid-chat takes effect at once. */
  settings(): Promise<Pick<ExtensionSettings, "imageGeneration" | "imageModel">>;
  /** The account's POST /v1/ai/images (AccountService.generateImage). */
  generate(req: GenerateImageRequest, opts: { sessionId?: string }): Promise<GenerateImageResponse>;
  /**
   * Keeps a copy in the account's cloud files (AccountService.keepInCloud): resolves false when the plan has none.
   * Absent: no cloud copy.
   */
  keepInCloud?(png: Blob, filename: string, folder: "images", meta: FileMeta): Promise<CloudFile | null>;
  /** Where the user keeps files (Settings > Storage, fileStorageFor). Absent: both. */
  where?(): Promise<FileStorage>;
  /** The path in the Noa folder a cloud-only picture is downloaded to when it is uploaded (NoaFiles.adopt). */
  cloudPath?(file: CloudFile): Promise<string>;
  /** Keeps the note on the picture in the Noa folder (the helper's files.note). Absent or failing: no local note. */
  note?(path: string, meta: FileMeta): Promise<void>;
  /** A cloud copy that failed (it is only logged: the picture is saved on this computer). */
  onCloudError?(err: unknown): void;
  downloads?: DownloadsLike;
  preview?: (png: Uint8Array<ArrayBuffer>) => Promise<{ base64: string; mimeType: string } | null>;
  timeoutMs?: number;
}

export class ImageGenerator {
  constructor(private readonly deps: ImageGeneratorDeps) {}

  private get downloads(): DownloadsLike {
    return this.deps.downloads ?? chrome.downloads;
  }

  /** Makes the picture and saves it; sessionId: the run it is for (its usage is recorded under it). */
  async generate(params: GenerateImageParams, sessionId: string | null): Promise<GenerateImageResult> {
    // A session that started while it was on still has the tool.
    const settings = await this.deps.settings();
    if (!settings.imageGeneration) throw new Error(IMAGES_OFF);
    const req: GenerateImageRequest = { prompt: params.prompt, model: settings.imageModel };
    if (params.size) req.size = params.size;
    if (params.quality) req.quality = params.quality;
    if (params.transparent) req.transparent = true;
    let made: GenerateImageResponse;
    try {
      made = await this.deps.generate(req, sessionId ? { sessionId } : {});
    } catch (err) {
      if (err instanceof NotSignedInError) throw new Error(NOT_SIGNED_IN);
      // An account server from before image generation (or a self-hosted one without it).
      if (err instanceof ApiRequestError && (err.status === 404 || err.status === 405)) throw new Error(NOT_ON_SERVER);
      throw err;
    }
    const png = base64ToBytes(made.base64);
    const fileName = `${imageFileBase(params.name, params.prompt)}.png`;
    // What it shows, for list_files to tell it from the user's other pictures later.
    const meta: FileMeta = { about: `Made with generate_image: ${params.prompt}`.slice(0, MAX_FILE_ABOUT_CHARS) };
    const where = (await this.deps.where?.()) ?? "both";
    let path = where === "cloud" ? await this.cloudOnly(png, fileName, meta) : null;
    if (!path) {
      path = await this.save(`${IMAGES_FOLDER}/${fileName}`, made.base64);
      if (this.deps.note) await this.deps.note(path, meta).catch(() => {});
      if (where === "both") this.copyToCloud(png, path, meta);
    }
    const preview = (await (this.deps.preview ?? jpegPreview)(png)) ?? { base64: made.base64, mimeType: made.mimeType };
    return { path, preview, size: made.size, quality: made.quality, chargedCents: made.chargedCents };
  }

  /** Stores the picture in the cloud only: where upload finds it, or null when the cloud cannot take it. */
  private async cloudOnly(png: Uint8Array<ArrayBuffer>, fileName: string, meta: FileMeta): Promise<string | null> {
    if (!this.deps.keepInCloud || !this.deps.cloudPath) return null;
    try {
      const file = await this.deps.keepInCloud(new Blob([png], { type: "image/png" }), fileName, "images", meta);
      return file ? await this.deps.cloudPath(file) : null;
    } catch (err) {
      this.deps.onCloudError?.(err);
      return null;
    }
  }

  /** Sends the saved picture to the account's cloud files under the name it got here (Chrome may have numbered it). */
  private copyToCloud(png: Uint8Array<ArrayBuffer>, path: string, meta: FileMeta): void {
    const keep = this.deps.keepInCloud;
    if (!keep) return;
    const name = path.split(/[\\/]/).pop() || "image.png";
    void keep(new Blob([png], { type: "image/png" }), name, "images", meta).catch((err: unknown) => this.deps.onCloudError?.(err));
  }

  /** Writes the PNG into the download folder (a name already there gets a number); resolves with its absolute path. */
  private async save(filename: string, base64: string): Promise<string> {
    const dl = this.downloads;
    // No download bubble: the chat shows the picture and says where it is.
    await dl.setUiOptions?.({ enabled: false }).catch(() => {});
    try {
      return await writeDownload(dl, { url: `data:image/png;base64,${base64}`, filename, conflictAction: "uniquify" }, () => {}, this.deps.timeoutMs ?? 60_000);
    } finally {
      await dl.setUiOptions?.({ enabled: true }).catch(() => {});
    }
  }
}
