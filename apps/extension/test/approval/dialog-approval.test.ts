/** Answers to a page's JavaScript dialogs through the approval gate: which wait for the user, and what the card says. */
import { describe, expect, it } from "vitest";
import { approvalRefusalText, type ApprovalOutcome, type ApprovalRequest, type BrowserMethod, type EffectiveLevel, type JsDialog } from "@noa/shared";
import type { BrowserCaller } from "@noa/core";
import type { ApprovalRequestOptions } from "../../src/approval/broker.js";
import { classifyByRules, LEAVE_PAGE_WHY, type GateAction } from "../../src/approval/consequence.js";
import { ApprovalGate, describeAction, type GateContext } from "../../src/approval/gate.js";

const LEAVE: JsDialog = { type: "beforeunload", message: "", url: "https://docs.test/editor" };
const DELETE: JsDialog = { type: "confirm", message: "Delete this item?", url: "https://shop.test/orders" };
const VAGUE: JsDialog = { type: "confirm", message: "Are you sure?", url: "https://shop.test/orders" };
const ALERT: JsDialog = { type: "alert", message: "Saved!", url: "https://shop.test/" };
const NAME: JsDialog = { type: "prompt", message: "Name the copy", url: "https://docs.test/", defaultPrompt: "Copy" };

const answer = (dialog: JsDialog | undefined, accept: boolean, text?: string): GateAction => ({
  method: "handleDialog",
  page: { url: "", title: "" },
  typed: [],
  accept,
  ...(dialog ? { dialog } : {}),
  ...(text ? { text } : {}),
});

describe("the rules on a dialog's answer", () => {
  it("Cancel, and OK on an alert, change nothing", () => {
    for (const d of [LEAVE, DELETE, ALERT, NAME]) expect(classifyByRules(answer(d, false)).verdict).toBe("benign");
    expect(classifyByRules(answer(ALERT, true)).verdict).toBe("benign");
  });

  it('Leave on "Leave site?" always asks: what the page did not save is lost', () => {
    expect(classifyByRules(answer(LEAVE, true))).toEqual({ verdict: "unsure", reason: LEAVE_PAGE_WHY });
  });

  it("OK on a confirm is judged by its words, like a button's; words that say nothing still ask", () => {
    expect(classifyByRules(answer(DELETE, true))).toEqual({ verdict: "consequential", kind: "delete", reason: 'the dialog says "delete"' });
    expect(classifyByRules(answer({ ...DELETE, message: "Send this email to 12 people?" }, true))).toMatchObject({ verdict: "consequential", kind: "send" });
    expect(classifyByRules(answer({ ...DELETE, message: "Pay $40 now?" }, true))).toMatchObject({ verdict: "consequential", kind: "pay" });
    expect(classifyByRules(answer(VAGUE, true)).verdict).toBe("unsure");
    expect(classifyByRules(answer(NAME, true, "Q3")).verdict).toBe("unsure");
  });

  it("the card says it plainly", () => {
    expect(describeAction(answer(LEAVE, true))).toBe("Leave the page");
    expect(describeAction(answer(LEAVE, false))).toBe("Stay on the page");
    expect(describeAction(answer(DELETE, true))).toBe("Confirm “Delete this item?”");
    expect(describeAction(answer(NAME, true, "Q3"))).toBe("Answer “Name the copy”");
    expect(describeAction(answer(ALERT, true))).toBe("Close “Saved!”");
  });
});

/** A gate whose tab has `dialog` open, at `level`; records what was asked and what ran. */
function setup(dialog: JsDialog | null, level: EffectiveLevel, o: { answer?: ApprovalOutcome; context?: Partial<GateContext> } = {}) {
  const ran: BrowserMethod[] = [];
  const asked: { ask: Omit<ApprovalRequest, "id" | "expiresAt">; opts?: ApprovalRequestOptions }[] = [];
  const paused: string[] = [];
  const browser: BrowserCaller = {
    call: async (method) => {
      // As the driver: no dialog, nothing to answer.
      if (!dialog) throw new Error("No browser dialog is open in t1.");
      ran.push(method);
      return { tab: "t1", dialog, accepted: true } as never;
    },
  };
  const gate = new ApprovalGate(
    browser,
    () => "s1",
    {
      context: async () => ({ level, pause: (r: string) => void paused.push(r), ...o.context }),
      request: async (_s, ask, opts) => {
        asked.push({ ask, ...(opts ? { opts } : {}) });
        return o.answer ?? "allow_once";
      },
    },
    undefined,
    async () => dialog,
  );
  return { call: gate.browser.call, ran, asked, paused };
}

describe("ApprovalGate on handle_dialog", () => {
  it('ask_consequential: Leave on "Leave site?" waits for the user, on the page\'s site; Stay does not', async () => {
    const t = setup(LEAVE, "ask_consequential");
    await t.call("browser.handleDialog", { accept: false });
    expect(t.asked).toEqual([]);
    await t.call("browser.handleDialog", { accept: true });
    expect(t.asked.map((a) => a.ask)).toEqual([{ action: "Leave the page", site: "docs.test", why: LEAVE_PAGE_WHY }]);
    expect(t.ran).toEqual(["browser.handleDialog", "browser.handleDialog"]);
  });

  it("a confirm that deletes asks with what the page says; the user's No leaves the dialog unanswered", async () => {
    const t = setup(DELETE, "ask_consequential", { answer: "deny" });
    await expect(t.call("browser.handleDialog", { accept: true })).rejects.toThrow(approvalRefusalText("deny", "Confirm “Delete this item?”"));
    expect(t.asked.map((a) => a.ask)).toEqual([{ action: "Confirm “Delete this item?”", site: "shop.test", why: "deletes", kind: "delete" }]);
    expect(t.ran).toEqual([]);
  });

  it("an alert's OK and any Cancel never wait, even when every action asks", async () => {
    const t = setup(ALERT, "ask_all");
    await t.call("browser.handleDialog", { accept: true });
    const u = setup(DELETE, "ask_all");
    await u.call("browser.handleDialog", { accept: false });
    expect([...t.asked, ...u.asked]).toEqual([]);
    expect([...t.ran, ...u.ran]).toEqual(["browser.handleDialog", "browser.handleDialog"]);
  });

  it("a prompt's OK shows the text it sends", async () => {
    const t = setup(NAME, "ask_all");
    await t.call("browser.handleDialog", { accept: true, text: "Q3 numbers" });
    expect(t.asked[0]?.ask).toMatchObject({ action: "Answer “Name the copy”", text: "Q3 numbers" });
  });

  it("full autonomy: nothing waits", async () => {
    const t = setup(LEAVE, "full");
    await t.call("browser.handleDialog", { accept: true });
    expect(t.asked).toEqual([]);
  });

  it("a scheduled run nobody watches pauses for the user's OK instead of leaving the page on its own", async () => {
    const t = setup(LEAVE, "full_within_task", { answer: "paused", context: { instructions: "Check the draft in the editor and summarize it" } });
    await expect(t.call("browser.handleDialog", { accept: true })).rejects.toThrow(approvalRefusalText("paused", "Leave the page"));
    expect(t.asked[0]?.opts?.unattended).toBe(true);
    expect(t.paused).toEqual([`Needs your OK to: Leave the page (${LEAVE_PAGE_WHY}; the task does not ask for this) — open to allow`]);
    expect(t.ran).toEqual([]);
  });

  it("a scheduled task that asks to delete may confirm the page's delete on its own site", async () => {
    const t = setup(DELETE, "full_within_task", { context: { instructions: "Delete the cancelled orders on shop.test" } });
    await t.call("browser.handleDialog", { accept: true });
    expect(t.asked).toEqual([]);
    expect(t.ran).toEqual(["browser.handleDialog"]);
  });

  it("with no dialog open there is nothing to approve: the call goes on and says so", async () => {
    const t = setup(null, "ask_consequential");
    await expect(t.call("browser.handleDialog", { accept: true })).rejects.toThrow("No browser dialog is open in t1.");
    expect(t.asked).toEqual([]);
  });
});
