/**
 * What Claude Code is doing, read from its stream-json output (with
 * --include-partial-messages and --replay-user-messages), so the brain knows
 * when a message written to its stdin has been read, when its turn is really
 * over, and when it may be interrupted.
 *
 * - Claude Code reads a stdin message at its next step: right away when idle,
 *   else after the running tool (merged into the same turn, one `result` for
 *   both). --replay-user-messages echoes each one (`isReplay: true`) at that
 *   moment, so counting writes and echoes says whether a `result` ends the
 *   work or more input is already queued.
 * - A model request runs from `system/status: requesting` to the stream's
 *   `message_stop`. While it has started no tool_use block and no tool call
 *   is open, interrupting it throws away only text or thinking, never an
 *   action half done.
 * - A message written while a tool ran is read with that tool's result (its
 *   echo comes before the next request). A request that starts after a tool
 *   result without reading it missed it: only an interrupt gets it read now.
 *
 * Every line is untrusted JSON: each field is checked before use.
 */
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** The text of a user message's content (a string, or text blocks). */
export function userMessageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.map((b) => obj(b)).filter((b) => b?.type === "text" && typeof b.text === "string");
  return texts.length ? texts.map((b) => b!.text as string).join("") : null;
}

export class ClaudeTurnState {
  /** stdin messages Claude Code has not echoed (read) yet. */
  private unread = 0;
  private requesting = false;
  private toolBlockStarted = false;
  private readonly openTools = new Set<string>();
  /** Input was unread when the last tool result came back. */
  private unreadAtStep = false;
  /** The running request started after a tool result without reading input written before it. */
  private missed = false;

  /** A user message was written to stdin. */
  wrote(): void {
    this.unread++;
  }

  /** Messages written and not read yet: a `result` now does not end the work. */
  get pendingInput(): boolean {
    return this.unread > 0;
  }

  /**
   * The model is writing text or thinking, with no action started: an
   * interrupt loses only that text (the next request starts right away).
   */
  get interruptible(): boolean {
    return this.requesting && !this.toolBlockStarted && this.openTools.size === 0;
  }

  /** The running request missed input written before it (see the file comment) and can still be interrupted. */
  get missedInput(): boolean {
    return this.missed && this.interruptible;
  }

  /** One parsed stream-json line. Returns the text of a stdin message Claude Code just read (its echo), else null. */
  line(value: unknown): string | null {
    const ev = obj(value);
    if (!ev) return null;
    switch (ev.type) {
      case "system":
        if (ev.subtype === "status" && ev.status === "requesting") {
          this.requesting = true;
          this.toolBlockStarted = false;
          this.missed = this.unreadAtStep && this.unread > 0;
          this.unreadAtStep = false;
        }
        return null;
      case "stream_event": {
        if (ev.parent_tool_use_id) return null;
        const e = obj(ev.event);
        if (e?.type === "message_start") this.requesting = true;
        if (e?.type === "content_block_start" && obj(e.content_block)?.type === "tool_use") this.toolBlockStarted = true;
        if (e?.type === "message_stop") this.requesting = false;
        return null;
      }
      case "assistant":
        for (const b of asArray(obj(ev.message)?.content)) if (b?.type === "tool_use" && typeof b.id === "string") this.openTools.add(b.id);
        return null;
      case "user": {
        const message = obj(ev.message);
        if (ev.isReplay === true) {
          this.unread = Math.max(0, this.unread - 1);
          if (this.unread === 0) this.missed = false;
          return userMessageText(message?.content);
        }
        for (const b of asArray(message?.content)) {
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          this.openTools.delete(b.tool_use_id);
          this.unreadAtStep = this.unread > 0;
        }
        return null;
      }
      case "result":
        this.requesting = false;
        this.toolBlockStarted = false;
        this.missed = false;
        this.unreadAtStep = false;
        this.openTools.clear();
        return null;
    }
    return null;
  }
}

function asArray(v: unknown): (Obj | null)[] {
  return Array.isArray(v) ? v.map(obj) : [];
}
