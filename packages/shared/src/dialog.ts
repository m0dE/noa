/**
 * JavaScript dialogs: alert, confirm, prompt, and the "Leave site?" a page's beforeunload asks. While one is open
 * its page is frozen: no script runs, and the debugger's commands on the tab wait until it is answered. The
 * extension tracks them per tab (apps/extension/src/cdp.ts), fails the agent's calls on a frozen page at once with
 * dialogOpenText, and the agent answers with handle_dialog; one opened during a run that nobody answers is
 * cancelled after DIALOG_AUTO_DISMISS_MS.
 */

export type JsDialogType = "alert" | "confirm" | "prompt" | "beforeunload";

/** An open dialog, as Chrome reports it (Page.javascriptDialogOpening). */
export interface JsDialog {
  type: JsDialogType;
  /** The page's text; empty for beforeunload (Chrome shows its own, LEAVE_SITE_TEXT). */
  message: string;
  /** The page that opened it. */
  url: string;
  /** A prompt's prefilled answer. */
  defaultPrompt?: string;
}

/** How a dialog was answered: OK / Leave, or Cancel / Stay (an alert has only OK). */
export type DialogAnswer = "accepted" | "dismissed";

/**
 * Who answered it: the agent (handle_dialog), the extension because nobody did in time (auto), or someone else in
 * the browser (the user on Chrome's own dialog, or the page going away).
 */
export type DialogAnsweredBy = "agent" | "auto" | "user";

/**
 * How long a dialog opened during a run may stay unanswered before it is cancelled (an alert is just closed):
 * Cancel keeps the page as it is, so a run nobody watches never hangs on one, and never leaves a page or confirms
 * anything on its own. The time the agent's accept waits for the user's OK is not counted.
 */
export const DIALOG_AUTO_DISMISS_MS = 10_000;

/** What Chrome's "Leave site?" dialog says: a page cannot set its text (beforeunload's message is empty). */
export const LEAVE_SITE_TEXT = "Leave site? Changes you made may not be saved.";

/** The longest dialog text shown to the agent or in the chat. */
const MAX_DIALOG_TEXT = 300;

/** What the dialog says, as the user sees it. */
export function dialogText(d: Pick<JsDialog, "type" | "message">): string {
  const text = d.type === "beforeunload" && !d.message.trim() ? LEAVE_SITE_TEXT : d.message.trim();
  return text.length > MAX_DIALOG_TEXT ? `${text.slice(0, MAX_DIALOG_TEXT - 1)}…` : text;
}

/** The dialog in a few words: `confirm “Delete this item?”`. */
export function dialogLabel(d: Pick<JsDialog, "type" | "message">): string {
  return `${d.type} “${dialogText(d)}”`;
}

/** Starts every error of a call that met an open dialog (dialogOpenText). */
export const DIALOG_OPEN_PREFIX = "A browser dialog is open:";

/** The error of a call on a page a dialog froze; tab: the short id of a tab other than the current one. */
export function dialogOpenText(d: Pick<JsDialog, "type" | "message">, tab?: string): string {
  const where = tab ? ` in ${tab}` : "";
  const how = tab ? `call handle_dialog with tab ${tab}` : "call handle_dialog";
  return `${DIALOG_OPEN_PREFIX} ${dialogLabel(d)}${where}. The page is frozen until it is answered: ${how} (accept false: Cancel / Stay on the page; true: OK / Leave).`;
}

/** Whether an error text says a dialog froze the page (see dialogOpenText). */
export function isDialogOpenText(text: string): boolean {
  return text.includes(DIALOG_OPEN_PREFIX);
}

/** A run's line for an answered dialog: `Dialog: Delete this item? → Cancel (automatically after 10 s)`. */
export function dialogLine(e: { dialog: JsDialog; outcome: DialogAnswer; by: DialogAnsweredBy; text?: string | undefined }): string {
  const by = e.by === "auto" ? ` (automatically after ${DIALOG_AUTO_DISMISS_MS / 1000} s)` : e.by === "user" ? " (in the browser)" : "";
  return `Dialog: ${dialogText(e.dialog)} → ${dialogAnswerLabel(e.dialog.type, e.outcome, e.text)}${by}`;
}

/** The button the answer pressed: OK, Leave or Cancel; a prompt's OK with its text. */
export function dialogAnswerLabel(type: JsDialogType, answer: DialogAnswer, text?: string): string {
  if (type === "alert") return "OK";
  if (answer === "dismissed") return "Cancel";
  if (type === "beforeunload") return "Leave";
  return type === "prompt" && text ? `OK “${text}”` : "OK";
}
