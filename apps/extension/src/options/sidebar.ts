/**
 * The options page's sidebar: one item per section (an icon tile and its
 * label), an accessible vertical tablist (arrow keys, Home / End), each
 * panel headed by its section's title. The open section is in location.hash
 * (options.html#ai opens AI; a group link such as #jev opens its section
 * scrolled to it; an old link such as #automation opens the section it moved
 * to) and, for a plain options.html, the section opened last in this browser.
 * On a narrow page the same list is a sideways-scrolling row (options.css).
 */
import { $, h } from "../ui/dom.js";
import { anchorFromHash, nextSection, SECTIONS, sectionFromHash, type SectionId } from "./settings-view.js";

/** The stored key predates the sidebar (it was the tab row); kept so the last section is still remembered. */
const LAST_SECTION_KEY = "noa.options.tab";

type Tone = "accent" | "sky" | "violet" | "warn" | "ok" | "teal" | "pink" | "slate";

/** Each section's icon (16 × 16, stroked) and the colour of its tile (options.css .side-icon[data-tone]). */
const ICONS: Record<SectionId, { tone: Tone; paths: string }> = {
  account: { tone: "accent", paths: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 13.75c.8-2.5 2.8-3.75 5.25-3.75s4.45 1.25 5.25 3.75"/>' },
  keys: { tone: "sky", paths: '<circle cx="5.25" cy="10.75" r="2.75"/><path d="m7.2 8.8 5.8-5.8M11 5l1.75 1.75M9.5 6.5l1.25 1.25"/>' },
  ai: { tone: "violet", paths: '<path d="M8 2.25 9.3 6.7l4.45 1.3-4.45 1.3L8 13.75 6.7 9.3 2.25 8l4.45-1.3z"/>' },
  permission: { tone: "warn", paths: '<path d="M8 1.75 13 3.75v4c0 3.1-2.1 5.4-5 6.5-2.9-1.1-5-3.4-5-6.5v-4z"/><path d="m5.75 8 1.6 1.6 2.9-3.1"/>' },
  tasks: { tone: "ok", paths: '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5"/><path d="m5.25 8.1 1.9 1.9 3.6-3.9"/>' },
  logins: { tone: "teal", paths: '<rect x="3" y="7" width="10" height="6.75" rx="1.75"/><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7M8 9.75v1.25"/>' },
  memory: { tone: "pink", paths: '<ellipse cx="8" cy="3.9" rx="5" ry="1.9"/><path d="M3 3.9v8.2c0 1.05 2.25 1.9 5 1.9s5-.85 5-1.9V3.9M3 8c0 1.05 2.25 1.9 5 1.9s5-.85 5-1.9"/>' },
  advanced: { tone: "slate", paths: '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>' },
};

const SVG_NS = "http://www.w3.org/2000/svg";

function iconTile(id: SectionId): HTMLElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" })) {
    svg.setAttribute(k, v);
  }
  svg.innerHTML = ICONS[id].paths;
  const tile = h("span.side-icon", { "data-tone": ICONS[id].tone });
  tile.append(svg);
  return tile;
}

function readLast(): SectionId | null {
  try {
    return sectionFromHash(localStorage.getItem(LAST_SECTION_KEY));
  } catch {
    return null;
  }
}

function writeLast(id: SectionId): void {
  try {
    localStorage.setItem(LAST_SECTION_KEY, id);
  } catch {
    /* storage blocked: the hash still works */
  }
}

export interface Sidebar {
  current(): SectionId;
  show(id: SectionId, opts?: { focus?: boolean }): void;
}

export function initSidebar(): Sidebar {
  const list = $("sections");
  const items = SECTIONS.map((s) =>
    h(
      "button.side-item",
      { type: "button", role: "tab", id: `tab-${s.id}`, "aria-controls": `panel-${s.id}`, "aria-selected": "false", tabindex: "-1", "data-section": s.id },
      iconTile(s.id),
      h("span.side-label", null, s.label),
    ),
  );
  list.replaceChildren(...items);
  for (const s of SECTIONS) $(`panel-${s.id}`).prepend(h("h2.panel-title", { id: `title-${s.id}` }, s.label));
  let current: SectionId = SECTIONS[0].id;

  function show(id: SectionId, opts: { focus?: boolean } = {}): void {
    const changed = id !== current;
    current = id;
    for (const b of items) {
      const on = b.dataset.section === id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      $(`panel-${b.dataset.section}`).hidden = !on;
      if (on) {
        if (opts.focus) b.focus();
        // Only the sideways row (narrow page) scrolls; never the page itself.
        list.scrollTo({ left: b.offsetLeft - (list.clientWidth - b.offsetWidth) / 2 });
      }
    }
    // A new section starts at its top, not wherever the last one was scrolled to.
    if (changed) scrollTo({ top: 0 });
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    writeLast(id);
  }

  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    if (b) show(b.dataset.section as SectionId);
  });
  list.addEventListener("keydown", (e) => {
    const to = nextSection(current, e.key);
    if (!to) return;
    e.preventDefault();
    show(to, { focus: true });
  });
  /** Shows the section the hash names, scrolled to the group it names (read before show() rewrites the hash). */
  function showHash(): void {
    const anchor = anchorFromHash(location.hash);
    const id = sectionFromHash(location.hash);
    if (id && id !== current) show(id);
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }
  window.addEventListener("hashchange", showHash);

  const anchor = anchorFromHash(location.hash);
  current = sectionFromHash(location.hash) ?? readLast() ?? SECTIONS[0].id;
  show(current);
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
  return { current: () => current, show };
}
