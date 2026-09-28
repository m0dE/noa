/**
 * A job's page: its header ("‹" back to the list, the title, one line of where it is, and "⋯" with what can be
 * done with it now: job-actions.ts) over its conversation (chat.ts). Under the header, while the job's agent tab is
 * not the one the user looks at: that tab, with View to watch the agent there.
 *
 * A task's page puts above its latest run's conversation: how many runs it had and how they went (each count opens
 * the runs list filtered), its instructions with Edit and Edit schedule while it is scheduled (job-instructions.ts),
 * and "Earlier runs (N)", which opens to its runs a page at a time (job-runs-view.ts). A run picked there shows its
 * conversation in the page's place ("‹ Runs" goes back to the list). A task that never ran shows its request and
 * when it will run.
 *
 * Its runs are its conversations in this browser and its series' task rows: those tasks.list has, and the rest loaded
 * from tasks.series a page at a time as the list needs them (the account lists a series in pages).
 */
import { MAX_CHAT_TITLE_CHARS } from "@noa/shared";
import { uiRequest } from "../ui-protocol.js";
import { $, h } from "../ui/dom.js";
import type { ChatView } from "./chat.js";
import { jobActions, type JobAction, type JobActionId } from "./job-actions.js";
import type { JobData } from "./job-data.js";
import { initInstructions } from "./job-instructions.js";
import { stateIcon } from "./job-list.js";
import { runItems, type RunItem } from "./job-runs.js";
import { initRunsView } from "./job-runs-view.js";
import { jobSubtitle, seriesOf, STATE_LABELS, type Job, type JobTask } from "./jobs.js";
import { formatWhen } from "./task-details.js";

export interface JobPageDeps {
  data: JobData;
  chat: ChatView;
  /** The tab to watch a conversation's agent in, when the user is not looking at it (null: none; see agentTabToView). */
  agentTab(sessionId: string): number | null;
  /** What a tab shows (null: it is gone). */
  tabInfo(tabId: number): Promise<TabInfo | null>;
  goToTab(tabId: number): void;
  /** Resume a stopped conversation (with the note typed in the box, if any). */
  continueNow(sessionId: string): void;
  openSchedule(job: Job, trigger: HTMLElement): void;
  /** The details sheet of a task that never ran (its request, its schedule). */
  onTaskDetails(job: Job, trigger: HTMLElement): void;
  onBack(): void;
  /** The job was deleted (the list shows again). */
  onDeleted(): void;
  showError(err: unknown): void;
}

export interface TabInfo {
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface JobPage {
  /** Shows job `key`: its header and its conversation. */
  show(key: string): void;
  /** The data changed: the header, the menu and the runs follow. */
  render(): void;
  /** The job shown (null: not known yet, e.g. a chat that just started). */
  job(): Job | null;
  /** The conversation the page shows (the chat, the task's newest run, or the run picked in its runs); null: none. */
  sessionId(): string | null;
  /** Its title as the header shows it. */
  title(): string;
  /** A tab's title, address or icon changed (the agent's tab row follows). */
  tabUpdated(tabId: number): void;
}

/** A tab without an icon the panel can show. */
const GLOBE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7c-3.2 3.6-3.2 9 0 12.6M8 1.7c3.2 3.6 3.2 9 0 12.6"/></svg>';

/** A page's site, as a person reads it ("mail.google.com"); "" for pages without one. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** A tab's icon the panel may show: a web or inline image (chrome:// icons do not load in an extension page). */
function safeIcon(url: string | undefined): string | null {
  return url && /^(https?:|data:image\/)/.test(url) ? url : null;
}

export function initJobPage(deps: JobPageDeps): JobPage {
  const { data, chat } = deps;
  const titleEl = $("job-title");
  const sub = $("job-sub");
  const menu = $<HTMLDetailsElement>("job-menu");
  const pop = $("job-menu-pop");
  const agentRow = $("job-agent-tab");
  const said = $("job-agent-tab-said");
  let key: string | null = null;
  let renaming = false;
  /** The run picked in the runs list, shown in the page's place (null: the page as it is). */
  let viewing: RunItem | null = null;
  /** What shows above a picked run's conversation ("‹ Runs", its time and how it went). */
  let viewingBar: HTMLElement | null = null;

  const current = (): Job | null => (key ? data.job(key) : null);
  const sessionId = (): string | null => {
    if (viewing) return viewing.session?.sessionId ?? null;
    const job = current();
    if (job) return job.session?.sessionId ?? null;
    return key?.startsWith("chat:") ? key.slice("chat:".length) : null;
  };

  const runs = initRunsView({ onOpen: openRun, onNeedOlder: () => void loadSeries() });
  const instructions = initInstructions({
    // The user's own words now (a task the agent wrote is theirs once they edit it).
    save: async (task, text) => {
      await uiRequest({ type: "tasks.update", id: task.id, patch: { instructions: text, agentAuthored: false } });
      await data.loadTasks();
    },
    editSchedule: (trigger) => {
      const job = current();
      if (job) deps.openSchedule(job, trigger);
    },
  });
  const latestHead = h("h2.job-runs-head.latest");
  /** A task's page above its conversation: its counts, its instructions, its earlier runs. */
  const top = h("div.job-top", null, runs.stats, instructions.el, runs.list, latestHead);

  /**
   * The job's series' task rows loaded from tasks.series (tasks.list may not have a long series' older ones): the
   * first page when its page shows, the next ones as the runs list needs them. `failed`: a page did not load (no
   * other is asked for automatically while the page shows the job).
   */
  let series: { id: string; rows: JobTask[]; cursor: string | null; loaded: boolean; loading: boolean; failed: boolean } | null = null;

  async function loadSeries(): Promise<void> {
    const s = series;
    if (!s || s.loading || s.failed || (s.loaded && s.cursor === null)) return;
    s.loading = true;
    try {
      const page = await uiRequest({ type: "tasks.series", seriesId: s.id, ...(s.cursor ? { cursor: s.cursor } : {}) });
      if (series !== s) return;
      s.rows.push(...page.tasks);
      s.cursor = page.nextCursor;
      s.loaded = true;
    } catch (err) {
      s.failed = true;
      deps.showError(err);
    } finally {
      s.loading = false;
    }
    render();
  }

  /** Every run of a task's job, from its conversations here and its series' rows known so far. */
  function runsOf(job: Job): { items: RunItem[]; loadedUntil: string | null } {
    const id = seriesOf(job.task ?? { id: job.key.slice("task:".length) });
    if (series?.id !== id) {
      series = { id, rows: [], cursor: null, loaded: false, loading: false, failed: false };
      void loadSeries();
    }
    // The list's copy of a row is the newest.
    const rows = new Map(series.rows.map((t) => [t.id, t]));
    for (const t of job.tasks) rows.set(t.id, t);
    const items = runItems({ sessions: job.runs, rows: [...rows.values()], running: new Set(job.running && job.session ? [job.session.sessionId] : []) });
    const older = series.loaded && series.cursor !== null && !series.failed;
    const loadedUntil = older ? series.rows.reduce((min, t) => (t.updatedAt < min ? t.updatedAt : min), series.rows[0]?.updatedAt ?? "") : null;
    return { items, loadedUntil };
  }

  function openRun(item: RunItem): void {
    viewing = item;
    viewingBar = null;
    render(true);
    document.querySelector<HTMLElement>("#chat-log .job-run-back")?.focus();
  }

  /** Back from a run to the runs list, on that run's row. */
  function closeRun(): void {
    const was = viewing;
    if (!was) return;
    viewing = null;
    viewingBar = null;
    render(true);
    runs.focusRun(was.key);
  }

  // Escape on a run picked in the runs list goes back to the list (not to the jobs list).
  for (const el of [$("view-job"), $("job-head")]) {
    el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.key !== "Escape" || !viewing || e.defaultPrevented || t.closest("input, textarea, details[open], dialog")) return;
      e.preventDefault();
      closeRun();
    });
  }

  $("job-back").addEventListener("click", () => deps.onBack());

  // The menu is built as it opens (what the job offers at that moment: on the click, before it shows), and emptied
  // when it closes.
  menu.querySelector("summary")!.addEventListener("click", () => {
    if (!menu.open) buildMenu();
  });
  menu.addEventListener("toggle", () => {
    if (!menu.open) return pop.replaceChildren();
    if (!pop.childElementCount) buildMenu();
    pop.querySelector<HTMLButtonElement>("button")?.focus();
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...pop.querySelectorAll<HTMLButtonElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(i + step + items.length) % items.length]!.focus();
    }
  });

  function item(a: JobAction): HTMLButtonElement {
    const b = h(a.danger ? "button.bad" : "button", { type: "button", role: "menuitem", "data-action": a.id, title: a.title }, a.id === "raw" && chat.rawOpen ? "Close raw" : a.label);
    b.addEventListener("click", (e) => {
      // The confirmation takes the item's place: the click must not count as one outside the menu (which closes it).
      if (a.id === "delete") {
        e.stopPropagation();
        return confirmDelete();
      }
      menu.open = false;
      void act(a.id);
    });
    return b;
  }

  function buildMenu(): void {
    const job = current();
    const actions = job ? jobActions(job, data.source) : [];
    pop.replaceChildren(...actions.map(item));
    if (menu.open) pop.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** Delete asks once, in the menu: this cannot be undone. */
  function confirmDelete(): void {
    const job = current();
    if (!job) return;
    const yes = h("button.bad", { type: "button", role: "menuitem", "data-action": "delete-confirm" }, "Delete");
    const no = h("button", { type: "button", role: "menuitem" }, "Keep");
    yes.addEventListener("click", () => {
      menu.open = false;
      void act("delete");
    });
    no.addEventListener("click", (e) => {
      e.stopPropagation();
      buildMenu();
    });
    pop.replaceChildren(h("p.menu-note", { role: "alert" }, job.kind === "task" ? "Delete this job and all its runs? This can't be undone." : "Delete this chat? This can't be undone."), yes, no);
    no.focus();
  }

  async function act(id: JobActionId): Promise<void> {
    const job = current();
    if (!job) return;
    const t = job.task;
    const s = job.session;
    try {
      switch (id) {
        case "run":
          if (t) await uiRequest({ type: "tasks.run", id: t.id });
          await data.loadTasks();
          break;
        case "pause":
          if (s) await uiRequest({ type: "run.stop", sessionId: s.sessionId });
          break;
        case "resume":
          if (t && data.source === "account") {
            await uiRequest({ type: "tasks.retry", id: t.id });
            await data.loadTasks();
          } else if (s) deps.continueNow(s.sessionId);
          break;
        case "hold":
        case "release":
          if (t) await uiRequest({ type: id === "hold" ? "tasks.pause" : "tasks.resume", id: t.id });
          await data.loadTasks();
          break;
        case "schedule":
          deps.openSchedule(job, menu.querySelector("summary")!);
          break;
        case "trust":
          if (t) await uiRequest({ type: "tasks.update", id: t.id, patch: { agentAuthored: false } });
          await data.loadTasks();
          break;
        case "raw":
          chat.setRaw(!chat.rawOpen);
          break;
        case "rename":
          startRename();
          break;
        case "cancel":
          if (t) await uiRequest({ type: "tasks.cancel", id: t.id });
          await data.loadTasks();
          break;
        case "delete":
          await remove(job);
          break;
      }
    } catch (err) {
      deps.showError(err);
    }
  }

  /** A chat goes with its conversation; a task with every repeat of it and every run. */
  async function remove(job: Job): Promise<void> {
    for (const t of job.tasks) if (t.status !== "running") await uiRequest({ type: "tasks.delete", id: t.id });
    for (const r of job.runs) {
      if (job.running && r.sessionId === job.session?.sessionId) continue;
      await uiRequest({ type: "session.delete", sessionId: r.sessionId });
      data.forget(r.sessionId);
    }
    if (job.tasks.length) await data.loadTasks();
    deps.onDeleted();
  }

  /** The title becomes a text box: Enter or leaving it saves (an unchanged or empty name keeps it), Escape cancels. */
  function startRename(): void {
    const s = current()?.session;
    if (!s || renaming) return;
    renaming = true;
    const box = h("input.job-rename", { type: "text", value: titleEl.textContent ?? "", "aria-label": "Job name", maxlength: MAX_CHAT_TITLE_CHARS, spellcheck: "false" });
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const name = box.value.trim();
      box.replaceWith(titleEl);
      renaming = false;
      titleEl.focus();
      if (!save || !name || name === s.title) return render();
      titleEl.textContent = name;
      try {
        data.onSession((await uiRequest({ type: "session.rename", sessionId: s.sessionId, title: name })).session);
      } catch (err) {
        deps.showError(err);
        render();
      }
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void finish(true);
      else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void finish(false);
      }
    });
    box.addEventListener("blur", () => void finish(true));
    titleEl.replaceWith(box);
    box.focus();
    box.select();
  }

  /**
   * The agent's tab, while the user is not looking at it: its icon, title and site, and View (that tab, in front, to
   * watch the agent there). Screen readers hear it when it appears, not each page the agent opens there.
   */
  function renderAgentTab(job: Job | null): void {
    const id = sessionId();
    const tab = id ? deps.agentTab(id) : null;
    if (tab === null) {
      agentRow.hidden = true;
      delete agentRow.dataset.tab;
      return;
    }
    const lead = job?.running ? "Working in" : "Ran in";
    if (agentRow.dataset.tab !== String(tab)) {
      agentRow.dataset.tab = String(tab);
      agentRow.hidden = true;
      const view = h("button.job-tab-view", { type: "button", title: "Switch to this tab to watch the agent", "aria-label": "View the agent's tab" }, "View");
      view.addEventListener("click", () => deps.goToTab(tab));
      agentRow.replaceChildren(h("span.job-tab-icon", { "aria-hidden": "true" }), h("span.job-tab-text", null, h("span.job-tab-lead"), " ", h("b.job-tab-name"), h("span.job-tab-host")), view);
    }
    agentRow.querySelector(".job-tab-lead")!.textContent = lead;
    void fillTab(tab);
  }

  /** The row's tab as it is now; shown once known (hidden if the tab is gone). */
  async function fillTab(tab: number): Promise<void> {
    const info = await deps.tabInfo(tab);
    if (agentRow.dataset.tab !== String(tab)) return;
    if (!info) {
      agentRow.hidden = true;
      return;
    }
    const host = hostOf(info.url);
    const title = info.title || host || "another tab";
    const name = agentRow.querySelector<HTMLElement>(".job-tab-name")!;
    name.textContent = title;
    name.title = info.url ? `${title} (${info.url})` : title;
    agentRow.querySelector(".job-tab-host")!.textContent = host && host !== title ? host : "";
    agentRow.querySelector(".job-tab-view")!.setAttribute("aria-label", `View the agent's tab: ${title}`);
    const icon = agentRow.querySelector<HTMLElement>(".job-tab-icon")!;
    const src = safeIcon(info.favIconUrl) ?? "";
    if (icon.dataset.src !== src || !icon.firstChild) {
      icon.dataset.src = src;
      if (!src) icon.innerHTML = GLOBE_ICON;
      else {
        const img = h("img", { src, alt: "", width: 16, height: 16 }) as HTMLImageElement;
        img.addEventListener("error", () => (icon.innerHTML = GLOBE_ICON));
        icon.replaceChildren(img);
      }
    }
    if (agentRow.hidden) {
      agentRow.hidden = false;
      said.textContent = `${agentRow.querySelector(".job-tab-lead")!.textContent} ${title}. View shows it.`;
    }
  }

  /** A task that never ran: its request as the page's opening bubble (it opens the task's details), and "Not run yet". */
  function introOf(job: Job, task: JobTask): HTMLElement {
    const bubble = h("div.ev-user.ev-first", { role: "button", tabindex: "0", title: "Show the full task and its details" }, h("span.ev-origin", null, "Scheduled"), h("span.ev-user-text", null, task.instructions));
    const open = () => deps.onTaskDetails(job, bubble);
    bubble.addEventListener("click", open);
    bubble.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    return h("div.job-intro", null, h("div.ev-opening", null, bubble, h("div.ev-when", null, "Not run yet")));
  }

  /**
   * Above a run picked in the runs list: "‹ Runs", when it ran and how it went. A run known only by its task row (its
   * conversation is not in this browser) also says how it ended, and where.
   */
  function runBar(item: RunItem): HTMLElement {
    const back = h("button.job-run-back", { type: "button", title: "Back to the runs (Esc)" }, h("span", { "aria-hidden": "true" }, "‹ "), "Runs");
    back.addEventListener("click", closeRun);
    const state = STATE_LABELS[item.state];
    const bar = h(
      "div.job-run-bar",
      { "data-key": item.key },
      back,
      h("h2.job-run-title", null, formatWhen(item.at)),
      h("span.job-run-state", { "data-state": item.state }, h("span.job-icon", { "data-state": item.state, "aria-hidden": "true" }, stateIcon(item.state)), state),
    );
    if (item.session) return bar;
    const t = item.task!;
    const said = (t.resultSummary ?? t.failReason ?? t.pauseReason ?? "").trim();
    return h(
      "div.job-run-view",
      { "data-key": item.key },
      bar,
      h(
        "div.job-run-gone",
        null,
        said ? h("p.job-run-said", null, said) : null,
        t.resultUrl ? h("a.job-run-url", { href: t.resultUrl, target: "_blank", rel: "noopener noreferrer" }, t.resultUrl) : null,
        h("p.job-run-note", null, "Its conversation isn't kept in this browser: it ran in another one, or long ago."),
      ),
    );
  }

  /** Above the conversation: a task's counts, instructions and earlier runs; or the bar over a run picked there. */
  function renderTop(job: Job | null): void {
    if (!job || job.kind !== "task") return chat.setBefore(null);
    if (viewing) {
      if (viewingBar?.dataset.key !== viewing.key) viewingBar = runBar(viewing);
      return chat.setBefore(viewingBar);
    }
    const { items, loadedUntil } = runsOf(job);
    const latest = job.session;
    runs.update({ items, latestKey: latest?.sessionId ?? null, loadedUntil });
    // Its instructions while it is scheduled (a task that never ran: its request as the opening bubble).
    const task = job.task;
    if (task && (job.scheduled || !latest)) {
      instructions.update({ task, canSchedule: jobActions(job, data.source).some((a) => a.id === "schedule"), ...(latest ? {} : { intro: introOf(job, task) }) });
    } else instructions.reset();
    latestHead.hidden = !latest || !runs.list.childElementCount;
    latestHead.textContent = latest ? `Latest run · ${formatWhen(latest.firstStartedAt ?? latest.startedAt)}` : "";
    // A task that ran once and is not scheduled has nothing above its conversation.
    chat.setBefore(runs.stats.hasChildNodes() || runs.list.hasChildNodes() || instructions.el.hasChildNodes() ? top : null);
  }

  /** `top`: the conversation shows at its top (a run picked, or back from one to the list), not at its end. */
  function render(top = false): void {
    if (!key) return;
    const job = current();
    const shown = chat.shown();
    if (!renaming) titleEl.textContent = job?.title ?? shown?.title ?? "";
    titleEl.title = titleEl.textContent ?? "";
    sub.textContent = job ? jobSubtitle(job) : "";
    menu.hidden = !!job && jobActions(job, data.source).length === 0;
    renderAgentTab(job);
    renderTop(job);
    chat.show(sessionId(), { top });
  }

  return {
    show(next) {
      if (next !== key) {
        key = next;
        viewing = null;
        viewingBar = null;
        series = null;
        runs.reset();
        instructions.reset();
        menu.open = false;
        chat.setRaw(false);
        chat.setBefore(null);
      }
      render();
    },
    render: () => render(),
    job: current,
    sessionId,
    title: () => titleEl.textContent ?? "",
    tabUpdated(tab) {
      if (!agentRow.hidden && agentRow.dataset.tab === String(tab)) void fillTab(tab);
    },
  };
}
