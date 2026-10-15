/**
 * What the agent may claim at the end: task_complete quotes back typed values the page never showed after the submit,
 * and act says when the same click keeps changing nothing (live: claims-live.mjs).
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent, BrowserMethod, ElementInfo, PageSnapshot, TaskRunResult } from "@noa/shared";
import { createToolExecutor, MAX_UNCONFIRMED_REFUSALS } from "../src/executor.js";
import { unacknowledgedValues } from "../src/page-format.js";
import type { BrowserCaller } from "../src/types.js";
import { fakeJev, noSleep } from "./helpers.js";

const el = (index: number, role: string, name: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({ index, tag: "input", role, name, inViewport: true, ...extra });

/** A form with a Labels field and a Submit button. submits: the page after Submit is a confirmation without the values; else nothing changes. */
function site(submits: boolean) {
  const form = (labels = ""): PageSnapshot => ({
    url: "http://t.test/new",
    title: "New issue",
    text: "New issue",
    truncated: false,
    elements: [el(0, "textbox", "Labels", { type: "text", ...(labels ? { value: labels } : {}) }), el(1, "button", "Submit issue", { tag: "button" })],
  });
  let page = form();
  const clicks: number[] = [];
  let issue = 12;
  const sent = () => ({ ...page, text: `Issue #${issue++} created`, elements: [el(0, "link", "File another issue", { tag: "a" })] });
  const browser = (async (method: BrowserMethod, params: { index?: number; text?: string; key?: string }) => {
    if (method === "browser.readPage") return page;
    if (method === "browser.type") page = form(params.text);
    if (method === "browser.click") {
      clicks.push(params.index!);
      if (submits && params.index === 1) page = sent();
    }
    if (method === "browser.pressKey" && submits && params.key === "Enter") page = sent();
    if (method === "browser.navigate") page = form();
    // The confirmation's text, found where it is (already in view).
    if (method === "browser.findText") {
      const hit = page.text.includes(params.text ?? "");
      const places = hit ? [{ number: 1, context: page.text, matches: 1, inViewport: true, controls: [] }] : [];
      return { total: places.length, placeCount: places.length, places, scrolledTo: null };
    }
    return { ok: true };
  });
  return { browser: { call: browser } as unknown as BrowserCaller, clicks };
}

/** Jev mode (the default): the picker finds the element named in the goal ("labels", "submit", "file another"). */
const jev = () =>
  fakeJev((goal, snap) => {
    const g = goal.toLowerCase();
    const name = g.includes("submit") ? "Submit issue" : g.includes("another") ? "File another issue" : "Labels";
    const target = snap.elements.find((e) => e.name === name);
    return target ? { operation: g.includes("labels") && !g.includes("click") ? "type" : "click", index: target.index, confidence: 0.99 } : { operation: "blocked", index: null, confidence: 0.1 };
  });

function setup(submits: boolean) {
  const s = site(submits);
  const ended: TaskRunResult[] = [];
  const exec = createToolExecutor({ browser: s.browser, jev: jev(), jevThreshold: 0.8, onEvent: () => {}, onTaskEnd: (r) => void ended.push(r), mediaPaths: [], sleep: noSleep });
  return { exec, ended, ...s };
}

const fillAndSubmit = [{ goal: "labels", text: "billing, urgent" }, { goal: "submit" }];

describe("task_complete and values the page never showed back", () => {
  it("is refused while its summary states them as done, quoting the sentences; a corrected one is recorded", async () => {
    const { exec, ended } = setup(true);
    const r = await exec.call("act", { steps: fillAndSubmit });
    expect(r.text).toContain('Typed but not shown on the page now: "Labels" "billing, urgent".');
    expect(r.text).toContain("Your answer may name these values or their fields only in a sentence that says they are not confirmed");
    const first = await exec.call("task_complete", { summary: "Filed issue #12 with labels billing and urgent", spoken: "Filed it with both labels." });
    expect(first.isError).toBe(true);
    expect(first.text).toContain('The page did not confirm these values you typed (after they were sent, the page did not show them): "Labels" "billing, urgent"');
    expect(first.text).toContain('and does not say they are not confirmed, in: "Filed issue #12 with labels billing and urgent", "Filed it with both labels."');
    expect(ended).toEqual([]);
    // Live (enter page, main): the second call kept "I filed the bug report with both labels" in its spoken line and
    // was recorded. It is checked again.
    const second = await exec.call("task_complete", { summary: "Filed issue #12; labels billing and urgent entered but not confirmed", spoken: "Filed it with both labels." });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('in: "Filed it with both labels."');
    const third = await exec.call("task_complete", { summary: "Filed issue #12; labels billing and urgent entered but not confirmed", spoken: "Filed it; the page never confirmed the labels." });
    expect(third.isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });

  it("is not held without end: after MAX_UNCONFIRMED_REFUSALS refusals the next call is recorded", async () => {
    const { exec, ended } = setup(true);
    await exec.call("act", { steps: fillAndSubmit });
    for (let i = 0; i < MAX_UNCONFIRMED_REFUSALS; i++) expect((await exec.call("task_complete", { summary: "Filed issue #12 with both labels" })).isError).toBe(true);
    expect((await exec.call("task_complete", { summary: "Filed issue #12 with both labels" })).isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });

  // Live (noop page, main): an honest first answer naming the field was refused, costing a turn.
  it("is recorded at once when each sentence naming them says they are not confirmed", async () => {
    const { exec, ended } = setup(false);
    await exec.call("act", { steps: fillAndSubmit });
    const honest = [
      "I entered billing, urgent in Labels and clicked Submit, but the page showed no confirmation that it saved.",
      "The labels billing and urgent are entered, not confirmed: the page did not show them back.",
      "I typed both labels, but couldn't verify they were stored.",
      "Labels: billing, urgent (unconfirmed).",
      "I entered the labels billing, urgent; the page did not show them back.",
      "The labels were not saved as far as the page shows; it never confirmed them.",
    ];
    for (const summary of honest) expect(unacknowledgedValues(summary, [{ field: "Labels", text: "billing, urgent" }]), summary).toEqual([]);
    const r = await exec.call("task_complete", { summary: honest[0], spoken: "I entered both labels; nothing on the page confirmed they were saved." });
    expect(r.isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });

  it("counts values typed in an earlier act call when the click that sends them comes in the next one", async () => {
    const { exec, ended } = setup(true);
    await exec.call("act", { steps: [fillAndSubmit[0]!] });
    const r = await exec.call("act", { steps: [fillAndSubmit[1]!] });
    expect(r.text).toContain('Typed but not shown on the page now: "Labels" "billing, urgent".');
    const first = await exec.call("task_complete", { summary: "Filed it with labels billing and urgent" });
    expect(first.isError).toBe(true);
    expect(ended).toEqual([]);
  });

  it("counts pasted text, and a click into a text field neither sends the values nor counts as changing nothing", async () => {
    const { exec, clicks } = setup(true);
    for (let i = 0; i < 3; i++) {
      const r = await exec.call("act", { steps: [{ goal: "click into the labels" }] });
      expect(r.isError).toBeFalsy();
      expect(r.text).not.toContain("After step 1");
    }
    await exec.call("paste", { text: "billing, urgent" });
    const r = await exec.call("act", { steps: [fillAndSubmit[1]!] });
    expect(r.text).toContain('Typed but not shown on the page now: "billing, urgent".');
    expect((await exec.call("task_complete", { summary: "Filed with labels billing and urgent" })).isError).toBe(true);
    expect(clicks).toEqual([0, 0, 0, 1]);
  });

  // Live (v4, enter page): the issue was sent, a later click opened a new form, and the summary said "with both
  // labels"; the later click had cleared what the send left unconfirmed, and the field's name was not matched.
  it("keeps what a send left unconfirmed past later clicks, and matches a summary that names the field", async () => {
    const { exec } = setup(true);
    await exec.call("act", { steps: fillAndSubmit });
    await exec.call("act", { steps: [{ goal: "file another" }] });
    const r = await exec.call("task_complete", { summary: "Filed issue #12 with both labels" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"Labels" "billing, urgent"');
  });

  it("an Enter that sends the form counts as a send", async () => {
    const { exec } = setup(true);
    await exec.call("act", { steps: [fillAndSubmit[0]!] });
    const r = await exec.call("act", { steps: [{ goal: "submit", key: "Enter" }] });
    expect(r.text).toContain('new text: "Issue #12 created". Typed but not shown on the page now: "Labels" "billing, urgent".');
    expect((await exec.call("task_complete", { summary: "Filed with labels billing, urgent" })).isError).toBe(true);
  });

  it("press_key Enter counts as a send too (what act and paste typed before it)", async () => {
    const { exec } = setup(true);
    await exec.call("paste", { text: "billing, urgent" });
    const r = await exec.call("press_key", { key: "Enter" });
    expect(r.text).toContain('Typed but not shown on the page now: "billing, urgent".');
    expect((await exec.call("task_complete", { summary: "Filed with labels billing, urgent" })).isError).toBe(true);
  });

  // Each sentence is read on its own: one that says something else was not confirmed, or a negation that is not about
  // confirming, does not cover a claim.
  it("a sentence that claims them is refused even next to one that says they are not confirmed", () => {
    const labels = [{ field: "Labels", text: "billing, urgent" }];
    const claims = [
      "Filed #12 with both labels. The title was not confirmed.",
      "Saved the labels billing and urgent, no errors shown.",
      "I saved the labels billing and urgent and the page showed them. No confirmation came for the title.",
      "Filed with billing, urgent — no problems.",
      "Done: labels billing, urgent are set\nThe page did not confirm the title.",
    ];
    for (const text of claims) expect(unacknowledgedValues(text, labels).map((b) => b.value), text).toEqual(labels);
  });

  // The answer, the summary and the spoken line are each read (or heard) on their own: each that names the values says
  // in one of its sentences naming them that they are not confirmed.
  it("an answer that names them and says, with them, that they are not confirmed is recorded; each part on its own", async () => {
    const labels = [{ field: "Labels", text: "billing, urgent" }];
    expect(unacknowledgedValues("Filed #12 with both labels. The page did not show the labels back, so they are entered, not confirmed.", labels)).toEqual([]);
    expect(unacknowledgedValues("Placed it. The page didn't show the labels, title or due date back.", labels)).toEqual([]);
    const { exec, ended } = setup(true);
    await exec.call("act", { steps: fillAndSubmit });
    exec.noteText!({ type: "assistant_text", id: "m1:0", text: "Filed #12. I typed the labels billing, urgent; the page never showed them back." });
    const r = await exec.call("task_complete", { summary: "Filed #12; labels entered, not confirmed", spoken: "Filed it with both labels." });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('in: "Filed it with both labels."');
    exec.noteText!({ type: "assistant_text", id: "m2:0", text: "Filed #12. I typed the labels billing, urgent; the page never showed them back." });
    expect((await exec.call("task_complete", { summary: "Filed #12; labels entered, not confirmed", spoken: "Filed it; the labels were not confirmed." })).isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });

  // Live (enter, dropdowns): the answer said the values were not confirmed, the spoken line did not. Rewriting the whole
  // answer for that costs a long turn: it is shown, and only the summary and spoken line are asked for again.
  it("a call refused only for its summary or spoken line shows the answer and does not ask for it again", async () => {
    const events: AgentEvent[] = [];
    const s = site(true);
    const exec = createToolExecutor({ browser: s.browser, jev: jev(), jevThreshold: 0.8, onEvent: (e) => void events.push(e), onTaskEnd: () => {}, mediaPaths: [], sleep: noSleep });
    const shown = () => events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    await exec.call("act", { steps: fillAndSubmit });
    const answer = "Filed #12. I typed the labels billing, urgent, but the page did not show them back: entered, not confirmed.";
    expect(exec.noteText!({ type: "assistant_text", id: "m1:0", text: answer })).toBe(true);
    const r = await exec.call("task_complete", { summary: "Filed #12 with both labels" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("The answer you wrote was shown to the user and stands: do not write it again.");
    expect(shown()).toEqual([answer]);
    // No answer written again: not refused for that.
    expect((await exec.call("task_complete", { summary: "Filed #12; labels entered, not confirmed" })).isError).toBeFalsy();
  });

  // Live (enter, dropdowns): refused once with the answer dropped, then once for the summary only (the new answer
  // kept); the third call, with no answer written again, was refused for "no answer" although the user had one.
  it("after a dropped answer and then a kept one, the next call is not refused for having no answer", async () => {
    const { exec, ended } = setup(true);
    await exec.call("act", { steps: fillAndSubmit });
    exec.noteText!({ type: "assistant_text", id: "m1:0", text: "Filed #12 with both labels." });
    expect((await exec.call("task_complete", { summary: "Filed #12" })).text).toContain("The answer you wrote was not shown to the user");
    exec.noteText!({ type: "assistant_text", id: "m2:0", text: "Filed #12. The labels billing, urgent are entered, not confirmed." });
    expect((await exec.call("task_complete", { summary: "Filed #12 with both labels" })).text).toContain("was shown to the user and stands");
    const r = await exec.call("task_complete", { summary: "Filed #12; title, description and labels entered, none confirmed back by the page" });
    expect(r.isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });

  // Live (enter page): answers talk about "the Labels field" (what Enter did in it) without stating what it holds.
  it("a field named as the control (\"the Labels field\") is not a statement of its value; \"with both labels\" is", () => {
    const labels = [{ field: "Labels", text: "billing, urgent" }];
    expect(unacknowledgedValues("Pressing Enter in the Labels field submitted the whole form.", labels)).toEqual([]);
    expect(unacknowledgedValues("The labels box sent the form early, so issue #12 was made.", labels)).toEqual([]);
    expect(unacknowledgedValues("Issue #12 has both labels.", labels).map((b) => b.sentences)).toEqual([["Issue #12 has both labels."]]);
    expect(unacknowledgedValues("The Labels field now has both labels.", labels)).toHaveLength(1);
  });

  // Live (dropdowns page): the answer listed the values under one line that said the page did not show them back.
  it("a list is read with the line that introduces it", () => {
    const values = [
      { field: "Plan", text: "Pro Plus" },
      { field: "Department", text: "Engineering" },
    ];
    const honest = "Order K-1 was placed. The page did not show these values back, so they are entered, not confirmed:\n- Plan: Pro Plus\n- Department: Engineering";
    expect(unacknowledgedValues(honest, values)).toEqual([]);
    const claimed = "Order K-1 was placed with:\n- Plan: Pro Plus\n- Department: Engineering\nThe page did not confirm the values.";
    expect(unacknowledgedValues(claimed, values)).toHaveLength(2);
  });

  it("is recorded at once when the summary does not state them", async () => {
    const { exec, ended } = setup(true);
    await exec.call("act", { steps: fillAndSubmit });
    const r = await exec.call("task_complete", { summary: "Filed issue #12" });
    expect(r.isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });
});

describe("the same click changing nothing again", () => {
  it("says on the second time to stop trying it and report it", async () => {
    const { exec, clicks } = setup(false);
    const first = await exec.call("act", { steps: fillAndSubmit });
    expect(first.text).toContain("After step 2, nothing on the page changed.");
    expect(first.text).toContain('Nothing on the page confirms these values were saved: "Labels" "billing, urgent". Until a page shows them saved, they are entered, not confirmed. Your answer may name these values');
    expect(first.text).not.toContain("Do not click it again");
    await exec.call("navigate", { url: "http://t.test/new" });
    const second = await exec.call("act", { steps: fillAndSubmit });
    expect(second.text).toContain('Clicking button "Submit issue" has now changed nothing on the page 2 times. Do not click it again');
    expect(clicks).toEqual([1, 1]);
    // A third try is not run: the steps before it are, the click is not.
    const third = await exec.call("act", { steps: fillAndSubmit });
    expect(third.isError).toBe(true);
    expect(third.text).toContain('step 2: not clicked: clicking button "Submit issue" already changed nothing on this page 2 times.');
    expect(clicks).toEqual([1, 1]);
  });

  it("an Enter that changes nothing on a page whose send click is spent says to report it", async () => {
    const { exec } = setup(false);
    await exec.call("act", { steps: fillAndSubmit });
    expect((await exec.call("press_key", { key: "Enter" })).text).toBe("Pressed Enter; nothing on the page changed.");
    await exec.call("act", { steps: fillAndSubmit });
    expect((await exec.call("press_key", { key: "Enter" })).text).toContain("Pressed Enter; nothing on the page changed. Sending this page has now shown no result several times: report that");
  });

  it("a save whose click changed nothing: task_complete stating the typed value is quoted back once", async () => {
    const { exec, ended } = setup(false);
    await exec.call("act", { steps: fillAndSubmit });
    const first = await exec.call("task_complete", { summary: "Saved the labels billing, urgent" });
    expect(first.isError).toBe(true);
    expect(first.text).toContain('(after the step that sent them, nothing on the page changed): "Labels" "billing, urgent"');
    await exec.call("task_complete", { summary: "Entered the labels; the page showed no confirmation" });
    expect(ended).toHaveLength(1);
  });
});

describe("the answer the user reads", () => {
  // Live (v5, enter page): the summary was rewritten after the refusal, but the answer text above it still said the
  // labels were filed.
  it("task_complete checks the answer text written since the last browser action, not only the summary", async () => {
    const { exec, ended } = setup(true);
    expect(exec.noteText!({ type: "assistant_text", text: "I'll fill the form with labels billing, urgent." })).toBe(false);
    await exec.call("act", { steps: fillAndSubmit });
    // The send left values unconfirmed: the answer is held back until task_complete decides.
    expect(exec.noteText!({ type: "assistant_text_delta", id: "m:0", text: "Filed #12 with labels " })).toBe(true);
    expect(exec.noteText!({ type: "assistant_text_delta", id: "m:0", text: "billing, urgent." })).toBe(true);
    const r = await exec.call("task_complete", { summary: "Filed issue #12" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"Labels" "billing, urgent", yet your answer, summary or spoken line names them or their fields and does not say they are not confirmed, in: "Filed #12 with labels billing, urgent."');
    expect(r.text).toContain("The answer you wrote was not shown to the user: write it again in full");
    expect(ended).toEqual([]);
  });

  // Live (v5, v6): a refused answer stayed in the chat above its correction. Now it is never shown.
  it("a refused answer is dropped, never shown; an accepted one is shown before the task_complete call", async () => {
    const events: AgentEvent[] = [];
    const s = site(true);
    const exec = createToolExecutor({ browser: s.browser, jev: jev(), jevThreshold: 0.8, onEvent: (e) => void events.push(e), onTaskEnd: () => {}, mediaPaths: [], sleep: noSleep });
    const shown = () => events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    await exec.call("act", { steps: fillAndSubmit });
    exec.noteText!({ type: "assistant_text", id: "m1:0", text: "Filed #12 with labels billing, urgent." });
    expect((await exec.call("task_complete", { summary: "Filed #12" })).isError).toBe(true);
    expect(shown()).toEqual([]);
    // Called again with no answer written: refused once more.
    const again = await exec.call("task_complete", { summary: "Filed #12; labels entered, not confirmed" });
    expect(again.text).toContain("the user has no answer from you");
    // Nothing is unconfirmed any more: the new answer is shown at once.
    expect(exec.noteText!({ type: "assistant_text", id: "m2:0", text: "Filed #12. I entered the labels billing, urgent; the page did not show them back." })).toBe(false);
    expect((await exec.call("task_complete", { summary: "Filed #12; labels entered, not confirmed" })).isError).toBeFalsy();
    expect(shown()).toEqual([]);
  });

  // find_text (from main) is a look, not an action: the text before it is shown when it is called, its result comes
  // through, and the answer written after it is still held and checked.
  it("an answer written after find_text is still held and checked; find_text's result comes through", async () => {
    const events: AgentEvent[] = [];
    const s = site(true);
    const exec = createToolExecutor({ browser: s.browser, jev: jev(), jevThreshold: 0.8, onEvent: (e) => void events.push(e), onTaskEnd: () => {}, mediaPaths: [], sleep: noSleep });
    await exec.call("act", { steps: fillAndSubmit });
    expect(exec.noteText!({ type: "assistant_text", id: "m1:0", text: "Let me find the confirmation." })).toBe(true);
    const found = await exec.call("find_text", { text: "Issue #12" });
    expect(found.text).toContain("Issue #12 created");
    expect(events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text)).toEqual(["Let me find the confirmation."]);
    expect(exec.noteText!({ type: "assistant_text", id: "m2:0", text: "Filed #12 with labels billing, urgent." })).toBe(true);
    const r = await exec.call("task_complete", { summary: "Filed #12" });
    expect(r.isError).toBe(true);
    expect(events.filter((e) => e.type === "assistant_text")).toHaveLength(1);
  });

  it("held text is shown when the next tool call comes (or flushText), in order, before that call", async () => {
    const events: AgentEvent[] = [];
    const s = site(true);
    const exec = createToolExecutor({ browser: s.browser, jev: jev(), jevThreshold: 0.8, onEvent: (e) => void events.push(e), onTaskEnd: () => {}, mediaPaths: [], sleep: noSleep });
    await exec.call("act", { steps: fillAndSubmit });
    exec.noteText!({ type: "assistant_text", id: "m1:0", text: "Let me check the page." });
    const before = events.length;
    await exec.call("read_page", {});
    expect(events.slice(before, before + 2).map((e) => e.type)).toEqual(["assistant_text", "tool_call"]);
    exec.noteText!({ type: "assistant_text", id: "m2:0", text: "Still checking." });
    exec.flushText!();
    expect(events.at(-1)).toEqual({ type: "assistant_text", id: "m2:0", text: "Still checking." });
  });

  it("text written before the last browser action is not checked", async () => {
    const { exec, ended } = setup(true);
    exec.noteText!({ type: "assistant_text", text: "Next I'll add the labels billing, urgent." });
    await exec.call("act", { steps: fillAndSubmit });
    expect((await exec.call("task_complete", { summary: "Filed issue #12" })).isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });
});

describe("a form that already made something", () => {
  it("says the send made something, holds a second send of that form once, then lets it through", async () => {
    const { exec, clicks } = setup(true);
    const first = await exec.call("act", { steps: fillAndSubmit });
    expect(first.text).toContain('This sent the form and the page now shows "Issue #12 created": count it as done');
    await exec.call("navigate", { url: "http://t.test/new" });
    const held = await exec.call("act", { steps: fillAndSubmit });
    expect(held.isError).toBe(true);
    expect(held.text).toContain('step 2: Not sent: this form was already sent in this task, and the page showed "Issue #12 created".');
    expect(clicks).toEqual([1]);
    const again = await exec.call("act", { steps: [fillAndSubmit[1]!] });
    expect(again.text).toContain('"Issue #13 created"');
    expect(again.text).toContain("this task has now sent it 2 times");
    expect(clicks).toEqual([1, 1]);
  });

  it("an Enter that would send it again is held too", async () => {
    const { exec } = setup(true);
    await exec.call("act", { steps: fillAndSubmit });
    await exec.call("navigate", { url: "http://t.test/new" });
    expect((await exec.call("press_key", { key: "Enter" })).text).toContain("Not sent: this form was already sent");
  });

  it("task_complete wants each thing a repeated form made named in the answer", async () => {
    const { exec, ended } = setup(true);
    await exec.call("act", { steps: [fillAndSubmit[1]!] });
    await exec.call("navigate", { url: "http://t.test/new" });
    await exec.call("act", { steps: [fillAndSubmit[1]!] });
    await exec.call("act", { steps: [fillAndSubmit[1]!] });
    exec.noteText!({ type: "assistant_text", text: "Filed issue #13." });
    const r = await exec.call("task_complete", { summary: "Filed issue #13" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('This task sent a form 2 times and each made something: "Issue #12 created", "Issue #13 created". Your answer does not name "Issue #12 created".');
    exec.noteText!({ type: "assistant_text", text: "Filed #13; #12 was made too, by an early send." });
    expect((await exec.call("task_complete", { summary: "Filed #13 (and #12 by accident)" })).isError).toBeFalsy();
    expect(ended).toHaveLength(1);
  });
});
