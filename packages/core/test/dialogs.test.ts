/** A page's JavaScript dialogs, as the agent meets them: act stopping on one, handle_dialog, and the prompt's rule. */
import { describe, expect, it } from "vitest";
import { dialogOpenText, toolsFor, type BrowserMethod, type BrowserMethods, type JsDialog, type PageSnapshot } from "@noa/shared";
import { buildSystemPrompt, createToolExecutor } from "../src/index.js";
import type { BrowserCaller } from "../src/types.js";
import { collect, noSleep } from "./helpers.js";

const CONFIRM: JsDialog = { type: "confirm", message: "Delete “Report Q3”?", url: "https://reports.test/list" };
const LEAVE: JsDialog = { type: "beforeunload", message: "", url: "https://docs.test/editor" };
const PAGE: PageSnapshot = {
  url: "https://reports.test/list",
  title: "Reports",
  text: "Reports",
  elements: [
    { index: 1, tag: "button", role: "button", name: "Clean up", inViewport: true },
    { index: 2, tag: "button", role: "button", name: "Export", inViewport: true },
  ],
  truncated: false,
};

/** A browser whose page opens `dialog` when [1] is clicked; the page is frozen until handleDialog answers it. */
function frozenOnClick(dialog: JsDialog) {
  const calls: { method: BrowserMethod; params: unknown }[] = [];
  let open: JsDialog | null = null;
  const browser: BrowserCaller = {
    call: async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => {
      calls.push({ method, params });
      if (method === "browser.handleDialog") {
        const p = params as BrowserMethods["browser.handleDialog"]["params"];
        const d = open;
        if (!d) throw new Error("No browser dialog is open in t1.");
        open = null;
        return { tab: "t1", dialog: d, accepted: p.accept } as BrowserMethods[M]["result"];
      }
      if (open) throw new Error(dialogOpenText(open));
      if (method === "browser.click" && (params as { index: number }).index === 1) {
        open = dialog;
        throw new Error(dialogOpenText(dialog));
      }
      if (method === "browser.readPage") return PAGE as BrowserMethods[M]["result"];
      if (method === "browser.navigate") {
        open = dialog;
        throw new Error(dialogOpenText(dialog));
      }
      return { ok: true } as BrowserMethods[M]["result"];
    },
  };
  return { browser, calls, methods: () => calls.map((c) => c.method) };
}

function setup(browser: BrowserCaller) {
  const { events, onEvent } = collect();
  const exec = createToolExecutor({ browser, jev: null, jevThreshold: 0.8, onEvent, mediaPaths: [], sleep: noSleep });
  return { exec, events };
}

describe("act meets a dialog", () => {
  it("stops at the step that opened it, says what the dialog asks, and runs nothing after it (not even a read of the frozen page)", async () => {
    const b = frozenOnClick(CONFIRM);
    const { exec } = setup(b.browser);
    const r = await exec.call("act", { steps: [{ goal: "click Clean up", index: 1 }, { goal: "click Export", index: 2 }] });
    expect(r.text).toBe(`step 1: "click Clean up": ${dialogOpenText(CONFIRM)} Steps 2-2 were not run.`);
    expect(b.methods()).toEqual(["browser.click"]);
  });
});

describe("handle_dialog", () => {
  it("answers the dialog and says which button it pressed on what", async () => {
    const b = frozenOnClick(CONFIRM);
    const { exec } = setup(b.browser);
    await exec.call("act", { steps: [{ goal: "click Clean up", index: 1 }] });
    const r = await exec.call("handle_dialog", { accept: false });
    expect(b.calls.at(-1)).toEqual({ method: "browser.handleDialog", params: { accept: false } });
    expect(r).toEqual({ text: "Pressed Cancel on the confirm “Delete “Report Q3”?” in t1. Read the page to see what it did." });
    expect((await exec.call("read_page", {})).isError).toBeUndefined();
  });

  it('on "Leave site?" says whether the page was left or kept', async () => {
    const b = frozenOnClick(LEAVE);
    const { exec } = setup(b.browser);
    const nav = await exec.call("navigate", { url: "https://docs.test/other" });
    expect(nav).toEqual({ text: `navigate failed: ${dialogOpenText(LEAVE)}`, isError: true });
    expect((await exec.call("handle_dialog", { accept: false, tab: "t1" })).text).toBe(
      "Pressed Cancel on the beforeunload “Leave site? Changes you made may not be saved.” in t1. Stayed on the page: nothing was navigated or closed, and its unsaved changes are still there.",
    );
    expect(b.calls.at(-1)).toEqual({ method: "browser.handleDialog", params: { accept: false, tab: "t1" } });
    await exec.call("navigate", { url: "https://docs.test/other" });
    expect((await exec.call("handle_dialog", { accept: true })).text).toMatch(/^Pressed Leave on the beforeunload .* Left the page: the navigation or tab close goes on\./);
  });

  it("with none open, the error says so", async () => {
    const { exec } = setup(frozenOnClick(CONFIRM).browser);
    expect(await exec.call("handle_dialog", { accept: true })).toEqual({ text: "handle_dialog failed: No browser dialog is open in t1.", isError: true });
  });
});

describe("the prompt", () => {
  it("offers handle_dialog, with how to answer dialogs safely", () => {
    const tools = toolsFor();
    expect(tools).toContain("handle_dialog");
    const prompt = buildSystemPrompt({ tools, jev: false });
    expect(prompt).toContain("- handle_dialog: Answer the browser dialog");
    expect(prompt).toMatch(/Prefer Cancel \(accept false\)\. On "Leave site\?", stay when the page holds changes that are not saved yet/);
    expect(prompt).toMatch(/Never press OK on a confirm that deletes, sends, pays or discards anything the task does not ask for/);
    expect(buildSystemPrompt({ tools: tools.filter((t) => t !== "handle_dialog"), jev: false })).not.toContain("freezes its page");
  });
});
