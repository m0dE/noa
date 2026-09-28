/**
 * Regression (user report 2026-09-28): with $0.67 of credit left, a Noa AI run on Opus 5.5 was refused by the
 * API's credit hold (402: then "too low for this request") and the side panel said
 * "You're out of usage credit." with the job "Needs you · Out of usage credit", while the balance was not zero.
 * The body below is what apps/api answers in that case (apps/api/test/low-credit-402.test.ts): with the credit
 * left and about what the request needed.
 */
import { describe, expect, it, vi } from "vitest";
import * as core from "@noa/core";
import { DEFAULT_SETTINGS, type AgentEvent } from "@noa/shared";
import { ApiBrain } from "../src/engine/api-brain.js";
import { hostedBackend } from "../src/engine/hosted-brain.js";
import { errorHelp } from "../src/sidepanel/error-help.js";
import { fakeMessagesServer } from "../../../packages/core/test/helpers.js";

const LOW_CREDIT_402 = {
  error: "out_of_credit",
  message: "Not enough usage credit for this request: $0.67 left, it needs about $0.80.",
  topupUrl: "https://app.noa.bot/#/billing",
  balanceCents: 67,
  neededCents: 80,
};
const EMPTY_402 = {
  error: "out_of_credit",
  message: "You are out of Noa usage credit. Buy a top-up or upgrade your plan to continue.",
  topupUrl: "https://app.noa.bot/#/billing",
};

async function refusedRun(body: object = LOW_CREDIT_402) {
  const s = fakeMessagesServer([{ status: 402, body }]);
  const events: AgentEvent[] = [];
  const onOutOfCredit = vi.fn();
  const b = new ApiBrain({
    core,
    browser: { call: vi.fn() as never },
    fetch: s.fetchImpl,
    backend: hostedBackend({ core, session: () => ({ token: "bt_s_tok", apiBase: "https://api.test" }), onOutOfCredit, fetch: s.fetchImpl }),
  });
  const result = await b
    .start({
      sessionId: "sess-jeju",
      task: { id: "t", instructions: "Find Jeju island invoice in Stripe", account: null },
      mediaPaths: [],
      config: { maxToolCalls: 10, maxTaskMinutes: 5, jevEnabled: false, jevThreshold: 0.8, isRetry: false },
      settings: { ...DEFAULT_SETTINGS, anthropicModel: "claude-opus-5-5" },
      onEvent: (e) => events.push(e),
    })
    .done;
  const error = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
  return { result, errorText: error?.text ?? "", onOutOfCredit };
}

describe("402 'too low for this request' while credit is left", () => {
  it("does not tell the user they are out of credit", async () => {
    const { result, errorText } = await refusedRun();
    const help = errorHelp(errorText);
    console.log(`run result: ${JSON.stringify(result)}\nerror event: ${errorText}\ncard: ${help?.message} ${help?.hint}`);
    expect(help?.message).not.toBe("You're out of usage credit.");
    expect(result).not.toEqual({ outcome: "paused", reason: "Out of usage credit" });
  });

  it("says how much is left and about how much the request needed, and pauses with 'Not enough usage credit'", async () => {
    const { result, errorText, onOutOfCredit } = await refusedRun();
    expect(errorText).toBe("Not enough usage credit for this request ($0.67 left; about $0.80 needed)");
    expect(errorHelp(errorText)).toMatchObject({
      message: "Not enough usage credit for this request ($0.67 left; about $0.80 needed).",
      hint: "Top up, or use your own Claude.",
    });
    expect(result).toEqual({ outcome: "paused", reason: "Not enough usage credit" });
    // Not flagged as an empty balance: the background fetches the credit again instead.
    expect(onOutOfCredit).toHaveBeenCalledWith({ balanceCents: 67, neededCents: 80 });
  });

  it("an empty balance still reads as out of credit", async () => {
    const { result, errorText, onOutOfCredit } = await refusedRun(EMPTY_402);
    expect(errorHelp(errorText)?.message).toBe("You're out of usage credit.");
    expect(result).toEqual({ outcome: "paused", reason: "Out of usage credit" });
    expect(onOutOfCredit).toHaveBeenCalledWith(undefined);
  });
});
