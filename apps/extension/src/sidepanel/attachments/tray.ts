/**
 * The files waiting in the input box to go with the next message: added by
 * paste, drop or the paperclip, prepared one after another (prepare.ts, so the
 * message's size limits count what came before), removable at any time. A file
 * that cannot go is not kept: the tray reports why (onProblem).
 */
import { ATTACHMENT_LIMITS, attachmentKind, type AttachmentKind } from "@noa/shared";
import type { UiAttachmentUpload } from "../../ui-protocol.js";
import type { PreparedAttachment } from "./prepare.js";
import { AttachmentProblem } from "./prepare.js";

export interface TrayItem {
  /** The tray's own id for the chip. */
  id: string;
  name: string;
  kind: AttachmentKind;
  /** The file's size, then (once ready) the bytes that will be sent. */
  size: number;
  status: "preparing" | "ready";
  prepared?: PreparedAttachment;
}

/** Files going out with one message (AttachmentTray.batch). */
export interface AttachmentBatch {
  uploads: UiAttachmentUpload[];
  sent(): void;
}

export interface TrayOptions {
  prepare(file: File, held: readonly { size: number }[]): Promise<PreparedAttachment>;
  /** The items changed (added, ready, removed). */
  onChange(): void;
  /** A file was not added, and why. */
  onProblem(text: string): void;
}

export class AttachmentTray {
  private list: TrayItem[] = [];
  private queue: Promise<void> = Promise.resolve();
  private next = 0;

  constructor(private readonly opts: TrayOptions) {}

  items(): readonly TrayItem[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  /** Some file is still being prepared. */
  get busy(): boolean {
    return this.list.some((i) => i.status === "preparing");
  }

  /** Adds files (those past maxFiles are refused at once, with one problem saying so). */
  add(files: readonly File[]): void {
    const room = ATTACHMENT_LIMITS.maxFiles - this.list.length;
    if (files.length > room) this.opts.onProblem(`At most ${ATTACHMENT_LIMITS.maxFiles} files per message${room > 0 ? `: ${files.length - room} not added` : ""}`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const item: TrayItem = { id: `f${++this.next}`, name: file.name || "pasted file", kind: attachmentKind(file.name, file.type), size: file.size, status: "preparing" };
      this.list.push(item);
      this.queue = this.queue.then(() => this.prepare(item, file));
    }
    this.opts.onChange();
  }

  remove(id: string): void {
    this.list = this.list.filter((i) => i.id !== id);
    this.opts.onChange();
  }

  /**
   * The files to send, once every one is prepared, and sent(): they went out, the tray lets go of them (files
   * added meanwhile stay for the next message).
   */
  async batch(): Promise<AttachmentBatch> {
    await this.queue;
    const items = this.list.filter((i) => i.prepared);
    return {
      uploads: items.map((i) => i.prepared!.upload),
      sent: () => {
        this.list = this.list.filter((i) => !items.includes(i));
        this.opts.onChange();
      },
    };
  }

  private async prepare(item: TrayItem, file: File): Promise<void> {
    const held = this.list.filter((i) => i.status === "ready").map((i) => ({ size: i.size }));
    try {
      const prepared = await this.opts.prepare(file, held);
      if (!this.list.includes(item)) return;
      Object.assign(item, { status: "ready", prepared, size: prepared.size, name: prepared.upload.name, kind: prepared.kind });
    } catch (err) {
      if (!this.list.includes(item)) return;
      this.list = this.list.filter((i) => i !== item);
      this.opts.onProblem(err instanceof AttachmentProblem ? err.message : `${item.name} could not be added: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.opts.onChange();
  }
}
