import { describe, expect, it } from "vitest";
import { accountSummary, dateLabel, keysLockedText } from "../../src/options/account-view.js";
import type { AccountView } from "../../src/ui-protocol.js";

const base: AccountView = { signedIn: true, signInConfigured: true, apiBase: "https://api.test", dashboardUrl: "https://api.test/", billingUrl: "https://api.test/billing", user: { email: "a@b.c", name: null, pictureUrl: null } };

describe("options: account summary", () => {
  it("free plan without billing on the server", () => {
    const s = accountSummary({
      ...base,
      plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false },
      credit: { subscriptionCents: 0, topupCents: 0, totalCents: 0, periodGrantCents: 0, periodEnd: null },
      stripeConfigured: false,
    });
    expect(s).toMatchObject({ planName: "Free", planStatus: "", credit: "$0.00", creditDetail: "$0.00 top-up", paid: false, keysAllowed: false, billingLabel: "Choose a plan", billing: "not-set-up" });
    // What Free lacks, from the plan catalog: the TODO list first.
    expect(s.planIncludes).toBe("");
  });

  it("paid plan: renewal date, subscription credit with its expiry plus top-up, keys allowed", () => {
    const s = accountSummary({
      ...base,
      plan: { id: "plus", status: "active", currentPeriodEnd: "2026-10-24T00:00:00Z", cancelAtPeriodEnd: false },
      credit: { subscriptionCents: 1540, topupCents: 1000, totalCents: 2540, periodGrantCents: 2000, periodEnd: "2026-10-24T00:00:00Z" },
      stripeConfigured: true,
    });
    expect(s).toMatchObject({
      planName: "Plus",
      planStatus: "Renews Oct 24, 2026",
      credit: "$25.40",
      creditDetail: "$15.40 subscription (expires Oct 24, 2026) + $10.00 top-up",
      paid: true,
      keysAllowed: true,
      billingLabel: "Manage plan & billing",
      billing: "ready",
      planIncludes: "Includes TODO list, voice input and API access",
    });
    expect(accountSummary({ ...base, plan: { id: "pro", status: "active", currentPeriodEnd: "2026-10-24T00:00:00Z", cancelAtPeriodEnd: true } }).planStatus).toBe("Ends Oct 24, 2026");
    expect(accountSummary({ ...base, plan: { id: "starter", status: "past_due", currentPeriodEnd: null, cancelAtPeriodEnd: false } })).toMatchObject({ planStatus: "Payment overdue", paid: true, keysAllowed: true });
    expect(accountSummary({ ...base, plan: { id: "free", status: "canceled", currentPeriodEnd: null, cancelAtPeriodEnd: false } })).toMatchObject({ planName: "Free", planStatus: "Subscription ended", paid: false, keysAllowed: false });
  });

  it("unknown billing and out of credit", () => {
    expect(accountSummary(base)).toMatchObject({ billing: "unknown", credit: "", planName: "Free", planIncludes: "" });
    expect(accountSummary({ ...base, outOfCredit: true })).toMatchObject({ outOfCredit: true, billingLabel: "Choose a plan" });
    const plus = { id: "plus", status: "active", currentPeriodEnd: "2026-10-24T00:00:00Z", cancelAtPeriodEnd: false } as const;
    expect(accountSummary({ ...base, plan: plus, outOfCredit: true }).billingLabel).toBe("Top up or change plan");
  });

  it("dates, and the API keys tab's text on a plan without keys (from the catalog)", () => {
    expect(dateLabel("2026-10-24T00:00:00Z")).toBe("Oct 24, 2026");
    expect(dateLabel("bogus")).toBe("");
    expect(keysLockedText()).toBe("API access to add TODO tasks comes with a paid plan.");
  });
});
