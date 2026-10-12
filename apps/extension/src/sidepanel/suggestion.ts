/**
 * The follow-up the agent proposed when its turn ended (SessionInfo.suggestion),
 * offered in the chat's input box as faded text after what is typed, like
 * inline autocomplete. Tab takes it into the box (it is not sent: Enter
 * sends as usual), Esc dismisses it for that turn, and typing anything it
 * does not start with hides it. An empty Enter still means "look at the
 * page": only Tab takes the suggestion. No DOM here; composer.ts draws it.
 */

/** A suggestion, and the turn it follows (a dismissal lasts for that turn). */
export interface SuggestionOffer {
  text: string;
  turn: string;
}

export type SuggestionKey = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "isComposing">;

/** What a key did to the suggestion: took it into the box (its new text), dismissed it, or nothing (the box handles the key as usual). */
export type SuggestionKeyResult = { accept: string } | "dismissed" | null;

/**
 * The rest of `suggestion` to show after `draft` (what is typed so far,
 * compared ignoring case), or null when the draft is not the start of it.
 */
export function suggestionRest(suggestion: string, draft: string): string | null {
  if (draft.length >= suggestion.length) return null;
  const head = suggestion.slice(0, draft.length);
  return head.toLowerCase() === draft.toLowerCase() ? suggestion.slice(draft.length) : null;
}

/** What screen readers hear about the box while a suggestion shows. */
export function suggestionDescription(suggestion: string): string {
  return `Suggestion: “${suggestion}”. Press Tab to use it.`;
}

export class FollowUpSuggestion {
  private offer: SuggestionOffer | null = null;
  private dismissedTurn: string | null = null;
  private dictating = false;

  /** The suggestion the box may offer now (null: none, a turn is running, or not in Chat). */
  setOffer(offer: SuggestionOffer | null): void {
    this.offer = offer;
  }

  /** Voice input is writing into the box: nothing is offered meanwhile. */
  setDictating(on: boolean): void {
    this.dictating = on;
  }

  /** Esc, or a message went out: this turn's suggestion is not offered again. */
  dismiss(): void {
    if (this.offer) this.dismissedTurn = this.offer.turn;
  }

  /** The suggestion shown with `draft` in the box, or null. */
  shown(draft: string): string | null {
    const o = this.offer;
    if (!o || this.dictating || this.dismissedTurn === o.turn) return null;
    return suggestionRest(o.text, draft) === null ? null : o.text;
  }

  /** The faded text after `draft`, or null when nothing shows. */
  rest(draft: string): string | null {
    const text = this.shown(draft);
    return text === null ? null : suggestionRest(text, draft);
  }

  /**
   * A key pressed in the box while it holds `draft`. Only plain Tab and Esc
   * act, and only while a suggestion shows; everything else (Tab moving the
   * focus, Enter sending) is left to the box.
   */
  onKey(e: SuggestionKey, draft: string): SuggestionKeyResult {
    if (e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
    if (e.key !== "Tab" && e.key !== "Escape") return null;
    const rest = this.rest(draft);
    if (rest === null) return null;
    if (e.key === "Escape") {
      this.dismiss();
      return "dismissed";
    }
    return { accept: draft + rest };
  }
}
