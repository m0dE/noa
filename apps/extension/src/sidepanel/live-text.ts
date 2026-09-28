/**
 * Text Claude is still writing (assistant_text_delta events), per stream id,
 * until the block's final assistant_text arrives. DOM-free: the chat asks
 * what changed and updates its elements (see chat.ts).
 */
import { streamMessageOf, type StampedAgentEvent } from "@noa/shared";

type Delta = Extract<StampedAgentEvent, { type: "assistant_text_delta" }>;

/** What a settling event means for the live texts on screen. */
export interface Settled {
  /** The live text (stream id) the event's final text replaces, if one was live. */
  replaces: string | null;
  /** Live texts to take off the screen: earlier messages that never got their final text (a retried request). */
  drop: string[];
  /** Live texts that stay as written but are no longer live (the turn ended without their final text). */
  freeze: string[];
}

/** Live texts of conversations not shown are kept up to this many. */
export const MAX_LIVE = 20;

export class LiveTexts {
  private readonly texts = new Map<string, { sessionId: string; text: string }>();

  /** Adds a delta; returns the stream's whole text so far. */
  add(ev: Delta): string {
    let t = this.texts.get(ev.id);
    if (!t) {
      t = { sessionId: ev.sessionId, text: "" };
      this.texts.set(ev.id, t);
      for (const [k, v] of this.texts) if (this.texts.size > MAX_LIVE && v.sessionId !== ev.sessionId) this.texts.delete(k);
    }
    t.text += ev.text;
    return t.text;
  }

  /** The live texts of a conversation, oldest first. */
  of(sessionId: string): [id: string, text: string][] {
    return [...this.texts].filter(([, t]) => t.sessionId === sessionId).map(([id, t]) => [id, t.text]);
  }

  /**
   * Any other event of a conversation. assistant_text with an id completes
   * that stream (and drops live texts of earlier messages); task_end ends
   * the turn (what is still live stays as written).
   */
  settle(ev: StampedAgentEvent): Settled {
    const out: Settled = { replaces: null, drop: [], freeze: [] };
    if (ev.type === "task_end") {
      for (const [id, t] of this.texts) {
        if (t.sessionId !== ev.sessionId) continue;
        out.freeze.push(id);
        this.texts.delete(id);
      }
      return out;
    }
    if (ev.type !== "assistant_text" || !ev.id) return out;
    const msg = streamMessageOf(ev.id);
    for (const [id, t] of this.texts) {
      if (t.sessionId === ev.sessionId && id !== ev.id && streamMessageOf(id) !== msg) {
        out.drop.push(id);
        this.texts.delete(id);
      }
    }
    if (this.texts.delete(ev.id)) out.replaces = ev.id;
    return out;
  }
}
