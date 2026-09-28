/**
 * Plans, top-ups and invoices are on the dashboard's Billing page: every
 * upgrade button of the extension's pages (options, side panel) opens it
 * through openBilling(), in a new tab. The URL comes with the account
 * (AccountView.billingUrl, built in account/dashboard.ts from the account
 * server's current address).
 *
 * After a dashboard page was opened, coming back to the extension page
 * refreshes the account (refreshOnReturn), so a new plan or credit shows
 * without clicking Refresh.
 */
import type { AccountView } from "../ui-protocol.js";
import { showExtensionPage } from "./extension-page.js";

/**
 * Whether the page came back after a dashboard page was opened from it:
 * arm() when opening, left() when the page is hidden or loses focus, back()
 * when it is shown or focused again (true once per return, and only after
 * a dashboard page was opened).
 */
export function createReturnWatcher(): { arm(): void; left(): void; back(): boolean } {
  let armed = false;
  let away = false;
  return {
    arm: () => void (armed = true),
    left: () => void (away = armed),
    back() {
      if (!away) return false;
      away = false;
      return true;
    },
  };
}

const returns = createReturnWatcher();

/** Opens a dashboard page in a new tab; without an account server address, Settings > Advanced where it is set. */
async function openDashboardPage(url: string | undefined): Promise<void> {
  if (!url) return showExtensionPage(`${chrome.runtime.getURL("options.html")}#advanced`);
  returns.arm();
  await chrome.tabs.create({ url });
}

/** The dashboard's Billing page: choose or change a plan, top up, invoices. */
export function openBilling(account: Pick<AccountView, "billingUrl"> | null | undefined): Promise<void> {
  return openDashboardPage(account?.billingUrl);
}

/** The dashboard's home (usage). */
export function openDashboard(account: Pick<AccountView, "dashboardUrl"> | null | undefined): Promise<void> {
  return openDashboardPage(account?.dashboardUrl);
}

/**
 * Calls `refresh` each time the page comes back (shown or focused) after it
 * opened a dashboard page and was left; a return that fires both focus and
 * visibilitychange refreshes once.
 */
export function refreshOnReturn(refresh: () => void, win: Pick<Window, "addEventListener" | "document"> = window, watcher = returns): void {
  const doc = win.document;
  const back = () => {
    if (watcher.back()) refresh();
  };
  win.addEventListener("blur", () => watcher.left());
  win.addEventListener("focus", back);
  doc.addEventListener("visibilitychange", () => (doc.visibilityState === "hidden" ? watcher.left() : back()));
}
