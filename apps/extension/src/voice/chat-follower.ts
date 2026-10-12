/**
 * Which chat's events a hands-free session narrates: the chat the panel
 * shows. A message sent from a new chat starts one whose id the panel learns
 * only when the request is answered, and its first events can arrive before
 * that, over the UI port. So events of other chats are kept for a while, and
 * once the followed chat changes, its events since the last message are
 * handed back to narrate (never older ones: switching to another tab's chat
 * does not replay its past). Pure.
 */
import type { StampedAgentEvent } from "@noa/shared";

/** Events of chats not followed kept at most. */
const MAX_KEPT = 200;
/** Events this much older than the message are still its chat's (clocks of the page and the background differ a little). */
const CLOCK_SLACK_MS = 1_000;

export class ChatFollower {
  private followed: string | null = null;
  private sentAt = -Infinity;
  private kept: StampedAgentEvent[] = [];

  constructor(private readonly current: () => string | null) {}

  /** A session starts: it follows the chat shown now, nothing kept. */
  start(): void {
    this.followed = this.current();
    this.sentAt = -Infinity;
    this.kept = [];
  }

  /** A message went out at `now`. */
  sent(now: number): void {
    this.sentAt = now;
  }

  /** An event of any chat: the events to narrate now (this one, and a newly followed chat's kept ones first). */
  push(ev: StampedAgentEvent): StampedAgentEvent[] {
    const out = this.refresh();
    if (ev.sessionId === this.followed) return [...out, ev];
    this.kept.push(ev);
    if (this.kept.length > MAX_KEPT) this.kept.shift();
    return out;
  }

  /** The panel's chat may have changed: when it did, the new chat's events since the last message. */
  refresh(): StampedAgentEvent[] {
    const next = this.current();
    if (next === this.followed) return [];
    this.followed = next;
    const since = this.sentAt - CLOCK_SLACK_MS;
    const replay = this.kept.filter((e) => e.sessionId === next && Date.parse(e.ts) >= since);
    this.kept = [];
    return replay;
  }
}
