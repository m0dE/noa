/**
 * The jobs list, the panel's first screen. One bar at its top: the view (Home | Scheduled, a segmented control: a
 * tablist, Left and Right move between them) and the search field beside it, always shown, which searches the view
 * shown. Home has the groups that have jobs (Needs you, Running, Upcoming with its soonest few and "All scheduled
 * (N)", Recent; jobs.ts); Scheduled has every scheduled job, soonest first, the paused ones last, each with its
 * schedule, its next run and Pause or Resume. One row per job: its state as an icon, its title (and, quietly under
 * it, why it needs you, its repeat rule or its site), and on the right when it ran or runs next. Recent shows a page
 * at a time (Show more). Up and Down move between rows (from the search field too), Home and End to the ends, Enter
 * opens. A row of Needs you or Recent can be dismissed (job-dismiss.ts): its ✕ (on hover or focus; always on touch
 * screens), or Delete (Backspace) on the focused row, which then moves to the next one; Needs you has Dismiss all.
 * The panel keeps the view it showed last (job-nav.ts storedView).
 */
import { TERMS_URL } from "@noa/shared";
import { h } from "../ui/dom.js";
import { HOLD_TITLE, RELEASE_TITLE } from "./job-actions.js";
import type { JobData } from "./job-data.js";
import type { ListPlace } from "./job-nav.js";
import { jobRow, scheduleRow, STATE_LABELS, viewLayout, type Job, type JobState, type JobView } from "./jobs.js";

/** Recent shows this many rows at first, and this many more with each Show more. */
export const RECENT_PAGE = 25;

/** The panel's keyboard shortcuts as the user reads them ("Ctrl+.", "Ctrl+,"); null: Chrome assigned none. */
export interface Shortcuts {
  open: string | null;
  voice: string | null;
}

export interface JobListDeps {
  data: JobData;
  /** A row was picked. */
  onOpen(job: Job): void;
  /** The job can be dismissed (see job-dismiss.ts). */
  canDismiss(job: Job): boolean;
  /** ✕, Delete on a row, or Dismiss all. */
  onDismiss(jobs: Job[]): void;
  /** Pause or Resume on a Scheduled row; settles once the list has the change. */
  onToggle(job: Job, to: "pause" | "resume"): Promise<void>;
  /** The view changed (the panel keeps it). */
  onView?(view: JobView): void;
  /** A view's tab was picked (in the header, so also on a job's page: the panel goes back to the list first). */
  onTab?(): void;
  /** "Set a keyboard shortcut" (chrome://extensions/shortcuts), when none is set. */
  onShortcuts(): void;
}

export interface JobList {
  /** The list is on screen again, as it was left. */
  show(place: ListPlace): void;
  /** Where the list is now (its view, search, scroll and the focused row), to come back to. */
  place(focusKey?: string | null): ListPlace;
  /** Shows a view (Home, or every scheduled job). */
  setView(view: JobView): void;
  setShortcuts(shortcuts: Shortcuts): void;
  /** The clock moved on (relative times, due tasks). */
  tick(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** One 16px glyph per state, drawn in the state's colour (sidepanel.css .job-icon). */
const ICONS: Record<JobState | "repeat", string> = {
  running: '<circle cx="8" cy="8" r="5.5" opacity=".25"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/>',
  needs: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.4M8 10.8v.2"/>',
  scheduled: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.4"/>',
  due: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.4"/>',
  retry: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.4"/>',
  paused: '<circle cx="8" cy="8" r="5.5"/><path d="M6.6 5.8v4.4M9.4 5.8v4.4"/>',
  repeat: '<path d="M3.5 7.2V6.5A2 2 0 0 1 5.5 4.5h6.5M10 2.5l2 2-2 2M12.5 8.8v.7a2 2 0 0 1-2 2H4M6 13.5l-2-2 2-2"/>',
  done: '<path d="M3.5 8.4 6.6 11.3 12.5 4.9"/>',
  failed: '<circle cx="8" cy="8" r="5.5"/><path d="M6 6l4 4M10 6l-4 4"/>',
  stopped: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>',
  cancelled: '<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>',
  dismissed: '<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/>',
  lapsed: '<path d="M4.5 2.5h7M4.5 13.5h7M5.5 2.5v1.8L8 8l2.5-3.7V2.5M5.5 13.5v-1.8L8 8l2.5 3.7v1.8"/>',
};

/** The job's state as a glyph (a waiting repeating job: the repeat arrows). */
export function stateIcon(state: JobState, repeating = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = ICONS[repeating && state === "scheduled" ? "repeat" : state];
  return svg;
}

const DISMISS_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

/** A held job shows the pause glyph wherever it is listed (a job paused after failures is also "needs"). */
const iconState = (job: Job): JobState => (job.held ? "paused" : job.state);

function rowButton(job: Job, r: { title: string; meta: string; when: string; label: string }, extra: Record<string, string> = {}): HTMLButtonElement {
  return h(
    "button.job-row",
    { type: "button", "data-key": job.key, "data-state": job.state, "aria-label": r.label, title: job.title, ...extra },
    h("span.job-icon", { "data-state": iconState(job), title: job.held ? STATE_LABELS.paused : STATE_LABELS[job.state] }, stateIcon(iconState(job), !!job.repeat)),
    h("span.job-main", null, h("span.job-title", null, r.title), r.meta ? h("span.job-meta", null, r.meta) : null),
    h("span.job-when", null, r.when),
  ) as HTMLButtonElement;
}

function rowOf(job: Job, now: number, dismissible: boolean): HTMLLIElement {
  const row = rowButton(job, jobRow(job, now), dismissible ? { "aria-keyshortcuts": "Delete" } : {});
  if (!dismissible) return h("li", null, row);
  // Reached by the pointer (and screen readers); the keyboard has Delete on the row.
  const x = h("button.job-dismiss", { type: "button", tabindex: "-1", "data-key": job.key, title: "Dismiss (Delete)", "aria-label": `Dismiss ${job.title}` });
  x.innerHTML = DISMISS_ICON;
  return h("li.dismissible", null, row, x);
}

/** A row of the Scheduled view: its schedule and next run, and Pause or Resume beside it. */
function scheduleRowOf(job: Job, now: number): HTMLLIElement {
  const r = scheduleRow(job, now);
  const row = rowButton(job, r);
  if (!r.toggle) return h("li.sched", null, row);
  const pause = r.toggle === "pause";
  const toggle = h(
    "button.job-toggle",
    { type: "button", "data-key": job.key, "data-to": r.toggle, title: pause ? HOLD_TITLE : RELEASE_TITLE, "aria-label": `${pause ? "Pause" : "Resume"} ${job.title}` },
    pause ? "Pause" : "Resume",
  );
  return h("li.sched.toggled", null, row, toggle);
}

export function initJobList(root: HTMLElement, deps: JobListDeps): JobList {
  const search = root.querySelector<HTMLInputElement>("#job-search")!;
  const groupsEl = root.querySelector<HTMLElement>("#job-groups")!;
  // In the header, outside the list.
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("#job-views [role=tab]")];
  let view: JobView = "home";
  let recentShown = RECENT_PAGE;
  let shortcuts: Shortcuts | undefined;

  const rows = () => [...groupsEl.querySelectorAll<HTMLButtonElement>("button.job-row")];
  const focusedKey = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".job-row")?.dataset.key ?? null;
  const rowFor = (key: string) => groupsEl.querySelector<HTMLButtonElement>(`button.job-row[data-key="${CSS.escape(key)}"]`);

  /**
   * "Ctrl+. to open · Ctrl+, to talk"; with only the open key, "Press Ctrl+. to open Noa at any time.";
   * without it, a link to set one.
   */
  function shortcutHint(): HTMLElement | null {
    if (!shortcuts) return null;
    const { open, voice } = shortcuts;
    const talk = voice ? [" · ", h("kbd", null, voice), " to talk"] : [];
    if (!open) {
      const link = h("button.link.shortcut-link", { type: "button", onclick: () => deps.onShortcuts() }, "Set a keyboard shortcut");
      return h("p.shortcut-hint", null, link, " to open Noa at any time", ...(voice ? talk : ["."]));
    }
    if (!voice) return h("p.shortcut-hint", null, "Press ", h("kbd", null, open), " to open Noa at any time.");
    return h("p.shortcut-hint", null, h("kbd", null, open), " to open", ...talk);
  }

  function emptyState(query: string): HTMLElement {
    const q = query.trim();
    if (view === "scheduled") {
      if (q) return h("div.jobs-empty", { role: "status" }, h("p.empty-title", null, "No scheduled jobs match"), h("p", null, `No scheduled job has “${q}” in its title, request or site.`));
      return h("div.jobs-empty", null, h("p.empty-title", null, "Nothing scheduled"), h("p", null, "Say when in a request, like “every day at 9 post a tip on X”, and it shows here."));
    }
    if (q) return h("div.jobs-empty", { role: "status" }, h("p.empty-title", null, "No jobs match"), h("p", null, `Nothing has “${q}” in its title, request or site.`));
    return h(
      "div.jobs-empty",
      null,
      h("p.empty-title", null, "No jobs yet"),
      h("p", null, "Type below to start one, like “Post ‘good morning’ on X”, or say when: “every day at 9 post a tip on X”."),
      shortcutHint(),
      h(
        "p.disclaimer",
        null,
        "Noa acts as you and can make mistakes, like a wrong post, purchase or deletion. You're responsible for what you ask it to do, and Noa comes as is, without warranty. ",
        h("a", { href: TERMS_URL, target: "_blank", rel: "noopener noreferrer" }, "Terms"),
      ),
    );
  }

  /** The tabs show the view; the one shown is the tab stop (roving tabindex). */
  function renderTabs(): void {
    for (const t of tabs) {
      const on = t.dataset.view === view;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    const current = tabs.find((t) => t.dataset.view === view);
    if (current) groupsEl.setAttribute("aria-labelledby", current.id);
    search.placeholder = view === "scheduled" ? "Search scheduled" : "Search jobs";
    search.setAttribute("aria-label", view === "scheduled" ? "Search scheduled jobs" : "Search jobs");
  }

  function render(): void {
    // Hidden, it is drawn when shown again (show()).
    if (root.hidden) return;
    const data = deps.data;
    if (!data.loaded) return;
    const now = Date.now();
    const query = search.value;
    const keep = focusedKey() ?? (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".job-toggle")?.dataset.key ?? null;
    const keepToggle = !!(document.activeElement as HTMLElement | null)?.closest(".job-toggle");
    const { groups, upcomingHidden, scheduledCount } = viewLayout(view, data.jobs(now), query);
    groupsEl.replaceChildren(
      ...groups.map((g) => {
        const id = `group-${g.id}`;
        const list = g.id === "recent" ? g.jobs.slice(0, recentShown) : g.jobs;
        const more = g.jobs.length - list.length;
        const head = h("h2.group-head", { id }, g.label, h("span.count", null, String(g.jobs.length + (g.id === "scheduled" ? upcomingHidden : 0))));
        const all = g.id === "needs" ? g.jobs.filter((j) => deps.canDismiss(j)) : [];
        const dismissAll =
          all.length > 1 ? h("button.link.group-action", { type: "button", "aria-describedby": id, onclick: () => deps.onDismiss(all) }, "Dismiss all") : null;
        const scheduledView = g.id === "active" || g.id === "paused";
        return h(
          "section.job-group",
          { "aria-labelledby": id, "data-group": g.id },
          dismissAll ? h("div.group-bar", null, head, dismissAll) : head,
          h("ul.job-rows", null, ...list.map((j) => (scheduledView ? scheduleRowOf(j, now) : rowOf(j, now, deps.canDismiss(j))))),
          g.id === "scheduled" && upcomingHidden > 0
            ? h("button.link.show-more.all-scheduled", { type: "button", onclick: () => setView("scheduled", true) }, `All scheduled (${scheduledCount}) →`)
            : null,
          more > 0
            ? h(
                "button.link.show-more",
                {
                  type: "button",
                  onclick: () => {
                    const first = list.length;
                    recentShown += RECENT_PAGE;
                    render();
                    // The first new row takes the focus (the button is gone).
                    groupsEl.querySelectorAll<HTMLButtonElement>('section[aria-labelledby="group-recent"] button.job-row')[first]?.focus();
                  },
                },
                `Show ${Math.min(more, RECENT_PAGE)} more`,
              )
            : null,
        );
      }),
      ...(groups.length ? [] : [emptyState(query)]),
    );
    if (keep) {
      const toggle = keepToggle ? groupsEl.querySelector<HTMLButtonElement>(`button.job-toggle[data-key="${CSS.escape(keep)}"]`) : null;
      (toggle ?? rowFor(keep))?.focus();
    }
  }

  function setView(next: JobView, focusTab = false): void {
    if (next !== view) {
      view = next;
      recentShown = RECENT_PAGE;
      renderTabs();
      render();
      root.scrollTop = 0;
      deps.onView?.(view);
    }
    if (focusTab) tabs.find((t) => t.dataset.view === view)?.focus();
  }

  function moveFocus(e: KeyboardEvent): void {
    const all = rows();
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const inSearch = document.activeElement === search;
    let to: number | null = null;
    if (e.key === "ArrowDown") to = inSearch ? 0 : i + 1;
    else if (e.key === "ArrowUp") to = i - 1;
    else if (!inSearch && e.key === "Home") to = 0;
    else if (!inSearch && e.key === "End") to = all.length - 1;
    if (to === null || (i < 0 && !inSearch)) return;
    e.preventDefault();
    // Up from the first row goes back to the search field.
    if (to < 0) return search.focus();
    all[Math.min(to, all.length - 1)]!.focus();
  }

  /** Delete (or Backspace) on a row: dismissed, and the focus goes on to the next row (or the one before). */
  function dismissFocused(e: KeyboardEvent): void {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const row = (e.target as HTMLElement).closest<HTMLButtonElement>("button.job-row");
    const job = row?.dataset.key ? deps.data.job(row.dataset.key) : null;
    // A Scheduled row has no ✕: its Pause is the way to stop it.
    if (!row || !job || view !== "home" || !deps.canDismiss(job)) return;
    e.preventDefault();
    const all = rows();
    const i = all.indexOf(row);
    const next = (all[i + 1] ?? all[i - 1])?.dataset.key ?? null;
    deps.onDismiss([job]);
    if (next) rowFor(next)?.focus();
    else search.focus();
  }

  /** Left and Right (Home and End) move between the views, which show at once. */
  function tabKeys(e: KeyboardEvent): void {
    const i = tabs.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    let to: number | null = null;
    if (e.key === "ArrowRight") to = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") to = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = tabs.length - 1;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    deps.onTab?.();
    setView(tabs[to]!.dataset.view as JobView, true);
  }

  for (const t of tabs) {
    t.addEventListener("click", () => {
      deps.onTab?.();
      setView(t.dataset.view as JobView);
    });
    t.addEventListener("keydown", tabKeys);
  }
  root.addEventListener("keydown", moveFocus);
  root.addEventListener("keydown", dismissFocused);
  search.addEventListener("input", () => {
    recentShown = RECENT_PAGE;
    render();
    root.scrollTop = 0;
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      search.dispatchEvent(new Event("input"));
    }
  });
  groupsEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const toggle = target.closest<HTMLButtonElement>("button.job-toggle");
    const toggled = toggle?.dataset.key ? deps.data.job(toggle.dataset.key) : null;
    if (toggle && toggled) {
      if (toggle.getAttribute("aria-disabled") === "true") return;
      toggle.setAttribute("aria-disabled", "true");
      void deps.onToggle(toggled, toggle.dataset.to === "resume" ? "resume" : "pause").finally(() => toggle.removeAttribute("aria-disabled"));
      return;
    }
    const x = target.closest<HTMLElement>("button.job-dismiss")?.dataset.key;
    const dismissed = x ? deps.data.job(x) : null;
    if (dismissed) return deps.onDismiss([dismissed]);
    const key = target.closest<HTMLElement>("button.job-row")?.dataset.key;
    const job = key ? deps.data.job(key) : null;
    if (job) deps.onOpen(job);
  });
  deps.data.onChange(() => render());
  renderTabs();

  return {
    show(place) {
      if (search.value !== place.query) {
        search.value = place.query;
        recentShown = RECENT_PAGE;
      }
      if (place.view !== view) {
        view = place.view;
        recentShown = RECENT_PAGE;
        renderTabs();
      }
      render();
      root.scrollTop = place.scrollTop;
      if (place.focusKey) rowFor(place.focusKey)?.focus({ preventScroll: true });
    },
    place(focusKey = focusedKey()) {
      return { view, query: search.value, scrollTop: root.scrollTop, focusKey };
    },
    setView(next) {
      setView(next);
    },
    setShortcuts(next) {
      if (shortcuts?.open === next.open && shortcuts.voice === next.voice) return;
      shortcuts = next;
      render();
    },
    tick() {
      // The focused row keeps the focus (render puts it back).
      render();
    },
  };
}
