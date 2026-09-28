/**
 * The Raw view of a job's conversation (its "⋯" menu's Raw): the whole
 * conversation as it happened, with how long everything took, for finding
 * bottlenecks. On top a summary (total time, time to the first response,
 * model / tool / voice time, the slowest items, tokens); below, each turn's
 * timeline with times relative to its start (+0.00 s) and durations, slow
 * items marked (SLOW_MS). Copy gives it as text, Download .json as the
 * structured export for the developer; both are redacted
 * (trace/trace-report.ts). While the conversation runs, the view refreshes.
 */
import { errorMessage } from "@noa/shared";
import { uiRequest, type RawTrace } from "../ui-protocol.js";
import { buildReport, durationText, exportJson, redactDeep, relText, reportText, summaryLines, turnTitle, type ReportEnv, type TraceReport, type TraceRow } from "../trace/trace-report.js";
import { copyText, h } from "../ui/dom.js";

/** While the conversation shown runs, the view is rebuilt at most this often. */
export const RAW_REFRESH_MS = 1500;
/** "Copied" / "Downloaded" stays this long on its button. */
const DONE_MS = 1500;

export interface RawViewDeps {
  /** What the panel knows about voice (engine, models, voice), for the export. */
  voiceEnv(): ReportEnv["voice"];
  /** Back to chat. */
  onBack(): void;
}

export interface RawView {
  /** Shows conversation `sessionId` (loads it). */
  open(sessionId: string): void;
  close(): void;
  readonly shown: string | null;
  /** An event of a conversation arrived: the one shown is reloaded soon. */
  touched(sessionId: string): void;
}

export function initRawView(host: HTMLElement, deps: RawViewDeps): RawView {
  let shown: string | null = null;
  let data: RawTrace | null = null;
  let report: TraceReport | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Loads in flight: only the newest one renders. */
  let loads = 0;

  const back = h("button.link.raw-back", { type: "button", title: "Back to the conversation" }, "‹ Back to chat");
  const copyBtn = h("button.ghost.small.raw-copy", { type: "button", title: "Copy the timeline as text (secrets redacted)", disabled: true }, "Copy");
  const saveBtn = h("button.ghost.small.raw-save", { type: "button", title: "Download the full trace as JSON, to send to the developer (secrets redacted)", disabled: true }, "Download .json");
  const body = h("div.raw-body.scroll", { "aria-live": "off" });
  host.replaceChildren(h("div.raw-bar", null, back, h("span.spacer"), copyBtn, saveBtn), body);

  back.addEventListener("click", () => deps.onBack());
  copyBtn.addEventListener("click", () => {
    const text = currentText();
    if (text === null) return;
    void copyText(text, host).then((ok) => done(copyBtn, ok ? "Copied" : "Copy failed"));
  });
  saveBtn.addEventListener("click", () => {
    if (!data || !report) return;
    const json = JSON.stringify(exportJson(report, data.session, env(data)), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = h("a", { href: url, download: fileName(data) });
    host.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    done(saveBtn, "Downloaded");
  });

  function env(d: RawTrace): ReportEnv {
    const voice = deps.voiceEnv();
    return { ...d.env, ...(voice ? { voice } : {}) };
  }

  function currentText(): string | null {
    return data && report ? reportText(report, data.session, env(data)) : null;
  }

  function done(btn: HTMLButtonElement, label: string): void {
    const was = btn.dataset.label ?? btn.textContent ?? "";
    btn.dataset.label = was;
    btn.textContent = label;
    setTimeout(() => (btn.textContent = btn.dataset.label ?? was), DONE_MS);
  }

  async function load(sessionId: string): Promise<void> {
    const n = ++loads;
    try {
      const d = await uiRequest({ type: "trace.get", sessionId });
      if (n !== loads || shown !== sessionId) return;
      data = d;
      // Redacted on screen too: what is shown is what gets copied or downloaded.
      report = redactDeep(buildReport({ session: d.session, events: d.events, trace: d.trace }));
      render(report, d);
    } catch (err) {
      if (n !== loads || shown !== sessionId) return;
      body.replaceChildren(h("p.msg", { "data-tone": "bad" }, `The trace couldn't be loaded: ${errorMessage(err)}`));
    }
  }

  function render(r: TraceReport, d: RawTrace): void {
    const top = body.scrollTop;
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    copyBtn.disabled = false;
    saveBtn.disabled = false;
    body.replaceChildren(renderSummary(r, d), ...r.turns.map(renderTurn));
    body.scrollTop = follow && top > 0 ? body.scrollHeight : top;
  }

  return {
    open(sessionId) {
      shown = sessionId;
      // Voice details may need loading (the export reads them later).
      deps.voiceEnv();
      data = null;
      report = null;
      copyBtn.disabled = true;
      saveBtn.disabled = true;
      body.replaceChildren(h("p.empty", null, "Loading…"));
      body.scrollTop = 0;
      void load(sessionId);
    },
    close() {
      shown = null;
      loads++;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get shown() {
      return shown;
    },
    touched(sessionId) {
      if (sessionId !== shown || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (shown) void load(shown);
      }, RAW_REFRESH_MS);
    },
  };
}

/** noa-trace-<first 8 of the session>-<yyyymmdd-hhmm>.json */
function fileName(d: RawTrace): string {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `noa-trace-${d.session.sessionId.slice(0, 8)}-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}.json`;
}

function renderSummary(r: TraceReport, d: RawTrace): HTMLElement {
  const s = r.summary;
  const tiles = summaryLines(s).map((l) => h("div.raw-stat", { title: l.about }, h("span.raw-stat-label", null, l.label), h("span.raw-stat-value", null, l.value), h("span.raw-stat-hint", null, l.hint)));
  const notes: HTMLElement[] = [];
  if (!s.traced) notes.push(h("p.raw-note", null, "This conversation is from before timings were recorded: only its events' times are shown."));
  if (s.dropped) notes.push(h("p.raw-note", null, `${s.dropped} older timing events were left out (the totals still count them).`));
  const meta = [d.session.brain, d.session.model, d.session.jev ? "Jev on" : "Jev off", d.env.helper ? `helper ${d.env.helper.version}` : null, d.env.extensionVersion ? `extension ${d.env.extensionVersion}` : null]
    .filter(Boolean)
    .join(" · ");
  return h(
    "section.raw-summary",
    { "aria-label": "Summary" },
    h("p.raw-meta", null, meta),
    h("div.raw-stats", null, ...tiles),
    ...notes,
    s.slowest.length
      ? h(
          "div.raw-slowest",
          null,
          h("p.raw-slowest-title", null, "Slowest"),
          h("ol", null, ...s.slowest.map((x) => h("li", null, h("span.raw-dur.mono", null, durationText(x.ms)), h("span.raw-slowest-label", null, x.label), h("span.raw-slowest-where", null, `turn ${x.turn} · ${relText(x.rel)}`)))),
        )
      : null,
  );
}

function renderTurn(t: TraceReport["turns"][number]): HTMLElement {
  const title = turnTitle(t).replace(/^TURN/, "Turn");
  return h("section.raw-turn", { "data-turn": String(t.turn) }, h("h3.raw-turn-title", null, title), h("ol.raw-rows", null, ...t.rows.map(renderRow)));
}

function renderRow(r: TraceRow): HTMLElement {
  const cls = ["li.raw-row", r.kind, r.slow ? "slow" : "", r.error ? "error" : ""].filter(Boolean).join(".");
  const dur = r.ms === undefined ? "" : durationText(r.ms);
  const title = r.slow ? "Slow" : r.wait !== undefined ? `Waited ${durationText(r.wait)}` : "";
  return h(
    cls as "li",
    { "data-name": r.name, ...(title ? { title } : {}) },
    h("span.raw-rel.mono", null, relText(r.rel)),
    h(
      "span.raw-main",
      null,
      h("span.raw-label", null, r.label),
      r.detail ? h("span.raw-detail.mono", null, r.detail) : null,
      r.text ? h("span.raw-text", null, r.text) : null,
    ),
    h("span.raw-dur.mono", null, dur),
  );
}
