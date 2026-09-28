/**
 * The jobs list's card "Add this computer's memory to <account>?" (UiState.memoryQuestion): shown after signing in to
 * another account than the one this computer's memory was synced with, until the user picks Add or Keep separate
 * (memory.syncChoice). Settings > Memory asks the same.
 */
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, flash } from "../ui/dom.js";
import { memoryQuestionText } from "../ui/memory-question.js";

export function initMemoryAsk(opts: { onState?(state: UiState): void; onAnswered?(text: string): void }): { render(state: UiState): void } {
  const card = $("memory-ask");
  const text = $("memory-ask-text");
  const hint = $("memory-ask-hint");
  const msg = $("memory-ask-msg");
  const add = $<HTMLButtonElement>("memory-ask-add");
  const keep = $<HTMLButtonElement>("memory-ask-keep");

  const answer = (btn: HTMLButtonElement, yes: boolean) =>
    void busy(
      btn,
      async () => {
        flash(msg, "");
        const account = text.dataset.account ?? "";
        await uiRequest({ type: "memory.syncChoice", add: yes });
        card.hidden = true;
        opts.onAnswered?.(yes ? `This computer's memory is being added to ${account}.` : `This computer's memory stays separate from ${account}.`);
        opts.onState?.(await uiRequest({ type: "state.get" }));
      },
      msg,
    );
  add.addEventListener("click", () => answer(add, true));
  keep.addEventListener("click", () => answer(keep, false));

  return {
    render(state) {
      const q = state.memoryQuestion;
      card.hidden = !q;
      if (!q || text.dataset.account === q.account) return;
      const t = memoryQuestionText(q.account);
      text.dataset.account = q.account;
      text.textContent = t.question;
      hint.textContent = t.hint;
      add.textContent = t.add;
      keep.textContent = t.keep;
    },
  };
}
