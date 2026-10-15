/** act on forms: dropdowns get their option, checkboxes are set (not toggled), and the page shows each field's state. */
import { describe, expect, it } from "vitest";
import { coveredText, INPUT_BLOCKED_TEXT, overlaidText, type BrowserMethod, type BrowserMethods, type ElementInfo, type PageSnapshot } from "@noa/shared";
import { runAct } from "../src/act.js";
import { formatSnapshot } from "../src/page-format.js";
import type { JevDecision, JevLike } from "../src/types.js";
import { fakeJev, noSleep } from "./helpers.js";

const el = (index: number, role: string, name: string, extra: Partial<ElementInfo> = {}): ElementInfo => ({ index, tag: "input", role, name, inViewport: true, ...extra });

/** The signup form of the benchmark, in the state a half-filled run leaves it. */
const FORM: PageSnapshot = {
  url: "http://localhost/w/form",
  title: "Create your account - Acme",
  text: "Create your Acme account",
  truncated: false,
  elements: [
    el(0, "textbox", "Job title", { type: "text", value: "Head of Research", required: true }),
    el(1, "combobox", "Country", { tag: "select", options: ["Australia", "United Kingdom"], required: true, invalid: "Please select an item in the list." }),
    el(2, "radio", "11-50", { type: "radio", value: "11-50", checked: false, required: true }),
    el(3, "checkbox", "I agree to the terms", { type: "checkbox", value: "yes", checked: true, required: true }),
    el(4, "button", "Create account", { tag: "button" }),
  ],
};

/** A browser that answers act's calls like a driver does, and records them. */
function browser() {
  const calls: [BrowserMethod, unknown][] = [];
  const call = async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> => {
    calls.push([method, params]);
    if (method === "browser.readPage") return FORM as never;
    if (method === "browser.type") return ((params as { index: number }).index === 1 ? { ok: true, selected: "United Kingdom" } : { ok: true }) as never;
    if (method === "browser.click") {
      const { index, checked } = params as { index: number; checked?: boolean };
      return (index === 2 || index === 3 ? { ok: true, checked: checked ?? true } : { ok: true }) as never;
    }
    return { ok: true } as never;
  };
  return { calls, call };
}

const ctx = (b: ReturnType<typeof browser>, jev: ReturnType<typeof fakeJev> | null = null) => ({
  browser: b.call,
  jev,
  jevThreshold: 0.8,
  sleep: noSleep,
  emit: () => {},
  outOfCredit: () => ({ text: "out of credit", isError: true }),
});

describe("act on a form", () => {
  it("text on a dropdown chooses its option; checked sets a checkbox or radio button; the result says what happened", async () => {
    const b = browser();
    const r = await runAct(
      [
        { goal: "country", index: 1, text: "United Kingdom" },
        { goal: "team size 11-50", index: 2, checked: true },
        { goal: "terms", index: 3, checked: true },
        { goal: "submit", index: 4 },
      ],
      ctx(b),
    );
    expect(b.calls.filter(([m]) => m !== "browser.readPage")).toEqual([
      ["browser.type", { index: 1, text: "United Kingdom", settleMs: 300 }],
      ["browser.click", { index: 2, checked: true, settleMs: 300 }],
      ["browser.click", { index: 3, checked: true, settleMs: 300 }],
      ["browser.click", { index: 4, settleMs: 500 }],
    ]);
    expect(r.text).toContain('step 1: chose "United Kingdom" in [1]');
    expect(r.text).toContain("step 2: checked [2]");
    expect(r.text).toContain("step 4: clicked [4]");
  });

  it("with Jev, a checked step is set on the element Jev picks, and the step line does not show the state from before it", async () => {
    const b = browser();
    const jev = fakeJev([{ operation: "click", index: 2, confidence: 0.99 }]);
    const r = await runAct([{ goal: "the 11-50 radio button", checked: true }], ctx(b, jev));
    expect(b.calls).toContainEqual(["browser.click", { index: 2, checked: true, settleMs: 300 }]);
    const step = r.text!.split("\n")[0]!;
    expect(step).toMatch(/^step 1: checked \[2\] radio "11-50" \(input, type=radio\) \(picked by Jev/);
  });

  it("a plain click on a checkbox reports its state afterwards", async () => {
    const b = browser();
    const r = await runAct([{ goal: "terms", index: 3 }], ctx(b));
    expect(r.text).toContain("step 1: clicked [3] (now checked)");
  });
});

describe("the page's field state", () => {
  it("lists value, options, checked or not, required and validation errors, with index numbers", () => {
    const text = formatSnapshot(FORM);
    expect(text).toContain('[0] textbox "Job title" (input, type=text, value="Head of Research", required)');
    expect(text).toContain('[1] combobox "Country" (select, options=["Australia","United Kingdom"], required, invalid: "Please select an item in the list.")');
    expect(text).toContain('[2] radio "11-50" (input, type=radio, value="11-50", not checked, required)');
    expect(text).toContain('[3] checkbox "I agree to the terms" (input, type=checkbox, value="yes", checked, required)');
  });

  it("and in words (Jev mode)", () => {
    const text = formatSnapshot(FORM, { words: true });
    expect(text).toContain('combobox "Country" (options=["Australia","United Kingdom"], required, invalid: "Please select an item in the list.")');
    expect(text).toContain('checkbox "I agree to the terms" (type=checkbox, value="yes", checked, required)');
  });

  it("identical checkboxes are listed apart when their states differ", () => {
    const boxes = [el(0, "checkbox", "Select", { type: "checkbox", checked: true }), el(1, "checkbox", "Select", { type: "checkbox", checked: false }), el(2, "checkbox", "Select", { type: "checkbox", checked: false })];
    const text = formatSnapshot({ ...FORM, elements: boxes }, { words: true });
    expect(text).toContain('checkbox "Select" (type=checkbox, checked)');
    expect(text).toContain('checkbox "Select" ×2 (type=checkbox, not checked)');
  });
});

describe("a step that presses a key", () => {
  // Measured on real sites (2026-10-09): "press Enter to submit" went to Jev, which answered press_key, and act gave the
  // step back to the model: one more model call each time.
  it("presses it at the focus in the same call, without asking Jev or naming an element", async () => {
    const b = browser();
    const jev = fakeJev([{ operation: "type", index: 0, confidence: 0.99 }]);
    const r = await runAct([{ goal: "the job title field", text: "CTO" }, { goal: "submit the form", key: "Enter" }], ctx(b, jev));
    expect(jev.goals).toEqual(["the job title field"]);
    expect(b.calls.filter(([m]) => m !== "browser.readPage")).toEqual([
      ["browser.type", { index: 0, text: "CTO", settleMs: 300 }],
      ["browser.pressKey", { key: "Enter", settleMs: 500 }],
    ]);
    expect(r.text).toContain("step 2: pressed Enter");
  });

  // Live (claims-live.mjs, enter page): an Enter meant to add a label submitted the whole form; the result said only
  // "pressed Enter", and the next step failed on a page the model had not seen.
  it("says on its line what the key did to the page (a form it submitted), before the next step runs", async () => {
    const DONE: PageSnapshot = { url: FORM.url, title: FORM.title, text: "Issue #12 created\nThanks, your issue was filed.", truncated: false, elements: [el(0, "link", "File another issue", { tag: "a" })] };
    let page = FORM;
    const b = browser();
    const call = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.readPage") return page;
      if (method === "browser.pressKey") page = DONE;
      return b.call(method, params);
    }) as typeof b.call;
    const jev = fakeJev([{ operation: "type", index: 0, confidence: 0.99 }]);
    const r = await runAct([{ goal: "the job title field", text: "CTO" }, { goal: "add the label", key: "Enter" }], { ...ctx(b, jev), browser: call });
    const line = r.text!.split("\n").find((l) => l.startsWith("step 2:"))!;
    expect(line).toMatch(/^step 2: pressed Enter; on the page, 5 element\(s\) went away \(textbox "Job title", combobox "Country", radio "11-50", checkbox "I agree to the terms", 1 more\); 1 appeared \(link "File another issue"\); new text: "Issue #12 created \/ Thanks, your issue was filed\."\. Typed but not shown on the page now: "Job title" "CTO"\. The page does not show these values back: they are entered, not confirmed\. Your answer may name these values or their fields only in a sentence that says they are not confirmed, e\.g\. "I entered X in Y, not confirmed: the page did not show it back\." This sent the form and the page now shows "Issue #12 created \/ Thanks, your issue was filed\.": count it as done/);
  });

  it("says when the key changed nothing", async () => {
    const b = browser();
    const r = await runAct([{ goal: "close the menu", key: "Escape" }], ctx(b, fakeJev([])));
    expect(r.text).toContain("step 1: pressed Escape; nothing on the page changed");
  });
});

describe("a call that ends with a click", () => {
  // Live (claims-live.mjs, noop page): Save sent nothing back and the page did not change, yet the result only listed
  // the field the call had typed into, which read as a save.
  it("says what the last click did apart from the steps before it: here nothing", async () => {
    let page = FORM;
    const b = browser();
    const call = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.readPage") return page;
      if (method === "browser.type") page = { ...FORM, elements: FORM.elements.map((e) => (e.index === 0 ? { ...e, value: "CTO" } : e)) };
      return b.call(method, params);
    }) as typeof b.call;
    const jev = fakeJev([
      { operation: "type", index: 0, confidence: 0.99 },
      { operation: "click", index: 4, confidence: 0.99 },
    ]);
    const r = await runAct([{ goal: "the job title field", text: "CTO" }, { goal: "the Create account button" }], { ...ctx(b, jev), browser: call });
    expect(r.text).toContain("All 2 step(s) done. Verify the result.\n\nAfter step 2, nothing on the page changed.\n");
    expect(r.text).toContain('Changed (1):\ntextbox "Job title" (type=text, value="CTO", required)');
  });

  // Live (claims-live.mjs, enter page): labels typed as text into a field that takes them one at a time with Enter
  // were reported as added; the confirmation after Submit showed none of them.
  it("names the typed values the page no longer shows after the click (a confirmation without the details, a capped value)", async () => {
    let page = FORM;
    const b = browser();
    const call = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.readPage") return page;
      if (method === "browser.type") page = { ...FORM, elements: FORM.elements.map((e) => (e.index === 0 ? { ...e, value: "Head of Research, CTO" } : e)) };
      if (method === "browser.click") page = { ...FORM, text: "Thanks! Head of Research saved", elements: [] };
      return b.call(method, params);
    }) as typeof b.call;
    const jev = fakeJev([
      { operation: "type", index: 0, confidence: 0.99 },
      { operation: "click", index: 4, confidence: 0.99 },
    ]);
    const r = await runAct([{ goal: "the job title field", text: "Head of Research, CTO" }, { goal: "the Create account button" }], { ...ctx(b, jev), browser: call });
    expect(r.text).toContain('Typed but not shown on the page now: "Job title" "Head of Research, CTO". The page does not show these values back: they are entered, not confirmed. Your answer may name these values');
  });

  it("never names what was typed into a password field (it is never shown back)", async () => {
    const LOGIN: PageSnapshot = { ...FORM, elements: [el(0, "textbox", "Password", { type: "password" }), el(1, "button", "Sign in", { tag: "button" })] };
    let page = LOGIN;
    const b = browser();
    const call = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.readPage") return page;
      if (method === "browser.click") page = { ...FORM, text: "Welcome back", elements: [] };
      return b.call(method, params);
    }) as typeof b.call;
    for (const jev of [fakeJev([{ operation: "type", index: 0, confidence: 0.99 }, { operation: "click", index: 1, confidence: 0.99 }]), null]) {
      page = LOGIN;
      const steps = jev ? [{ goal: "the password field", text: "hunter2-secret" }, { goal: "the Sign in button" }] : [{ goal: "password", index: 0, text: "hunter2-secret" }, { goal: "sign in", index: 1 }];
      const r = await runAct(steps, { ...ctx(b, jev), browser: call });
      expect(r.text).toContain("Welcome back");
      expect(r.text).not.toContain("hunter2-secret");
    }
  });

  it("names nothing when the typed values are still on the page", async () => {
    let page = FORM;
    const b = browser();
    const call = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.readPage") return page;
      if (method === "browser.type") page = { ...FORM, elements: FORM.elements.map((e) => (e.index === 0 ? { ...e, value: "CTO" } : e)) };
      return b.call(method, params);
    }) as typeof b.call;
    const r = await runAct([{ goal: "the job title field", text: "CTO" }, { goal: "the Create account button" }], { ...ctx(b, fakeJev([{ operation: "type", index: 0, confidence: 0.99 }, { operation: "click", index: 4, confidence: 0.99 }])), browser: call });
    expect(r.text).not.toContain("not shown on the page now");
  });

  // A read numbers the elements anew: before an index step it could make the model's index name another element.
  it("a click picked by index is never preceded by a page read, so it gets no effect line of its own", async () => {
    let page = FORM;
    const b = browser();
    const call = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.readPage") return page;
      if (method === "browser.click") page = { ...FORM, text: `${FORM.text}\nSettings saved` };
      return b.call(method, params);
    }) as typeof b.call;
    const r = await runAct([{ goal: "submit", index: 4 }], { ...ctx(b), browser: call });
    expect(b.calls[0]![0]).toBe("browser.click");
    expect(r.text).not.toContain("After step 1");
    expect(r.text).toContain("Settings saved");
  });

  it("a key step reads the page only when no later step names an index", async () => {
    const b = browser();
    await runAct([{ goal: "submit", key: "Enter" }, { goal: "terms", index: 3, checked: true }], ctx(b));
    expect(b.calls.slice(0, 2).map(([m]) => m)).toEqual(["browser.pressKey", "browser.click"]);
  });
});

describe("a click the page never received", () => {
  it("ends the batch with the reason (no candidates to pick again): a Chrome dialog holds the tab's input", async () => {
    const b = browser();
    const call = b.call;
    const blocked = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.click") throw new Error(INPUT_BLOCKED_TEXT);
      return call(method, params);
    }) as typeof b.call;
    const jev = fakeJev([{ operation: "click", index: 4, confidence: 1 }]);
    const r = await runAct([{ goal: "the Create account button" }, { goal: "the terms box", checked: true }], { ...ctx(b, jev), browser: blocked });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("step 1:");
    expect(r.text).toContain("task_pause");
    expect(r.text).toContain("Steps 2-2 were not run.");
    expect(r.text).not.toMatch(/candidate/i);
  });
});

describe("an element behind an open modal dialog", () => {
  it("read_page marks it in both lists, apart from a look-alike in the dialog", () => {
    const page = {
      ...FORM,
      elements: [el(0, "textbox", "Email", { type: "email", covered: true }), el(1, "button", "Save", { tag: "button", covered: true }), el(2, "textbox", "Email", { type: "email", inDialog: true })],
    };
    expect(formatSnapshot(page)).toContain('[1] button "Save" (button, behind the open dialog)');
    const words = formatSnapshot(page, { words: true });
    expect(words).toContain('textbox "Email" (type=email, behind the open dialog)');
    expect(words).toContain('textbox "Email" (type=email, in dialog)');
  });

  it("ends the batch with the reason (no candidates to pick again): the step meant that element, and the dialog is in the way", async () => {
    const b = browser();
    const call = b.call;
    const covered = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.click") throw new Error(coveredText((params as { index: number }).index, "Add billing contact"));
      return call(method, params);
    }) as typeof b.call;
    const jev = fakeJev([{ operation: "click", index: 4, confidence: 1 }]);
    const r = await runAct([{ goal: "the Create account button" }, { goal: "the terms box", checked: true }], { ...ctx(b, jev), browser: covered });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('step 1: "the Create account button": element 4 is behind the open dialog "Add billing contact"');
    expect(r.text).toContain("Steps 2-2 were not run.");
    expect(r.text).not.toMatch(/candidate/i);
  });

  it("so does an element something else covers (an open suggestion list): the click would have picked from the list", async () => {
    const b = browser();
    const call = b.call;
    const over = { over: 'the list "Address suggestions"', lands: 'option "41 Harbor Rd"', list: true };
    const covered = (async (method: BrowserMethod, params: never) => {
      if (method === "browser.click") throw new Error(overlaidText((params as { index: number }).index, over));
      return call(method, params);
    }) as typeof b.call;
    const jev = fakeJev([{ operation: "click", index: 4, confidence: 1 }]);
    const r = await runAct([{ goal: "the Create account button" }, { goal: "the terms box", checked: true }], { ...ctx(b, jev), browser: covered });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`step 1: "the Create account button": ${overlaidText(4, over)}`);
    expect(r.text).toContain("Steps 2-2 were not run.");
    expect(r.text).not.toMatch(/candidate/i);
  });
});


describe("a text field that suggests values as you type", () => {
  /** FORM with a suggestion of field 0 shown (an option element), and a browser whose typing into field 0 leaves its suggestions unchosen. */
  const SUGGESTING: PageSnapshot = { ...FORM, elements: [...FORM.elements, el(5, "option", "London Gatwick (LGW)", { tag: "li" })] };
  function suggesting(b: ReturnType<typeof browser>) {
    return (async (method: BrowserMethod, params: never) => {
      if (method === "browser.readPage") return SUGGESTING;
      if (method === "browser.type" && (params as { index: number }).index === 0) {
        b.calls.push([method, params]);
        return { ok: true, suggestions: ["London City (LCY)", "London Gatwick (LGW)"] };
      }
      return b.call(method, params);
    }) as typeof b.call;
  }

  it("its suggestions, none of them the typed text, are listed in the step line (Jev reads it for the next step)", async () => {
    const b = browser();
    const previous: (string | undefined)[] = [];
    const jev = fakeJev([
      { operation: "type", index: 0, confidence: 1 },
      { operation: "click", index: 5, confidence: 1 },
    ]);
    const decide = jev.decide.bind(jev);
    jev.decide = (input) => (previous.push(input.previousStep), decide(input));
    const r = await runAct([{ goal: "the airport field", text: "London" }, { goal: "the London Gatwick suggestion" }], { ...ctx(b, jev), browser: suggesting(b) });
    const step = r.text!.split("\n")[0]!;
    expect(step).toMatch(/^step 1: typed 6 characters into \[0\] .*; it suggests "London City \(LCY\)", "London Gatwick \(LGW\)", none of them exactly the text, so none was chosen/);
    expect(previous[1]).toBe(step);
    // Picking one of the suggestions runs.
    expect(b.calls).toContainEqual(["browser.click", { index: 5, settleMs: 500 }]);
    expect(r.text).toContain("All 2 step(s) done.");
  });

  it("while none is chosen, a later click on anything but a suggestion is not run: the model decides; typing elsewhere still runs", async () => {
    const b = browser();
    const jev = fakeJev([
      { operation: "type", index: 0, confidence: 1 },
      { operation: "type", index: 1, confidence: 1 },
      { operation: "click", index: 4, confidence: 1 },
    ]);
    const r = await runAct(
      [{ goal: "the airport field", text: "London" }, { goal: "the country dropdown", text: "United Kingdom" }, { goal: "the Create account button" }],
      { ...ctx(b, jev), browser: suggesting(b) },
    );
    expect(b.calls.filter(([m]) => m !== "browser.readPage")).toEqual([
      ["browser.type", { index: 0, text: "London", settleMs: 300 }],
      ["browser.type", { index: 1, text: "United Kingdom", settleMs: 300 }],
    ]);
    expect(r.text).toContain('Stopped before step 3 ("the Create account button"): the field of step 1 shows suggestions and none of them was chosen');
    expect(r.isError).toBeUndefined();
  });

  it("a field whose suggestion was chosen holds nothing back", async () => {
    const b = browser();
    const chose = (async (method: BrowserMethod, params: never) =>
      method === "browser.type" && (params as { index: number }).index === 0 ? { ok: true, selected: "London Gatwick (LGW)" } : b.call(method, params)) as typeof b.call;
    const jev = fakeJev([
      { operation: "type", index: 0, confidence: 1 },
      { operation: "click", index: 4, confidence: 1 },
    ]);
    const r = await runAct([{ goal: "the airport field", text: "London Gatwick (LGW)" }, { goal: "the Create account button" }], { ...ctx(b, jev), browser: chose });
    expect(r.text).toContain('step 1: chose "London Gatwick (LGW)" in [0]');
    expect(b.calls).toContainEqual(["browser.click", { index: 4, settleMs: 500 }]);
  });
});

describe("a page with nothing on it yet", () => {
  // Live (2026-10-12): a slow site read with 0 elements; Jev was asked anyway and its "unsure (0.63)" hid the cause.
  it("is not given to Jev: the step stops saying the page is still loading", async () => {
    const empty: PageSnapshot = { url: "https://slow.test/", title: "Slow", text: "", elements: [], truncated: false };
    const jev = fakeJev([{ operation: "click", index: null, confidence: 0.63 }]);
    const events: unknown[] = [];
    const r = await runAct([{ goal: "the Dropdown link" }, { goal: "choose Option 2", text: "Option 2" }], {
      ...ctx(browser(), jev),
      browser: (async (m: BrowserMethod) => (m === "browser.readPage" ? empty : { ok: true })) as never,
      emit: (e: unknown) => events.push(e),
    });
    expect(jev.goals).toEqual([]);
    expect(events).toEqual([]);
    expect(r.text).toContain('step 1: "the Dropdown link": the page has no elements yet (still loading or empty), so nothing was picked. Steps 2-2 were not run.');
  });
});

describe("a step with empty text empties the field", () => {
  /** A Jev that records what it was asked and answers `d`. */
  const askingJev = (d: JevDecision) => {
    const asked: Parameters<JevLike["decide"]>[0][] = [];
    const jev: JevLike = {
      async decide(input) {
        asked.push(input);
        return d;
      },
    };
    return { asked, jev };
  };

  // Live (2026-10-13): {goal: "clear the Search orders search box", text: ""} went to Jev as a click step; Jev was
  // unsure (click / press_key, 0.32-0.36), and the index the model then picked was clicked and reported done with the
  // text still in the box. The agent fell back to Control+A and Delete.
  it("Jev is told the step empties a field, picks it, and the driver types the empty text into it", async () => {
    const b = browser();
    const { asked, jev } = askingJev({ operation: "click", index: 0, confidence: 0.95 });
    const r = await runAct([{ goal: "the Job title field", text: "" }], { ...ctx(b), jev });
    expect(asked[0]).toMatchObject({ goal: "the Job title field", typesText: true, emptiesField: true });
    expect(b.calls.filter(([m]) => m !== "browser.readPage")).toEqual([["browser.type", { index: 0, text: "", settleMs: 300 }]]);
    expect(r.text).toMatch(/^step 1: cleared \[0\] textbox "Job title" .*\(picked by Jev, 0\.95/);
  });

  it("a step that types text is not marked as emptying", async () => {
    const { asked, jev } = askingJev({ operation: "type", index: 0, confidence: 0.95 });
    await runAct([{ goal: "the Job title field", text: "CTO" }], { ...ctx(browser()), jev });
    expect(asked[0]!.typesText).toBe(true);
    expect(asked[0]!.emptiesField).toBeUndefined();
  });

  it("with an index (Jev off, or a candidate the model picked), the element is emptied, not clicked", async () => {
    const b = browser();
    const r = await runAct([{ goal: "the Job title field", index: 0, text: "" }], ctx(b));
    expect(b.calls.filter(([m]) => m !== "browser.readPage")).toEqual([["browser.type", { index: 0, text: "", settleMs: 300 }]]);
    expect(r.text).toContain("step 1: cleared [0] (picked by Claude)");
  });

  it("when Jev is unsure, the candidates' example keeps the text, so the step comes back as an emptying step", async () => {
    const jev = fakeJev([{ operation: "type", index: 0, confidence: 0.4, ranked: [0, 4] }]);
    const r = await runAct([{ goal: "the Job title field", text: "" }], ctx(browser(), jev));
    expect(r.text).toContain('e.g. {goal: "the Job title field", index: <n>, text: ...}');
  });
});
