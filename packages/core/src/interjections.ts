/**
 * Messages the user sends while a turn runs ("interjections"), for both
 * brains. They take priority over the task the agent is working on, so they
 * reach the model at the first moment it can read anything, always as a user
 * message of their own (never inside a tool result: the model rightly treats
 * tool results as untrusted page content, and a page could fake one):
 *
 * - Claude API: as user text in the next Messages request, next to the tool
 *   results (api-agent.ts).
 * - Claude Code: written to its stdin at once, which it reads at its next
 *   step; while the model is only thinking or writing, that request is
 *   interrupted so the message is read now (brains/claude-code.ts).
 *
 * Until the model has read them, the turn cannot end: the tool executor
 * refuses task_complete / task_fail / task_pause, so an answer written before
 * the user spoke never closes the turn on the old goal. act also stops before
 * its next step, and a tool waiting for a page to load (navigate, open_tabs,
 * read_page) stops waiting, so the model reads the message within moments,
 * not when the page has loaded.
 */
import { stopwatch } from "@noa/shared";

/** How the model gets an interjection: the framing both brains use. */
export function interjectionText(texts: readonly string[]): string {
  const said = texts.map((t) => `"${t.trim()}"`).join(", then: ");
  return `The user just said: ${said}. Act on it now: a question or remark, answer it in a short reply before your next tool call (in the same message) and go on with the task; otherwise it changes the current task (keep doing what it does not change), or replaces or stops it if that is what it says.`;
}

/** Start of the answer to a task_* call made while a message from the user was still unread. */
const UNREAD_INTERJECTION = "Not recorded: the user sent you a new message";

/** Answer of a task_* call made while a message from the user was still unread (the message itself follows as a user message). */
export function unreadInterjection(tool: string): string {
  return `${UNREAD_INTERJECTION}, so ${tool} was not called. Read that message (it follows) and do what it asks before ending.`;
}

/**
 * How an interjection reached the model, for the trace: in a Messages
 * request, at Claude Code's next step, by interrupting the model's request,
 * or as the next message after the model stopped.
 */
export type InterjectionRoute = "request" | "next_step" | "interrupt" | "next_message";

interface Pending {
  text: string;
  since: () => number;
}

export class Interjections {
  private queued: Pending[] = [];
  /** Handed to a message of their own that the model has not read yet (Claude Code's stdin). */
  private handedOff: { framed: string; since: () => number; route: InterjectionRoute; count: number }[] = [];
  private readonly listeners: ((text: string) => void)[] = [];

  /** delivered: each time the model got messages, with how long the oldest one waited (for the trace). */
  constructor(private readonly delivered?: (route: InterjectionRoute, waitedMs: number, count: number) => void) {}

  add(text: string): void {
    if (!text.trim()) return;
    this.queued.push({ text, since: stopwatch() });
    for (const fn of this.listeners) {
      try {
        fn(text);
      } catch {
        /* a listener must not stop the message */
      }
    }
  }

  /** Called after each add(), with what the user said. Returns what stops it. */
  onAdd(fn: (text: string) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Resolves once the model has a message it has not read: when the user sends one (and the brain did not read it
   * at once), or at once when one is waiting already (unless `onlyNew`). cancel() stops waiting (it never resolves then).
   */
  spoken(onlyNew = false): { when: Promise<void>; cancel: () => void } {
    let cancel = () => {};
    const when = new Promise<void>((resolve) => {
      if (this.unseen && !onlyNew) return resolve();
      cancel = this.onAdd(() => this.unseen && resolve());
    });
    return { when, cancel };
  }

  /** Messages the model has not read yet: the turn must not end. */
  get unseen(): boolean {
    return this.queued.length > 0 || this.handedOff.length > 0;
  }

  /** Messages handed off and not read yet. */
  get unread(): boolean {
    return this.handedOff.length > 0;
  }

  /** The waiting messages, framed, for what goes to the model right now (they count as read). Null when none. */
  take(route: InterjectionRoute): string | null {
    const batch = this.queued.splice(0);
    if (!batch.length) return null;
    this.report(route, batch[0]!.since(), batch.length);
    return interjectionText(batch.map((q) => q.text));
  }

  /** Like take(), for a message of their own the model reads later: they stay unseen until seen() confirms it. */
  handOff(route: InterjectionRoute): string | null {
    const batch = this.queued.splice(0);
    if (!batch.length) return null;
    const framed = interjectionText(batch.map((q) => q.text));
    this.handedOff.push({ framed, since: batch[0]!.since, route, count: batch.length });
    return framed;
  }

  /** How the messages handed off and not read yet will be read (an interrupt changes it). */
  reroute(route: InterjectionRoute): void {
    for (const h of this.handedOff) h.route = route;
  }

  /** The model read `text` (Claude Code echoed that stdin message). */
  seen(text: string): void {
    const i = this.handedOff.findIndex((h) => h.framed === text);
    if (i < 0) return;
    const [h] = this.handedOff.splice(i, 1);
    this.report(h!.route, h!.since(), h!.count);
  }

  /** Nothing is waiting any more (the turn ended, the session closed). */
  clear(): void {
    this.queued = [];
    this.handedOff = [];
  }

  private report(route: InterjectionRoute, waitedMs: number, count: number): void {
    try {
      this.delivered?.(route, waitedMs, count);
    } catch {
      /* the trace must not stop the message */
    }
  }
}

/**
 * The work's result, or `instead()` as soon as the model has a message from the user it has not read (`spoken`,
 * see Interjections.spoken): a wait for a page is not worth more than what the user just said. The work goes on
 * and is let go (a later failure is no unhandled rejection).
 */
export async function untilUserSpeaks<T>(work: Promise<T>, spoken: ReturnType<Interjections["spoken"]>, instead: () => T): Promise<T> {
  try {
    return await Promise.race([work, spoken.when.then(instead)]);
  } finally {
    spoken.cancel();
    work.catch(() => undefined);
  }
}
