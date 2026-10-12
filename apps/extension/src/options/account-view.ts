/** Pure helpers for the options page's Account tab. */
import { formatCents, formatDate, PLAN_CATALOG, planIncludesText, planName, planStatusText } from "@noa/shared";
import { isPaidActive, type PlanInfo } from "../account/types.js";
import type { AccountView } from "../ui-protocol.js";

export interface AccountSummary {
  /** "Plus" / "Free". */
  planName: string;
  /** "Renews Oct 24, 2026", "Ends Oct 24, 2026", "Payment overdue"… or "" */
  planStatus: string;
  /** What the plan comes with, from the catalog: "Includes TODO list, voice input and API keys" ("" when the plan is not known). */
  planIncludes: string;
  /** "$12.40" (empty when not known). */
  credit: string;
  /** "$4.40 subscription (expires Oct 24) + $8.00 top-up" */
  creditDetail: string;
  paid: boolean;
  /** The one billing button, which opens the dashboard's Billing page: "Choose a plan" (Free), "Manage plan & billing" (paid), "Top up or change plan" (paid, out of credit). */
  billingLabel: string;
  /** Stripe is set up on the server; false: the billing button is replaced by a plain note. undefined: not known yet. */
  billing: "ready" | "not-set-up" | "unknown";
  outOfCredit: boolean;
}

/** "Oct 24, 2026" (UTC date: billing periods are UTC). */
export function dateLabel(iso: string | null | undefined): string {
  return formatDate(iso, "UTC");
}

/** The line under the plan: a payment problem, else when a paid plan renews or ends. */
function planStatus(plan: PlanInfo | undefined): string {
  if (!plan) return "";
  // A canceled subscription comes back as { id: "free", status: "canceled" }.
  if (plan.status === "canceled") return planStatusText(plan) ?? "";
  if (plan.id === "free") return "";
  if (plan.status === "past_due") return planStatusText(plan) ?? "";
  if (!plan.currentPeriodEnd) return "";
  return `${plan.cancelAtPeriodEnd ? "Ends" : "Renews"} ${dateLabel(plan.currentPeriodEnd)}`;
}

export function accountSummary(a: AccountView): AccountSummary {
  const plan = a.plan;
  const paid = isPaidActive(plan);
  const c = a.credit;
  const parts: string[] = [];
  if (c) {
    if (c.subscriptionCents > 0 || c.periodGrantCents > 0) {
      const ends = dateLabel(c.periodEnd);
      parts.push(`${formatCents(c.subscriptionCents)} subscription${ends ? ` (expires ${ends})` : ""}`);
    }
    if (c.topupCents > 0 || parts.length === 0) parts.push(`${formatCents(c.topupCents)} top-up`);
  }
  return {
    planName: planName(plan?.id),
    planStatus: planStatus(plan),
    planIncludes: plan ? planIncludesText(PLAN_CATALOG[plan.id]) : "",
    credit: c ? formatCents(c.totalCents) : "",
    creditDetail: parts.join(" + "),
    paid,
    // On Free a plan is the way to credit (a top-up is on the same page).
    billingLabel: !paid ? "Choose a plan" : a.outOfCredit ? "Top up or change plan" : "Manage plan & billing",
    billing: a.stripeConfigured === true ? "ready" : a.stripeConfigured === false ? "not-set-up" : "unknown",
    outOfCredit: !!a.outOfCredit,
  };
}
