/** act on forms: dropdowns get their option, checkboxes are set (not toggled), and the page shows each field's state. */
import { describe, expect, it } from "vitest";
import type { BrowserMethod, BrowserMethods, ElementInfo, PageSnapshot } from "@noa/shared";
import { runAct } from "../src/act.js";
import { formatSnapshot } from "../src/page-format.js";
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
      ["browser.type", { index: 1, text: "United Kingdom" }],
      ["browser.click", { index: 2, checked: true }],
      ["browser.click", { index: 3, checked: true }],
      ["browser.click", { index: 4 }],
    ]);
    expect(r.text).toContain('step 1: chose "United Kingdom" in [1]');
    expect(r.text).toContain("step 2: checked [2]");
    expect(r.text).toContain("step 4: clicked [4]");
  });

  it("with Jev, a checked step is set on the element Jev picks, and the step line does not show the state from before it", async () => {
    const b = browser();
    const jev = fakeJev([{ operation: "click", index: 2, confidence: 0.99 }]);
    const r = await runAct([{ goal: "the 11-50 radio button", checked: true }], ctx(b, jev));
    expect(b.calls).toContainEqual(["browser.click", { index: 2, checked: true }]);
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
