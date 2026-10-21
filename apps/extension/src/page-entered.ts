/**
 * Whether navigate may take the current tab away from its page. A page whose form holds what someone entered (the
 * user or the agent: a sign-up waiting for its email to be confirmed, a half-written message) loses it when the tab
 * leaves for another site, and often the flow with it. navigate then opens the address in a new tab instead and
 * leaves that page as it is (driver.ts).
 */

/**
 * How many of the page's form fields hold something other than what the page loaded with: text typed or pasted, a
 * box ticked or cleared, another option chosen. Only fields shown on the page count, not disabled or read-only ones,
 * and not search boxes (a query is cheap to type again). Self-contained: serialized by the debugger and
 * chrome.scripting.
 */
export function enteredFieldsInPage(): number {
  const skip = new Set(["hidden", "search", "submit", "button", "reset", "image"]);
  let n = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"))) {
    if (el.disabled || el.getClientRects().length === 0 || el.closest("[role=search]")) continue;
    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      if (el.multiple) {
        if (options.some((o) => o.selected !== o.defaultSelected)) n++;
        continue;
      }
      // A single choice without a preselected option starts on its first one (the last preselected wins).
      let start = 0;
      options.forEach((o, i) => o.defaultSelected && (start = i));
      if (options.length && el.selectedIndex !== start) n++;
      continue;
    }
    if (el.readOnly) continue;
    if (el instanceof HTMLInputElement) {
      if (skip.has(el.type)) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked !== el.defaultChecked) n++;
        continue;
      }
      if (el.type === "file") {
        if (el.files?.length) n++;
        continue;
      }
    }
    if (el.value.trim() && el.value !== el.defaultValue) n++;
  }
  return n;
}

/** The address goes to another site than the page's (another host; "www." does not count). */
export function otherSite(from: string | undefined, to: string): boolean {
  const host = (u: string | undefined) => {
    try {
      return new URL(u ?? "").hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  };
  const a = host(from);
  const b = host(to);
  return !!a && !!b && a !== b;
}
