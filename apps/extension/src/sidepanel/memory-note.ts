/**
 * The chat's note of a change to the agent's memory (a `memory` event):
 * "Remembered: Work email · admin@runhq.io is ..." with Undo, "Updated
 * memory: ...", or "Forgot: ...". Saved by the background writer after the
 * chat, it says "Remembered after this chat". One that replaced an entry of
 * another subject says so. A note added to a task's record shows that note.
 * Once undone it says so. Pure.
 */
import { isMemoryRecord, MEMORY_KIND_TEXT, type AgentEvent, type MemoryEntry } from "@noa/shared";

/** What the change did to memory. */
export type MemoryChangeKind = "added" | "updated" | "forgot";

export interface MemoryNoteView {
  kind: "memory";
  changeId: string;
  change: MemoryChangeKind;
  /** "Remembered", "Updated memory", "Forgot", "Remembered after this chat", "Updated after this chat". */
  label: string;
  subject: string;
  text: string;
  /** It replaced an entry of another subject (Undo puts that one back too): its subject, and "replaced “Tom Kim”". */
  replaced?: { subject: string; text: string };
  /** The whole entry in words, for the tooltip: its kind, site and text (and what it replaced). */
  title: string;
  undone?: true;
}

const LABELS: Record<MemoryChangeKind, { agent: string; auto: string }> = {
  added: { agent: "Remembered", auto: "Remembered after this chat" },
  updated: { agent: "Updated memory", auto: "Updated after this chat" },
  forgot: { agent: "Forgot", auto: "Forgot" },
};

/** What a memory change's note says; undone: the user undid it since. */
export function memoryNoteView(ev: Extract<AgentEvent, { type: "memory" }>, undone: boolean): MemoryNoteView {
  const shown = (ev.after ?? ev.before)!;
  const change: MemoryChangeKind = !ev.before ? "added" : ev.after ? "updated" : "forgot";
  const record = isMemoryRecord(shown);
  const where = (e: MemoryEntry) => `${record ? "Task record" : MEMORY_KIND_TEXT[e.kind].label}${e.domain ? ` · ${e.domain}` : ""}${e.taskTitle ? ` · ${e.taskTitle}` : ""}`;
  // A record grows by dated notes: what changed is its newest note (its summary is in the tooltip).
  const added = record && ev.before && ev.after ? ev.after.notes?.at(-1)?.text : undefined;
  const was = !record && ev.before && ev.after && ev.before.text !== ev.after.text ? `\n\nWas: ${ev.before.text}` : "";
  const notes = (shown.notes ?? []).map((n) => `\n${n.at.slice(0, 10)}: ${n.text}`).join("");
  const replaced = ev.replaced ? `\n\nReplaced ${ev.replaced.subject}: ${ev.replaced.text}` : "";
  const v: MemoryNoteView = {
    kind: "memory",
    changeId: ev.changeId,
    change,
    label: LABELS[change][ev.auto ? "auto" : "agent"],
    subject: shown.subject,
    text: added ?? shown.text,
    title: `${where(shown)}\n${shown.subject}: ${shown.text}${notes}${was}${replaced}`,
  };
  if (ev.replaced) v.replaced = { subject: ev.replaced.subject, text: `replaced “${ev.replaced.subject}”` };
  return undone ? { ...v, undone: true } : v;
}

/** What an undone note says under its line. */
export function undoneText(v: Pick<MemoryNoteView, "change" | "replaced">): string {
  const back = v.replaced ? ` “${v.replaced.subject}” is back.` : "";
  return v.change === "added" ? `Not kept.${back}` : v.change === "forgot" ? "Kept after all." : `Back to what it was.${back}`;
}
