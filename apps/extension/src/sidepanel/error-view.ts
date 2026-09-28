/**
 * An error card in the side panel (the chat, the composer's message line):
 * the plain line, a second line, the fix buttons, and the technical text
 * behind a collapsed, copyable Details (see error-help.ts for the words).
 * What each fix button does is set once by the side panel (setErrorFixes).
 */
import { h } from "../ui/dom.js";
import type { ErrorFixKind, ErrorHelp } from "./error-help.js";

export type ErrorFixes = Partial<Record<ErrorFixKind, () => void>>;

let fixes: ErrorFixes = {};

/** What each fix does in this panel. A fix without an action shows no button (e.g. Top up while signed out). */
export function setErrorFixes(next: ErrorFixes): void {
  fixes = next;
}

/** Runs a fix (the header's status line uses the same actions); false when this panel has none for it. */
export function runErrorFix(kind: ErrorFixKind): boolean {
  const fix = fixes[kind];
  fix?.();
  return !!fix;
}

/** extra: more buttons after the fixes (e.g. the chat's Retry). */
export function renderErrorHelp(help: ErrorHelp, extra: HTMLElement | null = null): HTMLElement {
  const usable = help.fixes.filter((f) => fixes[f.kind]);
  const buttons = usable.map((f, i) =>
    h(`button.small.err-fix${i === 0 ? ".primary" : ""}`, { type: "button", title: f.title, "data-fix": f.kind, onclick: () => void runErrorFix(f.kind) }, f.label),
  );
  return h(
    "div.ev-error",
    null,
    h("div.err-msg", null, help.message),
    help.hint ? h("div.err-hint", null, help.hint) : null,
    buttons.length || extra ? h("div.err-actions", null, ...buttons, extra) : null,
    help.details ? renderDetails(help.details) : null,
  );
}

/** The technical text: collapsed, selectable, with Copy. */
function renderDetails(text: string): HTMLElement {
  const copy = h("button.link.err-copy", { type: "button", title: "Copy the technical details" }, "Copy");
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).then(
      () => (copy.textContent = "Copied"),
      () => (copy.textContent = "Copy failed"),
    );
  });
  return h("details.err-details", null, h("summary", { title: "Show the technical details" }, "Details"), h("div.err-tech", null, h("pre", null, text), copy));
}
