/**
 * The account side of docs/BILLING-CONTRACT.md as the extension sees it:
 * the shared shapes, tolerant of servers that have no billing yet (plan and
 * credit may be missing from GET /v1/me).
 */
import type { z } from "zod";
import { CreditInfo, GOOD_STANDING, planAllows, PlanInfo, User, type PlanId } from "@noa/shared";

export type { CreditInfo, PlanId, PlanInfo };

/** GET /v1/me: the user, plus plan and credit when the server has billing (a plan or credit it cannot read counts as missing). */
export const Me = User.extend({ plan: PlanInfo.optional().catch(undefined), credit: CreditInfo.optional().catch(undefined) });
export type Me = z.infer<typeof Me>;

/** The plan includes voice input and is in good standing. */
export function voiceAllowed(plan: PlanInfo | undefined | null): boolean {
  return planAllows(plan, "voice");
}

/** The plan includes the account's TODO list (tasks kept in the cloud, run on schedule) and is in good standing. */
export function todoAllowed(plan: PlanInfo | undefined | null): boolean {
  return planAllows(plan, "todo");
}

/** A paid plan in good standing (it comes with monthly credit). */
export function isPaidActive(plan: PlanInfo | undefined | null): boolean {
  return !!plan && plan.id !== "free" && GOOD_STANDING.includes(plan.status);
}
