/**
 * Chat titles (the rules: shared chat-title.ts). A chat starts titled with its first request, cleaned
 * (fallbackChatTitle). Once its first turn ends, the writer's small model (memory/summarizers.ts: Haiku, paid the
 * same way as the chat's own brain) reads the conversation and names the job in a few words; once more after turn
 * RETITLE_AT_TURN, when the job may have moved on. A title the user gave is never replaced (SessionStore.retitle).
 *
 * A turn's title is written at once, one call at a time, in the worker that ran the turn (a worker that stops
 * meanwhile leaves the cleaned request, and the chat is titled when it is next shown). Chats from before titles, or
 * whose title failed, are titled when a list shows them (the side panel's jobs list): at most
 * MAX_TITLE_BACKFILL per worker start, after the turns' titles and never while a run is going on, like the episode
 * backfill. Brains without a writer (the scripted test brain) keep the cleaned request.
 *
 * A TODO task's series is named once, the same way, from its first run that keeps its instructions (a later turn
 * reads them there, not in the title): the jobs list shows that name for the whole series (sidepanel/jobs.ts). A run
 * of a series that already has a name (the model's or the user's) is not titled.
 */
import {
  buildChatTitlePrompt,
  CHAT_TITLE_MAX_TOKENS,
  CHAT_TITLE_SYSTEM_PROMPT,
  errorMessage,
  parseChatTitle,
  RETITLE_AT_TURN,
  type SessionInfo,
} from "@noa/shared";
import { transcriptLines } from "../memory/episodes.js";
import type { Summarize } from "../memory/summarizers.js";
import type { SessionStore } from "./sessions.js";

/** Most past chats titled in the background per worker start. */
export const MAX_TITLE_BACKFILL = 20;

export interface ChatTitlerDeps {
  sessions: Pick<SessionStore, "get" | "eventsOf" | "retitle">;
  /** The writer's call for a conversation on this brain (null: that brain has none). */
  summarizer(brain: SessionInfo["brain"]): Summarize | null;
  /** A run is going on: past chats wait (absent: never). */
  busy?(): boolean;
  /** A run of this TODO series already has its name (the model's or the user's). Absent: none has. */
  seriesTitled?(seriesId: string): Promise<boolean>;
  log(message: string): void;
}

/**
 * Whether the title model should write this conversation's title now: a chat between turns, whose title is still its
 * request, or the model's from before turn RETITLE_AT_TURN once that turn is over; a TODO run once, when it keeps its
 * instructions and series (see above). Never a title the user gave.
 */
export function titleDue(s: SessionInfo): boolean {
  if (!s.endedAt || s.titleBy === "user") return false;
  if (s.source !== "adhoc") return !s.titleBy && !!s.instructions && !!s.seriesId;
  if (s.titleBy !== "model") return true;
  return (s.turns ?? 1) >= RETITLE_AT_TURN && (s.titledTurn ?? 1) < RETITLE_AT_TURN;
}

export class ChatTitler {
  /** Chats whose turn just ended, first come first titled. */
  private readonly turns: string[] = [];
  /** Past chats a list showed, titled once nothing else waits and no run is going on. */
  private readonly past: string[] = [];
  /** Past chats queued since the worker started (each at most once). */
  private readonly listed = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(private readonly deps: ChatTitlerDeps) {}

  /** A conversation's turn ended: its title is written now when due. Never throws. */
  ended(sessionId: string): void {
    if (!this.turns.includes(sessionId)) this.turns.push(sessionId);
    void this.run();
  }

  /** A list shows these conversations: those still titled with their request get a title in the background. */
  shown(sessions: readonly SessionInfo[]): void {
    for (const s of sessions) {
      if (this.listed.size >= MAX_TITLE_BACKFILL) break;
      if (this.listed.has(s.sessionId) || !titleDue(s) || !this.deps.summarizer(s.brain)) continue;
      this.listed.add(s.sessionId);
      this.past.push(s.sessionId);
    }
    if (this.past.length) void this.run();
  }

  /** Writes what waits, one title at a time; resolves when nothing more may be written now (tests). */
  run(): Promise<void> {
    this.running ??= this.drain().finally(() => (this.running = null));
    return this.running;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const id = this.turns.shift() ?? (this.deps.busy?.() ? undefined : this.past.shift());
      if (!id) return;
      try {
        await this.write(id);
      } catch (err) {
        this.deps.log(`title for ${id} not written: ${errorMessage(err)}`);
      }
    }
  }

  private async write(sessionId: string): Promise<void> {
    const s = await this.deps.sessions.get(sessionId);
    if (!s || !titleDue(s)) return;
    if (s.source !== "adhoc" && (await this.deps.seriesTitled?.(s.seriesId!))) return;
    const summarize = this.deps.summarizer(s.brain);
    if (!summarize) return;
    const lines = transcriptLines(s, await this.deps.sessions.eventsOf(sessionId));
    const reply = await summarize({ system: CHAT_TITLE_SYSTEM_PROMPT, prompt: buildChatTitlePrompt(lines), sessionId, maxTokens: CHAT_TITLE_MAX_TOKENS });
    const title = parseChatTitle(reply.text);
    if (!title) return this.deps.log(`title for ${sessionId}: the model's answer is not a title that may be kept`);
    const saved = await this.deps.sessions.retitle(sessionId, title, "model", s.turns ?? 1);
    const cost = reply.costUsd === undefined ? "" : ` ($${reply.costUsd.toFixed(4)})`;
    this.deps.log(saved ? `title for ${sessionId}: "${title}"${cost}` : `title for ${sessionId} not kept: the user renamed it meanwhile${cost}`);
  }
}
