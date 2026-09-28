/**
 * Files the user attaches to a chat message (pasted, dropped or picked in the
 * side panel): how many and how big, what kind each is, the size an image is
 * brought to before the model sees it, and what a brain is given about each.
 *
 * Image limits follow Anthropic's vision guide
 * (https://platform.claude.com/docs/en/build-with-claude/vision, checked 2026-09-27):
 * JPEG, PNG, GIF and WebP; high-resolution models see up to 2576 px on the long
 * edge and 4784 visual tokens (one per 28x28 patch), larger images are
 * downscaled by the API; a request with more than 20 images rejects any image
 * over 2000 px on a side. PDFs go as document blocks (pdf-support guide: 32 MB
 * per request, 100 pages under a 1M context). The hosted AI takes request
 * bodies up to 20 MB (apps/api MAX_AI_BODY_BYTES), and base64 adds a third.
 */

const MB = 1024 * 1024;

export const ATTACHMENT_LIMITS = {
  /** Files one message can carry. */
  maxFiles: 10,
  /** One image, after it was downscaled and re-encoded. */
  maxImageBytes: 5 * MB,
  /** One document or other file. */
  maxFileBytes: 10 * MB,
  /** All files of one message together: as base64 in a request they stay well under the hosted AI's 20 MB body. */
  maxMessageBytes: 10 * MB,
  /** Characters of one text or Word file the model reads (the rest is cut, and it is told so). */
  maxTextChars: 60_000,
  /** Characters of every text or Word file of one message together. */
  maxMessageTextChars: 120_000,
} as const;

/**
 * Longest image edge sent to the model. 2000 px rather than the high-resolution tier's 2576: a conversation's
 * attachments and screenshots can pass 20 images in one request, where the API refuses anything larger.
 */
export const IMAGE_MAX_EDGE_PX = 2000;
/** Visual tokens of the high-resolution tier: a larger image would be downscaled by the API anyway. */
export const IMAGE_MAX_VISUAL_TOKENS = 4784;
/** One visual token covers a square of this many pixels. */
export const IMAGE_PATCH_PX = 28;
/** Image formats the model reads as they are; any other image is re-encoded. */
export const MODEL_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Files sent to a conversation whose turn is running: its agent takes files only with a new turn. */
export const FILES_WHILE_RUNNING = "The agent is working: send the files once it finishes, or Stop it first";

/** image and pdf: the model sees them; text and docx: it reads their text; file: it can only upload them. */
export type AttachmentKind = "image" | "pdf" | "text" | "docx" | "file";

/** An attachment as the chat keeps it (the bytes live in the extension's attachment store under `id`). */
export interface AttachmentRef {
  id: string;
  name: string;
  /** Media type of the stored bytes (an image's after re-encoding). */
  type: string;
  /** Bytes stored. */
  size: number;
  kind: AttachmentKind;
  /** Images: the size the model sees. */
  width?: number;
  height?: number;
  /** Images: a small JPEG data URL for the chat's bubble. */
  thumb?: string;
  /** Said with it in the chat, e.g. that secrets in its text were replaced before sending. */
  note?: string;
}

/** An attachment as a brain gets it for a turn. */
export interface AgentAttachment {
  ref: Omit<AttachmentRef, "thumb">;
  /** Came with this turn's message; earlier ones are listed so they can still be uploaded. */
  fresh: boolean;
  /** text and docx: what the model reads (bounded, secrets replaced). */
  text?: string;
  /** Absolute local path the upload tool may attach (and Claude Code may Read). */
  path?: string;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-ndjson|ld\+json|javascript|typescript|sql|x-sh|toml)\b)/i;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|xml|ya?ml|toml|ini|log|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|cs|sh|ps1|sql|srt|vtt)$/i;
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** What kind of attachment a file is, from its media type and name. */
export function attachmentKind(name: string, type: string): AttachmentKind {
  const t = type.split(";")[0]!.trim().toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf" || (!t && /\.pdf$/i.test(name))) return "pdf";
  if (t === DOCX_TYPE || /\.docx$/i.test(name)) return "docx";
  if (TEXT_TYPES.test(t) || TEXT_EXTENSIONS.test(name)) return "text";
  return "file";
}

/** The largest size within IMAGE_MAX_EDGE_PX and IMAGE_MAX_VISUAL_TOKENS, aspect kept; never larger than the image. */
export function fitImage(width: number, height: number): { width: number; height: number } {
  const tokens = (w: number, h: number) => Math.ceil(w / IMAGE_PATCH_PX) * Math.ceil(h / IMAGE_PATCH_PX);
  let scale = Math.min(1, IMAGE_MAX_EDGE_PX / Math.max(width, height));
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  // Patches round up, so shrink in small steps until the token count fits.
  while (tokens(w, h) > IMAGE_MAX_VISUAL_TOKENS) {
    scale *= 0.98;
    w = Math.max(1, Math.round(width * scale));
    h = Math.max(1, Math.round(height * scale));
  }
  return { width: w, height: h };
}

/** Why a file cannot be added to a message that already holds `held` (null: it can). */
export function attachmentRefusal(file: { name: string; size: number; kind: AttachmentKind }, held: readonly { size: number }[]): string | null {
  if (held.length >= ATTACHMENT_LIMITS.maxFiles) return `At most ${ATTACHMENT_LIMITS.maxFiles} files per message`;
  const max = file.kind === "image" ? ATTACHMENT_LIMITS.maxImageBytes : ATTACHMENT_LIMITS.maxFileBytes;
  if (file.size > max) return `${file.name} is ${mb(file.size)}; ${file.kind === "image" ? "images" : "files"} can be at most ${mb(max)}`;
  const total = held.reduce((n, f) => n + f.size, 0) + file.size;
  if (total > ATTACHMENT_LIMITS.maxMessageBytes) return `${file.name} does not fit: the files of one message can be at most ${mb(ATTACHMENT_LIMITS.maxMessageBytes)} together`;
  return null;
}

/** `text` cut to `max` characters, saying how much was left out. */
export function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[cut here: ${text.length - max} more characters not included]`;
}

function mb(bytes: number): string {
  const v = bytes / MB;
  return `${Number.isInteger(v) ? v : v.toFixed(1)} MB`;
}

/**
 * Bytes of an attachment per helper.putAttachment call. Native messaging limits a message from the helper to
 * 1 MB (Chrome to the helper allows more); pieces this size keep both directions and the helper's memory small.
 */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
