/**
 * Error answers of the Anthropic API and the Noa API (/v1/ai/*), read
 * one way for Messages requests and for Jev.
 */
import { z } from "zod";
import { HOSTED_AI_UNAVAILABLE_CODE, hostedAiUnavailableText, isApiErrorCode, LOW_CREDIT, lowCreditText, OUT_OF_CREDIT, OutOfCreditError as OutOfCreditBody } from "@noa/shared";

/** Credit left, but too little for the request (a 402 with both amounts), in whole cents. */
export interface CreditShortfall {
  balanceCents: number;
  neededCents: number;
}

/** A hosted-AI request was refused with 402: the account has no usage credit left, or too little for the request (`shortfall`). */
export class OutOfCreditError extends Error {
  constructor(
    message: string,
    readonly topupUrl?: string,
    readonly shortfall?: CreditShortfall,
  ) {
    super(message);
    this.name = "OutOfCreditError";
  }

  /** The paused run's reason: LOW_CREDIT when credit is left, else OUT_OF_CREDIT. */
  get pauseReason(): string {
    return this.shortfall ? LOW_CREDIT : OUT_OF_CREDIT;
  }
}

/** The response body as JSON, or undefined when it is not JSON. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The 402 body's fields, read leniently: a body without them still means "out of credit". */
const CreditBody = OutOfCreditBody.pick({ message: true, topupUrl: true, balanceCents: true, neededCents: true }).partial();

/**
 * A 402 answer as an error. With the credit left and what the request needed: lowCreditText ("Not enough
 * usage credit for this request ($0.67 left; about $0.80 needed)"). Else OUT_OF_CREDIT and the server's
 * explanation. Either way with the top-up link.
 */
export function outOfCreditError(body: string): OutOfCreditError {
  const parsed = CreditBody.safeParse(parseJsonBody(body));
  const { message, topupUrl, balanceCents, neededCents } = parsed.success ? parsed.data : {};
  const topup = topupUrl || undefined;
  if (balanceCents !== undefined && neededCents !== undefined && balanceCents > 0) {
    return new OutOfCreditError(lowCreditText(balanceCents, neededCents), topup, { balanceCents, neededCents });
  }
  return new OutOfCreditError(message ? `${OUT_OF_CREDIT}: ${message}` : OUT_OF_CREDIT, topup);
}

/**
 * For the hosted AI's HOSTED_AI_UNAVAILABLE_CODE (the server's own AI credentials or account were refused): what
 * the user reads, with why (hostedAiUnavailableText). Undefined for any other answer.
 */
export function hostedAiUnavailable(body: string): string | undefined {
  const json = parseJsonBody(body);
  if (!json || typeof json !== "object") return undefined;
  const { error, reason } = json as { error?: unknown; reason?: unknown };
  if (error !== HOSTED_AI_UNAVAILABLE_CODE) return undefined;
  return hostedAiUnavailableText(typeof reason === "string" && reason.trim() ? reason.trim() : undefined);
}

/**
 * The Noa API answers { error: "code or text", message? }; Anthropic
 * answers { error: { type, message } }; some proxies just { message };
 * TypeSafe (Jev) { detail: "text" or { error_type } }.
 */
const ErrorBody = z.object({
  error: z.union([z.string(), z.object({ type: z.string().optional(), message: z.string().optional() })]).optional(),
  message: z.string().optional(),
  detail: z.union([z.string(), z.object({ error_type: z.string().optional() })]).optional(),
});

/**
 * What an error answer says, from either API's error body, else the start of
 * a plain-text body. An HTML error page or JSON of another shape says nothing
 * a user can read: "" (callers then show just the status).
 */
export function errorDetail(body: string, maxChars = 300): string {
  const unavailable = hostedAiUnavailable(body);
  if (unavailable) return unavailable;
  const json = parseJsonBody(body);
  const parsed = ErrorBody.safeParse(json);
  if (parsed.success) {
    const { error, message } = parsed.data;
    // A machine code says nothing a user can read when the message is there.
    if (typeof error === "string") return message ? (isApiErrorCode(error) ? message : `${error}: ${message}`) : error;
    if (error?.message) return `${error.type ? `${error.type}: ` : ""}${error.message}`;
    if (message) return message;
    const { detail } = parsed.data;
    if (typeof detail === "string" && detail) return detail.slice(0, maxChars);
    if (typeof detail === "object" && detail.error_type) return detail.error_type;
  }
  const text = body.trim();
  if (json !== undefined || text.startsWith("<")) return "";
  return text.replace(/\s+/g, " ").slice(0, maxChars);
}

/**
 * Error text from elsewhere (e.g. Claude Code's "API Error: 529 {...}") with
 * an embedded JSON error body replaced by what it says, so the user never
 * reads raw JSON. Text without one is returned as it is.
 */
export function plainErrorText(text: string): string {
  const start = text.indexOf("{");
  if (start < 0 || parseJsonBody(text.slice(start)) === undefined) return text;
  const prefix = text.slice(0, start).trim();
  const detail = errorDetail(text.slice(start));
  return [prefix, detail].filter(Boolean).join(" ") || "an error without details";
}
