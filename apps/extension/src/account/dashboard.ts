/**
 * The account's dashboard: served at the account server's origin (the API
 * Worker serves apps/dashboard). Plans, top-ups and invoices live on its
 * Billing page only; the extension never opens Stripe itself. The one place
 * the extension builds dashboard URLs.
 */

/** "" is the dashboard's home (usage). */
export type DashboardPage = "" | "billing";

/** The dashboard page of the account server `apiBase` ("" when apiBase is not a URL). */
export function dashboardUrl(apiBase: string, page: DashboardPage = ""): string {
  try {
    return new URL(`/${page}`, new URL(apiBase).origin).toString();
  } catch {
    return "";
  }
}
