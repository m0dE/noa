/**
 * The approval card in the chat: an action waiting for the user's OK (what,
 * where, why it waits, and the exact text it posts or sends) with Allow (just
 * this one), Allow all until done (no more asking this turn) and Deny, also on Alt+Y / Alt+T / Alt+N. A card its run
 * paused at (nobody was there to answer) is decided in one click: Allow &
 * continue (Alt+Y) or Don't (Alt+N). Once answered (or timed out, or its turn
 * ended) it keeps one line saying how it ended. The view model is
 * approval-view.ts.
 */
import { type ApprovalAnswer } from "@noa/shared";
import { h } from "../ui/dom.js";
import { clockLabel } from "./format.js";
import { APPROVAL_ALLOW_ALL_NOTE, APPROVAL_BUTTONS, APPROVAL_KEYS, approvalKeyOf, PAUSED_BUTTONS, SWITCH_BUTTONS, type ApprovalView } from "./approval-view.js";
import { TAB_SWITCHING_SETTING } from "./event-format.js";
import { openSettings } from "./open-settings.js";

export interface ApprovalCardActions {
  /** Sends the answer (by: a button, or its key); false when the request no longer waits. */
  answer(id: string, answer: ApprovalAnswer, by: "card" | "keyboard"): Promise<boolean>;
}

const SHIELD_ICON =
  '<path d="M8 1.75 2.75 3.9v3.6c0 3.1 2.2 5.6 5.25 6.75 3.05-1.15 5.25-3.65 5.25-6.75V3.9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 5v3.4M8 10.6v.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';

function shield(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = SHIELD_ICON;
  return svg;
}

const ALLOWED = new Set(["allow_once", "allow_task"]);

export function renderApproval(v: ApprovalView, actions?: ApprovalCardActions): HTMLElement {
  // A card its run paused at, still to be decided, waits like one of a running turn.
  const pending = v.state === "pending" || !!v.decidable;
  const tone = pending ? "pending" : ALLOWED.has(v.state) ? "allowed" : "refused";
  const title = v.decidable
    ? "Paused for your OK"
    : pending
      ? v.switchTo
        ? "Noa needs to see this tab to take a screenshot"
        : "Waiting for your OK"
      : `${v.outcome ?? ""}${v.byVoice ? " (by voice)" : ""}`;
  const card = h(
    "div.ev-approval",
    { "data-approval-id": v.id, "data-state": tone, "data-outcome": v.state, "data-decidable": v.decidable ? "true" : null, role: "group", "aria-label": pending ? "Approval needed" : `Approval: ${v.outcome ?? ""}` },
    h("div.appr-head", null, shield(), h("span.appr-title", null, title)),
    h(
      "div.appr-action",
      null,
      h("b", null, v.action),
      v.site ? h("span.appr-site", null, ` on ${v.site}`) : null,
      v.switchTo ? null : h("span.appr-why", null, ` · ${v.why}`),
    ),
    v.target ? h("div.appr-target", { title: "What it acts on, as the page shows it" }, h("span.appr-target-label", null, "On: "), v.target) : null,
    v.text ? h("div.appr-text", { title: "The exact text" }, v.text) : null,
  );
  if (!pending || !actions) return card;
  const note = h(
    "div.appr-note",
    { role: "status" },
    v.decidable ? "The run stopped here: nobody was there to answer." : `No answer by ${clockLabel(v.expiresAt)} counts as ${v.switchTo ? "Not now" : "Deny"}.`,
  );
  const explain = v.decidable
    ? null
    : v.switchTo
      ? h(
          "div.appr-note.appr-explain",
          null,
          "Auto tab switching in Settings does this without asking. ",
          h("button.link", { type: "button", onclick: () => void openSettings(TAB_SWITCHING_SETTING) }, "Open Settings"),
        )
      : h("div.appr-note.appr-explain", null, APPROVAL_ALLOW_ALL_NOTE);
  const buttons = (v.decidable ? PAUSED_BUTTONS : v.switchTo ? SWITCH_BUTTONS : APPROVAL_BUTTONS).map(({ answer, label, hint }) => {
    const cls = answer === "allow_once" ? "button.small.primary" : answer === "deny" ? "button.small.danger" : "button.small";
    const b = h(cls as "button", { type: "button", "data-answer": answer, title: `${hint ?? label} (${APPROVAL_KEYS[answer].label})`, "aria-keyshortcuts": APPROVAL_KEYS[answer].label }, label);
    b.addEventListener("click", () => {
      // Switch to it: the side panel opens by the tab (in its window, which may have none open), so the user still
      // follows the chat there. Now, in the click's (or key press's) user gesture, which sidePanel.open() needs.
      if (v.switchTo && answer === "allow_once") chrome.sidePanel?.open({ tabId: v.switchTo.tabId }).catch(() => undefined);
      // bindApprovalKeys marks the click it makes for a key press.
      const by = b.dataset.by === "keyboard" ? "keyboard" : "card";
      delete b.dataset.by;
      void send(answer, by);
    });
    return b;
  });
  async function send(answer: ApprovalAnswer, by: "card" | "keyboard"): Promise<void> {
    if (buttons.some((b) => b.disabled)) return;
    for (const b of buttons) b.disabled = true;
    let ok = false;
    try {
      ok = await actions!.answer(v.id, answer, by);
    } catch {
      ok = false;
    }
    // Answered: the card changes when its approval_resolved arrives. Not waiting any more: say so (the buttons stay off).
    if (!ok) {
      note.textContent = "This request is no longer waiting.";
      note.classList.add("bad");
    }
  }
  card.append(h("div.appr-actions", null, ...buttons), ...(explain ? [explain] : []), note);
  return card;
}

/**
 * Alt+Y / Alt+T / Alt+N answer the newest card still waiting in `root` (the chat's log), wherever the focus is,
 * even in the message box. Returns a function that removes the listener.
 */
export function bindApprovalKeys(root: HTMLElement, doc: Document = document): () => void {
  const onKey = (e: KeyboardEvent) => {
    const answer = approvalKeyOf(e);
    if (!answer || root.hidden) return;
    const cards = root.querySelectorAll<HTMLElement>(".ev-approval[data-state=pending]");
    const button = cards[cards.length - 1]?.querySelector<HTMLButtonElement>(`button[data-answer="${answer}"]`);
    if (!button || button.disabled) return;
    e.preventDefault();
    button.dataset.by = "keyboard";
    button.click();
  };
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
}
