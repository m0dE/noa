/**
 * Error answers of the Anthropic API and the Noa API (/v1/ai/*), read
 * one way for Messages requests and for Jev.
 */
import { z } from "zod";
import { HOSTED_AI_UNAVAILABLE_CODE, isApiErrorCode, OUT_OF_CREDIT, OutOfCreditError as OutOfCreditBody } from "@noa/shared";

/** A hosted-AI request was refused with 402: the account has no usage credit left. */
export class OutOfCreditError extends Error {
  constructor(
    message: string,
    readonly topupUrl?: string,
  ) {
    super(message);
    this.name = "OutOfCreditError";
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
const CreditBody = OutOfCreditBody.pick({ message: true, topupUrl: true }).partial();

/** A 402 answer as an error: OUT_OF_CREDIT, the server's explanation, and the top-up link. */
export function outOfCreditError(body: string): OutOfCreditError {
  const parsed = CreditBody.safeParse(parseJsonBody(body));
  const { message, topupUrl } = parsed.success ? parsed.data : {};
  return new OutOfCreditError(message ? `${OUT_OF_CREDIT}: ${message}` : OUT_OF_CREDIT, topupUrl || undefined);
}

/** Whether an error answer is the hosted AI's HOSTED_AI_UNAVAILABLE_CODE (the server's own AI credentials were refused). */
export function isHostedAiUnavailable(body: string): boolean {
  const json = parseJsonBody(body);
  return !!json && typeof json === "object" && (json as { error?: unknown }).error === HOSTED_AI_UNAVAILABLE_CODE;
}

/**
 * The Noa API answers { error: "code or text", message? }; Anthropic
 * answers { error: { type, message } }; some proxies just { message }.
 */
const ErrorBody = z.object({
  error: z.union([z.string(), z.object({ type: z.string().optional(), message: z.string().optional() })]).optional(),
  message: z.string().optional(),
});

/**
 * What an error answer says, from either API's error body, else the start of
 * a plain-text body. An HTML error page or JSON of another shape says nothing
 * a user can read: "" (callers then show just the status).
 */
export function errorDetail(body: string, maxChars = 300): string {
  const json = parseJsonBody(body);
  const parsed = ErrorBody.safeParse(json);
  if (parsed.success) {
    const { error, message } = parsed.data;
    // A machine code says nothing a user can read when the message is there.
    if (typeof error === "string") return message ? (isApiErrorCode(error) ? message : `${error}: ${message}`) : error;
    if (error?.message) return `${error.type ? `${error.type}: ` : ""}${error.message}`;
    if (message) return message;
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
