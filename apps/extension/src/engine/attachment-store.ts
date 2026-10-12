/**
 * Files the user sent in a chat, kept in IndexedDB under their conversation:
 * the bytes (an image already brought to the model's size), the text the model
 * reads of a document, and the reference the chat shows. Sessions and events
 * hold only the reference (AttachmentRef); these records go when their
 * conversation is deleted (SessionStore's prune).
 */
import { ATTACHMENT_LIMITS, attachmentKind, attachmentRefusal, boundText, MODEL_IMAGE_TYPES, type AttachmentRef } from "@noa/shared";
import { base64ToBytes } from "../base64.js";
import type { UiAttachmentUpload } from "../ui-protocol.js";
import type { KvDb, KvStore } from "./kv.js";

/** A thumbnail larger than this (data URL characters) is dropped: the chat keeps references, not images. */
export const MAX_THUMB_CHARS = 40_000;

/** A file as the side panel sent it, before it is stored. */
export interface IncomingAttachment {
  ref: Omit<AttachmentRef, "id" | "size">;
  blob: Blob;
  /** text and docx: what the model reads (bounded, secrets replaced in the panel). */
  text?: string;
}

/** A stored attachment. */
export interface AttachmentRecord {
  ref: AttachmentRef;
  blob: Blob;
  text?: string;
}

export class AttachmentStore {
  private readonly store: KvStore<AttachmentRecord>;
  private seq = 0;

  constructor(
    db: KvDb,
    private readonly opts: { now?: () => number; newId?: () => string } = {},
  ) {
    this.store = db.store<AttachmentRecord>("attachments");
  }

  /** Stores a message's files in its conversation; returns their references, in order. */
  async add(sessionId: string, files: readonly IncomingAttachment[]): Promise<AttachmentRef[]> {
    const refs: AttachmentRef[] = [];
    for (const f of files) {
      const id = this.opts.newId?.() ?? `att-${crypto.randomUUID()}`;
      const ref: AttachmentRef = { ...f.ref, id, size: f.blob.size };
      // Keys sort in the order the files were sent: time, then a counter for the same millisecond.
      const key = `${sessionId}:${String(this.opts.now?.() ?? Date.now()).padStart(15, "0")}-${String(this.seq++ % 1e6).padStart(6, "0")}`;
      await this.store.put(key, { ref, blob: f.blob, ...(f.text === undefined ? {} : { text: f.text }) });
      refs.push(ref);
    }
    return refs;
  }

  /** The conversation's files, in the order they were sent. */
  async list(sessionId: string): Promise<AttachmentRecord[]> {
    return (await this.store.list(`${sessionId}:`)).map((e) => e.value);
  }

  /** Deletes the conversation's files. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.store.deletePrefix(`${sessionId}:`);
  }
}

/**
 * The files of a message as the side panel sent them, checked again here (count, sizes, text length): the panel
 * says why before sending, so a refusal here is an error.
 */
export function incomingAttachments(uploads: unknown): IncomingAttachment[] {
  if (uploads === undefined) return [];
  if (!Array.isArray(uploads)) throw new Error("attachments must be a list");
  const out: IncomingAttachment[] = [];
  let chars = 0;
  for (const u of uploads as Partial<UiAttachmentUpload>[]) {
    if (typeof u?.name !== "string" || typeof u.dataBase64 !== "string") throw new Error("an attachment needs a name and its data");
    const type = typeof u.type === "string" && u.type ? u.type : "application/octet-stream";
    const named = attachmentKind(u.name, type);
    // The model sees only the image formats it reads (the panel re-encodes others); any other is a file to upload.
    const kind = named === "image" && !MODEL_IMAGE_TYPES.includes(type) ? "file" : named;
    const blob = new Blob([base64ToBytes(u.dataBase64)], { type });
    const refusal = attachmentRefusal({ name: u.name, size: blob.size, kind }, out.map((f) => ({ size: f.blob.size })));
    if (refusal) throw new Error(refusal);
    const ref: IncomingAttachment["ref"] = { name: u.name.slice(0, 200), type, kind };
    if (kind === "image" && isSize(u.width) && isSize(u.height)) Object.assign(ref, { width: u.width, height: u.height });
    if (typeof u.thumb === "string" && u.thumb.startsWith("data:image/") && u.thumb.length <= MAX_THUMB_CHARS) ref.thumb = u.thumb;
    if (typeof u.note === "string" && u.note.trim()) ref.note = u.note.trim().slice(0, 300);
    const f: IncomingAttachment = { ref, blob };
    if ((kind === "text" || kind === "docx") && typeof u.text === "string") {
      const room = Math.max(0, Math.min(ATTACHMENT_LIMITS.maxTextChars, ATTACHMENT_LIMITS.maxMessageTextChars - chars));
      f.text = boundText(u.text, room);
      chars += Math.min(u.text.length, room);
    }
    out.push(f);
  }
  return out;
}

function isSize(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 100_000;
}
