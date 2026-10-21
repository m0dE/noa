/**
 * Text Claude is still writing (assistant_text_delta events), per stream id,
 * until the block's final assistant_text arrives. DOM-free: the chat asks
 * what changed and updates its elements (see chat.ts).
 *
 * Thinking (deltas marked thinking: the summary of a thinking block) never
 * gets a final text. A conversation shows only its latest thinking, while it
 * is the latest thing the model wrote: the next thinking, the answer's text
 * or the end of the turn takes it off the screen. Tool calls leave it, so
 * what the model is about while a step runs stays in view.
 */
import { streamMessageOf, type StampedAgentEvent } from "@noa/shared";

type Delta = Extract<StampedAgentEvent, { type: "assistant_text_delta" }>;

/** What a settling event means for the live texts on screen. */
export interface Settled {
  /** The live text (stream id) the event's final text replaces, if one was live. */
  replaces: string | null;
  /** Live texts to take off the screen: earlier messages that never got their final text (a retried request), and thinking the event supersedes. */
  drop: string[];
  /** Live texts that stay as written but are no longer live (the turn ended without their final text). */
  freeze: string[];
}

/** Live texts of conversations not shown are kept up to this many. */
export const MAX_LIVE = 20;

interface Live {
  sessionId: string;
  text: string;
  thinking: boolean;
}

export class LiveTexts {
  private readonly texts = new Map<string, Live>();

  /**
   * Adds a delta; returns the stream's whole text so far, and the live texts it takes off the screen (an earlier
   * thinking of the conversation, when this is new thinking or the answer's text).
   */
  add(ev: Delta): { text: string; drop: string[] } {
    let t = this.texts.get(ev.id);
    const drop: string[] = [];
    if (!t) {
      drop.push(...this.dropThinking(ev.sessionId));
      t = { sessionId: ev.sessionId, text: "", thinking: !!ev.thinking };
      this.texts.set(ev.id, t);
      for (const [k, v] of this.texts) if (this.texts.size > MAX_LIVE && v.sessionId !== ev.sessionId) this.texts.delete(k);
    }
    t.text += ev.text;
    return { text: t.text, drop };
  }

  /** The live texts of a conversation, oldest first. */
  of(sessionId: string): [id: string, text: string][] {
    return [...this.texts].filter(([, t]) => t.sessionId === sessionId).map(([id, t]) => [id, t.text]);
  }

  /** Whether the live text `id` is thinking. */
  isThinking(id: string): boolean {
    return this.texts.get(id)?.thinking ?? false;
  }

  /**
   * Any other event of a conversation. assistant_text with an id completes
   * that stream (and drops live texts of earlier messages); any
   * assistant_text drops the thinking; task_end ends the turn (the thinking
   * goes, what else is still live stays as written).
   */
  settle(ev: StampedAgentEvent): Settled {
    const out: Settled = { replaces: null, drop: [], freeze: [] };
    if (ev.type === "task_end") {
      for (const [id, t] of this.texts) {
        if (t.sessionId !== ev.sessionId) continue;
        (t.thinking ? out.drop : out.freeze).push(id);
        this.texts.delete(id);
      }
      return out;
    }
    if (ev.type !== "assistant_text") return out;
    out.drop.push(...this.dropThinking(ev.sessionId));
    if (!ev.id) return out;
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

  /** Forgets the conversation's live thinking; returns its stream ids. */
  private dropThinking(sessionId: string): string[] {
    const ids = [...this.texts].filter(([, t]) => t.sessionId === sessionId && t.thinking).map(([id]) => id);
    for (const id of ids) this.texts.delete(id);
    return ids;
  }
}
