/**
 * A file the user attached, made ready to send (in the side panel, before the
 * message goes): an image brought within the model's limits (fitImage) and
 * re-encoded only when it must be, with a small thumbnail for the chat; a Word
 * document's or text file's text read out, bounded, with what looks like a key
 * or password replaced; anything else checked for size. A file that cannot be
 * sent fails with AttachmentProblem, whose message says why in plain words.
 */
import {
  ATTACHMENT_LIMITS,
  attachmentKind,
  attachmentRefusal,
  boundText,
  fitImage,
  MODEL_IMAGE_TYPES,
  REDACTED_SECRET,
  redactSecrets,
  secretProblem,
  type AttachmentKind,
} from "@noa/shared";
import { bytesToBase64 } from "../../base64.js";
import type { UiAttachmentUpload } from "../../ui-protocol.js";
import { docxText, DocxError } from "./docx.js";

/** Longest edge of the chat's thumbnail of an image. */
export const THUMB_EDGE_PX = 96;
/** An image file larger than this is not even decoded. */
export const MAX_RAW_IMAGE_BYTES = 40 * 1024 * 1024;
/** JPEG qualities tried in turn until an image fits maxImageBytes. */
const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6];

/** Why a file cannot be attached, in words for the user. */
export class AttachmentProblem extends Error {}

/** A file ready to send. */
export interface PreparedAttachment {
  upload: UiAttachmentUpload;
  kind: AttachmentKind;
  /** Bytes that will be sent. */
  size: number;
  /** For the user, on its chip: a few words (label) and the whole of it (text), e.g. that it seems to hold a password. */
  warning?: { label: string; text: string };
}

/** A decoded image that can be drawn at another size and encoded. */
export interface DecodedImage {
  width: number;
  height: number;
  encode(width: number, height: number, type: string, quality?: number): Promise<Blob>;
  close(): void;
}

/** Reads images (the browser's own decoder, OffscreenCanvas; tests fake it). */
export interface ImageCodec {
  decode(blob: Blob): Promise<DecodedImage>;
}

export const browserImageCodec: ImageCodec = {
  async decode(blob) {
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      async encode(width, height, type, quality) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d canvas");
        // JPEG has no transparency: transparent parts become white, not black.
        if (type === "image/jpeg") {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
        }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
        return canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
      },
      close: () => bitmap.close(),
    };
  },
};

/** Prepares one file (see the module comment). `held`: what the message holds already (the limits count it). */
export async function prepareAttachment(file: File, held: readonly { size: number }[], codec: ImageCodec = browserImageCodec): Promise<PreparedAttachment> {
  const type = file.type || "application/octet-stream";
  const kind = attachmentKind(file.name, type);
  if (kind === "image") return checked(await prepareImage(file, codec), held);
  const refusal = attachmentRefusal({ name: file.name, size: file.size, kind }, held);
  if (refusal) throw new AttachmentProblem(refusal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const upload: UiAttachmentUpload = { name: file.name, type, dataBase64: bytesToBase64(bytes) };
  const prepared: PreparedAttachment = { upload, kind, size: bytes.length };
  if (kind === "text") return withText(prepared, new TextDecoder().decode(bytes));
  if (kind === "docx") {
    try {
      return withText(prepared, await docxText(bytes));
    } catch (err) {
      if (err instanceof DocxError) throw new AttachmentProblem(`${file.name}: ${err.message}`);
      throw err;
    }
  }
  return prepared;
}

function checked(p: PreparedAttachment, held: readonly { size: number }[]): PreparedAttachment {
  const refusal = attachmentRefusal({ name: p.upload.name, size: p.size, kind: p.kind }, held);
  if (refusal) throw new AttachmentProblem(refusal);
  return p;
}

/**
 * The text the model reads: bounded, what looks like a key or password replaced (the note says so to the model and
 * in the chat); what still looks like a password, code or card number is kept but the user is warned.
 */
function withText(p: PreparedAttachment, raw: string): PreparedAttachment {
  const text = boundText(redactSecrets(raw), ATTACHMENT_LIMITS.maxTextChars);
  p.upload.text = text;
  if (text !== boundText(raw, ATTACHMENT_LIMITS.maxTextChars)) p.upload.note = `What looked like keys or passwords was replaced with ${REDACTED_SECRET} before sending.`;
  const left = secretProblem(text);
  if (left) p.warning = { label: "may hold a secret", text: `The agent will read this file and ${left}. Remove it if it should not.` };
  else if (p.upload.note) p.warning = { label: "keys hidden", text: p.upload.note };
  return p;
}

async function prepareImage(file: File, codec: ImageCodec): Promise<PreparedAttachment> {
  if (file.size > MAX_RAW_IMAGE_BYTES) throw new AttachmentProblem(`${file.name} is too large to read (over ${MAX_RAW_IMAGE_BYTES / 1024 / 1024} MB)`);
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new AttachmentProblem(`${file.name}: this image format cannot be read here (use PNG, JPEG, GIF or WebP)`);
  }
  try {
    const fit = fitImage(image.width, image.height);
    const resized = fit.width !== image.width || fit.height !== image.height;
    const readable = MODEL_IMAGE_TYPES.includes(file.type);
    let blob: Blob = file;
    let type = file.type;
    if (resized || !readable || file.size > ATTACHMENT_LIMITS.maxImageBytes) {
      // Screenshots and drawings stay sharp as PNG; photos (and formats the model does not read) become JPEG.
      type = file.type === "image/png" || file.type === "image/gif" ? "image/png" : file.type === "image/webp" ? "image/webp" : "image/jpeg";
      blob = await image.encode(fit.width, fit.height, type);
      for (const quality of JPEG_QUALITIES) {
        if (blob.size <= ATTACHMENT_LIMITS.maxImageBytes) break;
        type = "image/jpeg";
        blob = await image.encode(fit.width, fit.height, type, quality);
      }
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const thumbSize = fitWithin(fit.width, fit.height, THUMB_EDGE_PX);
    const thumb = new Uint8Array(await (await image.encode(thumbSize.width, thumbSize.height, "image/jpeg", 0.7)).arrayBuffer());
    const upload: UiAttachmentUpload = {
      name: type === file.type ? file.name : renamed(file.name, type),
      type,
      dataBase64: bytesToBase64(bytes),
      width: fit.width,
      height: fit.height,
      thumb: `data:image/jpeg;base64,${bytesToBase64(thumb)}`,
    };
    return { upload, kind: "image", size: bytes.length };
  } finally {
    image.close();
  }
}

/** The size within `edge` px on the long side, aspect kept (never larger). */
function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

/** The file's name with the extension of its new format ("photo.heic" as JPEG: "photo.jpg"). */
function renamed(name: string, type: string): string {
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "image";
  return `${stem}${EXT[type] ?? ""}`;
}
