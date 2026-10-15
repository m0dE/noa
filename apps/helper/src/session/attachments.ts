/**
 * Files the user attached to a conversation, on the helper's side. The
 * extension sends each one ahead in pieces (helper.putAttachment) into the
 * inbox; the session's next turn moves it into its run folder's attachments/
 * folder, where the upload tool may attach it from, and shows its images and
 * PDFs to the model as blocks in that turn's message (withBytes).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_LIMITS, RpcError, safeFileName, uniqueNames, type AgentAttachment } from "@noa/shared";
import type { ApiAttachment } from "@noa/core";

/** The run folder's subfolder the attachments go in. */
export const ATTACHMENTS_DIR = "attachments";

/**
 * The attachments, with the bytes (base64) of each placed image or PDF that `show` picks, for the model to see
 * (attachmentBlocks): this message's first, then the earlier ones newest first, up to `maxBytes` together (a new
 * session for a long conversation would otherwise send every earlier file in one request, as the API brain's
 * history keeps at most that much). One left out, or that cannot be read, goes without and is marked `withheld`:
 * the model is told it could not be shown.
 */
export function withBytes(attachments: readonly AgentAttachment[], show: (a: AgentAttachment) => boolean, maxBytes = ATTACHMENT_LIMITS.maxMessageBytes): ApiAttachment[] {
  const out: ApiAttachment[] = [...attachments];
  const order = attachments.map((a, i) => ({ a, i })).sort((x, y) => Number(y.a.fresh) - Number(x.a.fresh) || y.i - x.i);
  let used = 0;
  for (const { a, i } of order) {
    if (!a.path || !show(a) || (a.ref.kind !== "image" && a.ref.kind !== "pdf")) continue;
    try {
      const bytes = readFileSync(a.path);
      used += bytes.length;
      out[i] = used > maxBytes ? { ...a, withheld: true } : { ...a, base64: bytes.toString("base64") };
    } catch {
      out[i] = { ...a, withheld: true };
    }
  }
  return out;
}

/** A name that is only letters, digits, _ and - (ids from the extension end up in paths). */
function safeId(id: string, what: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new RpcError(`invalid ${what}`, "invalid_params");
  return id;
}

/** Where attachments wait for their session's next turn, one folder per session. */
export class AttachmentInbox {
  constructor(private readonly dir: string) {}

  /** Starts empty: sessions (and what waited for them) do not outlive the helper. */
  clear(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Adds one piece at `offset` (0 starts the file over); returns the bytes held now. */
  put(p: { sessionId: string; id: string; offset: number; dataBase64: string }): { size: number } {
    const file = this.file(p.sessionId, p.id);
    const bytes = Buffer.from(p.dataBase64, "base64");
    if (bytes.length > ATTACHMENT_CHUNK_BYTES) throw new RpcError(`a piece can be at most ${ATTACHMENT_CHUNK_BYTES} bytes`, "invalid_params");
    const held = p.offset === 0 ? 0 : existsSync(file) ? statSync(file).size : -1;
    if (held !== p.offset) throw new RpcError(`attachment ${p.id}: expected the piece at ${Math.max(0, held)}, got ${p.offset}`, "invalid_params");
    if (held + bytes.length > ATTACHMENT_LIMITS.maxFileBytes) throw new RpcError(`attachment ${p.id} is larger than ${ATTACHMENT_LIMITS.maxFileBytes} bytes`, "invalid_params");
    mkdirSync(join(this.dir, p.sessionId), { recursive: true });
    if (p.offset === 0) writeFileSync(file, bytes);
    else appendFileSync(file, bytes);
    return { size: held + bytes.length };
  }

  /**
   * The attachments of a turn with their paths in `runDir`/attachments: each one waiting in the inbox moves there
   * (named after the file, made unique); one the session placed before keeps its path (`placed`, updated). One that
   * is neither comes without a path (the model is told it cannot open it).
   */
  place(sessionId: string, runDir: string, attachments: readonly AgentAttachment[], placed: Map<string, string>): AgentAttachment[] {
    const dir = join(runDir, ATTACHMENTS_DIR);
    const waiting = attachments.filter((a) => !placed.has(a.ref.id) && existsSync(this.file(sessionId, a.ref.id)));
    if (waiting.length) {
      mkdirSync(dir, { recursive: true });
      const taken = new Set(readdirSync(dir).map((n) => n.toLowerCase()));
      // uniqueNames over the folder's names and the new ones; only the new ones are used.
      const names = uniqueNames([...taken, ...waiting.map((a) => safeFileName(a.ref.name, a.ref.type))]).slice(taken.size);
      waiting.forEach((a, i) => {
        const path = join(dir, names[i]!);
        renameSync(this.file(sessionId, a.ref.id), path);
        placed.set(a.ref.id, path);
      });
    }
    return attachments.map((a) => {
      const path = placed.get(a.ref.id);
      return path ? { ...a, path } : a;
    });
  }

  /** Whatever still waits for this session (its turn never started). */
  drop(sessionId: string): void {
    rmSync(join(this.dir, safeId(sessionId, "session id")), { recursive: true, force: true });
  }

  private file(sessionId: string, id: string): string {
    return join(this.dir, safeId(sessionId, "session id"), safeId(id, "attachment id"));
  }
}
