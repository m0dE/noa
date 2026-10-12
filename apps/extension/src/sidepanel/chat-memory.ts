/**
 * Memory for one chat: the composer's menu has a Memory switch for the chat
 * the tab shows. A conversation keeps its choice (SessionInfo.memoryOff, set
 * with chat.setMemory); in a new chat the choice waits for the first message
 * (run.adhoc / run.message carry memoryOff) and belongs to the browser tab.
 * While memory is off in the chat shown, a small button next to the model
 * says so and turns it back on. Memory paused in Settings wins over both.
 */
import { errorMessage, type SessionInfo } from "@noa/shared";
import { uiRequest } from "../ui-protocol.js";

/** What the menu's Memory switch and the composer's "memory off" button show. */
export interface ChatMemoryView {
  /** The switch is on: this chat uses and saves memory. */
  on: boolean;
  /** Memory is paused in Settings: the switch cannot turn it on here. */
  disabled: boolean;
  /** The switch's second line. */
  hint: string;
  /** The "memory off" button next to the model shows. */
  offBadge: boolean;
}

export function chatMemoryView(s: { paused: boolean; off: boolean; conversation: boolean }): ChatMemoryView {
  if (s.paused) return { on: false, disabled: true, hint: "Paused in settings", offBadge: false };
  if (s.off) return { on: false, disabled: false, hint: s.conversation ? "Off in this chat" : "Off for this new chat", offBadge: true };
  return { on: true, disabled: false, hint: "Uses and saves what it learns", offBadge: false };
}

export class ChatMemory {
  /** Browser tabs whose next new chat starts with memory off. */
  private readonly newChatsOff = new Set<number>();
  private session: SessionInfo | null = null;
  private paused = false;

  constructor(
    private readonly opts: {
      /** The browser tab the panel shows the chat of (null: unknown). */
      tabId(): number | null;
      /** The view changed (redraw the menu and the badge). */
      onChange(): void;
      onError(message: string): void;
    },
  ) {}

  /** The chat shown. Once a new chat has started, its choice lives in the conversation, and the tab's is used up. */
  setConversation(session: SessionInfo | null): void {
    this.session = session;
    if (session) this.newChatsOff.delete(this.opts.tabId() ?? -1);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  view(): ChatMemoryView {
    return chatMemoryView({ paused: this.paused, off: this.off(), conversation: !!this.session });
  }

  /** The Memory switch or the badge: flips memory for the chat shown. */
  async toggle(): Promise<void> {
    if (this.paused) return;
    const s = this.session;
    if (!s) {
      const tab = this.opts.tabId() ?? -1;
      if (this.newChatsOff.has(tab)) this.newChatsOff.delete(tab);
      else this.newChatsOff.add(tab);
      this.opts.onChange();
      return;
    }
    try {
      const { session } = await uiRequest({ type: "chat.setMemory", sessionId: s.sessionId, on: !!s.memoryOff });
      if (this.session?.sessionId === session.sessionId) this.session = session;
    } catch (err) {
      this.opts.onError(`Memory not changed: ${errorMessage(err)}`);
    }
    this.opts.onChange();
  }

  /** What a request that starts a new chat from `tab` carries: memory off when that was chosen for it. */
  forNewChat(tab: number | null = this.opts.tabId()): { memoryOff?: true } {
    return this.newChatsOff.has(tab ?? -1) ? { memoryOff: true } : {};
  }

  private off(): boolean {
    return this.session ? !!this.session.memoryOff : this.newChatsOff.has(this.opts.tabId() ?? -1);
  }
}
