/**
 * A repeating job's runs on its page (job-runs.ts builds what it lists), made to stay small however many times the job
 * ran:
 *
 * - a line of counts ("12 runs · 9 done · 2 failed · 1 needs you"), each a button that opens the list filtered;
 * - "Earlier runs (N)", closed at first; open, filters (All, Failed, Needs you, Done) over a list grouped by day (the
 *   day sticks while its runs scroll), RUNS_PAGE runs at a time ("Show more"), runs in a row that ended the same way
 *   for the same reason folded into one row that opens to them. Picking a run shows its conversation (onOpen).
 *
 * It keeps its state (open, filter, how many shown, folds opened) while the page shows the job; reset() starts over.
 */
import { h } from "../ui/dom.js";
import { stateIcon } from "./job-list.js";
import { dayLabel, inFilter, localDay, needsMoreRows, RUN_FILTERS, runCounts, runPage, RUNS_PAGE, type RunFilter, type RunItem, type RunRow } from "./job-runs.js";
import { STATE_LABELS } from "./jobs.js";

export interface RunsViewDeps {
  /** A run was picked (its row is `trigger`). */
  onOpen(item: RunItem, trigger: HTMLElement): void;
  /** The list needs task rows older than those loaded (see needsMoreRows); the page loads them and updates the view. */
  onNeedOlder(): void;
}

export interface RunsData {
  /** Every run of the job, newest first. */
  items: readonly RunItem[];
  /** The run the page shows under the list (the newest, or the one running): not an earlier run. */
  latestKey: string | null;
  /** Older task rows may exist: rows are loaded back to this run's time (null: every row is loaded). */
  loadedUntil: string | null;
}

export interface RunsView {
  /** The line of counts (empty while the job has fewer than two runs). */
  readonly stats: HTMLElement;
  /** "Earlier runs (N)" and, open, the list (empty while the job has no earlier run). */
  readonly list: HTMLElement;
  update(data: RunsData): void;
  /** The row of run `key` takes the focus (back from its conversation). */
  focusRun(key: string): void;
  /** A new job: closed, every run, the first page. */
  reset(): void;
}

const FILTER_LABELS: Record<RunFilter, string> = { all: "All", failed: "Failed", needs: "Needs you", done: "Done" };
/** What the list says when a filter shows no earlier run. */
const NONE: Record<RunFilter, string> = { all: "No earlier runs.", failed: "No earlier run failed.", needs: "No earlier run needs you.", done: "No earlier run was done." };
/** The count line's words after a count. */
const countWords = (f: Exclude<RunFilter, "all">, n: number) => (f === "needs" ? (n === 1 ? "needs you" : "need you") : f);

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function initRunsView(deps: RunsViewDeps): RunsView {
  const stats = h("p.job-stats");
  const list = h("section.job-runs", { "aria-label": "Earlier runs" });
  const panelId = "job-runs-panel";
  let open = false;
  let filter: RunFilter = "all";
  let limit = RUNS_PAGE;
  /** Folded rows opened (by their newest run's key). */
  const unfolded = new Set<string>();
  let data: RunsData = { items: [], latestKey: null, loadedUntil: null };
  /** What the list was drawn from (drawn again only when that changes, so the focus stays). */
  let drawn = "";

  const earlier = () => data.items.filter((i) => i.key !== data.latestKey);
  const more = () => (data.loadedUntil === null ? "" : "+");

  function drawStats(): void {
    const counts = runCounts(data.items);
    if (data.items.length < 2) return void stats.replaceChildren();
    const pick = (f: RunFilter, text: string) => {
      const b = h("button.link", { type: "button", "data-filter": f, title: "Show these runs in the list below" }, text);
      b.addEventListener("click", () => {
        open = true;
        filter = f;
        limit = RUNS_PAGE;
        draw(true);
        list.querySelector<HTMLElement>(`.run-filter[data-filter="${f}"]`)?.focus();
      });
      return b;
    };
    const parts: Node[] = [pick("all", `${counts.all}${more()} runs`)];
    for (const f of ["done", "failed", "needs"] as const) {
      if (counts[f]) parts.push(document.createTextNode(" · "), pick(f, `${counts[f]} ${countWords(f, counts[f])}`));
    }
    stats.replaceChildren(...parts);
  }

  /** The row that stands for run `key`: its own, or the folded row it is in while that is closed. */
  function rowOf(key: string): HTMLElement | null {
    const own = [...list.querySelectorAll<HTMLElement>(".run-list .run-row[data-key]")].find((b) => b.dataset.key === key) ?? null;
    const fold = own?.closest<HTMLElement>(".run-fold-list");
    return fold?.hidden ? fold.parentElement!.querySelector<HTMLElement>(".run-fold-head") : own;
  }

  /** One run as a row: its icon, its time (with its day when `withDay`), how it ended. */
  function runButton(item: RunItem, withDay: boolean): HTMLButtonElement {
    const when = withDay ? `${dateOf(item.at)}, ${timeOf(item.at)}` : timeOf(item.at);
    const state = STATE_LABELS[item.state];
    const b = h(
      "button.run-row",
      { type: "button", "data-key": item.key, title: item.line || state, "aria-label": [`${dayLabel(localDay(item.at))} ${timeOf(item.at)}`, state, item.line].filter(Boolean).join(", ") },
      h("span.job-icon", { "data-state": item.state, "aria-hidden": "true" }, stateIcon(item.state)),
      h("span.run-when", null, when),
      h("span.run-line", null, item.line || state),
    );
    b.addEventListener("click", () => deps.onOpen(item, b));
    return b;
  }

  /** Runs in a row that ended the same way: one row ("7 runs") that opens to them. */
  function foldedRow(row: RunRow, day: string): HTMLElement {
    const id = `run-fold-${row.key.replace(/[^\w-]/g, "_")}`;
    const isOpen = unfolded.has(row.key);
    const state = STATE_LABELS[row.state];
    const oldest = row.runs.at(-1)!;
    const head = h(
      "button.run-row.run-fold-head",
      { type: "button", "aria-expanded": String(isOpen), "aria-controls": id, title: row.line || state, "aria-label": `${row.runs.length} runs in a row, ${state}${row.line ? `, ${row.line}` : ""}, from ${dateOf(oldest.at)} ${timeOf(oldest.at)}` },
      h("span.job-icon", { "data-state": row.state, "aria-hidden": "true" }, stateIcon(row.state)),
      h("span.run-when", null, timeOf(row.runs[0]!.at)),
      h("span.run-count", null, plural(row.runs.length, "run")),
      h("span.run-line", null, row.line || state),
      h("span.run-chevron", { "aria-hidden": "true" }, "›"),
    );
    const members = h("ul.run-fold-list", { id, hidden: !isOpen }, ...row.runs.map((r) => h("li", null, runButton(r, localDay(r.at) !== day))));
    head.addEventListener("click", () => {
      const now = !unfolded.has(row.key);
      if (now) unfolded.add(row.key);
      else unfolded.delete(row.key);
      head.setAttribute("aria-expanded", String(now));
      members.hidden = !now;
    });
    return h("li.run-fold", null, head, members);
  }

  function drawPanel(): HTMLElement {
    const runs = earlier();
    const page = runPage(runs, filter, limit);
    const chips = h(
      "div.run-filters",
      { role: "group", "aria-label": "Show runs" },
      ...RUN_FILTERS.map((f) => {
        const b = h("button.run-filter", { type: "button", "data-filter": f, "aria-pressed": String(f === filter) }, FILTER_LABELS[f]);
        b.addEventListener("click", () => {
          if (f === filter) return;
          filter = f;
          limit = RUNS_PAGE;
          draw(true);
          list.querySelector<HTMLElement>(`.run-filter[data-filter="${f}"]`)?.focus();
        });
        return b;
      }),
    );
    const days = page.days.map((d) =>
      h(
        "section.run-day",
        { "aria-label": dayLabel(d.day) },
        h("h3.run-day-head", { "aria-hidden": "true" }, dayLabel(d.day)),
        h("ul.run-list", null, ...d.rows.map((r) => (r.runs.length > 1 ? foldedRow(r, d.day) : h("li", null, runButton(r.runs[0]!, false))))),
      ),
    );
    const rest = page.total - page.shown;
    const older = data.loadedUntil !== null;
    let showMore: HTMLElement | null = null;
    if (rest > 0 || (older && page.shown >= limit)) {
      showMore = h("button.link.show-more.run-more", { type: "button" }, rest > 0 && !older ? `Show ${Math.min(rest, RUNS_PAGE)} more` : "Show more");
      showMore.addEventListener("click", () => {
        const first = runs.filter((i) => inFilter(i, filter))[page.shown]?.key;
        limit += RUNS_PAGE;
        draw(true);
        // The first run added takes the focus (once known: older rows may still be loading).
        if (first) rowOf(first)?.focus();
      });
    }
    const empty = page.total === 0 ? h("p.empty.run-none", null, older ? "Loading…" : NONE[filter]) : null;
    return h("div.job-runs-panel", { id: panelId }, chips, empty, ...days, showMore);
  }

  function draw(force = false): void {
    const runs = earlier();
    // Every run counts (the latest's state is in the counts).
    const sig = JSON.stringify([open, filter, limit, data.loadedUntil, data.latestKey, data.items.map((r) => `${r.key}:${r.state}:${r.line}`)]);
    if (!force && sig === drawn) return;
    drawn = sig;
    drawStats();
    if (!runs.length) return void list.replaceChildren();
    const toggle = h(
      "button.job-runs-toggle",
      { type: "button", "aria-expanded": String(open), "aria-controls": panelId },
      h("span", null, `Earlier runs (${runs.length}${more()})`),
      h("span.run-chevron", { "aria-hidden": "true" }, "›"),
    );
    toggle.addEventListener("click", () => {
      open = !open;
      draw(true);
      list.querySelector<HTMLElement>(".job-runs-toggle")?.focus();
    });
    list.replaceChildren(toggle, ...(open ? [drawPanel()] : []));
    if (open && needsMoreRows(runs, filter, limit, data.loadedUntil)) deps.onNeedOlder();
  }

  return {
    stats,
    list,
    update(next) {
      data = next;
      draw();
    },
    focusRun(key) {
      const row = rowOf(key);
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    },
    reset() {
      open = false;
      filter = "all";
      limit = RUNS_PAGE;
      unfolded.clear();
      drawn = "";
      data = { items: [], latestKey: null, loadedUntil: null };
      stats.replaceChildren();
      list.replaceChildren();
    },
  };
}
