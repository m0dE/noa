import { z } from "zod";
import catalog from "./billing-catalog.json";
import { User } from "./task.js";

/**
 * Billing, credits, hosted AI and usage: the shapes of docs/BILLING-CONTRACT.md.
 * Money is in cents (USD). Times are ISO 8601 UTC strings.
 */

export const PlanId = z.enum(["free", "starter", "plus", "pro"]);
export type PlanId = z.infer<typeof PlanId>;

export const PaidPlanId = z.enum(["starter", "plus", "pro"]);
export type PaidPlanId = z.infer<typeof PaidPlanId>;

export const PlanStatus = z.enum(["active", "past_due", "canceled", "none"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

/**
 * Where the effective plan comes from: a Stripe subscription (or none, on Free), or a
 * complimentary plan an admin gave (docs/BILLING-CONTRACT.md, "Complimentary plans").
 */
export const PlanSource = z.enum(["stripe", "complimentary"]);
export type PlanSource = z.infer<typeof PlanSource>;

/**
 * The user's effective plan: the higher of the Stripe plan (in good standing) and an
 * unexpired complimentary plan. Every feature check reads this.
 */
export const PlanInfo = z.object({
  id: PlanId,
  /** "none" for free. */
  status: PlanStatus,
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** Absent from older servers: "stripe". */
  source: PlanSource.optional(),
  /** complimentary: when it ends (null = no end). */
  compExpiresAt: z.string().nullable().optional(),
  /** A Stripe subscription in good standing exists (the customer portal manages it); false for complimentary-only users. */
  hasSubscription: z.boolean().optional(),
});
export type PlanInfo = z.infer<typeof PlanInfo>;

export const CreditInfo = z.object({
  /** Remaining subscription credit this period (whole cents, rounded down). */
  subscriptionCents: z.number(),
  /** Remaining top-up credit; never expires (whole cents, rounded down). */
  topupCents: z.number(),
  totalCents: z.number(),
  /** This plan's monthly grant. */
  periodGrantCents: z.number(),
  periodEnd: z.string().nullable(),
});
export type CreditInfo = z.infer<typeof CreditInfo>;

/** GET /v1/me. `isAdmin` is sent (true) only to admins (ADMIN_EMAILS): the dashboard then shows its Admin page. */
export const MeResponse = User.extend({ plan: PlanInfo, credit: CreditInfo, isAdmin: z.literal(true).optional() });
export type MeResponse = z.infer<typeof MeResponse>;

export const PlanCatalogEntry = z.object({
  id: PlanId,
  name: z.string(),
  priceCents: z.number().int(),
  creditCents: z.number().int(),
  apiKeys: z.boolean(),
  /** Voice input in the side panel (POST /v1/ai/transcribe). */
  voice: z.boolean(),
  /** The TODO list kept in the account and run on schedule (task writes, runner claims, media uploads). */
  todo: z.boolean(),
});
export type PlanCatalogEntry = z.infer<typeof PlanCatalogEntry>;

/** What a plan unlocks: the boolean capability flags of the catalog, in the order plan descriptions list them. */
export const PlanFeature = z.enum(["todo", "voice", "apiKeys"]);
export type PlanFeature = z.infer<typeof PlanFeature>;

/** How a feature reads in plan descriptions: `name` inside a sentence, `has` / `lacks` as a plan card's line. */
const FeatureText = z.object({ name: z.string(), has: z.string() });
export const PLAN_FEATURE_TEXT: Readonly<Record<PlanFeature, z.infer<typeof FeatureText>>> = z
  .object({ todo: FeatureText, voice: FeatureText, apiKeys: FeatureText })
  .parse(catalog.features);

/** "a", "a and b", "a, b and c". */
function listOf(items: string[], last: "and" | "or"): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}

/** A plan's included features in one line, e.g. "Includes TODO list, voice input and API access"; "" when it includes none. */
export function planIncludesText(plan: Pick<PlanCatalogEntry, PlanFeature>): string {
  const included = PlanFeature.options.filter((f) => plan[f]).map((f) => PLAN_FEATURE_TEXT[f].name);
  return included.length ? `Includes ${listOf(included, "and")}` : "";
}

/** The 503 answer of a feature this server has not been configured for (its key or binding is missing). */
export const NOT_SET_UP = {
  billing: "Billing is not set up on this server yet",
  hostedAi: "Hosted AI is not set up on this server yet",
  jev: "Hosted Jev is not set up on this server yet",
  voice: "Voice input is not set up on this server yet",
  realtime: "Realtime voice is not set up on this server yet",
} as const;

/** The plans (decided by the owner; docs/BILLING-CONTRACT.md). The one plan table: API, dashboard, extension and the Stripe setup script read it. */
export const PLAN_CATALOG: Readonly<Record<PlanId, PlanCatalogEntry>> = z.record(PlanId, PlanCatalogEntry).parse(catalog.plans);

/** Which plans include a feature, from the catalog: "a paid plan" when every paid plan has it, else e.g. "the Plus or Pro plan". */
export function plansWithText(feature: PlanFeature): string {
  const paid = Object.values(PLAN_CATALOG).filter((p) => p.priceCents > 0);
  const having = paid.filter((p) => p[feature]);
  return having.length === paid.length ? "a paid plan" : `the ${listOf(having.map((p) => p.name), "or")} plan`;
}

const REQUIRED_SUBJECT: Readonly<Record<PlanFeature, string>> = {
  apiKeys: "API keys need",
  voice: "Voice input needs",
  todo: "The TODO list needs",
};

/** The `message` of a 403 plan_required, per feature, e.g. "Voice input needs the Plus or Pro plan." */
export const PLAN_REQUIRED_MESSAGES: Readonly<Record<PlanFeature, string>> = Object.fromEntries(
  PlanFeature.options.map((f) => [f, `${REQUIRED_SUBJECT[f]} ${plansWithText(f)}.`]),
) as Record<PlanFeature, string>;

/** The Stripe API version the server calls with and pins its webhook endpoint to. */
export const STRIPE_API_VERSION: string = catalog.stripe.apiVersion;
/** The Stripe events the webhook handles (and the setup script subscribes to). */
export const STRIPE_WEBHOOK_EVENTS: readonly string[] = catalog.stripe.webhookEvents;

/** Statuses in which a plan's features work (past_due: Stripe is still retrying the payment). */
export const GOOD_STANDING: readonly PlanStatus[] = ["active", "past_due"];

/** True when `plan` is in good standing and its catalog entry has `feature`. */
export function planAllows(plan: { id: string; status: string } | null | undefined, feature: PlanFeature): boolean {
  if (!plan || !Object.hasOwn(PLAN_CATALOG, plan.id)) return false;
  return PLAN_CATALOG[plan.id as PlanId][feature] && (GOOD_STANDING as readonly string[]).includes(plan.status);
}

/** Fair-use limits on API-key traffic (docs/BILLING-CONTRACT.md): the API enforces them, the dashboard and extension state them. */
export const API_KEY_LIMITS = { requestsPerMinute: 60, taskCreationsPerDay: 10_000 } as const;

/** Top-up amounts that can be bought, in cents. */
/** The one-time top-up amounts, from the catalog. */
export const TOPUP_AMOUNTS_CENTS: readonly number[] = z.array(z.number().int().positive()).min(1).parse(catalog.topupAmountsCents);

/** GET /v1/billing/plans (public). */
export const BillingPlansResponse = z.object({
  plans: z.array(PlanCatalogEntry),
  topups: z.array(z.number().int()),
});
export type BillingPlansResponse = z.infer<typeof BillingPlansResponse>;

/** GET /v1/me/billing. */
export const MeBillingResponse = z.object({ plan: PlanInfo, credit: CreditInfo, stripeConfigured: z.boolean() });
export type MeBillingResponse = z.infer<typeof MeBillingResponse>;

/** POST /v1/billing/checkout. */
export const CheckoutInput = z.object({ plan: PaidPlanId, returnUrl: z.string().min(1).max(2000) });
export type CheckoutInput = z.infer<typeof CheckoutInput>;

/** POST /v1/billing/topup. */
export const TopupInput = z.object({
  amountCents: z.literal(TOPUP_AMOUNTS_CENTS),
  returnUrl: z.string().min(1).max(2000),
});
export type TopupInput = z.infer<typeof TopupInput>;

/** POST /v1/billing/portal. */
export const PortalInput = z.object({ returnUrl: z.string().min(1).max(2000) });
export type PortalInput = z.infer<typeof PortalInput>;

/** 200 of checkout, topup and portal: the Stripe page to open. */
export const RedirectUrlResponse = z.object({ url: z.string() });
export type RedirectUrlResponse = z.infer<typeof RedirectUrlResponse>;

/** The `error` code of a 402 from /v1/ai/* (no usage credit left). */
export const OUT_OF_CREDIT_CODE = "out_of_credit";
/** What the user reads when the hosted AI has no usage credit left (a paused run's reason starts with it). */
export const OUT_OF_CREDIT = "Out of usage credit";

/**
 * The `error` code of a 502 from /v1/ai/*: the AI provider refused this
 * server's own credentials or configuration (the details are in the server's
 * log). Nothing the user sent is wrong; their own Claude still works.
 */
export const HOSTED_AI_UNAVAILABLE_CODE = "hosted_ai_unavailable";
/** What the user reads when the hosted AI answered HOSTED_AI_UNAVAILABLE_CODE (a failed turn's reason is exactly this). */
export const HOSTED_AI_UNAVAILABLE = "Noa AI is unavailable right now";

/** 402 of /v1/ai/* when the user has no credit left. */
export const OutOfCreditError = z.object({
  error: z.literal(OUT_OF_CREDIT_CODE),
  message: z.string(),
  topupUrl: z.string(),
});
export type OutOfCreditError = z.infer<typeof OutOfCreditError>;

/** 403 of a feature the user's plan does not include (e.g. voice input or the TODO list on Free). */
export const PLAN_REQUIRED = "plan_required";
export const PlanRequiredError = z.object({
  error: z.literal(PLAN_REQUIRED),
  /** The catalog flag the plan lacks. */
  feature: PlanFeature,
  message: z.string(),
  /** Where to pick a plan (the dashboard's billing page). */
  upgradeUrl: z.string(),
});
export type PlanRequiredError = z.infer<typeof PlanRequiredError>;

/** Body of POST /v1/ai/jev: a TypeSafe systemOne request without `model`. */
export const JevProxyInput = z.object({
  state: z.unknown(),
  questions: z.record(z.string(), z.unknown()),
});
export type JevProxyInput = z.infer<typeof JevProxyInput>;

/** Header the extension sends so usage ties to a task run. */
export const SESSION_HEADER = "X-Noa-Session";
/** Response header of /v1/ai/*: cents charged for the request. */
export const CHARGED_CENTS_HEADER = "X-Noa-Charged-Cents";
/** Header dashboard (cookie) requests must send on POST/PATCH/DELETE. */
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_HEADER_VALUE = "noa";
export const SESSION_COOKIE = "bt_session";

/**
 * "transcribe" = voice input (Workers AI speech-to-text), billed by audio length.
 * "realtime" = a realtime voice session (GET /v1/ai/realtime): one event per model
 * response (tokens), and one per transcribed user turn when input transcription is on
 * (model = the transcription model, billed by audio length).
 */
export const UsageKind = z.enum(["ai_messages", "jev", "transcribe", "realtime"]);
export type UsageKind = z.infer<typeof UsageKind>;

export const UsageEvent = z.object({
  at: z.string(),
  kind: UsageKind,
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  chargedCents: z.number(),
  sessionId: z.string().nullable().optional(),
  /** Seconds of audio billed by length (transcribe, and realtime input transcription). */
  audioSeconds: z.number().optional(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** GET /v1/me/usage?month=YYYY-MM. */
export const UsageReport = z.object({
  month: z.string(),
  months: z.array(z.string()),
  totals: z.object({
    tasksRun: z.number().int(),
    tasksDone: z.number().int(),
    tasksFailed: z.number().int(),
    tasksPaused: z.number().int(),
    aiRequests: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    chargedCents: z.number(),
    creditGrantedCents: z.number(),
    topupsCents: z.number(),
    /** Seconds of voice input transcribed (optional: older servers do not send it). */
    audioSeconds: z.number().optional(),
  }),
  byModel: z.array(
    z.object({
      model: z.string(),
      requests: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      chargedCents: z.number(),
      /** Seconds of audio, for speech-to-text models (optional: older servers do not send it). */
      audioSeconds: z.number().optional(),
    }),
  ),
  byDay: z.array(z.object({ date: z.string(), tasksRun: z.number().int(), chargedCents: z.number() })),
});
export type UsageReport = z.infer<typeof UsageReport>;

export const DeviceSession = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/** GET /v1/me/sessions. */
export const SessionList = z.object({ sessions: z.array(DeviceSession) });
export type SessionList = z.infer<typeof SessionList>;

/** Body of DELETE /v1/me. */
export const DeleteAccountInput = z.object({ confirm: z.string().min(1) });
export type DeleteAccountInput = z.infer<typeof DeleteAccountInput>;

/** GET/PATCH /v1/me/settings (server addition: the monthly email report flag). */
export const AccountSettings = z.object({ reportEmailEnabled: z.boolean() });
export type AccountSettings = z.infer<typeof AccountSettings>;

// ---- Admin (/v1/admin/*, the dashboard's Admin page) ----------------------------
// Only admins reach these routes (ADMIN_EMAILS or the ADMIN_KEY); everyone else gets 404.
// Not in the public OpenAPI document. docs/BILLING-CONTRACT.md, "Admin".

/** A user's complimentary plan as stored (also after it expired: `active` false). */
export const CompPlan = z.object({
  plan: PaidPlanId,
  startedAt: z.string(),
  /** null = no end. */
  expiresAt: z.string().nullable(),
  /** The plan's monthly usage credit each period (as a paid plan gets); false = features only. */
  monthlyCredit: z.boolean(),
  note: z.string().nullable(),
  grantedBy: z.string().nullable(),
  active: z.boolean(),
});
export type CompPlan = z.infer<typeof CompPlan>;

/** The Stripe side of a user, as the webhooks keep it. */
export const StripePlanState = z.object({
  plan: PlanId,
  status: PlanStatus,
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  customerId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
});
export type StripePlanState = z.infer<typeof StripePlanState>;

/** One row of the admin user list. */
export const AdminUserSummary = User.extend({
  createdAt: z.string(),
  /** Latest of sign-in, session use and hosted-AI use. */
  lastActiveAt: z.string().nullable(),
  /** Effective plan (what every feature check uses). */
  plan: PlanInfo,
  stripe: StripePlanState,
  comp: CompPlan.nullable(),
  /** Unexpired credit left (whole cents, rounded down; may be negative after an overdraw). */
  creditCents: z.number(),
  /** This UTC month's hosted-AI usage. */
  usageCents: z.number(),
  aiRequests: z.number().int(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummary>;

/** Which users GET /v1/admin/users lists: everyone, complimentary plans (active or expired), or Stripe plans in good standing. */
export const AdminUserFilter = z.enum(["all", "comp", "paid"]);
export type AdminUserFilter = z.infer<typeof AdminUserFilter>;

/** GET /v1/admin/users?q=&filter=&limit= (most recently active first). */
export const AdminUserList = z.object({ users: z.array(AdminUserSummary), month: z.string(), limit: z.number().int() });
export type AdminUserList = z.infer<typeof AdminUserList>;

export const AdminAction = z.enum(["comp.give", "comp.update", "comp.remove", "credit.add"]);
export type AdminAction = z.infer<typeof AdminAction>;

export const AdminAuditEntry = z.object({
  id: z.number().int(),
  at: z.string(),
  /** The admin's email, or "ADMIN_KEY". */
  admin: z.string(),
  action: z.string(),
  targetUserId: z.string().nullable(),
  targetEmail: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  note: z.string().nullable(),
});
export type AdminAuditEntry = z.infer<typeof AdminAuditEntry>;

/** GET /v1/admin/audit?userId=&limit= (newest first). */
export const AdminAuditList = z.object({ entries: z.array(AdminAuditEntry) });
export type AdminAuditList = z.infer<typeof AdminAuditList>;

/** GET /v1/admin/users/:id?month=YYYY-MM: the summary plus credit, the month's usage and the user's audit log. */
export const AdminUserDetail = AdminUserSummary.extend({
  credit: CreditInfo,
  usage: UsageReport,
  audit: z.array(AdminAuditEntry),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetail>;

const AdminNote = z.string().trim().max(500);
/** An ISO 8601 instant (the dashboard sends the end of the chosen day, UTC). */
const Instant = z.iso.datetime({ offset: true });

/** PUT /v1/admin/users/:id/comp: give (or replace) a complimentary plan; a new monthly credit period starts now. */
export const GiveCompInput = z.object({
  plan: PaidPlanId,
  /** null = no end. Must be in the future. */
  expiresAt: Instant.nullable(),
  note: AdminNote.optional(),
  /** Default true: the plan's monthly usage credit, as a paid plan gets. */
  monthlyCredit: z.boolean().default(true),
});
export type GiveCompInput = z.input<typeof GiveCompInput>;

/** PATCH /v1/admin/users/:id/comp: change the end date (null = no end) or the note of an active complimentary plan. */
export const UpdateCompInput = z
  .object({ expiresAt: Instant.nullable().optional(), note: AdminNote.optional() })
  .refine((v) => v.expiresAt !== undefined || v.note !== undefined, { message: "send expiresAt or note" });
export type UpdateCompInput = z.infer<typeof UpdateCompInput>;

/** Largest one-off credit an admin can add at once, in cents ($1,000). */
export const ADMIN_CREDIT_MAX_CENTS = 100_000;

/** POST /v1/admin/users/:id/credit: a one-off top-up that never expires (a ledger entry). */
export const AdminCreditInput = z.object({
  amountCents: z.number().int().positive().max(ADMIN_CREDIT_MAX_CENTS),
  reason: z.string().trim().min(1).max(500),
});
export type AdminCreditInput = z.infer<typeof AdminCreditInput>;
