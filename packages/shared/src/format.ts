/**
 * Plain-language formatting every UI shares (extension side panel and
 * options page, dashboard, emails): money, counts, sizes, dates, plans.
 * Pure and DOM-free; English (en-US) wording.
 */
import { PLAN_CATALOG, type PlanId, type PlanInfo } from "./billing.js";
import type { IssuableKeyRole } from "./task.js";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-US");

/**
 * 1234 -> "$12.34"; -12 -> "-$0.12". Cents may be fractional (usage charges): shown to the
 * cent, and a charge below half a cent reads "<$0.01" rather than a misleading "$0.00".
 * `whole` drops ".00" on round dollar amounts ("$10").
 */
export function formatCents(cents: number, opts: { whole?: boolean } = {}): string {
  if (cents > 0 && cents < 0.5) return "<$0.01";
  const dollars = Math.round(cents) / 100;
  if (opts.whole && Number.isInteger(dollars)) return usdWhole.format(dollars);
  return usd.format(dollars);
}

/** 1234567 -> "1,234,567". */
export function formatCount(n: number): string {
  return int.format(Math.round(n));
}

/** plural(1, "task") -> "1 task"; plural(1200, "task") -> "1,200 tasks". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${int.format(n)} ${n === 1 ? one : many}`;
}

const trimZero = (s: string) => s.replace(/\.0$/, "");

/** 512 -> "512 B", 1536 -> "1.5 KB", 184_000 -> "180 KB", 5_300_000 -> "5.1 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? trimZero(kb.toFixed(1)) : Math.round(kb)} KB`;
  return `${trimZero((kb / 1024).toFixed(1))} MB`;
}

/** ISO -> "Oct 12, 2026" in `timeZone` (default: the viewer's); "" when missing or invalid. */
export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", "in 4 h"; two weeks or more away: a date. */
export function formatRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = t - now;
  const min = Math.round(Math.abs(diff) / 60_000);
  const say = (s: string) => (diff > 0 ? `in ${s}` : `${s} ago`);
  if (min < 1) return "just now";
  if (min < 60) return say(`${min} min`);
  const h = Math.round(min / 60);
  if (h < 24) return say(`${h} h`);
  const d = Math.round(h / 24);
  if (d < 14) return say(plural(d, "day"));
  return formatDate(iso);
}

/** The letter an avatar shows when there is no picture. */
export function initialOf(user: { name?: string | null; email: string }): string {
  return (user.name?.trim() || user.email.trim()).charAt(0).toUpperCase();
}

/** "plus" -> "Plus"; an id the catalog does not know is shown as it is, none as "Free". */
export function planName(id: PlanId | string | null | undefined): string {
  if (!id) return PLAN_CATALOG.free.name;
  return Object.hasOwn(PLAN_CATALOG, id) ? PLAN_CATALOG[id as PlanId].name : id;
}

/** A subscription that needs attention, in a few words; null when it is simply active (or free). */
export function planStatusText(plan: Pick<PlanInfo, "status" | "cancelAtPeriodEnd">): string | null {
  if (plan.status === "past_due") return "Payment overdue";
  if (plan.status === "canceled") return "Subscription ended";
  return plan.cancelAtPeriodEnd ? "Ends at period end" : null;
}

/** What each role of an account API key lets it do (the key form's choices). */
export const API_KEY_ROLE_LABELS: Readonly<Record<IssuableKeyRole, { label: string; hint: string }>> = {
  creator: { label: "Add tasks", hint: "Create, edit and read your tasks. For scripts and other apps." },
  runner: { label: "Run tasks", hint: "Claim and finish tasks. For a machine that works through your queue." },
};

/** "creator" -> "Add tasks"; other roles as they are. */
export function apiKeyRoleLabel(role: string): string {
  return Object.hasOwn(API_KEY_ROLE_LABELS, role) ? API_KEY_ROLE_LABELS[role as IssuableKeyRole].label : role;
}
