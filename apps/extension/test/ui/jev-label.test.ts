/**
 * The chat's Jev badge after the approval gate held the click Jev picked (owner's production run, 2026-09-28):
 * Jev picked the Post button at 1.00, the gate paused it for the user's OK, and the chat said
 * "Jev unsure (1.00) · Claude decides". Jev was sure; the click was not approved.
 */
import { describe, expect, it } from "vitest";
import { approvalRefusalText, type AgentEvent, type BrowserMethod, type PageSnapshot } from "@noa/shared";
import { runAct } from "../../../../packages/core/src/act.js";
import { describeEvent } from "../../src/sidepanel/event-format.js";

const PAGE: PageSnapshot = {
  url: "https://x.com/home",
  title: "Home / X",
  text: "What is happening?!",
  truncated: false,
  elements: [{ index: 8, tag: "button", role: "button", name: "Post", testId: "tweetButtonInline", inViewport: true }],
};

async function jevEventWhenClickFails(error: string): Promise<AgentEvent> {
  const events: AgentEvent[] = [];
  await runAct([{ goal: "click the Post button in the home composer (testid tweetButtonInline), below the Post text box" }], {
    browser: (async (method: BrowserMethod) => {
      if (method === "browser.click") throw new Error(error);
      return (method === "browser.readPage" ? PAGE : { ok: true }) as never;
    }) as never,
    jev: { decide: async () => ({ operation: "click", index: 8, confidence: 1 }) } as never,
    jevThreshold: 0.8,
    sleep: async () => {},
    emit: (e: AgentEvent) => events.push(e),
    outOfCredit: () => ({ text: "out of credit", isError: true }),
  } as never);
  return events.find((e) => e.type === "jev")!;
}

describe("Jev's badge says what happened", () => {
  it("Jev sure (1.00), the click paused for the user's OK: not 'unsure', and not 'Claude decides'", async () => {
    const ev = await jevEventWhenClickFails(approvalRefusalText("paused", 'Click "Post"'));
    const v = describeEvent(ev);
    expect(v.kind).toBe("jev");
    if (v.kind !== "jev") return;
    expect(v.label).not.toMatch(/unsure/);
    expect(v.label).toBe("Jev: click #8 · 1.00 · not approved");
    expect(v.title).not.toContain("not confident");
  });

  it("Jev sure, the click failed: says it failed", async () => {
    const v = describeEvent(await jevEventWhenClickFails("element is detached"));
    expect(v).toMatchObject({ kind: "jev", label: "Jev: click #8 · 1.00 · failed", executed: false });
  });
});
