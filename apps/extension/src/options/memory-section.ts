/**
 * Settings > Memory: what the agent remembers between chats and runs, by
 * kind, with edit and delete for each entry, a switch per kind, "Use memory"
 * (off pauses it), a search, and "Forget everything" (asked twice). Task
 * history is grouped by repeating task (collapsed, with a count): its run
 * notes, its records filed by key, and "delete this task's memory" (asked
 * twice). Episodes are listed by date (a page at a time) with Delete only.
 * Facts have "Always give" / "Only when relevant" (memory.pin) and show what
 * they said before. The switches save with settings.save like the rest of the page;
 * the entries come from memory.list. What shows comes from memory-view.ts.
 */
import { errorMessage, type ExtensionSettings, type MemoryEntry, type MemoryKind } from "@noa/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, flash, h } from "../ui/dom.js";
import { memoryQuestionText } from "../ui/memory-question.js";
import {
  backfillText,
  forgetAllText,
  forgetTaskText,
  kindsOffAfter,
  memoryPanel,
  PIN_TEXT,
  RECORDS_PAGE,
  syncText,
  type MemoryEntryView,
  type MemoryKindView,
  type MemoryTaskView,
} from "./memory-view.js";
import type { MemorySyncStatus } from "../memory/sync.js";

export interface MemorySection {
  render(state: UiState): void;
}

export function initMemorySection(opts: { onState(state: UiState): void }): MemorySection {
  const onSwitch = $<HTMLInputElement>("memory-on");
  const pausedNote = $("memory-paused-note");
  const syncNote = $("memory-sync");
  const syncActions = $("memory-sync-actions");
  const backfill = $("memory-backfill");
  const search = $<HTMLInputElement>("memory-search");
  const found = $("memory-found");
  const kindsHost = $("memory-kinds");
  const empty = $("memory-empty");
  const msg = $("memory-msg");
  const forget = $<HTMLButtonElement>("memory-forget");
  const forgetCancel = $<HTMLButtonElement>("memory-forget-cancel");
  const forgetQuestion = $("memory-forget-question");

  let settings: Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff"> | null = null;
  let entries: MemoryEntry[] = [];
  let sync: MemorySyncStatus | undefined;
  let loaded = false;
  /** The entry being edited (its row shows the editor). */
  let editing: string | null = null;
  let confirming = false;
  /** The task groups the user opened, the records each shows, and the task whose deletion is being asked. */
  const openTasks = new Set<string>();
  const recordsShown = new Map<string, number>();
  let confirmingTask: string | null = null;
  /** How many entries each paged group (episodes, the user's records) shows. */
  const kindShown = new Map<MemoryKind, number>();

  async function save(patch: Partial<ExtensionSettings>): Promise<void> {
    try {
      opts.onState(await uiRequest({ type: "settings.save", settings: patch }));
    } catch (err) {
      flash(msg, `Not saved: ${errorMessage(err)}`, "bad");
      draw();
    }
  }

  async function load(): Promise<void> {
    try {
      const res = await uiRequest({ type: "memory.list" });
      entries = res.entries;
      sync = res.sync;
      loaded = true;
    } catch (err) {
      flash(msg, `Memory could not be loaded: ${errorMessage(err)}`, "bad", { keep: true });
    }
    draw();
  }

  onSwitch.addEventListener("change", () => void save({ memoryPaused: !onSwitch.checked }));
  search.addEventListener("input", () => draw());

  function kindBlock(k: MemoryKindView, searching: boolean): HTMLElement {
    const id = `memory-kind-${k.kind}`;
    const toggle = h("input", { id, type: "checkbox", role: "switch", checked: k.on, "aria-describedby": `${id}-hint` });
    toggle.addEventListener("change", () => void save({ memoryKindsOff: kindsOffAfter(settings?.memoryKindsOff ?? [], k.kind, toggle.checked) }));
    const none = !loaded ? "Loading…" : searching ? "No matches." : "Nothing yet.";
    const body = !k.count
      ? [h("p.mem-none", null, none)]
      : k.page
        ? pagedList(k, k.page)
        : [...(k.entries.length ? [h("ul.mem-list", null, ...k.entries.map(row))] : []), ...k.tasks.map((t) => taskBlock(t, searching))];
    return h(
      "div.box.mem-kind",
      { "data-kind": k.kind, "data-on": String(k.on) },
      h(
        "div.srow.mem-kind-head",
        null,
        h("label.srow-label", { for: id }, h("b", null, k.label, h("span.mem-count", null, k.count.toLocaleString("en-US"))), h("small", { id: `${id}-hint` }, k.on ? k.hint : k.offHint)),
        h("div.srow-control", null, h("span.switch", null, toggle)),
      ),
      ...body,
    );
  }

  const row = (e: MemoryEntryView) => (e.id === editing ? editor(e) : entryRow(e));

  /** "Show 50 more of 70": adds a page to a long list; null when everything shows. */
  function moreButton(hidden: number, page: number, onMore: () => void): HTMLElement | null {
    if (hidden <= 0) return null;
    const btn = h("button.small.ghost.mem-more", { type: "button" }, `Show ${Math.min(hidden, page)} more of ${hidden.toLocaleString("en-US")}`);
    btn.addEventListener("click", () => {
      onMore();
      draw();
    });
    return h("div.mem-more-row", null, btn);
  }

  /** A group listed a page at a time (episodes by date, the user's records by key). */
  function pagedList(k: MemoryKindView, page: number): HTMLElement[] {
    const count = kindShown.get(k.kind) ?? page;
    const shown = k.entries.slice(0, count);
    const more = moreButton(k.entries.length - shown.length, page, () => kindShown.set(k.kind, count + page));
    return [h("ul.mem-list", { class: k.kind === "record" ? "mem-records" : null }, ...shown.map(row)), ...(more ? [more] : [])];
  }

  /** One repeating task's memory, collapsed with its count; open while a search finds something in it. */
  function taskBlock(t: MemoryTaskView, searching: boolean): HTMLElement {
    const shown = recordsShown.get(t.taskKey) ?? RECORDS_PAGE;
    const records = t.records.slice(0, shown);
    const more = moreButton(t.records.length - records.length, RECORDS_PAGE, () => recordsShown.set(t.taskKey, shown + RECORDS_PAGE));
    const details = h(
      "details.mem-task",
      { "data-task": t.taskKey, open: searching || openTasks.has(t.taskKey) },
      h("summary.mem-task-head", null, h("span.mem-task-title", null, t.title), h("span.mem-count", null, t.countText)),
      ...(t.notes.length ? [h("p.mem-sub", null, "Run notes"), h("ul.mem-list", null, ...t.notes.map(row))] : []),
      ...(t.records.length ? [h("p.mem-sub", null, "Records by key"), h("ul.mem-list.mem-records", null, ...records.map(row))] : []),
      ...(more ? [more] : []),
      taskDelete(t),
    );
    details.addEventListener("toggle", () => {
      if (searching) return;
      if ((details as HTMLDetailsElement).open) openTasks.add(t.taskKey);
      else openTasks.delete(t.taskKey);
    });
    return details;
  }

  function taskDelete(t: MemoryTaskView): HTMLElement {
    const asking = confirmingTask === t.taskKey;
    const text = forgetTaskText(t.total, asking);
    const del = h("button.small.danger.mem-task-delete", { type: "button" }, text.button);
    const cancel = h("button.small.ghost.mem-task-cancel", { type: "button", hidden: !asking }, "Cancel");
    cancel.addEventListener("click", () => {
      confirmingTask = null;
      draw();
    });
    del.addEventListener("click", (ev) => {
      if (!asking) {
        confirmingTask = t.taskKey;
        draw();
        return document.querySelector<HTMLButtonElement>(`.mem-task[data-task="${t.taskKey}"] .mem-task-delete`)?.focus();
      }
      if (ev.detail > 1) return;
      void busy(
        del,
        async () => {
          const { removed } = await uiRequest({ type: "memory.deleteTask", taskKey: t.taskKey });
          entries = entries.filter((e) => e.taskKey !== t.taskKey);
          confirmingTask = null;
          flash(msg, `Deleted ${removed.toLocaleString("en-US")} ${removed === 1 ? "entry" : "entries"} of “${t.title}”.`, "ok");
          draw();
        },
        msg,
      );
    });
    return h("div.mem-task-foot", null, h("div.row", null, del, cancel), h("p.mem-question", { role: "status" }, text.question));
  }

  /** "Always give" / "Only when relevant": whether the agent is given this fact at every turn. */
  function pinControl(e: MemoryEntryView): HTMLSelectElement {
    const choice = (pinned: boolean) => {
      const t = pinned ? PIN_TEXT.pinned : PIN_TEXT.relevant;
      return h("option", { value: pinned ? "pinned" : "relevant", title: t.hint, selected: e.pinned === pinned }, t.label);
    };
    const select = h("select.mem-pin", { id: `memory-pin-${e.id}`, "aria-label": `When to give ${e.subject}`, title: (e.pinned ? PIN_TEXT.pinned : PIN_TEXT.relevant).hint }, choice(false), choice(true));
    select.addEventListener("change", async () => {
      const pinned = select.value === "pinned";
      select.disabled = true;
      try {
        const { entry } = await uiRequest({ type: "memory.pin", id: e.id, pinned });
        entries = entries.map((x) => (x.id === entry.id ? entry : x));
        flash(msg, pinned ? `“${e.subject}” is given at every turn.` : `“${e.subject}” is given only when relevant.`, "ok");
      } catch (err) {
        flash(msg, `Not saved: ${errorMessage(err)}`, "bad");
      }
      draw();
    });
    return select;
  }

  function entryRow(e: MemoryEntryView): HTMLElement {
    const edit = e.editable ? h("button.small.ghost", { type: "button", "aria-label": `Edit ${e.subject}` }, "Edit") : null;
    const del = h("button.small.ghost.mem-delete", { type: "button", "aria-label": `Delete ${e.subject}` }, "Delete");
    edit?.addEventListener("click", () => {
      editing = e.id;
      draw();
      document.getElementById(`memory-edit-subject-${e.id}`)?.focus();
    });
    del.addEventListener("click", () =>
      void busy(
        del,
        async () => {
          await uiRequest({ type: "memory.delete", id: e.id });
          entries = entries.filter((x) => x.id !== e.id);
          flash(msg, `Deleted “${e.subject}”.`, "ok");
          draw();
        },
        msg,
      ),
    );
    const notes = e.notes?.length ? h("ul.mem-notes", null, ...e.notes.map((n) => h("li", null, h("span.mem-note-when", null, n.when), " ", n.text))) : null;
    const history = e.history?.length ? h("ul.mem-notes.mem-history", null, ...e.history.map((line) => h("li", null, line))) : null;
    const chips = e.entities?.length ? h("div.mem-chips", null, ...e.entities.map((x) => h("span.chip.mem-chip", null, x))) : null;
    return h(
      "li.mem-entry",
      { "data-id": e.id, "data-pinned": e.pinned === undefined ? null : String(e.pinned) },
      h(
        "div.mem-main",
        null,
        e.when ? h("span.mem-when", null, e.when) : null,
        h("div.mem-head", null, h("b.mem-subject", null, e.subject), e.where ? h("span.mem-where", { class: e.site ? "site" : null }, e.where) : null),
        h("p.mem-text", null, e.text),
        notes,
        history,
        chips,
        e.meta ? h("small.mem-meta", null, e.meta) : null,
      ),
      h("div.mem-actions", null, e.pinned === undefined ? null : pinControl(e), edit, del),
    );
  }

  function editor(e: MemoryEntryView): HTMLElement {
    const subject = h("input", { id: `memory-edit-subject-${e.id}`, type: "text", value: e.subject, maxlength: "80", "aria-label": "Subject", spellcheck: "false" });
    const text = h("textarea", { id: `memory-edit-text-${e.id}`, rows: "3", maxlength: "400", "aria-label": "What it remembers" }, e.text);
    const problem = h("p.field-error.mem-problem", { role: "alert" });
    const saveBtn = h("button.small.primary", { type: "button" }, "Save");
    const cancel = h("button.small.ghost", { type: "button" }, "Cancel");
    cancel.addEventListener("click", () => {
      editing = null;
      draw();
    });
    saveBtn.addEventListener("click", () =>
      void busy(
        saveBtn,
        async () => {
          const { entry } = await uiRequest({ type: "memory.edit", id: e.id, subject: subject.value, text: text.value });
          entries = entries.map((x) => (x.id === entry.id ? entry : x));
          editing = null;
          flash(msg, "Saved.", "ok");
          draw();
        },
        (message) => void (problem.textContent = message),
      ),
    );
    return h("li.mem-entry.editing", { "data-id": e.id }, h("div.mem-edit", null, subject, text, problem, h("div.row", null, saveBtn, cancel)));
  }

  function drawForget(total: number): void {
    const t = forgetAllText(total, confirming);
    forget.textContent = t.button;
    forget.disabled = confirming && total === 0;
    forgetQuestion.textContent = t.question;
    forgetCancel.hidden = !confirming;
  }

  /** The answer to "Add this computer's memory to <account>?", or Add after keeping it separate. */
  function drawSyncActions(st: ReturnType<typeof syncText>): void {
    if (!st.action || !st.account) {
      syncActions.hidden = true;
      return syncActions.replaceChildren();
    }
    const q = memoryQuestionText(st.account);
    const choose = (add: boolean, btn: HTMLButtonElement) =>
      void busy(
        btn,
        async () => {
          sync = (await uiRequest({ type: "memory.syncChoice", add })).sync;
          if (add) await load();
          else draw();
        },
        msg,
      );
    const add = h("button.small.primary", { id: "memory-sync-add", type: "button" }, st.action === "ask" ? q.add : `Add it to ${st.account}`);
    add.addEventListener("click", () => choose(true, add));
    const buttons: HTMLElement[] = [add];
    if (st.action === "ask") {
      const keep = h("button.small.ghost", { id: "memory-sync-keep", type: "button" }, q.keep);
      keep.addEventListener("click", () => choose(false, keep));
      buttons.unshift(keep);
    }
    syncActions.replaceChildren(...(st.action === "ask" ? [h("p.mem-sync-hint", null, q.hint)] : []), h("div.row", null, ...buttons));
    syncActions.hidden = false;
  }

  function draw(): void {
    if (!settings) return;
    const v = memoryPanel(entries, settings, new Date(), search.value);
    onSwitch.checked = v.on;
    pausedNote.textContent = v.pausedNote;
    pausedNote.hidden = !v.pausedNote;
    const st = syncText(sync);
    syncNote.textContent = st.text;
    syncNote.dataset.tone = st.tone;
    syncNote.hidden = !st.text;
    drawSyncActions(st);
    empty.hidden = !loaded || !v.empty;
    search.hidden = v.empty;
    const searching = !!v.search.query;
    found.textContent = searching ? `${v.search.found.toLocaleString("en-US")} ${v.search.found === 1 ? "match" : "matches"}` : "";
    found.hidden = !searching;
    // A redraw keeps the focus where it was (a switch just used, a button, the search box).
    const focused = document.activeElement?.id;
    kindsHost.replaceChildren(...v.kinds.map((k) => kindBlock(k, searching)));
    kindsHost.toggleAttribute("data-paused", !v.on);
    if (focused) document.getElementById(focused)?.focus();
    drawForget(v.total);
  }

  forgetCancel.addEventListener("click", () => {
    confirming = false;
    drawForget(entries.length);
    forget.focus();
  });
  // Forgetting takes a second click on the same button; the second click of a double-click (detail 2) does not count.
  forget.addEventListener("click", (ev) => {
    if (!confirming) {
      confirming = true;
      return drawForget(entries.length);
    }
    if (ev.detail > 1) return;
    void busy(
      forget,
      async () => {
        const { removed } = await uiRequest({ type: "memory.clear" });
        entries = [];
        confirming = false;
        flash(msg, removed ? `Forgot ${removed} ${removed === 1 ? "memory" : "memories"}.` : "Memory was already empty.", "ok", { keep: true });
        draw();
      },
      msg,
    );
  });

  // Entries change as the agent works: read them again when the page comes back into view.
  window.addEventListener("focus", () => {
    if (!editing) void load();
  });
  void load();

  return {
    render(state) {
      // Past chats being summarized in the background: a quiet line while it lasts.
      const b = state.memoryBackfill;
      backfill.textContent = b ? backfillText(b) : "";
      backfill.hidden = !b;
      const s = state.settings;
      const same = settings && s.memoryPaused === settings.memoryPaused && s.memoryKindsOff.join() === settings.memoryKindsOff.join();
      settings = { memoryPaused: s.memoryPaused, memoryKindsOff: [...s.memoryKindsOff] as MemoryKind[] };
      // Signed in to another account (or the question was answered elsewhere): read the sync status again.
      if (loaded && !!state.memoryQuestion !== (sync?.state === "ask")) void load();
      else if (!same) draw();
    },
  };
}
