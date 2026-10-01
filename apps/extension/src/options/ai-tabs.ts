/**
 * Sub-tabs inside a section (the AI section: Source, Speed, Voice, Images): an
 * accessible horizontal tablist (arrow keys, Home / End) over its panels. The
 * tab picked last is remembered in this browser; a group link (options.html#jev)
 * opens the sub-tab that holds the group (revealGroup, called by sidebar.ts).
 */
import { $ } from "../ui/dom.js";

const LAST_AI_TAB_KEY = "noa.options.aiTab";

function tabsOf(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>("[role=tab]")];
}

/** Selects `tab` in its tablist and shows its panel. */
function select(tab: HTMLButtonElement, opts: { focus?: boolean } = {}): void {
  const list = tab.closest<HTMLElement>("[role=tablist]");
  if (!list) return;
  for (const t of tabsOf(list)) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
    if (panel) panel.hidden = !on;
  }
  if (opts.focus) tab.focus();
  if (list.id === "ai-tabs") {
    try {
      localStorage.setItem(LAST_AI_TAB_KEY, tab.id);
    } catch {
      /* storage blocked: the first tab opens next time */
    }
  }
}

/** The tab an arrow key moves to (wraps around); Home / End go to the ends. */
function nextTab(tabs: HTMLButtonElement[], current: HTMLButtonElement, key: string): HTMLButtonElement | null {
  const i = tabs.indexOf(current);
  const n = tabs.length;
  if (key === "ArrowRight") return tabs[(i + 1) % n] ?? null;
  if (key === "ArrowLeft") return tabs[(i - 1 + n) % n] ?? null;
  if (key === "Home") return tabs[0] ?? null;
  if (key === "End") return tabs[n - 1] ?? null;
  return null;
}

export function initAiTabs(): void {
  const list = $("ai-tabs");
  list.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    if (tab) select(tab);
  });
  list.addEventListener("keydown", (e) => {
    const current = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    const to = current && nextTab(tabsOf(list), current, e.key);
    if (!to) return;
    e.preventDefault();
    select(to, { focus: true });
  });
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_AI_TAB_KEY);
  } catch {
    /* storage blocked */
  }
  const tab = last ? tabsOf(list).find((t) => t.id === last) : undefined;
  if (tab) select(tab);
}

/** Shows the group with this id: its sub-tab first, when it sits in one, then scrolls to it. */
export function revealGroup(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const panel = el.closest<HTMLElement>(".subpanel[role=tabpanel]");
  const tab = panel && document.getElementById(panel.getAttribute("aria-labelledby") ?? "");
  if (tab instanceof HTMLButtonElement) select(tab);
  el.scrollIntoView({ block: "start" });
}
