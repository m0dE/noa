/**
 * The add/edit form's schedule section, shared by the side panel and the
 * dashboard (each styles the `sch-*` classes): One time | Repeat (native
 * radios). One time shows "Scheduled at" (date and time; empty = as soon as
 * possible). Repeat shows the rule's choices instead (frequency, every N,
 * weekdays, day of the month, times, or a custom cron with a live
 * description; then starts and ends) and the first run they give. Then the
 * time zone. Plain DOM; the state and rules are in schedule-form.ts.
 *
 * Imported as "@noa/shared/schedule-fields" (DOM code stays out of
 * the package's main entry, which the API Worker imports too).
 */
import { describeCron } from "../schedule-text.js";
import {
  formToRepeat,
  onceInstant,
  openSchedule,
  saveSchedule,
  SCHEDULE_MODES,
  withMode,
  type Ends,
  type Frequency,
  type RepeatForm,
  type ScheduleDraft,
  type ScheduleField,
  type ScheduleMode,
  type ScheduleValue,
} from "../schedule-form.js";
import { cronProblem, nextRun } from "../schedule.js";
import { NTH_NAMES, ordinal, prefersHour12, WEEK_ORDER, WEEKDAY_NAMES, WEEKDAY_SHORT } from "../schedule-text.js";
import { whenText } from "../task-view.js";
import { localTimeZone } from "../zoned-time.js";

export type { ScheduleValue };

export interface ScheduleFieldsOptions {
  /** Prefix of the element ids (unique on the page). */
  id: string;
  value?: ScheduleValue | null;
  /** The zone times are entered in; default this browser's. A rule being edited uses its own. */
  timeZone?: string;
  now?: () => Date;
  hour12?: boolean;
}

export type ScheduleRead = { ok: true; value: ScheduleValue } | { ok: false; error: string; focus: HTMLElement };

export interface ScheduleFields {
  readonly element: HTMLElement;
  /** The schedule entered, or what to fix (and the field to focus). */
  read(): ScheduleRead;
  /** Shows a schedule (null: a new task, One time, as soon as possible). */
  set(value: ScheduleValue | null): void;
}

type Attrs = Record<string, string | number | boolean | null | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

function select(id: string, options: [string, string][], label?: string): HTMLSelectElement {
  const s = el("select", { id, ...(label ? { "aria-label": label } : {}) });
  for (const [value, text] of options) s.append(el("option", { value }, text));
  return s;
}

function tell(p: HTMLElement, text: string, tone: "" | "bad"): void {
  p.textContent = text;
  p.dataset.tone = tone;
}

const FREQUENCIES: [Frequency, string][] = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["custom", "Custom (cron)"],
];
const UNIT_WORDS: Record<Exclude<Frequency, "custom">, [string, string]> = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"] };
const ENDS: [Ends, string][] = [
  ["never", "Never"],
  ["on", "On date"],
  ["after", "After"],
];

/** Every IANA zone this browser knows, else just the ones given. */
function timeZones(known: string[]): string[] {
  const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([...known, ...all])].sort();
}

export function createScheduleFields(opts: ScheduleFieldsOptions): ScheduleFields {
  const now = opts.now ?? (() => new Date());
  const hour12 = opts.hour12 ?? prefersHour12();
  const id = (s: string) => `${opts.id}-${s}`;
  let draft: ScheduleDraft = openSchedule(null, { tz: opts.timeZone ?? localTimeZone(), now: now() });
  /** The user typed a cron: switching to Custom keeps it. */
  let cronTouched = false;

  // One time | Repeat
  const modeInputs = SCHEDULE_MODES.map(([value]) => el("input", { type: "radio", name: id("mode"), id: id(`mode-${value}`), value }));
  const mode = el(
    "fieldset",
    { class: "sch-mode segmented" },
    el("legend", { class: "sch-sr" }, "Schedule"),
    ...SCHEDULE_MODES.map(([value, label], i) => el("label", { for: id(`mode-${value}`) }, modeInputs[i]!, el("span", null, label))),
  );
  const chosenMode = (): ScheduleMode => (modeInputs.find((i) => i.checked)?.value as ScheduleMode | undefined) ?? "once";

  // One time: Scheduled at
  const date = el("input", { id: id("date"), type: "date", "aria-describedby": id("when-hint") });
  const time = el("input", { id: id("time"), type: "time", "aria-label": "Time", "aria-describedby": id("when-hint") });
  const clearWhen = el("button", { type: "button", class: "sch-link", "aria-label": "Clear the scheduled time" }, "Clear");
  const whenHint = el("p", { id: id("when-hint"), class: "sch-hint" });
  const when = el(
    "div",
    { class: "sch-when", id: id("when") },
    el("label", { class: "sch-label", for: id("date") }, "Scheduled at"),
    el("div", { class: "sch-row" }, date, time, clearWhen),
    whenHint,
  );

  // Repeat: frequency and every N
  const frequency = select(id("freq"), FREQUENCIES);
  const every = el("input", { id: id("every"), type: "number", min: 1, max: 99, step: 1, inputmode: "numeric", class: "sch-num" });
  const everyUnit = el("span", { class: "sch-unit", id: id("every-unit") });
  every.setAttribute("aria-describedby", id("every-unit"));
  const everyField = el("div", { class: "sch-field sch-every" }, el("label", { for: id("every") }, "Every"), el("div", { class: "sch-row" }, every, everyUnit));
  const freqRow = el("div", { class: "sch-grid" }, el("div", { class: "sch-field" }, el("label", { for: id("freq") }, "Frequency"), frequency), everyField);

  // Weekly: day chips, Monday first
  const dayButtons = WEEK_ORDER.map((d) =>
    el("button", { type: "button", class: "sch-day", "aria-pressed": "false", "data-day": d, "aria-label": WEEKDAY_NAMES[d], title: WEEKDAY_NAMES[d] }, WEEKDAY_SHORT[d]!.slice(0, 2)),
  );
  const days = el("div", { class: "sch-field sch-days-field" }, el("span", { class: "sch-label", id: id("days-label") }, "On"), el("div", { class: "sch-days", role: "group", "aria-labelledby": id("days-label") }, ...dayButtons));

  // Monthly: on day N, or on the nth weekday
  const byDay = el("input", { type: "radio", name: id("monthly"), id: id("by-day"), value: "day" });
  const byWeekday = el("input", { type: "radio", name: id("monthly"), id: id("by-weekday"), value: "weekday" });
  const monthDay = select(id("month-day"), [...Array.from({ length: 31 }, (_, i): [string, string] => [String(i + 1), ordinal(i + 1)]), ["-1", "last day"]], "Day of the month");
  const nth = select(id("nth"), [1, 2, 3, 4, -1].map((n): [string, string] => [String(n), NTH_NAMES[n]!]), "Which week");
  const nthDay = select(id("nth-day"), WEEK_ORDER.map((d): [string, string] => [String(d), WEEKDAY_NAMES[d]!]), "Day of the week");
  const monthly = el(
    "div",
    { class: "sch-field sch-monthly", role: "radiogroup", "aria-label": "Day of the month" },
    el("div", { class: "sch-row" }, byDay, el("label", { for: id("by-day") }, "On the"), monthDay),
    el("div", { class: "sch-row" }, byWeekday, el("label", { for: id("by-weekday") }, "On the"), nth, nthDay),
  );

  // Times
  const timeList = el("div", { class: "sch-times", role: "group", "aria-labelledby": id("times-label") });
  const addTime = el("button", { type: "button", class: "sch-link sch-add" }, "+ Add time");
  const times = el("div", { class: "sch-field" }, el("span", { class: "sch-label", id: id("times-label") }, "At"), el("div", { class: "sch-row sch-wrap" }, timeList, addTime));

  // Custom cron
  const cron = el("textarea", {
    id: id("cron"),
    rows: 2,
    spellcheck: "false",
    autocomplete: "off",
    class: "sch-cron",
    placeholder: "0 9 * * 1-5",
    "aria-describedby": `${id("cron-text")} ${id("cron-help")}`,
  });
  const cronText = el("p", { id: id("cron-text"), class: "sch-cron-text", "aria-live": "polite" });
  const custom = el(
    "div",
    { class: "sch-field sch-custom" },
    el("label", { for: id("cron") }, "Cron"),
    cron,
    cronText,
    el("p", { id: id("cron-help"), class: "sch-hint" }, "minute hour day-of-month month day-of-week; one rule per line"),
  );

  // Starts and ends
  const start = el("input", { id: id("start"), type: "date" });
  const ends = select(id("ends"), ENDS);
  const endDate = el("input", { id: id("end-date"), type: "date", "aria-label": "End date" });
  const count = el("input", { id: id("count"), type: "number", min: 1, max: 1000, step: 1, inputmode: "numeric", class: "sch-num", "aria-label": "Number of runs" });
  const countUnit = el("span", { class: "sch-unit" }, "runs");
  const range = el(
    "div",
    { class: "sch-grid sch-range" },
    el("div", { class: "sch-field" }, el("label", { for: id("start") }, "Starts"), start),
    el("div", { class: "sch-field" }, el("label", { for: id("ends") }, "Ends"), el("div", { class: "sch-row" }, ends, endDate, count, countUnit)),
  );
  /** The first run the rule gives, or what to fix in it. */
  const firstRun = el("p", { class: "sch-hint sch-first", id: id("first"), "aria-live": "polite" });

  const rule = el("fieldset", { id: id("rule"), class: "sch-rule" }, el("legend", { class: "sch-sr" }, "Repeat"), freqRow, days, monthly, times, custom, range, firstRun);

  // Time zone: shown; a select when the user asks to change it.
  const tzName = el("span", { class: "sch-tz-name" });
  const tzChange = el("button", { type: "button", class: "sch-link", "aria-controls": id("tz") }, "Change");
  const tzSelect = el("select", { id: id("tz"), "aria-label": "Time zone", hidden: true });
  const tzRow = el("p", { class: "sch-hint sch-tz" }, "Time zone: ", tzName, " ", tzChange, tzSelect);

  const element = el("div", { class: "sch" }, mode, when, rule, tzRow);

  // ---- draft <-> fields ------------------------------------------------------

  function timeRow(value: string): HTMLElement {
    const n = timeList.children.length + 1;
    const input = el("input", { type: "time", value, "aria-label": `Time ${n}`, required: true });
    input.value = value;
    const rm = el("button", { type: "button", class: "sch-x", "aria-label": `Remove time ${n}`, title: "Remove" }, "×");
    const row = el("span", { class: "sch-time" }, input, rm);
    rm.addEventListener("click", () => {
      if (timeList.children.length === 1) return;
      const next = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector("input");
      row.remove();
      renumberTimes();
      next?.focus();
      touched();
    });
    input.addEventListener("input", touched);
    return row;
  }

  function renumberTimes(): void {
    [...timeList.children].forEach((row, i) => {
      row.querySelector("input")!.setAttribute("aria-label", `Time ${i + 1}`);
      row.querySelector("button")!.setAttribute("aria-label", `Remove time ${i + 1}`);
      row.querySelector("button")!.toggleAttribute("disabled", timeList.children.length === 1);
    });
  }

  /** The rule's choices into their fields. */
  function writeRule(): void {
    const form = draft.rule;
    frequency.value = form.frequency;
    every.value = String(form.every);
    for (const b of dayButtons) b.setAttribute("aria-pressed", String(form.weekdays.includes(Number(b.dataset.day))));
    const m = form.monthly;
    byDay.checked = m.by === "day";
    byWeekday.checked = m.by === "weekday";
    if (m.by === "day") monthDay.value = String(m.day);
    else {
      nth.value = String(m.nth);
      nthDay.value = String(m.weekday);
    }
    timeList.replaceChildren();
    for (const t of form.times.length ? form.times : ["09:00"]) timeList.append(timeRow(t));
    renumberTimes();
    cron.value = form.cron;
    start.value = form.start;
    ends.value = form.ends;
    endDate.value = form.endDate;
    count.value = String(form.count);
  }

  function readRule(): RepeatForm {
    const m: RepeatForm["monthly"] = byWeekday.checked
      ? { by: "weekday", nth: Number(nth.value), weekday: Number(nthDay.value) }
      : { by: "day", day: Number(monthDay.value) };
    return {
      ...draft.rule,
      frequency: frequency.value as Frequency,
      every: every.value === "" ? NaN : Number(every.value),
      weekdays: dayButtons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => Number(b.dataset.day)),
      monthly: m,
      times: [...timeList.querySelectorAll("input")].map((i) => i.value),
      start: start.value,
      ends: ends.value as Ends,
      endDate: endDate.value,
      count: count.value === "" ? NaN : Number(count.value),
      cron: cron.value,
      tz: draft.tz,
    };
  }

  /** Every field into the draft. */
  function readDraft(): ScheduleDraft {
    return { ...draft, mode: chosenMode(), date: date.value, time: time.value, rule: readRule() };
  }

  const fieldFor: Record<ScheduleField, () => HTMLElement> = {
    date: () => date,
    time: () => time,
    every: () => every,
    weekdays: () => dayButtons[0]!,
    times: () => [...timeList.querySelectorAll("input")].find((i) => !i.value) ?? timeList.querySelector("input")!,
    start: () => start,
    endDate: () => endDate,
    count: () => count,
    cron: () => cron,
  };

  function update(): void {
    draft = readDraft();
    const form = draft.rule;
    const repeat = draft.mode === "repeat";
    when.hidden = repeat;
    rule.hidden = !repeat;
    const f = form.frequency;
    everyField.hidden = f === "custom";
    days.hidden = f !== "weekly";
    monthly.hidden = f !== "monthly";
    times.hidden = f === "custom";
    custom.hidden = f !== "custom";
    if (f !== "custom") {
      const [one, many] = UNIT_WORDS[f];
      everyUnit.textContent = form.every === 1 ? one : many;
    }
    endDate.hidden = form.ends !== "on";
    count.hidden = countUnit.hidden = form.ends !== "after";
    clearWhen.hidden = !date.value && !time.value;
    tzName.textContent = draft.tz;

    // The custom cron in words as it is typed.
    const problem = f === "custom" && cron.value.trim() ? cronProblem(cron.value) : null;
    cron.setAttribute("aria-invalid", String(!!problem));
    cronText.textContent = f !== "custom" || !cron.value.trim() ? "" : problem ?? describeCron(cron.value, form.customInterval, { hour12 });
    cronText.dataset.tone = problem ? "bad" : "";

    const n = now();
    const badWhen = onceInstant(draft, n) === null;
    tell(whenHint, badWhen ? "Pick a date and a time" : "Empty: as soon as possible", badWhen ? "bad" : "");

    if (!repeat) return tell(firstRun, "", "");
    const built = formToRepeat({ ...form, tz: draft.tz });
    if (!built.ok) return tell(firstRun, built.error, "bad");
    const first = nextRun(built.repeat, n)?.toISOString();
    if (first) tell(firstRun, `First run: ${whenText(first, n.getTime(), { tz: draft.tz, hour12 })}`, "");
    else tell(firstRun, "This rule never runs: check its days, start and end", "bad");
  }

  /** A change to the rule: switching modes no longer restarts it from "Scheduled at". */
  function touched(): void {
    draft = { ...draft, ruleTouched: true };
    update();
  }

  // ---- events --------------------------------------------------------------

  for (const input of modeInputs) {
    input.addEventListener("change", () => {
      const before = draft.rule;
      draft = withMode(readDraft(), chosenMode(), now());
      if (draft.rule !== before) writeRule();
      update();
    });
  }
  for (const input of [date, time]) {
    input.addEventListener("input", () => {
      if (input === date && date.value && !time.value) time.value = "09:00";
      update();
    });
  }
  clearWhen.addEventListener("click", () => {
    date.value = time.value = "";
    update();
    date.focus();
  });
  for (const input of [every, byDay, byWeekday, ends, endDate, count, start]) {
    input.addEventListener(input instanceof HTMLSelectElement || input.type === "radio" ? "change" : "input", touched);
  }
  cron.addEventListener("input", () => {
    cronTouched = true;
    touched();
  });
  frequency.addEventListener("change", () => {
    // Custom starts from the rule chosen so far, in cron (unless a cron was typed already).
    if (frequency.value === "custom" && !cronTouched && draft.rule.frequency !== "custom") {
      const built = formToRepeat(draft.rule);
      if (built.ok) cron.value = built.repeat.cron;
    }
    touched();
  });
  // Picking a day of the month picks its way of saying it.
  monthDay.addEventListener("change", () => {
    byDay.checked = true;
    touched();
  });
  for (const s of [nth, nthDay]) {
    s.addEventListener("change", () => {
      byWeekday.checked = true;
      touched();
    });
  }
  for (const b of dayButtons) {
    b.addEventListener("click", () => {
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      touched();
    });
  }
  addTime.addEventListener("click", () => {
    const last = [...timeList.querySelectorAll("input")].at(-1)?.value ?? "09:00";
    const [h, m] = last.split(":").map(Number) as [number, number];
    const row = timeRow(`${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    timeList.append(row);
    renumberTimes();
    row.querySelector("input")!.focus();
    touched();
  });
  tzChange.addEventListener("click", () => {
    if (!tzSelect.options.length) for (const z of timeZones([draft.tz])) tzSelect.append(el("option", { value: z }, z));
    tzSelect.value = draft.tz;
    tzSelect.hidden = false;
    tzChange.hidden = tzName.hidden = true;
    tzSelect.focus();
  });
  tzSelect.addEventListener("change", () => {
    draft = { ...draft, tz: tzSelect.value };
    update();
  });

  // ---- API -------------------------------------------------------------------

  function set(value: ScheduleValue | null): void {
    draft = openSchedule(value, { tz: opts.timeZone ?? localTimeZone(), now: now() });
    tzSelect.hidden = true;
    tzChange.hidden = tzName.hidden = false;
    for (const input of modeInputs) input.checked = input.value === draft.mode;
    date.value = draft.date;
    time.value = draft.time;
    cronTouched = draft.rule.frequency === "custom";
    writeRule();
    update();
  }

  function read(): ScheduleRead {
    update();
    const saved = saveSchedule(draft, now());
    return saved.ok ? saved : { ok: false, error: saved.error, focus: fieldFor[saved.field]() };
  }

  set(opts.value ?? null);
  return { element, read, set };
}
