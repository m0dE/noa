/** act when the user does not approve a step (the extension's approval gate refuses it): final, no retry offered. */
import { describe, expect, it } from "vitest";
import { approvalRefusalText, type BrowserMethod, type BrowserMethods, type PageSnapshot } from "@noa/shared";
import { NOT_CONFIDENT, runAct } from "../src/act.js";
import { fakeJev, noSleep } from "./helpers.js";

const PAGE: PageSnapshot = {
  url: "https://x.com/home",
  title: "Home / X",
  text: "What is happening?!",
  truncated: false,
  elements: [
    { index: 7, tag: "div", role: "textbox", name: "Post text", inViewport: true },
    { index: 8, tag: "button", role: "button", name: "Post", testId: "tweetButtonInline", inViewport: true },
  ],
};

function browser(refuse: (method: BrowserMethod, params: unknown) => boolean) {
  const calls: [BrowserMethod, unknown][] = [];
  const call = async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> => {
    calls.push([method, params]);
    if (refuse(method, params)) throw new Error(approvalRefusalText("deny", 'Click "Post"'));
    if (method === "browser.readPage") return PAGE as never;
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

const refusePost = (method: BrowserMethod, params: unknown) => method === "browser.click" && (params as { index: number }).index === 8;

describe("act and a refused step", () => {
  it("an index step the user denied ends the call: the refusal, no candidates, the rest not run", async () => {
    const b = browser(refusePost);
    const r = await runAct([{ goal: "type the post", index: 7, text: "Hello" }, { goal: "click Post", index: 8 }, { goal: "close", index: 7 }], ctx(b));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^step 1: typed 5 characters into \[7\]/);
    expect(r.text).toContain('step 2: "click Post": Not done: the user did not approve this action.');
    expect(r.text).toContain("Steps 3-3 were not run.");
    expect(r.text).not.toContain(NOT_CONFIDENT);
    expect(r.text).not.toContain("Candidates");
    // Nothing after the refused click: no third step, no page read to offer candidates.
    expect(b.calls.map(([m]) => m)).toEqual(["browser.type", "browser.click"]);
  });

  it("the same with Jev picking the element", async () => {
    const b = browser(refusePost);
    const jev = fakeJev([{ operation: "click", index: 8, confidence: 0.99 }]);
    const r = await runAct([{ goal: "click the Post button" }], ctx(b, jev));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Don't retry it");
    expect(r.text).not.toContain("Candidates");
  });
});
